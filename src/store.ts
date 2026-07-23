import type { ParsedNovel } from "./domain.js";
import { createHash } from "node:crypto";
import { Database, PLATFORM_AI_WORK_ID, type Row } from "./database.js";
import { AppError, notFound } from "./errors.js";
import { accountReference, logger } from "./logger.js";
import { paginated, paginationSql, type PaginatedResult, type Pagination } from "./pagination.js";
import { currentRequestActor } from "./request-context.js";
import {
  classifyWorkModulePermissions,
  emptyWorkModulePermissions,
  fullWorkModulePermissions,
  storedWorkModulePermissions,
  type WorkModulePermissions
} from "./work-permissions.js";
import {
  countWords,
  documentShortSearchTerms,
  id,
  json,
  normalizeDocumentSearchText,
  normalizeParagraphSpacing,
  now,
  splitDocumentParagraphs
} from "./utils.js";

type WorkInput = {
  title: string;
  author?: string;
  description?: string;
  language?: string;
  coverUrl?: string | null;
  tags?: string[];
};

type ChapterType = "正文" | "设定" | "作者的话" | "其他";
type ImportMode = "append" | "overwrite";

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

export type CharacterProfileSectionInput = {
  sectionType?: string;
  title: string;
  contentMarkdown?: string;
  summary?: string;
  sortOrder?: number;
  sourcePath?: string | null;
  sourceHash?: string | null;
};

export type AttachmentInput = {
  originalName: string;
  originalMimeType: string;
  storedMimeType: string;
  originalByteLength: number;
  storedByteLength: number;
  originalSha256: string;
  storedSha256: string;
  storageKey: string;
  width: number;
  height: number;
  pageCount: number;
  animated: boolean;
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
  parentRaceId?: string | null;
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
  "work",
  "volume",
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
  metadata?: { modelDisplayName?: string; outputTokens?: number; processDurationMs?: number; toolCalls?: unknown[]; processSteps?: unknown[] };
};

export type AiConversationContext = {
  workId: string;
  summary: string;
  compactedMessageCount: number;
  totalMessageCount: number;
  warningPending: boolean;
  messages: Array<{ id: string; role: "user" | "assistant"; content: string }>;
};

type RestorableFileSnapshotChapter = {
  title: string;
  content: string;
  sortOrder: number;
  chapterType: ChapterType;
};

type RestorableFileSnapshotVolume = {
  title: string;
  kind: string;
  source: string;
  description: string;
  keywords: string[];
  sortOrder: number;
  chapters: RestorableFileSnapshotChapter[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalidFileSnapshot(): never {
  throw new AppError(409, "FILE_VERSION_INVALID", "正文历史快照已损坏，未执行恢复");
}

function parseRestorableFileSnapshot(value: string, workId: string): { volumes: RestorableFileSnapshotVolume[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    invalidFileSnapshot();
  }
  if (!isRecord(parsed) || parsed.id !== workId || !Array.isArray(parsed.volumes) || parsed.volumes.length > 10_000) {
    return invalidFileSnapshot();
  }
  let chapterCount = 0;
  let contentLength = 0;
  const volumes = parsed.volumes.map((volumeValue) => {
    if (!isRecord(volumeValue) || typeof volumeValue.title !== "string" || typeof volumeValue.kind !== "string"
      || typeof volumeValue.source !== "string" || typeof volumeValue.sortOrder !== "number"
      || !Number.isFinite(volumeValue.sortOrder) || !Array.isArray(volumeValue.chapters)) {
      return invalidFileSnapshot();
    }
    const description = volumeValue.description === undefined ? "" : volumeValue.description;
    const keywords = volumeValue.keywords === undefined ? [] : volumeValue.keywords;
    if (typeof description !== "string" || !Array.isArray(keywords) || !keywords.every((keyword) => typeof keyword === "string")) {
      return invalidFileSnapshot();
    }
    const chapters = volumeValue.chapters.map((chapterValue) => {
      if (!isRecord(chapterValue) || typeof chapterValue.title !== "string" || typeof chapterValue.content !== "string"
        || typeof chapterValue.sortOrder !== "number" || !Number.isFinite(chapterValue.sortOrder)
        || !["正文", "设定", "作者的话", "其他"].includes(String(chapterValue.chapterType))) {
        return invalidFileSnapshot();
      }
      chapterCount += 1;
      contentLength += chapterValue.content.length;
      if (chapterCount > 100_000 || contentLength > 20_000_000) return invalidFileSnapshot();
      return {
        title: chapterValue.title,
        content: chapterValue.content,
        sortOrder: chapterValue.sortOrder,
        chapterType: chapterValue.chapterType as ChapterType
      };
    });
    return {
      title: volumeValue.title,
      kind: volumeValue.kind,
      source: volumeValue.source,
      description,
      keywords: [...keywords] as string[],
      sortOrder: volumeValue.sortOrder,
      chapters
    };
  });
  return { volumes };
}

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

  private currentEntityVersionNo(type: VersionedEntityType, entityId: string): number {
    const row = this.db.get(
      "SELECT MAX(version_no) AS version_no FROM entity_versions WHERE entity_type = ? AND entity_id = ?",
      type,
      entityId
    );
    return numberValue(row ?? {}, "version_no");
  }

  private currentChapterVersionNo(chapterId: string): number {
    return numberValue(this.db.get("SELECT MAX(version_no) AS version_no FROM chapter_versions WHERE chapter_id = ?", chapterId) ?? {}, "version_no");
  }

  private currentCharacterVersionNo(characterId: string): number {
    return numberValue(this.db.get("SELECT MAX(version_no) AS version_no FROM character_versions WHERE character_id = ?", characterId) ?? {}, "version_no");
  }

  private currentCharacterSectionVersionNo(sectionId: string): number {
    return numberValue(this.db.get("SELECT MAX(version_no) AS version_no FROM character_profile_section_versions WHERE section_id = ?", sectionId) ?? {}, "version_no");
  }

  private assertExpectedVersion(
    type: VersionedEntityType,
    entityId: string,
    expectedVersionNo: number | undefined,
    entityName: string,
    currentVersionNo = this.currentEntityVersionNo(type, entityId)
  ): void {
    if (expectedVersionNo === undefined || expectedVersionNo === currentVersionNo) return;
    throw new AppError(409, "VERSION_CONFLICT", `${entityName}已发生变化，请刷新后重试`, {
      entityType: type,
      entityId,
      expectedVersionNo,
      currentVersionNo
    });
  }

  private assertExpectedRevision(
    entityType: string,
    entityId: string,
    expectedVersionNo: number | undefined,
    entityName: string,
    currentVersionNo: number
  ): void {
    if (expectedVersionNo === undefined || expectedVersionNo === currentVersionNo) return;
    throw new AppError(409, "VERSION_CONFLICT", `${entityName}已发生变化，请刷新后重试`, {
      entityType,
      entityId,
      expectedVersionNo,
      currentVersionNo
    });
  }

  private versionedEntity(type: VersionedEntityType, entityId: string): Record<string, unknown> {
    if (type === "work") return this.getWork(entityId);
    if (type === "volume") return this.getVolume(entityId);
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
    if (type === "work") return {
      title: entity.title,
      author: entity.author,
      description: entity.description,
      language: entity.language,
      coverUrl: entity.coverUrl,
      tags: entity.tags,
      ownerUserId: entity.ownerUserId
    };
    if (type === "volume") return {
      title: entity.title,
      kind: entity.kind,
      source: entity.source,
      description: entity.description,
      keywords: entity.keywords,
      sortOrder: entity.sortOrder
    };
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
    if (type === "race") return {
      name: entity.name,
      parentRaceId: entity.parentRaceId,
      description: entity.description,
      settings: entity.settings,
      memberIds: entity.memberIds
    };
    if (type === "organization") return {
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
      type === "work" ? entityId : String(entity.workId),
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
      ...this.db.all("SELECT id, updated_at FROM works").map((row) => ["work", requiredString(row, "id"), requiredString(row, "updated_at")] as [VersionedEntityType, string, string]),
      ...this.db.all("SELECT id, updated_at FROM volumes").map((row) => ["volume", requiredString(row, "id"), requiredString(row, "updated_at")] as [VersionedEntityType, string, string]),
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

  listEntityVersionsPage(type: VersionedEntityType, entityId: string, pagination: Pagination): PaginatedResult<Record<string, unknown>> {
    const page = paginationSql(pagination);
    const rows = this.db.all(
      `SELECT version.*, user.display_name AS actor_display_name, user.username AS actor_username
       FROM entity_versions version LEFT JOIN users user ON user.id = version.created_by_user_id
       WHERE version.entity_type = ? AND version.entity_id = ? ORDER BY version.version_no DESC${page.sql}`,
      type,
      entityId,
      ...page.params
    );
    if (!rows.length && pagination.page === 1) this.versionedEntity(type, entityId);
    return paginated(rows.map((row) => ({
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
    })), pagination);
  }

  restoreEntityVersion(type: VersionedEntityType, entityId: string, versionNo: number, expectedVersionNo?: number): Record<string, unknown> {
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
    const currentVersionNo = existing
      ? type === "work" ? Number(existing.versionNo) : type === "volume" ? Number(existing.versionNo) : this.currentEntityVersionNo(type, entityId)
      : this.currentEntityVersionNo(type, entityId);
    this.assertExpectedVersion(type, entityId, expectedVersionNo, type === "work" ? "作品" : type === "volume" ? "分卷" : "创作资料", currentVersionNo);
    let restored: Record<string, unknown>;
    if (!existing) {
      restored = this.recreateEntityFromSnapshot(type, workId, entityId, snapshot, sourceRef, changeNote);
    } else if (type === "work") restored = this.updateWork(entityId, snapshot as Partial<WorkInput>, expectedVersionNo, "restore", sourceRef, changeNote);
    else if (type === "volume") restored = this.updateVolume(entityId, snapshot as Partial<{ title: string; kind?: string; description?: string; keywords?: string[]; sortOrder?: number }>, expectedVersionNo, "restore", sourceRef, changeNote);
    else if (type === "setting") restored = this.updateSetting(entityId, snapshot as Partial<SettingInput>, "restore", sourceRef, changeNote, expectedVersionNo);
    else if (type === "race") restored = this.updateRace(entityId, snapshot as Partial<RaceInput>, "restore", sourceRef, changeNote, expectedVersionNo);
    else if (type === "organization") restored = this.updateOrganization(entityId, snapshot as Partial<OrganizationInput>, "restore", sourceRef, changeNote, expectedVersionNo);
    else if (type === "timeline-track") restored = this.updateTimelineTrack(entityId, snapshot as Partial<TimelineTrackInput>, "restore", sourceRef, changeNote, expectedVersionNo);
    else if (type === "timeline-event") restored = this.updateTimelineEvent(entityId, snapshot as Partial<TimelineInput>, "restore", sourceRef, changeNote, expectedVersionNo);
    else if (type === "relationship") restored = this.updateRelationship(entityId, snapshot as Partial<RelationshipInput>, "restore", sourceRef, changeNote, expectedVersionNo);
    else if (type === "chapter-outline") restored = this.upsertChapterOutline(entityId, snapshot as ChapterOutlineInput, "restore", sourceRef, changeNote, expectedVersionNo);
    else restored = this.updateForeshadow(entityId, snapshot as Partial<ForeshadowInput>, "restore", sourceRef, changeNote, expectedVersionNo);
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
    if (type === "work") {
      return this.db.transaction(() => {
        const ownerUserId = typeof snapshot.ownerUserId === "string" ? snapshot.ownerUserId : null;
        const timestamp = now();
        this.db.run(
          `INSERT INTO works (id, title, author, description, language, cover_url, tags_json, version_no, created_at, updated_at, owner_user_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
          entityId,
          String(snapshot.title ?? "未命名作品"),
          String(snapshot.author ?? ""),
          String(snapshot.description ?? ""),
          String(snapshot.language ?? "zh-CN"),
          snapshot.coverUrl as string | null ?? null,
          JSON.stringify(Array.isArray(snapshot.tags) ? snapshot.tags : []),
          timestamp,
          timestamp,
          ownerUserId
        );
        if (ownerUserId) {
          this.db.run(
            "INSERT INTO work_memberships (work_id, user_id, role, invited_by_user_id, created_at) VALUES (?, ?, 'owner', ?, ?)",
            entityId,
            ownerUserId,
            ownerUserId,
            timestamp
          );
        }
        const versionNo = this.recordEntityVersion("work", entityId, "restore", sourceRef, changeNote, timestamp);
        this.db.run("UPDATE works SET version_no = ? WHERE id = ?", versionNo, entityId);
        this.audit(entityId, "work.restored", "work", entityId, { sourceRef });
        return this.getWork(entityId);
      });
    }
    if (type === "volume") {
      return this.db.transaction(() => this.insertVolumeWithId(workId, entityId, snapshot as { title: string; kind?: string; source?: string; description?: string; keywords?: string[]; sortOrder?: number }, "restore", sourceRef, changeNote));
    }
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
    const detailKeys = detail && typeof detail === "object" && !Array.isArray(detail) ? Object.keys(detail as Record<string, unknown>) : [];
    logger.info("domain.change.recorded", {
      action,
      workId,
      entityType,
      entityId: entityType === "user" && entityId ? accountReference(entityId) : entityId,
      detailKeys
    });
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
      this.recordEntityVersion("work", workId, "create", null, "建立作品", timestamp);
      this.audit(workId, "work.created", "work", workId);
    });
    return this.getWork(workId);
  }

  listWorks(): Record<string, unknown>[] {
    const actor = currentRequestActor();
    if (!actor || (actor.role === "admin" && actor.authentication !== "api-key")) {
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

  listWorksPage(pagination: Pagination): PaginatedResult<Record<string, unknown>> {
    const actor = currentRequestActor();
    const page = paginationSql(pagination);
    const rows = !actor || (actor.role === "admin" && actor.authentication !== "api-key")
      ? this.db.all(`SELECT * FROM works WHERE COALESCE(is_internal, 0) = 0 ORDER BY updated_at DESC${page.sql}`, ...page.params)
      : this.db.all(
        `SELECT DISTINCT work.* FROM works work LEFT JOIN work_memberships membership ON membership.work_id = work.id
         WHERE COALESCE(work.is_internal, 0) = 0 AND (work.owner_user_id = ? OR membership.user_id = ?)
         ORDER BY work.updated_at DESC${page.sql}`,
        actor.userId,
        actor.userId,
        ...page.params
      );
    return paginated(rows.map((row) => this.mapWork(row)), pagination);
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

  getPlatformUiSettings(): Record<string, unknown> {
    const row = this.db.get("SELECT * FROM platform_ui_settings WHERE id = 1");
    return {
      toastPosition: String(row?.toast_position) === "top-right" ? "top-right" : "bottom-right",
      updatedAt: String(row?.updated_at ?? "")
    };
  }

  updatePlatformUiSettings(input: { toastPosition: "bottom-right" | "top-right" }): Record<string, unknown> {
    const timestamp = now();
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO platform_ui_settings (id, toast_position, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET toast_position = excluded.toast_position, updated_at = excluded.updated_at`,
        input.toastPosition,
        timestamp
      );
      this.audit(PLATFORM_AI_WORK_ID, "platform.ui-settings.updated", "platform-ui-settings", "platform-ui-settings", {
        toastPosition: input.toastPosition
      });
    });
    return this.getPlatformUiSettings();
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
      contextCompactThreshold: Math.min(90, Math.max(50, Number(row?.context_compact_threshold ?? 85) || 85)),
      agentTools: json<string[]>(String(row?.agent_tools_json ?? '["story_index","read_chapters","query_story_knowledge","grep","read_character_sections"]'), ["story_index", "read_chapters", "query_story_knowledge", "grep", "read_character_sections"]),
      updatedAt: String(row?.updated_at ?? "")
    };
  }

  updateWorkAiSettings(workId: string, input: {
    systemPrompt?: string;
    autoRunEnabled?: boolean;
    autoRunConcurrency?: number;
    autoRunBatchLimit?: number;
    bookSummaryContextPercent?: number;
    contextCompactThreshold?: number;
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
    const nextContextCompactThreshold = input.contextCompactThreshold ?? Number(current.contextCompactThreshold);
    const nextAgentTools = input.agentTools ?? current.agentTools as string[];
    this.db.run(
      `INSERT INTO work_ai_settings (
         work_id, system_prompt, auto_run_enabled, auto_run_concurrency, auto_run_batch_limit, book_summary_context_percent, context_compact_threshold, agent_tools_json, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(work_id) DO UPDATE SET
         system_prompt = excluded.system_prompt,
         auto_run_enabled = excluded.auto_run_enabled,
         auto_run_concurrency = excluded.auto_run_concurrency,
         auto_run_batch_limit = excluded.auto_run_batch_limit,
         book_summary_context_percent = excluded.book_summary_context_percent,
         context_compact_threshold = excluded.context_compact_threshold,
         agent_tools_json = excluded.agent_tools_json,
         updated_at = excluded.updated_at`,
      workId,
      nextPrompt,
      nextEnabled ? 1 : 0,
      Math.min(8, Math.max(1, nextConcurrency)),
      Math.min(200, Math.max(1, nextBatchLimit)),
      Math.min(90, Math.max(1, nextBookSummaryContextPercent)),
      Math.min(90, Math.max(50, nextContextCompactThreshold)),
      JSON.stringify(nextAgentTools),
      timestamp
    );
    this.audit(workId, "work.ai-settings.updated", "work-ai-settings", workId, {
      systemPromptChanged: input.systemPrompt !== undefined,
      autoRunEnabled: nextEnabled,
      autoRunConcurrency: Math.min(8, Math.max(1, nextConcurrency)),
      autoRunBatchLimit: Math.min(200, Math.max(1, nextBatchLimit)),
      bookSummaryContextPercent: Math.min(90, Math.max(1, nextBookSummaryContextPercent)),
      contextCompactThreshold: Math.min(90, Math.max(50, nextContextCompactThreshold)),
      agentTools: nextAgentTools
    });
    return this.getWorkAiSettings(workId);
  }

  updateWork(workId: string, input: Partial<WorkInput>, expectedVersionNo?: number, source = "manual", sourceRef: string | null = null, changeNote = ""): Record<string, unknown> {
    this.db.transaction(() => {
      const current = this.getWork(workId);
      this.assertExpectedVersion("work", workId, expectedVersionNo, "作品", Number(current.versionNo));
      const timestamp = now();
      this.db.run(
        `UPDATE works SET title = ?, author = ?, description = ?, language = ?, cover_url = ?, tags_json = ?, version_no = version_no + 1, updated_at = ?
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
      this.recordEntityVersion("work", workId, source, sourceRef, changeNote || "更新作品信息", timestamp);
      this.audit(workId, "work.updated", "work", workId, { fields: Object.keys(input), versionNo: Number(current.versionNo) + 1, source, sourceRef, changeNote });
    });
    return this.getWork(workId);
  }

  deleteWork(workId: string, expectedVersionNo?: number): string[] {
    const work = this.getWork(workId);
    const storageKeys = this.db.all("SELECT DISTINCT storage_key FROM attachments WHERE work_id = ?", workId)
      .map((row) => requiredString(row, "storage_key"));
    this.db.transaction(() => {
      const current = this.getWork(workId);
      this.assertExpectedVersion("work", workId, expectedVersionNo, "作品", Number(current.versionNo));
      this.recordEntityVersion("work", workId, "delete", null, "删除作品");
      this.audit(null, "work.deleted", "work", workId, { title: work.title });
      this.db.run("DELETE FROM works WHERE id = ?", workId);
    });
    return storageKeys.filter((storageKey) => Number(
      this.db.get("SELECT COUNT(*) AS count FROM attachments WHERE storage_key = ?", storageKey)?.count ?? 0
    ) === 0);
  }

  setWorkCover(workId: string, mimeType: "image/jpeg" | "image/png" | "image/webp", content: Buffer, expectedVersionNo?: number): Record<string, unknown> {
    const sha256 = createHash("sha256").update(content).digest("hex");
    this.db.transaction(() => {
      const current = this.getWork(workId);
      this.assertExpectedVersion("work", workId, expectedVersionNo, "作品", Number(current.versionNo));
      const timestamp = now();
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
      this.db.run("UPDATE works SET version_no = version_no + 1, updated_at = ? WHERE id = ?", timestamp, workId);
      this.recordEntityVersion("work", workId, "manual", null, "更新作品封面", timestamp);
      this.audit(workId, "work.cover.updated", "work", workId, { mimeType, byteLength: content.byteLength, sha256 });
    });
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

  deleteWorkCover(workId: string, expectedVersionNo?: number): void {
    this.db.transaction(() => {
      const current = this.getWork(workId);
      this.assertExpectedVersion("work", workId, expectedVersionNo, "作品", Number(current.versionNo));
      const timestamp = now();
      this.db.run("DELETE FROM work_covers WHERE work_id = ?", workId);
      this.db.run("UPDATE works SET version_no = version_no + 1, updated_at = ? WHERE id = ?", timestamp, workId);
      this.recordEntityVersion("work", workId, "manual", null, "删除作品封面", timestamp);
      this.audit(workId, "work.cover.deleted", "work", workId);
    });
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

  getWorkDirectory(workId: string): Record<string, unknown> {
    const work = this.getWork(workId);
    const permissions = work.modulePermissions as WorkModulePermissions;
    if (permissions.prose === "none") return { ...work, volumes: [] };
    const volumeRows = this.db.all("SELECT * FROM volumes WHERE work_id = ? ORDER BY sort_order, created_at", workId);
    const chapterRows = this.db.all(
      `SELECT id, work_id, volume_id, title, chapter_type, sort_order, word_count, version_no,
        analysis_status, excluded_from_analysis, created_at, updated_at
       FROM chapters WHERE work_id = ? ORDER BY sort_order, created_at`,
      workId
    );
    const chaptersByVolume = new Map<string, Record<string, unknown>[]>();
    for (const row of chapterRows) {
      const chapter = this.mapChapterDirectoryEntry(row);
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

  getWorkDirectoryPage(workId: string, pagination: Pagination): Record<string, unknown> {
    const work = this.getWork(workId);
    const permissions = work.modulePermissions as WorkModulePermissions;
    if (permissions.prose === "none") return { ...work, volumes: [], directoryPage: paginated([], pagination) };
    const volumeRows = this.db.all("SELECT * FROM volumes WHERE work_id = ? ORDER BY sort_order, created_at", workId);
    const page = paginationSql(pagination);
    const chapterRows = this.db.all(
      `SELECT id, work_id, volume_id, title, chapter_type, sort_order, word_count, version_no,
        analysis_status, excluded_from_analysis, created_at, updated_at
       FROM chapters WHERE work_id = ? ORDER BY sort_order, created_at${page.sql}`,
      workId,
      ...page.params
    );
    const chapters = chapterRows.map((row) => this.mapChapterDirectoryEntry(row));
    const chaptersByVolume = new Map<string, Record<string, unknown>[]>();
    for (const chapter of chapters) {
      const volumeId = String(chapter.volumeId);
      const list = chaptersByVolume.get(volumeId) ?? [];
      list.push(chapter);
      chaptersByVolume.set(volumeId, list);
    }
    const volumes = volumeRows.map((row) => ({
      ...this.mapVolume(row),
      chapters: chaptersByVolume.get(requiredString(row, "id")) ?? []
    }));
    return { ...work, volumes, directoryPage: paginated(chapters, pagination) };
  }

  listFileVersions(workId: string): Record<string, unknown>[] {
    this.getWork(workId);
    return this.db
      .all(`SELECT version.id, version.work_id, version.file_name, version.file_type, version.word_count, version.paragraph_count,
        version.warnings_json, version.created_at, user.display_name AS actor_display_name, user.username AS actor_username
        FROM file_versions version LEFT JOIN users user ON user.id = version.created_by_user_id
        WHERE version.work_id = ? ORDER BY version.created_at DESC, version.id DESC`, workId)
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

  listFileVersionsPage(workId: string, pagination: Pagination): PaginatedResult<Record<string, unknown>> {
    this.getWork(workId);
    const page = paginationSql(pagination);
    const rows = this.db.all(
      `SELECT version.id, version.work_id, version.file_name, version.file_type, version.word_count, version.paragraph_count,
        version.warnings_json, version.created_at, user.display_name AS actor_display_name, user.username AS actor_username
       FROM file_versions version LEFT JOIN users user ON user.id = version.created_by_user_id
       WHERE version.work_id = ? ORDER BY version.created_at DESC, version.id DESC${page.sql}`,
      workId,
      ...page.params
    );
    return paginated(rows.map((row) => ({
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      fileName: requiredString(row, "file_name"),
      fileType: requiredString(row, "file_type"),
      wordCount: numberValue(row, "word_count"),
      paragraphCount: numberValue(row, "paragraph_count"),
      warnings: json(requiredString(row, "warnings_json"), []),
      createdAt: requiredString(row, "created_at"),
      actor: optionalString(row, "actor_display_name") ?? optionalString(row, "actor_username") ?? "历史数据"
    })), pagination);
  }

  restoreFileVersion(workId: string, fileVersionId: string, expectedVersionNo?: number): Record<string, unknown> {
    this.getWork(workId);
    const version = this.db.get("SELECT * FROM file_versions WHERE id = ? AND work_id = ?", fileVersionId, workId);
    if (!version) throw notFound("文件版本");
    const { volumes } = parseRestorableFileSnapshot(requiredString(version, "snapshot_json"), workId);
    return this.db.transaction(() => {
      const current = this.getWork(workId);
      this.assertExpectedVersion("work", workId, expectedVersionNo, "作品", Number(current.versionNo));
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
      for (const row of this.db.all("SELECT id FROM volumes WHERE work_id = ?", workId)) {
        this.recordEntityVersion("volume", requiredString(row, "id"), "delete", fileVersionId, "替换作品树前保存分卷历史");
      }
      this.db.run("DELETE FROM volumes WHERE work_id = ?", workId);
      for (const volume of volumes) {
        const volumeId = id("volume");
        this.insertVolumeWithId(workId, volumeId, {
          title: volume.title,
          kind: volume.kind,
          source: volume.source,
          description: volume.description,
          keywords: volume.keywords,
          sortOrder: volume.sortOrder
        }, "restore", fileVersionId, `恢复文件版本 ${fileVersionId}`);
        for (const chapter of volume.chapters) {
          this.insertChapter(
            workId,
            volumeId,
            chapter.title,
            chapter.content,
            chapter.sortOrder,
            "restore",
            fileVersionId,
            chapter.chapterType
          );
        }
      }
      this.db.run("UPDATE works SET version_no = version_no + 1, updated_at = ? WHERE id = ?", timestamp, workId);
      this.recordEntityVersion("work", workId, "restore", fileVersionId, `恢复文件版本 ${fileVersionId}`, timestamp);
      this.audit(workId, "file.restored", "file-version", fileVersionId, { restorePointId });
      return {
        fileVersionId: restorePointId,
        restoredFrom: fileVersionId,
        tree: this.getWorkDirectory(workId)
      };
    });
  }

  importNovel(workId: string, fileName: string, fileType: string, parsed: ParsedNovel, mode: ImportMode = "overwrite", expectedVersionNo?: number): Record<string, unknown> {
    this.getWork(workId);
    let result: Record<string, unknown> = {};
    this.db.transaction(() => { result = this.importNovelInTransaction(workId, fileName, fileType, parsed, mode, expectedVersionNo); });
    return { ...result, tree: this.getWorkDirectory(workId) };
  }

  createImportedWork(input: WorkInput, fileName: string, fileType: string, parsed: ParsedNovel): Record<string, unknown> {
    return this.db.transaction(() => {
      const work = this.createWork(input);
      const imported = this.importNovelInTransaction(String(work.id), fileName, fileType, parsed, undefined, undefined, false);
      return { ...imported, work: this.getWork(String(work.id)) };
    });
  }

  private importNovelInTransaction(workId: string, fileName: string, fileType: string, parsed: ParsedNovel, mode: ImportMode = "overwrite", expectedVersionNo?: number, bumpWorkVersion = true): Record<string, unknown> {
    const current = this.getWork(workId);
    this.assertExpectedVersion("work", workId, expectedVersionNo, "作品", Number(current.versionNo));
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
    let volumeOrderOffset = 0;
    if (mode === "overwrite") {
      for (const row of this.db.all("SELECT id FROM volumes WHERE work_id = ?", workId)) {
        this.recordEntityVersion("volume", requiredString(row, "id"), "delete", fileVersionId, "导入前保存分卷历史");
      }
      this.db.run("DELETE FROM volumes WHERE work_id = ?", workId);
    } else {
      const lastVolume = this.db.get("SELECT COALESCE(MAX(sort_order), -1) AS value FROM volumes WHERE work_id = ?", workId);
      volumeOrderOffset = numberValue(lastVolume ?? {}, "value") + 1;
    }
    let firstImportedChapterId: string | null = null;
    for (const volume of parsed.volumes) {
      const volumeId = id("volume");
      this.insertVolumeWithId(workId, volumeId, {
        title: volume.title,
        kind: volume.kind,
        source: volume.source,
        sortOrder: volumeOrderOffset + volume.order
      }, "import", fileVersionId, "导入分卷");
      for (const chapter of volume.chapters) {
        const chapterId = this.insertChapter(workId, volumeId, chapter.title, chapter.content, chapter.order, "import", fileVersionId, chapter.chapterType);
        firstImportedChapterId ??= chapterId;
      }
    }
    if (bumpWorkVersion) {
      this.db.run("UPDATE works SET version_no = version_no + 1, updated_at = ? WHERE id = ?", timestamp, workId);
      this.recordEntityVersion("work", workId, "import", fileVersionId, "导入作品正文", timestamp);
    }
    this.audit(workId, "work.imported", "file-version", fileVersionId, {
      fileName,
      mode,
      volumeCount: parsed.volumes.length,
      chapterCount: parsed.volumes.reduce((sum, volume) => sum + volume.chapters.length, 0)
    });
    return {
      fileVersionId,
      firstImportedChapterId,
      mode,
      warnings: parsed.warnings,
      wordCount: parsed.wordCount,
      paragraphCount: parsed.paragraphCount
    };
  }

  createVolume(workId: string, input: { title: string; kind?: string; description?: string; keywords?: string[] }): Record<string, unknown> {
    return this.db.transaction(() => this.insertVolumeWithId(workId, id("volume"), input, "create", null, "建立分卷"));
  }

  private insertVolumeWithId(
    workId: string,
    volumeId: string,
    input: { title: string; kind?: string; source?: string; description?: string; keywords?: string[]; sortOrder?: number },
    source = "create",
    sourceRef: string | null = null,
    changeNote = ""
  ): Record<string, unknown> {
    this.getWork(workId);
    const timestamp = now();
    const last = this.db.get("SELECT COALESCE(MAX(sort_order), -1) AS value FROM volumes WHERE work_id = ?", workId);
    this.db.run(
      `INSERT INTO volumes (id, work_id, title, kind, source, description, keywords_json, sort_order, version_no, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      volumeId,
      workId,
      input.title,
      input.kind ?? "main",
      input.source ?? "manual",
      input.description?.trim() ?? "",
      JSON.stringify(this.normalizeVolumeKeywords(input.keywords ?? [])),
      input.sortOrder ?? numberValue(last ?? {}, "value") + 1,
      timestamp,
      timestamp
    );
    const versionNo = this.recordEntityVersion("volume", volumeId, source, sourceRef, changeNote || "建立分卷", timestamp);
    if (versionNo !== 1) this.db.run("UPDATE volumes SET version_no = ? WHERE id = ?", versionNo, volumeId);
    this.audit(workId, source === "restore" ? "volume.restored" : "volume.created", "volume", volumeId, { source, sourceRef });
    return this.getVolume(volumeId);
  }

  getVolume(volumeId: string): Record<string, unknown> {
    const row = this.db.get("SELECT * FROM volumes WHERE id = ?", volumeId);
    if (!row) throw notFound("卷");
    return this.mapVolume(row);
  }

  updateVolume(volumeId: string, input: { title?: string; kind?: string; description?: string; keywords?: string[]; sortOrder?: number }, expectedVersionNo?: number, source = "manual", sourceRef: string | null = null, changeNote = ""): Record<string, unknown> {
    this.db.transaction(() => {
      const current = this.getVolume(volumeId);
      this.assertExpectedVersion("volume", volumeId, expectedVersionNo, "分卷", Number(current.versionNo));
      const timestamp = now();
      this.db.run(
        "UPDATE volumes SET title = ?, kind = ?, description = ?, keywords_json = ?, sort_order = ?, source = ?, version_no = version_no + 1, updated_at = ? WHERE id = ?",
        input.title ?? String(current.title),
        input.kind ?? String(current.kind),
        input.description?.trim() ?? String(current.description),
        JSON.stringify(input.keywords === undefined ? current.keywords : this.normalizeVolumeKeywords(input.keywords)),
        input.sortOrder ?? Number(current.sortOrder),
        source === "restore" ? String(current.source) : "manual",
        timestamp,
        volumeId
      );
      this.recordEntityVersion("volume", volumeId, source, sourceRef, changeNote || "更新分卷信息", timestamp);
      this.audit(String(current.workId), "volume.updated", "volume", volumeId, { ...input, versionNo: Number(current.versionNo) + 1, source, sourceRef, changeNote });
    });
    return this.getVolume(volumeId);
  }

  deleteVolume(volumeId: string, expectedVersionNo?: number): void {
    const volume = this.getVolume(volumeId);
    const count = this.db.get("SELECT COUNT(*) AS value FROM chapters WHERE volume_id = ?", volumeId);
    if (numberValue(count ?? {}, "value") > 0) {
      throw new AppError(409, "VOLUME_NOT_EMPTY", "卷内仍有章节，需先移动或删除章节");
    }
    this.db.transaction(() => {
      const current = this.getVolume(volumeId);
      this.assertExpectedVersion("volume", volumeId, expectedVersionNo, "分卷", Number(current.versionNo));
      this.recordEntityVersion("volume", volumeId, "delete", null, "删除分卷");
      this.db.run("DELETE FROM volumes WHERE id = ?", volumeId);
      this.audit(String(current.workId), "volume.deleted", "volume", volumeId, { versionNo: Number(current.versionNo) });
    });
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
      changeNote: requiredString(row, "change_note"),
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
    changeNote: string;
    timestamp?: string;
  }): void {
    this.db.run(
      `INSERT INTO chapter_versions (
         id, work_id, chapter_id, version_no, title, content, volume_id, sort_order, chapter_type,
         source, source_ref, change_note, created_at, created_by_user_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      input.changeNote.trim(),
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

  listChapterVersionsPage(chapterId: string, pagination: Pagination): PaginatedResult<Record<string, unknown>> {
    const page = paginationSql(pagination);
    const rows = this.db.all(
      `SELECT version.*, user.display_name AS actor_display_name, user.username AS actor_username
        FROM chapter_versions version LEFT JOIN users user ON user.id = version.created_by_user_id
        WHERE version.chapter_id = ? ORDER BY version.version_no DESC${page.sql}`,
      chapterId,
      ...page.params
    );
    if (!rows.length) {
      this.getChapter(chapterId);
      return paginated([], pagination);
    }
    return paginated(rows.slice(pagination.offset, pagination.offset + pagination.limit + 1).map((row) => this.mapChapterVersionRow(row)), pagination);
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

  listChapterInsightsPage(chapterId: string, pagination: Pagination): PaginatedResult<Record<string, unknown>> {
    this.getChapter(chapterId);
    const page = paginationSql(pagination);
    const rows = this.db.all(
      `SELECT * FROM chapter_insights WHERE chapter_id = ? ORDER BY chapter_version DESC, created_at DESC${page.sql}`,
      chapterId,
      ...page.params
    );
    return paginated(rows.map((row) => ({
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
    })), pagination);
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
    sourceRef: string | null = null,
    changeNote = "",
    expectedVersionNo?: number
  ): Record<string, unknown> {
    const current = this.getChapter(chapterId);
    this.assertExpectedRevision("chapter", chapterId, expectedVersionNo, "章节", Number(current.versionNo));
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
      const lockedCurrent = this.getChapter(chapterId);
      this.assertExpectedRevision("chapter", chapterId, expectedVersionNo, "章节", Number(lockedCurrent.versionNo));
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
      if (hasTextChange) this.syncChapterParagraphSearch(String(current.workId), chapterId, nextContent);
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
          changeNote: changeNote || "更新章节正文",
          timestamp
        });
      }
      if (hasTextChange || hasTypeChange) this.invalidateChapter(String(current.workId), chapterId, versionNo);
      this.db.run("UPDATE works SET updated_at = ? WHERE id = ?", timestamp, String(current.workId));
      this.audit(String(current.workId), "chapter.saved", "chapter", chapterId, { versionNo, source, chapterType: nextChapterType, changeNote });
    });
    return this.getChapter(chapterId);
  }

  restoreChapter(chapterId: string, versionNo: number, expectedVersionNo?: number): Record<string, unknown> {
    const version = this.db.get("SELECT * FROM chapter_versions WHERE chapter_id = ? AND version_no = ?", chapterId, versionNo);
    if (!version) throw notFound("章节版本");
    const existing = this.db.get("SELECT id FROM chapters WHERE id = ?", chapterId);
    if (!existing) {
      this.assertExpectedRevision("chapter", chapterId, expectedVersionNo, "章节", this.currentChapterVersionNo(chapterId));
      return this.recreateChapterFromVersion(chapterId, version);
    }
    return this.saveChapter(
      chapterId,
      { title: requiredString(version, "title"), content: requiredString(version, "content") },
      "restore",
      requiredString(version, "id"),
      `恢复至 v${versionNo}`,
      expectedVersionNo
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
      this.syncChapterParagraphSearch(workId, chapterId, content);
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
        changeNote: `恢复至 v${numberValue(version, "version_no")}`,
        timestamp
      });
      this.db.run("UPDATE works SET updated_at = ? WHERE id = ?", timestamp, workId);
      this.audit(workId, "chapter.restored", "chapter", chapterId, { versionNo: nextVersionNo, fromVersion: numberValue(version, "version_no") });
    });
    return this.getChapter(chapterId);
  }

  moveChapter(chapterId: string, input: { volumeId: string; sortOrder: number }, expectedVersionNo?: number): Record<string, unknown> {
    const chapter = this.getChapter(chapterId);
    this.assertExpectedRevision("chapter", chapterId, expectedVersionNo, "章节", Number(chapter.versionNo));
    const volume = this.getVolume(input.volumeId);
    if (volume.workId !== chapter.workId) throw new AppError(400, "VOLUME_WORK_MISMATCH", "卷不属于当前作品");
    this.db.transaction(() => {
      const lockedChapter = this.getChapter(chapterId);
      this.assertExpectedRevision("chapter", chapterId, expectedVersionNo, "章节", Number(lockedChapter.versionNo));
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

  deleteChapter(chapterId: string, expectedVersionNo?: number): void {
    const chapter = this.getChapter(chapterId);
    this.assertExpectedRevision("chapter", chapterId, expectedVersionNo, "章节", Number(chapter.versionNo));
    const timestamp = now();
    const versionNo = Number(chapter.versionNo) + 1;
    this.db.transaction(() => {
      const lockedChapter = this.getChapter(chapterId);
      this.assertExpectedRevision("chapter", chapterId, expectedVersionNo, "章节", Number(lockedChapter.versionNo));
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
        changeNote: "删除章节",
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
    this.syncChapterParagraphSearch(workId, chapterId, normalizedContent);
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
      changeNote: source === "import" ? "导入章节" : "建立章节",
      timestamp
    });
    return chapterId;
  }

  private syncChapterParagraphSearch(workId: string, chapterId: string, content: string): void {
    this.db.run("DELETE FROM chapter_paragraph_search WHERE chapter_id = ?", chapterId);
    for (const [paragraphOrder, paragraph] of splitDocumentParagraphs(content).entries()) {
      const searchContent = normalizeDocumentSearchText(paragraph);
      const inserted = this.db.run(
        `INSERT INTO chapter_paragraph_search (work_id, chapter_id, paragraph_order, content, search_content)
         VALUES (?, ?, ?, ?, ?)`,
        workId,
        chapterId,
        paragraphOrder,
        paragraph,
        searchContent
      );
      for (const term of documentShortSearchTerms(searchContent)) {
        this.db.run(
          "INSERT INTO chapter_paragraph_short_terms (paragraph_id, term) VALUES (?, ?)",
          inserted.lastInsertRowid,
          term
        );
      }
    }
  }

  searchChapterParagraphs(workId: string, keyword: string, limit = 20): Array<{
    chapterId: string;
    chapterTitle: string;
    paragraph: string;
  }> {
    this.getWork(workId);
    const normalizedKeyword = normalizeDocumentSearchText(keyword.trim());
    if (!normalizedKeyword) return [];
    const safeLimit = Math.min(100, Math.max(1, Math.trunc(limit)));
    const columns = `SELECT paragraph.chapter_id, chapter.title AS chapter_title, paragraph.content
      FROM chapter_paragraph_search paragraph
      JOIN chapters chapter ON chapter.id = paragraph.chapter_id
      JOIN volumes volume ON volume.id = chapter.volume_id`;
    const rows = [...normalizedKeyword].length < 3
      ? this.db.all(
          `${columns}
           JOIN chapter_paragraph_short_terms term ON term.paragraph_id = paragraph.id
           WHERE paragraph.work_id = ? AND term.term = ?
           ORDER BY volume.sort_order, chapter.sort_order, paragraph.paragraph_order
           LIMIT ?`,
          workId,
          normalizedKeyword,
          safeLimit
        )
      : this.db.all(
          `${columns}
           JOIN chapter_paragraph_search_fts fts ON fts.rowid = paragraph.id
           WHERE paragraph.work_id = ? AND chapter_paragraph_search_fts MATCH ?
           ORDER BY volume.sort_order, chapter.sort_order, paragraph.paragraph_order
           LIMIT ?`,
          workId,
          `"${normalizedKeyword.replaceAll('"', '""')}"`,
          safeLimit
        );
    return rows.map((row) => ({
      chapterId: requiredString(row, "chapter_id"),
      chapterTitle: requiredString(row, "chapter_title"),
      paragraph: requiredString(row, "content")
    }));
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
      ? this.db.get("SELECT role, permissions_json FROM work_memberships WHERE work_id = ? AND user_id = ?", requiredString(row, "id"), actor.userId)
      : undefined;
    const membershipRole = String(membership?.role ?? "");
    const ownerAccess = ownerUserId === actor?.userId;
    const adminAccess = actor?.role === "admin" && actor.authentication !== "api-key";
    const modulePermissions = !actor || ownerAccess || adminAccess
      ? fullWorkModulePermissions()
      : membershipRole
        ? storedWorkModulePermissions(membershipRole, optionalString(membership ?? {}, "permissions_json"))
        : emptyWorkModulePermissions();
    const accessRole = ownerUserId === actor?.userId
      ? "owner"
      : adminAccess
        ? "admin"
        : membershipRole ? classifyWorkModulePermissions(modulePermissions) : null;
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
      versionNo: numberValue(row, "version_no") || this.currentEntityVersionNo("work", requiredString(row, "id")),
      ownerUserId,
      accessRole,
      modulePermissions,
      chapterCount: modulePermissions.prose === "none" ? 0 : numberValue(count ?? {}, "chapter_count"),
      wordCount: modulePermissions.prose === "none" ? 0 : numberValue(count ?? {}, "word_count"),
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
      versionNo: numberValue(row, "version_no") || this.currentEntityVersionNo("volume", requiredString(row, "id")),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  private normalizeVolumeKeywords(keywords: string[]): string[] {
    return [...new Set(keywords.map((keyword) => keyword.normalize("NFKC").trim()).filter(Boolean))].slice(0, 100);
  }

  private mapChapter(row: Row): Record<string, unknown> {
    return {
      ...this.mapChapterDirectoryEntry(row),
      content: requiredString(row, "content")
    };
  }

  private mapChapterDirectoryEntry(row: Row): Record<string, unknown> {
    return {
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      volumeId: requiredString(row, "volume_id"),
      title: requiredString(row, "title"),
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

  listChapterOutlinesPage(workId: string, pagination: Pagination): PaginatedResult<Record<string, unknown>> {
    this.getWork(workId);
    const page = paginationSql(pagination);
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
       ORDER BY v.sort_order, c.sort_order, c.created_at${page.sql}`,
      workId,
      ...page.params
    );
    return paginated(rows.map((row) => ({
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
    })), pagination);
  }

  upsertChapterOutline(
    chapterId: string,
    input: ChapterOutlineInput,
    source = "manual",
    sourceRef: string | null = null,
    changeNote = "",
    expectedVersionNo?: number
  ): Record<string, unknown> {
    const chapter = this.getChapter(chapterId);
    const current = this.getChapterOutline(chapterId);
    const timestamp = now();
    this.db.transaction(() => {
      if (current) this.assertExpectedVersion("chapter-outline", chapterId, expectedVersionNo, "章节大纲");
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

  deleteChapterOutline(chapterId: string, expectedVersionNo?: number): void {
    const chapter = this.getChapter(chapterId);
    const outline = this.getChapterOutline(chapterId);
    if (!outline) return;
    this.db.transaction(() => {
      this.assertExpectedVersion("chapter-outline", chapterId, expectedVersionNo, "章节大纲");
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
      versionNo: this.currentEntityVersionNo("chapter-outline", requiredString(row, "chapter_id")),
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
      versionNo: this.currentEntityVersionNo("foreshadow", foreshadowId),
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

  listForeshadowsPage(workId: string, pagination: Pagination, status: "all" | "unresolved" | "resolved" = "all", currentChapterId?: string): PaginatedResult<Record<string, unknown>> {
    this.getWork(workId);
    if (currentChapterId) this.assertChapterInWork(currentChapterId, workId);
    const where = status === "unresolved"
      ? "AND status IN ('planned', 'planted')"
      : status === "resolved" ? "AND status IN ('resolved', 'abandoned')" : "";
    const page = paginationSql(pagination);
    const rows = this.db.all(
      `SELECT id FROM foreshadows WHERE work_id = ? ${where}
       ORDER BY CASE importance WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at${page.sql}`,
      workId,
      ...page.params
    );
    return paginated(rows.map((row) => this.getForeshadow(requiredString(row, "id"), currentChapterId)), pagination);
  }

  updateForeshadow(
    foreshadowId: string,
    input: Partial<ForeshadowInput>,
    source = "manual",
    sourceRef: string | null = null,
    changeNote = "",
    expectedVersionNo?: number
  ): Record<string, unknown> {
    const current = this.getForeshadow(foreshadowId);
    const workId = String(current.workId);
    if (input.plannedPayoffChapterId) this.assertChapterInWork(input.plannedPayoffChapterId, workId);
    this.db.transaction(() => {
      this.assertExpectedVersion("foreshadow", foreshadowId, expectedVersionNo, "伏笔");
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

  deleteForeshadow(foreshadowId: string, expectedVersionNo?: number): void {
    const current = this.getForeshadow(foreshadowId);
    this.db.transaction(() => {
      this.assertExpectedVersion("foreshadow", foreshadowId, expectedVersionNo, "伏笔");
      this.recordEntityVersion("foreshadow", foreshadowId, "delete", null, "删除伏笔");
      this.db.run("DELETE FROM foreshadows WHERE id = ?", foreshadowId);
      this.audit(String(current.workId), "foreshadow.deleted", "foreshadow", foreshadowId);
    });
  }

  createForeshadowOccurrence(foreshadowId: string, input: ForeshadowOccurrenceInput, expectedVersionNo?: number): Record<string, unknown> {
    const foreshadow = this.getForeshadow(foreshadowId);
    const occurrenceId = this.db.transaction(() => {
      this.assertExpectedVersion("foreshadow", foreshadowId, expectedVersionNo, "伏笔");
      const createdId = this.insertForeshadowOccurrence(foreshadowId, String(foreshadow.workId), input);
      this.recordEntityVersion("foreshadow", foreshadowId, "manual", createdId, "添加伏笔章节记录");
      this.audit(String(foreshadow.workId), "foreshadow.occurrence.created", "foreshadow-occurrence", createdId);
      return createdId;
    });
    return this.getForeshadowOccurrence(occurrenceId);
  }

  updateForeshadowOccurrence(occurrenceId: string, input: Partial<ForeshadowOccurrenceInput>, expectedVersionNo?: number): Record<string, unknown> {
    const current = this.getForeshadowOccurrence(occurrenceId);
    const foreshadow = this.getForeshadow(String(current.foreshadowId));
    const chapterId = input.chapterId ?? String(current.chapterId);
    this.assertChapterInWork(chapterId, String(foreshadow.workId));
    this.db.transaction(() => {
      this.assertExpectedVersion("foreshadow", String(current.foreshadowId), expectedVersionNo, "伏笔");
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

  deleteForeshadowOccurrence(occurrenceId: string, expectedVersionNo?: number): void {
    const current = this.getForeshadowOccurrence(occurrenceId);
    this.db.transaction(() => {
      this.assertExpectedVersion("foreshadow", String(current.foreshadowId), expectedVersionNo, "伏笔");
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

  listSettingsPage(workId: string, pagination: Pagination): PaginatedResult<Record<string, unknown>> {
    this.getWork(workId);
    const page = paginationSql(pagination);
    const rows = this.db.all(`SELECT * FROM settings WHERE work_id = ? ORDER BY locked DESC, category, title${page.sql}`, workId, ...page.params);
    return paginated(rows.map((row) => this.mapSetting(row)), pagination);
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
    changeNote = "",
    expectedVersionNo?: number
  ): Record<string, unknown> {
    const current = this.getSetting(settingId);
    this.db.transaction(() => {
      this.assertExpectedVersion("setting", settingId, expectedVersionNo, "设定");
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

  deleteSetting(settingId: string, expectedVersionNo?: number): void {
    const current = this.getSetting(settingId);
    this.db.transaction(() => {
      this.assertExpectedVersion("setting", settingId, expectedVersionNo, "设定");
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
      versionNo: this.currentEntityVersionNo("setting", requiredString(row, "id")),
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
    const parentRaceId = input.parentRaceId ?? null;
    this.assertRaceParent(workId, parentRaceId, raceId);
    const memberIds = [...new Set(input.memberIds ?? [])];
    this.assertCharactersInWork(workId, memberIds);
    const memberSnapshots = this.captureCharacterSnapshots(memberIds);
    const timestamp = now();
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO races (id, work_id, parent_race_id, name, normalized_name, description, settings_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        raceId,
        workId,
        parentRaceId,
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

  listRacesPage(workId: string, pagination: Pagination): PaginatedResult<Record<string, unknown>> {
    this.getWork(workId);
    const page = paginationSql(pagination);
    const rows = this.db.all(`SELECT * FROM races WHERE work_id = ? ORDER BY name${page.sql}`, workId, ...page.params);
    return paginated(rows.map((row) => this.mapRace(row)), pagination);
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
    changeNote = "",
    expectedVersionNo?: number
  ): Record<string, unknown> {
    const current = this.getRace(raceId);
    const workId = String(current.workId);
    const name = input.name === undefined
      ? String(current.name)
      : input.name.normalize("NFKC").trim().replace(/\s+/gu, " ");
    const normalizedName = normalizeCharacterName(name);
    if (!normalizedName) throw new AppError(400, "RACE_NAME_REQUIRED", "种族名称不能为空");
    this.assertRaceNameAvailable(workId, normalizedName, raceId);
    const parentRaceId = input.parentRaceId === undefined
      ? current.parentRaceId as string | null
      : input.parentRaceId;
    this.assertRaceParent(workId, parentRaceId, raceId);
    const memberIds = input.memberIds === undefined ? null : [...new Set(input.memberIds)];
    if (memberIds) this.assertCharactersInWork(workId, memberIds);
    const nameChanged = name !== current.name;
    const touchedMemberIds = memberIds || nameChanged
      ? [...new Set([...(current.memberIds as string[]), ...(memberIds ?? [])])]
      : [];
    const memberSnapshots = this.captureCharacterSnapshots(touchedMemberIds);
    this.db.transaction(() => {
      this.assertExpectedVersion("race", raceId, expectedVersionNo, "种族");
      this.db.run(
        `UPDATE races SET parent_race_id = ?, name = ?, normalized_name = ?, description = ?, settings_json = ?, updated_at = ? WHERE id = ?`,
        parentRaceId,
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

  deleteRace(raceId: string, expectedVersionNo?: number): void {
    const current = this.getRace(raceId);
    const child = this.db.get("SELECT id FROM races WHERE parent_race_id = ? LIMIT 1", raceId);
    if (child) {
      throw new AppError(409, "RACE_HAS_CHILDREN", "该种族仍有子种族，请先迁移或删除子种族", { raceId: requiredString(child, "id") });
    }
    const memberSnapshots = this.captureCharacterSnapshots(current.memberIds as string[]);
    this.db.transaction(() => {
      this.assertExpectedVersion("race", raceId, expectedVersionNo, "种族");
      this.recordEntityVersion("race", raceId, "delete", null, "删除种族档案");
      this.db.run("UPDATE characters SET race_id = NULL, species = '', updated_at = ? WHERE race_id = ?", now(), raceId);
      this.db.run("DELETE FROM races WHERE id = ?", raceId);
      this.recordMembershipVersions(memberSnapshots, "race", raceId, `种族“${String(current.name)}”已删除`);
      this.audit(String(current.workId), "race.deleted", "race", raceId);
    });
  }

  mergeRaces(sourceRaceId: string, targetRaceId: string): Record<string, unknown> {
    if (sourceRaceId === targetRaceId) throw new AppError(400, "RACE_MERGE_SELF", "不能把种族合并到自身");
    const source = this.getRace(sourceRaceId);
    const target = this.getRace(targetRaceId);
    if (source.workId !== target.workId) throw new AppError(400, "RACE_WORK_MISMATCH", "待合并种族不属于同一作品");

    const workId = String(target.workId);
    const mergeId = id("raceMerge");
    const timestamp = now();
    const memberIds = [...new Set([...(target.memberIds as string[]), ...(source.memberIds as string[])])];
    const memberSnapshots = this.captureCharacterSnapshots(memberIds);
    const sourceChildren = this.db.all("SELECT id FROM races WHERE parent_race_id = ? ORDER BY id", sourceRaceId)
      .map((row) => requiredString(row, "id"))
      .filter((childRaceId) => childRaceId !== targetRaceId);
    const targetDescendsFromSource = (target.lineage as Array<{ id: string }>).some((race) => race.id === sourceRaceId);
    const targetParentRaceId = targetDescendsFromSource
      ? source.parentRaceId as string | null
      : target.parentRaceId as string | null;
    const descriptionParts = [String(target.description).trim(), String(source.description).trim()].filter(Boolean);
    const description = [...new Set(descriptionParts)].join("\n\n");
    const settings = [...new Set([...(target.settings as string[]), ...(source.settings as string[])])];

    this.db.transaction(() => {
      this.recordEntityVersion("race", sourceRaceId, "delete", mergeId, `合并至种族“${String(target.name)}”`, timestamp);
      this.db.run(
        "UPDATE races SET parent_race_id = ?, description = ?, settings_json = ?, updated_at = ? WHERE id = ?",
        targetParentRaceId,
        description,
        JSON.stringify(settings),
        timestamp,
        targetRaceId
      );
      this.db.run(
        "UPDATE characters SET race_id = ?, species = ?, updated_at = ? WHERE race_id = ?",
        targetRaceId,
        String(target.name),
        timestamp,
        sourceRaceId
      );
      for (const childRaceId of sourceChildren) {
        this.db.run("UPDATE races SET parent_race_id = ?, updated_at = ? WHERE id = ?", targetRaceId, timestamp, childRaceId);
        this.recordEntityVersion("race", childRaceId, "merge", mergeId, `因种族“${String(source.name)}”合并而迁移父种族`, timestamp);
      }
      this.db.run("DELETE FROM races WHERE id = ?", sourceRaceId);
      this.recordMembershipVersions(memberSnapshots, "race", targetRaceId, `合并种族“${String(source.name)}”`);
      this.recordEntityVersion("race", targetRaceId, "merge", mergeId, `合并种族“${String(source.name)}”`, timestamp);
      this.audit(workId, "race.merged", "race", targetRaceId, { mergeId, sourceRaceId });
    });
    return { mergeId, target: this.getRace(targetRaceId), source };
  }

  resolveRaceReference(workId: string, value: string): string | null {
    const normalizedName = normalizeCharacterName(value);
    if (!normalizedName) return null;
    const row = this.db.get("SELECT id FROM races WHERE work_id = ? AND normalized_name = ?", workId, normalizedName);
    return row ? requiredString(row, "id") : null;
  }

  private mapRace(row: Row): Record<string, unknown> {
    const raceId = requiredString(row, "id");
    const lineage = this.raceLineage(raceId);
    const members = this.db.all("SELECT id, name FROM characters WHERE race_id = ? ORDER BY name", requiredString(row, "id")).map((member) => ({
      characterId: requiredString(member, "id"),
      name: requiredString(member, "name")
    }));
    return {
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      parentRaceId: optionalString(row, "parent_race_id"),
      name: requiredString(row, "name"),
      description: requiredString(row, "description"),
      settings: json(requiredString(row, "settings_json"), []),
      lineage: lineage.map((item) => ({ id: item.id, name: item.name })),
      effectiveSettings: lineage.flatMap((item, index) => item.settings.map((value) => ({
        value,
        sourceRaceId: item.id,
        sourceRaceName: item.name,
        inherited: index < lineage.length - 1
      }))),
      memberIds: members.map((member) => member.characterId),
      members,
      versionNo: this.currentEntityVersionNo("race", requiredString(row, "id")),
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

  private assertRaceParent(workId: string, parentRaceId: string | null, raceId: string): void {
    if (!parentRaceId) return;
    const seen = new Set<string>();
    let currentId: string | null = parentRaceId;
    while (currentId) {
      if (currentId === raceId || seen.has(currentId)) {
        throw new AppError(409, "RACE_HIERARCHY_CYCLE", "父种族不能是当前种族或其后代");
      }
      seen.add(currentId);
      const row = this.db.get("SELECT id, work_id, parent_race_id FROM races WHERE id = ?", currentId);
      if (!row) throw notFound("父种族");
      if (requiredString(row, "work_id") !== workId) {
        throw new AppError(400, "RACE_PARENT_WORK_MISMATCH", "父种族不属于当前作品");
      }
      currentId = optionalString(row, "parent_race_id");
    }
  }

  private raceLineage(raceId: string): Array<{ id: string; name: string; settings: string[] }> {
    const lineage: Array<{ id: string; name: string; settings: string[] }> = [];
    const seen = new Set<string>();
    let currentId: string | null = raceId;
    while (currentId) {
      if (seen.has(currentId)) throw new AppError(500, "RACE_HIERARCHY_INVALID", "种族层级存在循环");
      seen.add(currentId);
      const row = this.db.get("SELECT id, name, settings_json, parent_race_id FROM races WHERE id = ?", currentId);
      if (!row) throw new AppError(500, "RACE_HIERARCHY_INVALID", "种族层级引用了不存在的父种族");
      lineage.push({
        id: requiredString(row, "id"),
        name: requiredString(row, "name"),
        settings: json<string[]>(requiredString(row, "settings_json"), [])
      });
      currentId = optionalString(row, "parent_race_id");
    }
    return lineage.reverse();
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

  listOrganizationsPage(workId: string, pagination: Pagination): PaginatedResult<Record<string, unknown>> {
    this.getWork(workId);
    const page = paginationSql(pagination);
    const rows = this.db.all(`SELECT * FROM organizations WHERE work_id = ? ORDER BY name${page.sql}`, workId, ...page.params);
    return paginated(rows.map((row) => this.mapOrganization(row)), pagination);
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
    changeNote = "",
    expectedVersionNo?: number
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
      this.assertExpectedVersion("organization", organizationId, expectedVersionNo, "组织");
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

  deleteOrganization(organizationId: string, expectedVersionNo?: number): void {
    const current = this.getOrganization(organizationId);
    const memberSnapshots = this.captureCharacterSnapshots(current.memberIds as string[]);
    this.db.transaction(() => {
      this.assertExpectedVersion("organization", organizationId, expectedVersionNo, "组织");
      this.recordEntityVersion("organization", organizationId, "delete", null, "删除组织档案");
      this.db.run("DELETE FROM organizations WHERE id = ?", organizationId);
      this.recordMembershipVersions(memberSnapshots, "organization", organizationId, `组织“${String(current.name)}”已删除`);
      this.audit(String(current.workId), "organization.deleted", "organization", organizationId);
    });
  }

  mergeOrganizations(sourceOrganizationId: string, targetOrganizationId: string): Record<string, unknown> {
    if (sourceOrganizationId === targetOrganizationId) {
      throw new AppError(400, "ORGANIZATION_MERGE_SELF", "不能把组织合并到自身");
    }
    const source = this.getOrganization(sourceOrganizationId);
    const target = this.getOrganization(targetOrganizationId);
    if (source.workId !== target.workId) {
      throw new AppError(400, "ORGANIZATION_WORK_MISMATCH", "待合并组织不属于同一作品");
    }

    const workId = String(target.workId);
    const mergeId = id("organizationMerge");
    const timestamp = now();
    const memberIds = [...new Set([...(target.memberIds as string[]), ...(source.memberIds as string[])])];
    const memberSnapshots = this.captureCharacterSnapshots(memberIds);
    const descriptionParts = [String(target.description).trim(), String(source.description).trim()].filter(Boolean);
    const description = [...new Set(descriptionParts)].join("\n\n");
    const settings = [...new Set([...(target.settings as string[]), ...(source.settings as string[])])];
    const sourceMemberships = this.db.all(
      "SELECT character_id, role, note, created_at FROM character_organization_memberships WHERE organization_id = ?",
      sourceOrganizationId
    );

    this.db.transaction(() => {
      this.recordEntityVersion("organization", sourceOrganizationId, "delete", mergeId, `合并至组织“${String(target.name)}”`, timestamp);
      this.db.run(
        "UPDATE organizations SET description = ?, settings_json = ?, updated_at = ? WHERE id = ?",
        description,
        JSON.stringify(settings),
        timestamp,
        targetOrganizationId
      );
      for (const membership of sourceMemberships) {
        this.db.run(
          `INSERT INTO character_organization_memberships (character_id, organization_id, role, note, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(character_id, organization_id) DO NOTHING`,
          requiredString(membership, "character_id"),
          targetOrganizationId,
          requiredString(membership, "role"),
          requiredString(membership, "note"),
          requiredString(membership, "created_at"),
          timestamp
        );
      }
      this.db.run("DELETE FROM organizations WHERE id = ?", sourceOrganizationId);
      this.recordMembershipVersions(memberSnapshots, "organization", targetOrganizationId, `合并组织“${String(source.name)}”`);
      this.recordEntityVersion("organization", targetOrganizationId, "merge", mergeId, `合并组织“${String(source.name)}”`, timestamp);
      this.audit(workId, "organization.merged", "organization", targetOrganizationId, { mergeId, sourceOrganizationId });
    });
    return { mergeId, target: this.getOrganization(targetOrganizationId), source };
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
      versionNo: this.currentEntityVersionNo("organization", requiredString(row, "id")),
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
      if (character.mergedIntoCharacterId) throw new AppError(409, "CHARACTER_ALREADY_MERGED", "已合并角色不能继续被引用");
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
    const profile = { ...(character.profile as Record<string, unknown>) };
    delete profile.sections;
    return {
      name: String(character.name),
      aliases: [...(character.aliases as string[])],
      raceId: character.raceId as string | null,
      species: String(character.species),
      organizationIds: [...(character.organizationIds as string[])].sort(),
      attributes: character.attributes as Record<string, unknown>,
      profile,
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

  listCharacters(workId: string, includeProfileSections = false, includeMerged = false): Record<string, unknown>[] {
    this.getWork(workId);
    return this.db.all(
      `SELECT * FROM characters WHERE work_id = ?${includeMerged ? "" : " AND merged_into_character_id IS NULL"} ORDER BY name`,
      workId
    )
      .map((row) => this.mapCharacter(row, includeProfileSections));
  }

  listCharactersPage(workId: string, pagination: Pagination, includeProfileSections = false, includeMerged = false): PaginatedResult<Record<string, unknown>> {
    this.getWork(workId);
    const page = paginationSql(pagination);
    const rows = this.db.all(
      `SELECT * FROM characters WHERE work_id = ?${includeMerged ? "" : " AND merged_into_character_id IS NULL"} ORDER BY name${page.sql}`,
      workId,
      ...page.params
    );
    return paginated(rows.map((row) => this.mapCharacter(row, includeProfileSections)), pagination);
  }

  private mapCharacterProfileSection(row: Row): Record<string, unknown> {
    return {
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      characterId: requiredString(row, "character_id"),
      sectionType: requiredString(row, "section_type"),
      title: requiredString(row, "title"),
      contentMarkdown: requiredString(row, "content_markdown"),
      summary: requiredString(row, "summary"),
      sortOrder: numberValue(row, "sort_order"),
      sourcePath: optionalString(row, "source_path"),
      sourceHash: optionalString(row, "source_hash"),
      versionNo: numberValue(row, "version_no"),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  listCharacterProfileSections(characterId: string): Record<string, unknown>[] {
    this.getCharacter(characterId);
    return this.db.all(
      "SELECT * FROM character_profile_sections WHERE character_id = ? ORDER BY sort_order, created_at",
      characterId
    ).map((row) => this.mapCharacterProfileSection(row));
  }

  listCharacterProfileSectionsPage(characterId: string, pagination: Pagination): PaginatedResult<Record<string, unknown>> {
    this.getCharacter(characterId);
    const page = paginationSql(pagination);
    const rows = this.db.all(
      `SELECT * FROM character_profile_sections WHERE character_id = ? ORDER BY sort_order, created_at${page.sql}`,
      characterId,
      ...page.params
    );
    return paginated(rows.map((row) => this.mapCharacterProfileSection(row)), pagination);
  }

  listCharacterProfileSectionCatalog(characterId: string): Record<string, unknown>[] {
    this.getCharacter(characterId);
    return this.db.all(
      `SELECT id, character_id, section_type, title, summary, sort_order, version_no
       FROM character_profile_sections WHERE character_id = ? ORDER BY sort_order, created_at`,
      characterId
    ).map((row) => ({
      id: requiredString(row, "id"),
      characterId: requiredString(row, "character_id"),
      sectionType: requiredString(row, "section_type"),
      title: requiredString(row, "title"),
      summary: requiredString(row, "summary"),
      sortOrder: numberValue(row, "sort_order"),
      versionNo: numberValue(row, "version_no")
    }));
  }

  getCharacterProfileSection(sectionId: string): Record<string, unknown> {
    const row = this.db.get("SELECT * FROM character_profile_sections WHERE id = ?", sectionId);
    if (!row) throw notFound("人物档案章节");
    return this.mapCharacterProfileSection(row);
  }

  private characterProfileSectionSnapshot(section: Record<string, unknown>): Record<string, unknown> {
    return {
      sectionType: String(section.sectionType),
      title: String(section.title),
      contentMarkdown: String(section.contentMarkdown),
      summary: String(section.summary),
      sortOrder: Number(section.sortOrder),
      sourcePath: section.sourcePath ?? null,
      sourceHash: section.sourceHash ?? null
    };
  }

  private recordCharacterProfileSectionVersion(
    section: Record<string, unknown>,
    source: string,
    sourceRef: string | null,
    changeNote: string,
    timestamp = now()
  ): void {
    this.db.run(
      `INSERT INTO character_profile_section_versions
       (id, work_id, character_id, section_id, version_no, snapshot_json, source, source_ref, change_note, created_at, created_by_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id("characterSectionVersion"),
      String(section.workId),
      String(section.characterId),
      String(section.id),
      Number(section.versionNo),
      JSON.stringify(this.characterProfileSectionSnapshot(section)),
      source,
      sourceRef,
      changeNote.trim(),
      timestamp,
      currentRequestActor()?.userId ?? null
    );
  }

  private syncCharacterProfileSectionSearch(section: Record<string, unknown>): void {
    const searchContent = normalizeDocumentSearchText(
      `${String(section.title)}\n${String(section.summary)}\n${String(section.contentMarkdown)}`
    );
    this.db.run(
      `INSERT INTO character_profile_section_search (work_id, character_id, section_id, search_content)
       VALUES (?, ?, ?, ?) ON CONFLICT(section_id) DO UPDATE SET search_content = excluded.search_content`,
      String(section.workId),
      String(section.characterId),
      String(section.id),
      searchContent
    );
    const search = this.db.get("SELECT id FROM character_profile_section_search WHERE section_id = ?", String(section.id));
    const searchId = numberValue(search ?? {}, "id");
    this.db.run("DELETE FROM character_profile_section_short_terms WHERE search_id = ?", searchId);
    for (const term of documentShortSearchTerms(searchContent)) {
      this.db.run("INSERT INTO character_profile_section_short_terms (search_id, term) VALUES (?, ?)", searchId, term);
    }
  }

  private attachmentIdsInMarkdown(contentMarkdown: string): string[] {
    return [...new Set([...contentMarkdown.matchAll(/attachment:\/\/([A-Za-z0-9_-]{1,300})/gu)].map((match) => String(match[1])))];
  }

  private syncCharacterProfileSectionAttachments(section: Record<string, unknown>): void {
    const sectionId = String(section.id);
    const workId = String(section.workId);
    const attachmentIds = this.attachmentIdsInMarkdown(String(section.contentMarkdown));
    for (const attachmentId of attachmentIds) {
      const attachment = this.getAttachment(attachmentId);
      if (attachment.workId !== workId) throw new AppError(400, "ATTACHMENT_WORK_MISMATCH", "附件不属于当前作品");
    }
    this.db.run("DELETE FROM attachment_references WHERE entity_type = 'character-section' AND entity_id = ?", sectionId);
    for (const attachmentId of attachmentIds) {
      this.db.run(
        `INSERT INTO attachment_references (attachment_id, work_id, entity_type, entity_id, created_at)
         VALUES (?, ?, 'character-section', ?, ?)`,
        attachmentId,
        workId,
        sectionId,
        now()
      );
    }
  }

  createCharacterProfileSection(
    characterId: string,
    input: CharacterProfileSectionInput,
    source = "create",
    sourceRef: string | null = null
  ): Record<string, unknown> {
    const character = this.getCharacter(characterId);
    const sectionId = id("characterSection");
    const timestamp = now();
    const sortOrder = input.sortOrder ?? Number(this.db.get(
      "SELECT COALESCE(MAX(sort_order), -1) + 1 AS sort_order FROM character_profile_sections WHERE character_id = ?",
      characterId
    )?.sort_order ?? 0);
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO character_profile_sections
         (id, work_id, character_id, section_type, title, content_markdown, summary, sort_order, source_path, source_hash, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        sectionId,
        String(character.workId),
        characterId,
        input.sectionType ?? "custom",
        input.title,
        input.contentMarkdown ?? "",
        input.summary ?? "",
        sortOrder,
        input.sourcePath ?? null,
        input.sourceHash ?? null,
        timestamp,
        timestamp
      );
      const section = this.getCharacterProfileSection(sectionId);
      this.syncCharacterProfileSectionSearch(section);
      this.syncCharacterProfileSectionAttachments(section);
      this.recordCharacterProfileSectionVersion(section, source, sourceRef, "建立人物 Markdown 章节", timestamp);
      this.audit(String(character.workId), "character-section.created", "character-section", sectionId, { characterId, source, sourceRef });
    });
    return this.getCharacterProfileSection(sectionId);
  }

  updateCharacterProfileSection(
    sectionId: string,
    input: Partial<CharacterProfileSectionInput>,
    source = "manual",
    sourceRef: string | null = null,
    changeNote = "",
    expectedVersionNo?: number
  ): Record<string, unknown> {
    const current = this.getCharacterProfileSection(sectionId);
    this.assertExpectedRevision("character-section", sectionId, expectedVersionNo, "人物档案章节", Number(current.versionNo));
    const timestamp = now();
    this.db.transaction(() => {
      const lockedCurrent = this.getCharacterProfileSection(sectionId);
      this.assertExpectedRevision("character-section", sectionId, expectedVersionNo, "人物档案章节", Number(lockedCurrent.versionNo));
      this.db.run(
        `UPDATE character_profile_sections SET section_type = ?, title = ?, content_markdown = ?, summary = ?, sort_order = ?,
         source_path = ?, source_hash = ?, version_no = version_no + 1, updated_at = ? WHERE id = ?`,
        input.sectionType ?? String(current.sectionType),
        input.title ?? String(current.title),
        input.contentMarkdown ?? String(current.contentMarkdown),
        input.summary ?? String(current.summary),
        input.sortOrder ?? Number(current.sortOrder),
        input.sourcePath === undefined ? current.sourcePath as string | null : input.sourcePath,
        input.sourceHash === undefined ? current.sourceHash as string | null : input.sourceHash,
        timestamp,
        sectionId
      );
      const section = this.getCharacterProfileSection(sectionId);
      this.syncCharacterProfileSectionSearch(section);
      this.syncCharacterProfileSectionAttachments(section);
      this.recordCharacterProfileSectionVersion(section, source, sourceRef, changeNote || "更新人物 Markdown 章节", timestamp);
      this.audit(String(current.workId), "character-section.updated", "character-section", sectionId, { fields: Object.keys(input), source, sourceRef });
    });
    return this.getCharacterProfileSection(sectionId);
  }

  deleteCharacterProfileSection(sectionId: string, expectedVersionNo?: number): void {
    const current = this.getCharacterProfileSection(sectionId);
    this.assertExpectedRevision("character-section", sectionId, expectedVersionNo, "人物档案章节", Number(current.versionNo));
    this.db.transaction(() => {
      const lockedCurrent = this.getCharacterProfileSection(sectionId);
      this.assertExpectedRevision("character-section", sectionId, expectedVersionNo, "人物档案章节", Number(lockedCurrent.versionNo));
      this.db.run("UPDATE character_profile_sections SET version_no = version_no + 1 WHERE id = ?", sectionId);
      const deleting = this.getCharacterProfileSection(sectionId);
      this.recordCharacterProfileSectionVersion(deleting, "delete", null, "删除人物 Markdown 章节");
      this.db.run("DELETE FROM attachment_references WHERE entity_type = 'character-section' AND entity_id = ?", sectionId);
      this.db.run("DELETE FROM character_profile_sections WHERE id = ?", sectionId);
      this.audit(String(current.workId), "character-section.deleted", "character-section", sectionId, { characterId: current.characterId });
    });
  }

  listCharacterProfileSectionVersions(sectionId: string): Record<string, unknown>[] {
    const rows = this.db.all(
      `SELECT version.*, user.display_name AS actor_display_name, user.username AS actor_username
       FROM character_profile_section_versions version LEFT JOIN users user ON user.id = version.created_by_user_id
       WHERE version.section_id = ? ORDER BY version.version_no DESC`,
      sectionId
    );
    if (!rows.length) this.getCharacterProfileSection(sectionId);
    return rows.map((row) => ({
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      characterId: requiredString(row, "character_id"),
      sectionId: requiredString(row, "section_id"),
      versionNo: numberValue(row, "version_no"),
      snapshot: json(requiredString(row, "snapshot_json"), {}),
      source: requiredString(row, "source"),
      sourceRef: optionalString(row, "source_ref"),
      changeNote: requiredString(row, "change_note"),
      createdAt: requiredString(row, "created_at"),
      actor: optionalString(row, "actor_display_name") ?? optionalString(row, "actor_username") ?? "历史数据"
    }));
  }

  listCharacterProfileSectionVersionsPage(sectionId: string, pagination: Pagination): PaginatedResult<Record<string, unknown>> {
    const page = paginationSql(pagination);
    const rows = this.db.all(
      `SELECT version.*, user.display_name AS actor_display_name, user.username AS actor_username
       FROM character_profile_section_versions version LEFT JOIN users user ON user.id = version.created_by_user_id
       WHERE version.section_id = ? ORDER BY version.version_no DESC${page.sql}`,
      sectionId,
      ...page.params
    );
    if (!rows.length && pagination.page === 1) this.getCharacterProfileSection(sectionId);
    return paginated(rows.map((row) => ({
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      characterId: requiredString(row, "character_id"),
      sectionId: requiredString(row, "section_id"),
      versionNo: numberValue(row, "version_no"),
      snapshot: json(requiredString(row, "snapshot_json"), {}),
      source: requiredString(row, "source"),
      sourceRef: optionalString(row, "source_ref"),
      changeNote: requiredString(row, "change_note"),
      createdAt: requiredString(row, "created_at"),
      actor: optionalString(row, "actor_display_name") ?? optionalString(row, "actor_username") ?? "历史数据"
    })), pagination);
  }

  restoreCharacterProfileSection(sectionId: string, versionNo: number, expectedVersionNo?: number): Record<string, unknown> {
    const version = this.db.get(
      "SELECT * FROM character_profile_section_versions WHERE section_id = ? AND version_no = ?",
      sectionId,
      versionNo
    );
    if (!version) throw notFound("人物档案章节版本");
    const snapshot = json<Record<string, unknown>>(requiredString(version, "snapshot_json"), {});
    const existing = this.db.get("SELECT id FROM character_profile_sections WHERE id = ?", sectionId);
    if (existing) {
      return this.updateCharacterProfileSection(sectionId, snapshot as Partial<CharacterProfileSectionInput>, "restore", requiredString(version, "id"), `恢复至 v${versionNo}`, expectedVersionNo);
    }
    this.assertExpectedRevision("character-section", sectionId, expectedVersionNo, "人物档案章节", this.currentCharacterSectionVersionNo(sectionId));
    const characterId = requiredString(version, "character_id");
    const character = this.getCharacter(characterId);
    const timestamp = now();
    const nextVersionNo = Number(this.db.get(
      "SELECT COALESCE(MAX(version_no), 0) + 1 AS version_no FROM character_profile_section_versions WHERE section_id = ?",
      sectionId
    )?.version_no ?? 1);
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO character_profile_sections
         (id, work_id, character_id, section_type, title, content_markdown, summary, sort_order, source_path, source_hash, version_no, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        sectionId,
        String(character.workId),
        characterId,
        String(snapshot.sectionType ?? "custom"),
        String(snapshot.title ?? "恢复的章节"),
        String(snapshot.contentMarkdown ?? ""),
        String(snapshot.summary ?? ""),
        Number(snapshot.sortOrder ?? 0),
        snapshot.sourcePath as string | null ?? null,
        snapshot.sourceHash as string | null ?? null,
        nextVersionNo,
        timestamp,
        timestamp
      );
      const restored = this.getCharacterProfileSection(sectionId);
      this.syncCharacterProfileSectionSearch(restored);
      this.syncCharacterProfileSectionAttachments(restored);
      this.recordCharacterProfileSectionVersion(restored, "restore", requiredString(version, "id"), `恢复至 v${versionNo}`, timestamp);
      this.audit(String(character.workId), "character-section.restored", "character-section", sectionId, { versionNo });
    });
    return this.getCharacterProfileSection(sectionId);
  }

  searchCharacterProfileSections(workId: string, query: string, limit = 20): Record<string, unknown>[] {
    this.getWork(workId);
    const normalized = normalizeDocumentSearchText(query);
    const columns = `SELECT section.*, character.name AS character_name
      FROM character_profile_section_search search
      JOIN character_profile_sections section ON section.id = search.section_id
      JOIN characters character ON character.id = search.character_id`;
    const rows = [...normalized].length <= 2
      ? this.db.all(
        `${columns} JOIN character_profile_section_short_terms term ON term.search_id = search.id
         WHERE search.work_id = ? AND term.term = ? ORDER BY character.name, section.sort_order LIMIT ?`,
        workId,
        normalized,
        limit
      )
      : this.db.all(
        `${columns} JOIN character_profile_section_search_fts fts ON fts.rowid = search.id
         WHERE search.work_id = ? AND character_profile_section_search_fts MATCH ?
         ORDER BY bm25(character_profile_section_search_fts), character.name, section.sort_order LIMIT ?`,
        workId,
        `"${normalized.replaceAll('"', '""')}"`,
        limit
      );
    return rows.map((row) => ({ ...this.mapCharacterProfileSection(row), characterName: requiredString(row, "character_name") }));
  }

  private mapAttachment(row: Row): Record<string, unknown> {
    const attachmentId = requiredString(row, "id");
    return {
      id: attachmentId,
      workId: requiredString(row, "work_id"),
      originalName: requiredString(row, "original_name"),
      originalMimeType: requiredString(row, "original_mime_type"),
      storedMimeType: requiredString(row, "stored_mime_type"),
      originalByteLength: numberValue(row, "original_byte_length"),
      storedByteLength: numberValue(row, "stored_byte_length"),
      originalSha256: requiredString(row, "original_sha256"),
      storedSha256: requiredString(row, "stored_sha256"),
      storageKey: requiredString(row, "storage_key"),
      width: numberValue(row, "width"),
      height: numberValue(row, "height"),
      pageCount: numberValue(row, "page_count"),
      animated: booleanValue(row, "animated"),
      contentUrl: `/api/attachments/${encodeURIComponent(attachmentId)}/content`,
      createdAt: requiredString(row, "created_at")
    };
  }

  createAttachment(workId: string, input: AttachmentInput): { attachment: Record<string, unknown>; created: boolean } {
    this.getWork(workId);
    const existing = this.db.get("SELECT * FROM attachments WHERE work_id = ? AND stored_sha256 = ?", workId, input.storedSha256);
    if (existing) return { attachment: this.mapAttachment(existing), created: false };
    const attachmentId = id("attachment");
    const timestamp = now();
    this.db.transaction(() => {
      this.db.run(
        `INSERT INTO attachments
         (id, work_id, original_name, original_mime_type, stored_mime_type, original_byte_length, stored_byte_length,
          original_sha256, stored_sha256, storage_key, width, height, page_count, animated, created_at, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        attachmentId,
        workId,
        input.originalName,
        input.originalMimeType,
        input.storedMimeType,
        input.originalByteLength,
        input.storedByteLength,
        input.originalSha256,
        input.storedSha256,
        input.storageKey,
        input.width,
        input.height,
        input.pageCount,
        input.animated ? 1 : 0,
        timestamp,
        currentRequestActor()?.userId ?? null
      );
      this.audit(workId, "attachment.created", "attachment", attachmentId, {
        originalMimeType: input.originalMimeType,
        storedMimeType: input.storedMimeType,
        originalByteLength: input.originalByteLength,
        storedByteLength: input.storedByteLength,
        animated: input.animated
      });
    });
    return { attachment: this.getAttachment(attachmentId), created: true };
  }

  listAttachments(workId: string): Record<string, unknown>[] {
    this.getWork(workId);
    return this.db.all("SELECT * FROM attachments WHERE work_id = ? ORDER BY created_at DESC", workId).map((row) => this.mapAttachment(row));
  }

  listAttachmentsPage(workId: string, pagination: Pagination): PaginatedResult<Record<string, unknown>> {
    this.getWork(workId);
    const page = paginationSql(pagination);
    const rows = this.db.all(`SELECT * FROM attachments WHERE work_id = ? ORDER BY created_at DESC${page.sql}`, workId, ...page.params);
    return paginated(rows.map((row) => this.mapAttachment(row)), pagination);
  }

  getAttachment(attachmentId: string): Record<string, unknown> {
    const row = this.db.get("SELECT * FROM attachments WHERE id = ?", attachmentId);
    if (!row) throw notFound("附件");
    return this.mapAttachment(row);
  }

  deleteAttachment(attachmentId: string): { storageKey: string; removeStoredFile: boolean } {
    const attachment = this.getAttachment(attachmentId);
    const references = Number(this.db.get("SELECT COUNT(*) AS count FROM attachment_references WHERE attachment_id = ?", attachmentId)?.count ?? 0);
    if (references > 0) throw new AppError(409, "ATTACHMENT_IN_USE", "附件仍被人物档案章节引用，无法删除");
    const storageKey = String(attachment.storageKey);
    this.db.transaction(() => {
      this.db.run("DELETE FROM attachments WHERE id = ?", attachmentId);
      this.audit(String(attachment.workId), "attachment.deleted", "attachment", attachmentId, { storageKey });
    });
    const remaining = Number(this.db.get("SELECT COUNT(*) AS count FROM attachments WHERE storage_key = ?", storageKey)?.count ?? 0);
    return { storageKey, removeStoredFile: remaining === 0 };
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
    changeNote = "",
    expectedVersionNo?: number
  ): Record<string, unknown> {
    const current = this.getCharacter(characterId);
    this.assertExpectedRevision("character", characterId, expectedVersionNo, "人物", Number(current.versionNo));
    if (current.mergedIntoCharacterId) throw new AppError(409, "CHARACTER_ALREADY_MERGED", "已合并角色不能直接编辑");
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
      const lockedCurrent = this.getCharacter(characterId);
      this.assertExpectedRevision("character", characterId, expectedVersionNo, "人物", Number(lockedCurrent.versionNo));
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

  listCharacterVersionsPage(characterId: string, pagination: Pagination): PaginatedResult<Record<string, unknown>> {
    const page = paginationSql(pagination);
    const rows = this.db.all(
      `SELECT version.*, user.display_name AS actor_display_name, user.username AS actor_username
       FROM character_versions version LEFT JOIN users user ON user.id = version.created_by_user_id
       WHERE version.character_id = ? ORDER BY version.version_no DESC${page.sql}`,
      characterId,
      ...page.params
    );
    if (!rows.length && pagination.page === 1) this.getCharacter(characterId);
    return paginated(rows.map((row) => ({
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
    })), pagination);
  }

  restoreCharacter(characterId: string, versionNo: number, expectedVersionNo?: number): Record<string, unknown> {
    const version = this.db.get("SELECT * FROM character_versions WHERE character_id = ? AND version_no = ?", characterId, versionNo);
    if (!version) throw notFound("人物版本");
    const snapshot = json<CharacterSnapshot>(requiredString(version, "snapshot_json"), {} as CharacterSnapshot);
    if (!snapshot.name) throw new AppError(500, "CHARACTER_VERSION_INVALID", "人物版本快照无效");
    const existing = this.db.get("SELECT id FROM characters WHERE id = ?", characterId);
    if (!existing) {
      this.assertExpectedRevision("character", characterId, expectedVersionNo, "人物", this.currentCharacterVersionNo(characterId));
      return this.recreateCharacterFromVersion(characterId, version, snapshot, versionNo);
    }
    return this.updateCharacter(
      characterId,
      snapshot,
      "restore",
      requiredString(version, "id"),
      `恢复至 v${versionNo}`,
      expectedVersionNo
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

  deleteCharacter(characterId: string, expectedVersionNo?: number): void {
    const current = this.getCharacter(characterId);
    this.assertExpectedRevision("character", characterId, expectedVersionNo, "人物", Number(current.versionNo));
    const timestamp = now();
    const versionNo = Number(current.versionNo) + 1;
    const workId = String(current.workId);
    const timelineEvents = this.listTimelineEvents(workId).filter(
      (event) => (event.participantIds as string[]).includes(characterId)
    );
    const relationships = this.listRelationships(workId).filter(
      (relationship) => relationship.fromCharacterId === characterId || relationship.toCharacterId === characterId
    );
    this.db.transaction(() => {
      const lockedCurrent = this.getCharacter(characterId);
      this.assertExpectedRevision("character", characterId, expectedVersionNo, "人物", Number(lockedCurrent.versionNo));
      for (const event of timelineEvents) {
        this.updateTimelineEvent(String(event.id), {
          participantIds: (event.participantIds as string[]).filter((participantId) => participantId !== characterId)
        }, "manual", characterId, `删除角色“${String(current.name)}”后移除参与者引用`);
      }
      for (const relationship of relationships) this.deleteRelationship(String(relationship.id));
      const sectionIds = this.db.all("SELECT id FROM character_profile_sections WHERE character_id = ?", characterId)
        .map((row) => requiredString(row, "id"));
      for (const sectionId of sectionIds) {
        this.db.run("DELETE FROM attachment_references WHERE entity_type = 'character-section' AND entity_id = ?", sectionId);
      }
      this.db.run("UPDATE characters SET version_no = ?, updated_at = ? WHERE id = ?", versionNo, timestamp, characterId);
      this.insertCharacterVersion(characterId, versionNo, "delete", null, "删除人物", timestamp);
      this.db.run("DELETE FROM characters WHERE id = ?", characterId);
      this.audit(workId, "character.deleted", "character", characterId, { versionNo });
    });
  }

  private mapCharacter(row: Row, includeProfileSections = true): Record<string, unknown> {
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
    const race = raceId ? this.getRace(raceId) : undefined;
    const species = race ? String(race.name) : requiredString(row, "species");
    const profile = json<Record<string, unknown>>(requiredString(row, "profile_json"), {});
    const characterId = requiredString(row, "id");
    const profileSectionCount = Number(this.db.get(
      "SELECT COUNT(*) AS count FROM character_profile_sections WHERE character_id = ?",
      characterId
    )?.count ?? 0);
    const markdownSections = includeProfileSections
      ? this.db.all(
        "SELECT * FROM character_profile_sections WHERE character_id = ? ORDER BY sort_order, created_at",
        characterId
      ).map((section) => this.mapCharacterProfileSection(section))
      : [];
    if (markdownSections.length > 0) {
      profile.sections = markdownSections.map((section) => ({
        id: section.id,
        sectionType: section.sectionType,
        title: section.title,
        content: section.contentMarkdown,
        contentMarkdown: section.contentMarkdown,
        summary: section.summary,
        sortOrder: section.sortOrder,
        versionNo: section.versionNo
      }));
    }
    return {
      id: characterId,
      workId: requiredString(row, "work_id"),
      name: requiredString(row, "name"),
      aliases: indexedAliases.length > 0 ? indexedAliases : json(requiredString(row, "aliases_json"), []),
      raceId: race ? String(race.id) : null,
      race: race ? {
        id: String(race.id),
        name: species,
        lineage: race.lineage,
        effectiveSettings: race.effectiveSettings
      } : null,
      species,
      organizationIds: organizations.map((organization) => organization.organizationId),
      organizations,
      attributes: json(requiredString(row, "attributes_json"), {}),
      profile,
      profileSectionCount,
      currentState: json(requiredString(row, "current_state_json"), {}),
      lockedFields: json(requiredString(row, "locked_fields_json"), []),
      visibility: requiredString(row, "visibility"),
      firstChapterId: optionalString(row, "first_chapter_id"),
      mergedIntoCharacterId: optionalString(row, "merged_into_character_id"),
      mergedAt: optionalString(row, "merged_at"),
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

  mergeCharacters(input: {
    reviewId: string | null;
    targetCharacterId: string;
    sourceCharacterId: string;
    expectedTargetVersionNo: number;
    expectedSourceVersionNo: number;
  }): Record<string, unknown> {
    if (input.targetCharacterId === input.sourceCharacterId) {
      throw new AppError(400, "CHARACTER_MERGE_SELF", "不能把角色合并到自身");
    }
    const review = input.reviewId ? this.getReviewItem(input.reviewId) : null;
    if (review) {
      if (review.itemType !== "character-duplicate" || review.status !== "pending") {
        throw new AppError(409, "CHARACTER_REVIEW_DECIDED", "该角色查重项已经处理");
      }
      const reviewCharacterIds = (review.entityRefs as unknown[]).flatMap((reference) => {
        if (!reference || typeof reference !== "object" || Array.isArray(reference)) return [];
        const characterId = (reference as Record<string, unknown>).id;
        return typeof characterId === "string" ? [characterId] : [];
      });
      if (!reviewCharacterIds.includes(input.targetCharacterId) || !reviewCharacterIds.includes(input.sourceCharacterId)) {
        throw new AppError(400, "CHARACTER_REVIEW_MISMATCH", "待合并角色与审核项不一致");
      }
    }
    const target = this.getCharacter(input.targetCharacterId);
    const source = this.getCharacter(input.sourceCharacterId);
    if (target.workId !== source.workId || (review && target.workId !== review.workId)) {
      throw new AppError(400, "CHARACTER_WORK_MISMATCH", "待合并角色不属于同一作品");
    }
    if (target.mergedIntoCharacterId || source.mergedIntoCharacterId) {
      throw new AppError(409, "CHARACTER_ALREADY_MERGED", "待合并角色中已有角色被合并");
    }
    if (Number(target.versionNo) !== input.expectedTargetVersionNo || Number(source.versionNo) !== input.expectedSourceVersionNo) {
      throw new AppError(409, "CHARACTER_VERSION_CHANGED", "角色已发生变化，请刷新后重试");
    }

    const workId = String(target.workId);
    const targetId = String(target.id);
    const sourceId = String(source.id);
    const mergeId = id("characterMerge");
    const timestamp = now();
    const sourceRelationships = this.listRelationships(workId).filter(
      (relationship) => relationship.fromCharacterId === sourceId || relationship.toCharacterId === sourceId
    );
    const timelineEvents = this.listTimelineEvents(workId).filter(
      (event) => (event.participantIds as string[]).includes(sourceId)
    );
    const sourceMemberships = this.db.all(
      "SELECT * FROM character_organization_memberships WHERE character_id = ? ORDER BY organization_id",
      sourceId
    );
    const referenceSnapshot = { relationships: sourceRelationships, timelineEvents, memberships: sourceMemberships };

    this.db.transaction(() => {
      const lockedTarget = this.getCharacter(targetId);
      const lockedSource = this.getCharacter(sourceId);
      this.assertExpectedRevision("character", targetId, input.expectedTargetVersionNo, "目标角色", Number(lockedTarget.versionNo));
      this.assertExpectedRevision("character", sourceId, input.expectedSourceVersionNo, "来源角色", Number(lockedSource.versionNo));
      this.db.run("DELETE FROM character_names WHERE character_id = ?", sourceId);
      const aliases = [...(target.aliases as string[]), String(source.name), ...(source.aliases as string[])];
      const uniqueAliases = [...new Map(aliases
        .map((alias) => alias.normalize("NFKC").trim().replace(/\s+/gu, " "))
        .filter(Boolean)
        .filter((alias) => normalizeCharacterName(alias) !== normalizeCharacterName(String(target.name)))
        .map((alias) => [normalizeCharacterName(alias), alias])).values()];
      this.updateCharacter(targetId, {
        aliases: uniqueAliases,
        raceId: (target.raceId as string | null) ?? (source.raceId as string | null),
        organizationIds: [...new Set([...(target.organizationIds as string[]), ...(source.organizationIds as string[])])],
        attributes: { ...(source.attributes as Record<string, unknown>), ...(target.attributes as Record<string, unknown>) },
        profile: { ...(source.profile as Record<string, unknown>), ...(target.profile as Record<string, unknown>) },
        currentState: { ...(source.currentState as Record<string, unknown>), ...(target.currentState as Record<string, unknown>) },
        lockedFields: [...new Set([...(target.lockedFields as string[]), ...(source.lockedFields as string[])])],
        firstChapterId: (target.firstChapterId as string | null) ?? (source.firstChapterId as string | null)
      }, "merge", mergeId, `合并角色“${String(source.name)}”`, input.expectedTargetVersionNo);

      for (const event of timelineEvents) {
        const participantIds = [...new Set((event.participantIds as string[]).map(
          (characterId) => characterId === sourceId ? targetId : characterId
        ))];
        this.updateTimelineEvent(String(event.id), { participantIds }, "merge", mergeId, `合并角色“${String(source.name)}”`);
      }

      for (const relationship of sourceRelationships) {
        let fromCharacterId = relationship.fromCharacterId === sourceId ? targetId : String(relationship.fromCharacterId);
        let toCharacterId = relationship.toCharacterId === sourceId ? targetId : String(relationship.toCharacterId);
        if (fromCharacterId === toCharacterId) {
          this.deleteRelationship(String(relationship.id));
          continue;
        }
        if (!relationship.directed && fromCharacterId.localeCompare(toCharacterId) > 0) {
          [fromCharacterId, toCharacterId] = [toCharacterId, fromCharacterId];
        }
        const duplicate = this.listRelationships(workId).find((candidate) => candidate.id !== relationship.id
          && candidate.fromCharacterId === fromCharacterId
          && candidate.toCharacterId === toCharacterId
          && Boolean(candidate.directed) === Boolean(relationship.directed)
          && candidate.category === relationship.category
          && normalizeCharacterName(String(candidate.subtype)) === normalizeCharacterName(String(relationship.subtype))
          && candidate.confirmationStatus !== "rejected");
        if (duplicate) {
          const keywords = [...new Set([...(duplicate.keywords as string[]), ...(relationship.keywords as string[])])];
          const evidence = [...new Map([...(duplicate.evidence as unknown[]), ...(relationship.evidence as unknown[])]
            .map((item) => [JSON.stringify(item), item])).values()];
          this.updateRelationship(String(duplicate.id), {
            keywords,
            evidence,
            confidence: Math.max(Number(duplicate.confidence), Number(relationship.confidence)),
            locked: Boolean(duplicate.locked) || Boolean(relationship.locked),
            confirmationStatus: duplicate.confirmationStatus === "confirmed" || relationship.confirmationStatus === "confirmed"
              ? "confirmed"
              : String(duplicate.confirmationStatus)
          }, "merge", mergeId, `合并角色“${String(source.name)}”的重复关系`);
          this.deleteRelationship(String(relationship.id));
        } else {
          this.updateRelationship(String(relationship.id), { fromCharacterId, toCharacterId }, "merge", mergeId, `迁移角色“${String(source.name)}”的关系`);
        }
      }

      this.db.run("DELETE FROM character_organization_memberships WHERE character_id = ?", sourceId);
      this.db.run("UPDATE character_profile_sections SET character_id = ?, updated_at = ? WHERE character_id = ?", targetId, timestamp, sourceId);
      this.db.run("UPDATE character_profile_section_versions SET character_id = ? WHERE character_id = ?", targetId, sourceId);
      this.db.run("UPDATE character_profile_section_search SET character_id = ? WHERE character_id = ?", targetId, sourceId);
      const sourceVersionNo = Number(source.versionNo) + 1;
      this.db.run(
        "UPDATE characters SET merged_into_character_id = ?, merged_at = ?, version_no = ?, updated_at = ? WHERE id = ?",
        targetId,
        timestamp,
        sourceVersionNo,
        timestamp,
        sourceId
      );
      this.insertCharacterVersion(sourceId, sourceVersionNo, "merge", mergeId, `合并至角色“${String(target.name)}”`, timestamp);
      this.db.run(
        `INSERT INTO character_merges (id, work_id, source_character_id, target_character_id, review_id,
         source_snapshot_json, target_snapshot_json, reference_snapshot_json, created_at, created_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        mergeId,
        workId,
        sourceId,
        targetId,
        input.reviewId,
        JSON.stringify(source),
        JSON.stringify(target),
        JSON.stringify(referenceSnapshot),
        timestamp,
        currentRequestActor()?.userId ?? null
      );
      if (input.reviewId) {
        this.db.run(
          "UPDATE review_items SET status = 'fixed', resolution_note = ?, updated_at = ? WHERE id = ?",
          `已将“${String(source.name)}”合并到“${String(target.name)}”`,
          timestamp,
          input.reviewId
        );
      }
      this.audit(workId, "character.merged", "character", targetId, {
        mergeId,
        sourceCharacterId: sourceId,
        reviewId: input.reviewId
      });
    });
    return {
      mergeId,
      target: this.getCharacter(targetId),
      source: this.getCharacter(sourceId),
      review: input.reviewId ? this.getReviewItem(input.reviewId) : null
    };
  }

  resolveCharacterDuplicateReview(reviewId: string): Record<string, unknown> {
    const review = this.getReviewItem(reviewId);
    if (review.itemType !== "character-duplicate" || review.status !== "pending") {
      throw new AppError(409, "CHARACTER_REVIEW_DECIDED", "该角色查重项已经处理");
    }
    return this.updateReviewItem(reviewId, {
      status: "exception",
      resolutionNote: "作者确认是不同角色"
    });
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

  listTimelineTracksPage(workId: string, pagination: Pagination): PaginatedResult<Record<string, unknown>> {
    this.getWork(workId);
    const page = paginationSql(pagination);
    const rows = this.db.all(`SELECT * FROM timeline_tracks WHERE work_id = ? ORDER BY sort_order, created_at${page.sql}`, workId, ...page.params);
    return paginated(rows.map((row) => this.mapTimelineTrack(row)), pagination);
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
    changeNote = "",
    expectedVersionNo?: number
  ): Record<string, unknown> {
    const current = this.getTimelineTrack(trackId);
    this.db.transaction(() => {
      this.assertExpectedVersion("timeline-track", trackId, expectedVersionNo, "时间轴");
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

  deleteTimelineTrack(trackId: string, expectedVersionNo?: number): void {
    const current = this.getTimelineTrack(trackId);
    this.db.transaction(() => {
      this.assertExpectedVersion("timeline-track", trackId, expectedVersionNo, "时间轴");
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

  listTimelineEventsPage(workId: string, pagination: Pagination): PaginatedResult<Record<string, unknown>> {
    this.getWork(workId);
    const page = paginationSql(pagination);
    const rows = this.db.all(
      `SELECT * FROM timeline_events WHERE work_id = ? ORDER BY time_sort IS NULL, time_sort, created_at${page.sql}`,
      workId,
      ...page.params
    );
    return paginated(rows.map((row) => this.mapTimelineEvent(row)), pagination);
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
    changeNote = "",
    expectedVersionNo?: number
  ): Record<string, unknown> {
    const current = this.getTimelineEvent(eventId);
    if (input.trackId) {
      const track = this.getTimelineTrack(input.trackId);
      if (track.workId !== current.workId) throw new AppError(400, "TIMELINE_TRACK_WORK_MISMATCH", "独立时间轴不属于当前作品");
    }
    this.db.transaction(() => {
      this.assertExpectedVersion("timeline-event", eventId, expectedVersionNo, "时间事件");
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

  deleteTimelineEvent(eventId: string, expectedVersionNo?: number): void {
    const current = this.getTimelineEvent(eventId);
    this.db.transaction(() => {
      this.assertExpectedVersion("timeline-event", eventId, expectedVersionNo, "时间事件");
      this.recordEntityVersion("timeline-event", eventId, "delete", null, "删除时间事件");
      this.db.run("DELETE FROM timeline_events WHERE id = ?", eventId);
      this.audit(String(current.workId), "timeline.deleted", "timeline-event", eventId);
    });
  }

  mergeTimelineEvents(
    workId: string,
    eventIds: string[],
    input: { name: string; description?: string; timeLabel?: string; timeSort?: number | null },
    expectedVersionNos?: Record<string, number>
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
      for (const event of events) {
        this.assertExpectedVersion("timeline-event", String(event.id), expectedVersionNos?.[String(event.id)], "时间事件", Number(event.versionNo));
      }
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
    parts: Array<{ name: string; description?: string; timeLabel?: string; timeSort?: number | null }>,
    expectedVersionNo?: number
  ): Record<string, unknown>[] {
    const source = this.getTimelineEvent(eventId);
    this.assertExpectedVersion("timeline-event", eventId, expectedVersionNo, "时间事件", Number(source.versionNo));
    if (parts.length < 2) throw new AppError(400, "EVENT_PARTS_REQUIRED", "拆分时间事件至少需要两项");
    return this.db.transaction(() => {
      const lockedSource = this.getTimelineEvent(eventId);
      this.assertExpectedVersion("timeline-event", eventId, expectedVersionNo, "时间事件", Number(lockedSource.versionNo));
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
      versionNo: this.currentEntityVersionNo("timeline-event", requiredString(row, "id")),
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
      versionNo: this.currentEntityVersionNo("timeline-track", requiredString(row, "id")),
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
    if (from.mergedIntoCharacterId || to.mergedIntoCharacterId) throw new AppError(409, "CHARACTER_ALREADY_MERGED", "已合并角色不能继续被引用");
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

  listRelationshipsPage(workId: string, pagination: Pagination, minimumConfidence = 0): PaginatedResult<Record<string, unknown>> {
    this.getWork(workId);
    const page = paginationSql(pagination);
    const rows = this.db.all(
      `SELECT * FROM relationships WHERE work_id = ? AND confidence >= ? ORDER BY confidence DESC, created_at${page.sql}`,
      workId,
      minimumConfidence,
      ...page.params
    );
    return paginated(rows.map((row) => this.mapRelationship(row)), pagination);
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
    changeNote = "",
    expectedVersionNo?: number
  ): Record<string, unknown> {
    const current = this.getRelationship(relationshipId);
    let fromCharacterId = input.fromCharacterId ?? String(current.fromCharacterId);
    let toCharacterId = input.toCharacterId ?? String(current.toCharacterId);
    if (fromCharacterId === toCharacterId) throw new AppError(400, "SELF_RELATIONSHIP", "人物关系不能指向自身");
    const from = this.getCharacter(fromCharacterId);
    const to = this.getCharacter(toCharacterId);
    if (from.workId !== current.workId || to.workId !== current.workId) throw new AppError(400, "CHARACTER_WORK_MISMATCH", "关系人物不属于当前作品");
    if (from.mergedIntoCharacterId || to.mergedIntoCharacterId) throw new AppError(409, "CHARACTER_ALREADY_MERGED", "已合并角色不能继续被引用");
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
      this.assertExpectedVersion("relationship", relationshipId, expectedVersionNo, "人物关系");
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

  deleteRelationship(relationshipId: string, expectedVersionNo?: number): void {
    const current = this.getRelationship(relationshipId);
    this.db.transaction(() => {
      this.assertExpectedVersion("relationship", relationshipId, expectedVersionNo, "人物关系");
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
      versionNo: this.currentEntityVersionNo("relationship", requiredString(row, "id")),
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

  listReviewItemsPage(workId: string, pagination: Pagination, status?: string): PaginatedResult<Record<string, unknown>> {
    this.getWork(workId);
    const page = paginationSql(pagination);
    const rows = status
      ? this.db.all(`SELECT * FROM review_items WHERE work_id = ? AND status = ? ORDER BY created_at DESC${page.sql}`, workId, status, ...page.params)
      : this.db.all(`SELECT * FROM review_items WHERE work_id = ? ORDER BY created_at DESC${page.sql}`, workId, ...page.params);
    return paginated(rows.map((row) => this.mapReviewItem(row)), pagination);
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

  listContinuationGuardsPage(suggestionId: string, pagination: Pagination): PaginatedResult<Record<string, unknown>> {
    const suggestion = this.db.get("SELECT id FROM ai_suggestions WHERE id = ?", suggestionId);
    if (!suggestion) throw notFound("AI 建议");
    const page = paginationSql(pagination);
    const rows = this.db.all(
      `SELECT * FROM continuation_guard_runs WHERE suggestion_id = ? ORDER BY created_at DESC${page.sql}`,
      suggestionId,
      ...page.params
    );
    return paginated(rows.map((row) => this.mapContinuationGuard(row)), pagination);
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

  listAiConversationsPage(workId: string, pagination: Pagination): PaginatedResult<Record<string, unknown>> {
    this.getWork(workId);
    const page = paginationSql(pagination);
    const rows = this.db.all(
      `SELECT conversation.*,
        (SELECT COUNT(*) FROM ai_conversation_messages message WHERE message.conversation_id = conversation.id) AS message_count,
        COALESCE((SELECT content FROM ai_conversation_messages message WHERE message.conversation_id = conversation.id ORDER BY message.created_at DESC, message.rowid DESC LIMIT 1), '') AS preview
       FROM ai_conversations conversation
       WHERE conversation.work_id = ?
       ORDER BY conversation.updated_at DESC, conversation.created_at DESC${page.sql}`,
      workId,
      ...page.params
    );
    return paginated(rows.map((row) => this.mapAiConversation(row)), pagination);
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

  getAiConversationPage(conversationId: string, pagination: Pagination): Record<string, unknown> {
    const row = this.db.get("SELECT * FROM ai_conversations WHERE id = ?", conversationId);
    if (!row) throw notFound("AI 对话");
    const countRow = this.db.get("SELECT COUNT(*) AS count FROM ai_conversation_messages WHERE conversation_id = ?", conversationId);
    const page = paginationSql(pagination);
    const rows = this.db.all(
      `SELECT * FROM ai_conversation_messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC${page.sql}`,
      conversationId,
      ...page.params
    );
    const messagesPage = paginated(rows.map((message) => this.mapAiConversationMessage(message)), pagination);
    messagesPage.items.reverse();
    return {
      ...this.mapAiConversation(row),
      messageCount: Number(countRow?.count ?? 0),
      messages: messagesPage.items,
      messagesPage
    };
  }

  getAiConversationContext(conversationId: string, workId: string, excludeMessageId?: string): AiConversationContext {
    const conversation = this.db.get("SELECT * FROM ai_conversations WHERE id = ?", conversationId);
    if (!conversation) throw notFound("AI 对话");
    if (requiredString(conversation, "work_id") !== workId) throw new AppError(400, "CONVERSATION_WORK_MISMATCH", "AI 对话不属于当前作品");
    const rows = this.db.all(
      "SELECT id, role, content FROM ai_conversation_messages WHERE conversation_id = ? ORDER BY created_at, rowid",
      conversationId
    );
    const compactedMessageCount = Math.min(rows.length, Math.max(0, numberValue(conversation, "compacted_message_count")));
    return {
      workId,
      summary: requiredString(conversation, "compacted_summary"),
      compactedMessageCount,
      totalMessageCount: rows.length,
      warningPending: Boolean(optionalString(conversation, "context_warning_at")),
      messages: rows.slice(compactedMessageCount)
        .filter((message) => requiredString(message, "id") !== excludeMessageId)
        .map((message) => ({
          id: requiredString(message, "id"),
          role: requiredString(message, "role") === "assistant" ? "assistant" : "user",
          content: requiredString(message, "content")
        }))
    };
  }

  setAiConversationContextWarning(conversationId: string, pending: boolean): void {
    const conversation = this.db.get("SELECT id FROM ai_conversations WHERE id = ?", conversationId);
    if (!conversation) throw notFound("AI 对话");
    this.db.run("UPDATE ai_conversations SET context_warning_at = ? WHERE id = ?", pending ? now() : null, conversationId);
  }

  saveAiConversationCompaction(conversationId: string, summary: string, compactedMessageCount: number): Record<string, unknown> {
    const conversation = this.db.get("SELECT id FROM ai_conversations WHERE id = ?", conversationId);
    if (!conversation) throw notFound("AI 对话");
    this.db.run(
      "UPDATE ai_conversations SET compacted_summary = ?, compacted_message_count = ?, context_warning_at = NULL, updated_at = ? WHERE id = ?",
      summary,
      Math.max(0, compactedMessageCount),
      now(),
      conversationId
    );
    return this.getAiConversation(conversationId);
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
    const sourceCompactedCount = Math.max(0, numberValue(conversation, "compacted_message_count"));
    const forkCompactedCount = targetIndex + 1 >= sourceCompactedCount ? Math.min(sourceCompactedCount, targetIndex + 1) : 0;
    const forkSummary = forkCompactedCount ? requiredString(conversation, "compacted_summary") : "";
    this.db.transaction(() => {
      this.db.run(
        "INSERT INTO ai_conversations (id, work_id, title, compacted_summary, compacted_message_count, created_at, updated_at, created_by_user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        forkId,
        requiredString(conversation, "work_id"),
        title.slice(0, 200),
        forkSummary,
        forkCompactedCount,
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
      compactedMessageCount: numberValue(row, "compacted_message_count"),
      hasCompactedSummary: Boolean(requiredString(row, "compacted_summary")),
      contextWarningPending: Boolean(optionalString(row, "context_warning_at")),
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
    return this.db.all("SELECT * FROM analysis_tasks WHERE work_id = ? ORDER BY created_at DESC, id DESC", workId).map((row) => this.mapTask(row));
  }

  listTasksPage(workId: string, pagination: Pagination): PaginatedResult<Record<string, unknown>> {
    this.getWork(workId);
    const page = paginationSql(pagination);
    const rows = this.db.all(`SELECT * FROM analysis_tasks WHERE work_id = ? ORDER BY created_at DESC, id DESC${page.sql}`, workId, ...page.params);
    return paginated(rows.map((row) => this.mapTask(row)), pagination);
  }

  listTaskSummariesPage(workId: string, pagination: Pagination): PaginatedResult<Record<string, unknown>> {
    this.getWork(workId);
    const page = paginationSql(pagination);
    const rows = this.db.all(
      `SELECT id, work_id, task_type, scope_json, status, progress, created_at, updated_at
       FROM analysis_tasks WHERE work_id = ? ORDER BY created_at DESC, id DESC${page.sql}`,
      workId,
      ...page.params
    );
    const chapterSummaries = new Map(this.db.all(
      `SELECT chapter.id, chapter.title, volume.title AS volume_title
       FROM chapters chapter JOIN volumes volume ON volume.id = chapter.volume_id
       WHERE chapter.work_id = ?`,
      workId
    ).map((row) => [
      requiredString(row, "id"),
      `${requiredString(row, "volume_title")} · ${requiredString(row, "title")}`
    ] as const));
    const volumeTitles = new Map(this.db.all(
      "SELECT id, title FROM volumes WHERE work_id = ?",
      workId
    ).map((row) => [requiredString(row, "id"), requiredString(row, "title")] as const));
    return paginated(rows.map((row) => this.mapTaskSummary(row, chapterSummaries, volumeTitles)), pagination);
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

  private mapTaskSummary(row: Row, chapterSummaries: Map<string, string>, volumeTitles: Map<string, string>): Record<string, unknown> {
    const scope = json<Record<string, unknown>>(requiredString(row, "scope_json"), {});
    return {
      id: requiredString(row, "id"),
      workId: requiredString(row, "work_id"),
      taskType: requiredString(row, "task_type"),
      scope,
      scopeSummary: this.taskScopeSummaryFromMaps(scope, chapterSummaries, volumeTitles),
      status: requiredString(row, "status"),
      progress: numberValue(row, "progress"),
      createdAt: requiredString(row, "created_at"),
      updatedAt: requiredString(row, "updated_at")
    };
  }

  private taskScopeSummaryFromMaps(scope: Record<string, unknown>, chapterSummaries: Map<string, string>, volumeTitles: Map<string, string>): string {
    if (typeof scope.chapterId === "string") return chapterSummaries.get(scope.chapterId) ?? "章节已删除";
    if (scope.type === "volume" && typeof scope.volumeId === "string") {
      const title = volumeTitles.get(scope.volumeId);
      return title ? `分卷 · ${title}` : "分卷已删除";
    }
    if (scope.type === "book" || Object.keys(scope).length === 0) return "全书";
    return "未指定范围";
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
    const normalizedQuery = query.toLocaleLowerCase("zh-CN");
    const races = this.listRaces(workId).filter((race) => {
      const lineage = race.lineage as Array<{ name: string }>;
      const effectiveSettings = race.effectiveSettings as Array<{ value: string; sourceRaceName: string }>;
      return [
        race.name,
        race.description,
        ...(race.settings as string[]),
        ...lineage.map((item) => item.name),
        ...effectiveSettings.flatMap((item) => [item.value, item.sourceRaceName])
      ].join("\n").toLocaleLowerCase("zh-CN").includes(normalizedQuery);
    }).slice(0, 50);
    const settings = this.db.all(
      "SELECT id, title, content, category FROM settings WHERE work_id = ? AND (title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\') LIMIT 50",
      workId,
      pattern,
      pattern
    );
    const characters = this.db.all(
      `WITH RECURSIVE character_race_lineage(character_id, race_id, parent_race_id, name, path) AS (
         SELECT character.id, race.id, race.parent_race_id, race.name, race.name
         FROM characters character JOIN races race ON race.id = character.race_id
         WHERE character.work_id = ?
         UNION ALL
         SELECT lineage.character_id, parent.id, parent.parent_race_id, parent.name, parent.name || ' / ' || lineage.path
         FROM character_race_lineage lineage JOIN races parent ON parent.id = lineage.parent_race_id
       ), character_race_paths AS (
         SELECT character_id, path FROM character_race_lineage WHERE parent_race_id IS NULL
       )
       SELECT character.id, character.name, character.aliases_json, character.species,
              COALESCE(path.path, character.species) AS race_path
       FROM characters character LEFT JOIN character_race_paths path ON path.character_id = character.id
       WHERE character.work_id = ? AND (
         character.name LIKE ? ESCAPE '\\' OR character.aliases_json LIKE ? ESCAPE '\\' OR character.species LIKE ? ESCAPE '\\'
         OR EXISTS (SELECT 1 FROM character_race_lineage lineage WHERE lineage.character_id = character.id AND lineage.name LIKE ? ESCAPE '\\')
       ) LIMIT 50`,
      workId,
      workId,
      pattern,
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
    const characterSections = this.searchCharacterProfileSections(workId, query, 30);
    const snippet = (content: string): string => {
      const index = content.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
      const start = Math.max(0, index - 40);
      return content.slice(start, start + 120);
    };
    return [
      ...characters.map((row) => ({
        type: "character",
        id: requiredString(row, "id"),
        title: requiredString(row, "name"),
        snippet: [requiredString(row, "race_path"), ...json<string[]>(requiredString(row, "aliases_json"), [])].filter(Boolean).join("、"),
        racePath: requiredString(row, "race_path")
      })),
      ...characterSections.map((section) => ({
        type: "character",
        id: String(section.characterId),
        sectionId: String(section.id),
        title: `${String(section.characterName)} / ${String(section.title)}`,
        snippet: snippet(String(section.contentMarkdown)),
        sectionType: String(section.sectionType)
      })),
      ...settings.map((row) => ({ type: "setting", id: requiredString(row, "id"), title: requiredString(row, "title"), snippet: snippet(requiredString(row, "content")), category: requiredString(row, "category") })),
      ...races.map((race) => {
        const lineage = race.lineage as Array<{ id: string; name: string }>;
        const effectiveSettings = race.effectiveSettings as Array<{ value: string; sourceRaceId: string; sourceRaceName: string; inherited: boolean }>;
        return {
          type: "race",
          id: String(race.id),
          title: String(race.name),
          snippet: snippet(`${lineage.map((item) => item.name).join(" / ")}\n${String(race.description)}\n${effectiveSettings.map((item) => `${item.sourceRaceName}：${item.value}`).join("\n")}`),
          lineage,
          effectiveSettings
        };
      }),
      ...organizations.map((row) => ({ type: "organization", id: requiredString(row, "id"), title: requiredString(row, "name"), snippet: snippet(`${requiredString(row, "description")}\n${json<string[]>(requiredString(row, "settings_json"), []).join("\n")}`) })),
      ...chapters.map((row) => ({ type: "chapter", id: requiredString(row, "id"), title: requiredString(row, "title"), snippet: snippet(requiredString(row, "content")), volumeId: requiredString(row, "volume_id") }))
    ];
  }

  exportWork(workId: string): Record<string, unknown> {
    const tree = this.getWorkTree(workId);
    return {
      schemaVersion: 7,
      exportedAt: now(),
      work: tree,
      settings: this.listSettings(workId),
      characters: this.listCharacters(workId, true, true),
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

  listAuditLogsPage(workId: string, pagination: Pagination): PaginatedResult<Record<string, unknown>> {
    this.getWork(workId);
    const page = paginationSql(pagination);
    const rows = this.db.all(
      `SELECT log.*, user.display_name AS actor_display_name, user.username AS actor_username
       FROM audit_logs log LEFT JOIN users user ON user.id = log.user_id
       WHERE log.work_id = ? ORDER BY log.created_at DESC${page.sql}`,
      workId,
      ...page.params
    );
    return paginated(rows.map((row) => ({
      id: requiredString(row, "id"),
      action: requiredString(row, "action"),
      entityType: requiredString(row, "entity_type"),
      entityId: optionalString(row, "entity_id"),
      actor: optionalString(row, "actor_display_name") ?? optionalString(row, "actor_username") ?? requiredString(row, "actor"),
      userId: optionalString(row, "user_id"),
      detail: json(requiredString(row, "detail_json"), {}),
      createdAt: requiredString(row, "created_at")
    })), pagination);
  }
}
