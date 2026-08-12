import { createHash, randomUUID } from "node:crypto";
import type { Database } from "./database.js";
import { AppError } from "./errors.js";

export const AI_CONNECTIVITY_TEST_SUCCESS_COOLDOWN_MS = 120_000;
export const AI_CONNECTIVITY_TEST_FAILURE_COOLDOWN_MS = 10_000;
export const AI_CONNECTIVITY_TEST_IN_PROGRESS_LEASE_MS = 65_000;

export type AiConnectivityTestObjectType = "provider" | "model";
export type AiConnectivityTestOutcome = "success" | "failure";
export type AiConnectivityTestCooldownReason = "in_progress" | "success_cooldown" | "failure_cooldown" | "configuration_changed";

export type AiConnectivityTestClaim = {
  objectType: AiConnectivityTestObjectType;
  objectId: string;
  configFingerprint: string;
  attemptId: string;
};

export type AiConnectivityTestCooldown = {
  reason: AiConnectivityTestCooldownReason;
  retryAfterSeconds: number;
  retryAt: string | null;
};

type AiConnectivityTestCompletionOptions = {
  isConfigurationCurrent?: () => boolean;
  onApplied?: (completedAt: string) => void;
};

type ConnectivityTestStateRow = {
  config_fingerprint: string;
  state: "in_progress" | "success" | "failure";
  retry_at_ms: number;
};

type AcquireResult<T> =
  | { claim: AiConnectivityTestClaim; blocked: null; configFingerprint: string; configuration: T }
  | { claim: null; blocked: AiConnectivityTestCooldown; configFingerprint: null; configuration: null };

export function hashAiConnectivityConfiguration(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function retryDetails(reason: AiConnectivityTestCooldownReason, retryAtMs: number, nowMs: number): AiConnectivityTestCooldown {
  return {
    reason,
    retryAfterSeconds: Math.max(1, Math.ceil((retryAtMs - nowMs) / 1_000)),
    retryAt: new Date(retryAtMs).toISOString()
  };
}

function blockedError(objectType: AiConnectivityTestObjectType, cooldown: AiConnectivityTestCooldown): AppError {
  const label = objectType === "provider" ? "供应商" : "模型";
  if (cooldown.reason === "in_progress") {
    return new AppError(429, "AI_CONNECTIVITY_TEST_IN_PROGRESS", `${label}连接测试正在进行，请稍后重试`, cooldown);
  }
  return new AppError(429, "AI_CONNECTIVITY_TEST_COOLDOWN", `${label}连接测试仍在冷却中，请稍后重试`, cooldown);
}

export class AiConnectivityTestGate {
  constructor(
    private readonly database: Database,
    private readonly currentTime: () => number = () => Date.now(),
    private readonly inProgressLeaseMs = AI_CONNECTIVITY_TEST_IN_PROGRESS_LEASE_MS
  ) {}

  acquire(objectType: AiConnectivityTestObjectType, objectId: string, configFingerprint: string): AiConnectivityTestClaim {
    return this.acquireWithConfiguration(objectType, objectId, () => ({ configFingerprint, configuration: undefined })).claim;
  }

  acquireWithConfiguration<T>(
    objectType: AiConnectivityTestObjectType,
    objectId: string,
    readConfiguration: () => { configFingerprint: string; configuration: T }
  ): { claim: AiConnectivityTestClaim; configFingerprint: string; configuration: T } {
    const nowMs = this.currentTime();
    const result = this.database.transaction<AcquireResult<T>>(() => {
      const { configFingerprint, configuration } = readConfiguration();
      const current = this.database.get<ConnectivityTestStateRow>(
        `SELECT config_fingerprint, state, retry_at_ms
         FROM ai_connectivity_test_states WHERE object_type = ? AND object_id = ?`,
        objectType,
        objectId
      );
      if (current && current.config_fingerprint === configFingerprint && Number(current.retry_at_ms) > nowMs) {
        const reason = current.state === "in_progress"
          ? "in_progress"
          : current.state === "success" ? "success_cooldown" : "failure_cooldown";
        return {
          claim: null,
          blocked: retryDetails(reason, Number(current.retry_at_ms), nowMs),
          configFingerprint: null,
          configuration: null
        };
      }

      const attemptId = randomUUID();
      this.database.run(
        `INSERT INTO ai_connectivity_test_states
           (object_type, object_id, config_fingerprint, state, attempt_id, retry_at_ms, updated_at)
         VALUES (?, ?, ?, 'in_progress', ?, ?, ?)
         ON CONFLICT(object_type, object_id) DO UPDATE SET
           config_fingerprint = excluded.config_fingerprint,
           state = excluded.state,
           attempt_id = excluded.attempt_id,
           retry_at_ms = excluded.retry_at_ms,
           updated_at = excluded.updated_at`,
        objectType,
        objectId,
        configFingerprint,
        attemptId,
        nowMs + this.inProgressLeaseMs,
        new Date(nowMs).toISOString()
      );
      return {
        claim: { objectType, objectId, configFingerprint, attemptId },
        blocked: null,
        configFingerprint,
        configuration
      };
    });
    if (result.blocked) throw blockedError(objectType, result.blocked);
    return {
      claim: result.claim,
      configFingerprint: result.configFingerprint,
      configuration: result.configuration
    };
  }

  complete(
    claim: AiConnectivityTestClaim,
    outcome: AiConnectivityTestOutcome,
    options: AiConnectivityTestCompletionOptions = {}
  ): AiConnectivityTestCooldown {
    const nowMs = this.currentTime();
    const cooldownMs = outcome === "success"
      ? AI_CONNECTIVITY_TEST_SUCCESS_COOLDOWN_MS
      : AI_CONNECTIVITY_TEST_FAILURE_COOLDOWN_MS;
    const retryAtMs = nowMs + cooldownMs;
    const completedAt = new Date(nowMs).toISOString();
    const applied = this.database.transaction(() => {
      if (options.isConfigurationCurrent && !options.isConfigurationCurrent()) {
        this.database.run(
          `DELETE FROM ai_connectivity_test_states
           WHERE object_type = ? AND object_id = ? AND config_fingerprint = ? AND attempt_id = ?`,
          claim.objectType,
          claim.objectId,
          claim.configFingerprint,
          claim.attemptId
        );
        return false;
      }
      const update = this.database.run(
        `UPDATE ai_connectivity_test_states
         SET state = ?, retry_at_ms = ?, updated_at = ?
         WHERE object_type = ? AND object_id = ? AND config_fingerprint = ?
           AND attempt_id = ? AND state = 'in_progress'`,
        outcome,
        retryAtMs,
        completedAt,
        claim.objectType,
        claim.objectId,
        claim.configFingerprint,
        claim.attemptId
      );
      if (update.changes !== 1) return false;
      options.onApplied?.(completedAt);
      return true;
    });
    if (!applied) {
      return { reason: "configuration_changed", retryAfterSeconds: 0, retryAt: null };
    }
    return {
      reason: outcome === "success" ? "success_cooldown" : "failure_cooldown",
      retryAfterSeconds: cooldownMs / 1_000,
      retryAt: new Date(retryAtMs).toISOString()
    };
  }
}
