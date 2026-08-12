export const AI_STREAM_IDLE_TIMEOUT_SECONDS_ENV = "SCRIVERSE_AI_STREAM_IDLE_TIMEOUT_SECONDS";
export const DEFAULT_AI_STREAM_IDLE_TIMEOUT_SECONDS = 30;
export const MIN_AI_STREAM_IDLE_TIMEOUT_SECONDS = 10;
export const MAX_AI_STREAM_IDLE_TIMEOUT_SECONDS = 120;
export const DEFAULT_AI_STREAM_IDLE_TIMEOUT_MS = DEFAULT_AI_STREAM_IDLE_TIMEOUT_SECONDS * 1_000;

export function resolveAiStreamIdleTimeoutSeconds(environment: NodeJS.ProcessEnv = process.env): number {
  const raw = environment[AI_STREAM_IDLE_TIMEOUT_SECONDS_ENV]?.trim() ?? "";
  if (!/^\d+$/u.test(raw)) return DEFAULT_AI_STREAM_IDLE_TIMEOUT_SECONDS;
  const configured = Number(raw);
  if (!Number.isSafeInteger(configured)) return DEFAULT_AI_STREAM_IDLE_TIMEOUT_SECONDS;
  return Math.min(
    MAX_AI_STREAM_IDLE_TIMEOUT_SECONDS,
    Math.max(MIN_AI_STREAM_IDLE_TIMEOUT_SECONDS, configured)
  );
}

export function resolveAiStreamIdleTimeoutMs(environment: NodeJS.ProcessEnv = process.env): number {
  return resolveAiStreamIdleTimeoutSeconds(environment) * 1_000;
}
