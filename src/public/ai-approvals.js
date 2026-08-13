// AI 可写工具审批中心的纯函数模块：状态、操作类型标签与 diff 渲染。

export const AI_APPROVAL_STATUS_LABELS = {
  pending: "待确认",
  rejected: "已拒绝",
  expired: "已过期",
  invalidated: "已失效",
  executing: "执行中",
  succeeded: "执行成功",
  failed: "执行失败"
};

export const AI_APPROVAL_STATUS_TONES = {
  pending: "is-pending",
  rejected: "is-muted",
  expired: "is-muted",
  invalidated: "is-error",
  executing: "is-running",
  succeeded: "is-success",
  failed: "is-error"
};

const AI_WRITE_OPERATION_LABELS = {
  create_setting: "新建世界设定",
  update_setting: "编辑世界设定",
  create_character: "新建角色",
  update_character: "编辑角色",
  create_race: "新建种族",
  update_race: "编辑种族",
  create_organization: "新建组织",
  update_organization: "编辑组织",
  create_timeline_event: "新建时间线事件",
  update_timeline_event: "编辑时间线事件",
  create_relationship: "新建人物关系",
  update_relationship: "编辑人物关系",
  create_outline: "新建章节大纲",
  update_outline: "编辑章节大纲",
  create_foreshadow: "新建伏笔",
  update_foreshadow: "编辑伏笔",
  create_chapter_annotation: "创建正文批注",
  create_analysis_task: "创建分析任务"
};

export function aiApprovalStatusLabel(status) {
  return AI_APPROVAL_STATUS_LABELS[status] ?? String(status ?? "未知");
}

export function aiApprovalStatusTone(status) {
  return AI_APPROVAL_STATUS_TONES[status] ?? "";
}

export function aiWriteOperationLabel(operationType) {
  return AI_WRITE_OPERATION_LABELS[operationType] ?? String(operationType ?? "未知操作");
}

export function aiApprovalStatusOptions(selected) {
  const entries = [
    ["", "全部状态"],
    ["pending", "待确认"],
    ["succeeded", "执行成功"],
    ["rejected", "已拒绝"],
    ["expired", "已过期"],
    ["invalidated", "已失效"],
    ["executing", "执行中"],
    ["failed", "执行失败"]
  ];
  return entries.map(([value, label]) => `<option value="${value}"${value === selected ? " selected" : ""}>${label}</option>`).join("");
}

export function aiApprovalStatusSummary(status, plan) {
  if (status === "invalidated" && plan.invalidationReason) return plan.invalidationReason;
  if (status === "succeeded" && plan.revokedAt) return "已撤销本次审批";
  if (status === "pending" && plan.expiresAt) return `将于 ${formatApprovalDateTime(plan.expiresAt)} 过期`;
  return AI_APPROVAL_STATUS_LABELS[status] ?? "";
}

function formatApprovalDateTime(value) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString("zh-CN", { hour12: false });
  } catch {
    return String(value);
  }
}

export function formatApprovalDateTimeForDisplay(value) {
  return formatApprovalDateTime(value);
}

function approvalChangeValueHtml(value) {
  if (value === null || value === undefined) return '<span class="ai-approval-empty">（无）</span>';
  if (typeof value === "object") return `<code>${escapeApprovalHtml(JSON.stringify(value))}</code>`;
  return escapeApprovalHtml(String(value));
}

function escapeApprovalHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** 渲染单个操作的 diff 表格；新建操作明确标记为“新增”。 */
export function aiApprovalOperationChangesHtml(operation) {
  const isCreate = String(operation.operationType).startsWith("create_");
  if (operation.operationType === "create_chapter_annotation") {
    const rows = (Array.isArray(operation.changes) ? operation.changes : []).map((change) => `<tr><th>${escapeApprovalHtml(String(change.label ?? change.field))}</th><td colspan="2"><span class="ai-approval-added">新增</span>${approvalChangeValueHtml(change.after)}</td></tr>`).join("");
    return `<table class="ai-approval-diff-table"><tbody>${rows}</tbody></table>
      ${operation.referencedText ? `<blockquote class="ai-approval-quote">${escapeApprovalHtml(operation.referencedText)}</blockquote>` : ""}`;
  }
  if (operation.operationType === "create_analysis_task") {
    const rows = (Array.isArray(operation.changes) ? operation.changes : []).map((change) => `<tr><th>${escapeApprovalHtml(String(change.label ?? change.field))}</th><td colspan="2">${approvalChangeValueHtml(change.after)}</td></tr>`).join("");
    return `<table class="ai-approval-diff-table"><tbody>${rows}</tbody></table>`;
  }
  const rows = (Array.isArray(operation.changes) ? operation.changes : []).map((change) => `<tr>
    <th>${escapeApprovalHtml(String(change.label ?? change.field))}</th>
    <td>${isCreate ? '<span class="ai-approval-added">新增</span>' : approvalChangeValueHtml(change.before)}</td>
    <td>${approvalChangeValueHtml(change.after)}</td>
  </tr>`).join("");
  return `<table class="ai-approval-diff-table"><thead><tr><th>字段</th><th>修改前</th><th>修改后</th></tr></thead><tbody>${rows}</tbody></table>`;
}

/** 渲染审批详情中的单条操作卡。 */
export function aiApprovalOperationHtml(operation, index) {
  const isCreate = String(operation.operationType).startsWith("create_");
  const targetLine = operation.targetId
    ? `<span class="ai-approval-target">${escapeApprovalHtml(String(operation.targetLabel ?? "目标对象"))}</span>${operation.targetVersionNo ? ` <small>版本 ${Number(operation.targetVersionNo)}</small>` : ""}`
    : `<span class="ai-approval-target">${escapeApprovalHtml(String(operation.targetLabel ?? "新词条"))}</span>`;
  const resultLine = operation.result
    ? `<p class="ai-approval-result">执行结果：${escapeApprovalHtml(String(operation.result.targetLabel ?? ""))}${operation.result.versionNo ? ` · 当前版本 ${Number(operation.result.versionNo)}` : ""}</p>`
    : operation.failure ? `<p class="ai-approval-result is-error">${escapeApprovalHtml(String(operation.failure))}</p>` : "";
  return `<section class="ai-approval-operation${isCreate ? " is-create" : ""}">
    <header>
      <strong>${index + 1}. ${escapeApprovalHtml(aiWriteOperationLabel(operation.operationType))}</strong>
      <span>${escapeApprovalHtml(String(operation.moduleLabel ?? ""))}${isCreate ? " · 新增" : ""}</span>
    </header>
    <p class="ai-approval-operation-summary">${escapeApprovalHtml(String(operation.aiSummary ?? ""))}</p>
    <p>${targetLine}</p>
    ${aiApprovalOperationChangesHtml(operation)}
    ${resultLine}
  </section>`;
}
