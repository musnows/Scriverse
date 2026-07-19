import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { logger, sanitizeError } from "./logger.js";

export type Row = Record<string, unknown>;
export const PLATFORM_AI_WORK_ID = "__scriverse_platform_ai__";

export class Database {
  readonly raw: DatabaseSync;

  constructor(filename: string) {
    logger.info("database.opening", { databasePath: filename, inMemory: filename === ":memory:" });
    try {
      if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
      this.raw = new DatabaseSync(filename);
      this.raw.exec("PRAGMA foreign_keys = ON");
      this.raw.exec("PRAGMA busy_timeout = 5000");
      if (filename !== ":memory:") this.raw.exec("PRAGMA journal_mode = WAL");
      this.migrate();
      this.recoverInterruptedOperations();
      const migration = this.get<{ version: number }>("SELECT MAX(version) AS version FROM schema_migrations");
      logger.info("database.ready", { inMemory: filename === ":memory:", schemaVersion: Number(migration?.version ?? 0) });
    } catch (error) {
      logger.error("database.open_failed", { databasePath: filename, error: sanitizeError(error) });
      throw error;
    }
  }

  close(): void {
    logger.info("database.closing");
    this.raw.close();
    logger.info("database.closed");
  }

  run(sql: string, ...params: SQLInputValue[]): { changes: number; lastInsertRowid: number | bigint } {
    const result = this.raw.prepare(sql).run(...params);
    return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
  }

  get<T extends Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  all<T extends Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  transaction<T>(operation: () => T): T {
    if (this.raw.isTransaction) return operation();
    const startedAt = process.hrtime.bigint();
    logger.debug("database.transaction.started");
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.raw.exec("COMMIT");
      logger.debug("database.transaction.committed", { durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000 });
      return result;
    } catch (error) {
      this.raw.exec("ROLLBACK");
      logger.warn("database.transaction.rolled_back", {
        durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
        error: sanitizeError(error)
      });
      throw error;
    }
  }

  private migrate(): void {
    this.raw.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS works (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        author TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        language TEXT NOT NULL DEFAULT 'zh-CN',
        cover_url TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        is_internal INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS file_versions (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        file_name TEXT NOT NULL,
        file_type TEXT NOT NULL,
        word_count INTEGER NOT NULL,
        paragraph_count INTEGER NOT NULL,
        warnings_json TEXT NOT NULL DEFAULT '[]',
        snapshot_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS volumes (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'main',
        source TEXT NOT NULL DEFAULT 'manual',
        description TEXT NOT NULL DEFAULT '',
        keywords_json TEXT NOT NULL DEFAULT '[]',
        sort_order INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chapters (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        volume_id TEXT NOT NULL REFERENCES volumes(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        content TEXT NOT NULL DEFAULT '',
        chapter_type TEXT NOT NULL DEFAULT '正文' CHECK(chapter_type IN ('正文', '设定', '作者的话', '其他')),
        sort_order INTEGER NOT NULL,
        word_count INTEGER NOT NULL DEFAULT 0,
        version_no INTEGER NOT NULL DEFAULT 1,
        analysis_status TEXT NOT NULL DEFAULT 'pending',
        excluded_from_analysis INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chapter_versions (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        chapter_id TEXT NOT NULL,
        version_no INTEGER NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        volume_id TEXT,
        sort_order INTEGER,
        chapter_type TEXT,
        source TEXT NOT NULL DEFAULT 'manual',
        source_ref TEXT,
        change_note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        created_by_user_id TEXT,
        UNIQUE(chapter_id, version_no)
      );

      CREATE TABLE IF NOT EXISTS chapter_insights (
        id TEXT PRIMARY KEY,
        chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        chapter_version INTEGER NOT NULL,
        summary TEXT NOT NULL,
        events_json TEXT NOT NULL DEFAULT '[]',
        characters_json TEXT NOT NULL DEFAULT '[]',
        settings_json TEXT NOT NULL DEFAULT '[]',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        uncertainties_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'review',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'draft',
        locked INTEGER NOT NULL DEFAULT 0,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        scope_json TEXT NOT NULL DEFAULT '{}',
        author_note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS races (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        settings_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(work_id, normalized_name)
      );

      CREATE TABLE IF NOT EXISTS characters (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        aliases_json TEXT NOT NULL DEFAULT '[]',
        species TEXT NOT NULL DEFAULT '',
        race_id TEXT REFERENCES races(id) ON DELETE SET NULL,
        attributes_json TEXT NOT NULL DEFAULT '{}',
        profile_json TEXT NOT NULL DEFAULT '{}',
        current_state_json TEXT NOT NULL DEFAULT '{}',
        locked_fields_json TEXT NOT NULL DEFAULT '[]',
        visibility TEXT NOT NULL DEFAULT 'author',
        first_chapter_id TEXT REFERENCES chapters(id) ON DELETE SET NULL,
        version_no INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS character_versions (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        character_id TEXT NOT NULL,
        version_no INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'manual',
        source_ref TEXT,
        change_note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        created_by_user_id TEXT,
        UNIQUE(character_id, version_no)
      );

      CREATE TABLE IF NOT EXISTS entity_versions (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        version_no INTEGER NOT NULL,
        snapshot_json TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'manual',
        source_ref TEXT,
        change_note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        UNIQUE(entity_type, entity_id, version_no)
      );

      CREATE TABLE IF NOT EXISTS timeline_tracks (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(work_id, name)
      );

      CREATE TABLE IF NOT EXISTS timeline_events (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        track_id TEXT REFERENCES timeline_tracks(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        event_type TEXT NOT NULL DEFAULT 'other',
        time_label TEXT NOT NULL DEFAULT '时间待定',
        time_sort REAL,
        chapter_ids_json TEXT NOT NULL DEFAULT '[]',
        participant_ids_json TEXT NOT NULL DEFAULT '[]',
        location TEXT NOT NULL DEFAULT '',
        causes_json TEXT NOT NULL DEFAULT '[]',
        impact_scope TEXT NOT NULL DEFAULT 'personal',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'candidate',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS relationships (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        from_character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        to_character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        category TEXT NOT NULL,
        subtype TEXT NOT NULL DEFAULT '',
        keywords_json TEXT NOT NULL DEFAULT '[]',
        directed INTEGER NOT NULL DEFAULT 0,
        current_status TEXT NOT NULL DEFAULT 'active',
        time_range_json TEXT NOT NULL DEFAULT '{}',
        confidence REAL NOT NULL DEFAULT 0.5,
        evidence_json TEXT NOT NULL DEFAULT '[]',
        confirmation_status TEXT NOT NULL DEFAULT 'pending',
        locked INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK(from_character_id <> to_character_id)
      );

      CREATE TABLE IF NOT EXISTS review_items (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        item_type TEXT NOT NULL,
        severity TEXT NOT NULL DEFAULT 'medium',
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        entity_refs_json TEXT NOT NULL DEFAULT '[]',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        suggestion TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'pending',
        resolution_note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS providers (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        encrypted_key TEXT NOT NULL,
        key_iv TEXT NOT NULL,
        key_tag TEXT NOT NULL,
        key_hint TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'disabled',
        connection_status TEXT NOT NULL DEFAULT 'unchecked',
        concurrency_limit INTEGER NOT NULL DEFAULT 10 CHECK(concurrency_limit BETWEEN 1 AND 100),
        rpm_limit INTEGER NOT NULL DEFAULT 10 CHECK(rpm_limit BETWEEN 1 AND 10000),
        max_tokens INTEGER NOT NULL DEFAULT 32000 CHECK(max_tokens BETWEEN 1 AND 32768),
        default_model_id TEXT,
        note TEXT NOT NULL DEFAULT '',
        last_error TEXT,
        last_success_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS models (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
        display_name TEXT NOT NULL,
        model_id TEXT NOT NULL,
        purposes_json TEXT NOT NULL DEFAULT '[]',
        context_note TEXT NOT NULL DEFAULT '',
        context_window INTEGER NOT NULL DEFAULT 128000 CHECK(context_window BETWEEN 1024 AND 2000000),
        output_note TEXT NOT NULL DEFAULT '',
        preset_json TEXT NOT NULL DEFAULT '{}',
        thinking_enabled INTEGER NOT NULL DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 1,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(provider_id, model_id)
      );

      CREATE TABLE IF NOT EXISTS task_defaults (
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        task_type TEXT NOT NULL,
        model_id TEXT NOT NULL REFERENCES models(id) ON DELETE CASCADE,
        PRIMARY KEY(work_id, task_type)
      );

      CREATE TABLE IF NOT EXISTS platform_ai_settings (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        system_prompt TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS platform_ui_settings (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        toast_position TEXT NOT NULL DEFAULT 'bottom-right' CHECK(toast_position IN ('bottom-right', 'top-right')),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS work_ai_settings (
        work_id TEXT PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
        system_prompt TEXT NOT NULL DEFAULT '',
        auto_run_enabled INTEGER NOT NULL DEFAULT 0,
        auto_run_concurrency INTEGER NOT NULL DEFAULT 2,
        auto_run_batch_limit INTEGER NOT NULL DEFAULT 20,
        book_summary_context_percent INTEGER NOT NULL DEFAULT 50 CHECK(book_summary_context_percent BETWEEN 1 AND 90),
        context_compact_threshold INTEGER NOT NULL DEFAULT 85 CHECK(context_compact_threshold BETWEEN 50 AND 90),
        agent_tools_json TEXT NOT NULL DEFAULT '["story_index","read_chapters","query_story_knowledge"]',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ai_calls (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        task_type TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        model_id TEXT NOT NULL,
        context_scope_json TEXT NOT NULL,
        parameters_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL,
        failure TEXT,
        input_chars INTEGER NOT NULL DEFAULT 0,
        output_chars INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        completed_at TEXT
      );

      CREATE TABLE IF NOT EXISTS ai_suggestions (
        id TEXT PRIMARY KEY,
        call_id TEXT NOT NULL REFERENCES ai_calls(id) ON DELETE CASCADE,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        chapter_id TEXT REFERENCES chapters(id) ON DELETE SET NULL,
        chapter_version INTEGER,
        task_type TEXT NOT NULL,
        instruction TEXT NOT NULL,
        source_text TEXT NOT NULL DEFAULT '',
        content TEXT NOT NULL,
        action TEXT NOT NULL DEFAULT 'note',
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        decided_at TEXT
      );

      CREATE TABLE IF NOT EXISTS ai_conversations (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        title TEXT NOT NULL DEFAULT '新对话',
        compacted_summary TEXT NOT NULL DEFAULT '',
        compacted_message_count INTEGER NOT NULL DEFAULT 0,
        context_warning_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ai_conversation_messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        citations_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS analysis_tasks (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        task_type TEXT NOT NULL,
        scope_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending',
        progress INTEGER NOT NULL DEFAULT 0,
        result_json TEXT NOT NULL DEFAULT '{}',
        failure_json TEXT NOT NULL DEFAULT '[]',
        source_versions_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        work_id TEXT REFERENCES works(id) ON DELETE CASCADE,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT,
        actor TEXT NOT NULL DEFAULT 'owner',
        detail_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS work_covers (
        work_id TEXT PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
        mime_type TEXT NOT NULL CHECK(mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
        content BLOB NOT NULL,
        byte_length INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS character_names (
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        normalized_name TEXT NOT NULL,
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        display_name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('primary', 'alias')),
        sort_order INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(work_id, normalized_name)
      );

      CREATE TABLE IF NOT EXISTS organizations (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        normalized_name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        settings_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(work_id, normalized_name)
      );

      CREATE TABLE IF NOT EXISTS character_organization_memberships (
        character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
        organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
        role TEXT NOT NULL DEFAULT '',
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(character_id, organization_id)
      );

      CREATE TABLE IF NOT EXISTS chapter_outlines (
        chapter_id TEXT PRIMARY KEY REFERENCES chapters(id) ON DELETE CASCADE,
        goal TEXT NOT NULL DEFAULT '',
        conflict TEXT NOT NULL DEFAULT '',
        turning_point TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'ready', 'completed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS foreshadows (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned', 'planted', 'resolved', 'abandoned')),
        importance TEXT NOT NULL DEFAULT 'medium' CHECK(importance IN ('low', 'medium', 'high')),
        planned_payoff_chapter_id TEXT REFERENCES chapters(id) ON DELETE SET NULL,
        resolution_note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS foreshadow_occurrences (
        id TEXT PRIMARY KEY,
        foreshadow_id TEXT NOT NULL REFERENCES foreshadows(id) ON DELETE CASCADE,
        chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('setup', 'reminder', 'payoff')),
        note TEXT NOT NULL DEFAULT '',
        evidence_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(foreshadow_id, chapter_id, role)
      );

      CREATE TABLE IF NOT EXISTS continuation_guard_runs (
        id TEXT PRIMARY KEY,
        suggestion_id TEXT NOT NULL REFERENCES ai_suggestions(id) ON DELETE CASCADE,
        call_id TEXT REFERENCES ai_calls(id) ON DELETE SET NULL,
        chapter_version INTEGER NOT NULL,
        content_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('clear', 'warning', 'failed')),
        issues_json TEXT NOT NULL DEFAULT '[]',
        context_refs_json TEXT NOT NULL DEFAULT '{}',
        failure TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_volumes_work ON volumes(work_id, sort_order);
      CREATE INDEX IF NOT EXISTS idx_chapters_work ON chapters(work_id, volume_id, sort_order);
      CREATE INDEX IF NOT EXISTS idx_versions_chapter ON chapter_versions(chapter_id, version_no DESC);
      CREATE INDEX IF NOT EXISTS idx_settings_work ON settings(work_id, category);
      CREATE INDEX IF NOT EXISTS idx_characters_work ON characters(work_id, name);
      CREATE INDEX IF NOT EXISTS idx_events_work ON timeline_events(work_id, time_sort);
      CREATE INDEX IF NOT EXISTS idx_timeline_tracks_work ON timeline_tracks(work_id, sort_order);
      CREATE INDEX IF NOT EXISTS idx_relationships_work ON relationships(work_id);
      CREATE INDEX IF NOT EXISTS idx_reviews_work ON review_items(work_id, status);
      CREATE INDEX IF NOT EXISTS idx_tasks_work ON analysis_tasks(work_id, status);
      CREATE INDEX IF NOT EXISTS idx_calls_work ON ai_calls(work_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ai_conversations_work ON ai_conversations(work_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ai_conversation_messages ON ai_conversation_messages(conversation_id, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_character_names_primary ON character_names(character_id) WHERE kind = 'primary';
      CREATE INDEX IF NOT EXISTS idx_character_names_character ON character_names(character_id, sort_order);
      CREATE INDEX IF NOT EXISTS idx_character_versions_character ON character_versions(character_id, version_no DESC);
      CREATE INDEX IF NOT EXISTS idx_entity_versions_entity ON entity_versions(entity_type, entity_id, version_no DESC);
      CREATE INDEX IF NOT EXISTS idx_entity_versions_work ON entity_versions(work_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_races_work ON races(work_id, name);
      CREATE INDEX IF NOT EXISTS idx_organizations_work ON organizations(work_id, name);
      CREATE INDEX IF NOT EXISTS idx_memberships_organization ON character_organization_memberships(organization_id, character_id);
      CREATE INDEX IF NOT EXISTS idx_foreshadows_work ON foreshadows(work_id, status, importance);
      CREATE INDEX IF NOT EXISTS idx_foreshadow_occurrences_chapter ON foreshadow_occurrences(chapter_id, role);
      CREATE INDEX IF NOT EXISTS idx_continuation_guards_suggestion ON continuation_guard_runs(suggestion_id, created_at DESC);
    `);
    this.applyDataMigrations();
  }

  private applyDataMigrations(): void {
    const applied = new Set(this.all<{ version: number }>("SELECT version FROM schema_migrations").map((row) => Number(row.version)));
    if (!applied.has(1)) {
      this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)", new Date().toISOString());
    }
    if (!applied.has(2)) {
      this.transaction(() => {
        this.run("DELETE FROM character_names");
        const characters = this.all<{ id: string; work_id: string; name: string; aliases_json: string }>(
          "SELECT id, work_id, name, aliases_json FROM characters ORDER BY created_at, id"
        );
        for (const character of characters) {
          const aliases = this.parseAliases(character.aliases_json);
          const names = [
            { displayName: character.name, kind: "primary", sortOrder: 0 },
            ...aliases.map((displayName, index) => ({ displayName, kind: "alias", sortOrder: index + 1 }))
          ];
          const localNames = new Set<string>();
          for (const name of names) {
            const normalizedName = this.normalizeCharacterName(name.displayName);
            if (!normalizedName) throw new Error(`角色 ${character.id} 存在空名称，无法完成名称索引迁移`);
            if (localNames.has(normalizedName)) throw new Error(`角色 ${character.id} 的名称或别名重复：${name.displayName}`);
            localNames.add(normalizedName);
            try {
              this.run(
                `INSERT INTO character_names (work_id, normalized_name, character_id, display_name, kind, sort_order)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                character.work_id,
                normalizedName,
                character.id,
                name.displayName.trim(),
                name.kind,
                name.sortOrder
              );
            } catch {
              throw new Error(`作品 ${character.work_id} 存在重复角色名或别名：${name.displayName}`);
            }
          }
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (2, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(3)) {
      this.transaction(() => {
        const relationshipColumns = new Set(this.all("PRAGMA table_info(relationships)").map((row) => String(row.name)));
        if (!relationshipColumns.has("keywords_json")) {
          this.run("ALTER TABLE relationships ADD COLUMN keywords_json TEXT NOT NULL DEFAULT '[]'");
        }
        const providerColumns = new Set(this.all("PRAGMA table_info(providers)").map((row) => String(row.name)));
        if (!providerColumns.has("concurrency_limit")) {
          this.run("ALTER TABLE providers ADD COLUMN concurrency_limit INTEGER NOT NULL DEFAULT 10 CHECK(concurrency_limit BETWEEN 1 AND 100)");
        }
        if (!providerColumns.has("rpm_limit")) {
          this.run("ALTER TABLE providers ADD COLUMN rpm_limit INTEGER NOT NULL DEFAULT 10 CHECK(rpm_limit BETWEEN 1 AND 10000)");
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (3, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(4)) {
      this.transaction(() => {
        const chapterColumns = new Set(this.all("PRAGMA table_info(chapters)").map((row) => String(row.name)));
        if (!chapterColumns.has("chapter_type")) {
          this.run("ALTER TABLE chapters ADD COLUMN chapter_type TEXT NOT NULL DEFAULT '正文' CHECK(chapter_type IN ('正文', '设定', '作者的话', '其他'))");
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (4, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(5)) {
      this.transaction(() => {
        const providerColumns = new Set(this.all("PRAGMA table_info(providers)").map((row) => String(row.name)));
        if (!providerColumns.has("max_tokens")) {
          this.run("ALTER TABLE providers ADD COLUMN max_tokens INTEGER NOT NULL DEFAULT 32000 CHECK(max_tokens BETWEEN 1 AND 32768)");
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (5, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(6)) {
      this.transaction(() => {
        this.run(`CREATE TABLE IF NOT EXISTS timeline_tracks (
          id TEXT PRIMARY KEY,
          work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(work_id, name)
        )`);
        const eventColumns = new Set(this.all("PRAGMA table_info(timeline_events)").map((row) => String(row.name)));
        if (!eventColumns.has("track_id")) {
          this.run("ALTER TABLE timeline_events ADD COLUMN track_id TEXT REFERENCES timeline_tracks(id) ON DELETE SET NULL");
        }
        this.run("CREATE INDEX IF NOT EXISTS idx_timeline_tracks_work ON timeline_tracks(work_id, sort_order)");
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (6, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(7)) {
      this.transaction(() => {
        const volumeColumns = new Set(this.all("PRAGMA table_info(volumes)").map((row) => String(row.name)));
        if (!volumeColumns.has("description")) {
          this.run("ALTER TABLE volumes ADD COLUMN description TEXT NOT NULL DEFAULT ''");
        }
        if (!volumeColumns.has("keywords_json")) {
          this.run("ALTER TABLE volumes ADD COLUMN keywords_json TEXT NOT NULL DEFAULT '[]'");
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (7, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(8)) {
      this.transaction(() => {
        const timestamp = new Date().toISOString();
        const workColumns = new Set(this.all("PRAGMA table_info(works)").map((row) => String(row.name)));
        if (!workColumns.has("is_internal")) {
          this.run("ALTER TABLE works ADD COLUMN is_internal INTEGER NOT NULL DEFAULT 0");
        }
        const modelColumns = new Set(this.all("PRAGMA table_info(models)").map((row) => String(row.name)));
        if (!modelColumns.has("context_window")) {
          this.run("ALTER TABLE models ADD COLUMN context_window INTEGER NOT NULL DEFAULT 128000 CHECK(context_window BETWEEN 1024 AND 2000000)");
        }
        this.run(`CREATE TABLE IF NOT EXISTS platform_ai_settings (
          id INTEGER PRIMARY KEY CHECK(id = 1),
          system_prompt TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL
        )`);
        this.run(`CREATE TABLE IF NOT EXISTS work_ai_settings (
          work_id TEXT PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
          system_prompt TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL
        )`);
        this.run(
          `INSERT INTO works (id, title, author, description, language, cover_url, tags_json, is_internal, created_at, updated_at)
           VALUES (?, '平台 AI 配置', '', '', 'zh-CN', NULL, '[]', 1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET is_internal = 1`,
          PLATFORM_AI_WORK_ID,
          timestamp,
          timestamp
        );
        this.run(
          "INSERT INTO platform_ai_settings (id, system_prompt, updated_at) VALUES (1, '', ?) ON CONFLICT(id) DO NOTHING",
          timestamp
        );
        this.run("UPDATE providers SET work_id = ? WHERE work_id <> ?", PLATFORM_AI_WORK_ID, PLATFORM_AI_WORK_ID);
        this.run("CREATE INDEX IF NOT EXISTS idx_work_ai_settings_work ON work_ai_settings(work_id)");
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (8, ?)", timestamp);
      });
    }
    if (!applied.has(9)) {
      this.transaction(() => {
        const messageColumns = new Set(this.all("PRAGMA table_info(ai_conversation_messages)").map((row) => String(row.name)));
        if (!messageColumns.has("metadata_json")) {
          this.run("ALTER TABLE ai_conversation_messages ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'");
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (9, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(10)) {
      this.transaction(() => {
        const characterColumns = new Set(this.all("PRAGMA table_info(characters)").map((row) => String(row.name)));
        if (!characterColumns.has("species")) {
          this.run("ALTER TABLE characters ADD COLUMN species TEXT NOT NULL DEFAULT ''");
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (10, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(11)) {
      this.transaction(() => {
        const characters = this.all<{ id: string; species: string; attributes_json: string }>(
          "SELECT id, species, attributes_json FROM characters WHERE species = ''"
        );
        for (const character of characters) {
          try {
            const attributes = JSON.parse(character.attributes_json) as Record<string, unknown>;
            if (typeof attributes.species === "string" && attributes.species.trim()) {
              this.run("UPDATE characters SET species = ? WHERE id = ?", attributes.species.trim(), character.id);
            }
          } catch {
            // 无效的旧扩展属性保持原样，避免迁移阻断数据库启动。
          }
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (11, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(12)) {
      this.transaction(() => {
        const characterColumns = new Set(this.all("PRAGMA table_info(characters)").map((row) => String(row.name)));
        if (!characterColumns.has("version_no")) {
          this.run("ALTER TABLE characters ADD COLUMN version_no INTEGER NOT NULL DEFAULT 1");
        }
        this.run(`CREATE TABLE IF NOT EXISTS character_versions (
          id TEXT PRIMARY KEY,
          character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
          version_no INTEGER NOT NULL,
          snapshot_json TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'manual',
          source_ref TEXT,
          change_note TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          UNIQUE(character_id, version_no)
        )`);
        this.run("CREATE INDEX IF NOT EXISTS idx_character_versions_character ON character_versions(character_id, version_no DESC)");
        const characterVersionColumns = new Set(this.all("PRAGMA table_info(character_versions)").map((row) => String(row.name)));
        const characters = this.all<Record<string, unknown>>("SELECT * FROM characters ORDER BY created_at, id");
        for (const character of characters) {
          const characterId = String(character.id);
          const organizationIds = this.all<{ organization_id: string }>(
            "SELECT organization_id FROM character_organization_memberships WHERE character_id = ? ORDER BY organization_id",
            characterId
          ).map((membership) => membership.organization_id);
          const parseJson = (value: unknown, fallback: unknown): unknown => {
            try {
              return JSON.parse(String(value));
            } catch {
              return fallback;
            }
          };
          const snapshot = {
            name: String(character.name),
            aliases: parseJson(character.aliases_json, []),
            species: String(character.species ?? ""),
            organizationIds,
            attributes: parseJson(character.attributes_json, {}),
            profile: parseJson(character.profile_json, {}),
            currentState: parseJson(character.current_state_json, {}),
            lockedFields: parseJson(character.locked_fields_json, []),
            visibility: String(character.visibility),
            firstChapterId: character.first_chapter_id === null ? null : String(character.first_chapter_id)
          };
          this.run(
            characterVersionColumns.has("work_id")
              ? `INSERT INTO character_versions (id, work_id, character_id, version_no, snapshot_json, source, change_note, created_at)
                 VALUES (?, ?, ?, 1, ?, 'migration', '建立人物版本基线', ?)
                 ON CONFLICT(character_id, version_no) DO NOTHING`
              : `INSERT INTO character_versions (id, character_id, version_no, snapshot_json, source, change_note, created_at)
                 VALUES (?, ?, 1, ?, 'migration', '建立人物版本基线', ?)
                 ON CONFLICT(character_id, version_no) DO NOTHING`,
            ...(characterVersionColumns.has("work_id")
              ? [`characterVersion_migration_${characterId}`, String(character.work_id), characterId, JSON.stringify(snapshot), String(character.updated_at)]
              : [`characterVersion_migration_${characterId}`, characterId, JSON.stringify(snapshot), String(character.updated_at)])
          );
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (12, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(13)) {
      this.transaction(() => {
        this.run(`CREATE TABLE IF NOT EXISTS races (
          id TEXT PRIMARY KEY,
          work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          normalized_name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          settings_json TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(work_id, normalized_name)
        )`);
        this.run("CREATE INDEX IF NOT EXISTS idx_races_work ON races(work_id, name)");
        const characterColumns = new Set(this.all("PRAGMA table_info(characters)").map((row) => String(row.name)));
        if (!characterColumns.has("race_id")) {
          this.run("ALTER TABLE characters ADD COLUMN race_id TEXT REFERENCES races(id) ON DELETE SET NULL");
        }
        const legacySpecies = this.all<{ work_id: string; species: string; created_at: string; updated_at: string }>(
          `SELECT work_id, species, MIN(created_at) AS created_at, MAX(updated_at) AS updated_at
           FROM characters WHERE TRIM(species) <> '' GROUP BY work_id, species ORDER BY work_id, species`
        );
        const raceByWorkAndName = new Map<string, string>();
        let migrationIndex = 0;
        for (const legacy of legacySpecies) {
          const name = legacy.species.normalize("NFKC").trim().replace(/\s+/gu, " ");
          const normalizedName = name.toLocaleLowerCase("zh-CN");
          const key = `${legacy.work_id}\u0000${normalizedName}`;
          let raceId = raceByWorkAndName.get(key);
          if (!raceId) {
            const existing = this.get<{ id: string }>("SELECT id FROM races WHERE work_id = ? AND normalized_name = ?", legacy.work_id, normalizedName);
            raceId = existing?.id ?? `race_migration_${++migrationIndex}`;
            if (!existing) {
              this.run(
                `INSERT INTO races (id, work_id, name, normalized_name, description, settings_json, created_at, updated_at)
                 VALUES (?, ?, ?, ?, '由旧人物种族字段迁移生成', '[]', ?, ?)`,
                raceId,
                legacy.work_id,
                name,
                normalizedName,
                legacy.created_at,
                legacy.updated_at
              );
            }
            raceByWorkAndName.set(key, raceId);
          }
          this.run("UPDATE characters SET race_id = ?, species = ? WHERE work_id = ? AND species = ?", raceId, name, legacy.work_id, legacy.species);
        }
        const versions = this.all<{ id: string; work_id: string; snapshot_json: string }>(
          `SELECT cv.id, c.work_id, cv.snapshot_json FROM character_versions cv
           JOIN characters c ON c.id = cv.character_id`
        );
        for (const version of versions) {
          try {
            const snapshot = JSON.parse(version.snapshot_json) as Record<string, unknown>;
            const species = typeof snapshot.species === "string" ? snapshot.species.normalize("NFKC").trim().replace(/\s+/gu, " ") : "";
            if (!species) {
              snapshot.raceId = null;
            } else {
              const normalizedName = species.toLocaleLowerCase("zh-CN");
              const race = this.get<{ id: string }>("SELECT id FROM races WHERE work_id = ? AND normalized_name = ?", version.work_id, normalizedName);
              snapshot.raceId = race?.id ?? null;
            }
            this.run("UPDATE character_versions SET snapshot_json = ? WHERE id = ?", JSON.stringify(snapshot), version.id);
          } catch {
            // 无效历史快照保持原样，避免阻断数据库迁移。
          }
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (13, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(14)) {
      this.transaction(() => {
        this.run(`CREATE TABLE IF NOT EXISTS entity_versions (
          id TEXT PRIMARY KEY,
          work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          version_no INTEGER NOT NULL,
          snapshot_json TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'manual',
          source_ref TEXT,
          change_note TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          UNIQUE(entity_type, entity_id, version_no)
        )`);
        this.run("CREATE INDEX IF NOT EXISTS idx_entity_versions_entity ON entity_versions(entity_type, entity_id, version_no DESC)");
        this.run("CREATE INDEX IF NOT EXISTS idx_entity_versions_work ON entity_versions(work_id, created_at DESC)");
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (14, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(15)) {
      this.transaction(() => {
        this.run(`CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL,
          normalized_username TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          password_salt TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('admin', 'user')),
          status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'disabled')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_login_at TEXT
        )`);
        this.run(`CREATE TABLE IF NOT EXISTS user_sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          csrf_token TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          revoked_at TEXT
        )`);
        const workColumns = new Set(this.all("PRAGMA table_info(works)").map((row) => String(row.name)));
        if (!workColumns.has("owner_user_id")) {
          this.run("ALTER TABLE works ADD COLUMN owner_user_id TEXT REFERENCES users(id) ON DELETE SET NULL");
        }
        this.run(`CREATE TABLE IF NOT EXISTS work_memberships (
          work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK(role IN ('owner', 'editor')),
          invited_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY(work_id, user_id)
        )`);
        const actorColumns: Array<[string, string]> = [
          ["file_versions", "created_by_user_id"],
          ["chapter_versions", "created_by_user_id"],
          ["character_versions", "created_by_user_id"],
          ["entity_versions", "created_by_user_id"],
          ["ai_calls", "created_by_user_id"],
          ["ai_suggestions", "created_by_user_id"],
          ["ai_suggestions", "decided_by_user_id"],
          ["ai_conversations", "created_by_user_id"],
          ["ai_conversation_messages", "created_by_user_id"],
          ["analysis_tasks", "created_by_user_id"],
          ["audit_logs", "user_id"],
          ["continuation_guard_runs", "created_by_user_id"]
        ];
        for (const [table, column] of actorColumns) {
          const columns = new Set(this.all(`PRAGMA table_info(${table})`).map((row) => String(row.name)));
          if (!columns.has(column)) this.run(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT REFERENCES users(id) ON DELETE SET NULL`);
        }
        this.run("CREATE INDEX IF NOT EXISTS idx_users_status ON users(status, username)");
        this.run("CREATE INDEX IF NOT EXISTS idx_user_sessions_token ON user_sessions(token_hash)");
        this.run("CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id, expires_at)");
        this.run("CREATE INDEX IF NOT EXISTS idx_work_memberships_user ON work_memberships(user_id, work_id)");
        this.run("CREATE INDEX IF NOT EXISTS idx_works_owner ON works(owner_user_id, updated_at DESC)");
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (15, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(16)) {
      this.transaction(() => {
        const chapterVersionColumns = new Set(this.all("PRAGMA table_info(chapter_versions)").map((row) => String(row.name)));
        if (!chapterVersionColumns.has("work_id")) {
          this.run(`CREATE TABLE chapter_versions_v16 (
            id TEXT PRIMARY KEY,
            work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
            chapter_id TEXT NOT NULL,
            version_no INTEGER NOT NULL,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            volume_id TEXT,
            sort_order INTEGER,
            chapter_type TEXT,
            source TEXT NOT NULL DEFAULT 'manual',
            source_ref TEXT,
            created_at TEXT NOT NULL,
            created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
            UNIQUE(chapter_id, version_no)
          )`);
          this.run(`INSERT INTO chapter_versions_v16 (
              id, work_id, chapter_id, version_no, title, content, volume_id, sort_order, chapter_type,
              source, source_ref, created_at, created_by_user_id
            )
            SELECT version.id, chapter.work_id, version.chapter_id, version.version_no, version.title, version.content,
              chapter.volume_id, chapter.sort_order, chapter.chapter_type, version.source, version.source_ref,
              version.created_at, version.created_by_user_id
            FROM chapter_versions version
            JOIN chapters chapter ON chapter.id = version.chapter_id`);
          this.run("DROP TABLE chapter_versions");
          this.run("ALTER TABLE chapter_versions_v16 RENAME TO chapter_versions");
        }
        const characterVersionColumns = new Set(this.all("PRAGMA table_info(character_versions)").map((row) => String(row.name)));
        if (!characterVersionColumns.has("work_id")) {
          this.run(`CREATE TABLE character_versions_v16 (
            id TEXT PRIMARY KEY,
            work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
            character_id TEXT NOT NULL,
            version_no INTEGER NOT NULL,
            snapshot_json TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'manual',
            source_ref TEXT,
            change_note TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
            UNIQUE(character_id, version_no)
          )`);
          this.run(`INSERT INTO character_versions_v16 (
              id, work_id, character_id, version_no, snapshot_json, source, source_ref, change_note, created_at, created_by_user_id
            )
            SELECT version.id, character.work_id, version.character_id, version.version_no, version.snapshot_json,
              version.source, version.source_ref, version.change_note, version.created_at, version.created_by_user_id
            FROM character_versions version
            JOIN characters character ON character.id = version.character_id`);
          this.run("DROP TABLE character_versions");
          this.run("ALTER TABLE character_versions_v16 RENAME TO character_versions");
        }
        this.run("CREATE INDEX IF NOT EXISTS idx_chapter_versions_work ON chapter_versions(work_id, chapter_id, version_no)");
        this.run("CREATE INDEX IF NOT EXISTS idx_character_versions_work ON character_versions(work_id, character_id, version_no)");
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (16, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(17)) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(work_ai_settings)").map((row) => String(row.name)));
        if (!columns.has("auto_run_enabled")) {
          this.run("ALTER TABLE work_ai_settings ADD COLUMN auto_run_enabled INTEGER NOT NULL DEFAULT 0");
        }
        if (!columns.has("auto_run_concurrency")) {
          this.run("ALTER TABLE work_ai_settings ADD COLUMN auto_run_concurrency INTEGER NOT NULL DEFAULT 2");
        }
        if (!columns.has("auto_run_batch_limit")) {
          this.run("ALTER TABLE work_ai_settings ADD COLUMN auto_run_batch_limit INTEGER NOT NULL DEFAULT 20");
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (17, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(18)) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(work_ai_settings)").map((row) => String(row.name)));
        if (!columns.has("book_summary_context_percent")) {
          this.run("ALTER TABLE work_ai_settings ADD COLUMN book_summary_context_percent INTEGER NOT NULL DEFAULT 50");
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (18, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(19)) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(work_ai_settings)").map((row) => String(row.name)));
        if (!columns.has("agent_tools_json")) {
          this.run("ALTER TABLE work_ai_settings ADD COLUMN agent_tools_json TEXT NOT NULL DEFAULT '[\"story_index\",\"read_chapters\",\"query_story_knowledge\"]'");
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (19, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(20)) {
      this.transaction(() => {
        const settingsColumns = new Set(this.all("PRAGMA table_info(work_ai_settings)").map((row) => String(row.name)));
        if (!settingsColumns.has("context_compact_threshold")) {
          this.run("ALTER TABLE work_ai_settings ADD COLUMN context_compact_threshold INTEGER NOT NULL DEFAULT 85");
        }
        const conversationColumns = new Set(this.all("PRAGMA table_info(ai_conversations)").map((row) => String(row.name)));
        if (!conversationColumns.has("compacted_summary")) {
          this.run("ALTER TABLE ai_conversations ADD COLUMN compacted_summary TEXT NOT NULL DEFAULT ''");
        }
        if (!conversationColumns.has("compacted_message_count")) {
          this.run("ALTER TABLE ai_conversations ADD COLUMN compacted_message_count INTEGER NOT NULL DEFAULT 0");
        }
        if (!conversationColumns.has("context_warning_at")) {
          this.run("ALTER TABLE ai_conversations ADD COLUMN context_warning_at TEXT");
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (20, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(21)) {
      this.transaction(() => {
        this.run(`CREATE TABLE IF NOT EXISTS user_api_keys (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          key_hash TEXT NOT NULL UNIQUE,
          key_prefix TEXT NOT NULL,
          created_at TEXT NOT NULL,
          rotated_at TEXT NOT NULL,
          last_used_at TEXT
        )`);
        this.run("CREATE INDEX IF NOT EXISTS idx_user_api_keys_hash ON user_api_keys(key_hash)");
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (21, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(22)) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(chapter_versions)").map((row) => String(row.name)));
        if (!columns.has("change_note")) {
          this.run("ALTER TABLE chapter_versions ADD COLUMN change_note TEXT NOT NULL DEFAULT ''");
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (22, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(23)) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(models)").map((row) => String(row.name)));
        if (!columns.has("thinking_enabled")) {
          this.run("ALTER TABLE models ADD COLUMN thinking_enabled INTEGER NOT NULL DEFAULT 1");
        }
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (23, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(24)) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(users)").map((row) => String(row.name)));
        if (!columns.has("avatar_updated_at")) {
          this.run("ALTER TABLE users ADD COLUMN avatar_updated_at TEXT");
        }
        this.run(`CREATE TABLE IF NOT EXISTS user_avatars (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          mime_type TEXT NOT NULL CHECK(mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
          content BLOB NOT NULL,
          byte_length INTEGER NOT NULL,
          sha256 TEXT NOT NULL,
          width INTEGER NOT NULL,
          height INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        )`);
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (24, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(25)) {
      this.transaction(() => {
        const columns = new Set(this.all("PRAGMA table_info(users)").map((row) => String(row.name)));
        if (!columns.has("avatar_sha256")) {
          this.run("ALTER TABLE users ADD COLUMN avatar_sha256 TEXT");
        }
        this.run(`UPDATE users SET avatar_sha256 = (
          SELECT avatar.sha256 FROM user_avatars avatar WHERE avatar.user_id = users.id
        ) WHERE avatar_updated_at IS NOT NULL AND avatar_sha256 IS NULL`);
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (25, ?)", new Date().toISOString());
      });
    }
    if (!applied.has(26)) {
      this.transaction(() => {
        const timestamp = new Date().toISOString();
        this.run(`CREATE TABLE IF NOT EXISTS platform_ui_settings (
          id INTEGER PRIMARY KEY CHECK(id = 1),
          toast_position TEXT NOT NULL DEFAULT 'bottom-right' CHECK(toast_position IN ('bottom-right', 'top-right')),
          updated_at TEXT NOT NULL
        )`);
        this.run(
          "INSERT INTO platform_ui_settings (id, toast_position, updated_at) VALUES (1, 'bottom-right', ?) ON CONFLICT(id) DO NOTHING",
          timestamp
        );
        this.run("INSERT INTO schema_migrations (version, applied_at) VALUES (26, ?)", timestamp);
      });
    }
  }

  private normalizeCharacterName(value: string): string {
    return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("zh-CN");
  }

  private parseAliases(value: string): string[] {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
    } catch {
      return [];
    }
  }

  private recoverInterruptedOperations(): void {
    const timestamp = new Date().toISOString();
    this.run(
      `UPDATE ai_calls SET status = 'failed', failure = COALESCE(failure, '服务重启导致调用中断'), completed_at = ?
       WHERE status = 'running'`,
      timestamp
    );
    this.run(
      `UPDATE analysis_tasks SET status = 'partial', failure_json = ?, updated_at = ?
       WHERE status = 'running'`,
      JSON.stringify([{ message: "服务重启导致任务中断" }]),
      timestamp
    );
  }
}
