import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export type Row = Record<string, unknown>;
export const PLATFORM_AI_WORK_ID = "__scriverse_platform_ai__";

export class Database {
  readonly raw: DatabaseSync;

  constructor(filename: string) {
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true });
    this.raw = new DatabaseSync(filename);
    this.raw.exec("PRAGMA foreign_keys = ON");
    this.raw.exec("PRAGMA busy_timeout = 5000");
    if (filename !== ":memory:") this.raw.exec("PRAGMA journal_mode = WAL");
    this.migrate();
    this.recoverInterruptedOperations();
  }

  close(): void {
    this.raw.close();
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
    this.raw.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.raw.exec("COMMIT");
      return result;
    } catch (error) {
      this.raw.exec("ROLLBACK");
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
        chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
        version_no INTEGER NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'manual',
        source_ref TEXT,
        created_at TEXT NOT NULL,
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

      CREATE TABLE IF NOT EXISTS characters (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL REFERENCES works(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        aliases_json TEXT NOT NULL DEFAULT '[]',
        attributes_json TEXT NOT NULL DEFAULT '{}',
        profile_json TEXT NOT NULL DEFAULT '{}',
        current_state_json TEXT NOT NULL DEFAULT '{}',
        locked_fields_json TEXT NOT NULL DEFAULT '[]',
        visibility TEXT NOT NULL DEFAULT 'author',
        first_chapter_id TEXT REFERENCES chapters(id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
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

      CREATE TABLE IF NOT EXISTS work_ai_settings (
        work_id TEXT PRIMARY KEY REFERENCES works(id) ON DELETE CASCADE,
        system_prompt TEXT NOT NULL DEFAULT '',
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
      CREATE UNIQUE INDEX IF NOT EXISTS idx_character_names_primary ON character_names(character_id) WHERE kind = 'primary';
      CREATE INDEX IF NOT EXISTS idx_character_names_character ON character_names(character_id, sort_order);
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
