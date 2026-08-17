function enumLabel(labels, value, fallback) {
  const normalized = String(value ?? "").trim();
  if (Object.hasOwn(labels, normalized)) return labels[normalized];
  if (!normalized || /^[a-z][a-z0-9_-]*$/iu.test(normalized)) return fallback;
  return normalized;
}

export function settingStatusLabel(value) {
  return enumLabel({ draft: "草稿", pending: "待确认", confirmed: "已确认", deprecated: "已弃用" }, value, "未知状态");
}

export function timelineStatusLabel(value) {
  return enumLabel({ candidate: "候选", pending: "待确认", confirmed: "已确认", deprecated: "已弃用" }, value, "未知状态");
}

export function levelLabel(value) {
  return enumLabel({ low: "低", medium: "中", high: "高" }, value, "未知等级");
}

export function foreshadowStatusLabel(value) {
  return enumLabel({ planned: "计划中", planted: "已埋设", resolved: "已回收", abandoned: "已放弃" }, value, "未知状态");
}

export function outlineStatusLabel(value) {
  return enumLabel({ draft: "草稿", ready: "可执行", completed: "已完成" }, value, "未知状态");
}

export function relationshipCategoryLabel(value) {
  return enumLabel({ family: "亲属", social: "社交", emotional: "情感", conflict: "冲突", uncertain: "未确定" }, value, "其他关系");
}

export function relationshipConfirmationLabel(value) {
  return enumLabel({ pending: "待确认", confirmed: "已确认", rejected: "已拒绝" }, value, "未知状态");
}

export function reviewItemTypeLabel(value) {
  return enumLabel({
    consistency: "一致性问题",
    "character-duplicate": "角色重复",
    "character-name-variant": "疑似人物名错字",
    "timeline-conflict": "时间线冲突",
    "setting-conflict": "设定冲突",
    "relationship-conflict": "关系冲突",
    "character-conflict": "角色冲突",
    "plot-hole": "剧情漏洞",
    "low-confidence": "低置信度结论",
    chronology: "时间顺序问题",
    factual: "事实问题"
  }, value, "其他审核问题");
}

export function reviewStatusLabel(value) {
  return enumLabel({ pending: "待处理", ignored: "已忽略", fixing: "处理中", fixed: "已修复", exception: "例外保留" }, value, "未知状态");
}

export function taskScopeLabel(value) {
  return enumLabel({ none: "无上下文", selection: "选中文本", chapter: "当前章节", volume: "当前分卷", book: "全书", entities: "指定资料" }, value, "未指定范围");
}

export function providerStatusLabel(value) {
  return enumLabel({ enabled: "已启用", disabled: "已停用", error: "异常" }, value, "未知状态");
}

export function providerConnectionLabel(value) {
  return enumLabel({ unchecked: "未测试", success: "连接正常", failed: "连接失败" }, value, "未知连接状态");
}

export function providerProtocolLabel(value) {
  return enumLabel({
    "openai-chat-completions": "OpenAI Chat Completions",
    "anthropic-messages": "Anthropic Messages",
    "google-vertex": "Google Vertex"
  }, value, "未知接口协议");
}

export function chapterVersionSourceLabel(value) {
  return enumLabel({ manual: "人工保存", auto: "自动保存", "ai-suggestion": "AI 建议", restore: "历史恢复", import: "文件导入", create: "初始版本", "global-replace": "全局替换" }, value, "其他来源");
}

export function occurrenceRoleLabel(value) {
  return enumLabel({ setup: "埋设", reminder: "提醒", payoff: "回收" }, value, "其他节点");
}

export function searchResultTypeLabel(value) {
  return enumLabel({
    chapter: "正文章节",
    setting: "设定",
    character: "角色",
    race: "种族",
    organization: "组织",
    "timeline-track": "独立时间轴",
    "timeline-event": "时间线事件",
    relationship: "人物关系",
    "chapter-outline": "章节大纲",
    foreshadow: "伏笔",
    review: "审核项",
    "agent-history": "Agent 历史"
  }, value, "其他资料");
}

export function characterStateFieldLabel(value) {
  const normalized = String(value ?? "").trim();
  return enumLabel({
    location: "位置",
    condition: "状况"
  }, normalized, normalized || "未命名字段");
}

export function characterGenderLabel(value) {
  return enumLabel({ male: "男 / 雄", female: "女 / 雌", none: "无性别", unknown: "未知" }, value, "未知");
}
