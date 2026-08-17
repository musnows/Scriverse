export const AI_RETRY_COUNT_ENV = "SCRIVERSE_AI_RETRY_COUNT";
export const AI_BACKOFF_RETRY_COUNT_ENV = "SCRIVERSE_AI_BACKOFF_RETRY_COUNT";
export const DEFAULT_AI_RETRY_COUNT = 3;
export const DEFAULT_AI_BACKOFF_RETRY_COUNT = 10;
export const MIN_AI_RETRY_COUNT = 1;
export const MAX_AI_RETRY_COUNT = 20;
export const AI_RETRY_BASE_DELAY_MS = 500;
export const AI_RETRY_MAX_DELAY_MS = 5_000;

export type AiRetryPolicy = {
  retryCount: number;
  backoffRetryCount: number;
};

function resolveRetryCount(value: string | undefined, fallback: number): number {
  const raw = value?.trim() ?? "";
  if (!/^\d+$/u.test(raw)) return fallback;
  const configured = Number(raw);
  if (!Number.isSafeInteger(configured)) return fallback;
  return Math.min(MAX_AI_RETRY_COUNT, Math.max(MIN_AI_RETRY_COUNT, configured));
}

export function resolveAiRetryPolicy(environment: NodeJS.ProcessEnv = process.env): AiRetryPolicy {
  return {
    retryCount: resolveRetryCount(environment[AI_RETRY_COUNT_ENV], DEFAULT_AI_RETRY_COUNT),
    backoffRetryCount: resolveRetryCount(environment[AI_BACKOFF_RETRY_COUNT_ENV], DEFAULT_AI_BACKOFF_RETRY_COUNT)
  };
}

export function normalizeAiRetryPolicy(policy: Partial<AiRetryPolicy> | undefined): AiRetryPolicy {
  const normalize = (value: number | undefined, fallback: number): number => Number.isSafeInteger(value)
    ? Math.min(MAX_AI_RETRY_COUNT, Math.max(MIN_AI_RETRY_COUNT, Number(value)))
    : fallback;
  return {
    retryCount: normalize(policy?.retryCount, DEFAULT_AI_RETRY_COUNT),
    backoffRetryCount: normalize(policy?.backoffRetryCount, DEFAULT_AI_BACKOFF_RETRY_COUNT)
  };
}

export function aiHttpRetryCount(status: number, policy: AiRetryPolicy): number {
  if (status === 403) return 0;
  if (status === 429 || status === 502) return policy.backoffRetryCount;
  return policy.retryCount;
}

export function aiHttpRetryDelayMs(status: number, retryNumber: number, retryAfter: string | null = null): number {
  if (status === 429 || status === 502) {
    const retryAfterSeconds = retryAfter && /^\d+(?:\.\d+)?$/u.test(retryAfter.trim())
      ? Number(retryAfter.trim())
      : 0;
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      return Math.min(AI_RETRY_MAX_DELAY_MS, Math.max(AI_RETRY_BASE_DELAY_MS, Math.ceil(retryAfterSeconds * 1_000)));
    }
    return Math.min(AI_RETRY_MAX_DELAY_MS, AI_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, retryNumber - 1)));
  }
  return Math.min(AI_RETRY_MAX_DELAY_MS, AI_RETRY_BASE_DELAY_MS * Math.max(1, retryNumber));
}
