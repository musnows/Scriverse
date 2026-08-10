import type {
  CollaborationPresenceStore,
  PersistedCollaborativeChange,
  PersistedPresenceEntry,
  PresencePage,
  PresencePersistenceBatch
} from "./collaboration-presence.js";
import type { Database } from "./database.js";

type PresenceEntryRow = {
  work_id: unknown;
  client_id: unknown;
  user_id: unknown;
  username: unknown;
  display_name: unknown;
  avatar_url: unknown;
  page_kind: unknown;
  page_module: unknown;
  page_resource_id: unknown;
  last_seen_at: unknown;
};

type PresenceChangeRow = {
  id: unknown;
  work_id: unknown;
  page_key: unknown;
  label: unknown;
  actor_user_id: unknown;
  actor_display_name: unknown;
  saved_at: unknown;
  recipient_client_ids_json: unknown;
};

function requiredString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parsePage(row: PresenceEntryRow): PresencePage | null {
  const kind = requiredString(row.page_kind);
  if (kind === "welcome" || kind === "settings") return { kind };
  if (kind === "editor") {
    const resourceId = requiredString(row.page_resource_id);
    return resourceId ? { kind, resourceId } : null;
  }
  if (kind === "module") {
    const module = requiredString(row.page_module);
    return module ? { kind, module } : null;
  }
  if (kind === "entity-editor") {
    const module = requiredString(row.page_module);
    const resourceId = optionalString(row.page_resource_id);
    return module ? { kind, module, ...(resourceId ? { resourceId } : {}) } : null;
  }
  return null;
}

function parseRecipients(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? [...new Set(parsed.filter((item): item is string => typeof item === "string" && item.length > 0))]
      : [];
  } catch {
    return [];
  }
}

export class PresenceStore implements CollaborationPresenceStore {
  constructor(private readonly database: Database) {}

  loadEntries(activeSince: string): PersistedPresenceEntry[] {
    const entries: PersistedPresenceEntry[] = [];
    for (const row of this.database.all<PresenceEntryRow>(
      `SELECT work_id, client_id, user_id, username, display_name, avatar_url,
              page_kind, page_module, page_resource_id, last_seen_at
       FROM presence_entries
       WHERE last_seen_at >= ?
       ORDER BY last_seen_at ASC, work_id ASC, client_id ASC`,
      activeSince
    )) {
      const workId = requiredString(row.work_id);
      const clientId = requiredString(row.client_id);
      const userId = requiredString(row.user_id);
      const username = requiredString(row.username);
      const displayName = requiredString(row.display_name);
      const lastSeenAt = requiredString(row.last_seen_at);
      const page = parsePage(row);
      if (!workId || !clientId || !userId || !username || !displayName || !lastSeenAt || !page) continue;
      entries.push({
        workId,
        clientId,
        userId,
        username,
        displayName,
        avatarUrl: typeof row.avatar_url === "string" ? row.avatar_url : null,
        page,
        lastSeenAt
      });
    }
    return entries;
  }

  loadChanges(activeSince: string, limit: number): PersistedCollaborativeChange[] {
    const resolvedLimit = Math.max(0, Math.trunc(limit));
    if (resolvedLimit === 0) return [];
    const changes: PersistedCollaborativeChange[] = [];
    for (const row of this.database.all<PresenceChangeRow>(
      `SELECT id, work_id, page_key, label, actor_user_id, actor_display_name,
              saved_at, recipient_client_ids_json
       FROM presence_changes
       WHERE saved_at >= ?
       ORDER BY saved_at DESC, id DESC
       LIMIT ?`,
      activeSince,
      resolvedLimit
    )) {
      const id = requiredString(row.id);
      const workId = requiredString(row.work_id);
      const pageKey = requiredString(row.page_key);
      const label = requiredString(row.label);
      const actorUserId = requiredString(row.actor_user_id);
      const actorDisplayName = requiredString(row.actor_display_name);
      const savedAt = requiredString(row.saved_at);
      if (!id || !workId || !pageKey || !label || !actorUserId || !actorDisplayName || !savedAt) continue;
      changes.push({
        id,
        workId,
        pageKey,
        label,
        actorUserId,
        actorDisplayName,
        savedAt,
        recipientClientIds: parseRecipients(row.recipient_client_ids_json)
      });
    }
    return changes.reverse();
  }

  flush(batch: PresencePersistenceBatch): void {
    const hasCleanup = batch.entryExpiryCutoff !== undefined || batch.changeExpiryCutoff !== undefined;
    if (batch.entries.length === 0 && batch.changes.length === 0 && !hasCleanup) return;
    this.database.transaction(() => {
      for (const entry of batch.entries) {
        this.database.run(
          `INSERT INTO presence_entries (
             work_id, client_id, user_id, username, display_name, avatar_url,
             page_kind, page_module, page_resource_id, last_seen_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(work_id, client_id) DO UPDATE SET
             user_id = excluded.user_id,
             username = excluded.username,
             display_name = excluded.display_name,
             avatar_url = excluded.avatar_url,
             page_kind = excluded.page_kind,
             page_module = excluded.page_module,
             page_resource_id = excluded.page_resource_id,
             last_seen_at = excluded.last_seen_at
           WHERE excluded.last_seen_at >= presence_entries.last_seen_at`,
          entry.workId,
          entry.clientId,
          entry.userId,
          entry.username,
          entry.displayName,
          entry.avatarUrl,
          entry.page.kind,
          entry.page.module ?? null,
          entry.page.resourceId ?? null,
          entry.lastSeenAt
        );
      }
      for (const change of batch.changes) {
        this.database.run(
          `INSERT INTO presence_changes (
             id, work_id, page_key, label, actor_user_id, actor_display_name,
             saved_at, recipient_client_ids_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO NOTHING`,
          change.id,
          change.workId,
          change.pageKey,
          change.label,
          change.actorUserId,
          change.actorDisplayName,
          change.savedAt,
          JSON.stringify([...new Set(change.recipientClientIds)])
        );
      }
      if (batch.entryExpiryCutoff !== undefined) {
        this.database.run("DELETE FROM presence_entries WHERE last_seen_at < ?", batch.entryExpiryCutoff);
      }
      if (batch.changeExpiryCutoff !== undefined) {
        this.database.run("DELETE FROM presence_changes WHERE saved_at < ?", batch.changeExpiryCutoff);
      }
    });
  }
}
