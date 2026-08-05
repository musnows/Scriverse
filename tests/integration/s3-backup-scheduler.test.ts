import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";
import type { S3BackupConnection, S3ListedObject, S3ObjectClient } from "../../src/s3-backup.js";

class SchedulerS3Client implements S3ObjectClient {
  constructor(
    private readonly endpoint: string,
    private readonly events: string[],
    private readonly concurrency: { active: number; maximum: number }
  ) {}

  async objectExists(): Promise<boolean> {
    return false;
  }

  async putObject(input: { key: string }): Promise<void> {
    this.concurrency.active += 1;
    this.concurrency.maximum = Math.max(this.concurrency.maximum, this.concurrency.active);
    this.events.push(`${this.endpoint}:${input.key}`);
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.concurrency.active -= 1;
  }

  async listObjects(): Promise<S3ListedObject[]> {
    return [];
  }

  async deleteObjects(): Promise<void> {}

  close(): void {}
}

describe("S3 备份调度与运行事件 API", () => {
  const runtimes: Runtime[] = [];

  afterEach(() => {
    for (const runtime of runtimes.splice(0)) runtime.close();
  });

  it("按服务器本地时间补跑当天任务、避免重复并保持目标串行", async () => {
    let clock = new Date(2026, 7, 4, 2, 30, 0, 0);
    const events: string[] = [];
    const concurrency = { active: 0, maximum: 0 };
    const runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "s3-scheduler-test-master-secret-with-enough-length",
      disableUserAuth: true,
      serveUi: false,
      backupOptions: {
        now: () => new Date(clock),
        snapshotDatabase: () => Buffer.from("database"),
        clientFactory: (connection: S3BackupConnection) => new SchedulerS3Client(connection.endpoint, events, concurrency)
      }
    });
    runtimes.push(runtime);
    const first = runtime.backups.createTarget({
      name: "凌晨目标",
      endpoint: "https://first.example.com",
      bucket: "backup",
      accessKeyId: "access-first",
      secretAccessKey: "secret-first",
      enabled: true,
      backupImages: false,
      scheduleTime: "03:00"
    });
    const second = runtime.backups.createTarget({
      name: "清晨目标",
      endpoint: "https://second.example.com",
      bucket: "backup",
      accessKeyId: "access-second",
      secretAccessKey: "secret-second",
      enabled: true,
      backupImages: false,
      scheduleTime: "04:00"
    });
    const disabled = runtime.backups.createTarget({
      name: "停用目标",
      endpoint: "https://disabled.example.com",
      bucket: "backup",
      accessKeyId: "access-disabled",
      secretAccessKey: "secret-disabled",
      enabled: false,
      backupImages: false,
      scheduleTime: "02:00"
    });
    expect(() => runtime.backups.enqueueTargets([disabled.id], "manual")).toThrow("停用的 S3 备份目标不能手动执行");

    clock = new Date(2026, 7, 4, 3, 30, 0, 0);
    expect(runtime.backups.enqueueDueTargets(clock)).toEqual({ acceptedTargetIds: [first.id], skippedTargetIds: [] });
    expect(runtime.backups.enqueueDueTargets(clock)).toEqual({ acceptedTargetIds: [], skippedTargetIds: [first.id] });
    await runtime.backups.waitForIdle();
    expect(runtime.backups.enqueueDueTargets(clock)).toEqual({ acceptedTargetIds: [], skippedTargetIds: [] });

    clock = new Date(2026, 7, 4, 4, 30, 0, 0);
    expect(runtime.backups.enqueueDueTargets(clock)).toEqual({ acceptedTargetIds: [second.id], skippedTargetIds: [] });
    await runtime.backups.waitForIdle();

    clock = new Date(2026, 7, 5, 2, 59, 0, 0);
    expect(runtime.backups.enqueueDueTargets(clock)).toEqual({ acceptedTargetIds: [], skippedTargetIds: [] });
    clock = new Date(2026, 7, 5, 5, 0, 0, 0);
    expect(runtime.backups.enqueueDueTargets(clock)).toEqual({ acceptedTargetIds: [first.id, second.id], skippedTargetIds: [] });
    await runtime.backups.waitForIdle();

    expect(concurrency.maximum).toBe(1);
    expect(events.map((event) => event.split(":scriverse", 1)[0])).toEqual([
      "https://first.example.com",
      "https://first.example.com",
      "https://second.example.com",
      "https://second.example.com",
      "https://first.example.com",
      "https://first.example.com",
      "https://second.example.com",
      "https://second.example.com"
    ]);
    expect(runtime.backups.listRuns().items.map((run) => run.status)).toEqual(["succeeded", "succeeded", "succeeded", "succeeded"]);
  });

  it("手动触发立即返回队列回执，并通过单调序号增量读取结果", async () => {
    const runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "s3-run-api-test-master-secret-with-enough-length",
      disableUserAuth: true,
      serveUi: false,
      backupOptions: {
        snapshotDatabase: () => Buffer.from("database"),
        clientFactory: (connection: S3BackupConnection) => new SchedulerS3Client(connection.endpoint, [], { active: 0, maximum: 0 })
      }
    });
    runtimes.push(runtime);
    const target = runtime.backups.createTarget({
      name: "手动目标",
      endpoint: "https://manual.example.com",
      bucket: "backup",
      accessKeyId: "access-manual",
      secretAccessKey: "secret-manual",
      enabled: true,
      backupImages: false
    });

    const queued = await request(runtime.app).post("/api/platform/backups/run").send({ targetIds: [target.id] }).expect(202);
    expect(queued.body.data).toMatchObject({ acceptedTargetIds: [target.id], skippedTargetIds: [] });
    await request(runtime.app).post("/api/platform/backups/run").send({ targetIds: [target.id, target.id] }).expect(400);
    await request(runtime.app).post("/api/platform/backups/run").send({ targetIds: ["missing-target"] }).expect(404);
    await runtime.backups.waitForIdle();

    const latest = await request(runtime.app).get("/api/platform/backups/runs?limit=1").expect(200);
    expect(latest.body.data.items).toHaveLength(1);
    expect(latest.body.data.items[0]).toMatchObject({ targetId: target.id, trigger: "manual", status: "succeeded", sequence: 1 });
    expect(latest.body.data.latestSequence).toBe(1);
    const incremental = await request(runtime.app).get("/api/platform/backups/runs?afterSequence=0&limit=100").expect(200);
    expect(incremental.body.data).toEqual(latest.body.data);
    await request(runtime.app).get("/api/platform/backups/runs?afterSequence=-1").expect(400);
    await request(runtime.app).get("/api/platform/backups/runs?unknown=true").expect(400);
  });
});
