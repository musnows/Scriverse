import { levelLabel, relationshipCategoryLabel } from "./display-labels.js?v=20260725-enum-labels-zh";

export const VERSIONED_ENTITY_LABELS = Object.freeze({
  draft: "创作想法",
  setting: "世界观设定",
  race: "种族档案",
  organization: "组织档案",
  "timeline-track": "独立时间轴",
  "timeline-event": "时间事件",
  relationship: "人物关系",
  "chapter-outline": "章节大纲",
  foreshadow: "伏笔"
});

export function entityVersionSourceLabel(source) {
  return ({
    create: "初始版本",
    manual: "人工编辑",
    migration: "迁移基线",
    restore: "历史回滚",
    analysis: "AI 分析",
    merge: "事件合并",
    split: "事件拆分",
    "global-replace": "全局替换"
  })[source] ?? "其他来源";
}

export function entityVersionSnapshotSummary(type, snapshot = {}) {
  if (type === "draft") return `${snapshot.draftType === "setting" ? "设定想法" : "正文想法"} · ${snapshot.title || "未命名想法"}`;
  if (type === "setting") return `${snapshot.category || "未分类"} · ${snapshot.title || "未命名设定"}`;
  if (type === "race") return `${snapshot.name || "未命名种族"} · ${(snapshot.memberIds ?? []).length} 位角色`;
  if (type === "organization") return `${snapshot.name || "未命名组织"} · ${(snapshot.memberIds ?? []).length} 位成员`;
  if (type === "timeline-track") return `${snapshot.name || "未命名时间轴"} · 排序 ${snapshot.sortOrder ?? 0}`;
  if (type === "timeline-event") return `${snapshot.timeLabel || "时间待定"} · ${snapshot.name || "未命名事件"}`;
  if (type === "relationship") return `${relationshipCategoryLabel(snapshot.category)} / ${snapshot.subtype || "未细分"} · ${Math.round(Number(snapshot.confidence ?? 0) * 100)}%`;
  if (type === "chapter-outline") return `目标：${snapshot.goal || "未填写"}`;
  if (type === "foreshadow") return `${levelLabel(snapshot.importance || "medium")} · ${snapshot.title || "未命名伏笔"}`;
  return "历史快照";
}
