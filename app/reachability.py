"""组件可达性审计：从 paths / webhooks 实际入口出发，沿本地 $ref 传递追踪
components，统计未被入口触达的组件。

规则：
- 入口固定为 paths 与 webhooks 下的每个 Path Item（含其 $ref 指向的
  components/pathItems）；不从 components 自身出发，故未被引用的组件即"不可达"；
- 沿入口结构递归，遇到本地 $ref 则把目标标记为可达并继续向目标内部追踪；
  同一目标指针只访问一次（循环引用 / 多处共享引用安全终止，不重复计数）；
- OpenAPI 3.1 允许 $ref 与兄弟字段并存，兄弟字段同样参与追踪；
- 全局 security（根级）与操作级 security 中按名称引用的 securitySchemes
  也计入可达；引用了未声明的名称属于无效引用；
- 外部文件引用（./other.yaml#/...）不解析，单独列出提示；
- 无法解析的本地 $ref（指针越界 / 目标不存在）记入无效引用并给出来源位置。

纯函数、无存储：接口每次按已保存文档实时计算，与 groups / reconcile 一致。
"""
from __future__ import annotations

from typing import Any

from .refs import (
    COMPONENT_SECTIONS,
    PointerError,
    encode_token,
    resolve_pointer,
)

# Path Item 下的操作字段（按 OpenAPI 3.x 固定顺序）
HTTP_METHODS = ("get", "put", "post", "delete", "patch", "options", "head", "trace")

# 超大文档的遍历预算，防止异常文档耗尽资源
MAX_NODES = 200_000
# 无效 / 外部引用在响应中最多保留的条目数（超出部分以计数形式提示）
MAX_REF_REPORTS = 200


def _component_pointer(section: str, name: str) -> str:
    return f"/components/{section}/{encode_token(name)}"


def _is_component_pointer(pointer: str) -> tuple[str, str] | None:
    """``/components/<section>/<name>``（恰好三段）→ (section, name)。"""
    if not pointer.startswith("/components/"):
        return None
    tokens = pointer.split("/")
    # ["", "components", section, name]
    if len(tokens) != 4:
        return None
    section, name = tokens[2], tokens[3]
    if section not in COMPONENT_SECTIONS:
        return None
    return section, name


class _Ctx:
    """遍历过程中的累积状态。"""

    def __init__(self) -> None:
        self.reachable: set[str] = set()       # 已触达的组件指针
        self.visited_targets: set[str] = set()  # 已访问的 $ref 目标指针（循环只访问一次）
        self.visited_ids: set[int] = set()      # 结构节点去重（防御 YAML 锚点别名环）
        self.invalid_refs: list[dict[str, Any]] = []
        self.external_refs: list[dict[str, Any]] = []
        self._external_seen: set[tuple[str, str]] = set()
        self.security_refs: list[dict[str, Any]] = []
        self.nodes = 0
        self.truncated = False

        self.invalid_ref_count = 0

    def add_invalid(self, item: dict[str, Any]) -> None:
        self.invalid_ref_count += 1
        if len(self.invalid_refs) < MAX_REF_REPORTS:
            self.invalid_refs.append(item)

    def add_external(self, ref: str, source: str) -> None:
        key = (ref, source)
        if key in self._external_seen:
            return
        self._external_seen.add(key)
        if len(self.external_refs) < MAX_REF_REPORTS:
            self.external_refs.append({"ref": ref, "source": source})


def _classify_ref(ref: str) -> tuple[str, str]:
    """把 $ref 分为本地 / 外部，返回 (kind, pointer)。

    - ``#/a/b`` 与 ``/a/b``：本地 JSON Pointer；``#`` / ``#/``：文档根；
    - 带非空前缀的 URI（``./other.yaml#/...``、``http://...#/...``）及裸名：外部；
    - 同文档片段但不是合法 JSON Pointer（``#foo``）：非法本地引用。

    kind ∈ {"local", "external", "root", "malformed"}。
    """
    if "#" in ref:
        prefix, fragment = ref.split("#", 1)
        if prefix.strip():
            return "external", ""
        if fragment in ("", "/"):
            return "root", ""
        if fragment.startswith("/"):
            return "local", fragment
        return "malformed", fragment
    if ref.startswith("/"):
        return "local", ref
    return "external", ""


def _handle_ref(
    doc: dict[str, Any],
    ref: str,
    source: str,
    ctx: _Ctx,
    work: list[tuple[Any, str]],
) -> None:
    """处理一个 $ref：分类为可达 / 无效本地引用 / 外部引用，并安排目标遍历。"""
    kind, pointer = _classify_ref(ref)
    if kind == "external":
        # 裸名 / 外部文件引用：不解析，单独列出提示
        ctx.add_external(ref, source)
        return
    if kind == "root":
        # $ref: "#" 指向文档根：展开根会把所有组件误标为可达，跳过
        return
    if kind == "malformed":
        ctx.add_invalid({
            "kind": "ref",
            "ref": ref,
            "pointer": pointer,
            "source": source,
            "reason": f"无效本地引用：片段 '{pointer}' 不是合法的 JSON Pointer",
        })
        return

    try:
        target = resolve_pointer(doc, pointer)
    except PointerError as exc:
        ctx.add_invalid({
            "kind": "ref",
            "ref": ref,
            "pointer": pointer,
            "source": source,
            "reason": f"无效本地引用：{exc}",
        })
        return

    comp = _is_component_pointer(pointer)
    if comp is not None:
        ctx.reachable.add(pointer)

    # 目标只访问一次：循环引用（A→B→A）与多处共享引用在此去重
    if pointer in ctx.visited_targets:
        return
    ctx.visited_targets.add(pointer)
    work.append((target, pointer))


def _scan_security(doc: dict[str, Any], ctx: _Ctx) -> None:
    """收集全局 / 操作级 security 按名称引用的 securitySchemes。

    已声明的名称 → 标记可达；未声明的名称 → 无效引用（给出作用域与来源）。
    """
    components = doc.get("components")
    schemes = (
        components.get("securitySchemes")
        if isinstance(components, dict) and isinstance(components.get("securitySchemes"), dict)
        else {}
    )

    def collect(req_node: Any, scope: str, source: str) -> None:
        if not isinstance(req_node, list):
            return
        for idx, requirement in enumerate(req_node):
            if not isinstance(requirement, dict):
                continue
            # 每个 requirement 是 {方案名: [scope, ...]}；空对象 {} 表示匿名放行，跳过
            for name in requirement:
                if name in schemes:
                    ctx.reachable.add(_component_pointer("securitySchemes", name))
                    ctx.security_refs.append({
                        "name": name,
                        "pointer": _component_pointer("securitySchemes", name),
                        "scope": scope,
                        "source": source,
                    })
                else:
                    where = "全局" if scope == "global" else "操作级"
                    ctx.add_invalid({
                        "kind": "security",
                        "name": name,
                        "scope": scope,
                        "source": source,
                        "ref": name,
                        "reason": f"{where} security 引用了未声明的 securityScheme：{name}",
                    })

    collect(doc.get("security"), "global", "")

    for container in ("paths", "webhooks"):
        holder = doc.get(container)
        if not isinstance(holder, dict):
            continue
        for key, item in holder.items():
            effective = item
            # path item 可能整体 $ref 到 components/pathItems，操作在引用目标上
            if isinstance(item, dict) and isinstance(item.get("$ref"), str):
                kind, pointer = _classify_ref(item["$ref"])
                if kind == "local":
                    try:
                        effective = resolve_pointer(doc, pointer)
                    except PointerError:
                        effective = item
            if not isinstance(effective, dict):
                continue
            base = f"/{container}/{encode_token(key)}"
            for method in HTTP_METHODS:
                operation = effective.get(method)
                if isinstance(operation, dict) and "security" in operation:
                    collect(operation["security"], "operation", f"{base}/{method}")


def analyze_side(doc: dict[str, Any]) -> dict[str, Any]:
    """对单侧文档做组件可达性分析，返回结构化审计结果。"""
    ctx = _Ctx()
    entry_counts = {"paths": 0, "webhooks": 0}

    work: list[tuple[Any, str]] = []
    for container in ("paths", "webhooks"):
        holder = doc.get(container)
        if isinstance(holder, dict):
            entry_counts[container] = len(holder)
            for name, node in holder.items():
                work.append((node, f"/{container}/{encode_token(name)}"))

    # 1) 从入口出发沿 $ref 传递追踪（迭代式，避免深嵌套文档撑爆递归栈）
    while work:
        if ctx.nodes >= MAX_NODES:
            ctx.truncated = True
            break
        node, pointer = work.pop()
        if isinstance(node, dict):
            if id(node) in ctx.visited_ids:
                continue
            ctx.visited_ids.add(id(node))
            ctx.nodes += 1
            ref = node.get("$ref")
            if isinstance(ref, str):
                _handle_ref(doc, ref, pointer, ctx, work)
            # OpenAPI 3.1：$ref 的兄弟字段也参与追踪
            for key, value in node.items():
                if key == "$ref" or not isinstance(value, (dict, list)):
                    continue
                work.append((value, f"{pointer}/{encode_token(key)}"))
        elif isinstance(node, list):
            if id(node) in ctx.visited_ids:
                continue
            ctx.visited_ids.add(id(node))
            ctx.nodes += 1
            for idx, value in enumerate(node):
                if isinstance(value, (dict, list)):
                    work.append((value, f"{pointer}/{idx}"))

    # 2) security 按名称引用 securitySchemes
    _scan_security(doc, ctx)

    # 3) 枚举声明的组件，与可达集合做差
    components = doc.get("components")
    declared: dict[str, list[str]] = {}
    declared_pointers: set[str] = set()
    if isinstance(components, dict):
        for section in COMPONENT_SECTIONS:
            holder = components.get(section)
            if isinstance(holder, dict) and holder:
                names = list(holder.keys())
                declared[section] = names
                for name in names:
                    declared_pointers.add(_component_pointer(section, name))

    unreachable: list[dict[str, Any]] = []
    unreachable_by_type: dict[str, int] = {}
    for section in COMPONENT_SECTIONS:
        for name in declared.get(section, []):
            pointer = _component_pointer(section, name)
            if pointer in ctx.reachable:
                continue
            unreachable.append({
                "type": section,
                "name": name,
                "pointer": pointer,
            })
            unreachable_by_type[section] = unreachable_by_type.get(section, 0) + 1

    reachable_pointers = sorted(ctx.reachable & declared_pointers)

    return {
        "entry_points": entry_counts,
        "declared": {section: names for section, names in declared.items()},
        "declared_total": len(declared_pointers),
        "reachable": reachable_pointers,
        "reachable_total": len(reachable_pointers),
        "unreachable": unreachable,
        "unreachable_total": len(unreachable),
        "unreachable_by_type": unreachable_by_type,
        "security_refs": ctx.security_refs,
        "invalid_refs": ctx.invalid_refs,
        "invalid_refs_total": ctx.invalid_ref_count,
        "invalid_refs_truncated": ctx.invalid_ref_count > len(ctx.invalid_refs),
        "external_refs": ctx.external_refs,
        "external_refs_total": len(ctx._external_seen),
        "external_refs_truncated": len(ctx._external_seen) > len(ctx.external_refs),
        "truncated": ctx.truncated,
    }


def build_reachability_report(
    review_id: int, old_doc: dict[str, Any], new_doc: dict[str, Any]
) -> dict[str, Any]:
    """对已保存审查的新旧两侧分别审计，并标出新版独有 / 新版退化为未使用的组件。"""
    old = analyze_side(old_doc)
    new = analyze_side(new_doc)

    old_decl = {
        (section, name)
        for section, names in old["declared"].items()
        for name in names
    }
    old_unreachable = {(u["type"], u["name"]) for u in old["unreachable"]}

    new_only = 0
    for item in new["unreachable"]:
        key = (item["type"], item["name"])
        if key not in old_decl:
            item["status"] = "new_only"      # 新版独有且未使用
            new_only += 1
        elif key in old_unreachable:
            item["status"] = "both"          # 新旧两版均未使用
        else:
            item["status"] = "regressed"     # 旧版可达、新版变为未使用

    return {
        "review_id": review_id,
        "old": old,
        "new": new,
        "summary": {
            "old_unreachable": old["unreachable_total"],
            "new_unreachable": new["unreachable_total"],
            "new_only_unreachable": new_only,
            "old_invalid_refs": len(old["invalid_refs"]),
            "new_invalid_refs": len(new["invalid_refs"]),
            "old_external_refs": len(old["external_refs"]),
            "new_external_refs": len(new["external_refs"]),
        },
    }
