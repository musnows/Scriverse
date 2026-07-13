import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { Database } from "../../src/database.js";

const roots: string[] = [];

function createLegacyDatabase(conflict = false): string {
  const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-"));
  roots.push(root);
  const filename = join(root, "legacy.db");
  const database = new DatabaseSync(filename);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE works (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
      language TEXT NOT NULL DEFAULT 'zh-CN', cover_url TEXT, tags_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE volumes (
      id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE, title TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'main', source TEXT NOT NULL DEFAULT 'manual', sort_order INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE chapters (
      id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
      volume_id TEXT NOT NULL REFERENCES volumes(id) ON DELETE CASCADE, title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL, word_count INTEGER NOT NULL DEFAULT 0, version_no INTEGER NOT NULL DEFAULT 1,
      analysis_status TEXT NOT NULL DEFAULT 'pending', excluded_from_analysis INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE characters (
      id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE, name TEXT NOT NULL,
      aliases_json TEXT NOT NULL DEFAULT '[]', attributes_json TEXT NOT NULL DEFAULT '{}', profile_json TEXT NOT NULL DEFAULT '{}',
      current_state_json TEXT NOT NULL DEFAULT '{}', locked_fields_json TEXT NOT NULL DEFAULT '[]', visibility TEXT NOT NULL DEFAULT 'author',
      first_chapter_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO works VALUES ('work-old', '旧作品', '', '', 'zh-CN', NULL, '[]', '2025-01-01', '2025-01-01');
    INSERT INTO volumes VALUES ('volume-old', 'work-old', '第一卷', 'main', 'manual', 0, '2025-01-01', '2025-01-01');
    INSERT INTO chapters VALUES ('chapter-old', 'work-old', 'volume-old', '第一章', '旧正文', 0, 3, 1, 'pending', 0, '2025-01-01', '2025-01-01');
  `);
  const insert = database.prepare(`INSERT INTO characters
    (id, work_id, name, aliases_json, attributes_json, profile_json, current_state_json, locked_fields_json, visibility, first_chapter_id, created_at, updated_at)
    VALUES (?, 'work-old', ?, ?, '{}', '{}', '{}', '[]', 'author', NULL, '2025-01-01', '2025-01-01')`);
  insert.run("character-a", "魔斯拉", JSON.stringify(["小魔", "Mothra"]));
  insert.run("character-b", conflict ? "小魔" : "拉顿", JSON.stringify([]));
  database.close();
  return filename;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("数据库版本化迁移", () => {
  it("无损回填角色主名与别名并支持幂等重启", () => {
    const filename = createLegacyDatabase();
    const first = new Database(filename);
    expect(first.all("SELECT display_name, kind FROM character_names ORDER BY character_id, sort_order")).toEqual([
      { display_name: "魔斯拉", kind: "primary" },
      { display_name: "小魔", kind: "alias" },
      { display_name: "Mothra", kind: "alias" },
      { display_name: "拉顿", kind: "primary" }
    ]);
    expect(first.all("SELECT version FROM schema_migrations ORDER BY version")).toEqual([{ version: 1 }, { version: 2 }, { version: 3 }, { version: 4 }, { version: 5 }, { version: 6 }, { version: 7 }, { version: 8 }, { version: 9 }]);
    expect(first.all("PRAGMA table_info(relationships)").some((column) => column.name === "keywords_json")).toBe(true);
    expect(first.all("PRAGMA table_info(providers)").filter((column) => ["concurrency_limit", "rpm_limit", "max_tokens"].includes(String(column.name)))).toHaveLength(3);
    expect(first.all("PRAGMA table_info(chapters)").some((column) => column.name === "chapter_type")).toBe(true);
    expect(first.get("SELECT title, chapter_type FROM chapters WHERE id = 'chapter-old'")).toEqual({ title: "第一章", chapter_type: "正文" });
    expect(first.get("SELECT COUNT(*) AS count FROM organizations")?.count).toBe(0);
    expect(first.get("SELECT COUNT(*) AS count FROM timeline_tracks")?.count).toBe(0);
    expect(first.all("PRAGMA table_info(timeline_events)").some((column) => column.name === "track_id")).toBe(true);
    expect(first.all("PRAGMA table_info(volumes)").filter((column) => ["description", "keywords_json"].includes(String(column.name)))).toHaveLength(2);
    expect(first.get("SELECT description, keywords_json FROM volumes WHERE id = 'volume-old'")).toEqual({ description: "", keywords_json: "[]" });
    expect(first.all("PRAGMA table_info(works)").some((column) => column.name === "is_internal")).toBe(true);
    expect(first.all("PRAGMA table_info(models)").some((column) => column.name === "context_window")).toBe(true);
    expect(first.all("PRAGMA table_info(ai_conversation_messages)").some((column) => column.name === "metadata_json")).toBe(true);
    expect(first.get("SELECT is_internal FROM works WHERE id = '__scriverse_platform_ai__'")).toEqual({ is_internal: 1 });
    expect(first.get("SELECT system_prompt FROM platform_ai_settings WHERE id = 1")).toEqual({ system_prompt: "" });
    first.run(
      `INSERT INTO ai_calls (id, work_id, task_type, provider_id, model_id, context_scope_json, status, created_at)
       VALUES ('call-running', 'work-old', 'book-analysis', 'provider-old', 'model-old', '{}', 'running', '2025-01-01')`
    );
    first.run(
      `INSERT INTO analysis_tasks (id, work_id, task_type, status, created_at, updated_at)
       VALUES ('task-running', 'work-old', 'book-analysis', 'running', '2025-01-01', '2025-01-01')`
    );
    first.close();

    const second = new Database(filename);
    expect(second.get("SELECT COUNT(*) AS count FROM character_names")?.count).toBe(4);
    expect(second.get("SELECT title FROM works WHERE id = 'work-old'")?.title).toBe("旧作品");
    expect(second.get("SELECT status FROM ai_calls WHERE id = 'call-running'")?.status).toBe("failed");
    expect(second.get("SELECT status FROM analysis_tasks WHERE id = 'task-running'")?.status).toBe("partial");
    second.close();
  });

  it("历史名称冲突时原子回滚名称索引迁移", () => {
    const filename = createLegacyDatabase(true);
    expect(() => new Database(filename)).toThrow(/重复角色名或别名/u);
    const database = new DatabaseSync(filename);
    expect(database.prepare("SELECT COUNT(*) AS count FROM character_names").get()?.count).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 2").get()?.count).toBe(0);
    database.close();
  });
});
