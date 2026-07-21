import { describe, expect, it } from "vitest";
import { aiErrorForLog } from "../../src/ai.js";
import { accountReference, createLogger, type LogRecord, sanitizeError } from "../../src/logger.js";
import { runWithRequestContext } from "../../src/request-context.js";

describe("结构化日志", () => {
  it("递归脱敏凭据、账户字段和错误消息中的令牌", () => {
    const records: LogRecord[] = [];
    const log = createLogger({
      level: "debug",
      now: () => new Date("2026-07-19T00:00:00.000Z"),
      write: (_level, record) => records.push(record)
    });
    const error = new Error("request failed with Bearer bearer-secret and sk-provider-secret");

    log.error("security.redaction.test", {
      username: "private-account",
      password: "private-password",
      csrfToken: "private-csrf",
      apiKey: "private-api-key",
      user_id: "private-user-id",
      nested: { access_token: "private-access-token" },
      message: "Authorization: Bearer bearer-secret; url=https://user:pass@example.com?token=query-secret",
      error: sanitizeError(error)
    });

    const serialized = JSON.stringify(records[0]);
    expect(records[0]).toMatchObject({ ts: "2026-07-19T00:00:00.000Z" });
    expect(records[0]).not.toHaveProperty("timestamp");
    for (const secret of ["private-account", "private-password", "private-csrf", "private-api-key", "private-user-id", "private-access-token", "bearer-secret", "provider-secret", "query-secret", "user:pass"]) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).toContain("[REDACTED]");
  });

  it("使用请求 ID 和不可逆账户引用关联同一请求内的日志", () => {
    const records: LogRecord[] = [];
    const log = createLogger({ level: "info", write: (_level, record) => records.push(record) });

    runWithRequestContext({
      requestId: "request-123",
      actor: {
        userId: "private-user-id",
        username: "private-username",
        displayName: "private-display-name",
        role: "user",
        authentication: "session"
      }
    }, () => log.info("domain.test"));

    expect(records[0]).toMatchObject({
      event: "domain.test",
      requestId: "request-123",
      actorRef: accountReference("private-user-id"),
      authentication: "session"
    });
    expect(JSON.stringify(records[0])).not.toContain("private-user-id");
    expect(JSON.stringify(records[0])).not.toContain("private-username");
    expect(JSON.stringify(records[0])).not.toContain("private-display-name");
  });

  it("不会把供应商错误响应正文写入日志字段", () => {
    const fields = aiErrorForLog(new Error("HTTP 401: account private-account-id is not allowed"));

    expect(fields).toEqual({ name: "Error", message: "Provider returned HTTP 401" });
    expect(JSON.stringify(fields)).not.toContain("private-account-id");
  });
});
