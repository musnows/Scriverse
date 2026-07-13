export function formatAiContextUsageTooltip(usage) {
  if (!usage) return "选择可用模型后显示当前上下文用量";
  const inputTokens = Math.max(0, Math.round(Number(usage.inputTokens) || 0)).toLocaleString("zh-CN");
  const contextWindow = Math.max(0, Math.round(Number(usage.contextWindow) || 0)).toLocaleString("zh-CN");
  return `${inputTokens} tok / ${contextWindow} tok`;
}
