export function shouldShowAiQuickActions(hasSentPrompt) {
  return !Boolean(hasSentPrompt);
}
