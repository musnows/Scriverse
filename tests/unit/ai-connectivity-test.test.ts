import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AI_CONNECTIVITY_TEST_FAILURE_COOLDOWN_MS,
  AI_CONNECTIVITY_TEST_SUCCESS_COOLDOWN_MS,
  AiConnectivityTestGate,
  hashAiConnectivityConfiguration
} from "../../src/ai-connectivity-test.js";
import { Database } from "../../src/database.js";
import { AppError } from "../../src/errors.js";

const databases: Database[] = [];
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const database of databases.splice(0).reverse()) database.close();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function expectBlocked(operation: () => unknown, reason: string, retryAfterSeconds: number): AppError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ status: 429 });
    expect((error as AppError).details).toMatchObject({ reason, retryAfterSeconds });
    return error as AppError;
  }
  throw new Error("预期连接测试请求被服务端冷却门槛拒绝");
}

describe("AI 连通性测试冷却门槛", () => {
  it("按服务端时间执行成功与失败边界，并在配置指纹变化后立即放行", () => {
    const database = new Database(":memory:");
    databases.push(database);
    let currentTime = Date.parse("2026-08-12T12:00:00.000Z");
    const gate = new AiConnectivityTestGate(database, () => currentTime);
    const firstFingerprint = hashAiConnectivityConfiguration(["provider", "base-url-a", "encrypted-secret-a"]);
    expect(firstFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(firstFingerprint).not.toContain("encrypted-secret-a");

    const firstClaim = gate.acquire("provider", "provider-1", firstFingerprint);
    expectBlocked(() => gate.acquire("provider", "provider-1", firstFingerprint), "in_progress", 65);
    const success = gate.complete(firstClaim, "success");
    expect(success).toMatchObject({ reason: "success_cooldown", retryAfterSeconds: 120 });

    currentTime += AI_CONNECTIVITY_TEST_SUCCESS_COOLDOWN_MS - 1;
    expectBlocked(() => gate.acquire("provider", "provider-1", firstFingerprint), "success_cooldown", 1);
    currentTime += 1;
    const boundaryClaim = gate.acquire("provider", "provider-1", firstFingerprint);
    const failure = gate.complete(boundaryClaim, "failure");
    expect(failure).toMatchObject({ reason: "failure_cooldown", retryAfterSeconds: 10 });

    currentTime += AI_CONNECTIVITY_TEST_FAILURE_COOLDOWN_MS - 1;
    expectBlocked(() => gate.acquire("provider", "provider-1", firstFingerprint), "failure_cooldown", 1);

    const secondFingerprint = hashAiConnectivityConfiguration(["provider", "base-url-b", "encrypted-secret-b"]);
    const changedConfigurationClaim = gate.acquire("provider", "provider-1", secondFingerprint);
    expect(changedConfigurationClaim.configFingerprint).toBe(secondFingerprint);
    const staleCompletion = gate.complete(boundaryClaim, "success");
    expect(staleCompletion).toEqual({ reason: "configuration_changed", retryAfterSeconds: 0, retryAt: null });
    expect(database.get("SELECT attempt_id FROM ai_connectivity_test_states WHERE object_id = ?", "provider-1"))
      .toEqual({ attempt_id: changedConfigurationClaim.attemptId });
  });

  it("在共享 SQLite 的两个服务实例间原子阻止重复调用", () => {
    const root = mkdtempSync(join(tmpdir(), "scriverse-connectivity-gate-"));
    temporaryRoots.push(root);
    const filename = join(root, "novel.db");
    const firstDatabase = new Database(filename);
    const secondDatabase = new Database(filename);
    databases.push(firstDatabase, secondDatabase);
    const now = Date.parse("2026-08-12T12:00:00.000Z");
    const firstGate = new AiConnectivityTestGate(firstDatabase, () => now);
    const secondGate = new AiConnectivityTestGate(secondDatabase, () => now);
    const fingerprint = hashAiConnectivityConfiguration(["model", "shared-config"]);

    const claim = firstGate.acquire("model", "model-shared", fingerprint);
    const blocked = expectBlocked(() => secondGate.acquire("model", "model-shared", fingerprint), "in_progress", 65);
    expect(blocked.code).toBe("AI_CONNECTIVITY_TEST_IN_PROGRESS");
    firstGate.complete(claim, "success");
    const row = secondDatabase.get("SELECT state, retry_at_ms FROM ai_connectivity_test_states WHERE object_id = ?", "model-shared");
    expect(row).toMatchObject({ state: "success", retry_at_ms: now + AI_CONNECTIVITY_TEST_SUCCESS_COOLDOWN_MS });
  });
});
