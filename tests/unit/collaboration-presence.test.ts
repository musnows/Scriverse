import { describe, expect, it, vi } from "vitest";
import {
  CollaborationPresence,
  editorPageKey,
  entityEditorPageKey,
  modulePageKey,
  pageLabelForKey
} from "../../src/collaboration-presence.js";
import { Database } from "../../src/database.js";
import { PresenceStore } from "../../src/presence-store.js";

function createPresenceWork(database: Database, workId = "work-1"): void {
  database.run(
    "INSERT INTO works (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
    workId,
    "协作测试作品",
    "2026-07-24T08:00:00.000Z",
    "2026-07-24T08:00:00.000Z"
  );
}

describe("作品协作者在线状态", () => {
  it("按浏览器标签页记录受控页面并清理过期状态", () => {
    let now = Date.parse("2026-07-24T08:00:00.000Z");
    const presence = new CollaborationPresence(45_000, () => now);
    const owner = { userId: "owner", username: "owner", displayName: "作者", avatarUrl: null };
    const writer = { userId: "writer", username: "writer", displayName: "协作者", avatarUrl: "/avatar" };

    presence.heartbeat("work-1", "54b43f7d-9778-4c8a-8b59-2ae64718cd59", owner, { kind: "editor", resourceId: "chapter-1" });
    now += 1_000;
    const active = presence.heartbeat("work-1", "652c35d0-e187-4a74-ab0c-7f2e3d2f3301", writer, { kind: "entity-editor", module: "character", resourceId: "character-1" });

    expect(active.participants).toEqual([
      expect.objectContaining({ displayName: "协作者", page: { key: "entity-editor:character:character-1", label: "角色编辑" } }),
      expect.objectContaining({ displayName: "作者", page: { key: "editor:chapter-1", label: "正文编辑" } })
    ]);
    expect(active.recentChanges).toEqual([]);

    now += 45_001;
    const refreshed = presence.heartbeat("work-1", "652c35d0-e187-4a74-ab0c-7f2e3d2f3301", writer, { kind: "module", module: "timeline" });
    expect(refreshed.participants).toHaveLength(1);
    expect(refreshed.participants[0]?.page).toEqual({ key: "module:timeline", label: "时间轴" });
  });

  it("仅向正在查看同一资料的其他用户返回最近事件", () => {
    let now = Date.parse("2026-07-24T09:00:00.000Z");
    const presence = new CollaborationPresence(45_000, () => now, 120_000, 50);
    const owner = { userId: "owner", username: "owner", displayName: "作者", avatarUrl: null };
    const writer = { userId: "writer", username: "writer", displayName: "协作者", avatarUrl: null };
    const reader = { userId: "reader", username: "reader", displayName: "读者", avatarUrl: null };

    presence.heartbeat("work-1", "client-owner", owner, { kind: "entity-editor", module: "relationship", resourceId: "relationship-1" });
    presence.heartbeat("work-1", "client-writer", writer, { kind: "entity-editor", module: "relationship", resourceId: "relationship-2" });
    expect(presence.publishChange("work-1", entityEditorPageKey("relationship", "relationship-1"), {
      userId: owner.userId,
      displayName: owner.displayName
    })).toBeNull();

    presence.heartbeat("work-1", "client-writer", writer, { kind: "entity-editor", module: "relationship", resourceId: "relationship-1" });
    const published = presence.publishChange("work-1", entityEditorPageKey("relationship", "relationship-1"), {
      userId: owner.userId,
      displayName: owner.displayName
    });
    expect(published).toMatchObject({
      pageKey: "entity-editor:relationship:relationship-1",
      label: "人物关系编辑",
      actorUserId: "owner",
      actorDisplayName: "作者"
    });
    if (!published) throw new Error("应登记同一人物关系的协作变更");

    const heartbeat = presence.heartbeat("work-1", "client-writer", writer, { kind: "entity-editor", module: "relationship", resourceId: "relationship-1" });
    expect(heartbeat.recentChanges).toEqual([
      expect.objectContaining({
        id: published.id,
        pageKey: "entity-editor:relationship:relationship-1",
        actorUserId: "owner"
      })
    ]);
    const actorHeartbeat = presence.heartbeat("work-1", "client-owner", owner, { kind: "entity-editor", module: "relationship", resourceId: "relationship-1" });
    expect(actorHeartbeat.recentChanges).toEqual([]);
    const lateViewer = presence.heartbeat("work-1", "client-reader", reader, { kind: "entity-editor", module: "relationship", resourceId: "relationship-1" });
    expect(lateViewer.recentChanges).toEqual([]);
    const globalList = presence.heartbeat("work-1", "client-writer", writer, { kind: "module", module: "relationships" });
    expect(globalList.recentChanges).toEqual([]);

    now += 120_001;
    const expired = presence.heartbeat("work-1", "client-writer", writer, { kind: "entity-editor", module: "relationship", resourceId: "relationship-1" });
    expect(expired.recentChanges).toEqual([]);
  });

  it("生成稳定的页面键与标签", () => {
    expect(editorPageKey("chapter-9")).toBe("editor:chapter-9");
    expect(entityEditorPageKey("character", "char-1")).toBe("entity-editor:character:char-1");
    expect(entityEditorPageKey("relationship", "relationship-1")).toBe("entity-editor:relationship:relationship-1");
    expect(modulePageKey("relationships")).toBe("module:relationships");
    expect(pageLabelForKey("entity-editor:race:race-1")).toBe("种族编辑");
    expect(pageLabelForKey("entity-editor:relationship:relationship-1")).toBe("人物关系编辑");
    expect(pageLabelForKey("module:outlines")).toBe("大纲与伏笔");
    expect(pageLabelForKey("module:comments")).toBe("正文评论");
  });

  it("合并同一客户端的高频心跳并在批量同步时只写最新状态", () => {
    let now = Date.parse("2026-07-24T10:00:00.000Z");
    const database = new Database(":memory:");
    createPresenceWork(database);
    const store = new PresenceStore(database);
    const flush = vi.spyOn(store, "flush");
    const presence = new CollaborationPresence(45_000, () => now, 120_000, 50, {
      store,
      flushIntervalMs: 1_000_000
    });
    try {
      const user = { userId: "owner", username: "owner", displayName: "作者", avatarUrl: null };
      presence.heartbeat("work-1", "client-owner", user, { kind: "welcome" });
      now += 1_000;
      presence.heartbeat("work-1", "client-owner", user, { kind: "module", module: "timeline" });

      expect(flush).not.toHaveBeenCalled();
      presence.flush();

      expect(flush).toHaveBeenCalledTimes(1);
      expect(flush.mock.calls[0]?.[0].entries).toEqual([
        expect.objectContaining({
          clientId: "client-owner",
          page: { kind: "module", module: "timeline" },
          lastSeenAt: "2026-07-24T10:00:01.000Z"
        })
      ]);
      expect(database.get("SELECT page_kind, page_module FROM presence_entries WHERE client_id = 'client-owner'")).toEqual({
        page_kind: "module",
        page_module: "timeline"
      });
    } finally {
      presence.close();
      database.close();
    }
  });

  it("从持久层恢复在线状态与定向变更并保证重启后的变更 ID 唯一", () => {
    const now = Date.parse("2026-07-24T11:00:00.000Z");
    const database = new Database(":memory:");
    createPresenceWork(database);
    const store = new PresenceStore(database);
    const owner = { userId: "owner", username: "owner", displayName: "作者", avatarUrl: null };
    const writer = { userId: "writer", username: "writer", displayName: "协作者", avatarUrl: null };
    const page = { kind: "entity-editor", module: "relationship", resourceId: "relationship-1" } as const;
    const pageKey = entityEditorPageKey("relationship", "relationship-1");
    const first = new CollaborationPresence(45_000, () => now, 120_000, 50, { store, flushIntervalMs: 1_000_000 });
    let second: CollaborationPresence | null = null;
    try {
      first.heartbeat("work-1", "client-owner", owner, page);
      first.heartbeat("work-1", "client-writer", writer, page);
      const firstChange = first.publishChange("work-1", pageKey, owner);
      expect(firstChange).not.toBeNull();
      first.close();

      second = new CollaborationPresence(45_000, () => now, 120_000, 50, { store, flushIntervalMs: 1_000_000 });
      const restored = second.heartbeat("work-1", "client-writer", writer, page);
      expect(restored.participants).toEqual(expect.arrayContaining([
        expect.objectContaining({ clientId: "client-owner", page: { key: pageKey, label: "人物关系编辑" } }),
        expect.objectContaining({ clientId: "client-writer", page: { key: pageKey, label: "人物关系编辑" } })
      ]));
      expect(restored.recentChanges).toEqual([expect.objectContaining({ id: firstChange?.id })]);

      const secondChange = second.publishChange("work-1", pageKey, owner);
      expect(secondChange).not.toBeNull();
      expect(secondChange?.id).not.toBe(firstChange?.id);
    } finally {
      second?.close();
      first.close();
      database.close();
    }
  });

  it("重启后相同 clientId 仅向原账户恢复定向变更", () => {
    const now = Date.parse("2026-07-24T12:00:00.000Z");
    const database = new Database(":memory:");
    createPresenceWork(database);
    const store = new PresenceStore(database);
    const owner = { userId: "owner", username: "owner", displayName: "作者", avatarUrl: null };
    const writer = { userId: "writer", username: "writer", displayName: "协作者", avatarUrl: null };
    const otherMember = { userId: "other", username: "other", displayName: "其他成员", avatarUrl: null };
    const page = { kind: "entity-editor", module: "relationship", resourceId: "relationship-1" } as const;
    const pageKey = entityEditorPageKey("relationship", "relationship-1");
    const first = new CollaborationPresence(45_000, () => now, 120_000, 50, { store, flushIntervalMs: 1_000_000 });
    let second: CollaborationPresence | null = null;
    try {
      first.heartbeat("work-1", "shared-client", writer, page);
      const change = first.publishChange("work-1", pageKey, owner);
      expect(change).not.toBeNull();
      first.close();

      second = new CollaborationPresence(45_000, () => now, 120_000, 50, { store, flushIntervalMs: 1_000_000 });
      expect(second.heartbeat("work-1", "shared-client", otherMember, page).recentChanges).toEqual([]);
      expect(second.heartbeat("work-1", "shared-client", writer, page).recentChanges).toEqual([
        expect.objectContaining({ id: change?.id })
      ]);
    } finally {
      second?.close();
      first.close();
      database.close();
    }
  });
});
