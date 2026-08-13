import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { DATABASE_SCHEMA_VERSION, Database } from "../../src/database.js";

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
    CREATE TABLE platform_ui_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      toast_position TEXT NOT NULL DEFAULT 'bottom-right' CHECK(toast_position IN ('bottom-right', 'top-right')),
      updated_at TEXT NOT NULL
    );
    INSERT INTO platform_ui_settings (id, toast_position, updated_at) VALUES (1, 'top-right', '2025-01-01');
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
  database.prepare("UPDATE characters SET attributes_json = ? WHERE id = 'character-a'").run(JSON.stringify({ species: "泰坦族" }));
  database.prepare("UPDATE characters SET profile_json = ? WHERE id = 'character-a'").run(JSON.stringify({
    summary: "星球守护者",
    sections: [{ title: "背景故事", content: "## 远古时期\n\n守护地球生态。" }]
  }));
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
    expect(first.all("SELECT version FROM schema_migrations ORDER BY version")).toEqual(Array.from({ length: DATABASE_SCHEMA_VERSION }, (_, index) => ({ version: index + 1 })));
    expect(first.all("PRAGMA table_info(characters)").map((column) => column.name)).toEqual(expect.arrayContaining(["code", "merged_into_character_id", "merged_at", "is_dead"]));
    expect(first.all("PRAGMA table_info(races)").map((column) => column.name)).toContain("is_extinct");
    expect(first.all("PRAGMA table_info(organizations)").map((column) => column.name)).toContain("is_dissolved");
    expect(first.get("SELECT is_dead FROM characters WHERE id = 'character-a'")).toEqual({ is_dead: 0 });
    expect(first.get("SELECT is_extinct FROM races WHERE id = 'race_migration_1'")).toEqual({ is_extinct: 0 });
    expect(first.all("PRAGMA table_info(characters)").some((column) => column.name === "visibility")).toBe(false);
    expect(first.get("SELECT code FROM characters WHERE id = 'character-a'")).toEqual({ code: "" });
    expect(first.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'character_merges'")?.name).toBe("character_merges");
    expect(first.all("PRAGMA table_info(works)").some((column) => column.name === "owner_user_id")).toBe(true);
    expect(first.all("PRAGMA table_info(works)").some((column) => column.name === "version_no")).toBe(true);
    expect(first.all("PRAGMA table_info(volumes)").some((column) => column.name === "version_no")).toBe(true);
    expect(first.all("PRAGMA table_info(work_memberships)").some((column) => column.name === "permissions_json")).toBe(true);
    expect(first.all("PRAGMA table_info(chapter_versions)").some((column) => column.name === "created_by_user_id")).toBe(true);
    expect(first.all("PRAGMA table_info(chapter_versions)").some((column) => column.name === "work_id")).toBe(true);
    expect(first.all("PRAGMA table_info(chapter_versions)").some((column) => column.name === "change_note")).toBe(true);
    expect(first.all("PRAGMA table_info(audit_logs)").some((column) => column.name === "user_id")).toBe(true);
    expect(first.all("PRAGMA table_info(entity_versions)").map((column) => column.name)).toEqual(expect.arrayContaining(["entity_type", "entity_id", "version_no", "snapshot_json"]));
    expect(first.all("PRAGMA table_info(drafts)").map((column) => column.name)).toEqual(expect.arrayContaining(["work_id", "draft_type", "volume_id", "setting_module", "title", "content"]));
    expect(first.all("PRAGMA index_list(drafts)").some((index) => index.name === "idx_drafts_work")).toBe(true);
    expect(first.all("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'drafts'").map((row) => row.name)).toEqual(expect.arrayContaining(["drafts_binding_insert", "drafts_binding_update"]));
    expect(first.all("PRAGMA table_info(relationships)").some((column) => column.name === "keywords_json")).toBe(true);
    expect(first.all("PRAGMA table_info(providers)").filter((column) => ["concurrency_limit", "rpm_limit", "max_tokens"].includes(String(column.name)))).toHaveLength(3);
    expect(first.all("PRAGMA table_info(providers)").some((column) => column.name === "protocol" && column.dflt_value === "'openai-chat-completions'")).toBe(true);
    expect(first.all("PRAGMA table_info(chapters)").some((column) => column.name === "chapter_type")).toBe(true);
    expect(first.all("PRAGMA table_info(chapters)").some((column) => column.name === "deleted_at")).toBe(true);
    expect(first.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chapter_annotations'")?.name).toBe("chapter_annotations");
    expect(first.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chapter_annotation_versions'")?.name).toBe("chapter_annotation_versions");
    expect(first.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'writing_goals'")?.name).toBe("writing_goals");
    expect(first.get("SELECT title, chapter_type FROM chapters WHERE id = 'chapter-old'")).toEqual({ title: "第一章", chapter_type: "正文" });
    expect(first.all("SELECT name, species FROM characters ORDER BY name")).toEqual([
      { name: "拉顿", species: "" },
      { name: "魔斯拉", species: "泰坦族" }
    ]);
    expect(first.all("SELECT name, description FROM races")).toEqual([{ name: "泰坦族", description: "由旧人物种族字段迁移生成" }]);
    expect(first.get("SELECT parent_race_id FROM races WHERE id = 'race_migration_1'")?.parent_race_id).toBeNull();
    expect(first.all("PRAGMA index_list(races)").some((index) => index.name === "idx_races_parent")).toBe(true);
    expect(first.all("PRAGMA table_info(races)").some((column) => column.name === "settings_sections_json")).toBe(true);
    expect(first.all("PRAGMA table_info(organizations)").some((column) => column.name === "settings_sections_json")).toBe(true);
    expect(first.all("PRAGMA index_list(analysis_tasks)").some((index) => index.name === "idx_tasks_work_created")).toBe(true);
    expect(first.all("PRAGMA table_info(analysis_tasks)").some((column) => column.name === "model_id")).toBe(true);
    expect(first.all("PRAGMA index_list(analysis_tasks)").some((index) => index.name === "idx_tasks_model")).toBe(true);
    expect(first.all("PRAGMA table_info(ai_calls)").some((column) => column.name === "task_id")).toBe(true);
    expect(first.all("PRAGMA table_info(ai_calls)").map((column) => column.name)).toEqual(expect.arrayContaining([
      "input_tokens",
      "output_tokens",
      "cached_input_tokens",
      "cache_eligible_input_tokens",
      "cache_usage_available",
      "token_usage_source"
    ]));
    expect(first.all("PRAGMA table_info(work_ai_settings)").some((column) => column.name === "daily_token_quota")).toBe(true);
    expect(first.all("PRAGMA table_info(ai_call_traces)").map((column) => column.name)).toEqual(
      expect.arrayContaining(["call_id", "task_id", "initial_messages_json", "rounds_json", "source_refs_json", "created_at", "updated_at"])
    );
    expect(first.all("PRAGMA index_list(ai_calls)").some((index) => index.name === "idx_calls_task")).toBe(true);
    expect(first.all("PRAGMA index_list(ai_call_traces)").some((index) => index.name === "idx_ai_call_traces_task")).toBe(true);
    expect(first.get("SELECT race_id FROM characters WHERE id = 'character-a'")?.race_id).toBe("race_migration_1");
    expect(first.get("SELECT race_id FROM characters WHERE id = 'character-b'")?.race_id).toBeNull();
    expect(first.all("SELECT character_id, version_no, source, change_note FROM character_versions ORDER BY character_id")).toEqual([
      { character_id: "character-a", version_no: 1, source: "migration", change_note: "建立人物版本基线" },
      { character_id: "character-b", version_no: 1, source: "migration", change_note: "建立人物版本基线" }
    ]);
    const migratedSnapshot = JSON.parse(String(first.get("SELECT snapshot_json FROM character_versions WHERE character_id = 'character-a'")?.snapshot_json));
    expect(migratedSnapshot).toMatchObject({ name: "魔斯拉", raceId: "race_migration_1", species: "泰坦族", organizationIds: [] });
    expect(first.get("SELECT COUNT(*) AS count FROM organizations")?.count).toBe(0);
    expect(first.get("SELECT COUNT(*) AS count FROM timeline_tracks")?.count).toBe(0);
    expect(first.all("PRAGMA table_info(timeline_events)").some((column) => column.name === "track_id")).toBe(true);
    expect(first.all("PRAGMA table_info(volumes)").filter((column) => ["description", "keywords_json"].includes(String(column.name)))).toHaveLength(2);
    expect(first.get("SELECT description, keywords_json FROM volumes WHERE id = 'volume-old'")).toEqual({ description: "", keywords_json: "[]" });
    expect(first.all("PRAGMA table_info(works)").some((column) => column.name === "is_internal")).toBe(true);
    expect(first.all("PRAGMA table_info(models)").some((column) => column.name === "context_window")).toBe(true);
    expect(first.all("PRAGMA table_info(models)").some((column) => column.name === "thinking_enabled" && column.dflt_value === "1")).toBe(true);
    expect(first.all("PRAGMA table_info(ai_conversation_messages)").some((column) => column.name === "metadata_json")).toBe(true);
    expect(first.all("PRAGMA table_info(ai_conversation_messages)").some((column) => column.name === "request_id")).toBe(true);
    expect(first.all("PRAGMA index_list(ai_conversation_messages)").some((index) => index.name === "idx_ai_conversation_messages_request")).toBe(true);
    expect(first.all("PRAGMA table_info(ai_history_search)").map((column) => column.name)).toEqual(expect.arrayContaining([
      "work_id",
      "conversation_id",
      "message_id",
      "source_type",
      "source_id",
      "search_content"
    ]));
    expect(first.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ai_history_search_fts'")?.name).toBe("ai_history_search_fts");
    expect(first.all("PRAGMA index_list(ai_history_search)").some((index) => index.name === "idx_ai_history_search_work")).toBe(true);
    expect(first.all("PRAGMA index_list(ai_history_search_short_terms)").some(
      (index) => index.name === "idx_ai_history_search_short_terms_search"
    )).toBe(true);
    expect(first.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ai_write_plans'")?.name).toBe("ai_write_plans");
    expect(first.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ai_write_plan_operations'")?.name).toBe("ai_write_plan_operations");
    expect(first.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ai_approval_questions'")?.name).toBe("ai_approval_questions");
    expect(first.all("PRAGMA index_list(ai_write_plans)").some((index) => index.name === "idx_ai_write_plans_work")).toBe(true);
    expect(first.all("PRAGMA index_list(ai_write_plan_operations)").some((index) => index.name === "idx_ai_write_plan_operations_plan")).toBe(true);
    expect(first.all("PRAGMA index_list(ai_approval_questions)").some((index) => index.name === "idx_ai_approval_questions_work")).toBe(true);
    expect(first.all("PRAGMA table_info(work_ai_settings)").some((column) => column.name === "ai_write_tools_json")).toBe(true);
    expect(first.get("SELECT is_internal FROM works WHERE id = '__scriverse_platform_ai__'")).toEqual({ is_internal: 1 });
    expect(first.get("SELECT system_prompt FROM platform_ai_settings WHERE id = 1")).toEqual({ system_prompt: "" });
    expect(first.get("SELECT toast_position, page_sizes_json FROM platform_ui_settings WHERE id = 1")).toEqual({
      toast_position: "top-right",
      page_sizes_json: '{"characters":30,"analysisTasks":30,"fileVersions":30}'
    });
    expect(first.all("PRAGMA table_info(platform_ui_settings)").some((column) => column.name === "page_sizes_json")).toBe(true);
    expect(first.get("SELECT chapter_id, content FROM chapter_paragraph_search WHERE chapter_id = 'chapter-old'")).toEqual({ chapter_id: "chapter-old", content: "旧正文" });
    expect(first.all("PRAGMA index_list(chapter_paragraph_short_terms)").some(
      (index) => index.name === "idx_chapter_paragraph_short_terms_paragraph"
    )).toBe(true);
    expect(first.all("EXPLAIN QUERY PLAN DELETE FROM chapter_paragraph_short_terms WHERE paragraph_id = 1").some(
      (step) => String(step.detail).includes("idx_chapter_paragraph_short_terms_paragraph")
    )).toBe(true);
    expect(first.get(`SELECT paragraph.rowid AS id FROM chapter_paragraph_search_fts paragraph
      WHERE chapter_paragraph_search_fts MATCH '"旧正文"'`)).toEqual({ id: 1 });
    expect(first.all("PRAGMA table_info(work_ai_settings)").map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "auto_run_enabled",
        "auto_run_concurrency",
        "auto_run_batch_limit",
        "auto_run_daily_task_limit",
        "auto_run_failure_threshold",
        "auto_run_paused",
        "auto_run_pause_reason",
        "auto_run_resume_at",
        "auto_run_consecutive_failures",
        "book_summary_context_percent",
        "context_compact_threshold",
        "agent_tool_call_limit",
        "agent_tool_call_global_multiplier",
        "agent_tools_json",
        "always_include_setting_info",
        "title_generation_model_id"
      ])
    );
    expect(first.all("PRAGMA table_info(analysis_tasks)").map((column) => column.name)).toEqual(
      expect.arrayContaining(["attempt_count", "next_attempt_at", "last_attempt_at"])
    );
    expect(first.all("PRAGMA table_info(ai_conversations)").map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "compacted_summary",
        "compacted_message_count",
        "context_warning_at",
        "agent_tools_json",
        "injected_entities_json",
        "system_clock_text",
        "roleplay_character_id",
        "task_type",
        "context_scope_json"
      ])
    );
    expect(first.all("PRAGMA index_list(ai_conversations)").some((index) => index.name === "idx_ai_conversations_roleplay_character")).toBe(true);
    expect(first.all("PRAGMA table_info(user_api_keys)").map((column) => column.name)).toEqual(
      expect.arrayContaining(["user_id", "key_hash", "key_prefix", "created_at", "rotated_at", "last_used_at"])
    );
    expect(first.all("PRAGMA table_info(users)").map((column) => column.name)).toEqual(expect.arrayContaining(["avatar_updated_at", "avatar_sha256", "onboarding_completed_at"]));
    expect(first.all("PRAGMA table_info(login_attempts)").map((column) => column.name)).toEqual(
      expect.arrayContaining(["normalized_username", "failure_timestamps_json", "locked_until", "updated_at"])
    );
    expect(first.all("PRAGMA index_list(login_attempts)").some((index) => index.name === "idx_login_attempts_updated")).toBe(true);
    expect(first.all("PRAGMA table_info(user_avatars)").map((column) => column.name)).toEqual(
      expect.arrayContaining(["user_id", "mime_type", "content", "byte_length", "sha256", "width", "height", "updated_at"])
    );
    expect(first.get("SELECT character_id, section_type, title, content_markdown FROM character_profile_sections")).toEqual({
      character_id: "character-a",
      section_type: "custom",
      title: "背景故事",
      content_markdown: "## 远古时期\n\n守护地球生态。"
    });
    first.run(
      `INSERT INTO ai_calls (id, work_id, task_type, provider_id, model_id, context_scope_json, status, created_at)
       VALUES ('call-running', 'work-old', 'book-analysis', 'provider-old', 'model-old', '{}', 'running', '2025-01-01')`
    );
    first.run(
      `INSERT INTO analysis_tasks (id, work_id, task_type, status, created_at, updated_at)
       VALUES ('task-running', 'work-old', 'book-analysis', 'running', '2025-01-01', '2025-01-01')`
    );
    first.run(
      `INSERT INTO ai_conversations (id, work_id, roleplay_character_id, task_type, context_scope_json, title, created_at, updated_at)
       VALUES ('conversation-chat-old', 'work-old', NULL, NULL, NULL, '旧问答', '2025-01-01', '2025-01-01'),
              ('conversation-roleplay-old', 'work-old', 'character-a', NULL, NULL, '旧角色扮演', '2025-01-01', '2025-01-01')`
    );
    first.run("DELETE FROM schema_migrations WHERE version = 68");
    first.run("DELETE FROM schema_migrations WHERE version = 69");
    first.run("DELETE FROM schema_migrations WHERE version = 70");
    first.close();

    const second = new Database(filename);
    expect(second.get("SELECT COUNT(*) AS count FROM character_names")?.count).toBe(4);
    expect(second.get("SELECT title FROM works WHERE id = 'work-old'")?.title).toBe("旧作品");
    expect(second.get("SELECT COUNT(*) AS count FROM races")?.count).toBe(1);
    expect(second.get("SELECT status FROM ai_calls WHERE id = 'call-running'")?.status).toBe("failed");
    expect(second.get("SELECT status FROM analysis_tasks WHERE id = 'task-running'")?.status).toBe("partial");
    expect(second.all("SELECT id, task_type, context_scope_json FROM ai_conversations ORDER BY id")).toEqual([
      { id: "conversation-chat-old", task_type: "chat", context_scope_json: '{"type":"none"}' },
      { id: "conversation-roleplay-old", task_type: "roleplay", context_scope_json: '{"type":"none"}' }
    ]);
    second.close();
  });

  it("迁移 53 只重排可重建索引并保留领域数据", () => {
    const filename = createLegacyDatabase();
    const current = new Database(filename);
    current.run(
      `INSERT INTO relationship_source_search(work_id, source_type, source_id, source_version, content_hash, updated_at)
       VALUES ('work-old', 'character', 'character-a', '1', 'hash-before', '2025-01-01')`
    );
    current.run("DELETE FROM relationship_source_index_queue WHERE work_id = 'work-old'");
    current.run(
      `INSERT INTO relationship_source_index_state(work_id, status, generation, error, updated_at)
       VALUES ('work-old', 'ready', 4, '', '2025-01-01')
       ON CONFLICT(work_id) DO UPDATE SET status = excluded.status, generation = excluded.generation, updated_at = excluded.updated_at`
    );
    current.run("DELETE FROM schema_migrations WHERE version = 53");
    current.close();

    const migrated = new Database(filename);
    expect(migrated.all(
      "SELECT source_type, source_id FROM relationship_source_index_queue WHERE work_id = 'work-old' ORDER BY source_type, source_id"
    )).toEqual([
      { source_type: "chapter", source_id: "chapter-old" },
      { source_type: "character", source_id: "character-a" }
    ]);
    expect(migrated.get(
      "SELECT source_version, content_hash FROM relationship_source_search WHERE work_id = 'work-old' AND source_type = 'character'"
    )).toEqual({ source_version: "1", content_hash: "hash-before" });
    expect(migrated.get("SELECT status, generation FROM relationship_source_index_state WHERE work_id = 'work-old'"))
      .toEqual({ status: "queued", generation: 4 });
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("历史名称冲突时原子回滚名称索引迁移", () => {
    const filename = createLegacyDatabase(true);
    expect(() => new Database(filename)).toThrow(/重复角色名或别名/u);
    const database = new DatabaseSync(filename);
    expect(database.prepare("SELECT COUNT(*) AS count FROM character_names").get()?.count).toBe(0);
    expect(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 2").get()?.count).toBe(0);
    database.close();
  });

  it("修复迁移编号冲突遗留的作品与分卷版本字段", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-collision-"));
    roots.push(root);
    const filename = join(root, "collision.db");
    const current = new Database(filename);
    current.close();

    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      DELETE FROM schema_migrations WHERE version = 35;
      ALTER TABLE works DROP COLUMN version_no;
      ALTER TABLE volumes DROP COLUMN version_no;
    `);
    legacy.close();

    const repaired = new Database(filename);
    expect(repaired.all("PRAGMA table_info(works)").some((column) => column.name === "version_no")).toBe(true);
    expect(repaired.all("PRAGMA table_info(volumes)").some((column) => column.name === "version_no")).toBe(true);
    expect(repaired.all("PRAGMA table_info(work_memberships)").some((column) => column.name === "permissions_json")).toBe(true);
    expect(repaired.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 35")?.count).toBe(1);
    repaired.close();
  });

  it("迁移 40 将 query_story_knowledge 重命名为 search_story_entities", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-tool-rename-"));
    roots.push(root);
    const filename = join(root, "tool-rename.db");
    const first = new Database(filename);
    const timestamp = "2025-01-01T00:00:00.000Z";
    first.run(
      `INSERT INTO works (id, title, author, description, language, tags_json, created_at, updated_at)
       VALUES ('work-tool', '工具迁移', '', '', 'zh-CN', '[]', ?, ?)`,
      timestamp,
      timestamp
    );
    first.run(
      `INSERT INTO work_ai_settings (work_id, system_prompt, agent_tools_json, updated_at)
       VALUES ('work-tool', '', ?, ?)`,
      JSON.stringify(["story_index", "read_chapters", "query_story_knowledge", "grep", "read_character_sections"]),
      timestamp
    );
    first.run("DELETE FROM schema_migrations WHERE version = 40");
    first.close();

    const second = new Database(filename);
    expect(JSON.parse(String(second.get("SELECT agent_tools_json FROM work_ai_settings WHERE work_id = 'work-tool'")?.agent_tools_json))).toEqual([
      "story_index",
      "read_chapters",
      "search_story_entities",
      "grep",
      "read_character_sections"
    ]);
    expect(second.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 40")?.count).toBe(1);
    second.close();
  });

  it("迁移 55 创建草稿表并为已有作品启用草稿搜索工具", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-drafts-"));
    roots.push(root);
    const filename = join(root, "drafts.db");
    const current = new Database(filename);
    const timestamp = "2026-07-29T00:00:00.000Z";
    current.run(
      `INSERT INTO works (id, title, author, description, language, tags_json, created_at, updated_at)
       VALUES ('work-drafts', '草稿迁移', '', '', 'zh-CN', '[]', ?, ?)`,
      timestamp,
      timestamp
    );
    current.run(
      `INSERT INTO work_ai_settings (work_id, system_prompt, agent_tools_json, updated_at)
       VALUES ('work-drafts', '', ?, ?)`,
      JSON.stringify(["story_index", "grep"]),
      timestamp
    );
    current.run("DELETE FROM schema_migrations WHERE version = 55");
    current.run("DROP TABLE drafts");
    current.close();

    const migrated = new Database(filename);
    expect(migrated.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'drafts'")?.name).toBe("drafts");
    expect(JSON.parse(String(migrated.get("SELECT agent_tools_json FROM work_ai_settings WHERE work_id = 'work-drafts'")?.agent_tools_json))).toEqual([
      "story_index",
      "grep",
      "search_drafts"
    ]);
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("从迁移 40 的历史调用表升级并保留任务追踪索引", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-call-trace-"));
    roots.push(root);
    const filename = join(root, "call-trace.db");
    const current = new Database(filename);
    current.close();

    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      DROP INDEX idx_calls_task;
      DROP TABLE ai_call_traces;
      ALTER TABLE ai_calls DROP COLUMN task_id;
      DELETE FROM schema_migrations WHERE version = 41;
    `);
    legacy.close();

    const migrated = new Database(filename);
    expect(migrated.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 41")?.count).toBe(1);
    expect(migrated.all("PRAGMA table_info(ai_calls)").some((column) => column.name === "task_id")).toBe(true);
    expect(migrated.all("PRAGMA table_info(ai_call_traces)").map((column) => column.name)).toEqual(
      expect.arrayContaining(["call_id", "task_id", "initial_messages_json", "rounds_json", "created_at", "updated_at"])
    );
    expect(migrated.all("PRAGMA index_list(ai_calls)").some((index) => index.name === "idx_calls_task")).toBe(true);
    expect(migrated.all("PRAGMA index_list(ai_call_traces)").some((index) => index.name === "idx_ai_call_traces_task")).toBe(true);
    migrated.close();
  });

  it("为历史任务追踪补充轻量来源标题字段", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-trace-source-refs-"));
    roots.push(root);
    const filename = join(root, "trace-source-refs.db");
    const current = new Database(filename);
    current.close();

    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      ALTER TABLE ai_call_traces DROP COLUMN source_refs_json;
      DELETE FROM schema_migrations WHERE version = 43;
    `);
    legacy.close();

    const migrated = new Database(filename);
    expect(migrated.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 43")?.count).toBe(1);
    const sourceRefsColumn = migrated.all("PRAGMA table_info(ai_call_traces)")
      .find((column) => column.name === "source_refs_json");
    expect(sourceRefsColumn).toMatchObject({ notnull: 1, dflt_value: "'[]'" });
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("为历史分析任务补充可选模型并保留原任务", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-task-model-"));
    roots.push(root);
    const filename = join(root, "task-model.db");
    const current = new Database(filename);
    const timestamp = "2025-01-01T00:00:00.000Z";
    current.run(
      `INSERT INTO works (id, title, author, description, language, tags_json, created_at, updated_at)
       VALUES ('work-task-model', '任务模型迁移', '', '', 'zh-CN', '[]', ?, ?)`,
      timestamp,
      timestamp
    );
    current.run(
      `INSERT INTO analysis_tasks (id, work_id, task_type, status, created_at, updated_at)
       VALUES ('task-before-model', 'work-task-model', 'book-analysis', 'pending', ?, ?)`,
      timestamp,
      timestamp
    );
    current.close();

    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      DROP INDEX idx_tasks_model;
      ALTER TABLE analysis_tasks DROP COLUMN model_id;
      DELETE FROM schema_migrations WHERE version = 44;
    `);
    legacy.close();

    const migrated = new Database(filename);
    expect(migrated.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 44")?.count).toBe(1);
    expect(migrated.get("SELECT id, model_id FROM analysis_tasks WHERE id = 'task-before-model'")).toEqual({
      id: "task-before-model",
      model_id: null
    });
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("为历史供应商补充 OpenAI 默认协议并保留配置", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-provider-protocol-"));
    roots.push(root);
    const filename = join(root, "provider-protocol.db");
    const current = new Database(filename);
    const timestamp = "2025-01-01T00:00:00.000Z";
    current.run(
      `INSERT INTO providers (
        id, work_id, name, base_url, encrypted_key, key_iv, key_tag, key_hint, status, created_at, updated_at
      ) VALUES (
        'provider-before-protocol', '__scriverse_platform_ai__', '历史供应商', 'https://legacy-provider.test/v1',
        'encrypted', 'iv', 'tag', '***', 'disabled', ?, ?
      )`,
      timestamp,
      timestamp
    );
    current.close();

    const legacy = new DatabaseSync(filename);
    legacy.exec(`
      ALTER TABLE providers DROP COLUMN protocol;
      DELETE FROM schema_migrations WHERE version = 47;
    `);
    legacy.close();

    const migrated = new Database(filename);
    expect(migrated.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 47")?.count).toBe(1);
    expect(migrated.get("SELECT id, protocol FROM providers WHERE id = 'provider-before-protocol'")).toEqual({
      id: "provider-before-protocol",
      protocol: "openai-chat-completions"
    });
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("建立可重建的关系来源拼音索引并只回填待构建队列", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-relationship-search-"));
    roots.push(root);
    const filename = join(root, "relationship-search.db");
    const database = new Database(filename);

    expect(database.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 45")?.count).toBe(1);
    expect(database.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 46")?.count).toBe(1);
    expect(database.all("PRAGMA table_info(review_items)").some((column) => column.name === "dedupe_key")).toBe(true);
    expect(database.get("SELECT sql FROM sqlite_master WHERE name = 'chapter_paragraph_pinyin_fts'")?.sql)
      .toContain("contentless_delete=1");
    expect(database.get("SELECT sql FROM sqlite_master WHERE name = 'relationship_source_pinyin_fts'")?.sql)
      .toContain("content=''");
    expect(database.all("PRAGMA table_info(relationship_source_search)").map((column) => column.name))
      .not.toContain("pinyin_content");
    expect(database.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(database.all("PRAGMA foreign_key_check")).toEqual([]);
    database.close();

    const schema45 = new Database(filename);
    schema45.run("DELETE FROM schema_migrations WHERE version = 46");
    schema45.raw.exec(`
      DROP TRIGGER relationship_index_volume_dependencies_au;
      CREATE TRIGGER relationship_index_volume_dependencies_au AFTER UPDATE ON volumes BEGIN
        INSERT INTO relationship_source_index_queue(work_id, source_type, source_id, queued_at)
        SELECT chapter.work_id, 'chapter-outline', chapter.id, datetime('now')
        FROM chapters chapter JOIN chapter_outlines outline ON outline.chapter_id = chapter.id
        WHERE chapter.volume_id = new.id
        ON CONFLICT(work_id, source_type, source_id) DO UPDATE SET queued_at = excluded.queued_at;
      END;
    `);
    schema45.close();
    const migrated = new Database(filename);
    expect(migrated.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 46")?.count).toBe(1);
    expect(String(migrated.get("SELECT sql FROM sqlite_master WHERE name = 'relationship_index_volume_dependencies_au'")?.sql))
      .toContain("foreshadow_occurrences");
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.close();
  });

  it("迁移 66 扩大 providers.protocol CHECK 并保留已有供应商与模型", () => {
    const root = mkdtempSync(join(tmpdir(), "ai-novel-migration-vertex-protocol-"));
    roots.push(root);
    const filename = join(root, "provider-vertex-protocol.db");
    const current = new Database(filename);
    const timestamp = "2025-01-01T00:00:00.000Z";
    current.run(
      `INSERT INTO providers (
        id, work_id, name, base_url, protocol, encrypted_key, key_iv, key_tag, key_hint, status, created_at, updated_at
      ) VALUES (
        'provider-before-vertex', '__scriverse_platform_ai__', '历史供应商', 'https://legacy-provider.test/v1',
        'openai-chat-completions', 'encrypted', 'iv', 'tag', '***', 'disabled', ?, ?
      )`,
      timestamp,
      timestamp
    );
    current.run(
      `INSERT INTO models (
        id, provider_id, display_name, model_id, purposes_json, context_note, context_window, output_note,
        preset_json, thinking_enabled, enabled, note, created_at, updated_at
      ) VALUES (
        'model-before-vertex', 'provider-before-vertex', '历史模型', 'legacy-model', '[]', '', 128000, '',
        '{}', 1, 1, '', ?, ?
      )`,
      timestamp,
      timestamp
    );
    current.close();

    const legacy = new DatabaseSync(filename);
    legacy.exec("DELETE FROM schema_migrations WHERE version = 66");
    legacy.close();

    const migrated = new Database(filename);
    expect(migrated.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 66")?.count).toBe(1);
    expect(migrated.get("SELECT id, protocol FROM providers WHERE id = 'provider-before-vertex'")).toEqual({
      id: "provider-before-vertex",
      protocol: "openai-chat-completions"
    });
    expect(migrated.get("SELECT id FROM models WHERE id = 'model-before-vertex'")?.id).toBe("model-before-vertex");
    migrated.run(
      `INSERT INTO providers (
        id, work_id, name, base_url, protocol, encrypted_key, key_iv, key_tag, key_hint, status, created_at, updated_at
      ) VALUES (
        'provider-vertex', '__scriverse_platform_ai__', 'Vertex', 'https://aiplatform.googleapis.com/v1/projects/demo/locations/global/endpoints/openapi',
        'google-vertex', 'encrypted', 'iv', 'tag', 'sa:bot@demo.iam.gserviceaccount.com', 'disabled', ?, ?
      )`,
      timestamp,
      timestamp
    );
    expect(migrated.get("SELECT protocol FROM providers WHERE id = 'provider-vertex'")?.protocol).toBe("google-vertex");
    expect(migrated.all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
    expect(migrated.all("PRAGMA foreign_key_check")).toEqual([]);
    migrated.close();
  });
});
