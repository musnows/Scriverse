import { randomUUID } from "node:crypto";
import { logger, sanitizeError } from "./logger.js";

/**
 * 协作状态以内存作为单进程热路径，并按周期批量同步到 SQLite。
 * SQLite 让计划内重启可以恢复状态，也让多进程在各自同步周期后最终可见；它不是实时消息总线，
 * 因此跨进程可见性会有至多一个同步周期的延迟，异常退出也可能丢失尚未同步的瞬时状态。
 * Scriverse 以本地优先、单实例部署为主，当前不为亚秒级跨实例一致性额外引入 Redis 基础设施。
 */
export const presencePageKinds = [
  "welcome",
  "editor",
  "module",
  "entity-editor",
  "settings"
] as const;

export type PresencePageKind = typeof presencePageKinds[number];

export type PresencePage = {
  kind: PresencePageKind;
  module?: string;
  resourceId?: string;
};

export type PresenceUser = {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
};

export type PresenceParticipant = PresenceUser & {
  clientId: string;
  page: {
    key: string;
    label: string;
  };
  lastSeenAt: string;
};

export type CollaborativeChange = {
  id: string;
  pageKey: string;
  label: string;
  actorUserId: string;
  actorDisplayName: string;
  savedAt: string;
};

export type CollaborativeChangeRecipient = {
  userId: string;
  clientId: string;
};

export type PresenceHeartbeatResult = {
  participants: PresenceParticipant[];
  recentChanges: CollaborativeChange[];
};

export type PersistedPresenceEntry = PresenceUser & {
  workId: string;
  clientId: string;
  page: PresencePage;
  lastSeenAt: string;
};

export type PersistedCollaborativeChange = CollaborativeChange & {
  workId: string;
  recipients: CollaborativeChangeRecipient[];
};

export type PresencePersistenceBatch = {
  entries: PersistedPresenceEntry[];
  changes: PersistedCollaborativeChange[];
  entryExpiryCutoff?: string;
  changeExpiryCutoff?: string;
};

export type CollaborationPresenceStore = {
  loadEntries(activeSince: string): PersistedPresenceEntry[];
  loadChanges(activeSince: string, limit: number): PersistedCollaborativeChange[];
  flush(batch: PresencePersistenceBatch): void;
};

export type CollaborationPresencePersistenceOptions = {
  store: CollaborationPresenceStore;
  flushIntervalMs?: number;
  cleanupIntervalMs?: number;
  minPublishIntervalMs?: number;
};

type PresenceEntry = PresenceParticipant & {
  workId: string;
  lastSeenMs: number;
  persistedPage: PresencePage;
};

type ChangeEntry = CollaborativeChange & {
  workId: string;
  savedAtMs: number;
  recipients: CollaborativeChangeRecipient[];
};

const moduleLabels: Record<string, string> = {
  settings: "设定库",
  characters: "角色",
  races: "种族",
  organizations: "组织",
  timeline: "时间轴",
  comments: "正文评论",
  relationships: "人物关系",
  outlines: "大纲与伏笔",
  reviews: "审核队列",
  tasks: "AI 分析",
  "ai-settings": "AI 设置"
};

const entityLabels: Record<string, string> = {
  setting: "设定编辑",
  character: "角色编辑",
  race: "种族编辑",
  organization: "组织编辑",
  relationship: "人物关系编辑"
};

function normalizedPage(page: PresencePage): PresenceParticipant["page"] {
  const module = String(page.module ?? "");
  const resourceId = String(page.resourceId ?? "");
  if (page.kind === "editor") return { key: `editor:${resourceId}`, label: "正文编辑" };
  if (page.kind === "entity-editor") return { key: `entity-editor:${module}:${resourceId}`, label: entityLabels[module] ?? "资料编辑" };
  if (page.kind === "module") return { key: `module:${module}`, label: moduleLabels[module] ?? "作品模块" };
  if (page.kind === "settings") return { key: "settings", label: "设置中心" };
  return { key: "welcome", label: "作品首页" };
}

export function editorPageKey(chapterId: string): string {
  return `editor:${chapterId}`;
}

export function entityEditorPageKey(module: "setting" | "character" | "race" | "organization" | "relationship", resourceId: string): string {
  return `entity-editor:${module}:${resourceId}`;
}

export function modulePageKey(module: keyof typeof moduleLabels | string): string {
  return `module:${module}`;
}

export function pageLabelForKey(pageKey: string): string {
  if (pageKey.startsWith("editor:")) return "正文编辑";
  if (pageKey.startsWith("entity-editor:")) {
    const module = pageKey.split(":")[1] ?? "";
    return entityLabels[module] ?? "资料编辑";
  }
  if (pageKey.startsWith("module:")) {
    const module = pageKey.slice("module:".length);
    return moduleLabels[module] ?? "作品模块";
  }
  if (pageKey === "settings") return "设置中心";
  return "作品页面";
}

export class CollaborationPresence {
  private readonly entries = new Map<string, PresenceEntry>();
  private readonly changes: ChangeEntry[] = [];
  private readonly dirtyEntryKeys = new Set<string>();
  private readonly pendingChanges = new Map<string, ChangeEntry>();
  private readonly lastPublishedAtMs = new Map<string, number>();
  private readonly persistenceStore: CollaborationPresenceStore | null;
  private readonly cleanupIntervalMs: number;
  private readonly minPublishIntervalMs: number;
  private maintenanceTimer: NodeJS.Timeout | null = null;
  private lastCleanupAt: number;
  private closed = false;

  constructor(
    private readonly timeoutMs = 45_000,
    private readonly now: () => number = Date.now,
    private readonly changeTtlMs = 120_000,
    private readonly maxChanges = 50,
    persistenceOrMinPublishInterval?: CollaborationPresencePersistenceOptions | number
  ) {
    const persistence = typeof persistenceOrMinPublishInterval === "number" ? undefined : persistenceOrMinPublishInterval;
    this.minPublishIntervalMs = typeof persistenceOrMinPublishInterval === "number"
      ? persistenceOrMinPublishInterval
      : persistence?.minPublishIntervalMs ?? 30_000;
    this.persistenceStore = persistence?.store ?? null;
    this.cleanupIntervalMs = Math.max(1, persistence?.cleanupIntervalMs ?? 60_000);
    this.lastCleanupAt = this.now();
    if (!this.persistenceStore) return;
    this.restoreFromStore(this.lastCleanupAt);
    const flushIntervalMs = Math.max(1, persistence?.flushIntervalMs ?? 5_000);
    this.maintenanceTimer = setInterval(() => {
      try {
        this.flush();
      } catch (error) {
        logger.warn("collaboration.presence_flush_failed", { error: sanitizeError(error) });
      }
    }, flushIntervalMs);
    this.maintenanceTimer.unref();
  }

  heartbeat(workId: string, clientId: string, user: PresenceUser, page: PresencePage): PresenceHeartbeatResult {
    const now = this.now();
    this.prune(now);
    const normalized = normalizedPage(page);
    const entryKey = `${workId}:${clientId}`;
    this.entries.set(entryKey, {
      workId,
      clientId,
      ...user,
      page: normalized,
      lastSeenAt: new Date(now).toISOString(),
      lastSeenMs: now,
      persistedPage: { ...page }
    });
    this.dirtyEntryKeys.add(entryKey);
    return {
      participants: this.list(workId, now),
      recentChanges: this.listChanges(workId, normalized.key, clientId, now)
    };
  }

  publishChange(
    workId: string,
    pageKey: string,
    actor: { userId: string; displayName: string },
    label = pageLabelForKey(pageKey)
  ): CollaborativeChange | null {
    const now = this.now();
    this.prune(now);
    const publishKey = `${workId}:${pageKey}:${actor.userId}`;
    const lastPublishedAt = this.lastPublishedAtMs.get(publishKey);
    if (
      this.minPublishIntervalMs > 0
      && lastPublishedAt !== undefined
      && now - lastPublishedAt < this.minPublishIntervalMs
    ) return null;
    const recipients = [...this.entries.values()]
      .filter((entry) => (
        entry.workId === workId
        && entry.page.key === pageKey
        && entry.userId !== actor.userId
      ))
      .map((entry) => ({ userId: entry.userId, clientId: entry.clientId }))
      .filter((recipient, index, values) => values.findIndex((candidate) => (
        candidate.userId === recipient.userId && candidate.clientId === recipient.clientId
      )) === index);
    if (recipients.length === 0) return null;
    if (this.minPublishIntervalMs > 0) this.lastPublishedAtMs.set(publishKey, now);
    const change: ChangeEntry = {
      id: `change-${now}-${randomUUID()}`,
      workId,
      pageKey,
      label,
      actorUserId: actor.userId,
      actorDisplayName: actor.displayName,
      savedAt: new Date(now).toISOString(),
      savedAtMs: now,
      recipients
    };
    this.changes.push(change);
    this.pendingChanges.set(change.id, change);
    while (this.changes.length > this.maxChanges) this.changes.shift();
    return {
      id: change.id,
      pageKey: change.pageKey,
      label: change.label,
      actorUserId: change.actorUserId,
      actorDisplayName: change.actorDisplayName,
      savedAt: change.savedAt
    };
  }

  listChanges(workId: string, pageKey: string, receiverClientId: string, now = this.now()): CollaborativeChange[] {
    this.pruneChanges(now);
    const receiverUserId = this.entries.get(`${workId}:${receiverClientId}`)?.userId;
    if (!receiverUserId) return [];
    return this.changes
      .filter((change) => (
        change.workId === workId
        && change.pageKey === pageKey
        && change.recipients.some((recipient) => (
          recipient.userId === receiverUserId && recipient.clientId === receiverClientId
        ))
      ))
      .sort((left, right) => right.savedAtMs - left.savedAtMs)
      .map(({ workId: _workId, savedAtMs: _savedAtMs, recipients: _recipients, ...change }) => change);
  }

  flush(forceCleanup = false): void {
    if (!this.persistenceStore) return;
    const now = this.now();
    this.prune(now);
    const dirtyKeys = [...this.dirtyEntryKeys];
    const pendingChangeIds = [...this.pendingChanges.keys()];
    const shouldCleanup = forceCleanup || now - this.lastCleanupAt >= this.cleanupIntervalMs;
    this.persistenceStore.flush({
      entries: dirtyKeys.flatMap((key) => {
        const entry = this.entries.get(key);
        return entry ? [this.persistedEntry(entry)] : [];
      }),
      changes: pendingChangeIds.flatMap((id) => {
        const change = this.pendingChanges.get(id);
        return change ? [this.persistedChange(change)] : [];
      }),
      ...(shouldCleanup ? {
        entryExpiryCutoff: new Date(now - this.timeoutMs).toISOString(),
        changeExpiryCutoff: new Date(now - this.changeTtlMs).toISOString()
      } : {})
    });
    for (const key of dirtyKeys) this.dirtyEntryKeys.delete(key);
    for (const id of pendingChangeIds) this.pendingChanges.delete(id);
    if (shouldCleanup) this.lastCleanupAt = now;
    this.restoreFromStore(now);
  }

  close(): void {
    if (this.closed) return;
    if (this.maintenanceTimer) {
      clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
    }
    this.flush(true);
    this.closed = true;
  }

  private list(workId: string, now: number): PresenceParticipant[] {
    this.prune(now);
    return [...this.entries.values()]
      .filter((entry) => entry.workId === workId)
      .sort((left, right) => right.lastSeenMs - left.lastSeenMs || left.displayName.localeCompare(right.displayName, "zh-CN"))
      .map(({ workId: _workId, lastSeenMs: _lastSeenMs, persistedPage: _persistedPage, ...participant }) => participant);
  }

  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.lastSeenMs > this.timeoutMs) {
        this.entries.delete(key);
        this.dirtyEntryKeys.delete(key);
      }
    }
    for (const [key, publishedAtMs] of this.lastPublishedAtMs) {
      if (this.minPublishIntervalMs <= 0 || now - publishedAtMs >= this.minPublishIntervalMs) {
        this.lastPublishedAtMs.delete(key);
      }
    }
    this.pruneChanges(now);
  }

  private pruneChanges(now: number): void {
    while (this.changes.length > 0) {
      const oldest = this.changes[0];
      if (!oldest || now - oldest.savedAtMs <= this.changeTtlMs) break;
      this.changes.shift();
    }
  }

  private persistedEntry(entry: PresenceEntry): PersistedPresenceEntry {
    return {
      workId: entry.workId,
      clientId: entry.clientId,
      userId: entry.userId,
      username: entry.username,
      displayName: entry.displayName,
      avatarUrl: entry.avatarUrl,
      page: { ...entry.persistedPage },
      lastSeenAt: entry.lastSeenAt
    };
  }

  private persistedChange(change: ChangeEntry): PersistedCollaborativeChange {
    return {
      id: change.id,
      workId: change.workId,
      pageKey: change.pageKey,
      label: change.label,
      actorUserId: change.actorUserId,
      actorDisplayName: change.actorDisplayName,
      savedAt: change.savedAt,
      recipients: change.recipients.map((recipient) => ({ ...recipient }))
    };
  }

  private restoreFromStore(now: number): void {
    if (!this.persistenceStore) return;
    const activeEntries = this.persistenceStore.loadEntries(new Date(now - this.timeoutMs).toISOString());
    for (const persisted of activeEntries) {
      const lastSeenMs = Date.parse(persisted.lastSeenAt);
      if (!Number.isFinite(lastSeenMs) || now - lastSeenMs > this.timeoutMs) continue;
      const key = `${persisted.workId}:${persisted.clientId}`;
      const current = this.entries.get(key);
      if (current && current.lastSeenMs >= lastSeenMs) continue;
      this.entries.set(key, {
        workId: persisted.workId,
        clientId: persisted.clientId,
        userId: persisted.userId,
        username: persisted.username,
        displayName: persisted.displayName,
        avatarUrl: persisted.avatarUrl,
        page: normalizedPage(persisted.page),
        lastSeenAt: persisted.lastSeenAt,
        lastSeenMs,
        persistedPage: { ...persisted.page }
      });
      this.dirtyEntryKeys.delete(key);
    }

    const knownChangeIds = new Set(this.changes.map((change) => change.id));
    for (const persisted of this.persistenceStore.loadChanges(new Date(now - this.changeTtlMs).toISOString(), this.maxChanges)) {
      if (knownChangeIds.has(persisted.id)) continue;
      const savedAtMs = Date.parse(persisted.savedAt);
      if (!Number.isFinite(savedAtMs) || now - savedAtMs > this.changeTtlMs) continue;
      this.changes.push({
        ...persisted,
        savedAtMs,
        recipients: persisted.recipients.filter((recipient, index, values) => values.findIndex((candidate) => (
          candidate.userId === recipient.userId && candidate.clientId === recipient.clientId
        )) === index)
      });
      knownChangeIds.add(persisted.id);
    }
    this.changes.sort((left, right) => left.savedAtMs - right.savedAtMs || left.id.localeCompare(right.id));
    while (this.changes.length > this.maxChanges) this.changes.shift();
    this.prune(now);
  }
}
