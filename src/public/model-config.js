export const MODEL_PURPOSE_OPTIONS = Object.freeze([
  ["chat", "通用对话"],
  ["continue", "创作续写"],
  ["polish", "文本润色"],
  ["chapter-analysis", "章节理解"],
  ["book-analysis", "全书分析"],
  ["timeline-analysis", "时间轴抽取"],
  ["relationship-analysis", "人物关系分析"],
  ["consistency-check", "一致性校对"]
]);

const purposeAliases = new Map([
  ...MODEL_PURPOSE_OPTIONS.flatMap(([key, label]) => [[key, key], [label, key]]),
  ["章节分析", "chapter-analysis"],
  ["时间轴分析", "timeline-analysis"],
  ["关系分析", "relationship-analysis"]
]);

export function normalizeModelPurposes(purposes) {
  const values = Array.isArray(purposes) ? purposes : String(purposes ?? "").split(/[,，]/u);
  return [...new Set(values.map((value) => purposeAliases.get(String(value).trim())).filter(Boolean))];
}

export function modelFormValues(model = null) {
  return {
    displayName: model?.displayName ?? "",
    modelId: model?.modelId ?? "",
    purposes: model ? normalizeModelPurposes(model.purposes) : ["chat", "continue"],
    contextWindow: model?.contextWindow ?? 128000,
    temperature: model?.preset?.temperature ?? 0.7,
    maxTokens: model?.preset?.max_tokens ?? 32000,
    enabled: model?.enabled ?? true
  };
}

export function modelPayload(values, existingPreset = {}) {
  return {
    displayName: String(values.displayName),
    modelId: String(values.modelId),
    purposes: normalizeModelPurposes(values.purposes),
    contextWindow: Number(values.contextWindow),
    preset: {
      ...existingPreset,
      temperature: Number(values.temperature),
      max_tokens: Number(values.maxTokens)
    },
    enabled: Boolean(values.enabled)
  };
}

export function modelOptionLabel(model) {
  const providerName = String(model?.providerName ?? "").trim();
  const modelName = String(model?.displayName ?? model?.modelId ?? "").trim();
  return [providerName, modelName].filter(Boolean).join(" · ");
}
