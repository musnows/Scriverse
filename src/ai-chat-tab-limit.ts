export const AI_CHAT_TAB_LIMIT_ENV = "APP_AI_CHAT_TAB_LIMIT";
export const DEFAULT_AI_CHAT_TAB_LIMIT = 5;
export const MIN_AI_CHAT_TAB_LIMIT = 1;
export const MAX_AI_CHAT_TAB_LIMIT = 20;

export function resolveAiChatTabLimit(environment: NodeJS.ProcessEnv): number {
  const raw = environment[AI_CHAT_TAB_LIMIT_ENV]?.trim() ?? "";
  if (!/^\d+$/u.test(raw)) return DEFAULT_AI_CHAT_TAB_LIMIT;
  const configured = Number(raw);
  if (!Number.isSafeInteger(configured)) return DEFAULT_AI_CHAT_TAB_LIMIT;
  return Math.min(MAX_AI_CHAT_TAB_LIMIT, Math.max(MIN_AI_CHAT_TAB_LIMIT, configured));
}
