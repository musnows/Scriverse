import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { DATABASE_SCHEMA_VERSION, Database, readDatabaseSchemaVersion } from "../../src/database.js";

const roots: string[] = [];
const fixtureDatabase = fileURLToPath(new URL(
  "../fixtures/database/scriverse-demo-db-with-setting-images-20260802/runtime/demo.db",
  import.meta.url
));

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("真实数据库升级夹具", () => {
  it("将 schema 72 的脱敏演示数据库平滑升级到当前版本", () => {
    const root = mkdtempSync(join(tmpdir(), "scriverse-database-upgrade-fixture-"));
    roots.push(root);
    const databasePath = join(root, "novel.db");
    cpSync(fixtureDatabase, databasePath);

    expect(readDatabaseSchemaVersion(databasePath)).toBe(72);
    const database = new Database(databasePath);
    try {
      expect(Number(database.get("SELECT MAX(version) AS version FROM schema_migrations")?.version)).toBe(DATABASE_SCHEMA_VERSION);
      expect(Number(database.get("SELECT COUNT(*) AS count FROM works")?.count)).toBeGreaterThan(0);
      expect(database.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
      expect(database.all("PRAGMA foreign_key_check")).toEqual([]);
    } finally {
      database.close();
    }

    const restartedDatabase = new Database(databasePath);
    try {
      expect(Number(restartedDatabase.get("SELECT MAX(version) AS version FROM schema_migrations")?.version)).toBe(DATABASE_SCHEMA_VERSION);
      expect(restartedDatabase.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
      expect(restartedDatabase.all("PRAGMA foreign_key_check")).toEqual([]);
    } finally {
      restartedDatabase.close();
    }
  });
});
