export function formatAiContextUsageTooltip(usage) {
  if (!usage) return "选择可用模型后显示当前上下文用量";
  const inputTokens = Math.max(0, Math.round(Number(usage.inputTokens) || 0)).toLocaleString("zh-CN");
  const contextWindow = Math.max(0, Math.round(Number(usage.contextWindow) || 0)).toLocaleString("zh-CN");
  const contextTokens = Math.max(0, Math.round(Number(usage.contextTokens) || 0)).toLocaleString("zh-CN");
  const conversationTokens = Math.max(0, Math.round(Number(usage.conversationTokens) || 0)).toLocaleString("zh-CN");
  const conversationBudget = Math.max(0, Math.round(Number(usage.conversationBudgetTokens) || 0)).toLocaleString("zh-CN");
  const outputReserve = Math.max(0, Math.round(Number(usage.outputReserveTokens) || 0)).toLocaleString("zh-CN");
  return `总输入 ${inputTokens} / ${contextWindow} tok · 作品上下文 ${contextTokens} tok · 对话历史 ${conversationTokens} / ${conversationBudget} tok · 输出预留 ${outputReserve} tok`;
}
