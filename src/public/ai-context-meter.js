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

function tokenCount(value) {
  return Math.max(0, Math.round(Number(value) || 0));
}

export function normalizeAiContextTokenDistribution(usage) {
  const contextWindow = tokenCount(usage?.contextWindow);
  const distribution = usage?.tokenDistribution ?? {};
  const systemPromptTokens = tokenCount(distribution.systemPromptTokens);
  const functionTokens = tokenCount(distribution.functionTokens);
  const skillsTokens = tokenCount(distribution.skillsTokens);
  const contextTokens = Object.keys(distribution).length > 0
    ? tokenCount(distribution.contextTokens)
    : tokenCount(usage?.inputTokens);
  const occupiedTokens = systemPromptTokens + functionTokens + skillsTokens + contextTokens;
  const leftTokens = Math.max(0, contextWindow - occupiedTokens);
  const items = [
    { key: "system-prompt", label: "system prompt", tokens: systemPromptTokens },
    { key: "function", label: "function", tokens: functionTokens },
    { key: "skills", label: "skills", tokens: skillsTokens },
    { key: "context", label: "context", tokens: contextTokens },
    { key: "left", label: "left", tokens: leftTokens }
  ];
  return {
    contextWindow,
    occupiedTokens,
    items: items.map((item) => ({
      ...item,
      percent: contextWindow > 0 ? Math.round(item.tokens / contextWindow * 1_000) / 10 : 0
    }))
  };
}
