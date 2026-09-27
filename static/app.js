/* OpenAPI 兼容性审查 —— 原生 JS 前端（无构建、无框架） */
(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const state = {
    review: null,          // 当前审查结果（含 findings/summary/id）
    filter: { severity: "all", direction: "all", category: "all", text: "" },
    tree: { side: "new", pointer: "", data: null, loading: false },
    expandedFinding: null,
    view: "flat",          // flat=逐条发现 | groups=根因聚合
    groups: null,          // 聚合结果缓存（按当前审查）
    groupsMeta: null,
    groupsPromise: null,   // 进行中的聚合请求（防重复拉取）
    reconcile: null,       // 最近一次破坏项对账结果
  };

  const SEV_LABEL = {
    breaking: "破坏性",
    non_breaking: "兼容",
    deprecation: "废弃",
    info: "信息",
  };
  const CHANGE_LABEL = { added: "新增", removed: "删除", changed: "修改" };
  const DIRECTION_LABEL = {
    request: "请求", response: "响应", shared: "请求/响应", none: "结构",
  };
  const REL_LABEL = { primary: "主因", absorbed: "下游影响", same_cause: "同源" };
  const REL_TITLE = {
    primary: "该影响组的根因发现",
    absorbed: "父路径被整体替换/删除，该发现是其下游影响",
    same_cause: "共享/循环组件在多处引用产生的同一根因",
  };
  const EXEMPTION_STATUS = {
    active: "🛡️ 豁免生效中",
    expired: "⏰ 豁免已过期",
    revoked: "🚫 豁免已撤销",
  };
  const EXEMPTION_BADGE = {
    active: "🛡️ 已豁免",
    expired: "⏰ 豁免过期",
    revoked: "🚫 豁免撤销",
  };

  // ------------------------------------------------------------------ //
  // Tab 切换
  // ------------------------------------------------------------------ //
  function switchToTab(name) {
    $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
    $$(".tab-panel").forEach((p) =>
      p.classList.toggle("active", p.id === `tab-${name}`));
    if (name === "history") loadHistory();
  }

  $$(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchToTab(tab.dataset.tab));
  });

  // ------------------------------------------------------------------ //
  // 输入：文件上传 / 示例 / 清空
  // ------------------------------------------------------------------ //
  $$("input[type=file]").forEach((input) => {
    input.addEventListener("change", () => {
      const file = input.files[0];
      if (!file) return;
      const side = input.dataset.side;
      const reader = new FileReader();
      reader.onload = () => {
        $(`#${side}-spec`).value = reader.result;
        $(`#${side}-filename`).textContent = file.name;
        $(`#${side}-filename`).title = file.name;
      };
      reader.readAsText(file);
    });
  });

  $$("[data-sample]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const sample = window.SAMPLES[btn.dataset.sample];
      $("#old-spec").value = sample.old;
      $("#new-spec").value = sample.new;
      $("#old-filename").textContent = "sample-old.yaml 或 .json";
      $("#new-filename").textContent = "sample-new.yaml 或 .json";
      hideError();
    });
  });

  $("#clear-btn").addEventListener("click", () => {
    $("#old-spec").value = "";
    $("#new-spec").value = "";
    $("#old-filename").textContent = "";
    $("#new-filename").textContent = "";
    $("#result-area").classList.add("hidden");
    hideError();
  });

  $("#compare-btn").addEventListener("click", runCompare);

  // 逐条发现 / 根因聚合 视图切换
  $$("#view-toggle .toggle-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$("#view-toggle .toggle-btn").forEach((b) =>
        b.classList.toggle("active", b === btn));
      state.view = btn.dataset.view;
      renderCurrentView();
    });
  });

  async function runCompare() {
    const oldSpec = $("#old-spec").value;
    const newSpec = $("#new-spec").value;
    hideError();

    if (!oldSpec.trim() || !newSpec.trim()) {
      showError("请先在两侧粘贴或上传新旧两份 OpenAPI 文档。");
      return;
    }

    const btn = $("#compare-btn");
    btn.disabled = true;
    btn.textContent = "审查中…";
    $("#loading").classList.remove("hidden");
    $("#result-area").classList.add("hidden");

    try {
      const resp = await fetch("/api/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          old_spec: oldSpec,
          new_spec: newSpec,
          old_filename: $("#old-filename").textContent || null,
          new_filename: $("#new-filename").textContent || null,
          api_id: $("#api-id-input").value.trim() || null,
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        const sideCn = data.detail?.side === "old" ? "旧版" :
                       data.detail?.side === "new" ? "新版" : "";
        showError(`${sideCn}文档${sideCn ? " " : ""}解析失败：${data.detail?.message || data.detail || "未知错误"}`);
        return;
      }
      state.review = data;
      state.filter = { severity: "all", direction: "all", category: "all", text: "" };
      renderResult();
    } catch (err) {
      showError(`请求失败：${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = "开始审查 →";
      $("#loading").classList.add("hidden");
    }
  }

  function showError(msg) {
    const el = $("#error-banner");
    el.textContent = msg;
    el.classList.remove("hidden");
  }
  function hideError() {
    $("#error-banner").classList.add("hidden");
  }

  // ------------------------------------------------------------------ //
  // 结果渲染
  // ------------------------------------------------------------------ //
  function renderResult() {
    const r = state.review;
    // 历史数据若没有引擎序号 id，按 1 起始位置补齐（与后端回退规则一致）
    (r.findings || []).forEach((f, i) => { if (f.id == null) f.id = i + 1; });
    // 重置视图状态：默认逐条发现，聚合缓存随审查失效
    state.view = "flat";
    state.groups = null;
    state.groupsMeta = null;
    state.groupsPromise = null;
    $$("#view-toggle .toggle-btn").forEach((b) =>
      b.classList.toggle("active", b.dataset.view === "flat"));
    $("#view-meta").textContent = "";
    $("#result-area").classList.remove("hidden");
    $("#result-title").textContent = r.title || `审查 #${r.id}`;
    $("#result-meta").textContent =
      `记录 #${r.id} · 版本 ${r.old_version || "?"} → ${r.new_version || "?"} · 共 ${r.summary.total} 条变更`;

    const verdict = $("#verdict");
    if (r.summary.compatible) {
      verdict.textContent = "✅ 向后兼容";
      verdict.className = "verdict good";
    } else {
      verdict.textContent = `❌ ${r.summary.counts.breaking} 项破坏性变更`;
      verdict.className = "verdict bad";
    }

    renderStats();
    renderExemptionBar();
    $("#api-id-input").value = r.api_id || "";
    populateCategoryFilter();
    bindFiltersOnce();
    syncFilterControls();
    renderCurrentView();
    loadPointers();
    loadTree();
    syncReconcileCurrent();
  }

  function renderStats() {
    const c = state.review.summary.counts;
    const cards = [
      ["breaking", c.breaking || 0, "破坏性变更"],
      ["non_breaking", c.non_breaking || 0, "兼容性变更"],
      ["deprecation", c.deprecation || 0, "废弃提示"],
      ["info", c.info || 0, "信息性变更"],
    ];
    $("#stat-cards").innerHTML = cards.map(([sev, num, label]) =>
      `<div class="stat-card ${sev}"><div class="num">${num}</div><div class="label">${label}</div></div>`
    ).join("");

    $$("[data-count]").forEach((el) => {
      const key = el.dataset.count;
      el.textContent = key === "all"
        ? state.review.summary.total
        : (state.review.summary.counts[key] || 0);
    });
  }

  // ------------------------------------------------------------------ //
  // 限时豁免（创建 / 撤销 / API 标识 / 放行结论）
  // ------------------------------------------------------------------ //
  function renderExemptionBar() {
    const r = state.review;
    const bar = $("#exemption-bar");
    if (!r || !r.exemption_summary) {
      bar.classList.add("hidden");
      return;
    }
    const s = r.exemption_summary;
    const apiId = r.api_id || "";
    let html = `<div class="ex-row">
      <span class="ex-api-label">API 标识：<b>${apiId ? escapeHtml(apiId) : "（未设置）"}</b></span>
      <input type="text" id="api-id-edit" placeholder="API 标识（用于豁免匹配）"
        value="${escapeAttr(apiId)}" title="保存后按该标识重新匹配豁免；清空则不应用豁免" />
      <button id="api-id-save" class="mini-btn ex-save" title="保存 API 标识">保存</button>
      ${s.applied ? "" : '<span class="ex-hint">未设置标识的审查不应用任何豁免</span>'}
    </div>`;
    html += `<div class="ex-row ex-counts">
      <span class="pill ${s.releasable ? "good" : "bad"}">${escapeHtml(s.conclusion)}</span>
      <span class="ex-stat">破坏 <b>${s.breaking_total}</b></span>
      <span class="ex-stat ok">🛡️ 已豁免 <b>${s.exempted}</b></span>
      <span class="ex-stat warn">⚠️ 未豁免 <b>${s.unexempted}</b></span>
    </div>`;
    const rows = r.exemptions || [];
    if (rows.length) {
      html += `<details class="ex-list"><summary>豁免记录（${rows.length}）</summary>` +
        rows.map(exemptionRowHtml).join("") + "</details>";
    }
    bar.innerHTML = html;
    bar.classList.remove("hidden");
    $("#api-id-save").addEventListener("click", saveApiId);
    bar.querySelectorAll("[data-ex-revoke]").forEach((btn) =>
      btn.addEventListener("click", () => revokeExemption(Number(btn.dataset.exRevoke))));
  }

  function exemptionRowHtml(row) {
    const st = EXEMPTION_STATUS[row.status] || row.status;
    return `<div class="ex-record ${row.status}">
      <span class="ex-pill ${row.status}">${st}</span>
      <span class="ex-rec-main">
        ${row.endpoint ? `<span class="finding-endpoint">${escapeHtml(row.endpoint)}</span>` : ""}
        <code>${escapeHtml(row.rule_id || "")}</code>
        <span class="ex-loc">📍 ${escapeHtml(row.location || "")}</span>
      </span>
      <span class="ex-rec-meta">理由：${escapeHtml(row.reason || "—")} · 到期（UTC）：${escapeHtml(row.expires_at || "—")}${row.matched ? " · 命中当前发现" : " · 未命中当前发现"}${row.revoked_at ? ` · 撤销于 ${escapeHtml(row.revoked_at)}` : ""}</span>
      ${row.status === "active" ? `<button class="mini-link ex-revoke" data-ex-revoke="${row.id}" title="撤销该豁免，撤销后立即失效">撤销</button>` : ""}
    </div>`;
  }

  /** 豁免 / 标识变更后的轻量刷新：不重置视图与筛选，仅重算展示。 */
  function applyReviewUpdate(data) {
    state.review = data;
    (data.findings || []).forEach((f, i) => { if (f.id == null) f.id = i + 1; });
    $("#api-id-input").value = data.api_id || "";
    renderStats();
    renderExemptionBar();
    renderCurrentView();
  }

  async function saveApiId() {
    if (!state.review || !state.review.id) return;
    const apiId = $("#api-id-edit").value.trim();
    try {
      const resp = await fetch(`/api/reviews/${state.review.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_id: apiId || null }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        showError(data.detail || `保存 API 标识失败（HTTP ${resp.status}）`);
        return;
      }
      hideError();
      applyReviewUpdate(data);
    } catch (err) {
      showError(`保存 API 标识失败：${err.message}`);
    }
  }

  async function createExemption(findingId, box) {
    if (!state.review || !state.review.id) return;
    const reason = box.querySelector(".ex-reason-input").value.trim();
    const expiresLocal = box.querySelector(".ex-expires-input").value;
    if (!reason) { showError("请填写豁免理由。"); return; }
    if (!expiresLocal) { showError("请选择 UTC 到期时间。"); return; }
    // datetime-local 输入按 UTC 解释（输入框旁已标注 UTC）
    const expires = new Date(`${expiresLocal}Z`);
    if (Number.isNaN(expires.getTime())) { showError("到期时间格式无效。"); return; }
    try {
      const resp = await fetch(`/api/reviews/${state.review.id}/exemptions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          finding_id: findingId,
          reason,
          expires_at: expires.toISOString(),
        }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        showError(data.detail || `创建豁免失败（HTTP ${resp.status}）`);
        return;
      }
      hideError();
      applyReviewUpdate(data);
    } catch (err) {
      showError(`创建豁免失败：${err.message}`);
    }
  }

  async function revokeExemption(exemptionId) {
    if (!state.review || !state.review.id) return;
    if (!confirm("确定撤销该豁免？撤销后立即失效。")) return;
    try {
      const resp = await fetch(
        `/api/reviews/${state.review.id}/exemptions/${exemptionId}/revoke`,
        { method: "POST" });
      const data = await resp.json();
      if (!resp.ok) {
        showError(data.detail || `撤销豁免失败（HTTP ${resp.status}）`);
        return;
      }
      hideError();
      applyReviewUpdate(data);
    } catch (err) {
      showError(`撤销豁免失败：${err.message}`);
    }
  }

  function populateCategoryFilter() {
    const cats = new Set(state.review.findings.map((f) => f.category));
    const sel = $("#category-filter");
    const current = sel.value;
    sel.innerHTML = `<option value="all">全部分类</option>` +
      Array.from(cats).sort().map((c) => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join("");
    sel.value = current && cats.has(current) ? current : "all";
  }

  let filtersBound = false;
  function bindFiltersOnce() {
    if (filtersBound) return;
    filtersBound = true;

    $$("#severity-filters .chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        $$("#severity-filters .chip").forEach((c) => c.classList.remove("active"));
        chip.classList.add("active");
        state.filter.severity = chip.dataset.severity;
        renderCurrentView();
      });
    });
    $("#direction-filter").addEventListener("change", (e) => {
      state.filter.direction = e.target.value;
      renderCurrentView();
    });
    $("#category-filter").addEventListener("change", (e) => {
      state.filter.category = e.target.value;
      renderCurrentView();
    });
    $("#text-filter").addEventListener("input", (e) => {
      state.filter.text = e.target.value.trim().toLowerCase();
      renderCurrentView();
    });
  }

  function syncFilterControls() {
    const f = state.filter;
    $$("#severity-filters .chip").forEach((c) =>
      c.classList.toggle("active", c.dataset.severity === f.severity));
    $("#direction-filter").value = f.direction;
    $("#category-filter").value = f.category;
    $("#text-filter").value = f.text;
  }

  function filteredFindings() {
    const f = state.filter;
    return state.review.findings.filter((item) => {
      if (f.severity !== "all" && item.severity !== f.severity) return false;
      if (f.direction !== "all" && item.direction !== f.direction) return false;
      if (f.category !== "all" && item.category !== f.category) return false;
      if (f.text) {
        const hay = [
          item.message, item.location, item.endpoint,
          item.rule_id, item.category,
        ].join(" ").toLowerCase();
        if (!hay.includes(f.text)) return false;
      }
      return true;
    });
  }

  function renderCurrentView() {
    if (state.view === "groups") {
      renderGroups();
    } else {
      renderFindings();
    }
  }

  function renderFindings() {
    const list = $("#findings-list");
    const items = filteredFindings();
    $("#view-meta").textContent = "";
    $("#findings-empty").classList.toggle("hidden", items.length > 0);

    // 破坏性优先，其次按分类/定位排序
    const order = { breaking: 0, deprecation: 1, non_breaking: 2, info: 3 };
    items.sort((a, b) =>
      (order[a.severity] - order[b.severity]) ||
      (a.endpoint || "").localeCompare(b.endpoint || "") ||
      a.id - b.id
    );

    list.innerHTML = items.map((f) => findingCard(f)).join("");

    list.querySelectorAll(".finding").forEach((card) => {
      const head = card.querySelector(".finding-head");
      head.addEventListener("click", (e) => {
        if (e.target.closest(".mini-link, code")) return;
        card.querySelector(".finding-body").classList.toggle("hidden");
      });
    });
    bindFindingInteractions(list);
  }

  /** 绑定发现卡片内的交互：引用树跳转 + 最小复现包导出 + 豁免（两种视图共用）。 */
  function bindFindingInteractions(root) {
    root.querySelectorAll("[data-tree-pointer]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const pointer = el.dataset.treePointer;
        if (!pointer) return;
        jumpToRef(el.dataset.treeRef || null, el.dataset.treeSide, pointer);
      });
    });
    root.querySelectorAll("[data-repro]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        downloadRepro(Number(btn.dataset.repro), btn);
      });
    });
    root.querySelectorAll("[data-ex-create]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        createExemption(Number(btn.dataset.exCreate), btn.closest(".exemption-box"));
      });
    });
    root.querySelectorAll("[data-ex-revoke]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        revokeExemption(Number(btn.dataset.exRevoke));
      });
    });
  }

  function refButtons(f) {
    return [
      f.old_ref ? `<button class="mini-link" title="在旧版引用树中查看"
          data-tree-ref="${escapeAttr(f.old_ref)}" data-tree-side="old"
          data-tree-pointer="${escapeAttr(f.old_ref)}">🌲旧</button>` : "",
      f.new_ref ? `<button class="mini-link" title="在新版引用树中查看"
          data-tree-ref="${escapeAttr(f.new_ref)}" data-tree-side="new"
          data-tree-pointer="${escapeAttr(f.new_ref)}">🌲新</button>` : "",
    ].join("");
  }

  /** 发现详情体：定位 / 双侧指针 / 旧新值 / 规则 / 复现导出（两种视图共用）。 */
  function findingBodyHtml(f) {
    const hasValues = f.old_value !== null || f.new_value !== null;
    const oldVal = hasValues
      ? `<div class="value-box"><div class="vb-label">旧值</div><pre>${escapeHtml(pretty(f.old_value))}</pre></div>` : "";
    const newVal = hasValues
      ? `<div class="value-box"><div class="vb-label">新值</div><pre>${escapeHtml(pretty(f.new_value))}</pre></div>` : "";
    return `
      <div class="loc-line">📍 ${escapeHtml(f.location)}</div>
      <div class="path-rows">
        <span class="k">旧路径</span>
        <code data-tree-side="old" data-tree-pointer="${escapeAttr(f.old_json_path || "")}"
          ${f.old_ref ? `data-tree-ref="${escapeAttr(f.old_ref)}"` : ""}>
          ${escapeHtml(f.old_json_path || "—（新版新增）")}</code>
        <span class="k">新路径</span>
        <code data-tree-side="new" data-tree-pointer="${escapeAttr(f.new_json_path || "")}"
          ${f.new_ref ? `data-tree-ref="${escapeAttr(f.new_ref)}"` : ""}>
          ${escapeHtml(f.new_json_path || "—（旧版删除）")}</code>
      </div>
      ${hasValues ? `<div class="value-diff">${oldVal}${newVal}</div>` : ""}
      <div class="rule-id">rule: ${escapeHtml(f.rule_id)} · 方向：${DIRECTION_LABEL[f.direction] || f.direction} · 分类：${escapeHtml(f.category)}</div>
      ${f.severity === "breaking" ? exemptionBlockHtml(f) : ""}
      <div class="repro-row">
        <button class="mini-link repro-btn" data-repro="${f.id}"
          title="裁剪新旧文档，仅保留该发现所属路径/操作及其传递引用的组件，打包 ZIP 下载">📦 导出最小复现包</button>
        <span class="repro-hint">含 old.yaml / new.yaml / manifest.json，导出前会自动复核可复现性</span>
      </div>`;
  }

  /** 破坏项的豁免区块：匹配状态 / 理由 / 到期时间 + 创建表单（需已设置 API 标识）。 */
  function exemptionBlockHtml(f) {
    const hasApiId = !!(state.review && state.review.api_id);
    const ex = f.exemption || null;
    let html = '<div class="exemption-box">';
    if (ex) {
      html += `<div class="ex-status ${ex.status}">`
        + `<span class="ex-pill ${ex.status}">${EXEMPTION_STATUS[ex.status] || ex.status}</span>`
        + ` <span class="ex-detail">理由：${escapeHtml(ex.reason || "—")}</span>`
        + ` <span class="ex-detail">到期（UTC）：${escapeHtml(ex.expires_at || "—")}</span>`
        + (ex.revoked_at ? ` <span class="ex-detail">撤销于（UTC）：${escapeHtml(ex.revoked_at)}</span>` : "")
        + (ex.status === "active"
          ? ` <button class="mini-link ex-revoke" data-ex-revoke="${ex.id}" title="撤销该豁免，撤销后立即失效">撤销豁免</button>`
          : "")
        + "</div>";
    } else {
      html += `<div class="ex-status none">未豁免${hasApiId ? "" : "（审查未设置 API 标识，豁免不适用）"}</div>`;
    }
    if (hasApiId) {
      html += `<div class="ex-form">
        <input type="text" class="ex-reason-input" placeholder="豁免理由（必填）" maxlength="200" />
        <input type="datetime-local" class="ex-expires-input" title="UTC 到期时间（须为未来时间）" />
        <span class="ex-tz">UTC</span>
        <button class="mini-link ex-create" data-ex-create="${f.id}"
          title="按 规则+方向+端点+位置+新旧值 匹配该破坏项，到期或撤销后自动失效">＋ 创建限时豁免</button>
      </div>`;
    }
    return html + "</div>";
  }

  function findingCard(f) {
    const bodyHidden = state.expandedFinding === f.id ? "" : "hidden";
    const exBadge = f.severity === "breaking" && f.exemption
      ? `<span class="ex-badge ${f.exemption.status}"
          title="${escapeAttr(EXEMPTION_STATUS[f.exemption.status] || "")}：${escapeAttr(f.exemption.reason || "")}，到期（UTC）${escapeAttr(f.exemption.expires_at || "—")}"
        >${EXEMPTION_BADGE[f.exemption.status] || ""}</span>`
      : "";

    return `
    <article class="finding ${f.severity}" data-id="${f.id}">
      <div class="finding-head">
        <span class="finding-badge">${SEV_LABEL[f.severity] || f.severity}</span>
        ${f.endpoint ? `<span class="finding-endpoint">${escapeHtml(f.endpoint)}</span>` : ""}
        <p class="finding-msg">${escapeHtml(f.message)}</p>
        <span class="finding-meta">
          ${exBadge}
          <span class="change-tag">${CHANGE_LABEL[f.change] || f.change}</span>
          ${refButtons(f)}
        </span>
      </div>
      <div class="finding-body ${bodyHidden}">
        ${findingBodyHtml(f)}
      </div>
    </article>`;
  }

  // ------------------------------------------------------------------ //
  // 根因聚合视图
  // ------------------------------------------------------------------ //
  async function ensureGroups() {
    if (state.groups) return;
    if (!state.groupsPromise) {
      const rid = state.review.id;
      state.groupsPromise = fetch(`/api/reviews/${rid}/groups`)
        .then(async (resp) => {
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const data = await resp.json();
          // 审查已切换时丢弃迟到结果
          if (state.review && state.review.id === rid) {
            state.groups = data.groups || [];
            state.groupsMeta = data;
          }
        })
        .finally(() => { state.groupsPromise = null; });
    }
    await state.groupsPromise;
  }

  function filteredGroups() {
    const f = state.filter;
    return (state.groups || []).filter((g) => {
      if (f.severity !== "all" && g.severity !== f.severity) return false;
      if (f.direction !== "all" && g.direction !== f.direction) return false;
      if (f.category !== "all" && g.category !== f.category) return false;
      if (f.text) {
        const hay = [
          g.rule_id, g.category, g.endpoint, g.primary.message, g.primary.location,
          ...g.affected.flatMap((a) => [a.message, a.location, a.rule_id]),
        ].join(" ").toLowerCase();
        if (!hay.includes(f.text)) return false;
      }
      return true;
    });
  }

  async function renderGroups() {
    const list = $("#findings-list");
    if (!state.groups) {
      list.innerHTML = '<div class="empty-hint">正在计算根因聚合…</div>';
      $("#findings-empty").classList.add("hidden");
      try {
        await ensureGroups();
      } catch (err) {
        list.innerHTML = `<div class="empty-hint">聚合加载失败：${escapeHtml(err.message)}</div>`;
        return;
      }
    }
    const meta = state.groupsMeta || {};
    $("#view-meta").textContent =
      `共 ${meta.total_findings ?? 0} 条发现 → ${meta.group_count ?? 0} 个影响组` +
      (meta.affected_count ? `（${meta.affected_count} 条为下游/同源影响）` : "");

    const groups = filteredGroups();
    $("#findings-empty").classList.toggle("hidden", groups.length > 0);
    list.innerHTML = groups.map((g) => groupCard(g)).join("");

    list.querySelectorAll(".group-head").forEach((head) => {
      head.addEventListener("click", (e) => {
        if (e.target.closest(".mini-link, code")) return;
        head.parentElement.querySelector(":scope > .finding-body").classList.toggle("hidden");
      });
    });
    list.querySelectorAll(".entry-head").forEach((head) => {
      head.addEventListener("click", (e) => {
        if (e.target.closest(".mini-link, code")) return;
        const body = head.nextElementSibling;
        if (body) body.classList.toggle("hidden");
      });
    });
    bindFindingInteractions(list);
  }

  function groupCard(g) {
    const p = g.primary;
    return `
    <article class="finding group ${g.severity}" data-gid="${escapeAttr(g.group_id)}">
      <div class="finding-head group-head">
        <span class="finding-badge">${SEV_LABEL[g.severity] || g.severity}</span>
        ${g.endpoint ? `<span class="finding-endpoint">${escapeHtml(g.endpoint)}</span>` : ""}
        <p class="finding-msg">${escapeHtml(p.message)}</p>
        <span class="finding-meta">
          <span class="group-size" title="组内发现总数（主因 + 受影响条目）">${g.member_count} 条</span>
          <span class="change-tag">${CHANGE_LABEL[g.change] || g.change}</span>
          <span class="group-id" title="稳定组标识">${escapeHtml(g.group_id)}</span>
        </span>
      </div>
      <div class="finding-body hidden">
        <div class="group-section">主因</div>
        ${groupEntryHtml(p, true)}
        ${g.affected.length ? `<div class="group-section">受影响条目（${g.affected.length}）</div>` : ""}
        ${g.affected.map((e) => groupEntryHtml(e, false)).join("")}
        <div class="rule-id">group: ${escapeHtml(g.group_id)} · rule: ${escapeHtml(g.rule_id)} · 方向：${DIRECTION_LABEL[g.direction] || g.direction} · 分类：${escapeHtml(g.category || "")}</div>
      </div>
    </article>`;
  }

  function groupEntryHtml(f, isPrimary) {
    const rel = f.relation || (isPrimary ? "primary" : "absorbed");
    const indent = !isPrimary && f.depth > 0
      ? ` style="margin-left:${Math.min(f.depth, 4) * 14}px"` : "";
    return `
    <div class="group-entry ${f.severity}"${indent}>
      <div class="entry-head">
        <span class="relation-tag ${rel}" title="${escapeAttr(REL_TITLE[rel] || "")}">${REL_LABEL[rel] || rel}</span>
        <span class="finding-badge">${SEV_LABEL[f.severity] || f.severity}</span>
        <p class="finding-msg">${escapeHtml(f.message)}</p>
        <span class="finding-meta">${refButtons(f)}</span>
      </div>
      <div class="entry-body ${isPrimary ? "" : "hidden"}">
        ${findingBodyHtml(f)}
      </div>
    </div>`;
  }

  function pretty(v) {
    if (v === null || v === undefined) return "—";
    if (typeof v === "string") return v;
    try {
      return JSON.stringify(v, null, 2);
    } catch (_) {
      return String(v);
    }
  }

  // ------------------------------------------------------------------ //
  // 引用展开树
  // ------------------------------------------------------------------ //
  async function loadPointers() {
    if (!state.review) return;
    try {
      const resp = await fetch(`/api/reviews/${state.review.id}/pointers`);
      const groups = await resp.json();
      const side = state.tree.side;
      const sel = $("#tree-pointer");
      sel.innerHTML = (groups[side] || []).map((g) =>
        `<optgroup label="${escapeAttr(g.group)}">` +
        g.items.map((it) =>
          `<option value="${escapeAttr(it.pointer)}">${escapeHtml(it.label)}</option>`
        ).join("") + "</optgroup>"
      ).join("");
      sel.value = "";
    } catch (err) {
      /* 忽略：树控件只是辅助功能 */
    }
  }

  $("#tree-side").addEventListener("change", async (e) => {
    state.tree.side = e.target.value;
    state.tree.pointer = "";
    await loadPointers();
    $("#tree-pointer").value = "";
    loadTree();
  });

  $("#tree-pointer").addEventListener("change", (e) => {
    state.tree.pointer = e.target.value;
    loadTree();
  });

  async function loadTree(targetPointer) {
    if (!state.review) return;
    const container = $("#tree-container");
    container.innerHTML = '<div class="empty-hint">加载中…</div>';
    const pointer = targetPointer !== undefined ? state.tree.pointer : state.tree.pointer;

    const qs = new URLSearchParams({
      side: state.tree.side,
      pointer: pointer || "",
    });
    let wanted = "";
    if (targetPointer !== undefined && targetPointer && targetPointer !== pointer) {
      wanted = targetPointer;
      qs.set("target", targetPointer);
    }
    try {
      const resp = await fetch(`/api/reviews/${state.review.id}/tree?${qs}`);
      const tree = await resp.json();
      state.tree.data = tree;
      renderTree(tree, container, wanted || pointer || "");
    } catch (err) {
      container.innerHTML = `<div class="empty-hint">树加载失败：${escapeHtml(err.message)}</div>`;
    }
  }

  function renderTree(tree, container, targetPointer) {
    container.innerHTML = "";
    const nodeEl = renderTreeNode(tree, 0, true, targetPointer, []);
    container.appendChild(nodeEl);
    // 滚动到目标节点
    const hit = container.querySelector(".tree-row.is-target");
    if (hit) {
      hit.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  function renderTreeNode(node, depth, isRoot, targetPointer, targetPath) {
    const wrap = document.createElement("div");
    wrap.className = "tree-node" + (isRoot ? " root" : "");

    const hasChildren = Array.isArray(node.children) && node.children.length > 0;
    const row = document.createElement("div");
    const circular = !!node.circular;
    const onTargetPath = targetPath.includes(node.name) ||
      (isRoot && depth === 0);
    row.className =
      `tree-row kind-${node.kind || "object"}` +
      (circular ? " circular" : "") +
      (node.pointer && node.pointer === targetPointer ? " is-target" : "");

    const toggle = document.createElement("span");
    toggle.className = "tree-toggle" + (hasChildren ? "" : " leaf");
    toggle.textContent = "▸";
    row.appendChild(toggle);

    const name = document.createElement("span");
    name.className = "tree-name";
    name.textContent = node.name || "(node)";
    row.appendChild(name);

    if (node.ref) {
      const badge = document.createElement("span");
      badge.className = "tree-badge";
      badge.textContent = circular ? "circular ref" : "$ref";
      row.appendChild(badge);
    }

    if (node.summary) {
      const sum = document.createElement("span");
      sum.className = "tree-summary";
      sum.textContent = node.summary;
      row.appendChild(sum);
    }

    if (node.truncated) {
      const t = document.createElement("span");
      t.className = "tree-badge";
      t.textContent = "已截断";
      row.appendChild(t);
    }

    if (node.pointer) {
      const ptr = document.createElement("span");
      ptr.className = "tree-pointer";
      ptr.textContent = node.pointer;
      row.appendChild(ptr);
    }

    wrap.appendChild(row);

    if (hasChildren) {
      const childBox = document.createElement("div");
      childBox.className = "tree-children";
      // 默认：根与前两层展开；有深链目标时只展开目标路径上的节点
      const openByDefault =
        (targetPointer && (depth < 2 || onTargetPath)) ||
        (!targetPointer && depth < 2);
      childBox.style.display = openByDefault ? "block" : "none";
      if (openByDefault) toggle.textContent = "▾";

      node.children.forEach((child) => {
        childBox.appendChild(
          renderTreeNode(child, depth + 1, false, targetPointer, targetPath)
        );
      });
      wrap.appendChild(childBox);

      row.addEventListener("click", (e) => {
        if (e.target.closest("a")) return;
        const open = childBox.style.display !== "none";
        childBox.style.display = open ? "none" : "block";
        toggle.textContent = open ? "▸" : "▾";
      });
    }

    return wrap;
  }

  $("#tree-expand").addEventListener("click", () => {
    $$("#tree-container .tree-children").forEach((box) => {
      box.style.display = "block";
    });
    $$("#tree-container .tree-toggle:not(.leaf)").forEach((t) => {
      t.textContent = "▾";
    });
  });
  $("#tree-collapse").addEventListener("click", () => {
    $$("#tree-container .tree-children").forEach((box) => {
      // 根节点的直接子层保持展开，其余全部折叠
      const isRootChildren = box.parentElement.classList.contains("root");
      box.style.display = isRootChildren ? "block" : "none";
    });
    $$("#tree-container .tree-toggle:not(.leaf)").forEach((t) => {
      const isRootToggle =
        t.closest(".tree-node") && t.closest(".tree-node").classList.contains("root");
      t.textContent = isRootToggle ? "▾" : "▸";
    });
  });

  /** 从发现项跳到引用树：切换 side、加载从根到目标的展开视图。 */
  async function jumpToRef(ref, side, pointer) {
    if (!state.review || !pointer) return;
    // 规范化：去掉 URI 片段前缀 #，使其与树节点 pointer 一致
    const normPointer = pointer.includes("#")
      ? pointer.slice(pointer.indexOf("#") + 1)
      : pointer;
    state.tree.side = side;
    $("#tree-side").value = side;
    await loadPointers();

    // 优先选目标所在的顶层组件分组（树更小、可读性好），否则从根展开
    const m = normPointer.match(/^(\/components\/(?:schemas|parameters|requestBodies|responses|headers)\/[^/]+)/);
    const rootPick = m ? m[1] : "";
    $("#tree-pointer").value = rootPick;
    state.tree.pointer = rootPick;
    await loadTree(normPointer || rootPick);
  }

  // ------------------------------------------------------------------ //
  // 报告下载
  // ------------------------------------------------------------------ //
  function downloadReport(format) {
    if (!state.review) return;
    window.location.href = `/api/reviews/${state.review.id}/report?format=${format}`;
  }
  $("#download-md").addEventListener("click", () => downloadReport("markdown"));
  $("#download-json").addEventListener("click", () => downloadReport("json"));

  // ------------------------------------------------------------------ //
  // 最小复现包导出
  // ------------------------------------------------------------------ //
  async function downloadRepro(findingId, btn) {
    if (!state.review || !findingId) return;
    const oldText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "📦 生成中…";
    try {
      const resp = await fetch(
        `/api/reviews/${state.review.id}/findings/${findingId}/repro`
      );
      if (!resp.ok) {
        let msg = `HTTP ${resp.status}`;
        try {
          const data = await resp.json();
          msg = data.detail || msg;
        } catch (_) { /* 非 JSON 错误响应 */ }
        showError(`最小复现包导出失败：${msg}`);
        return;
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `openapi-repro-r${state.review.id}-f${findingId}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      hideError();
    } catch (err) {
      showError(`最小复现包导出失败：${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = oldText;
    }
  }

  // ------------------------------------------------------------------ //
  // 历史记录
  // ------------------------------------------------------------------ //
  async function loadHistory() {
    const body = $("#history-body");
    body.innerHTML = `<tr><td colspan="7" style="color:var(--text-faint)">加载中…</td></tr>`;
    try {
      const resp = await fetch("/api/reviews");
      const data = await resp.json();
      const items = data.items || [];
      $("#history-empty").classList.toggle("hidden", items.length > 0);
      syncReconcileCurrent();
      // 基线选择器：保留已选项（若对应审查仍存在）
      const sel = $("#reconcile-baseline");
      const prevBaseline = sel.value;
      sel.innerHTML = `<option value="">选择基线审查…</option>` +
        items.map((it) =>
          `<option value="${it.id}">#${it.id} · ${escapeHtml(it.title || "未命名")}` +
          `（${escapeHtml(it.created_at || "")}）</option>`
        ).join("");
      sel.value = items.some((it2) => String(it2.id) === prevBaseline) ? prevBaseline : "";
      body.innerHTML = items.map((it) => {
        const c = it.summary.counts || {};
        return `
        <tr>
          <td>${it.id}</td>
          <td>${escapeHtml(it.created_at || "")}</td>
          <td>${escapeHtml(it.title || "")}</td>
          <td>${escapeHtml(it.old_version || "?")} → ${escapeHtml(it.new_version || "?")}</td>
          <td><span class="pill ${it.summary.compatible ? "good" : "bad"}">
            ${it.summary.compatible ? "兼容" : `${c.breaking || 0} 破坏`}
          </span></td>
          <td>${it.summary.total}</td>
          <td>
            <button class="link-btn" data-open="${it.id}">打开</button>
            <button class="link-btn" data-reconcile="${it.id}">对账</button>
            <button class="link-btn" data-md="${it.id}">MD</button>
            <button class="link-btn" data-del="${it.id}">删除</button>
          </td>
        </tr>`;
      }).join("");

      body.querySelectorAll("[data-open]").forEach((b) =>
        b.addEventListener("click", async () => {
          const review = await (await fetch(`/api/reviews/${b.dataset.open}`)).json();
          state.review = review;
          state.filter = { severity: "all", direction: "all", category: "all", text: "" };
          switchToTab("review");
          renderResult();
          window.scrollTo({ top: 0, behavior: "smooth" });
        }));
      body.querySelectorAll("[data-reconcile]").forEach((b) =>
        b.addEventListener("click", () => {
          $("#reconcile-baseline").value = b.dataset.reconcile;
          $(".reconcile-panel").scrollIntoView({ block: "start", behavior: "smooth" });
          runReconcile();
        }));
      body.querySelectorAll("[data-md]").forEach((b) =>
        b.addEventListener("click", () => {
          window.location.href = `/api/reviews/${b.dataset.md}/report?format=markdown`;
        }));
      body.querySelectorAll("[data-del]").forEach((b) =>
        b.addEventListener("click", async () => {
          if (!confirm("确定删除这条审查记录？")) return;
          await fetch(`/api/reviews/${b.dataset.del}`, { method: "DELETE" });
          loadHistory();
        }));
    } catch (err) {
      body.innerHTML = `<tr><td colspan="7" style="color:var(--breaking)">加载失败：${escapeHtml(err.message)}</td></tr>`;
    }
  }

  // ------------------------------------------------------------------ //
  // 破坏项对账（历史页：基线审查 vs 当前审查）
  // ------------------------------------------------------------------ //
  const REC_KIND = {
    added: { icon: "🆕", label: "新增" },
    continuing: { icon: "🔁", label: "延续" },
    disappeared: { icon: "✅", label: "已消失" },
  };

  function syncReconcileCurrent() {
    const el = $("#reconcile-current");
    if (!el) return;
    el.textContent = state.review && state.review.id
      ? `#${state.review.id} · ${state.review.title || "未命名"}`
      : "（尚未打开审查）";
  }

  function showReconcileError(msg) {
    const el = $("#reconcile-banner");
    el.textContent = msg;
    el.classList.remove("hidden");
  }

  async function runReconcile() {
    const banner = $("#reconcile-banner");
    const resultBox = $("#reconcile-result");
    banner.classList.add("hidden");
    resultBox.innerHTML = "";

    if (!state.review || !state.review.id) {
      showReconcileError("请先在下方历史记录中「打开」一条审查（或先执行一次新审查）作为当前审查，再选择基线对账。");
      return;
    }
    const baselineId = Number($("#reconcile-baseline").value);
    if (!baselineId) {
      showReconcileError("请选择一条已保存的审查作为基线。");
      return;
    }
    if (baselineId === state.review.id) {
      showReconcileError(`基线与当前审查相同（#${baselineId}），对账没有意义——请另选一条历史审查作为基线。`);
      return;
    }

    const btn = $("#reconcile-run");
    btn.disabled = true;
    btn.textContent = "对账中…";
    try {
      const resp = await fetch(
        `/api/reviews/${state.review.id}/reconcile?baseline_id=${baselineId}`);
      const data = await resp.json();
      if (!resp.ok) {
        showReconcileError(data.detail || `对账失败（HTTP ${resp.status}）`);
        return;
      }
      state.reconcile = data;
      renderReconcile(data);
    } catch (err) {
      showReconcileError(`对账请求失败：${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = "开始对账";
    }
  }

  function renderReconcile(data) {
    const box = $("#reconcile-result");
    const s = data.summary;
    const head = `
      <div class="reconcile-summary">
        <div class="rec-stat added"><div class="num">${s.added}</div><div class="label">🆕 新增破坏项</div></div>
        <div class="rec-stat continuing"><div class="num">${s.continuing}</div><div class="label">🔁 延续破坏项</div></div>
        <div class="rec-stat disappeared"><div class="num">${s.disappeared}</div><div class="label">✅ 已消失破坏项</div></div>
      </div>
      <p class="result-meta">
        当前审查 #${data.current.id}（${s.current_breaking} 项破坏） vs
        基线审查 #${data.baseline.id}（${s.baseline_breaking} 项破坏） ·
        稳定身份 = 端点 + 方向 + 规则 + 语义定位，同身份按出现次数一一配对
      </p>`;

    if (!s.added && !s.continuing && !s.disappeared) {
      box.innerHTML = head + `<div class="empty-hint">两次审查均无破坏性发现，无需对账。</div>`;
      return;
    }

    const cols = ["added", "continuing", "disappeared"].map((kind) => {
      const items = data[kind] || [];
      const meta = REC_KIND[kind];
      const body = items.length
        ? items.map((e) => recItemHtml(e)).join("")
        : `<div class="rec-empty">无</div>`;
      return `<div class="reconcile-col ${kind}">
        <div class="rec-col-head">${meta.icon} ${meta.label}（${items.length}）</div>
        ${body}
      </div>`;
    }).join("");
    box.innerHTML = head + `<div class="reconcile-columns">${cols}</div>`;

    box.querySelectorAll("[data-jump-current]").forEach((b) =>
      b.addEventListener("click", () =>
        jumpToFinding(data.current.id, Number(b.dataset.jumpCurrent))));
    box.querySelectorAll("[data-jump-baseline]").forEach((b) =>
      b.addEventListener("click", () =>
        jumpToFinding(data.baseline.id, Number(b.dataset.jumpBaseline))));
  }

  function recItemHtml(e) {
    const f = e.finding || {};
    const curBtn = e.current_finding_id != null
      ? `<button class="mini-link rec-jump" data-jump-current="${e.current_finding_id}"
          title="切到审查页，定位当前审查中的该发现">↗ 当前 #${e.current_finding_id}</button>` : "";
    const baseBtn = e.baseline_finding_id != null
      ? `<button class="mini-link rec-jump" data-jump-baseline="${e.baseline_finding_id}"
          title="打开基线审查，定位该发现">↗ 基线 #${e.baseline_finding_id}</button>` : "";
    return `
    <div class="rec-item">
      <div class="rec-msg">${escapeHtml(f.message || "")}</div>
      ${f.endpoint ? `<span class="finding-endpoint">${escapeHtml(f.endpoint)}</span>` : ""}
      <div class="rec-loc">📍 ${escapeHtml(f.location || "")}</div>
      <div class="rec-meta">
        <span class="rule-id">${escapeHtml(f.rule_id || "")}</span>
        ${curBtn}${baseBtn}
      </div>
    </div>`;
  }

  /** 跳到某次审查中的指定发现：切到审查页、清筛选、展开并高亮目标卡片。 */
  async function jumpToFinding(reviewId, findingId) {
    if (!state.review || state.review.id !== reviewId) {
      let review;
      try {
        const resp = await fetch(`/api/reviews/${reviewId}`);
        if (!resp.ok) {
          showReconcileError(`审查 #${reviewId} 已不存在或无法读取，无法定位该发现。`);
          return;
        }
        review = await resp.json();
      } catch (err) {
        showReconcileError(`定位失败：${err.message}`);
        return;
      }
      state.review = review;
      state.filter = { severity: "all", direction: "all", category: "all", text: "" };
      renderResult();
    }
    switchToTab("review");
    // 逐条视图 + 清空筛选，确保目标发现一定可见
    state.view = "flat";
    $$("#view-toggle .toggle-btn").forEach((b) =>
      b.classList.toggle("active", b.dataset.view === "flat"));
    state.filter = { severity: "all", direction: "all", category: "all", text: "" };
    syncFilterControls();
    state.expandedFinding = findingId;
    renderFindings();
    const card = document.querySelector(`#findings-list .finding[data-id="${findingId}"]`);
    if (card) {
      card.scrollIntoView({ block: "center", behavior: "smooth" });
      card.classList.add("flash");
      setTimeout(() => card.classList.remove("flash"), 2400);
    }
  }

  $("#reconcile-run").addEventListener("click", runReconcile);

  // ------------------------------------------------------------------ //
  // 规则说明（静态内容，与后端规则保持同步）
  // ------------------------------------------------------------------ //
  const RULES = [
    {
      title: "路径与操作",
      items: [
        "<code>删除路径 / 删除操作</code>：🔴 破坏性（404/405）",
        "<code>新增路径 / 新增操作</code>：🟢 纯扩展",
        "<code>operationId 改变</code>：⚪ codegen 客户端可能受影响",
        "<code>操作/参数/响应标记 deprecated</code>：🟡 废弃提示",
        "<code>移除 servers 地址</code>：🔴 仍在使用该地址的客户端失效",
      ],
    },
    {
      title: "参数（请求方向）",
      items: [
        "<code>新增必填参数</code>（含 path 参数）：🔴 旧请求被拒绝",
        "<code>可选 → 必填</code>：🔴 破坏性；必填 → 可选：🟢",
        "<code>删除参数</code>：🔴（header 参数除外，通常被忽略，列兼容）",
        "<code>style / explode 变化</code>：🔴 线上序列化格式不兼容",
        "参数 schema 变化按下方请求 Schema 规则判定",
      ],
    },
    {
      title: "请求体 Schema",
      items: [
        "<code>新增必填字段</code>：🔴；新增可选字段：🟢",
        "<code>删除字段</code>：🟢（服务端通常忽略多余字段）",
        "<code>必填 → 可选</code>：🟢；可选 → 必填：🔴",
        "<code>枚举取值减少</code>：🔴；枚举取值增加：🟢",
        "<code>min* 升高 / max* 降低</code>：🔴 收紧；反方向 🟢",
        "<code>新增 format 约束</code>、类型收窄：🔴",
        "<code>nullable → 非空</code>、字段变 readOnly：🔴",
        "<code>additionalProperties: true → false</code>：🔴",
      ],
    },
    {
      title: "响应 Schema（方向相反）",
      items: [
        "<code>删除响应字段</code>：🔴 客户端读到 undefined",
        "<code>新增必有字段</code>：🟢；新增可选字段：🟢（严格模型需确认）",
        "<code>必填 → 可选</code>：🔴；可选 → 必填：🟢",
        "<code>枚举取值增加</code>：🔴 客户端遇到未知值；减少：🟢",
        "<code>minimum 降低 / maximum 升高</code>：🔴 承诺范围扩大",
        "<code>变 nullable</code>、字段变 writeOnly：🔴",
        "<code>类型变多 / format 被移除</code>：🔴",
      ],
    },
    {
      title: "状态码与媒体类型",
      items: [
        "<code>删除 2xx 响应</code>：🔴；新增成功响应：🟢",
        "删除错误码：🔴（风险较低，消息中注明）",
        "请求：<code>服务端不再接受某 Content-Type</code>：🔴（415）",
        "响应：<code>新增一种返回 Content-Type</code>：🔴 严格客户端风险",
        "requestBody 可选 → 必填：🔴；必填 → 可选：🟢",
      ],
    },
    {
      title: "$ref 与循环引用",
      items: [
        "所有 schema/参数/请求体/响应中的 <code>$ref</code> 先解引用再比较",
        "自动合并 <code>allOf</code>（属性、required、约束按合取语义合并）",
        "组件自引用 / 互相引用（A→B→A）通过 DFS 栈检测，不会无限递归",
        "发现项给出载荷语义路径 + 文档 JSON Pointer 双重定位",
        "右侧展开树以 ⟳ 标记循环引用，点击 🌲 可直接跳转",
      ],
    },
  ];
  $("#rules-content").innerHTML = RULES.map((g) => `
    <div class="rule-card">
      <h3>${g.title}</h3>
      <ul>${g.items.map((i) => `<li>${i}</li>`).join("")}</ul>
    </div>`).join("");

  // ------------------------------------------------------------------ //
  // 工具
  // ------------------------------------------------------------------ //
  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function escapeAttr(s) {
    return escapeHtml(s).replace(/`/g, "&#96;");
  }
})();
