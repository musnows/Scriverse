import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "../../src/logger.js";
import type { S3Like } from "../../src/s3-client.js";
import {
  buildPrefixes,
  collectAttachmentStorageKeys,
  normalizeSubDirectory,
  planImageUploads,
  runBackupToTarget,
  selectExpiredDbBackups
} from "../../src/backup-service.js";

const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {}
};

class FakeS3 implements S3Like {
  public putCalls: Array<{ key: string; filePath: string; contentType: string }> = [];
  public deleteCalls: Array<string[]> = [];
  public listCalls: string[] = [];
  public existingImg = new Set<string>();
  public existingDb: string[] = [];

  async headObject(): Promise<boolean> {
    return false;
  }
  async putObject(key: string, filePath: string, contentType: string): Promise<void> {
    this.putCalls.push({ key, filePath, contentType });
    if (key.startsWith("scriverse/db/")) this.existingDb.push(key);
    else if (key.startsWith("scriverse/img/")) this.existingImg.add(key);
  }
  async listObjects(prefix: string): Promise<string[]> {
    this.listCalls.push(prefix);
    return prefix.endsWith("img/") ? [...this.existingImg] : [...this.existingDb];
  }
  async deleteObjects(keys: string[]): Promise<void> {
    this.deleteCalls.push(keys);
  }
}

describe("backup-service 纯函数", () => {
  it("normalizeSubDirectory 去除首尾斜杠", () => {
    expect(normalizeSubDirectory("/sub/")).toBe("sub");
    expect(normalizeSubDirectory("  sub/inner  ")).toBe("sub/inner");
    expect(normalizeSubDirectory("")).toBe("");
  });

  it("buildPrefixes 统一落在 /scriverse 下", () => {
    expect(buildPrefixes("")).toEqual({ imgPrefix: "scriverse/img/", dbPrefix: "scriverse/db/" });
    expect(buildPrefixes("team-a")).toEqual({ imgPrefix: "team-a/scriverse/img/", dbPrefix: "team-a/scriverse/db/" });
  });

  it("planImageUploads 仅返回不存在的图片", () => {
    const keys = ["a.png", "b.png", "sub/c.png"];
    const existing = new Set(["scriverse/img/a.png"]);
    expect(planImageUploads(keys, existing, "scriverse/img/").sort()).toEqual(["b.png", "sub/c.png"]);
  });

  it("selectExpiredDbBackups 仅清理最旧的超时快照且不误删其它文件", () => {
    const keys = [
      "scriverse/db/novel-20240101T000000Z.db",
      "scriverse/db/novel-20240102T000000Z.db",
      "scriverse/db/novel-20240103T000000Z.db",
      "scriverse/db/readme.txt",
      "scriverse/db/novel-20240104T000000Z.db"
    ];
    const expired = selectExpiredDbBackups(keys, 3);
    expect(expired).toEqual(["scriverse/db/novel-20240101T000000Z.db"]);
  });

  it("collectAttachmentStorageKeys 递归收集并用 / 分隔、忽略 .tmp", () => {
    const dir = mkdtempSync(join(tmpdir(), "bk-attach-"));
    try {
      mkdirSync(join(dir, "sub"), { recursive: true });
      writeFileSync(join(dir, "cover.webp"), "x");
      writeFileSync(join(dir, "sub", "photo.png"), "y");
      writeFileSync(join(dir, ".tmp"), "ignore");
      const keys = collectAttachmentStorageKeys(dir).sort();
      expect(keys).toEqual(["cover.webp", "sub/photo.png"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runBackupToTarget 编排", () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop() as string;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeAttachmentDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "bk-run-attach-"));
    tempDirs.push(dir);
    mkdirSync(join(dir, "nested"), { recursive: true });
    writeFileSync(join(dir, "cover.webp"), "cover");
    writeFileSync(join(dir, "nested", "shot.png"), "shot");
    return dir;
  }

  function makeSnapshot(): string {
    const dir = mkdtempSync(join(tmpdir(), "bk-run-snap-"));
    tempDirs.push(dir);
    const path = join(dir, "novel.db");
    writeFileSync(path, "snapshot-bytes");
    return path;
  }

  it("备份图片时跳过已存在、上传缺失，并上传带时间戳的数据库", async () => {
    const attachmentDirectory = makeAttachmentDir();
    const snapshotPath = makeSnapshot();
    const s3 = new FakeS3();
    s3.existingImg.add("scriverse/img/cover.webp");
    const result = await runBackupToTarget({
      client: s3,
      meta: { label: "主存储", subDirectory: "" },
      dbSnapshotPath: snapshotPath,
      attachmentDirectory,
      backupImages: true,
      retentionCount: 7,
      logger: silentLogger
    });
    expect(result.uploadedImages).toBe(1);
    expect(result.skippedImages).toBe(1);
    const uploadedKeys = s3.putCalls.map((call) => call.key);
    expect(uploadedKeys).toContain("scriverse/img/nested/shot.png");
    expect(uploadedKeys).not.toContain("scriverse/img/cover.webp");
    expect(result.uploadedDb).toBe(true);
    const dbCall = s3.putCalls.find((call) => call.key.startsWith("scriverse/db/novel-"));
    expect(dbCall).toBeDefined();
    expect(dbCall?.contentType).toBe("application/octet-stream");
  });

  it("关闭图片备份时只上传数据库", async () => {
    const attachmentDirectory = makeAttachmentDir();
    const snapshotPath = makeSnapshot();
    const s3 = new FakeS3();
    const result = await runBackupToTarget({
      client: s3,
      meta: { label: "仅库", subDirectory: "" },
      dbSnapshotPath: snapshotPath,
      attachmentDirectory,
      backupImages: false,
      retentionCount: 7,
      logger: silentLogger
    });
    expect(result.uploadedImages).toBe(0);
    expect(result.skippedImages).toBe(0);
    expect(result.uploadedDb).toBe(true);
  });

  it("超过留存份数时清理最旧的数据库快照而不清理图片", async () => {
    const attachmentDirectory = makeAttachmentDir();
    const snapshotPath = makeSnapshot();
    const s3 = new FakeS3();
    s3.existingImg.add("scriverse/img/cover.webp");
    s3.existingDb = [
      "scriverse/db/novel-20240101T000000Z.db",
      "scriverse/db/novel-20240102T000000Z.db",
      "scriverse/db/novel-20240103T000000Z.db",
      "scriverse/db/novel-20240104T000000Z.db",
      "scriverse/db/novel-20240105T000000Z.db",
      "scriverse/db/novel-20240106T000000Z.db",
      "scriverse/db/novel-20240107T000000Z.db"
    ];
    const result = await runBackupToTarget({
      client: s3,
      meta: { label: "留存", subDirectory: "" },
      dbSnapshotPath: snapshotPath,
      attachmentDirectory,
      backupImages: true,
      retentionCount: 7,
      logger: silentLogger
    });
    expect(result.uploadedImages).toBe(1);
    expect(result.deletedDbBackups).toBe(1);
    expect(s3.deleteCalls).toEqual([["scriverse/db/novel-20240101T000000Z.db"]]);
  });
});
