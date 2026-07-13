const fieldLabels = Object.freeze({
  name: "标准名",
  aliases: "别名",
  species: "种族",
  organizationIds: "所属组织",
  attributes: "身份与扩展属性",
  profile: "人物档案与设定章节",
  currentState: "当前状态",
  lockedFields: "锁定字段",
  visibility: "可见范围",
  firstChapterId: "首次登场章节"
});

export function describeCharacterVersionChanges(snapshot, previousSnapshot) {
  if (!previousSnapshot) return ["建立人物档案"];
  return Object.entries(fieldLabels).filter(([key]) => (
    JSON.stringify(snapshot?.[key] ?? null) !== JSON.stringify(previousSnapshot?.[key] ?? null)
  )).map(([, label]) => label);
}

export function characterVersionSourceLabel(source) {
  return ({
    create: "创建",
    manual: "手动保存",
    restore: "历史回滚",
    organization: "组织变更",
    migration: "历史基线"
  })[String(source)] ?? String(source || "未知来源");
}
