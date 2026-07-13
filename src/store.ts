import type { ParsedNovel } from "./domain.js";
import { createHash } from "node:crypto";
import { Database, type Row } from "./database.js";
import { AppError, notFound } from "./errors.js";
import { countWords, id, json, normalizeParagraphSpacing, now } from "./utils.js";

type WorkInput = {
  title: string;
  author?: string;
  description?: string;
  language?: string;
  coverUrl?: string | null;
  tags?: string[];
};

type ChapterType = "正文" | "设定" | "作者的话" | "其他";

type SettingInput = {
  title: string;
  category: string;
  content: string;
  tags?: string[];
  status?: string;
  locked?: boolean;
  evidence?: unknown[];
  scope?: Record<string, unknown>;
  authorNote?: string;
};

type CharacterInput = {
  name: string;
  aliases?: string[];
  species?: string;
  organizationIds?: string[];
  attributes?: Record<string, unknown>;
  profile?: Record<string, unknown>;
  currentState?: Record<string, unknown>;
  lockedFields?: string[];
  visibility?: string;
  firstChapterId?: string | null;
};

type CharacterSnapshot = {
  name: string;
  aliases: string[];
  species: string;
  organizationIds: string[];
  attributes: Record<string, unknown>;
  profile: Record<string, unknown>;
  currentState: Record<string, unknown>;
  lockedFields: string[];
  visibility: string;
  firstChapterId: string | null;
};

type TimelineInput = {
  name: string;
  trackId?: string | null;
  description?: string;
  eventType?: string;
  timeLabel?: string;
  timeSort?: number | null;
  chapterIds?: string[];
  participantIds?: string[];
  location?: string;
  causes?: string[];
  impactScope?: string;
  evidence?: unknown[];
  status?: string;
};

type TimelineTrackInput = {
  name: string;
  description?: string;
  sortOrder?: number;
};

type RelationshipInput = {
  fromCharacterId: string;
  toCharacterId: string;
  category: string;
  subtype?: string;
  keywords?: string[];
  directed?: boolean;
  currentStatus?: string;
  timeRange?: Record<string, unknown>;
  confidence?: number;
  evidence?: unknown[];
  confirmationStatus?: string;
  locked?: boolean;
};

type OrganizationInput = {
  name: string;
  description?: string;
  settings?: string[];
  memberIds?: string[];
};

type ChapterOutlineInput = {
  goal?: string;
  conflict?: string;
  turningPoint?: string;
  notes?: string;
  status?: "draft" | "ready" | "completed";
};

type ForeshadowOccurrenceInput = {
  chapterId: string;
  role: "setup" | "reminder" | "payoff";
  note?: string;
  evidence?: unknown[];
};

type ForeshadowInput = {
  title: string;
  description?: string;
  status?: "planned" | "planted" | "resolved" | "abandoned";
  importance?: "low" | "medium" | "high";
  plannedPayoffChapterId?: string | null;
  resolutionNote?: string;
  occurrences?: ForeshadowOccurrenceInput[];
};

type ReviewInput = {
  itemType: string;
  severity?: string;
  title: string;
  description?: string;
  entityRefs?: unknown[];
  evidence?: unknown[];
  suggestion?: string;
  status?: string;
  resolutionNote?: string;
};

type AiConversationMessageInput = {
  role: "user" | "assistant";
  content: string;
  citations?: unknown[];
  metadata?: { modelDisplayName?: string; outputTokens?: number };
};

function requiredString(row: Row, key: string): string {
  return String(row[key] ?? "");
}

function optionalString(row: Row, key: string): string | null {
  return row[key] === null || row[key] === undefined ? null : String(row[key]);
}

function numberValue(row: Row, key: string): number {
  return Number(row[key] ?? 0);
}

function booleanValue(row: Row, key: string): boolean {
  return Number(row[key] ?? 0) === 1;
}

export function normalizeCharacterName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("zh-CN");
}

export class Store {
  constructor(readonly db: Database) {}

  audit(workId: string | null, action: string, entityType: string, entityId: string | null, detail: unknown = {}): void {
    this.db.run(
      "INSERT INTO audit_logs (id, work_id, action, entity_type, entity_id, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      id("audit"),
      workId,
      action,
      entityType,
      entityId,
      JSON.stringify(detail),
      now()
    );
  }

  createWork(input: WorkInput): Record<string, unknown> {
    const workId = id("work");
    const timestamp = now();
    this.db.run(
      `INSERT INTO works (id, title, author, description, language, cover_url, tags_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      workId,
      input.title,
      input.author ?? "",
      input.description ?? "",
      input.language ?? "zh-CN",
      input.coverUrl ?? null,
      JSON.stringify(input.tags ?? []),
      timestamp,
      timestamp
    );
    this.audit(workId, "work.created", "work", workId);
    return this.getWork(workId);
  }

  listWorks(): Record<string, unknown>[] {
    return this.db.all("SELECT * FROM works WHERE COALESCE(is_internal, 0) = 0 ORDER BY updated_at DESC").map((row) => this.mapWork(row));
  }

  getWork(workId: string): Record<string, unknown> {
    const row = this.db.get("SELECT * FROM works WHERE id = ?", workId);
    if (!row) throw notFound("作品");
    return this.mapWork(row);
  }

  getPlatformAiSettings(): Record<string, unknown> {
    const row = this.db.get("SELECT * FROM platform_ai_settings WHERE id = 1");
    return {
      systemPrompt: String(row?.system_prompt ?? ""),
      updatedAt: String(row?.updated_at ?? "")
    };
  }

  updatePlatformAiSettings(input: { systemPrompt?: string }): Record<string, unknown> {
    const timestamp = now();
    this.db.run(
      `INSERT INTO platform_ai_settings (id, system_prompt, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET system_prompt = excluded.system_prompt, updated_at = excluded.updated_at`,
      input.systemPrompt ?? String(this.getPlatformAiSettings().systemPrompt),
      timestamp
    );
    return this.getPlatformAiSettings();
  }

  getWorkAiSettings(workId: string): Record<string, unknown> {
    this.getWork(workId);
    const row = this.db.get("SELECT * FROM work_ai_settings WHERE work_id = ?", workId);
    return {
      workId,
      systemPrompt: String(row?.system_prompt ?? ""),
      updatedAt: String(row?.updated_at ?? "")
    };
  }

  updateWorkAiSettings(workId: string, input: { systemPrompt?: string }): Record<string, unknown> {
    this.getWork(workId);
    const timestamp = now();
    this.db.run(
      `INSERT INTO work_ai_settings (work_id, system_prompt, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(work_id) DO UPDATE SET system_prompt = excluded.system_prompt, updated_at = excluded.updated_at`,
      workId,
      input.systemPrompt ?? String(this.getWorkAiSettings(workId).systemPrompt),
      timestamp
    );
    this.audit(workId, "work.ai-settings.updated", "work-ai-settings", workId, { systemPromptChanged: input.systemPrompt !== undefined });
    return this.getWorkAiSettings(workId);
  }

  updateWork(workId: string, input: Partial<WorkInput>): Record<string, unknown> {
    const current = this.getWork(workId);
    const timestamp = now();
    this.db.run(
      `UPDATE works SET title = ?, author = ?, description = ?, language = ?, cover_url = ?, tags_json = ?, updated_at = ?
       WHERE id = ?`,
      input.title ?? String(current.title),
      input.author ?? String(current.author),
      input.description ?? String(current.description),
      input.language ?? String(current.language),
      input.coverUrl === undefined ? (current.coverUrl as string | null) : input.coverUrl,
      JSON.stringify(input.tags ?? current.tags),
      timestamp,
      workId
    );
    this.audit(workId, "work.updated", "work", workId, { fields: Object.keys(input) });
    return this.getWork(workId);
  }

  deleteWork(workId: string): void {
    this.getWork(workId);
    this.db.run("DELETE FROM works WHERE id = ?", workId);
  }

  setWorkCover(workId: string, mimeType: "image/jpeg" | "image/png" | "image/webp", content: Buffer): Record<string, unknown> {
    this.getWork(workId);
    const timestamp = now();
    const sha256 = createHash("sha256").update(content).digest("hex");
    this.db.run(
      `INSERT INTO work_covers (work_id, mime_type, content, byte_length, sha256, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(work_id) DO UPDATE SET mime_type = excluded.mime_type, content = excluded.content,
       byte_length = excluded.byte_length, sha256 = excluded.sha256, updated_at = excluded.updated_at`,
      workId,
      mimeType,
      content,
      content.byteLength,
      sha256,
      timestamp
    );
    this.db.run("UPDATE works SET updated_at = ? WHERE id = ?", timestamp, workId);
    this.audit(workId, "work.cover.updated", "work", workId, { mimeType, byteLength: content.byteLength, sha256 });
    return this.getWork(workId);
  }

  getWorkCover(workId: string): { mimeType: string; content: Buffer; byteLength: number; sha256: string; updatedAt: string } {
    this.getWork(workId);
    const row = this.db.get("SELECT * FROM work_covers WHERE work_id = ?", workId);
    if (!row) throw notFound("作品封面");
    return {
      mimeType: requiredString(row, "mime_type"),
      content: Buffer.from(row.content as Uint8Array),
      byteLength: numberValue(row, "byte_length"),
      sha256: requiredString(row, "sha256"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  deleteWorkCover(workId: string): void {
    this.getWork(workId);
    this.db.run("DELETE FROM work_covers WHERE work_id = ?", workId);
    this.db.run("UPDATE works SET updated_at = ? WHERE id = ?", now(), workId);
    this.audit(workId, "work.cover.deleted", "work", workId);
  }

  getWorkTree(workId: string): Record<string, unknown> {
    const work = this.getWork(workId);
    const volumeRows = this.db.all("SELECT * FROM volumes WHERE work_id = ? ORDER BY sort_order, created_at", workId);
    const chapterRows = this.db.all("SELECT * FROM chapters WHERE work_id = ? ORDER BY sort_order, created_at", workId);
    const chaptersByVolume = new Map<string, Record<string, unknown>[]>();
    for (const row of chapterRows) {
      const chapter = this.mapChapter(row);
      const volumeId = requiredString(row, "volume_id");
      const list = chaptersByVolume.get(volumeId) ?? [];
      list.push(chapter);
      chaptersByVolume.set(volumeId, list);
    }
    const volumes = volumeRows.map((row) => ({
      ...this.mapVolume(row),
      chapters: chaptersByVolume.get(requiredString(row, "id")) ?? []
    }));
    return { ...work, volumes };
  }

  listFileVersions(workId: string): Record<string, unknown>[] {
    this.getWork(workId);
    return this.db
      .all("SELECT id, work_id, file_name, file_type, word_count, paragraph_count, warnings_json, created_at FROM file_versions WHERE work_id = ? ORDER BY created_at DESC", workId)
      .map((row) => ({
        id: requiredString(row, "id"),
        workId: requiredString(row, "work_id"),
        fileName: requiredString(row, "file_name"),
        fileType: requiredString(row, "file_type"),
        wordCount: numberValue(row, "word_count"),
        paragraphCount: numberValue(row, "paragraph_count"),
        warnings: json(requiredString(row, "warnings_json"), []),
        createdAt: requiredString(row, "created_at")
      }));
  }

  importNovel(workId: string, fileName: string, fileType: string, parsed: ParsedNovel): Record<string, unknown> {
    this.getWork(workId);
    let result: Record<string, unknown> = {};
    this.db.transaction(() => { result = this.importNovelInTransaction(workId, fileName, fileType, parsed); });
    return result;
  }

  createImportedWork(input: WorkInput, fileName: string, fileType: string, parsed: ParsedNovel): Record<string, unknown> {
    return this.db.transaction(() => {
      const work = this.createWork(input);
      const imported = this.importNovelInTransaction(String(work.id), fileName, fileType, parsed);
      return { ...imported, work: this.getWork(String(work.id)) };
    });
  }

  private importNovelInTransaction(workId: string, fileName: string, fileType: string, parsed: ParsedNovel): Record<string, unknown> {
    const fileVersionId = id("file");
    const timestamp = now();
    const snapshot = this.getWorkTree(workId);
    this.db.run(
      `INSERT INTO file_versions (id, work_id, file_name, file_type, word_count, paragraph_count, warnings_json, snapshot_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      fileVersionId,
      workId,
      fileName,
      fileType,
      parsed.wordCount,
      parsed.paragraphCount,
      JSON.stringify(parsed.warnings),
      JSON.stringify(snapshot),
      timestamp
    );
    this.db.run("DELETE FROM volumes WHERE work_id = ?", workId);
    for (const volume of parsed.volumes) {
      const volumeId = id("volume");
      this.db.run(
        `INSERT INTO volumes (id, work_id, title, kind, source, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        volumeId,
        workId,
        volume.title,
        volume.kind,
        volume.source,
        volume.order,
        timestamp,
        timestamp
      );
      for (const chapter of volume.chapters) {
        this.insertChapter(workId, volumeId, chapter.title, chapter.content, chapter.order, "import", fileVersionId, chapter.chapterType);
      }
    }
    this.db.run("UPDATE works SET updated_at = ? WHERE id = ?", timestamp, workId);
    this.audit(workId, "work.imported", "file-version", fileVersionId, {
      fileName,
      volumeCount: parsed.volumes.length,
      chapterCount: parsed.volumes.reduce((sum, volume) => sum + volume.chapters.length, 0)
    });
    return {
      fileVersionId,
      warnings: parsed.warnings,
      wordCount: parsed.wordCount,
      paragraphCount: parsed.paragraphCount,
      tree: this.getWorkTree(workId)
    };
  }

  createVolume(workId: string, input: { title: string; kind?: string; description?: string; keywords?: string[] }): Record<string, unknown> {
    this.getWork(workId);
    const volumeId = id("volume");
    const timestamp = now();
    const last = this.db.get("SELECT COALESCE(MAX(sort_order), -1) AS value FROM volumes WHERE work_id = ?", workId);
    this.db.run(
      `INSERT INTO volumes (id, work_id, title, kind, source, description, keywords_json, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'manual', ?, ?, ?, ?, ?)`,
      volumeId,
      workId,
      input.title,
      input.kind ?? "main",
      input.description?.trim() ?? "",
      JSON.stringify(this.normalizeVolumeKeywords(input.keywords ?? [])),
      numberValue(last ?? {}, "value") + 1,
      timestamp,
      timestamp
    );
    this.audit(workId, "volume.created", "volume", volumeId);
    return this.getVolume(volumeId);
  }

  getVolume(volumeId: string): Record<string, unknown> {
    const row = this.db.get("SELECT * FROM volumes WHERE id = ?", volumeId);
    if (!row) throw notFound("卷");
    return this.mapVolume(row);
  }

  updateVolume(volumeId: string, input: { title?: string; kind?: string; description?: string; keywords?: string[]; sortOrder?: number }): Record<string, unknown> {
    const current = this.getVolume(volumeId);
    this.db.run(
      "UPDATE volumes SET title = ?, kind = ?, description = ?, keywords_json = ?, sort_order = ?, source = 'manual', updated_at = ? WHERE id = ?",
      input.title ?? String(current.title),
      input.kind ?? String(current.kind),
      input.description?.trim() ?? String(current.description),
      JSON.stringify(input.keywords === undefined ? current.keywords : this.normalizeVolumeKeywords(input.keywords)),
      input.sortOrder ?? Number(current.sortOrder),
      now(),
      volumeId
    );
    this.audit(String(current.workId), "volume.updated", "volume", volumeId, input);
    return this.getVolume(volumeId);
  }

  deleteVolume(volumeId: string): void {
    const volume = this.getVolume(volumeId);
    const count = this.db.get("SELECT COUNT(*) AS value FROM chapters WHERE volume_id = ?", volumeId);
    if (numberValue(count ?? {}, "value") > 0) {
      throw new AppError(409, "VOLUME_NOT_EMPTY", "卷内仍有章节，需先移动或删除章节");
    }
    this.db.run("DELETE FROM volumes WHERE id = ?", volumeId);
    this.audit(String(volume.workId), "volume.deleted", "volume", volumeId);
  }

  createChapter(workId: string, input: { volumeId: string; title: string; content?: string; chapterType?: ChapterType }): Record<string, unknown> {
    this.getWork(workId);
    const volume = this.getVolume(input.volumeId);
    if (volume.workId !== workId) throw new AppError(400, "VOLUME_WORK_MISMATCH", "卷不属于当前作品");
    const last = this.db.get("SELECT COALESCE(MAX(sort_order), -1) AS value FROM chapters WHERE volume_id = ?", input.volumeId);
    const chapterId = this.insertChapter(
      workId,
      input.volumeId,
      input.title,
      input.content ?? "",
      numberValue(last ?? {}, "value") + 1,
      "manual",
      null,
      input.chapterType ?? "正文"
    );
    this.audit(workId, "chapter.created", "chapter", chapterId);
    return this.getChapter(chapterId);
  }

  getChapter(chapterId: string): Record<string, unknown> {
    const row = this.db.get("SELECT * FROM chapters WHERE id = ?", chapterId);
    if (!row) throw notFound("章节");
    return this.mapChapter(row);
  }

  listChapterVersions(chapterId: string): Record<string, unknown>[] {
    this.getChapter(chapterId);
    return this.db
      .all("SELECT * FROM chapter_versions WHERE chapter_id = ? ORDER BY version_no DESC", chapterId)
      .map((row) => ({
        id: requiredString(row, "id"),
        chapterId: requiredString(row, "chapter_id"),
        versionNo: numberValue(row, "version_no"),
        title: requiredString(row, "title"),
        content: requiredString(row, "content"),
        source: requiredString(row, "source"),
        sourceRef: optionalString(row, "source_ref"),
        createdAt: requiredString(row, "created_at")
      }));
  }

  listChapterInsights(chapterId: string): Record<string, unknown>[] {
    this.getChapter(chapterId);
    return this.db
      .all("SELECT * FROM chapter_insights WHERE chapter_id = ? ORDER BY chapter_version DESC, created_at DESC", chapterId)
      .map((row) => ({
        id: requiredString(row, "id"),
        chapterId: requiredString(row, "chapter_id"),
        chapterVersion: numberValue(row, "chapter_version"),
        summary: requiredString(row, "summary"),
        events: json(requiredString(row, "events_json"), []),
        characters: json(requiredString(row, "characters_json"), []),
        settings: json(requiredString(row, "settings_json"), []),
        evidence: json(requiredString(row, "evidence_json"), []),
        uncertainties: json(requiredString(row, "uncertainties_json"), []),
        status: requiredString(row, "status"),
        createdAt: requiredString(row, "created_at")
      }));
  }

  saveChapter(
    chapterId: string,
    input: { title?: string; content?: string; excludedFromAnalysis?: boolean; chapterType?: ChapterType },
    source = "manual",
    sourceRef: string | null = null
  ): Record<string, unknown> {
    const current = this.getChapter(chapterId);
    const nextTitle = input.title ?? String(current.title);
    const nextContent = input.content === undefined ? String(current.content) : normalizeParagraphSpacing(input.content);
    const nextExcluded = input.excludedFromAnalysis ?? Boolean(current.excludedFromAnalysis);
    const nextChapterType = input.chapterType ?? String(current.chapterType) as ChapterType;
    const hasTextChange = nextTitle !== current.title || nextContent !== current.content;
    const hasTypeChange = nextChapterType !== current.chapterType;
    const hasOtherChange = nextExcluded !== current.excludedFromAnalysis || hasTypeChange;
    if (!hasTextChange && !hasOtherChange) return current;
    const timestamp = now();
    const versionNo = Number(current.versionNo) + (hasTextChange ? 1 : 0);
    this.db.transaction(() => {
      this.db.run(
        `UPDATE chapters SET title = ?, content = ?, chapter_type = ?, word_count = ?, version_no = ?, analysis_status = ?,
         excluded_from_analysis = ?, updated_at = ? WHERE id = ?`,
        nextTitle,
        nextContent,
        nextChapterType,
        countWords(nextContent),
        versionNo,
        hasTextChange || hasTypeChange ? "expired" : String(current.analysisStatus),
        nextExcluded ? 1 : 0,
        timestamp,
        chapterId
      );
      if (hasTextChange) {
        this.db.run(
          `INSERT INTO chapter_versions (id, chapter_id, version_no, title, content, source, source_ref, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          id("chapterVersion"),
          chapterId,
          versionNo,
          nextTitle,
          nextContent,
          source,
          sourceRef,
          timestamp
        );
      }
      if (hasTextChange || hasTypeChange) this.invalidateChapter(String(current.workId), chapterId, versionNo);
      this.db.run("UPDATE works SET updated_at = ? WHERE id = ?", timestamp, String(current.workId));
      this.audit(String(current.workId), "chapter.saved", "chapter", chapterId, { versionNo, source, chapterType: nextChapterType });
    });
    return this.getChapter(chapterId);
  }

  restoreChapter(chapterId: string, versionNo: number): Record<string, unknown> {
    const version = this.db.get("SELECT * FROM chapter_versions WHERE chapter_id = ? AND version_no = ?", chapterId, versionNo);
    if (!version) throw notFound("章节版本");
    return this.saveChapter(
      chapterId,
      { title: requiredString(version, "title"), content: requiredString(version, "content") },
      "restore",
      requiredString(version, "id")
    );
  }

  moveChapter(chapterId: string, input: { volumeId: string; sortOrder: number }): Record<string, unknown> {
    const chapter = this.getChapter(chapterId);
    const volume = this.getVolume(input.volumeId);
    if (volume.workId !== chapter.workId) throw new AppError(400, "VOLUME_WORK_MISMATCH", "卷不属于当前作品");
    this.db.transaction(() => {
      this.db.run(
        `UPDATE analysis_tasks SET status = 'expired', updated_at = ?
         WHERE work_id = ? AND status IN ('pending', 'running', 'completed', 'partial', 'review')
         AND json_extract(scope_json, '$.type') = 'volume' AND json_extract(scope_json, '$.volumeId') = ?`,
        now(),
        String(chapter.workId),
        String(chapter.volumeId)
      );
      this.db.run(
        "UPDATE chapters SET volume_id = ?, sort_order = ?, analysis_status = 'expired', updated_at = ? WHERE id = ?",
        input.volumeId,
        input.sortOrder,
        now(),
        chapterId
      );
      this.invalidateChapter(String(chapter.workId), chapterId, Number(chapter.versionNo));
      this.audit(String(chapter.workId), "chapter.moved", "chapter", chapterId, input);
    });
    return this.getChapter(chapterId);
  }

  deleteChapter(chapterId: string): void {
    const chapter = this.getChapter(chapterId);
    this.db.run("DELETE FROM chapters WHERE id = ?", chapterId);
    this.audit(String(chapter.workId), "chapter.deleted", "chapter", chapterId);
  }

  private insertChapter(
    workId: string,
    volumeId: string,
    title: string,
    content: string,
    sortOrder: number,
    source: string,
    sourceRef: string | null,
    chapterType: ChapterType = "正文"
  ): string {
    const chapterId = id("chapter");
    const timestamp = now();
    const normalizedContent = normalizeParagraphSpacing(content);
    this.db.run(
      `INSERT INTO chapters (id, work_id, volume_id, title, content, chapter_type, sort_order, word_count, version_no, analysis_status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'pending', ?, ?)`,
      chapterId,
      workId,
      volumeId,
      title,
      normalizedContent,
      chapterType,
      sortOrder,
      countWords(normalizedContent),
      timestamp,
      timestamp
    );
    this.db.run(
      `INSERT INTO chapter_versions (id, chapter_id, version_no, title, content, source, source_ref, created_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
      id("chapterVersion"),
      chapterId,
      title,
      normalizedContent,
      source,
      sourceRef,
      timestamp
    );
    return chapterId;
  }

  private invalidateChapter(workId: string, chapterId: string, versionNo: number): void {
    this.db.run(
      `UPDATE analysis_tasks SET status = 'expired', updated_at = ?
       WHERE work_id = ? AND status IN ('pending', 'running', 'completed', 'partial', 'review')
       AND NOT (status = 'pending' AND task_type = 'chapter-analysis'
         AND json_extract(scope_json, '$.chapterId') = ?)
       AND (json_extract(scope_json, '$.chapterId') = ?
         OR json_extract(scope_json, '$.type') = 'book'
         OR (json_extract(scope_json, '$.type') = 'volume'
           AND json_extract(scope_json, '$.volumeId') = (SELECT volume_id FROM chapters WHERE id = ?)))`,
      now(),
      workId,
      chapterId,
      chapterId,
      chapterId
    );
    const existing = this.db.get(
      `SELECT id FROM analysis_tasks WHERE work_id = ? AND task_type = 'chapter-analysis' AND status = 'pending'
       AND json_extract(scope_json, '$.chapterId') = ?`,
      workId,
      chapterId
    );
    if (!existing) {
      const timestamp = now();
      this.db.run(
        `INSERT INTO analysis_tasks (id, work_id, task_type, scope_json, status, source_versions_json, created_at, updated_at)
         VALUES (?, ?, 'chapter-analysis', ?, 'pending', ?, ?, ?)`,
        id("task"),
        workId,
        JSON.stringify({ type: "chapter", chapterId }),
        JSON.stringify({ [chapterId]: versionNo }),
        timestamp,
        timestamp
      );
    } else {
      this.db.run(
        "UPDATE analysis_tasks SET source_versions_json = ?, updated_at = ? WHERE id = ?",
        JSON.stringify({ [chapterId]: versionNo }),
        now(),
        requiredString(existing, "id")
      );
    }
  }

  private mapWork(row: Row): Record<string, unknown> {
    const count = this.db.get(
      "SELECT COUNT(*) AS chapter_count, COALESCE(SUM(word_count), 0) AS word_count FROM chapters WHERE work_id = ?",
      requiredString(row, "id")
    );
    const cover = this.db.get("SELECT updated_at FROM work_covers WHERE work_id = ?", requiredString(row, "id"));
    return {
      id: requiredString(row, "id"),
      title: requiredString(row, "title"),
      author: requiredString(row, "author"),
      description: requiredString(row, "description"),
      language: requiredString(row, "language"),
      coverUrl: cover
        ? `/api/works/${encodeURIComponent(requiredString(row, "id"))}/cover?v=${encodeURIComponent(requiredString(cover, "updated_at"))}`
        : optionalString(row, "cover_url"),
      tags: json(requiredString(row, "tags_json"), []),
      chapterCount: numberValue(count ?? {}, "chapter_count"),
      wordCount: numberValue(count ?? {}, "word_count"),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  private mapVolume(row: Row): Record<string, unknown> {
    return {
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      title: requiredString(row, "title"),
      kind: requiredString(row, "kind"),
      source: requiredString(row, "source"),
      description: optionalString(row, "description") ?? "",
      keywords: json<string[]>(optionalString(row, "keywords_json"), []),
      sortOrder: numberValue(row, "sort_order"),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  private normalizeVolumeKeywords(keywords: string[]): string[] {
    return [...new Set(keywords.map((keyword) => keyword.normalize("NFKC").trim()).filter(Boolean))].slice(0, 100);
  }

  private mapChapter(row: Row): Record<string, unknown> {
    return {
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      volumeId: requiredString(row, "volume_id"),
      title: requiredString(row, "title"),
      content: requiredString(row, "content"),
      chapterType: requiredString(row, "chapter_type") || "正文",
      sortOrder: numberValue(row, "sort_order"),
      wordCount: numberValue(row, "word_count"),
      versionNo: numberValue(row, "version_no"),
      analysisStatus: requiredString(row, "analysis_status"),
      excludedFromAnalysis: booleanValue(row, "excluded_from_analysis"),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  getChapterOutline(chapterId: string): Record<string, unknown> | null {
    const chapter = this.getChapter(chapterId);
    const row = this.db.get("SELECT * FROM chapter_outlines WHERE chapter_id = ?", chapterId);
    if (!row) return null;
    return this.mapChapterOutline(row, chapter);
  }

  listChapterOutlines(workId: string): Record<string, unknown>[] {
    this.getWork(workId);
    const rows = this.db.all(
      `SELECT c.id AS chapter_id, c.title AS chapter_title, c.volume_id, c.sort_order AS chapter_order,
       v.title AS volume_title, v.sort_order AS volume_order,
       o.goal, o.conflict, o.turning_point, o.notes, o.status, o.created_at, o.updated_at,
       (SELECT COUNT(DISTINCT fo.foreshadow_id) FROM foreshadow_occurrences fo
        JOIN foreshadows f ON f.id = fo.foreshadow_id
        WHERE fo.chapter_id = c.id AND f.status IN ('planned', 'planted')) AS unresolved_count
       FROM chapters c
       JOIN volumes v ON v.id = c.volume_id
       LEFT JOIN chapter_outlines o ON o.chapter_id = c.id
       WHERE c.work_id = ?
       ORDER BY v.sort_order, c.sort_order, c.created_at`,
      workId
    );
    return rows.map((row) => ({
      chapterId: requiredString(row, "chapter_id"),
      chapterTitle: requiredString(row, "chapter_title"),
      volumeId: requiredString(row, "volume_id"),
      volumeTitle: requiredString(row, "volume_title"),
      goal: optionalString(row, "goal") ?? "",
      conflict: optionalString(row, "conflict") ?? "",
      turningPoint: optionalString(row, "turning_point") ?? "",
      notes: optionalString(row, "notes") ?? "",
      status: optionalString(row, "status") ?? "draft",
      unresolvedForeshadowCount: numberValue(row, "unresolved_count"),
      createdAt: optionalString(row, "created_at"),
      updatedAt: optionalString(row, "updated_at")
    }));
  }

  upsertChapterOutline(chapterId: string, input: ChapterOutlineInput): Record<string, unknown> {
    const chapter = this.getChapter(chapterId);
    const current = this.getChapterOutline(chapterId);
    const timestamp = now();
    this.db.run(
      `INSERT INTO chapter_outlines (chapter_id, goal, conflict, turning_point, notes, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chapter_id) DO UPDATE SET goal = excluded.goal, conflict = excluded.conflict,
       turning_point = excluded.turning_point, notes = excluded.notes, status = excluded.status,
       updated_at = excluded.updated_at`,
      chapterId,
      input.goal ?? String(current?.goal ?? ""),
      input.conflict ?? String(current?.conflict ?? ""),
      input.turningPoint ?? String(current?.turningPoint ?? ""),
      input.notes ?? String(current?.notes ?? ""),
      input.status ?? String(current?.status ?? "draft"),
      timestamp,
      timestamp
    );
    this.audit(String(chapter.workId), current ? "outline.updated" : "outline.created", "chapter-outline", chapterId, { fields: Object.keys(input) });
    return this.getChapterOutline(chapterId) as Record<string, unknown>;
  }

  deleteChapterOutline(chapterId: string): void {
    const chapter = this.getChapter(chapterId);
    this.db.run("DELETE FROM chapter_outlines WHERE chapter_id = ?", chapterId);
    this.audit(String(chapter.workId), "outline.deleted", "chapter-outline", chapterId);
  }

  private mapChapterOutline(row: Row, chapter: Record<string, unknown>): Record<string, unknown> {
    return {
      chapterId: requiredString(row, "chapter_id"),
      workId: chapter.workId,
      chapterTitle: chapter.title,
      volumeId: chapter.volumeId,
      goal: requiredString(row, "goal"),
      conflict: requiredString(row, "conflict"),
      turningPoint: requiredString(row, "turning_point"),
      notes: requiredString(row, "notes"),
      status: requiredString(row, "status"),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  createForeshadow(workId: string, input: ForeshadowInput): Record<string, unknown> {
    this.getWork(workId);
    if (input.plannedPayoffChapterId) this.assertChapterInWork(input.plannedPayoffChapterId, workId);
    const foreshadowId = id("foreshadow");
    const timestamp = now();
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO foreshadows (id, work_id, title, description, status, importance,
         planned_payoff_chapter_id, resolution_note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        foreshadowId,
        workId,
        input.title,
        input.description ?? "",
        input.status ?? "planned",
        input.importance ?? "medium",
        input.plannedPayoffChapterId ?? null,
        input.resolutionNote ?? "",
        timestamp,
        timestamp
      );
      for (const occurrence of input.occurrences ?? []) this.insertForeshadowOccurrence(foreshadowId, workId, occurrence);
      this.audit(workId, "foreshadow.created", "foreshadow", foreshadowId);
    });
    return this.getForeshadow(foreshadowId);
  }

  getForeshadow(foreshadowId: string, currentChapterId?: string): Record<string, unknown> {
    const row = this.db.get("SELECT * FROM foreshadows WHERE id = ?", foreshadowId);
    if (!row) throw notFound("伏笔");
    const workId = requiredString(row, "work_id");
    if (currentChapterId) this.assertChapterInWork(currentChapterId, workId);
    const occurrences = this.db.all(
      `SELECT fo.*, c.title AS chapter_title, c.volume_id, c.sort_order AS chapter_order,
       v.title AS volume_title, v.sort_order AS volume_order
       FROM foreshadow_occurrences fo
       JOIN chapters c ON c.id = fo.chapter_id
       JOIN volumes v ON v.id = c.volume_id
       WHERE fo.foreshadow_id = ? ORDER BY v.sort_order, c.sort_order, fo.created_at`,
      foreshadowId
    ).map((item) => this.mapForeshadowOccurrence(item));
    const status = requiredString(row, "status");
    const plannedPayoffChapterId = optionalString(row, "planned_payoff_chapter_id");
    return {
      id: requiredString(row, "id"),
      workId,
      title: requiredString(row, "title"),
      description: requiredString(row, "description"),
      status,
      importance: requiredString(row, "importance"),
      plannedPayoffChapterId,
      resolutionNote: requiredString(row, "resolution_note"),
      unresolved: status === "planned" || status === "planted",
      overdue: Boolean(currentChapterId && plannedPayoffChapterId && ["planned", "planted"].includes(status)
        && this.chapterSequence(workId, plannedPayoffChapterId) < this.chapterSequence(workId, currentChapterId)),
      occurrences,
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  listForeshadows(workId: string, status: "all" | "unresolved" | "resolved" = "all", currentChapterId?: string): Record<string, unknown>[] {
    this.getWork(workId);
    if (currentChapterId) this.assertChapterInWork(currentChapterId, workId);
    const where = status === "unresolved"
      ? "AND status IN ('planned', 'planted')"
      : status === "resolved" ? "AND status IN ('resolved', 'abandoned')" : "";
    return this.db.all(
      `SELECT id FROM foreshadows WHERE work_id = ? ${where}
       ORDER BY CASE importance WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at`,
      workId
    ).map((row) => this.getForeshadow(requiredString(row, "id"), currentChapterId));
  }

  updateForeshadow(foreshadowId: string, input: Partial<ForeshadowInput>): Record<string, unknown> {
    const current = this.getForeshadow(foreshadowId);
    const workId = String(current.workId);
    if (input.plannedPayoffChapterId) this.assertChapterInWork(input.plannedPayoffChapterId, workId);
    this.db.transaction(() => {
      this.db.run(
        `UPDATE foreshadows SET title = ?, description = ?, status = ?, importance = ?,
         planned_payoff_chapter_id = ?, resolution_note = ?, updated_at = ? WHERE id = ?`,
        input.title ?? String(current.title),
        input.description ?? String(current.description),
        input.status ?? String(current.status),
        input.importance ?? String(current.importance),
        input.plannedPayoffChapterId === undefined ? current.plannedPayoffChapterId as string | null : input.plannedPayoffChapterId,
        input.resolutionNote ?? String(current.resolutionNote),
        now(),
        foreshadowId
      );
      if (input.occurrences) {
        this.db.run("DELETE FROM foreshadow_occurrences WHERE foreshadow_id = ?", foreshadowId);
        for (const occurrence of input.occurrences) this.insertForeshadowOccurrence(foreshadowId, workId, occurrence);
      }
      this.audit(workId, "foreshadow.updated", "foreshadow", foreshadowId, { fields: Object.keys(input) });
    });
    return this.getForeshadow(foreshadowId);
  }

  deleteForeshadow(foreshadowId: string): void {
    const current = this.getForeshadow(foreshadowId);
    this.db.run("DELETE FROM foreshadows WHERE id = ?", foreshadowId);
    this.audit(String(current.workId), "foreshadow.deleted", "foreshadow", foreshadowId);
  }

  createForeshadowOccurrence(foreshadowId: string, input: ForeshadowOccurrenceInput): Record<string, unknown> {
    const foreshadow = this.getForeshadow(foreshadowId);
    const occurrenceId = this.insertForeshadowOccurrence(foreshadowId, String(foreshadow.workId), input);
    this.audit(String(foreshadow.workId), "foreshadow.occurrence.created", "foreshadow-occurrence", occurrenceId);
    return this.getForeshadowOccurrence(occurrenceId);
  }

  updateForeshadowOccurrence(occurrenceId: string, input: Partial<ForeshadowOccurrenceInput>): Record<string, unknown> {
    const current = this.getForeshadowOccurrence(occurrenceId);
    const foreshadow = this.getForeshadow(String(current.foreshadowId));
    const chapterId = input.chapterId ?? String(current.chapterId);
    this.assertChapterInWork(chapterId, String(foreshadow.workId));
    this.db.run(
      `UPDATE foreshadow_occurrences SET chapter_id = ?, role = ?, note = ?, evidence_json = ?, updated_at = ? WHERE id = ?`,
      chapterId,
      input.role ?? String(current.role),
      input.note ?? String(current.note),
      JSON.stringify(input.evidence ?? current.evidence),
      now(),
      occurrenceId
    );
    return this.getForeshadowOccurrence(occurrenceId);
  }

  deleteForeshadowOccurrence(occurrenceId: string): void {
    this.getForeshadowOccurrence(occurrenceId);
    this.db.run("DELETE FROM foreshadow_occurrences WHERE id = ?", occurrenceId);
  }

  private insertForeshadowOccurrence(foreshadowId: string, workId: string, input: ForeshadowOccurrenceInput): string {
    this.assertChapterInWork(input.chapterId, workId);
    const occurrenceId = id("foreshadowOccurrence");
    const timestamp = now();
    this.db.run(
      `INSERT INTO foreshadow_occurrences (id, foreshadow_id, chapter_id, role, note, evidence_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      occurrenceId,
      foreshadowId,
      input.chapterId,
      input.role,
      input.note ?? "",
      JSON.stringify(input.evidence ?? []),
      timestamp,
      timestamp
    );
    return occurrenceId;
  }

  private getForeshadowOccurrence(occurrenceId: string): Record<string, unknown> {
    const row = this.db.get(
      `SELECT fo.*, c.title AS chapter_title, c.volume_id, v.title AS volume_title
       FROM foreshadow_occurrences fo JOIN chapters c ON c.id = fo.chapter_id
       JOIN volumes v ON v.id = c.volume_id WHERE fo.id = ?`,
      occurrenceId
    );
    if (!row) throw notFound("伏笔章节记录");
    return this.mapForeshadowOccurrence(row);
  }

  private mapForeshadowOccurrence(row: Row): Record<string, unknown> {
    return {
      id: requiredString(row, "id"),
      foreshadowId: requiredString(row, "foreshadow_id"),
      chapterId: requiredString(row, "chapter_id"),
      chapterTitle: requiredString(row, "chapter_title"),
      volumeId: requiredString(row, "volume_id"),
      volumeTitle: requiredString(row, "volume_title"),
      role: requiredString(row, "role"),
      note: requiredString(row, "note"),
      evidence: json(requiredString(row, "evidence_json"), []),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  private assertChapterInWork(chapterId: string, workId: string): void {
    const chapter = this.getChapter(chapterId);
    if (chapter.workId !== workId) throw new AppError(400, "CHAPTER_WORK_MISMATCH", "章节不属于当前作品");
  }

  private chapterSequence(workId: string, chapterId: string): number {
    const row = this.db.get(
      `SELECT v.sort_order * 1000000 + c.sort_order AS sequence
       FROM chapters c JOIN volumes v ON v.id = c.volume_id WHERE c.id = ? AND c.work_id = ?`,
      chapterId,
      workId
    );
    return row ? numberValue(row, "sequence") : Number.MAX_SAFE_INTEGER;
  }

  createSetting(workId: string, input: SettingInput): Record<string, unknown> {
    this.getWork(workId);
    const settingId = id("setting");
    const timestamp = now();
    this.db.run(
      `INSERT INTO settings (id, work_id, title, category, content, tags_json, status, locked, evidence_json, scope_json, author_note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      settingId,
      workId,
      input.title,
      input.category,
      input.content,
      JSON.stringify(input.tags ?? []),
      input.status ?? "draft",
      input.locked ? 1 : 0,
      JSON.stringify(input.evidence ?? []),
      JSON.stringify(input.scope ?? {}),
      input.authorNote ?? "",
      timestamp,
      timestamp
    );
    this.audit(workId, "setting.created", "setting", settingId, { locked: input.locked ?? false });
    return this.getSetting(settingId);
  }

  listSettings(workId: string): Record<string, unknown>[] {
    this.getWork(workId);
    return this.db.all("SELECT * FROM settings WHERE work_id = ? ORDER BY locked DESC, category, title", workId).map((row) => this.mapSetting(row));
  }

  getSetting(settingId: string): Record<string, unknown> {
    const row = this.db.get("SELECT * FROM settings WHERE id = ?", settingId);
    if (!row) throw notFound("设定");
    return this.mapSetting(row);
  }

  updateSetting(settingId: string, input: Partial<SettingInput>): Record<string, unknown> {
    const current = this.getSetting(settingId);
    this.db.run(
      `UPDATE settings SET title = ?, category = ?, content = ?, tags_json = ?, status = ?, locked = ?,
       evidence_json = ?, scope_json = ?, author_note = ?, updated_at = ? WHERE id = ?`,
      input.title ?? String(current.title),
      input.category ?? String(current.category),
      input.content ?? String(current.content),
      JSON.stringify(input.tags ?? current.tags),
      input.status ?? String(current.status),
      (input.locked ?? Boolean(current.locked)) ? 1 : 0,
      JSON.stringify(input.evidence ?? current.evidence),
      JSON.stringify(input.scope ?? current.scope),
      input.authorNote ?? String(current.authorNote),
      now(),
      settingId
    );
    this.audit(String(current.workId), "setting.updated", "setting", settingId, { fields: Object.keys(input) });
    return this.getSetting(settingId);
  }

  deleteSetting(settingId: string): void {
    const current = this.getSetting(settingId);
    this.db.run("DELETE FROM settings WHERE id = ?", settingId);
    this.audit(String(current.workId), "setting.deleted", "setting", settingId);
  }

  private mapSetting(row: Row): Record<string, unknown> {
    return {
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      title: requiredString(row, "title"),
      category: requiredString(row, "category"),
      content: requiredString(row, "content"),
      tags: json(requiredString(row, "tags_json"), []),
      status: requiredString(row, "status"),
      locked: booleanValue(row, "locked"),
      evidence: json(requiredString(row, "evidence_json"), []),
      scope: json(requiredString(row, "scope_json"), {}),
      authorNote: requiredString(row, "author_note"),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  createOrganization(workId: string, input: OrganizationInput): Record<string, unknown> {
    this.getWork(workId);
    const name = input.name.normalize("NFKC").trim().replace(/\s+/gu, " ");
    const normalizedName = normalizeCharacterName(name);
    if (!normalizedName) throw new AppError(400, "ORGANIZATION_NAME_REQUIRED", "组织名称不能为空");
    this.assertOrganizationNameAvailable(workId, normalizedName);
    const memberIds = [...new Set(input.memberIds ?? [])];
    this.assertCharactersInWork(workId, memberIds);
    const memberSnapshots = this.captureCharacterSnapshots(memberIds);
    const organizationId = id("organization");
    const timestamp = now();
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO organizations (id, work_id, name, normalized_name, description, settings_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        organizationId,
        workId,
        name,
        normalizedName,
        input.description ?? "",
        JSON.stringify(input.settings ?? []),
        timestamp,
        timestamp
      );
      this.replaceOrganizationMembers(organizationId, memberIds);
      this.recordMembershipVersions(memberSnapshots, "organization", organizationId, `加入组织“${name}”`);
      this.audit(workId, "organization.created", "organization", organizationId);
    });
    return this.getOrganization(organizationId);
  }

  listOrganizations(workId: string): Record<string, unknown>[] {
    this.getWork(workId);
    return this.db.all("SELECT * FROM organizations WHERE work_id = ? ORDER BY name", workId).map((row) => this.mapOrganization(row));
  }

  getOrganization(organizationId: string): Record<string, unknown> {
    const row = this.db.get("SELECT * FROM organizations WHERE id = ?", organizationId);
    if (!row) throw notFound("组织");
    return this.mapOrganization(row);
  }

  updateOrganization(organizationId: string, input: Partial<OrganizationInput>): Record<string, unknown> {
    const current = this.getOrganization(organizationId);
    const workId = String(current.workId);
    const name = input.name === undefined
      ? String(current.name)
      : input.name.normalize("NFKC").trim().replace(/\s+/gu, " ");
    const normalizedName = normalizeCharacterName(name);
    if (!normalizedName) throw new AppError(400, "ORGANIZATION_NAME_REQUIRED", "组织名称不能为空");
    this.assertOrganizationNameAvailable(workId, normalizedName, organizationId);
    const memberIds = input.memberIds === undefined ? null : [...new Set(input.memberIds)];
    if (memberIds) this.assertCharactersInWork(workId, memberIds);
    const touchedMemberIds = memberIds ? [...new Set([...(current.memberIds as string[]), ...memberIds])] : [];
    const memberSnapshots = this.captureCharacterSnapshots(touchedMemberIds);
    this.db.transaction(() => {
      this.db.run(
        `UPDATE organizations SET name = ?, normalized_name = ?, description = ?, settings_json = ?, updated_at = ? WHERE id = ?`,
        name,
        normalizedName,
        input.description ?? String(current.description),
        JSON.stringify(input.settings ?? current.settings),
        now(),
        organizationId
      );
      if (memberIds) {
        this.replaceOrganizationMembers(organizationId, memberIds);
        this.recordMembershipVersions(memberSnapshots, "organization", organizationId, `组织“${name}”成员关系变更`);
      }
      this.audit(workId, "organization.updated", "organization", organizationId, { fields: Object.keys(input) });
    });
    return this.getOrganization(organizationId);
  }

  deleteOrganization(organizationId: string): void {
    const current = this.getOrganization(organizationId);
    const memberSnapshots = this.captureCharacterSnapshots(current.memberIds as string[]);
    this.db.transaction(() => {
      this.db.run("DELETE FROM organizations WHERE id = ?", organizationId);
      this.recordMembershipVersions(memberSnapshots, "organization", organizationId, `组织“${String(current.name)}”已删除`);
      this.audit(String(current.workId), "organization.deleted", "organization", organizationId);
    });
  }

  private mapOrganization(row: Row): Record<string, unknown> {
    const members = this.db.all(
      `SELECT c.id, c.name, m.role, m.note
       FROM character_organization_memberships m
       JOIN characters c ON c.id = m.character_id
       WHERE m.organization_id = ? ORDER BY c.name`,
      requiredString(row, "id")
    ).map((member) => ({
      characterId: requiredString(member, "id"),
      name: requiredString(member, "name"),
      role: requiredString(member, "role"),
      note: requiredString(member, "note")
    }));
    return {
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      name: requiredString(row, "name"),
      description: requiredString(row, "description"),
      settings: json(requiredString(row, "settings_json"), []),
      memberIds: members.map((member) => member.characterId),
      members,
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  private assertOrganizationNameAvailable(workId: string, normalizedName: string, excludeOrganizationId?: string): void {
    const row = this.db.get(
      `SELECT id FROM organizations WHERE work_id = ? AND normalized_name = ?${excludeOrganizationId ? " AND id <> ?" : ""}`,
      ...([workId, normalizedName, ...(excludeOrganizationId ? [excludeOrganizationId] : [])])
    );
    if (row) throw new AppError(409, "ORGANIZATION_NAME_CONFLICT", "同一作品内的组织名称不能重复", { organizationId: requiredString(row, "id") });
  }

  private assertCharactersInWork(workId: string, characterIds: string[]): void {
    for (const characterId of characterIds) {
      const character = this.getCharacter(characterId);
      if (character.workId !== workId) throw new AppError(400, "CHARACTER_WORK_MISMATCH", "组织成员不属于当前作品");
    }
  }

  private assertOrganizationsInWork(workId: string, organizationIds: string[]): void {
    for (const organizationId of organizationIds) {
      const organization = this.getOrganization(organizationId);
      if (organization.workId !== workId) throw new AppError(400, "ORGANIZATION_WORK_MISMATCH", "角色绑定的组织不属于当前作品");
    }
  }

  private replaceOrganizationMembers(organizationId: string, memberIds: string[]): void {
    const timestamp = now();
    this.db.run("DELETE FROM character_organization_memberships WHERE organization_id = ?", organizationId);
    for (const characterId of memberIds) {
      this.db.run(
        `INSERT INTO character_organization_memberships (character_id, organization_id, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
        characterId,
        organizationId,
        timestamp,
        timestamp
      );
    }
  }

  private replaceCharacterOrganizations(characterId: string, organizationIds: string[]): void {
    const timestamp = now();
    this.db.run("DELETE FROM character_organization_memberships WHERE character_id = ?", characterId);
    for (const organizationId of organizationIds) {
      this.db.run(
        `INSERT INTO character_organization_memberships (character_id, organization_id, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
        characterId,
        organizationId,
        timestamp,
        timestamp
      );
    }
  }

  private characterSnapshot(character: Record<string, unknown>): CharacterSnapshot {
    return {
      name: String(character.name),
      aliases: [...(character.aliases as string[])],
      species: String(character.species),
      organizationIds: [...(character.organizationIds as string[])].sort(),
      attributes: character.attributes as Record<string, unknown>,
      profile: character.profile as Record<string, unknown>,
      currentState: character.currentState as Record<string, unknown>,
      lockedFields: [...(character.lockedFields as string[])],
      visibility: String(character.visibility),
      firstChapterId: character.firstChapterId as string | null
    };
  }

  private captureCharacterSnapshots(characterIds: string[]): Map<string, CharacterSnapshot> {
    return new Map(characterIds.map((characterId) => [characterId, this.characterSnapshot(this.getCharacter(characterId))]));
  }

  private snapshotsEqual(left: CharacterSnapshot, right: CharacterSnapshot): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
  }

  private insertCharacterVersion(
    characterId: string,
    versionNo: number,
    source: string,
    sourceRef: string | null,
    changeNote: string,
    timestamp = now()
  ): void {
    const snapshot = this.characterSnapshot(this.getCharacter(characterId));
    this.db.run(
      `INSERT INTO character_versions (id, character_id, version_no, snapshot_json, source, source_ref, change_note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id("characterVersion"),
      characterId,
      versionNo,
      JSON.stringify(snapshot),
      source,
      sourceRef,
      changeNote.trim(),
      timestamp
    );
  }

  private recordMembershipVersions(
    snapshots: Map<string, CharacterSnapshot>,
    source: string,
    sourceRef: string,
    changeNote: string
  ): void {
    for (const [characterId, before] of snapshots) {
      const current = this.getCharacter(characterId);
      if (this.snapshotsEqual(before, this.characterSnapshot(current))) continue;
      const versionNo = Number(current.versionNo) + 1;
      const timestamp = now();
      this.db.run("UPDATE characters SET version_no = ?, updated_at = ? WHERE id = ?", versionNo, timestamp, characterId);
      this.insertCharacterVersion(characterId, versionNo, source, sourceRef, changeNote, timestamp);
      this.audit(String(current.workId), "character.versioned", "character", characterId, { versionNo, source, sourceRef });
    }
  }

  createCharacter(workId: string, input: CharacterInput): Record<string, unknown> {
    this.getWork(workId);
    const characterId = id("character");
    const timestamp = now();
    const names = this.prepareCharacterNames(input.name, input.aliases ?? []);
    const legacySpecies = typeof input.attributes?.species === "string" ? input.attributes.species.trim() : "";
    const species = input.species?.trim() || legacySpecies;
    this.assertCharacterNamesAvailable(workId, names.entries);
    if (input.firstChapterId) this.assertChapterInWork(input.firstChapterId, workId);
    const organizationIds = [...new Set(input.organizationIds ?? [])];
    this.assertOrganizationsInWork(workId, organizationIds);
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO characters (id, work_id, name, aliases_json, species, attributes_json, profile_json, current_state_json,
         locked_fields_json, visibility, first_chapter_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        characterId,
        workId,
        names.name,
        JSON.stringify(names.aliases),
        species,
        JSON.stringify(input.attributes ?? {}),
        JSON.stringify(input.profile ?? {}),
        JSON.stringify(input.currentState ?? {}),
        JSON.stringify(input.lockedFields ?? []),
        input.visibility ?? "author",
        input.firstChapterId ?? null,
        timestamp,
        timestamp
      );
      this.insertCharacterNames(workId, characterId, names.entries);
      this.replaceCharacterOrganizations(characterId, organizationIds);
      this.insertCharacterVersion(characterId, 1, "create", null, "建立人物档案", timestamp);
      this.audit(workId, "character.created", "character", characterId);
    });
    return this.getCharacter(characterId);
  }

  listCharacters(workId: string): Record<string, unknown>[] {
    this.getWork(workId);
    return this.db.all("SELECT * FROM characters WHERE work_id = ? ORDER BY name", workId).map((row) => this.mapCharacter(row));
  }

  getCharacter(characterId: string): Record<string, unknown> {
    const row = this.db.get("SELECT * FROM characters WHERE id = ?", characterId);
    if (!row) throw notFound("角色");
    return this.mapCharacter(row);
  }

  updateCharacter(
    characterId: string,
    input: Partial<CharacterInput>,
    source = "manual",
    sourceRef: string | null = null,
    changeNote = ""
  ): Record<string, unknown> {
    const current = this.getCharacter(characterId);
    const before = this.characterSnapshot(current);
    const workId = String(current.workId);
    const names = this.prepareCharacterNames(input.name ?? String(current.name), input.aliases ?? current.aliases as string[]);
    const attributes = input.attributes ?? current.attributes as Record<string, unknown>;
    const legacySpecies = typeof attributes.species === "string" ? attributes.species.trim() : "";
    const species = input.species === undefined ? String(current.species) || legacySpecies : input.species.trim();
    this.assertCharacterNamesAvailable(workId, names.entries, characterId);
    if (input.firstChapterId) this.assertChapterInWork(input.firstChapterId, workId);
    const organizationIds = input.organizationIds === undefined ? null : [...new Set(input.organizationIds)];
    if (organizationIds) this.assertOrganizationsInWork(workId, organizationIds);
    this.db.transaction(() => {
      this.db.run(
        `UPDATE characters SET name = ?, aliases_json = ?, species = ?, attributes_json = ?, profile_json = ?, current_state_json = ?,
         locked_fields_json = ?, visibility = ?, first_chapter_id = ?, updated_at = ? WHERE id = ?`,
        names.name,
        JSON.stringify(names.aliases),
        species,
        JSON.stringify(attributes),
        JSON.stringify(input.profile ?? current.profile),
        JSON.stringify(input.currentState ?? current.currentState),
        JSON.stringify(input.lockedFields ?? current.lockedFields),
        input.visibility ?? String(current.visibility),
        input.firstChapterId === undefined ? (current.firstChapterId as string | null) : input.firstChapterId,
        now(),
        characterId
      );
      this.db.run("DELETE FROM character_names WHERE character_id = ?", characterId);
      this.insertCharacterNames(workId, characterId, names.entries);
      if (organizationIds) this.replaceCharacterOrganizations(characterId, organizationIds);
      const updated = this.getCharacter(characterId);
      if (!this.snapshotsEqual(before, this.characterSnapshot(updated))) {
        const versionNo = Number(current.versionNo) + 1;
        const timestamp = now();
        this.db.run("UPDATE characters SET version_no = ?, updated_at = ? WHERE id = ?", versionNo, timestamp, characterId);
        this.insertCharacterVersion(characterId, versionNo, source, sourceRef, changeNote || "更新人物档案", timestamp);
        this.audit(workId, "character.updated", "character", characterId, { fields: Object.keys(input), versionNo, source, sourceRef });
      }
    });
    return this.getCharacter(characterId);
  }

  listCharacterVersions(characterId: string): Record<string, unknown>[] {
    this.getCharacter(characterId);
    return this.db.all("SELECT * FROM character_versions WHERE character_id = ? ORDER BY version_no DESC", characterId).map((row) => ({
      id: requiredString(row, "id"),
      characterId: requiredString(row, "character_id"),
      versionNo: numberValue(row, "version_no"),
      snapshot: json(requiredString(row, "snapshot_json"), {}),
      source: requiredString(row, "source"),
      sourceRef: optionalString(row, "source_ref"),
      changeNote: requiredString(row, "change_note"),
      createdAt: requiredString(row, "created_at")
    }));
  }

  restoreCharacter(characterId: string, versionNo: number): Record<string, unknown> {
    const version = this.db.get("SELECT * FROM character_versions WHERE character_id = ? AND version_no = ?", characterId, versionNo);
    if (!version) throw notFound("人物版本");
    const snapshot = json<CharacterSnapshot>(requiredString(version, "snapshot_json"), {} as CharacterSnapshot);
    if (!snapshot.name) throw new AppError(500, "CHARACTER_VERSION_INVALID", "人物版本快照无效");
    return this.updateCharacter(
      characterId,
      snapshot,
      "restore",
      requiredString(version, "id"),
      `恢复至 v${versionNo}`
    );
  }

  deleteCharacter(characterId: string): void {
    const current = this.getCharacter(characterId);
    this.db.run("DELETE FROM characters WHERE id = ?", characterId);
    this.audit(String(current.workId), "character.deleted", "character", characterId);
  }

  private mapCharacter(row: Row): Record<string, unknown> {
    const indexedAliases = this.db.all(
      "SELECT display_name FROM character_names WHERE character_id = ? AND kind = 'alias' ORDER BY sort_order",
      requiredString(row, "id")
    ).map((item) => requiredString(item, "display_name"));
    const organizations = this.db.all(
      `SELECT o.id, o.name, m.role, m.note
       FROM character_organization_memberships m
       JOIN organizations o ON o.id = m.organization_id
       WHERE m.character_id = ? ORDER BY o.name`,
      requiredString(row, "id")
    ).map((item) => ({
      organizationId: requiredString(item, "id"),
      name: requiredString(item, "name"),
      role: requiredString(item, "role"),
      note: requiredString(item, "note")
    }));
    return {
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      name: requiredString(row, "name"),
      aliases: indexedAliases.length > 0 ? indexedAliases : json(requiredString(row, "aliases_json"), []),
      species: requiredString(row, "species"),
      organizationIds: organizations.map((organization) => organization.organizationId),
      organizations,
      attributes: json(requiredString(row, "attributes_json"), {}),
      profile: json(requiredString(row, "profile_json"), {}),
      currentState: json(requiredString(row, "current_state_json"), {}),
      lockedFields: json(requiredString(row, "locked_fields_json"), []),
      visibility: requiredString(row, "visibility"),
      firstChapterId: optionalString(row, "first_chapter_id"),
      versionNo: numberValue(row, "version_no"),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  resolveCharacterReference(workId: string, value: string): string | null {
    const normalizedName = normalizeCharacterName(value);
    if (!normalizedName) return null;
    const row = this.db.get(
      "SELECT character_id FROM character_names WHERE work_id = ? AND normalized_name = ?",
      workId,
      normalizedName
    );
    return row ? requiredString(row, "character_id") : null;
  }

  private prepareCharacterNames(name: string, aliases: string[]): {
    name: string;
    aliases: string[];
    entries: Array<{ normalizedName: string; displayName: string; kind: "primary" | "alias"; sortOrder: number }>;
  } {
    const primary = name.normalize("NFKC").trim().replace(/\s+/gu, " ");
    if (!primary) throw new AppError(400, "CHARACTER_NAME_REQUIRED", "角色标准名不能为空");
    const cleanedAliases = aliases.map((alias) => alias.normalize("NFKC").trim().replace(/\s+/gu, " ")).filter(Boolean);
    const entries = [
      { normalizedName: normalizeCharacterName(primary), displayName: primary, kind: "primary" as const, sortOrder: 0 },
      ...cleanedAliases.map((alias, index) => ({ normalizedName: normalizeCharacterName(alias), displayName: alias, kind: "alias" as const, sortOrder: index + 1 }))
    ];
    const seen = new Map<string, string>();
    for (const entry of entries) {
      const existing = seen.get(entry.normalizedName);
      if (existing) {
        throw new AppError(409, "CHARACTER_NAME_CONFLICT", `角色名或别名重复：${existing} / ${entry.displayName}`, {
          normalizedName: entry.normalizedName
        });
      }
      seen.set(entry.normalizedName, entry.displayName);
    }
    return { name: primary, aliases: cleanedAliases, entries };
  }

  private assertCharacterNamesAvailable(
    workId: string,
    entries: Array<{ normalizedName: string; displayName: string }>,
    excludeCharacterId?: string
  ): void {
    for (const entry of entries) {
      const row = this.db.get(
        `SELECT character_id, display_name FROM character_names
         WHERE work_id = ? AND normalized_name = ?${excludeCharacterId ? " AND character_id <> ?" : ""}`,
        ...([workId, entry.normalizedName, ...(excludeCharacterId ? [excludeCharacterId] : [])])
      );
      if (row) {
        throw new AppError(409, "CHARACTER_NAME_CONFLICT", `角色名或别名“${entry.displayName}”已被使用`, {
          conflictingCharacterId: requiredString(row, "character_id"),
          conflictingName: requiredString(row, "display_name")
        });
      }
    }
  }

  private insertCharacterNames(
    workId: string,
    characterId: string,
    entries: Array<{ normalizedName: string; displayName: string; kind: "primary" | "alias"; sortOrder: number }>
  ): void {
    for (const entry of entries) {
      this.db.run(
        `INSERT INTO character_names (work_id, normalized_name, character_id, display_name, kind, sort_order)
         VALUES (?, ?, ?, ?, ?, ?)`,
        workId,
        entry.normalizedName,
        characterId,
        entry.displayName,
        entry.kind,
        entry.sortOrder
      );
    }
  }

  createTimelineTrack(workId: string, input: TimelineTrackInput): Record<string, unknown> {
    this.getWork(workId);
    const trackId = id("timeline-track");
    const timestamp = now();
    const fallbackOrder = Number(this.db.get("SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM timeline_tracks WHERE work_id = ?", workId)?.value ?? 0);
    this.db.run(
      `INSERT INTO timeline_tracks (id, work_id, name, description, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      trackId,
      workId,
      input.name,
      input.description ?? "",
      input.sortOrder ?? fallbackOrder,
      timestamp,
      timestamp
    );
    this.audit(workId, "timeline-track.created", "timeline-track", trackId);
    return this.getTimelineTrack(trackId);
  }

  listTimelineTracks(workId: string): Record<string, unknown>[] {
    this.getWork(workId);
    return this.db.all("SELECT * FROM timeline_tracks WHERE work_id = ? ORDER BY sort_order, created_at", workId).map((row) => this.mapTimelineTrack(row));
  }

  getTimelineTrack(trackId: string): Record<string, unknown> {
    const row = this.db.get("SELECT * FROM timeline_tracks WHERE id = ?", trackId);
    if (!row) throw notFound("独立时间轴");
    return this.mapTimelineTrack(row);
  }

  updateTimelineTrack(trackId: string, input: Partial<TimelineTrackInput>): Record<string, unknown> {
    const current = this.getTimelineTrack(trackId);
    this.db.run(
      "UPDATE timeline_tracks SET name = ?, description = ?, sort_order = ?, updated_at = ? WHERE id = ?",
      input.name ?? String(current.name),
      input.description ?? String(current.description),
      input.sortOrder ?? Number(current.sortOrder),
      now(),
      trackId
    );
    this.audit(String(current.workId), "timeline-track.updated", "timeline-track", trackId, { fields: Object.keys(input) });
    return this.getTimelineTrack(trackId);
  }

  deleteTimelineTrack(trackId: string): void {
    const current = this.getTimelineTrack(trackId);
    this.db.run("DELETE FROM timeline_tracks WHERE id = ?", trackId);
    this.audit(String(current.workId), "timeline-track.deleted", "timeline-track", trackId);
  }

  createTimelineEvent(workId: string, input: TimelineInput): Record<string, unknown> {
    this.getWork(workId);
    if (input.trackId) {
      const track = this.getTimelineTrack(input.trackId);
      if (track.workId !== workId) throw new AppError(400, "TIMELINE_TRACK_WORK_MISMATCH", "独立时间轴不属于当前作品");
    }
    const eventId = id("event");
    const timestamp = now();
    this.db.run(
      `INSERT INTO timeline_events (id, work_id, track_id, name, description, event_type, time_label, time_sort, chapter_ids_json,
       participant_ids_json, location, causes_json, impact_scope, evidence_json, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      eventId,
      workId,
      input.trackId ?? null,
      input.name,
      input.description ?? "",
      input.eventType ?? "other",
      input.timeLabel ?? "时间待定",
      input.timeSort ?? null,
      JSON.stringify(input.chapterIds ?? []),
      JSON.stringify(input.participantIds ?? []),
      input.location ?? "",
      JSON.stringify(input.causes ?? []),
      input.impactScope ?? "personal",
      JSON.stringify(input.evidence ?? []),
      input.status ?? "candidate",
      timestamp,
      timestamp
    );
    this.audit(workId, "timeline.created", "timeline-event", eventId);
    return this.getTimelineEvent(eventId);
  }

  listTimelineEvents(workId: string): Record<string, unknown>[] {
    this.getWork(workId);
    return this.db
      .all("SELECT * FROM timeline_events WHERE work_id = ? ORDER BY time_sort IS NULL, time_sort, created_at", workId)
      .map((row) => this.mapTimelineEvent(row));
  }

  getTimelineEvent(eventId: string): Record<string, unknown> {
    const row = this.db.get("SELECT * FROM timeline_events WHERE id = ?", eventId);
    if (!row) throw notFound("时间线事件");
    return this.mapTimelineEvent(row);
  }

  updateTimelineEvent(eventId: string, input: Partial<TimelineInput>): Record<string, unknown> {
    const current = this.getTimelineEvent(eventId);
    if (input.trackId) {
      const track = this.getTimelineTrack(input.trackId);
      if (track.workId !== current.workId) throw new AppError(400, "TIMELINE_TRACK_WORK_MISMATCH", "独立时间轴不属于当前作品");
    }
    this.db.run(
      `UPDATE timeline_events SET track_id = ?, name = ?, description = ?, event_type = ?, time_label = ?, time_sort = ?,
       chapter_ids_json = ?, participant_ids_json = ?, location = ?, causes_json = ?, impact_scope = ?, evidence_json = ?,
       status = ?, updated_at = ? WHERE id = ?`,
      input.trackId === undefined ? (current.trackId as string | null) : input.trackId,
      input.name ?? String(current.name),
      input.description ?? String(current.description),
      input.eventType ?? String(current.eventType),
      input.timeLabel ?? String(current.timeLabel),
      input.timeSort === undefined ? (current.timeSort as number | null) : input.timeSort,
      JSON.stringify(input.chapterIds ?? current.chapterIds),
      JSON.stringify(input.participantIds ?? current.participantIds),
      input.location ?? String(current.location),
      JSON.stringify(input.causes ?? current.causes),
      input.impactScope ?? String(current.impactScope),
      JSON.stringify(input.evidence ?? current.evidence),
      input.status ?? String(current.status),
      now(),
      eventId
    );
    this.audit(String(current.workId), "timeline.updated", "timeline-event", eventId, { fields: Object.keys(input) });
    return this.getTimelineEvent(eventId);
  }

  deleteTimelineEvent(eventId: string): void {
    const current = this.getTimelineEvent(eventId);
    this.db.run("DELETE FROM timeline_events WHERE id = ?", eventId);
    this.audit(String(current.workId), "timeline.deleted", "timeline-event", eventId);
  }

  mergeTimelineEvents(
    workId: string,
    eventIds: string[],
    input: { name: string; description?: string; timeLabel?: string; timeSort?: number | null }
  ): Record<string, unknown> {
    this.getWork(workId);
    const uniqueIds = [...new Set(eventIds)];
    if (uniqueIds.length < 2) throw new AppError(400, "EVENTS_REQUIRED", "合并时间事件至少需要选择两项");
    const events = uniqueIds.map((eventId) => this.getTimelineEvent(eventId));
    if (events.some((event) => event.workId !== workId)) throw new AppError(400, "EVENT_WORK_MISMATCH", "时间事件不属于当前作品");
    const union = (key: string): unknown[] => {
      const values = events.flatMap((event) => Array.isArray(event[key]) ? event[key] as unknown[] : []);
      return [...new Map(values.map((value) => [JSON.stringify(value), value])).values()];
    };
    const knownSorts = events.map((event) => event.timeSort).filter((value): value is number => typeof value === "number");
    return this.db.transaction(() => {
      const merged = this.createTimelineEvent(workId, {
        name: input.name,
        trackId: events.every((event) => event.trackId === events[0]?.trackId) ? (events[0]?.trackId as string | null) : null,
        description: input.description ?? events.map((event) => String(event.description)).filter(Boolean).join("\n"),
        eventType: String(events[0]?.eventType ?? "other"),
        timeLabel: input.timeLabel ?? String(events[0]?.timeLabel ?? "时间待定"),
        timeSort: input.timeSort === undefined ? (knownSorts.length ? Math.min(...knownSorts) : null) : input.timeSort,
        chapterIds: union("chapterIds").filter((value): value is string => typeof value === "string"),
        participantIds: union("participantIds").filter((value): value is string => typeof value === "string"),
        location: [...new Set(events.map((event) => String(event.location)).filter(Boolean))].join(" / "),
        causes: union("causes").filter((value): value is string => typeof value === "string"),
        impactScope: String(events[0]?.impactScope ?? "personal"),
        evidence: union("evidence"),
        status: events.every((event) => event.status === "confirmed") ? "confirmed" : "pending"
      });
      for (const eventId of uniqueIds) this.db.run("DELETE FROM timeline_events WHERE id = ?", eventId);
      this.audit(workId, "timeline.merged", "timeline-event", String(merged.id), { sourceEventIds: uniqueIds });
      return merged;
    });
  }

  splitTimelineEvent(
    eventId: string,
    parts: Array<{ name: string; description?: string; timeLabel?: string; timeSort?: number | null }>
  ): Record<string, unknown>[] {
    const source = this.getTimelineEvent(eventId);
    if (parts.length < 2) throw new AppError(400, "EVENT_PARTS_REQUIRED", "拆分时间事件至少需要两项");
    return this.db.transaction(() => {
      const created = parts.map((part, index) => this.createTimelineEvent(String(source.workId), {
        name: part.name,
        trackId: source.trackId as string | null,
        description: part.description ?? String(source.description),
        eventType: String(source.eventType),
        timeLabel: part.timeLabel ?? String(source.timeLabel),
        timeSort: part.timeSort === undefined
          ? (typeof source.timeSort === "number" ? source.timeSort + index / 100 : null)
          : part.timeSort,
        chapterIds: source.chapterIds as string[],
        participantIds: source.participantIds as string[],
        location: String(source.location),
        causes: source.causes as string[],
        impactScope: String(source.impactScope),
        evidence: source.evidence as unknown[],
        status: String(source.status)
      }));
      this.db.run("DELETE FROM timeline_events WHERE id = ?", eventId);
      this.audit(String(source.workId), "timeline.split", "timeline-event", eventId, { createdEventIds: created.map((event) => event.id) });
      return created;
    });
  }

  private mapTimelineEvent(row: Row): Record<string, unknown> {
    return {
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      trackId: row.track_id === null ? null : requiredString(row, "track_id"),
      name: requiredString(row, "name"),
      description: requiredString(row, "description"),
      eventType: requiredString(row, "event_type"),
      timeLabel: requiredString(row, "time_label"),
      timeSort: row.time_sort === null ? null : numberValue(row, "time_sort"),
      chapterIds: json(requiredString(row, "chapter_ids_json"), []),
      participantIds: json(requiredString(row, "participant_ids_json"), []),
      location: requiredString(row, "location"),
      causes: json(requiredString(row, "causes_json"), []),
      impactScope: requiredString(row, "impact_scope"),
      evidence: json(requiredString(row, "evidence_json"), []),
      status: requiredString(row, "status"),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  private mapTimelineTrack(row: Row): Record<string, unknown> {
    return {
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      name: requiredString(row, "name"),
      description: requiredString(row, "description"),
      sortOrder: numberValue(row, "sort_order"),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  createRelationship(workId: string, input: RelationshipInput): Record<string, unknown> {
    this.getWork(workId);
    let fromCharacterId = input.fromCharacterId;
    let toCharacterId = input.toCharacterId;
    if (fromCharacterId === toCharacterId) throw new AppError(400, "SELF_RELATIONSHIP", "人物关系不能指向自身");
    const from = this.getCharacter(fromCharacterId);
    const to = this.getCharacter(toCharacterId);
    if (from.workId !== workId || to.workId !== workId) throw new AppError(400, "CHARACTER_WORK_MISMATCH", "关系人物不属于当前作品");
    if (!input.directed && fromCharacterId.localeCompare(toCharacterId) > 0) [fromCharacterId, toCharacterId] = [toCharacterId, fromCharacterId];
    this.assertRelationshipUnique(workId, fromCharacterId, toCharacterId, input.category, input.subtype ?? "", Boolean(input.directed));
    const relationshipId = id("relationship");
    const timestamp = now();
    const keywords = this.normalizeRelationshipKeywords(input.keywords ?? []);
    this.db.run(
      `INSERT INTO relationships (id, work_id, from_character_id, to_character_id, category, subtype, keywords_json, directed,
       current_status, time_range_json, confidence, evidence_json, confirmation_status, locked, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      relationshipId,
      workId,
      fromCharacterId,
      toCharacterId,
      input.category,
      input.subtype ?? "",
      JSON.stringify(keywords),
      input.directed ? 1 : 0,
      input.currentStatus ?? "active",
      JSON.stringify(input.timeRange ?? {}),
      input.confidence ?? 0.5,
      JSON.stringify(input.evidence ?? []),
      input.confirmationStatus ?? "pending",
      input.locked ? 1 : 0,
      timestamp,
      timestamp
    );
    this.audit(workId, "relationship.created", "relationship", relationshipId);
    return this.getRelationship(relationshipId);
  }

  listRelationships(workId: string, minimumConfidence = 0): Record<string, unknown>[] {
    this.getWork(workId);
    return this.db
      .all("SELECT * FROM relationships WHERE work_id = ? AND confidence >= ? ORDER BY confidence DESC, created_at", workId, minimumConfidence)
      .map((row) => this.mapRelationship(row));
  }

  getRelationship(relationshipId: string): Record<string, unknown> {
    const row = this.db.get("SELECT * FROM relationships WHERE id = ?", relationshipId);
    if (!row) throw notFound("人物关系");
    return this.mapRelationship(row);
  }

  updateRelationship(relationshipId: string, input: Partial<RelationshipInput>): Record<string, unknown> {
    const current = this.getRelationship(relationshipId);
    let fromCharacterId = input.fromCharacterId ?? String(current.fromCharacterId);
    let toCharacterId = input.toCharacterId ?? String(current.toCharacterId);
    if (fromCharacterId === toCharacterId) throw new AppError(400, "SELF_RELATIONSHIP", "人物关系不能指向自身");
    const from = this.getCharacter(fromCharacterId);
    const to = this.getCharacter(toCharacterId);
    if (from.workId !== current.workId || to.workId !== current.workId) throw new AppError(400, "CHARACTER_WORK_MISMATCH", "关系人物不属于当前作品");
    const directed = input.directed ?? Boolean(current.directed);
    if (!directed && fromCharacterId.localeCompare(toCharacterId) > 0) [fromCharacterId, toCharacterId] = [toCharacterId, fromCharacterId];
    this.assertRelationshipUnique(
      String(current.workId),
      fromCharacterId,
      toCharacterId,
      input.category ?? String(current.category),
      input.subtype ?? String(current.subtype),
      directed,
      relationshipId
    );
    this.db.run(
      `UPDATE relationships SET from_character_id = ?, to_character_id = ?, category = ?, subtype = ?, keywords_json = ?, directed = ?,
       current_status = ?, time_range_json = ?, confidence = ?, evidence_json = ?, confirmation_status = ?, locked = ?, updated_at = ?
       WHERE id = ?`,
      fromCharacterId,
      toCharacterId,
      input.category ?? String(current.category),
      input.subtype ?? String(current.subtype),
      JSON.stringify(this.normalizeRelationshipKeywords(input.keywords ?? current.keywords as string[])),
      directed ? 1 : 0,
      input.currentStatus ?? String(current.currentStatus),
      JSON.stringify(input.timeRange ?? current.timeRange),
      input.confidence ?? Number(current.confidence),
      JSON.stringify(input.evidence ?? current.evidence),
      input.confirmationStatus ?? String(current.confirmationStatus),
      (input.locked ?? Boolean(current.locked)) ? 1 : 0,
      now(),
      relationshipId
    );
    this.audit(String(current.workId), "relationship.updated", "relationship", relationshipId, { fields: Object.keys(input) });
    return this.getRelationship(relationshipId);
  }

  deleteRelationship(relationshipId: string): void {
    const current = this.getRelationship(relationshipId);
    this.db.run("DELETE FROM relationships WHERE id = ?", relationshipId);
    this.audit(String(current.workId), "relationship.deleted", "relationship", relationshipId);
  }

  private mapRelationship(row: Row): Record<string, unknown> {
    return {
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      fromCharacterId: requiredString(row, "from_character_id"),
      toCharacterId: requiredString(row, "to_character_id"),
      category: requiredString(row, "category"),
      subtype: requiredString(row, "subtype"),
      keywords: json(requiredString(row, "keywords_json"), []),
      directed: booleanValue(row, "directed"),
      currentStatus: requiredString(row, "current_status"),
      timeRange: json(requiredString(row, "time_range_json"), {}),
      confidence: numberValue(row, "confidence"),
      evidence: json(requiredString(row, "evidence_json"), []),
      confirmationStatus: requiredString(row, "confirmation_status"),
      locked: booleanValue(row, "locked"),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  private normalizeRelationshipKeywords(keywords: string[]): string[] {
    const values = keywords.map((keyword) => keyword.normalize("NFKC").trim().replace(/\s+/gu, " ")).filter(Boolean);
    return [...new Map(values.map((keyword) => [keyword.toLocaleLowerCase("zh-CN"), keyword])).values()].slice(0, 30);
  }

  private assertRelationshipUnique(
    workId: string,
    fromCharacterId: string,
    toCharacterId: string,
    category: string,
    subtype: string,
    directed: boolean,
    excludeRelationshipId?: string
  ): void {
    const normalizedSubtype = subtype.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
    const duplicate = this.listRelationships(workId).find((relationship) => {
      if (excludeRelationshipId && relationship.id === excludeRelationshipId) return false;
      const same = relationship.fromCharacterId === fromCharacterId && relationship.toCharacterId === toCharacterId;
      const reverse = !directed && !relationship.directed
        && relationship.fromCharacterId === toCharacterId && relationship.toCharacterId === fromCharacterId;
      return (same || reverse)
        && Boolean(relationship.directed) === directed
        && relationship.category === category
        && String(relationship.subtype).normalize("NFKC").trim().toLocaleLowerCase("zh-CN") === normalizedSubtype
        && relationship.confirmationStatus !== "rejected";
    });
    if (duplicate) throw new AppError(409, "RELATIONSHIP_CONFLICT", "相同人物、类型与方向的关系已经存在", { relationshipId: duplicate.id });
  }

  createReviewItem(workId: string, input: ReviewInput): Record<string, unknown> {
    this.getWork(workId);
    const reviewId = id("review");
    const timestamp = now();
    this.db.run(
      `INSERT INTO review_items (id, work_id, item_type, severity, title, description, entity_refs_json, evidence_json,
       suggestion, status, resolution_note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      reviewId,
      workId,
      input.itemType,
      input.severity ?? "medium",
      input.title,
      input.description ?? "",
      JSON.stringify(input.entityRefs ?? []),
      JSON.stringify(input.evidence ?? []),
      input.suggestion ?? "",
      input.status ?? "pending",
      input.resolutionNote ?? "",
      timestamp,
      timestamp
    );
    return this.getReviewItem(reviewId);
  }

  listReviewItems(workId: string, status?: string): Record<string, unknown>[] {
    this.getWork(workId);
    const rows = status
      ? this.db.all("SELECT * FROM review_items WHERE work_id = ? AND status = ? ORDER BY created_at DESC", workId, status)
      : this.db.all("SELECT * FROM review_items WHERE work_id = ? ORDER BY created_at DESC", workId);
    return rows.map((row) => this.mapReviewItem(row));
  }

  getReviewItem(reviewId: string): Record<string, unknown> {
    const row = this.db.get("SELECT * FROM review_items WHERE id = ?", reviewId);
    if (!row) throw notFound("审核项");
    return this.mapReviewItem(row);
  }

  updateReviewItem(reviewId: string, input: Partial<ReviewInput>): Record<string, unknown> {
    const current = this.getReviewItem(reviewId);
    this.db.run(
      `UPDATE review_items SET item_type = ?, severity = ?, title = ?, description = ?, entity_refs_json = ?,
       evidence_json = ?, suggestion = ?, status = ?, resolution_note = ?, updated_at = ? WHERE id = ?`,
      input.itemType ?? String(current.itemType),
      input.severity ?? String(current.severity),
      input.title ?? String(current.title),
      input.description ?? String(current.description),
      JSON.stringify(input.entityRefs ?? current.entityRefs),
      JSON.stringify(input.evidence ?? current.evidence),
      input.suggestion ?? String(current.suggestion),
      input.status ?? String(current.status),
      input.resolutionNote ?? String(current.resolutionNote),
      now(),
      reviewId
    );
    this.audit(String(current.workId), "review.updated", "review", reviewId, { status: input.status });
    return this.getReviewItem(reviewId);
  }

  private mapReviewItem(row: Row): Record<string, unknown> {
    return {
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      itemType: requiredString(row, "item_type"),
      severity: requiredString(row, "severity"),
      title: requiredString(row, "title"),
      description: requiredString(row, "description"),
      entityRefs: json(requiredString(row, "entity_refs_json"), []),
      evidence: json(requiredString(row, "evidence_json"), []),
      suggestion: requiredString(row, "suggestion"),
      status: requiredString(row, "status"),
      resolutionNote: requiredString(row, "resolution_note"),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  createContinuationGuard(input: {
    suggestionId: string;
    callId?: string | null;
    chapterVersion: number;
    content: string;
    status: "clear" | "warning" | "failed";
    issues?: unknown[];
    contextRefs?: Record<string, unknown>;
    failure?: string | null;
  }): Record<string, unknown> {
    const suggestion = this.db.get("SELECT work_id FROM ai_suggestions WHERE id = ?", input.suggestionId);
    if (!suggestion) throw notFound("AI 建议");
    const guardId = id("guard");
    const contentHash = createHash("sha256").update(input.content).digest("hex");
    this.db.run(
      `INSERT INTO continuation_guard_runs (id, suggestion_id, call_id, chapter_version, content_hash,
       status, issues_json, context_refs_json, failure, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      guardId,
      input.suggestionId,
      input.callId ?? null,
      input.chapterVersion,
      contentHash,
      input.status,
      JSON.stringify(input.issues ?? []),
      JSON.stringify(input.contextRefs ?? {}),
      input.failure ?? null,
      now()
    );
    this.audit(requiredString(suggestion, "work_id"), "continuation.guard.created", "continuation-guard", guardId, {
      suggestionId: input.suggestionId,
      status: input.status,
      issueCount: input.issues?.length ?? 0
    });
    return this.getContinuationGuard(guardId);
  }

  getContinuationGuard(guardId: string): Record<string, unknown> {
    const row = this.db.get("SELECT * FROM continuation_guard_runs WHERE id = ?", guardId);
    if (!row) throw notFound("续写一致性检查");
    return this.mapContinuationGuard(row);
  }

  listContinuationGuards(suggestionId: string): Record<string, unknown>[] {
    const suggestion = this.db.get("SELECT id FROM ai_suggestions WHERE id = ?", suggestionId);
    if (!suggestion) throw notFound("AI 建议");
    return this.db.all(
      "SELECT * FROM continuation_guard_runs WHERE suggestion_id = ? ORDER BY created_at DESC",
      suggestionId
    ).map((row) => this.mapContinuationGuard(row));
  }

  getLatestContinuationGuard(suggestionId: string): Record<string, unknown> | null {
    const row = this.db.get(
      "SELECT * FROM continuation_guard_runs WHERE suggestion_id = ? ORDER BY created_at DESC LIMIT 1",
      suggestionId
    );
    return row ? this.mapContinuationGuard(row) : null;
  }

  createAiConversation(workId: string, title = "新对话"): Record<string, unknown> {
    this.getWork(workId);
    const conversationId = id("conversation");
    const timestamp = now();
    this.db.run(
      "INSERT INTO ai_conversations (id, work_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      conversationId,
      workId,
      title.trim() || "新对话",
      timestamp,
      timestamp
    );
    return this.getAiConversation(conversationId);
  }

  listAiConversations(workId: string): Record<string, unknown>[] {
    this.getWork(workId);
    return this.db.all(
      `SELECT conversation.*,
        (SELECT COUNT(*) FROM ai_conversation_messages message WHERE message.conversation_id = conversation.id) AS message_count,
        COALESCE((SELECT content FROM ai_conversation_messages message WHERE message.conversation_id = conversation.id ORDER BY message.created_at DESC, message.rowid DESC LIMIT 1), '') AS preview
       FROM ai_conversations conversation
       WHERE conversation.work_id = ?
       ORDER BY conversation.updated_at DESC, conversation.created_at DESC
       LIMIT 100`,
      workId
    ).map((row) => this.mapAiConversation(row));
  }

  getAiConversation(conversationId: string): Record<string, unknown> {
    const row = this.db.get("SELECT * FROM ai_conversations WHERE id = ?", conversationId);
    if (!row) throw notFound("AI 对话");
    const messages = this.db.all(
      "SELECT * FROM ai_conversation_messages WHERE conversation_id = ? ORDER BY created_at, rowid",
      conversationId
    ).map((message) => this.mapAiConversationMessage(message));
    return { ...this.mapAiConversation(row), messageCount: messages.length, messages };
  }

  addAiConversationMessage(conversationId: string, input: AiConversationMessageInput): Record<string, unknown> {
    const conversation = this.db.get("SELECT * FROM ai_conversations WHERE id = ?", conversationId);
    if (!conversation) throw notFound("AI 对话");
    const messageId = id("message");
    const timestamp = now();
    const title = requiredString(conversation, "title") === "新对话" && input.role === "user"
      ? input.content.replace(/\s+/gu, " ").trim().slice(0, 36) || "新对话"
      : requiredString(conversation, "title");
    this.db.transaction(() => {
      this.db.run(
        "INSERT INTO ai_conversation_messages (id, conversation_id, role, content, citations_json, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        messageId,
        conversationId,
        input.role,
        input.content,
        JSON.stringify(input.citations ?? []),
        JSON.stringify(input.metadata ?? {}),
        timestamp
      );
      this.db.run("UPDATE ai_conversations SET title = ?, updated_at = ? WHERE id = ?", title, timestamp, conversationId);
    });
    const message = this.db.get("SELECT * FROM ai_conversation_messages WHERE id = ?", messageId);
    if (!message) throw notFound("AI 对话消息");
    return this.mapAiConversationMessage(message);
  }

  forkAiConversation(conversationId: string, messageId: string, requestedTitle?: string): Record<string, unknown> {
    const conversation = this.db.get("SELECT * FROM ai_conversations WHERE id = ?", conversationId);
    if (!conversation) throw notFound("AI 对话");
    const messages = this.db.all(
      "SELECT * FROM ai_conversation_messages WHERE conversation_id = ? ORDER BY created_at, rowid",
      conversationId
    );
    const targetIndex = messages.findIndex((message) => requiredString(message, "id") === messageId);
    if (targetIndex < 0) throw notFound("AI 对话消息");
    const forkId = id("conversation");
    const timestamp = now();
    const sourceTitle = requiredString(conversation, "title");
    const title = requestedTitle?.trim() || `${sourceTitle} · 分支`;
    this.db.transaction(() => {
      this.db.run(
        "INSERT INTO ai_conversations (id, work_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        forkId,
        requiredString(conversation, "work_id"),
        title.slice(0, 200),
        timestamp,
        timestamp
      );
      for (const message of messages.slice(0, targetIndex + 1)) {
        this.db.run(
          "INSERT INTO ai_conversation_messages (id, conversation_id, role, content, citations_json, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
          id("message"),
          forkId,
          requiredString(message, "role"),
          requiredString(message, "content"),
          requiredString(message, "citations_json"),
          requiredString(message, "metadata_json"),
          requiredString(message, "created_at")
        );
      }
    });
    return this.getAiConversation(forkId);
  }

  private mapAiConversation(row: Row): Record<string, unknown> {
    return {
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      title: requiredString(row, "title"),
      messageCount: numberValue(row, "message_count"),
      preview: requiredString(row, "preview"),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  private mapAiConversationMessage(row: Row): Record<string, unknown> {
    return {
      id: requiredString(row, "id"),
      conversationId: requiredString(row, "conversation_id"),
      role: requiredString(row, "role"),
      content: requiredString(row, "content"),
      citations: json(requiredString(row, "citations_json"), []),
      metadata: json(requiredString(row, "metadata_json"), {}),
      createdAt: requiredString(row, "created_at")
    };
  }

  hashContent(content: string): string {
    return createHash("sha256").update(content).digest("hex");
  }

  private mapContinuationGuard(row: Row): Record<string, unknown> {
    return {
      id: requiredString(row, "id"),
      suggestionId: requiredString(row, "suggestion_id"),
      callId: optionalString(row, "call_id"),
      chapterVersion: numberValue(row, "chapter_version"),
      contentHash: requiredString(row, "content_hash"),
      status: requiredString(row, "status"),
      issues: json(requiredString(row, "issues_json"), []),
      contextRefs: json(requiredString(row, "context_refs_json"), {}),
      failure: optionalString(row, "failure"),
      createdAt: requiredString(row, "created_at")
    };
  }

  createTask(workId: string, input: { taskType: string; scope?: Record<string, unknown> }): Record<string, unknown> {
    this.getWork(workId);
    const taskId = id("task");
    const timestamp = now();
    const scope = input.scope ?? { type: "book" };
    const sourceVersions: Record<string, number> = {};
    if (typeof scope.chapterId === "string") {
      const chapter = this.getChapter(scope.chapterId);
      if (chapter.workId !== workId) throw new AppError(400, "CHAPTER_WORK_MISMATCH", "章节不属于当前作品");
      sourceVersions[scope.chapterId] = Number(chapter.versionNo);
    } else if (scope.type === "book" || scope.type === "volume") {
      const tree = this.getWorkTree(workId);
      const volumes = tree.volumes as Record<string, unknown>[];
      const selectedVolumes = scope.type === "volume"
        ? volumes.filter((volume) => volume.id === scope.volumeId)
        : volumes;
      if (scope.type === "volume" && selectedVolumes.length === 0) throw notFound("卷");
      for (const chapter of selectedVolumes.flatMap((volume) => volume.chapters as Record<string, unknown>[])) {
        sourceVersions[String(chapter.id)] = Number(chapter.versionNo);
      }
    }
    this.db.run(
      `INSERT INTO analysis_tasks (id, work_id, task_type, scope_json, status, source_versions_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`,
      taskId,
      workId,
      input.taskType,
      JSON.stringify(scope),
      JSON.stringify(sourceVersions),
      timestamp,
      timestamp
    );
    this.audit(workId, "task.created", "analysis-task", taskId, { taskType: input.taskType, scope });
    return this.getTask(taskId);
  }

  listTasks(workId: string): Record<string, unknown>[] {
    this.getWork(workId);
    return this.db.all("SELECT * FROM analysis_tasks WHERE work_id = ? ORDER BY created_at DESC", workId).map((row) => this.mapTask(row));
  }

  getTask(taskId: string): Record<string, unknown> {
    const row = this.db.get("SELECT * FROM analysis_tasks WHERE id = ?", taskId);
    if (!row) throw notFound("分析任务");
    return this.mapTask(row);
  }

  isTaskSourceCurrent(taskId: string): boolean {
    const task = this.getTask(taskId);
    const scope = task.scope as Record<string, unknown>;
    const expected = task.sourceVersions as Record<string, number>;
    let chapters: Record<string, unknown>[] = [];
    if (typeof scope.chapterId === "string") {
      const row = this.db.get("SELECT id, work_id, version_no FROM chapters WHERE id = ?", scope.chapterId);
      if (!row || requiredString(row, "work_id") !== task.workId) return false;
      chapters = [{ id: requiredString(row, "id"), versionNo: numberValue(row, "version_no") }];
    } else if (scope.type === "book" || scope.type === "volume") {
      const tree = this.getWorkTree(String(task.workId));
      const volumes = tree.volumes as Record<string, unknown>[];
      const selectedVolumes = scope.type === "volume"
        ? volumes.filter((volume) => volume.id === scope.volumeId)
        : volumes;
      if (scope.type === "volume" && selectedVolumes.length === 0) return false;
      chapters = selectedVolumes.flatMap((volume) => volume.chapters as Record<string, unknown>[]);
    } else {
      return true;
    }
    const current = Object.fromEntries(chapters.map((chapter) => [String(chapter.id), Number(chapter.versionNo)]));
    const expectedIds = Object.keys(expected).sort();
    const currentIds = Object.keys(current).sort();
    return expectedIds.length === currentIds.length
      && expectedIds.every((chapterId, index) => chapterId === currentIds[index] && expected[chapterId] === current[chapterId]);
  }

  cancelTask(taskId: string): Record<string, unknown> {
    const current = this.getTask(taskId);
    if (current.status === "cancelled") return current;
    if (current.status !== "pending" && current.status !== "running") {
      throw new AppError(409, "TASK_NOT_CANCELLABLE", "只有待执行或执行中的任务可以取消");
    }
    this.db.run(
      "UPDATE analysis_tasks SET status = 'cancelled', updated_at = ? WHERE id = ?",
      now(),
      taskId
    );
    this.audit(String(current.workId), "task.cancelled", "analysis-task", taskId, { previousStatus: current.status });
    return this.getTask(taskId);
  }

  updateTask(taskId: string, input: { status: string; progress?: number; result?: unknown; failures?: unknown[] }): Record<string, unknown> {
    const current = this.getTask(taskId);
    const terminal = ["completed", "partial", "review", "expired", "cancelled"];
    if (terminal.includes(String(current.status)) && input.status !== current.status) {
      throw new AppError(409, "INVALID_TASK_TRANSITION", "终态任务不能再变更状态");
    }
    this.db.run(
      "UPDATE analysis_tasks SET status = ?, progress = ?, result_json = ?, failure_json = ?, updated_at = ? WHERE id = ?",
      input.status,
      input.progress ?? Number(current.progress),
      JSON.stringify(input.result ?? current.result),
      JSON.stringify(input.failures ?? current.failures),
      now(),
      taskId
    );
    return this.getTask(taskId);
  }

  private mapTask(row: Row): Record<string, unknown> {
    return {
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      taskType: requiredString(row, "task_type"),
      scope: json(requiredString(row, "scope_json"), {}),
      status: requiredString(row, "status"),
      progress: numberValue(row, "progress"),
      result: json(requiredString(row, "result_json"), {}),
      failures: json(requiredString(row, "failure_json"), []),
      sourceVersions: json(requiredString(row, "source_versions_json"), {}),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  search(workId: string, query: string): Record<string, unknown>[] {
    this.getWork(workId);
    const pattern = `%${query.replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
    const chapters = this.db.all(
      "SELECT id, title, content, volume_id FROM chapters WHERE work_id = ? AND (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\') LIMIT 50",
      workId,
      pattern,
      pattern
    );
    const settings = this.db.all(
      "SELECT id, title, content, category FROM settings WHERE work_id = ? AND (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\') LIMIT 50",
      workId,
      pattern,
      pattern
    );
    const characters = this.db.all(
      "SELECT id, name, aliases_json, species FROM characters WHERE work_id = ? AND (name LIKE ? ESCAPE '\\' OR aliases_json LIKE ? ESCAPE '\\' OR species LIKE ? ESCAPE '\\') LIMIT 50",
      workId,
      pattern,
      pattern,
      pattern
    );
    const organizations = this.db.all(
      "SELECT id, name, description, settings_json FROM organizations WHERE work_id = ? AND (name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR settings_json LIKE ? ESCAPE '\\') LIMIT 50",
      workId,
      pattern,
      pattern,
      pattern
    );
    const snippet = (content: string): string => {
      const index = content.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
      const start = Math.max(0, index - 40);
      return content.slice(start, start + 120);
    };
    return [
      ...chapters.map((row) => ({ type: "chapter", id: requiredString(row, "id"), title: requiredString(row, "title"), snippet: snippet(requiredString(row, "content")), volumeId: requiredString(row, "volume_id") })),
      ...settings.map((row) => ({ type: "setting", id: requiredString(row, "id"), title: requiredString(row, "title"), snippet: snippet(requiredString(row, "content")), category: requiredString(row, "category") })),
      ...characters.map((row) => ({ type: "character", id: requiredString(row, "id"), title: requiredString(row, "name"), snippet: [requiredString(row, "species"), ...json<string[]>(requiredString(row, "aliases_json"), [])].filter(Boolean).join("、") })),
      ...organizations.map((row) => ({ type: "organization", id: requiredString(row, "id"), title: requiredString(row, "name"), snippet: snippet(`${requiredString(row, "description")}\n${json<string[]>(requiredString(row, "settings_json"), []).join("\n")}`) }))
    ];
  }

  exportWork(workId: string): Record<string, unknown> {
    const tree = this.getWorkTree(workId);
    return {
      schemaVersion: 5,
      exportedAt: now(),
      work: tree,
      settings: this.listSettings(workId),
      characters: this.listCharacters(workId),
      organizations: this.listOrganizations(workId),
      timelineTracks: this.listTimelineTracks(workId),
      timeline: this.listTimelineEvents(workId),
      relationships: this.listRelationships(workId),
      outlines: this.listChapterOutlines(workId),
      foreshadows: this.listForeshadows(workId),
      reviews: this.listReviewItems(workId)
    };
  }

  exportText(workId: string, format: "txt" | "markdown"): string {
    const tree = this.getWorkTree(workId);
    const volumes = tree.volumes as Record<string, unknown>[];
    const lines: string[] = [];
    for (const volume of volumes) {
      lines.push(format === "markdown" ? `# ${String(volume.title)}` : String(volume.title), "");
      for (const chapter of volume.chapters as Record<string, unknown>[]) {
        lines.push(format === "markdown" ? `## ${String(chapter.title)}` : String(chapter.title), "", String(chapter.content), "");
      }
    }
    return lines.join("\n").trimEnd() + "\n";
  }

  listAuditLogs(workId: string): Record<string, unknown>[] {
    this.getWork(workId);
    return this.db.all("SELECT * FROM audit_logs WHERE work_id = ? ORDER BY created_at DESC LIMIT 200", workId).map((row) => ({
      id: requiredString(row, "id"),
      action: requiredString(row, "action"),
      entityType: requiredString(row, "entity_type"),
      entityId: optionalString(row, "entity_id"),
      actor: requiredString(row, "actor"),
      detail: json(requiredString(row, "detail_json"), {}),
      createdAt: requiredString(row, "created_at")
    }));
  }
}
