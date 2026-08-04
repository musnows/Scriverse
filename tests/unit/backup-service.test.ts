import { describe, expect, it } from "vitest";
import { buildDbBackupKey, buildImageKey, buildPrefixes, collectAttachmentStorageKeys, isDatabaseBackupKey, isImageBackupKey, planImageUploads, runBackupToTarget, safeLogConfigForTarget, selectExpiredDbBackups } from "../../src/backup-service.js";
import type { BackupS3Like } from "../../src/backup-service.js";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

class FakeS3 implements BackupS3Like {
  existing = new Set<string>();
  uploaded: Array<{ key: string; body: Buffer }> = [];
  async headObject(key: string) {
    return { exists: this.existing.has(key) };
  }
  async putObject(request: { key: string; body: Buffer }) {
    this.uploaded.push({ key: request.key, body: request.body });
    this.existing.add(request.key);
    return {};
  }
  async listObjects(options?: { prefix?: string }) {
    const prefix = options?.prefix ?? "";
    const keys = [...this.existing].filter((key) => key.startsWith(prefix)).sort();
    return {
      objects: keys.map((key) => ({ key, size: 0 })),
      isTruncated: false
    };
  }
  async deleteObjects(keys: string[]) {
    for (const key of keys) this.existing.delete(key);
    return { deleted: keys, errors: [] };
  }
}

function createInMemoryS3WithExisting(existingKeys: string[]): FakeS3 {
  const s3 = new FakeS3();
  for (const key of existingKeys) s3.existing.add(key);
  return s3;
}

describe("backup-service: 路径与命名", () => {
  it("默认前缀构造为空", () => {
    expect(buildPrefixes("")).toEqual({
      rootPrefix: "scriverse",
      imagePrefix: "scriverse/img",
      dbPrefix: "scriverse/db"
    });
  });

  it("用户子目录去除两端斜杠并拼接", () => {
    expect(buildPrefixes("/prod/main//")).toEqual({
      rootPrefix: "scriverse/prod/main",
      imagePrefix: "scriverse/prod/main/img",
      dbPrefix: "scriverse/prod/main/db"
    });
  });

  it("数据库备份 key 形如 database-2026-08-04T22-44-30Z.db", () => {
    const date = new Date("2026-08-04T22:44:30.123Z");
    expect(buildDbBackupKey("scriverse/db", date)).toBe("scriverse/db/database-20260804T224430Z.db");
  });

  it("图片 key 保留子目录结构", () => {
    expect(buildImageKey("scriverse/img", "ab/abcdef.webp")).toBe("scriverse/img/ab/abcdef.webp");
  });

  it("数据库/图片 key 前缀匹配", () => {
    expect(isDatabaseBackupKey("scriverse/db/database-2026.db", "scriverse/db")).toBe(true);
    expect(isDatabaseBackupKey("scriverse/img/x.png", "scriverse/db")).toBe(false);
    expect(isImageBackupKey("scriverse/img/ab/x.webp", "scriverse/img")).toBe(true);
    expect(isImageBackupKey("scriverse/db/x.db", "scriverse/img")).toBe(false);
  });
});

describe("backup-service: selectExpiredDbBackups", () => {
  it("保留数 0/未超限返回空", () => {
    expect(selectExpiredDbBackups({ existing: [], retentionCount: 0 })).toEqual([]);
    expect(selectExpiredDbBackups({ existing: [{ key: "a" }], retentionCount: 1 })).toEqual([]);
  });

  it("超出留存数时按字典序删除最旧", () => {
    const expired = selectExpiredDbBackups({
      existing: [
        { key: "scriverse/db/database-20260101.db" },
        { key: "scriverse/db/database-20260102.db" },
        { key: "scriverse/db/database-20260103.db" }
      ],
      retentionCount: 1
    });
    expect(expired).toEqual([
      "scriverse/db/database-20260101.db",
      "scriverse/db/database-20260102.db"
    ]);
  });

  it("exclude 始终保留且新上传计入总数", () => {
    // 模拟"上传后 list 包含新 key"的真实流程：existing 中已包含新上传。
    const expired = selectExpiredDbBackups({
      existing: [
        { key: "db/2026-a.db" },
        { key: "db/2026-b.db" },
        { key: "db/2026-c.db" },
        { key: "db/2026-d.db" } // 这是本轮刚上传、必须保留
      ],
      retentionCount: 2,
      excludeKeys: new Set(["db/2026-d.db"])
    });
    expect(expired).toEqual(["db/2026-a.db", "db/2026-b.db"]);
  });

  it("exclude 项数等于或超过留存时不删除任何非 exclude 项", () => {
    const expired = selectExpiredDbBackups({
      existing: [
        { key: "db/x.db" },
        { key: "db/y.db" },
        { key: "db/z.db" }
      ],
      retentionCount: 1,
      excludeKeys: new Set(["db/x.db", "db/y.db", "db/z.db"])
    });
    expect(expired).toEqual([]);
  });
});

describe("backup-service: planImageUploads", () => {
  it("已存在的图片被跳过，缺失图片加入上传列表", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "backup-test-"));
    try {
      const storageKey = "ab/abcdef.webp";
      await mkdir(join(tempRoot, "ab"), { recursive: true });
      await writeFile(join(tempRoot, storageKey), Buffer.from("DATA"));
      const s3 = createInMemoryS3WithExisting(["scriverse/img/ab/abcdef.webp"]);
      const otherKey = "cd/123456.png";
      await mkdir(join(tempRoot, "cd"), { recursive: true });
      await writeFile(join(tempRoot, otherKey), Buffer.from("PNG"));
      const plan = await planImageUploads({
        s3,
        storageKeys: [storageKey, otherKey],
        imagePrefix: "scriverse/img",
        attachmentRoot: tempRoot
      });
      expect(plan.total).toBe(2);
      expect(plan.uploads.map((item) => item.storageKey)).toEqual([otherKey]);
      expect(plan.skipped.map((item) => item.objectKey)).toEqual(["scriverse/img/ab/abcdef.webp"]);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("本地图片缺失抛出 BackupFailure", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "backup-test-"));
    try {
      const s3 = new FakeS3();
      await expect(planImageUploads({
        s3,
        storageKeys: ["ab/missing.png"],
        imagePrefix: "scriverse/img",
        attachmentRoot: tempRoot
      })).rejects.toMatchObject({ name: "BackupFailure", kind: "image_not_found_local" });
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

describe("backup-service: collectAttachmentStorageKeys", () => {
  it("忽略 .tmp 与顶层非 2 字符目录", async () => {
    const root = await mkdtemp(join(tmpdir(), "backup-list-"));
    try {
      await mkdir(join(root, "ab"), { recursive: true });
      await mkdir(join(root, ".tmp"), { recursive: true });
      await mkdir(join(root, "long"), { recursive: true });
      await writeFile(join(root, "ab", "abcdef.webp"), Buffer.from(""));
      await writeFile(join(root, ".tmp", "scratch"), Buffer.from(""));
      await writeFile(join(root, "long", "xxx.webp"), Buffer.from(""));
      const keys = await collectAttachmentStorageKeys(root);
      expect(keys).toEqual(["ab/abcdef.webp"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("backup-service: safeLogConfigForTarget", () => {
  it("只导出字段白名单", () => {
    const safe = safeLogConfigForTarget({
      id: "x",
      displayName: "primary",
      endpoint: "https://s3.amazonaws.com",
      bucket: "bucket",
      region: "us-east-1",
      prefix: "",
      accessKeyId: "AKIAEXAMPLE",
      secretKeyHint: "ab***yz",
      secretAccessKey: "FORBIDDEN",
      encryptedSecretAccessKey: "FORBIDDEN",
      pathStyle: false,
      backupImages: false
    });
    expect(safe.targetId).toBe("x");
    expect(safe.accessKeyId).toBe("AKIAEXAMPLE");
    expect(safe.secretKeyHint).toBe("ab***yz");
    expect(Object.prototype.hasOwnProperty.call(safe, "secretAccessKey")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(safe, "encryptedSecretAccessKey")).toBe(false);
  });
});

describe("backup-service: runBackupToTarget", () => {
  it("完整流程上传图片与数据库并清理超额 db 备份", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "backup-flow-"));
    try {
      const attachmentRoot = join(tempRoot, "attachments");
      const snapshotDir = join(tempRoot, "snapshots");
      const databasePath = join(tempRoot, "novel.db");
      await mkdir(join(attachmentRoot, "ab"), { recursive: true });
      await writeFile(join(attachmentRoot, "ab", "abcdef.webp"), Buffer.from("WEBP"));
      // 创建一个最小 sqlite 数据库用于 VACUUM INTO
      const { DatabaseSync } = await import("node:sqlite");
      const database = new DatabaseSync(databasePath);
      database.exec("CREATE TABLE IF NOT EXISTS demo (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
      database.prepare("INSERT INTO demo (value) VALUES (?)").run("hello");
      database.close();

      // 已有 5 个旧的 db 备份 + 1 个现存图片，留存 3
      const existingImages = ["scriverse/prod/img/ab/abcdef.webp"];
      const existingDbs = [1, 2, 3, 4, 5].map((index) => `scriverse/prod/db/database-202601${String(index).padStart(2, "0")}T000000Z.db`);
      const s3 = createInMemoryS3WithExisting([...existingImages, ...existingDbs]);
      const now = new Date("2026-08-04T22:44:30.123Z");
      const result = await runBackupToTarget({
        config: {
          id: "target-1",
          endpoint: "https://s3.example.com",
          bucket: "bucket",
          region: "us-east-1",
          prefix: "prod",
          accessKeyId: "AKIAEXAMPLE",
          secretAccessKey: "secret-access-key",
          pathStyle: true,
          backupImages: true,
          retentionCount: 3
        },
        databasePath,
        attachmentRoot,
        snapshotDirectory: snapshotDir,
        s3,
        now
      });
      expect(s3.uploaded.find((item) => item.key === "scriverse/prod/img/ab/abcdef.webp")).toBeUndefined();
      expect(result.uploadedImageCount).toBe(0);
      expect(result.skippedImageCount).toBe(1);
      expect(s3.uploaded.find((item) => item.key === "scriverse/prod/db/database-20260804T224430Z.db")).toBeDefined();
      expect(result.deletedDbBackupCount).toBe(3);
      expect(result.uploadedDbKey).toBe("scriverse/prod/db/database-20260804T224430Z.db");
      // 验证留存刚好 3：刚上传 + 三条中较新的两条
      const remaining = [...s3.existing].filter((key) => key.startsWith("scriverse/prod/db/")).sort();
      expect(remaining.length).toBe(3);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("saveLog 不暴露 secretAccessKey", () => {
    const safe = safeLogConfigForTarget({
      id: "t1",
      endpoint: "https://s3.example.com",
      bucket: "b",
      region: "us-east-1",
      accessKeyId: "AKIA",
      secretAccessKey: "should-not-leak",
      pathStyle: true,
      backupImages: false,
      retentionCount: 7
    });
    const json = JSON.stringify(safe);
    expect(json.includes("should-not-leak")).toBe(false);
  });
});
