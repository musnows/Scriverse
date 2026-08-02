import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { backupTimestamp, normalizeBackupPrefix, selectPruneKeys, walkAttachmentKeys, STORAGE_KEY_PATTERN } from "../../src/backup.js";

const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "scriverse-backup-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function key(base: string, name: string): string {
  return `${base}${name}`;
}

describe("selectPruneKeys 留存清理", () => {
  it("未超过留存个数时不做清理", () => {
    const keys = [
      key("scriverse/db/", "novel-2026-08-01T00-00-00-000Z.db"),
      key("scriverse/db/", "novel-2026-08-02T00-00-00-000Z.db"),
      key("scriverse/db/", "novel-2026-08-02T00-00-00-000Z-wal.db"),
      key("scriverse/db/", "master-2026-08-02T00-00-00-000Z.key")
    ];
    expect(selectPruneKeys(keys, 10)).toEqual([]);
  });

  it("超过留存个数时删除最老备份的全部文件", () => {
    const oldest = key("scriverse/db/", "novel-2026-08-01T00-00-00-000Z.db");
    const keys = [
      oldest,
      key("scriverse/db/", "master-2026-08-01T00-00-00-000Z.key"),
      key("scriverse/db/", "novel-2026-08-02T00-00-00-000Z.db"),
      key("scriverse/db/", "novel-2026-08-02T00-00-00-000Z-wal.db"),
      key("scriverse/db/", "master-2026-08-02T00-00-00-000Z.key"),
      key("scriverse/db/", "novel-2026-08-03T00-00-00-000Z.db"),
      key("scriverse/db/", "master-2026-08-03T00-00-00-000Z.key")
    ];
    expect(selectPruneKeys(keys, 2)).toEqual([
      oldest,
      key("scriverse/db/", "master-2026-08-01T00-00-00-000Z.key")
    ]);
  });

  it("按时间戳排序忽略文件顺序", () => {
    const keys = [
      key("scriverse/db/", "novel-2026-08-03T00-00-00-000Z.db"),
      key("scriverse/db/", "novel-2026-08-01T00-00-00-000Z.db"),
      key("scriverse/db/", "novel-2026-08-02T00-00-00-000Z.db")
    ];
    expect(selectPruneKeys(keys, 1)).toEqual([
      key("scriverse/db/", "novel-2026-08-01T00-00-00-000Z.db"),
      key("scriverse/db/", "novel-2026-08-02T00-00-00-000Z.db")
    ]);
  });

  it("忽略图片与无关文件", () => {
    const keys = [
      key("scriverse/img/", "ab/hash.webp"),
      key("scriverse/db/", "novel-2026-08-01T00-00-00-000Z.db"),
      key("scriverse/db/", "readme.txt"),
      key("other-prefix/scriverse/db/", "novel-2026-08-01T00-00-00-000Z.db")
    ];
    expect(selectPruneKeys(keys, 10)).toEqual([]);
  });

  it("留存个数下限为 1", () => {
    const keys = [
      key("scriverse/db/", "novel-2026-08-01T00-00-00-000Z.db"),
      key("scriverse/db/", "novel-2026-08-02T00-00-00-000Z.db")
    ];
    expect(selectPruneKeys(keys, 0)).toEqual([key("scriverse/db/", "novel-2026-08-01T00-00-00-000Z.db")]);
  });

  it("子目录前缀下的备份同样参与清理", () => {
    const prefix = "backups/novel-a/scriverse/db/";
    const keys = [
      key(prefix, "novel-2026-08-01T00-00-00-000Z.db"),
      key(prefix, "novel-2026-08-02T00-00-00-000Z.db")
    ];
    expect(selectPruneKeys(keys, 1)).toEqual([key(prefix, "novel-2026-08-01T00-00-00-000Z.db")]);
  });
});

describe("backupTimestamp", () => {
  it("生成固定格式时间戳", () => {
    const timestamp = backupTimestamp(new Date("2026-08-02T03:04:05.123Z"));
    expect(timestamp).toBe("2026-08-02T03-04-05-123Z");
  });
});

describe("normalizeBackupPrefix", () => {
  it("去除首尾斜杠", () => {
    expect(normalizeBackupPrefix("/backups/novel-a/")).toBe("backups/novel-a");
    expect(normalizeBackupPrefix("")).toBe("");
    expect(normalizeBackupPrefix("  ")).toBe("");
  });

  it("拒绝路径穿越", () => {
    expect(() => normalizeBackupPrefix("a/../b")).toThrow("..");
    expect(() => normalizeBackupPrefix("../escape")).toThrow("..");
  });
});

describe("walkAttachmentKeys", () => {
  it("只返回符合存储 key 布局的图片文件", () => {
    const root = makeTemporaryDirectory();
    mkdirSync(join(root, "ab"), { recursive: true });
    mkdirSync(join(root, "cd"), { recursive: true });
    writeFileSync(join(root, "ab", "a".repeat(64) + ".webp"), "image");
    writeFileSync(join(root, "cd", "b".repeat(64) + ".png"), "image");
    writeFileSync(join(root, "cd", "B".repeat(64) + ".png"), "uppercase");
    mkdirSync(join(root, ".tmp"), { recursive: true });
    writeFileSync(join(root, ".tmp", "c".repeat(64) + ".webp"), "temp");
    writeFileSync(join(root, "ab", "not-a-key.txt"), "text");
    const keys = walkAttachmentKeys(root);
    expect(keys).toContain("ab/" + "a".repeat(64) + ".webp");
    expect(keys).toContain("cd/" + "b".repeat(64) + ".png");
    // 大写哈希不符合存储 key 布局，不应上传
    expect(keys).not.toContain("cd/" + "B".repeat(64) + ".png");
    expect(keys).not.toContain(".tmp/" + "c".repeat(64) + ".webp");
    expect(keys).not.toContain("ab/not-a-key.txt");
  });

  it("目录不存在时返回空列表", () => {
    expect(walkAttachmentKeys(join(tmpdir(), "definitely-missing-dir"))).toEqual([]);
  });
});

describe("STORAGE_KEY_PATTERN", () => {
  it("匹配合法存储 key", () => {
    expect(STORAGE_KEY_PATTERN.test("ab/" + "a".repeat(64) + ".webp")).toBe(true);
    expect(STORAGE_KEY_PATTERN.test("ab/" + "a".repeat(64) + ".jpg")).toBe(true);
    expect(STORAGE_KEY_PATTERN.test("ab/" + "A".repeat(64) + ".png")).toBe(false);
    expect(STORAGE_KEY_PATTERN.test("ab/too-short.webp")).toBe(false);
  });
});
