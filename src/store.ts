import type { ParsedNovel } from "./domain.js";
import { createHash } from "node:crypto";
import { Database, type Row } from "./database.js";
import { AppError, notFound } from "./errors.js";
import { currentRequestActor } from "./request-context.js";
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
  raceId?: string | null;
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
  raceId: string | null;
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

type RaceInput = {
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

export const versionedEntityTypes = [
  "setting",
  "race",
  "organization",
  "timeline-track",
  "timeline-event",
  "relationship",
  "chapter-outline",
  "foreshadow"
] as const;

export type VersionedEntityType = typeof versionedEntityTypes[number];

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
  constructor(readonly db: Database) {
    this.backfillEntityVersionBaselines();
  }

  private versionedEntity(type: VersionedEntityType, entityId: string): Record<string, unknown> {
    if (type === "setting") return this.getSetting(entityId);
    if (type === "race") return this.getRace(entityId);
    if (type === "organization") return this.getOrganization(entityId);
    if (type === "timeline-track") return this.getTimelineTrack(entityId);
    if (type === "timeline-event") return this.getTimelineEvent(entityId);
    if (type === "relationship") return this.getRelationship(entityId);
    if (type === "chapter-outline") {
      const outline = this.getChapterOutline(entityId);
      if (!outline) throw notFound("章节大纲");
      return outline;
    }
    return this.getForeshadow(entityId);
  }

  private tryVersionedEntity(type: VersionedEntityType, entityId: string): Record<string, unknown> | null {
    try {
      return this.versionedEntity(type, entityId);
    } catch (error) {
      if (error instanceof AppError && error.status === 404) return null;
      throw error;
    }
  }

  private versionedEntitySnapshot(type: VersionedEntityType, entity: Record<string, unknown>): Record<string, unknown> {
    if (type === "setting") return {
      title: entity.title,
      category: entity.category,
      content: entity.content,
      tags: entity.tags,
      status: entity.status,
      locked: entity.locked,
      evidence: entity.evidence,
      scope: entity.scope,
      authorNote: entity.authorNote
    };
    if (type === "race" || type === "organization") return {
      name: entity.name,
      description: entity.description,
      settings: entity.settings,
      memberIds: entity.memberIds
    };
    if (type === "timeline-track") return {
      name: entity.name,
      description: entity.description,
      sortOrder: entity.sortOrder
    };
    if (type === "timeline-event") return {
      name: entity.name,
      trackId: entity.trackId,
      description: entity.description,
      eventType: entity.eventType,
      timeLabel: entity.timeLabel,
      timeSort: entity.timeSort,
      chapterIds: entity.chapterIds,
      participantIds: entity.participantIds,
      location: entity.location,
      causes: entity.causes,
      impactScope: entity.impactScope,
      evidence: entity.evidence,
      status: entity.status
    };
    if (type === "relationship") return {
      fromCharacterId: entity.fromCharacterId,
      toCharacterId: entity.toCharacterId,
      category: entity.category,
      subtype: entity.subtype,
      keywords: entity.keywords,
      directed: entity.directed,
      currentStatus: entity.currentStatus,
      timeRange: entity.timeRange,
      confidence: entity.confidence,
      evidence: entity.evidence,
      confirmationStatus: entity.confirmationStatus,
      locked: entity.locked
    };
    if (type === "chapter-outline") return {
      goal: entity.goal,
      conflict: entity.conflict,
      turningPoint: entity.turningPoint,
      notes: entity.notes,
      status: entity.status
    };
    return {
      title: entity.title,
      description: entity.description,
      status: entity.status,
      importance: entity.importance,
      plannedPayoffChapterId: entity.plannedPayoffChapterId,
      resolutionNote: entity.resolutionNote,
      occurrences: (entity.occurrences as Array<Record<string, unknown>>).map((occurrence) => ({
        chapterId: occurrence.chapterId,
        role: occurrence.role,
        note: occurrence.note,
        evidence: occurrence.evidence
      }))
    };
  }

  private recordEntityVersion(
    type: VersionedEntityType,
    entityId: string,
    source: string,
    sourceRef: string | null,
    changeNote: string,
    timestamp?: string
  ): number {
    const entity = this.versionedEntity(type, entityId);
    const snapshot = this.versionedEntitySnapshot(type, entity);
    const snapshotJson = JSON.stringify(snapshot);
    const latest = this.db.get(
      "SELECT version_no, snapshot_json FROM entity_versions WHERE entity_type = ? AND entity_id = ? ORDER BY version_no DESC LIMIT 1",
      type,
      entityId
    );
    if (latest && requiredString(latest, "snapshot_json") === snapshotJson && source !== "restore" && source !== "delete") {
      return numberValue(latest, "version_no");
    }
    const versionNo = latest ? numberValue(latest, "version_no") + 1 : 1;
    this.db.run(
      `INSERT INTO entity_versions (id, work_id, entity_type, entity_id, version_no, snapshot_json, source, source_ref, change_note, created_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id("entityVersion"),
      String(entity.workId),
      type,
      entityId,
      versionNo,
      snapshotJson,
      source,
      sourceRef,
      changeNote.trim(),
      timestamp ?? now(),
      currentRequestActor()?.userId ?? null
    );
    return versionNo;
  }

  private backfillEntityVersionBaselines(): void {
    const entities: Array<[VersionedEntityType, string, string]> = [
      ...this.db.all("SELECT id, updated_at FROM settings").map((row) => ["setting", requiredString(row, "id"), requiredString(row, "updated_at")] as [VersionedEntityType, string, string]),
      ...this.db.all("SELECT id, updated_at FROM races").map((row) => ["race", requiredString(row, "id"), requiredString(row, "updated_at")] as [VersionedEntityType, string, string]),
      ...this.db.all("SELECT id, updated_at FROM organizations").map((row) => ["organization", requiredString(row, "id"), requiredString(row, "updated_at")] as [VersionedEntityType, string, string]),
      ...this.db.all("SELECT id, updated_at FROM timeline_tracks").map((row) => ["timeline-track", requiredString(row, "id"), requiredString(row, "updated_at")] as [VersionedEntityType, string, string]),
      ...this.db.all("SELECT id, updated_at FROM timeline_events").map((row) => ["timeline-event", requiredString(row, "id"), requiredString(row, "updated_at")] as [VersionedEntityType, string, string]),
      ...this.db.all("SELECT id, updated_at FROM relationships").map((row) => ["relationship", requiredString(row, "id"), requiredString(row, "updated_at")] as [VersionedEntityType, string, string]),
      ...this.db.all("SELECT chapter_id, updated_at FROM chapter_outlines").map((row) => ["chapter-outline", requiredString(row, "chapter_id"), requiredString(row, "updated_at")] as [VersionedEntityType, string, string]),
      ...this.db.all("SELECT id, updated_at FROM foreshadows").map((row) => ["foreshadow", requiredString(row, "id"), requiredString(row, "updated_at")] as [VersionedEntityType, string, string])
    ];
    this.db.transaction(() => {
      for (const [type, entityId, timestamp] of entities) {
        this.recordEntityVersion(type, entityId, "migration", null, "建立版本基线", timestamp);
      }
    });
  }

  listEntityVersions(type: VersionedEntityType, entityId: string): Record<string, unknown>[] {
    const rows = this.db.all(
      `SELECT version.*, user.display_name AS actor_display_name, user.username AS actor_username
       FROM entity_versions version LEFT JOIN users user ON user.id = version.created_by_user_id
       WHERE version.entity_type = ? AND version.entity_id = ? ORDER BY version.version_no DESC`,
      type,
      entityId
    );
    if (!rows.length) {
      this.versionedEntity(type, entityId);
      return [];
    }
    return rows.map((row) => ({
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      entityType: requiredString(row, "entity_type"),
      entityId: requiredString(row, "entity_id"),
      versionNo: numberValue(row, "version_no"),
      snapshot: json(requiredString(row, "snapshot_json"), {}),
      source: requiredString(row, "source"),
      sourceRef: optionalString(row, "source_ref"),
      changeNote: requiredString(row, "change_note"),
      createdAt: requiredString(row, "created_at"),
      actor: optionalString(row, "actor_display_name") ?? optionalString(row, "actor_username") ?? "历史数据"
    }));
  }

  restoreEntityVersion(type: VersionedEntityType, entityId: string, versionNo: number): Record<string, unknown> {
    const version = this.db.get(
      "SELECT * FROM entity_versions WHERE entity_type = ? AND entity_id = ? AND version_no = ?",
      type,
      entityId,
      versionNo
    );
    if (!version) throw notFound("历史版本");
    const snapshot = json<Record<string, unknown>>(requiredString(version, "snapshot_json"), {});
    if (!Object.keys(snapshot).length) throw new AppError(500, "ENTITY_VERSION_INVALID", "历史版本快照无效");
    const sourceRef = requiredString(version, "id");
    const changeNote = `恢复至 v${versionNo}`;
    const workId = requiredString(version, "work_id");
    const existing = this.tryVersionedEntity(type, entityId);
    let restored: Record<string, unknown>;
    if (!existing) {
      restored = this.recreateEntityFromSnapshot(type, workId, entityId, snapshot, sourceRef, changeNote);
    } else if (type === "setting") restored = this.updateSetting(entityId, snapshot as Partial<SettingInput>, "restore", sourceRef, changeNote);
    else if (type === "race") restored = this.updateRace(entityId, snapshot as Partial<RaceInput>, "restore", sourceRef, changeNote);
    else if (type === "organization") restored = this.updateOrganization(entityId, snapshot as Partial<OrganizationInput>, "restore", sourceRef, changeNote);
    else if (type === "timeline-track") restored = this.updateTimelineTrack(entityId, snapshot as Partial<TimelineTrackInput>, "restore", sourceRef, changeNote);
    else if (type === "timeline-event") restored = this.updateTimelineEvent(entityId, snapshot as Partial<TimelineInput>, "restore", sourceRef, changeNote);
    else if (type === "relationship") restored = this.updateRelationship(entityId, snapshot as Partial<RelationshipInput>, "restore", sourceRef, changeNote);
    else if (type === "chapter-outline") restored = this.upsertChapterOutline(entityId, snapshot as ChapterOutlineInput, "restore", sourceRef, changeNote);
    else restored = this.updateForeshadow(entityId, snapshot as Partial<ForeshadowInput>, "restore", sourceRef, changeNote);
    const currentVersion = this.db.get(
      "SELECT MAX(version_no) AS version_no FROM entity_versions WHERE entity_type = ? AND entity_id = ?",
      type,
      entityId
    );
    return { ...restored, versionNo: numberValue(currentVersion ?? {}, "version_no") };
  }

  private recreateEntityFromSnapshot(
    type: VersionedEntityType,
    workId: string,
    entityId: string,
    snapshot: Record<string, unknown>,
    sourceRef: string,
    changeNote: string
  ): Record<string, unknown> {
    this.getWork(workId);
    if (type === "setting") {
      return this.insertSettingWithId(workId, entityId, snapshot as SettingInput, "restore", sourceRef, changeNote);
    }
    if (type === "race") {
      return this.insertRaceWithId(workId, entityId, snapshot as RaceInput, "restore", sourceRef, changeNote);
    }
    if (type === "organization") {
      return this.insertOrganizationWithId(workId, entityId, snapshot as OrganizationInput, "restore", sourceRef, changeNote);
    }
    if (type === "timeline-track") {
      return this.insertTimelineTrackWithId(workId, entityId, snapshot as TimelineTrackInput, "restore", sourceRef, changeNote);
    }
    if (type === "timeline-event") {
      return this.insertTimelineEventWithId(workId, entityId, snapshot as TimelineInput, "restore", sourceRef, changeNote);
    }
    if (type === "relationship") {
      return this.insertRelationshipWithId(workId, entityId, snapshot as RelationshipInput, "restore", sourceRef, changeNote);
    }
    if (type === "chapter-outline") {
      this.getChapter(entityId);
      return this.upsertChapterOutline(entityId, snapshot as ChapterOutlineInput, "restore", sourceRef, changeNote);
    }
    return this.insertForeshadowWithId(workId, entityId, snapshot as ForeshadowInput, "restore", sourceRef, changeNote);
  }

  audit(workId: string | null, action: string, entityType: string, entityId: string | null, detail: unknown = {}): void {
    const actor = currentRequestActor();
    this.db.run(
      "INSERT INTO audit_logs (id, work_id, action, entity_type, entity_id, actor, detail_json, created_at, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      id("audit"),
      workId,
      action,
      entityType,
      entityId,
      actor?.displayName || actor?.username || "system",
      JSON.stringify(detail),
      now(),
      actor?.userId ?? null
    );
  }

  createWork(input: WorkInput): Record<string, unknown> {
    const workId = id("work");
    const timestamp = now();
    const actor = currentRequestActor();
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO works (id, title, author, description, language, cover_url, tags_json, created_at, updated_at, owner_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        workId,
        input.title,
        input.author ?? "",
        input.description ?? "",
        input.language ?? "zh-CN",
        input.coverUrl ?? null,
        JSON.stringify(input.tags ?? []),
        timestamp,
        timestamp,
        actor?.userId ?? null
      );
      if (actor) {
        this.db.run(
          "INSERT INTO work_memberships (work_id, user_id, role, invited_by_user_id, created_at) VALUES (?, ?, 'owner', ?, ?)",
          workId,
          actor.userId,
          actor.userId,
          timestamp
        );
      }
      this.audit(workId, "work.created", "work", workId);
    });
    return this.getWork(workId);
  }

  listWorks(): Record<string, unknown>[] {
    const actor = currentRequestActor();
    if (!actor || actor.role === "admin") {
      return this.db.all("SELECT * FROM works WHERE COALESCE(is_internal, 0) = 0 ORDER BY updated_at DESC").map((row) => this.mapWork(row));
    }
    return this.db.all(
      `SELECT DISTINCT work.* FROM works work LEFT JOIN work_memberships membership ON membership.work_id = work.id
       WHERE COALESCE(work.is_internal, 0) = 0 AND (work.owner_user_id = ? OR membership.user_id = ?)
       ORDER BY work.updated_at DESC`,
      actor.userId,
      actor.userId
    ).map((row) => this.mapWork(row));
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

  private analysisTaskQueuedHandler: ((workId: string) => void) | null = null;

  setAnalysisTaskQueuedHandler(handler: ((workId: string) => void) | null): void {
    this.analysisTaskQueuedHandler = handler;
  }

  private notifyAnalysisTaskQueued(workId: string): void {
    try {
      this.analysisTaskQueuedHandler?.(workId);
    } catch {
      // 自动运行调度失败不影响主写入路径
    }
  }

  getWorkAiSettings(workId: string): Record<string, unknown> {
    this.getWork(workId);
    const row = this.db.get("SELECT * FROM work_ai_settings WHERE work_id = ?", workId);
    return {
      workId,
      systemPrompt: String(row?.system_prompt ?? ""),
      autoRunEnabled: Number(row?.auto_run_enabled ?? 0) === 1,
      autoRunConcurrency: Math.min(8, Math.max(1, Number(row?.auto_run_concurrency ?? 2) || 2)),
      autoRunBatchLimit: Math.min(200, Math.max(1, Number(row?.auto_run_batch_limit ?? 20) || 20)),
      bookSummaryContextPercent: Math.min(90, Math.max(1, Number(row?.book_summary_context_percent ?? 50) || 50)),
      agentTools: json<string[]>(String(row?.agent_tools_json ?? '["story_index","read_chapters","query_story_knowledge"]'), ["story_index", "read_chapters", "query_story_knowledge"]),
      updatedAt: String(row?.updated_at ?? "")
    };
  }

  updateWorkAiSettings(workId: string, input: {
    systemPrompt?: string;
    autoRunEnabled?: boolean;
    autoRunConcurrency?: number;
    autoRunBatchLimit?: number;
    bookSummaryContextPercent?: number;
    agentTools?: string[];
  }): Record<string, unknown> {
    this.getWork(workId);
    const current = this.getWorkAiSettings(workId);
    const timestamp = now();
    const nextPrompt = input.systemPrompt ?? String(current.systemPrompt);
    const nextEnabled = input.autoRunEnabled ?? Boolean(current.autoRunEnabled);
    const nextConcurrency = input.autoRunConcurrency ?? Number(current.autoRunConcurrency);
    const nextBatchLimit = input.autoRunBatchLimit ?? Number(current.autoRunBatchLimit);
    const nextBookSummaryContextPercent = input.bookSummaryContextPercent ?? Number(current.bookSummaryContextPercent);
    const nextAgentTools = input.agentTools ?? current.agentTools as string[];
    this.db.run(
      `INSERT INTO work_ai_settings (
         work_id, system_prompt, auto_run_enabled, auto_run_concurrency, auto_run_batch_limit, book_summary_context_percent, agent_tools_json, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(work_id) DO UPDATE SET
         system_prompt = excluded.system_prompt,
         auto_run_enabled = excluded.auto_run_enabled,
         auto_run_concurrency = excluded.auto_run_concurrency,
         auto_run_batch_limit = excluded.auto_run_batch_limit,
         book_summary_context_percent = excluded.book_summary_context_percent,
         agent_tools_json = excluded.agent_tools_json,
         updated_at = excluded.updated_at`,
      workId,
      nextPrompt,
      nextEnabled ? 1 : 0,
      Math.min(8, Math.max(1, nextConcurrency)),
      Math.min(200, Math.max(1, nextBatchLimit)),
      Math.min(90, Math.max(1, nextBookSummaryContextPercent)),
      JSON.stringify(nextAgentTools),
      timestamp
    );
    this.audit(workId, "work.ai-settings.updated", "work-ai-settings", workId, {
      systemPromptChanged: input.systemPrompt !== undefined,
      autoRunEnabled: nextEnabled,
      autoRunConcurrency: Math.min(8, Math.max(1, nextConcurrency)),
      autoRunBatchLimit: Math.min(200, Math.max(1, nextBatchLimit)),
      bookSummaryContextPercent: Math.min(90, Math.max(1, nextBookSummaryContextPercent)),
      agentTools: nextAgentTools
    });
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
    const work = this.getWork(workId);
    this.db.transaction(() => {
      this.audit(null, "work.deleted", "work", workId, { title: work.title });
      this.db.run("DELETE FROM works WHERE id = ?", workId);
    });
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
      .all(`SELECT version.id, version.work_id, version.file_name, version.file_type, version.word_count, version.paragraph_count,
        version.warnings_json, version.created_at, user.display_name AS actor_display_name, user.username AS actor_username
        FROM file_versions version LEFT JOIN users user ON user.id = version.created_by_user_id
        WHERE version.work_id = ? ORDER BY version.created_at DESC`, workId)
      .map((row) => ({
        id: requiredString(row, "id"),
        workId: requiredString(row, "work_id"),
        fileName: requiredString(row, "file_name"),
        fileType: requiredString(row, "file_type"),
        wordCount: numberValue(row, "word_count"),
        paragraphCount: numberValue(row, "paragraph_count"),
        warnings: json(requiredString(row, "warnings_json"), []),
        createdAt: requiredString(row, "created_at"),
        actor: optionalString(row, "actor_display_name") ?? optionalString(row, "actor_username") ?? "历史数据"
      }));
  }

  restoreFileVersion(workId: string, fileVersionId: string): Record<string, unknown> {
    this.getWork(workId);
    const version = this.db.get("SELECT * FROM file_versions WHERE id = ? AND work_id = ?", fileVersionId, workId);
    if (!version) throw notFound("文件版本");
    const snapshot = json<Record<string, unknown>>(requiredString(version, "snapshot_json"), {});
    const volumes = Array.isArray(snapshot.volumes) ? snapshot.volumes as Array<Record<string, unknown>> : [];
    return this.db.transaction(() => {
      const currentTree = this.getWorkTree(workId);
      const currentChapters = this.db.all("SELECT content FROM chapters WHERE work_id = ?", workId);
      const wordCount = currentChapters.reduce((sum, row) => sum + countWords(requiredString(row, "content")), 0);
      const paragraphCount = currentChapters.reduce((sum, row) => {
        const content = requiredString(row, "content").trim();
        return sum + (content ? content.split(/\n+/u).filter(Boolean).length : 0);
      }, 0);
      const restorePointId = id("file");
      const timestamp = now();
      this.db.run(
        `INSERT INTO file_versions (id, work_id, file_name, file_type, word_count, paragraph_count, warnings_json, snapshot_json, created_at, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        restorePointId,
        workId,
        `before-restore:${requiredString(version, "file_name")}`,
        "snapshot",
        wordCount,
        paragraphCount,
        "[]",
        JSON.stringify(currentTree),
        timestamp,
        currentRequestActor()?.userId ?? null
      );
      this.db.run("DELETE FROM volumes WHERE work_id = ?", workId);
      for (const volume of volumes) {
        const volumeId = id("volume");
        const chapters = Array.isArray(volume.chapters) ? volume.chapters as Array<Record<string, unknown>> : [];
        this.db.run(
          `INSERT INTO volumes (id, work_id, title, kind, source, description, keywords_json, sort_order, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          volumeId,
          workId,
          String(volume.title ?? "正文"),
          String(volume.kind ?? "main"),
          String(volume.source ?? "manual"),
          String(volume.description ?? ""),
          JSON.stringify(Array.isArray(volume.keywords) ? this.normalizeVolumeKeywords(volume.keywords as string[]) : []),
          Number(volume.sortOrder ?? 0),
          timestamp,
          timestamp
        );
        for (const chapter of chapters) {
          const chapterType = (["正文", "设定", "作者的话", "其他"].includes(String(chapter.chapterType))
            ? String(chapter.chapterType)
            : "正文") as ChapterType;
          this.insertChapter(
            workId,
            volumeId,
            String(chapter.title ?? "未命名章节"),
            String(chapter.content ?? ""),
            Number(chapter.sortOrder ?? 0),
            "restore",
            fileVersionId,
            chapterType
          );
        }
      }
      this.db.run("UPDATE works SET updated_at = ? WHERE id = ?", timestamp, workId);
      this.audit(workId, "file.restored", "file-version", fileVersionId, { restorePointId });
      return {
        fileVersionId: restorePointId,
        restoredFrom: fileVersionId,
        tree: this.getWorkTree(workId)
      };
    });
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
      `INSERT INTO file_versions (id, work_id, file_name, file_type, word_count, paragraph_count, warnings_json, snapshot_json, created_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      fileVersionId,
      workId,
      fileName,
      fileType,
      parsed.wordCount,
      parsed.paragraphCount,
      JSON.stringify(parsed.warnings),
      JSON.stringify(snapshot),
      timestamp,
      currentRequestActor()?.userId ?? null
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

  private findChapterVersionRows(chapterId: string): Row[] {
    return this.db.all(
      `SELECT version.*, user.display_name AS actor_display_name, user.username AS actor_username
        FROM chapter_versions version LEFT JOIN users user ON user.id = version.created_by_user_id
        WHERE version.chapter_id = ? ORDER BY version.version_no DESC`,
      chapterId
    );
  }

  private mapChapterVersionRow(row: Row): Record<string, unknown> {
    return {
      id: requiredString(row, "id"),
      workId: optionalString(row, "work_id"),
      chapterId: requiredString(row, "chapter_id"),
      versionNo: numberValue(row, "version_no"),
      title: requiredString(row, "title"),
      content: requiredString(row, "content"),
      volumeId: optionalString(row, "volume_id"),
      sortOrder: row.sort_order === null || row.sort_order === undefined ? null : numberValue(row, "sort_order"),
      chapterType: optionalString(row, "chapter_type"),
      source: requiredString(row, "source"),
      sourceRef: optionalString(row, "source_ref"),
      createdAt: requiredString(row, "created_at"),
      actor: optionalString(row, "actor_display_name") ?? optionalString(row, "actor_username") ?? "历史数据"
    };
  }

  private insertChapterVersionRow(input: {
    workId: string;
    chapterId: string;
    versionNo: number;
    title: string;
    content: string;
    volumeId: string | null;
    sortOrder: number | null;
    chapterType: string | null;
    source: string;
    sourceRef: string | null;
    timestamp?: string;
  }): void {
    this.db.run(
      `INSERT INTO chapter_versions (
         id, work_id, chapter_id, version_no, title, content, volume_id, sort_order, chapter_type,
         source, source_ref, created_at, created_by_user_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id("chapterVersion"),
      input.workId,
      input.chapterId,
      input.versionNo,
      input.title,
      input.content,
      input.volumeId,
      input.sortOrder,
      input.chapterType,
      input.source,
      input.sourceRef,
      input.timestamp ?? now(),
      currentRequestActor()?.userId ?? null
    );
  }

  listChapterVersions(chapterId: string): Record<string, unknown>[] {
    const rows = this.findChapterVersionRows(chapterId);
    if (!rows.length) {
      this.getChapter(chapterId);
      return [];
    }
    return rows.map((row) => this.mapChapterVersionRow(row));
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

  listCurrentChapterInsights(workId: string): Record<string, unknown>[] {
    this.getWork(workId);
    return this.db.all(
      `SELECT insight.id, insight.chapter_id, insight.summary, chapter.title AS chapter_title,
              volume.title AS volume_title, volume.sort_order AS volume_sort_order, chapter.sort_order AS chapter_sort_order
       FROM chapters chapter
       JOIN volumes volume ON volume.id = chapter.volume_id
       JOIN chapter_insights insight ON insight.chapter_id = chapter.id AND insight.chapter_version = chapter.version_no
       WHERE chapter.work_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM chapter_insights newer
           WHERE newer.chapter_id = insight.chapter_id
             AND newer.chapter_version = insight.chapter_version
             AND (newer.created_at > insight.created_at OR (newer.created_at = insight.created_at AND newer.id > insight.id))
         )
       ORDER BY volume.sort_order, chapter.sort_order`,
      workId
    ).map((row) => ({
      id: requiredString(row, "id"),
      chapterId: requiredString(row, "chapter_id"),
      chapterTitle: requiredString(row, "chapter_title"),
      volumeTitle: requiredString(row, "volume_title"),
      summary: requiredString(row, "summary")
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
        this.insertChapterVersionRow({
          workId: String(current.workId),
          chapterId,
          versionNo,
          title: nextTitle,
          content: nextContent,
          volumeId: String(current.volumeId),
          sortOrder: Number(current.sortOrder),
          chapterType: nextChapterType,
          source,
          sourceRef,
          timestamp
        });
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
    const existing = this.db.get("SELECT id FROM chapters WHERE id = ?", chapterId);
    if (!existing) {
      return this.recreateChapterFromVersion(chapterId, version);
    }
    return this.saveChapter(
      chapterId,
      { title: requiredString(version, "title"), content: requiredString(version, "content") },
      "restore",
      requiredString(version, "id")
    );
  }

  private recreateChapterFromVersion(chapterId: string, version: Row): Record<string, unknown> {
    const workId = requiredString(version, "work_id");
    const volumeId = optionalString(version, "volume_id");
    if (!volumeId) throw new AppError(400, "CHAPTER_RESTORE_INCOMPLETE", "历史版本缺少分卷信息，无法恢复已删除章节");
    const volume = this.getVolume(volumeId);
    if (volume.workId !== workId) throw new AppError(400, "VOLUME_WORK_MISMATCH", "卷不属于当前作品");
    const title = requiredString(version, "title");
    const content = requiredString(version, "content");
    const chapterType = (optionalString(version, "chapter_type") ?? "正文") as ChapterType;
    const sortOrder = version.sort_order === null || version.sort_order === undefined
      ? numberValue(this.db.get("SELECT COALESCE(MAX(sort_order), -1) AS sort_order FROM chapters WHERE volume_id = ?", volumeId) ?? {}, "sort_order") + 1
      : numberValue(version, "sort_order");
    const timestamp = now();
    const nextVersionNo = numberValue(
      this.db.get("SELECT COALESCE(MAX(version_no), 0) AS version_no FROM chapter_versions WHERE chapter_id = ?", chapterId) ?? {},
      "version_no"
    ) + 1;
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO chapters (id, work_id, volume_id, title, content, chapter_type, sort_order, word_count, version_no, analysis_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
        chapterId,
        workId,
        volumeId,
        title,
        content,
        chapterType,
        sortOrder,
        countWords(content),
        nextVersionNo,
        timestamp,
        timestamp
      );
      this.insertChapterVersionRow({
        workId,
        chapterId,
        versionNo: nextVersionNo,
        title,
        content,
        volumeId,
        sortOrder,
        chapterType,
        source: "restore",
        sourceRef: requiredString(version, "id"),
        timestamp
      });
      this.db.run("UPDATE works SET updated_at = ? WHERE id = ?", timestamp, workId);
      this.audit(workId, "chapter.restored", "chapter", chapterId, { versionNo: nextVersionNo, fromVersion: numberValue(version, "version_no") });
    });
    return this.getChapter(chapterId);
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
    const timestamp = now();
    const versionNo = Number(chapter.versionNo) + 1;
    this.db.transaction(() => {
      this.db.run("UPDATE chapters SET version_no = ?, updated_at = ? WHERE id = ?", versionNo, timestamp, chapterId);
      this.insertChapterVersionRow({
        workId: String(chapter.workId),
        chapterId,
        versionNo,
        title: String(chapter.title),
        content: String(chapter.content),
        volumeId: String(chapter.volumeId),
        sortOrder: Number(chapter.sortOrder),
        chapterType: String(chapter.chapterType),
        source: "delete",
        sourceRef: null,
        timestamp
      });
      this.db.run("DELETE FROM chapters WHERE id = ?", chapterId);
      this.audit(String(chapter.workId), "chapter.deleted", "chapter", chapterId, { versionNo });
    });
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
    this.insertChapterVersionRow({
      workId,
      chapterId,
      versionNo: 1,
      title,
      content: normalizedContent,
      volumeId,
      sortOrder,
      chapterType,
      source,
      sourceRef,
      timestamp
    });
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
        `INSERT INTO analysis_tasks (id, work_id, task_type, scope_json, status, source_versions_json, created_at, updated_at, created_by_user_id)
         VALUES (?, ?, 'chapter-analysis', ?, 'pending', ?, ?, ?, ?)`,
        id("task"),
        workId,
        JSON.stringify({ type: "chapter", chapterId }),
        JSON.stringify({ [chapterId]: versionNo }),
        timestamp,
        timestamp,
        currentRequestActor()?.userId ?? null
      );
    } else {
      this.db.run(
        "UPDATE analysis_tasks SET source_versions_json = ?, updated_at = ? WHERE id = ?",
        JSON.stringify({ [chapterId]: versionNo }),
        now(),
        requiredString(existing, "id")
      );
    }
    this.notifyAnalysisTaskQueued(workId);
  }

  private mapWork(row: Row): Record<string, unknown> {
    const actor = currentRequestActor();
    const ownerUserId = optionalString(row, "owner_user_id");
    const membership = actor
      ? this.db.get("SELECT role FROM work_memberships WHERE work_id = ? AND user_id = ?", requiredString(row, "id"), actor.userId)
      : undefined;
    const accessRole = ownerUserId === actor?.userId
      ? "owner"
      : actor?.role === "admin"
        ? "admin"
        : String(membership?.role ?? "") === "editor" ? "editor" : null;
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
      ownerUserId,
      accessRole,
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

  upsertChapterOutline(
    chapterId: string,
    input: ChapterOutlineInput,
    source = "manual",
    sourceRef: string | null = null,
    changeNote = ""
  ): Record<string, unknown> {
    const chapter = this.getChapter(chapterId);
    const current = this.getChapterOutline(chapterId);
    const timestamp = now();
    this.db.transaction(() => {
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
      this.recordEntityVersion("chapter-outline", chapterId, current ? source : "create", sourceRef, changeNote || (current ? "更新章节大纲" : "建立章节大纲"), timestamp);
      this.audit(String(chapter.workId), current ? "outline.updated" : "outline.created", "chapter-outline", chapterId, { fields: Object.keys(input), source, sourceRef });
    });
    return this.getChapterOutline(chapterId) as Record<string, unknown>;
  }

  deleteChapterOutline(chapterId: string): void {
    const chapter = this.getChapter(chapterId);
    const outline = this.getChapterOutline(chapterId);
    if (!outline) return;
    this.db.transaction(() => {
      this.recordEntityVersion("chapter-outline", chapterId, "delete", null, "删除章节大纲");
      this.db.run("DELETE FROM chapter_outlines WHERE chapter_id = ?", chapterId);
      this.audit(String(chapter.workId), "outline.deleted", "chapter-outline", chapterId);
    });
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
    return this.insertForeshadowWithId(workId, id("foreshadow"), input, "create", null);
  }

  private insertForeshadowWithId(
    workId: string,
    foreshadowId: string,
    input: ForeshadowInput,
    source = "create",
    sourceRef: string | null = null,
    changeNote = ""
  ): Record<string, unknown> {
    if (input.plannedPayoffChapterId) this.assertChapterInWork(input.plannedPayoffChapterId, workId);
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
      this.recordEntityVersion("foreshadow", foreshadowId, source, sourceRef, changeNote || "建立伏笔", timestamp);
      this.audit(workId, source === "restore" ? "foreshadow.restored" : "foreshadow.created", "foreshadow", foreshadowId);
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

  updateForeshadow(
    foreshadowId: string,
    input: Partial<ForeshadowInput>,
    source = "manual",
    sourceRef: string | null = null,
    changeNote = ""
  ): Record<string, unknown> {
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
      this.recordEntityVersion("foreshadow", foreshadowId, source, sourceRef, changeNote || "更新伏笔");
      this.audit(workId, "foreshadow.updated", "foreshadow", foreshadowId, { fields: Object.keys(input), source, sourceRef });
    });
    return this.getForeshadow(foreshadowId);
  }

  deleteForeshadow(foreshadowId: string): void {
    const current = this.getForeshadow(foreshadowId);
    this.db.transaction(() => {
      this.recordEntityVersion("foreshadow", foreshadowId, "delete", null, "删除伏笔");
      this.db.run("DELETE FROM foreshadows WHERE id = ?", foreshadowId);
      this.audit(String(current.workId), "foreshadow.deleted", "foreshadow", foreshadowId);
    });
  }

  createForeshadowOccurrence(foreshadowId: string, input: ForeshadowOccurrenceInput): Record<string, unknown> {
    const foreshadow = this.getForeshadow(foreshadowId);
    const occurrenceId = this.db.transaction(() => {
      const createdId = this.insertForeshadowOccurrence(foreshadowId, String(foreshadow.workId), input);
      this.recordEntityVersion("foreshadow", foreshadowId, "manual", createdId, "添加伏笔章节记录");
      this.audit(String(foreshadow.workId), "foreshadow.occurrence.created", "foreshadow-occurrence", createdId);
      return createdId;
    });
    return this.getForeshadowOccurrence(occurrenceId);
  }

  updateForeshadowOccurrence(occurrenceId: string, input: Partial<ForeshadowOccurrenceInput>): Record<string, unknown> {
    const current = this.getForeshadowOccurrence(occurrenceId);
    const foreshadow = this.getForeshadow(String(current.foreshadowId));
    const chapterId = input.chapterId ?? String(current.chapterId);
    this.assertChapterInWork(chapterId, String(foreshadow.workId));
    this.db.transaction(() => {
      this.db.run(
        `UPDATE foreshadow_occurrences SET chapter_id = ?, role = ?, note = ?, evidence_json = ?, updated_at = ? WHERE id = ?`,
        chapterId,
        input.role ?? String(current.role),
        input.note ?? String(current.note),
        JSON.stringify(input.evidence ?? current.evidence),
        now(),
        occurrenceId
      );
      this.recordEntityVersion("foreshadow", String(current.foreshadowId), "manual", occurrenceId, "更新伏笔章节记录");
    });
    return this.getForeshadowOccurrence(occurrenceId);
  }

  deleteForeshadowOccurrence(occurrenceId: string): void {
    const current = this.getForeshadowOccurrence(occurrenceId);
    this.db.transaction(() => {
      this.db.run("DELETE FROM foreshadow_occurrences WHERE id = ?", occurrenceId);
      this.recordEntityVersion("foreshadow", String(current.foreshadowId), "manual", occurrenceId, "删除伏笔章节记录");
    });
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

  createSetting(workId: string, input: SettingInput, source = "create", sourceRef: string | null = null): Record<string, unknown> {
    this.getWork(workId);
    return this.insertSettingWithId(workId, id("setting"), input, source, sourceRef);
  }

  private insertSettingWithId(
    workId: string,
    settingId: string,
    input: SettingInput,
    source = "create",
    sourceRef: string | null = null,
    changeNote = ""
  ): Record<string, unknown> {
    const timestamp = now();
    this.db.transaction(() => {
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
      this.recordEntityVersion("setting", settingId, source, sourceRef, changeNote || "建立世界观设定", timestamp);
      this.audit(workId, source === "restore" ? "setting.restored" : "setting.created", "setting", settingId, {
        locked: input.locked ?? false,
        source,
        sourceRef
      });
    });
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

  updateSetting(
    settingId: string,
    input: Partial<SettingInput>,
    source = "manual",
    sourceRef: string | null = null,
    changeNote = ""
  ): Record<string, unknown> {
    const current = this.getSetting(settingId);
    this.db.transaction(() => {
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
      this.recordEntityVersion("setting", settingId, source, sourceRef, changeNote || "更新世界观设定");
      this.audit(String(current.workId), "setting.updated", "setting", settingId, { fields: Object.keys(input), source, sourceRef });
    });
    return this.getSetting(settingId);
  }

  deleteSetting(settingId: string): void {
    const current = this.getSetting(settingId);
    this.db.transaction(() => {
      this.recordEntityVersion("setting", settingId, "delete", null, "删除世界观设定");
      this.db.run("DELETE FROM settings WHERE id = ?", settingId);
      this.audit(String(current.workId), "setting.deleted", "setting", settingId);
    });
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

  createRace(workId: string, input: RaceInput): Record<string, unknown> {
    return this.insertRaceWithId(workId, id("race"), input, "create", null);
  }

  private insertRaceWithId(
    workId: string,
    raceId: string,
    input: RaceInput,
    source = "create",
    sourceRef: string | null = null,
    changeNote = ""
  ): Record<string, unknown> {
    this.getWork(workId);
    const name = input.name.normalize("NFKC").trim().replace(/\s+/gu, " ");
    const normalizedName = normalizeCharacterName(name);
    if (!normalizedName) throw new AppError(400, "RACE_NAME_REQUIRED", "种族名称不能为空");
    this.assertRaceNameAvailable(workId, normalizedName);
    const memberIds = [...new Set(input.memberIds ?? [])];
    this.assertCharactersInWork(workId, memberIds);
    const memberSnapshots = this.captureCharacterSnapshots(memberIds);
    const timestamp = now();
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO races (id, work_id, name, normalized_name, description, settings_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        raceId,
        workId,
        name,
        normalizedName,
        input.description ?? "",
        JSON.stringify(input.settings ?? []),
        timestamp,
        timestamp
      );
      this.replaceRaceMembers(raceId, name, memberIds);
      this.recordMembershipVersions(memberSnapshots, "race", raceId, `设为种族“${name}”`);
      this.recordEntityVersion("race", raceId, source, sourceRef, changeNote || "建立种族档案", timestamp);
      this.audit(workId, source === "restore" ? "race.restored" : "race.created", "race", raceId);
    });
    return this.getRace(raceId);
  }

  listRaces(workId: string): Record<string, unknown>[] {
    this.getWork(workId);
    return this.db.all("SELECT * FROM races WHERE work_id = ? ORDER BY name", workId).map((row) => this.mapRace(row));
  }

  getRace(raceId: string): Record<string, unknown> {
    const row = this.db.get("SELECT * FROM races WHERE id = ?", raceId);
    if (!row) throw notFound("种族");
    return this.mapRace(row);
  }

  updateRace(
    raceId: string,
    input: Partial<RaceInput>,
    source = "manual",
    sourceRef: string | null = null,
    changeNote = ""
  ): Record<string, unknown> {
    const current = this.getRace(raceId);
    const workId = String(current.workId);
    const name = input.name === undefined
      ? String(current.name)
      : input.name.normalize("NFKC").trim().replace(/\s+/gu, " ");
    const normalizedName = normalizeCharacterName(name);
    if (!normalizedName) throw new AppError(400, "RACE_NAME_REQUIRED", "种族名称不能为空");
    this.assertRaceNameAvailable(workId, normalizedName, raceId);
    const memberIds = input.memberIds === undefined ? null : [...new Set(input.memberIds)];
    if (memberIds) this.assertCharactersInWork(workId, memberIds);
    const nameChanged = name !== current.name;
    const touchedMemberIds = memberIds || nameChanged
      ? [...new Set([...(current.memberIds as string[]), ...(memberIds ?? [])])]
      : [];
    const memberSnapshots = this.captureCharacterSnapshots(touchedMemberIds);
    this.db.transaction(() => {
      this.db.run(
        `UPDATE races SET name = ?, normalized_name = ?, description = ?, settings_json = ?, updated_at = ? WHERE id = ?`,
        name,
        normalizedName,
        input.description ?? String(current.description),
        JSON.stringify(input.settings ?? current.settings),
        now(),
        raceId
      );
      if (nameChanged) this.db.run("UPDATE characters SET species = ?, updated_at = ? WHERE race_id = ?", name, now(), raceId);
      if (memberIds) this.replaceRaceMembers(raceId, name, memberIds);
      this.recordMembershipVersions(memberSnapshots, "race", raceId, nameChanged ? `种族更名为“${name}”` : `种族“${name}”成员关系变更`);
      this.recordEntityVersion("race", raceId, source, sourceRef, changeNote || "更新种族档案");
      this.audit(workId, "race.updated", "race", raceId, { fields: Object.keys(input), source, sourceRef });
    });
    return this.getRace(raceId);
  }

  deleteRace(raceId: string): void {
    const current = this.getRace(raceId);
    const memberSnapshots = this.captureCharacterSnapshots(current.memberIds as string[]);
    this.db.transaction(() => {
      this.recordEntityVersion("race", raceId, "delete", null, "删除种族档案");
      this.db.run("UPDATE characters SET race_id = NULL, species = '', updated_at = ? WHERE race_id = ?", now(), raceId);
      this.db.run("DELETE FROM races WHERE id = ?", raceId);
      this.recordMembershipVersions(memberSnapshots, "race", raceId, `种族“${String(current.name)}”已删除`);
      this.audit(String(current.workId), "race.deleted", "race", raceId);
    });
  }

  resolveRaceReference(workId: string, value: string): string | null {
    const normalizedName = normalizeCharacterName(value);
    if (!normalizedName) return null;
    const row = this.db.get("SELECT id FROM races WHERE work_id = ? AND normalized_name = ?", workId, normalizedName);
    return row ? requiredString(row, "id") : null;
  }

  private mapRace(row: Row): Record<string, unknown> {
    const members = this.db.all("SELECT id, name FROM characters WHERE race_id = ? ORDER BY name", requiredString(row, "id")).map((member) => ({
      characterId: requiredString(member, "id"),
      name: requiredString(member, "name")
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

  private assertRaceNameAvailable(workId: string, normalizedName: string, excludeRaceId?: string): void {
    const row = this.db.get(
      `SELECT id FROM races WHERE work_id = ? AND normalized_name = ?${excludeRaceId ? " AND id <> ?" : ""}`,
      ...([workId, normalizedName, ...(excludeRaceId ? [excludeRaceId] : [])])
    );
    if (row) throw new AppError(409, "RACE_NAME_CONFLICT", "同一作品内的种族名称不能重复", { raceId: requiredString(row, "id") });
  }

  private assertRaceInWork(workId: string, raceId: string): Record<string, unknown> {
    const race = this.getRace(raceId);
    if (race.workId !== workId) throw new AppError(400, "RACE_WORK_MISMATCH", "角色绑定的种族不属于当前作品");
    return race;
  }

  private replaceRaceMembers(raceId: string, raceName: string, memberIds: string[]): void {
    const timestamp = now();
    this.db.run("UPDATE characters SET race_id = NULL, species = '', updated_at = ? WHERE race_id = ?", timestamp, raceId);
    for (const characterId of memberIds) {
      this.db.run("UPDATE characters SET race_id = ?, species = ?, updated_at = ? WHERE id = ?", raceId, raceName, timestamp, characterId);
    }
  }

  createOrganization(workId: string, input: OrganizationInput): Record<string, unknown> {
    return this.insertOrganizationWithId(workId, id("organization"), input, "create", null);
  }

  private insertOrganizationWithId(
    workId: string,
    organizationId: string,
    input: OrganizationInput,
    source = "create",
    sourceRef: string | null = null,
    changeNote = ""
  ): Record<string, unknown> {
    this.getWork(workId);
    const name = input.name.normalize("NFKC").trim().replace(/\s+/gu, " ");
    const normalizedName = normalizeCharacterName(name);
    if (!normalizedName) throw new AppError(400, "ORGANIZATION_NAME_REQUIRED", "组织名称不能为空");
    this.assertOrganizationNameAvailable(workId, normalizedName);
    const memberIds = [...new Set(input.memberIds ?? [])];
    this.assertCharactersInWork(workId, memberIds);
    const memberSnapshots = this.captureCharacterSnapshots(memberIds);
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
      this.recordEntityVersion("organization", organizationId, source, sourceRef, changeNote || "建立组织档案", timestamp);
      this.audit(workId, source === "restore" ? "organization.restored" : "organization.created", "organization", organizationId);
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

  updateOrganization(
    organizationId: string,
    input: Partial<OrganizationInput>,
    source = "manual",
    sourceRef: string | null = null,
    changeNote = ""
  ): Record<string, unknown> {
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
      this.recordEntityVersion("organization", organizationId, source, sourceRef, changeNote || "更新组织档案");
      this.audit(workId, "organization.updated", "organization", organizationId, { fields: Object.keys(input), source, sourceRef });
    });
    return this.getOrganization(organizationId);
  }

  deleteOrganization(organizationId: string): void {
    const current = this.getOrganization(organizationId);
    const memberSnapshots = this.captureCharacterSnapshots(current.memberIds as string[]);
    this.db.transaction(() => {
      this.recordEntityVersion("organization", organizationId, "delete", null, "删除组织档案");
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
      raceId: character.raceId as string | null,
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
    timestamp = now(),
    workId?: string
  ): void {
    const character = this.getCharacter(characterId);
    const snapshot = this.characterSnapshot(character);
    this.db.run(
      `INSERT INTO character_versions (id, work_id, character_id, version_no, snapshot_json, source, source_ref, change_note, created_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id("characterVersion"),
      workId ?? String(character.workId),
      characterId,
      versionNo,
      JSON.stringify(snapshot),
      source,
      sourceRef,
      changeNote.trim(),
      timestamp,
      currentRequestActor()?.userId ?? null
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
    const candidateSpecies = input.species?.trim() || legacySpecies;
    const raceId = input.raceId === undefined ? (candidateSpecies ? this.resolveRaceReference(workId, candidateSpecies) : null) : input.raceId;
    const race = raceId ? this.assertRaceInWork(workId, raceId) : null;
    const species = race ? String(race.name) : "";
    this.assertCharacterNamesAvailable(workId, names.entries);
    if (input.firstChapterId) this.assertChapterInWork(input.firstChapterId, workId);
    const organizationIds = [...new Set(input.organizationIds ?? [])];
    this.assertOrganizationsInWork(workId, organizationIds);
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO characters (id, work_id, name, aliases_json, species, race_id, attributes_json, profile_json, current_state_json,
         locked_fields_json, visibility, first_chapter_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        characterId,
        workId,
        names.name,
        JSON.stringify(names.aliases),
        species,
        raceId,
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
    let raceId = input.raceId === undefined ? current.raceId as string | null : input.raceId;
    if (input.raceId === undefined && !raceId && input.species !== undefined) {
      raceId = this.resolveRaceReference(workId, input.species.trim() || legacySpecies);
    }
    const race = raceId ? this.assertRaceInWork(workId, raceId) : null;
    const species = race ? String(race.name) : "";
    this.assertCharacterNamesAvailable(workId, names.entries, characterId);
    if (input.firstChapterId) this.assertChapterInWork(input.firstChapterId, workId);
    const organizationIds = input.organizationIds === undefined ? null : [...new Set(input.organizationIds)];
    if (organizationIds) this.assertOrganizationsInWork(workId, organizationIds);
    this.db.transaction(() => {
      this.db.run(
        `UPDATE characters SET name = ?, aliases_json = ?, species = ?, race_id = ?, attributes_json = ?, profile_json = ?, current_state_json = ?,
         locked_fields_json = ?, visibility = ?, first_chapter_id = ?, updated_at = ? WHERE id = ?`,
        names.name,
        JSON.stringify(names.aliases),
        species,
        raceId,
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
    const rows = this.db.all(
      `SELECT version.*, user.display_name AS actor_display_name, user.username AS actor_username
       FROM character_versions version LEFT JOIN users user ON user.id = version.created_by_user_id
       WHERE version.character_id = ? ORDER BY version.version_no DESC`,
      characterId
    );
    if (!rows.length) {
      this.getCharacter(characterId);
      return [];
    }
    return rows.map((row) => ({
      id: requiredString(row, "id"),
      workId: optionalString(row, "work_id"),
      characterId: requiredString(row, "character_id"),
      versionNo: numberValue(row, "version_no"),
      snapshot: json(requiredString(row, "snapshot_json"), {}),
      source: requiredString(row, "source"),
      sourceRef: optionalString(row, "source_ref"),
      changeNote: requiredString(row, "change_note"),
      createdAt: requiredString(row, "created_at"),
      actor: optionalString(row, "actor_display_name") ?? optionalString(row, "actor_username") ?? "历史数据"
    }));
  }

  restoreCharacter(characterId: string, versionNo: number): Record<string, unknown> {
    const version = this.db.get("SELECT * FROM character_versions WHERE character_id = ? AND version_no = ?", characterId, versionNo);
    if (!version) throw notFound("人物版本");
    const snapshot = json<CharacterSnapshot>(requiredString(version, "snapshot_json"), {} as CharacterSnapshot);
    if (!snapshot.name) throw new AppError(500, "CHARACTER_VERSION_INVALID", "人物版本快照无效");
    const existing = this.db.get("SELECT id FROM characters WHERE id = ?", characterId);
    if (!existing) {
      return this.recreateCharacterFromVersion(characterId, version, snapshot, versionNo);
    }
    return this.updateCharacter(
      characterId,
      snapshot,
      "restore",
      requiredString(version, "id"),
      `恢复至 v${versionNo}`
    );
  }

  private recreateCharacterFromVersion(
    characterId: string,
    version: Row,
    snapshot: CharacterSnapshot,
    versionNo: number
  ): Record<string, unknown> {
    const workId = requiredString(version, "work_id");
    this.getWork(workId);
    const names = this.prepareCharacterNames(snapshot.name, snapshot.aliases ?? []);
    const raceId = snapshot.raceId ?? null;
    const race = raceId ? this.assertRaceInWork(workId, raceId) : null;
    const species = race ? String(race.name) : (snapshot.species ?? "");
    this.assertCharacterNamesAvailable(workId, names.entries);
    if (snapshot.firstChapterId) this.assertChapterInWork(snapshot.firstChapterId, workId);
    const organizationIds = [...new Set(snapshot.organizationIds ?? [])];
    this.assertOrganizationsInWork(workId, organizationIds);
    const timestamp = now();
    const nextVersionNo = numberValue(
      this.db.get("SELECT COALESCE(MAX(version_no), 0) AS version_no FROM character_versions WHERE character_id = ?", characterId) ?? {},
      "version_no"
    ) + 1;
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO characters (id, work_id, name, aliases_json, species, race_id, attributes_json, profile_json, current_state_json,
         locked_fields_json, visibility, first_chapter_id, version_no, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        characterId,
        workId,
        names.name,
        JSON.stringify(names.aliases),
        species,
        raceId,
        JSON.stringify(snapshot.attributes ?? {}),
        JSON.stringify(snapshot.profile ?? {}),
        JSON.stringify(snapshot.currentState ?? {}),
        JSON.stringify(snapshot.lockedFields ?? []),
        snapshot.visibility ?? "author",
        snapshot.firstChapterId ?? null,
        nextVersionNo,
        timestamp,
        timestamp
      );
      this.insertCharacterNames(workId, characterId, names.entries);
      this.replaceCharacterOrganizations(characterId, organizationIds);
      this.insertCharacterVersion(characterId, nextVersionNo, "restore", requiredString(version, "id"), `恢复至 v${versionNo}`, timestamp, workId);
      this.audit(workId, "character.restored", "character", characterId, { versionNo: nextVersionNo, fromVersion: versionNo });
    });
    return this.getCharacter(characterId);
  }

  deleteCharacter(characterId: string): void {
    const current = this.getCharacter(characterId);
    const timestamp = now();
    const versionNo = Number(current.versionNo) + 1;
    this.db.transaction(() => {
      this.db.run("UPDATE characters SET version_no = ?, updated_at = ? WHERE id = ?", versionNo, timestamp, characterId);
      this.insertCharacterVersion(characterId, versionNo, "delete", null, "删除人物", timestamp);
      this.db.run("DELETE FROM characters WHERE id = ?", characterId);
      this.audit(String(current.workId), "character.deleted", "character", characterId, { versionNo });
    });
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
    const raceId = optionalString(row, "race_id");
    const race = raceId ? this.db.get("SELECT id, name FROM races WHERE id = ?", raceId) : undefined;
    const species = race ? requiredString(race, "name") : requiredString(row, "species");
    return {
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      name: requiredString(row, "name"),
      aliases: indexedAliases.length > 0 ? indexedAliases : json(requiredString(row, "aliases_json"), []),
      raceId: race ? requiredString(race, "id") : null,
      race: race ? { id: requiredString(race, "id"), name: species } : null,
      species,
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

  createTimelineTrack(workId: string, input: TimelineTrackInput, source = "create", sourceRef: string | null = null): Record<string, unknown> {
    this.getWork(workId);
    return this.insertTimelineTrackWithId(workId, id("timeline-track"), input, source, sourceRef);
  }

  private insertTimelineTrackWithId(
    workId: string,
    trackId: string,
    input: TimelineTrackInput,
    source = "create",
    sourceRef: string | null = null,
    changeNote = ""
  ): Record<string, unknown> {
    const timestamp = now();
    const fallbackOrder = Number(this.db.get("SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM timeline_tracks WHERE work_id = ?", workId)?.value ?? 0);
    this.db.transaction(() => {
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
      this.recordEntityVersion("timeline-track", trackId, source, sourceRef, changeNote || "建立独立时间轴", timestamp);
      this.audit(workId, source === "restore" ? "timeline-track.restored" : "timeline-track.created", "timeline-track", trackId, { source, sourceRef });
    });
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

  updateTimelineTrack(
    trackId: string,
    input: Partial<TimelineTrackInput>,
    source = "manual",
    sourceRef: string | null = null,
    changeNote = ""
  ): Record<string, unknown> {
    const current = this.getTimelineTrack(trackId);
    this.db.transaction(() => {
      this.db.run(
        "UPDATE timeline_tracks SET name = ?, description = ?, sort_order = ?, updated_at = ? WHERE id = ?",
        input.name ?? String(current.name),
        input.description ?? String(current.description),
        input.sortOrder ?? Number(current.sortOrder),
        now(),
        trackId
      );
      this.recordEntityVersion("timeline-track", trackId, source, sourceRef, changeNote || "更新时间轴");
      this.audit(String(current.workId), "timeline-track.updated", "timeline-track", trackId, { fields: Object.keys(input), source, sourceRef });
    });
    return this.getTimelineTrack(trackId);
  }

  deleteTimelineTrack(trackId: string): void {
    const current = this.getTimelineTrack(trackId);
    this.db.transaction(() => {
      this.recordEntityVersion("timeline-track", trackId, "delete", null, "删除时间轴");
      this.db.run("DELETE FROM timeline_tracks WHERE id = ?", trackId);
      this.audit(String(current.workId), "timeline-track.deleted", "timeline-track", trackId);
    });
  }

  createTimelineEvent(workId: string, input: TimelineInput, source = "create", sourceRef: string | null = null): Record<string, unknown> {
    this.getWork(workId);
    if (input.trackId) {
      const track = this.getTimelineTrack(input.trackId);
      if (track.workId !== workId) throw new AppError(400, "TIMELINE_TRACK_WORK_MISMATCH", "独立时间轴不属于当前作品");
    }
    return this.insertTimelineEventWithId(workId, id("event"), input, source, sourceRef);
  }

  private insertTimelineEventWithId(
    workId: string,
    eventId: string,
    input: TimelineInput,
    source = "create",
    sourceRef: string | null = null,
    changeNote = ""
  ): Record<string, unknown> {
    if (input.trackId) {
      const track = this.getTimelineTrack(input.trackId);
      if (track.workId !== workId) throw new AppError(400, "TIMELINE_TRACK_WORK_MISMATCH", "独立时间轴不属于当前作品");
    }
    const timestamp = now();
    this.db.transaction(() => {
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
      this.recordEntityVersion(
        "timeline-event",
        eventId,
        source,
        sourceRef,
        changeNote || (source === "analysis" ? "AI 提取时间事件" : "建立时间事件"),
        timestamp
      );
      this.audit(workId, source === "restore" ? "timeline.restored" : "timeline.created", "timeline-event", eventId, { source, sourceRef });
    });
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

  updateTimelineEvent(
    eventId: string,
    input: Partial<TimelineInput>,
    source = "manual",
    sourceRef: string | null = null,
    changeNote = ""
  ): Record<string, unknown> {
    const current = this.getTimelineEvent(eventId);
    if (input.trackId) {
      const track = this.getTimelineTrack(input.trackId);
      if (track.workId !== current.workId) throw new AppError(400, "TIMELINE_TRACK_WORK_MISMATCH", "独立时间轴不属于当前作品");
    }
    this.db.transaction(() => {
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
      this.recordEntityVersion("timeline-event", eventId, source, sourceRef, changeNote || "更新时间事件");
      this.audit(String(current.workId), "timeline.updated", "timeline-event", eventId, { fields: Object.keys(input), source, sourceRef });
    });
    return this.getTimelineEvent(eventId);
  }

  deleteTimelineEvent(eventId: string): void {
    const current = this.getTimelineEvent(eventId);
    this.db.transaction(() => {
      this.recordEntityVersion("timeline-event", eventId, "delete", null, "删除时间事件");
      this.db.run("DELETE FROM timeline_events WHERE id = ?", eventId);
      this.audit(String(current.workId), "timeline.deleted", "timeline-event", eventId);
    });
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
      }, "merge", uniqueIds.join(","));
      for (const eventId of uniqueIds) {
        this.recordEntityVersion("timeline-event", eventId, "delete", null, "删除时间事件");
        this.db.run("DELETE FROM timeline_events WHERE id = ?", eventId);
      }
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
      }, "split", eventId));
      this.recordEntityVersion("timeline-event", eventId, "delete", null, "删除时间事件");
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

  createRelationship(workId: string, input: RelationshipInput, source = "create", sourceRef: string | null = null): Record<string, unknown> {
    this.getWork(workId);
    return this.insertRelationshipWithId(workId, id("relationship"), input, source, sourceRef);
  }

  private insertRelationshipWithId(
    workId: string,
    relationshipId: string,
    input: RelationshipInput,
    source = "create",
    sourceRef: string | null = null,
    changeNote = ""
  ): Record<string, unknown> {
    let fromCharacterId = input.fromCharacterId;
    let toCharacterId = input.toCharacterId;
    if (fromCharacterId === toCharacterId) throw new AppError(400, "SELF_RELATIONSHIP", "人物关系不能指向自身");
    const from = this.getCharacter(fromCharacterId);
    const to = this.getCharacter(toCharacterId);
    if (from.workId !== workId || to.workId !== workId) throw new AppError(400, "CHARACTER_WORK_MISMATCH", "关系人物不属于当前作品");
    if (!input.directed && fromCharacterId.localeCompare(toCharacterId) > 0) [fromCharacterId, toCharacterId] = [toCharacterId, fromCharacterId];
    this.assertRelationshipUnique(workId, fromCharacterId, toCharacterId, input.category, input.subtype ?? "", Boolean(input.directed));
    const timestamp = now();
    const keywords = this.normalizeRelationshipKeywords(input.keywords ?? []);
    this.db.transaction(() => {
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
      this.recordEntityVersion(
        "relationship",
        relationshipId,
        source,
        sourceRef,
        changeNote || (source === "analysis" ? "AI 提取人物关系" : "建立人物关系"),
        timestamp
      );
      this.audit(workId, source === "restore" ? "relationship.restored" : "relationship.created", "relationship", relationshipId, { source, sourceRef });
    });
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

  updateRelationship(
    relationshipId: string,
    input: Partial<RelationshipInput>,
    source = "manual",
    sourceRef: string | null = null,
    changeNote = ""
  ): Record<string, unknown> {
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
    this.db.transaction(() => {
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
      this.recordEntityVersion("relationship", relationshipId, source, sourceRef, changeNote || "更新人物关系");
      this.audit(String(current.workId), "relationship.updated", "relationship", relationshipId, { fields: Object.keys(input), source, sourceRef });
    });
    return this.getRelationship(relationshipId);
  }

  deleteRelationship(relationshipId: string): void {
    const current = this.getRelationship(relationshipId);
    this.db.transaction(() => {
      this.recordEntityVersion("relationship", relationshipId, "delete", null, "删除人物关系");
      this.db.run("DELETE FROM relationships WHERE id = ?", relationshipId);
      this.audit(String(current.workId), "relationship.deleted", "relationship", relationshipId);
    });
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
       status, issues_json, context_refs_json, failure, created_at, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      guardId,
      input.suggestionId,
      input.callId ?? null,
      input.chapterVersion,
      contentHash,
      input.status,
      JSON.stringify(input.issues ?? []),
      JSON.stringify(input.contextRefs ?? {}),
      input.failure ?? null,
      now(),
      currentRequestActor()?.userId ?? null
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
      "INSERT INTO ai_conversations (id, work_id, title, created_at, updated_at, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?)",
      conversationId,
      workId,
      title.trim() || "新对话",
      timestamp,
      timestamp,
      currentRequestActor()?.userId ?? null
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
        "INSERT INTO ai_conversation_messages (id, conversation_id, role, content, citations_json, metadata_json, created_at, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        messageId,
        conversationId,
        input.role,
        input.content,
        JSON.stringify(input.citations ?? []),
        JSON.stringify(input.metadata ?? {}),
        timestamp,
        currentRequestActor()?.userId ?? null
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
        "INSERT INTO ai_conversations (id, work_id, title, created_at, updated_at, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?)",
        forkId,
        requiredString(conversation, "work_id"),
        title.slice(0, 200),
        timestamp,
        timestamp,
        currentRequestActor()?.userId ?? null
      );
      for (const message of messages.slice(0, targetIndex + 1)) {
        this.db.run(
          "INSERT INTO ai_conversation_messages (id, conversation_id, role, content, citations_json, metadata_json, created_at, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          id("message"),
          forkId,
          requiredString(message, "role"),
          requiredString(message, "content"),
          requiredString(message, "citations_json"),
          requiredString(message, "metadata_json"),
          requiredString(message, "created_at"),
          currentRequestActor()?.userId ?? null
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
      `INSERT INTO analysis_tasks (id, work_id, task_type, scope_json, status, source_versions_json, created_at, updated_at, created_by_user_id)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      taskId,
      workId,
      input.taskType,
      JSON.stringify(scope),
      JSON.stringify(sourceVersions),
      timestamp,
      timestamp,
      currentRequestActor()?.userId ?? null
    );
    this.audit(workId, "task.created", "analysis-task", taskId, { taskType: input.taskType, scope });
    this.notifyAnalysisTaskQueued(workId);
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

  countRunningTasks(workId: string): number {
    const row = this.db.get(
      "SELECT COUNT(*) AS value FROM analysis_tasks WHERE work_id = ? AND status = 'running'",
      workId
    );
    return numberValue(row ?? {}, "value");
  }

  listOldestPendingTaskIds(workId: string, limit: number): string[] {
    if (limit <= 0) return [];
    return this.db.all(
      `SELECT id FROM analysis_tasks WHERE work_id = ? AND status = 'pending'
       ORDER BY created_at ASC, id ASC LIMIT ?`,
      workId,
      limit
    ).map((row) => requiredString(row, "id"));
  }

  countPendingTasks(workId: string): number {
    const row = this.db.get(
      "SELECT COUNT(*) AS value FROM analysis_tasks WHERE work_id = ? AND status = 'pending'",
      workId
    );
    return numberValue(row ?? {}, "value");
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
    const workId = requiredString(row, "work_id");
    const scope = json<Record<string, unknown>>(requiredString(row, "scope_json"), {});
    return {
      id: requiredString(row, "id"),
      workId,
      taskType: requiredString(row, "task_type"),
      scope,
      scopeSummary: this.taskScopeSummary(workId, scope),
      scopeDetails: this.taskScopeDetails(workId, scope),
      status: requiredString(row, "status"),
      progress: numberValue(row, "progress"),
      result: json(requiredString(row, "result_json"), {}),
      failures: json(requiredString(row, "failure_json"), []),
      sourceVersions: json(requiredString(row, "source_versions_json"), {}),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  private taskScopeSummary(workId: string, scope: Record<string, unknown>): string {
    if (typeof scope.chapterId === "string") {
      const chapter = this.db.get(
        `SELECT chapter.title AS title, volume.title AS volume_title
         FROM chapters chapter
         JOIN volumes volume ON volume.id = chapter.volume_id
         WHERE chapter.id = ? AND chapter.work_id = ?`,
        scope.chapterId,
        workId
      );
      if (!chapter) return "章节已删除";
      const title = requiredString(chapter, "title");
      const volumeTitle = requiredString(chapter, "volume_title");
      return `${volumeTitle} · ${title}`;
    }
    if (scope.type === "volume" && typeof scope.volumeId === "string") {
      const volume = this.db.get("SELECT title FROM volumes WHERE id = ? AND work_id = ?", scope.volumeId, workId);
      return volume ? `分卷 · ${requiredString(volume, "title")}` : "分卷已删除";
    }
    if (scope.type === "book" || Object.keys(scope).length === 0) return "全书";
    return "未指定范围";
  }

  private taskScopeDetails(workId: string, scope: Record<string, unknown>): Record<string, unknown>[] {
    if (typeof scope.chapterId === "string") {
      const chapter = this.db.get(
        `SELECT chapter.id AS id, chapter.title AS title, chapter.version_no AS version_no,
                volume.id AS volume_id, volume.title AS volume_title
         FROM chapters chapter
         JOIN volumes volume ON volume.id = chapter.volume_id
         WHERE chapter.id = ? AND chapter.work_id = ?`,
        scope.chapterId,
        workId
      );
      if (!chapter) return [{ type: "chapter", chapterId: scope.chapterId, missing: true }];
      return [{
        type: "chapter",
        chapterId: requiredString(chapter, "id"),
        title: requiredString(chapter, "title"),
        versionNo: numberValue(chapter, "version_no"),
        volumeId: requiredString(chapter, "volume_id"),
        volumeTitle: requiredString(chapter, "volume_title")
      }];
    }
    if (scope.type === "volume" && typeof scope.volumeId === "string") {
      const volume = this.db.get("SELECT id, title FROM volumes WHERE id = ? AND work_id = ?", scope.volumeId, workId);
      if (!volume) return [{ type: "volume", volumeId: scope.volumeId, missing: true }];
      const chapters = this.db.all(
        "SELECT id, title, version_no FROM chapters WHERE volume_id = ? ORDER BY sort_order, created_at",
        scope.volumeId
      );
      return [{
        type: "volume",
        volumeId: requiredString(volume, "id"),
        title: requiredString(volume, "title"),
        chapters: chapters.map((item) => ({
          chapterId: requiredString(item, "id"),
          title: requiredString(item, "title"),
          versionNo: numberValue(item, "version_no")
        }))
      }];
    }
    if (scope.type === "book" || Object.keys(scope).length === 0) {
      return [{ type: "book", title: "全书" }];
    }
    return [{ type: "unknown", scope }];
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
    const races = this.db.all(
      "SELECT id, name, description, settings_json FROM races WHERE work_id = ? AND (name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR settings_json LIKE ? ESCAPE '\\') LIMIT 50",
      workId,
      pattern,
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
      ...characters.map((row) => ({ type: "character", id: requiredString(row, "id"), title: requiredString(row, "name"), snippet: [requiredString(row, "species"), ...json<string[]>(requiredString(row, "aliases_json"), [])].filter(Boolean).join("、") })),
      ...settings.map((row) => ({ type: "setting", id: requiredString(row, "id"), title: requiredString(row, "title"), snippet: snippet(requiredString(row, "content")), category: requiredString(row, "category") })),
      ...races.map((row) => ({ type: "race", id: requiredString(row, "id"), title: requiredString(row, "name"), snippet: snippet(`${requiredString(row, "description")}\n${json<string[]>(requiredString(row, "settings_json"), []).join("\n")}`) })),
      ...organizations.map((row) => ({ type: "organization", id: requiredString(row, "id"), title: requiredString(row, "name"), snippet: snippet(`${requiredString(row, "description")}\n${json<string[]>(requiredString(row, "settings_json"), []).join("\n")}`) })),
      ...chapters.map((row) => ({ type: "chapter", id: requiredString(row, "id"), title: requiredString(row, "title"), snippet: snippet(requiredString(row, "content")), volumeId: requiredString(row, "volume_id") }))
    ];
  }

  exportWork(workId: string): Record<string, unknown> {
    const tree = this.getWorkTree(workId);
    return {
      schemaVersion: 6,
      exportedAt: now(),
      work: tree,
      settings: this.listSettings(workId),
      characters: this.listCharacters(workId),
      races: this.listRaces(workId),
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
    return this.db.all(
      `SELECT log.*, user.display_name AS actor_display_name, user.username AS actor_username
       FROM audit_logs log LEFT JOIN users user ON user.id = log.user_id
       WHERE log.work_id = ? ORDER BY log.created_at DESC LIMIT 200`,
      workId
    ).map((row) => ({
      id: requiredString(row, "id"),
      action: requiredString(row, "action"),
      entityType: requiredString(row, "entity_type"),
      entityId: optionalString(row, "entity_id"),
      actor: optionalString(row, "actor_display_name") ?? optionalString(row, "actor_username") ?? requiredString(row, "actor"),
      userId: optionalString(row, "user_id"),
      detail: json(requiredString(row, "detail_json"), {}),
      createdAt: requiredString(row, "created_at")
    }));
  }
}
