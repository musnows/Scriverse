import { describe, expect, it } from "vitest";
import {
  buildBackupTimestamp,
  buildScriverseRoot,
  credentialHint,
  normalizeS3Prefix,
  parseScheduleTime,
  redactS3TargetForLog
} from "../../src/s3-backup-service.js";

describe("s3 backup helpers", () => {
  it("normalizes prefix segments", () => {
    expect(normalizeS3Prefix("/backups/")).toBe("backups");
    expect(normalizeS3Prefix("")).toBe("");
  });

  it("builds scriverse root under optional prefix", () => {
    expect(buildScriverseRoot("")).toBe("scriverse");
    expect(buildScriverseRoot("backups")).toBe("backups/scriverse");
    expect(buildScriverseRoot("/prod/")).toBe("prod/scriverse");
  });

  it("parses schedule time", () => {
    expect(parseScheduleTime("02:30")).toEqual({ hour: 2, minute: 30 });
    expect(parseScheduleTime("24:00")).toBeNull();
    expect(parseScheduleTime("aa:bb")).toBeNull();
  });

  it("builds stable backup timestamp", () => {
    const timestamp = buildBackupTimestamp(new Date("2026-08-03T21:30:45.123Z"));
    expect(timestamp).toMatch(/^2026\d{4}-\d{6}-\d{3}$/u);
  });

  it("redacts credentials in logs", () => {
    const redacted = redactS3TargetForLog({
      id: "s3target_1",
      name: "Primary",
      enabled: true,
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      bucket: "bucket",
      prefix: "backups",
      accessKeyHint: "****1234",
      secretKeyHint: "****abcd",
      hasAccessKey: true,
      hasSecretKey: true,
      sortOrder: 0
    });
    expect(redacted).not.toHaveProperty("accessKey");
    expect(redacted).not.toHaveProperty("secretKey");
    expect(redacted.accessKeyHint).toBe("****1234");
  });

  it("masks credential hints", () => {
    expect(credentialHint("abc")).toBe("****");
    expect(credentialHint("abcdefghij")).toBe("****ghij");
  });
});
