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

export function isKimiModelId(modelId) {
  return String(modelId ?? "").toLowerCase().includes("kimi");
}

export function modelFormValues(model = null) {
  const modelId = String(model?.modelId ?? "");
  const configuredTemperature = model?.preset?.temperature;
  return {
    displayName: model?.displayName ?? "",
    modelId,
    purposes: model ? normalizeModelPurposes(model.purposes) : ["chat", "continue"],
    contextWindow: model?.contextWindow ?? 128000,
    temperature: isKimiModelId(modelId) && !(typeof configuredTemperature === "number" && Number.isFinite(configuredTemperature))
      ? 1
      : (configuredTemperature ?? 0.7),
    maxTokens: model?.preset?.max_tokens ?? 32000,
    thinkingEnabled: model?.thinkingEnabled ?? true,
    enabled: model?.enabled ?? true
  };
}

export function modelPayload(values, existingPreset = {}) {
  const modelId = String(values.modelId);
  return {
    displayName: String(values.displayName),
    modelId,
    purposes: normalizeModelPurposes(values.purposes),
    contextWindow: Number(values.contextWindow),
    preset: {
      ...existingPreset,
      temperature: Number(values.temperature),
      max_tokens: Number(values.maxTokens)
    },
    thinkingEnabled: Boolean(values.thinkingEnabled),
    enabled: Boolean(values.enabled)
  };
}

export function modelOptionLabel(model) {
  const providerName = String(model?.providerName ?? "").trim();
  const modelName = String(model?.displayName ?? model?.modelId ?? "").trim();
  return [providerName, modelName].filter(Boolean).join(" · ");
}
