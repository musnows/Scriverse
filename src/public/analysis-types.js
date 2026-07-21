export const ANALYSIS_TYPES = Object.freeze([
  Object.freeze({
    value: "chapter-analysis",
    label: "章节理解",
    desc: "分析所选章节，生成情节概要，并提取事件、出场角色、设定、原文证据和不确定项。"
  }),
  Object.freeze({
    value: "character-extraction",
    label: "全书角色抽取",
    desc: "扫描分析范围内的正文，识别有跨章节意义的角色及可靠别名，并创建或更新角色档案。"
  }),
  Object.freeze({
    value: "character-identity-audit",
    label: "AI 角色查重",
    desc: "对照全书正文与现有角色档案，找出可能属于同一角色的重复档案；只生成审核建议，不会自动合并。"
  }),
  Object.freeze({
    value: "timeline-analysis",
    label: "时间轴与事件抽取",
    desc: "从正文提取事件、发生时间、地点和参与者，区分发生时间与叙述时间，并保存为待确认候选。"
  }),
  Object.freeze({
    value: "relationship-analysis",
    label: "全书人物关系分析",
    desc: "根据原文证据识别角色之间具有长期意义的关系及变化，生成可供确认的人物关系候选。"
  }),
  Object.freeze({
    value: "worldview-analysis",
    label: "世界观分析",
    desc: "归纳正文中的自然、社会、历史、科技、文化等世界观维度，同时标出冲突和证据不足之处。"
  }),
  Object.freeze({
    value: "setting-extraction",
    label: "设定抽取",
    desc: "提取会影响后续创作的地点、物品、能力、制度、规则等设定，附带原文证据并等待作者确认。"
  }),
  Object.freeze({
    value: "consistency-check",
    label: "一致性校对",
    desc: "检查人物状态、关系、时间与作品设定是否相互冲突，并按严重程度给出证据和修改建议。"
  }),
  Object.freeze({
    value: "book-analysis",
    label: "全书综合分析",
    desc: "基于所选范围生成开放式综合分析，适合查看作品整体表现、主要问题和可改进方向。"
  })
]);

const analysisTypeDescriptions = new Map(ANALYSIS_TYPES.map(({ value, desc }) => [value, desc]));

export function analysisTypeDescription(value) {
  return analysisTypeDescriptions.get(String(value)) ?? "请选择一种分析类型以查看用途说明。";
}
