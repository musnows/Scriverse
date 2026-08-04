import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime } from "../helpers.js";

function adminSession(runtime: Runtime): string {
  return Buffer.from(JSON.stringify({ userId: "admin", role: "admin" })).toString("base64");
}

describe("系统级备份设置 API", () => {
  let runtime: Runtime | null = null;

  beforeEach(() => {
    runtime = createTestRuntime();
  });

  afterEach(() => {
    runtime?.close();
    runtime = null;
  });

  it("保存备份目标后再次读取保留 hasSecretAccessKey，密钥不回显", async () => {
    const session = adminSession(runtime!);
    const put = await request(runtime!.app)
      .put("/api/platform/backup-settings")
      .set("x-test-user", `user:${session}`)
      .set("x-test-auth-method", "session")
      .send({
        targets: [{
          displayName: "生产备份",
          endpoint: "https://s3.example.com",
          bucket: "scriverse-prod",
          region: "us-east-1",
          prefix: "prod",
          accessKeyId: "AKIAEXAMPLE",
          secretAccessKey: "shhh-very-secret",
          pathStyle: true,
          backupImages: true,
          scheduleHour: 4,
          scheduleMinute: 30,
          retentionCount: 5,
          enabled: true
        }]
      });
    expect(put.status).toBe(200);
    expect(put.body.data.targets[0]).toMatchObject({
      hasSecretAccessKey: true,
      secretKeyHint: expect.stringMatching(/\*/),
      endpoint: "https://s3.example.com"
    });
    expect(JSON.stringify(put.body.data.targets[0])).not.toContain("shhh-very-secret");

    const stored = runtime!.database.get<{ access_key_id: string; secret_key_hint: string }>("SELECT * FROM platform_backup_targets LIMIT 1");
    expect(stored?.access_key_id).toBe("AKIAEXAMPLE");
    expect(stored?.secret_key_hint).not.toBe("shhh-very-secret");
  });

  it("更新现有目标并清理已删除目标", async () => {
    const session = adminSession(runtime!);
    const headers = { "x-test-user": `user:${session}`, "x-test-auth-method": "session" };
    await request(runtime!.app).put("/api/platform/backup-settings").set(headers).send({
      targets: [
        { displayName: "A", endpoint: "https://s3.example.com", bucket: "b1", region: "us-east-1", accessKeyId: "AK", secretAccessKey: "secret-1", pathStyle: true, backupImages: true, scheduleHour: 0, scheduleMinute: 0, retentionCount: 1, enabled: true },
        { displayName: "B", endpoint: "https://s3.example.com", bucket: "b2", region: "us-east-1", accessKeyId: "AK", secretAccessKey: "secret-2", pathStyle: true, backupImages: false, scheduleHour: 0, scheduleMinute: 0, retentionCount: 1, enabled: true }
      ]
    }).expect(200);

    const keptId = runtime!.database.get<{ id: string }>("SELECT id FROM platform_backup_targets WHERE bucket = 'b1'")?.id;
    expect(keptId).toBeTruthy();

    const second = await request(runtime!.app).put("/api/platform/backup-settings").set(headers).send({
      targets: [
        { id: keptId, displayName: "A2", endpoint: "https://s3.example.com", bucket: "b1", region: "us-east-1", accessKeyId: "AK", secretAccessKey: null, pathStyle: true, backupImages: true, scheduleHour: 1, scheduleMinute: 0, retentionCount: 2, enabled: true }
      ]
    }).expect(200);
    expect(second.body.data.targets.length).toBe(1);
    expect(second.body.data.targets[0].hasSecretAccessKey).toBe(true);
    expect(second.body.data.targets[0].backupImages).toBe(true);
    expect(second.body.data.targets[0].retentionCount).toBe(2);
    expect(second.body.data.targets[0].scheduleHour).toBe(1);
    const remaining = runtime!.database.all<{ bucket: string }>("SELECT bucket FROM platform_backup_targets");
    expect(remaining.map((row) => row.bucket)).toEqual(["b1"]);
  });

  it("记录手动备份结果并能通过 /runs 查询", async () => {
    const session = adminSession(runtime!);
    const headers = { "x-test-user": `user:${session}`, "x-test-auth-method": "session" };
    await request(runtime!.app).put("/api/platform/backup-settings").set(headers).send({
      targets: [{
        displayName: "Run Test",
        endpoint: "https://s3.example.com",
        bucket: "b",
        region: "us-east-1",
        prefix: "",
        accessKeyId: "AK",
        secretAccessKey: "shhh",
        pathStyle: true,
        backupImages: false,
        scheduleHour: 3,
        scheduleMinute: 0,
        retentionCount: 1,
        enabled: true
      }]
    }).expect(200);

    const list = await request(runtime!.app).get("/api/platform/backup/runs?limit=10").set(headers);
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.data.runs)).toBe(true);

    const targetId = runtime!.database.get<{ id: string }>("SELECT id FROM platform_backup_targets LIMIT 1")?.id;
    expect(targetId).toBeTruthy();

    const store = runtime!.store;
    const row = store.recordPlatformBackupRun({
      targetId: targetId!,
      triggeredBy: "manual",
      status: "failed",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      uploadedImageCount: 0,
      skippedImageCount: 0,
      deletedDbBackupCount: 0,
      uploadedDbKey: null,
      uploadedDbSize: null,
      errorMessage: "boom"
    });
    expect(row.status).toBe("failed");

    const failed = await request(runtime!.app).get("/api/platform/backup/runs?limit=10").set(headers);
    const failedRow = (failed.body.data.runs as Array<{ status: string; errorMessage: string | null }>).find((entry) => entry.status === "failed");
    expect(failedRow?.errorMessage).toBe("boom");
  });

  it("超过 32 个目标被拒绝", async () => {
    const session = adminSession(runtime!);
    const targets = Array.from({ length: 33 }, (_, index) => ({
      displayName: `target-${index}`,
      endpoint: "https://s3.example.com",
      bucket: `b${index}`,
      region: "us-east-1",
      accessKeyId: "AK",
      secretAccessKey: "shhh",
      pathStyle: true,
      backupImages: false,
      scheduleHour: 0,
      scheduleMinute: 0,
      retentionCount: 1,
      enabled: true
    }));
    const result = await request(runtime!.app)
      .put("/api/platform/backup-settings")
      .set("x-test-user", `user:${session}`)
      .set("x-test-auth-method", "session")
      .send({ targets });
    expect(result.status).toBeGreaterThanOrEqual(400);
  });

  it("缺少 secretAccessKey 的新建目标被拒绝", async () => {
    const session = adminSession(runtime!);
    const result = await request(runtime!.app)
      .put("/api/platform/backup-settings")
      .set("x-test-user", `user:${session}`)
      .set("x-test-auth-method", "session")
      .send({
        targets: [{
          displayName: "新目标",
          endpoint: "https://s3.example.com",
          bucket: "b",
          region: "us-east-1",
          accessKeyId: "AK",
          secretAccessKey: null,
          pathStyle: true,
          backupImages: false,
          scheduleHour: 0,
          scheduleMinute: 0,
          retentionCount: 1,
          enabled: true
        }]
      });
    expect(result.status).toBeGreaterThanOrEqual(400);
  });
});
