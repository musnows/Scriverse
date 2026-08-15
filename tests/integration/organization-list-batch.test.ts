import { afterEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../src/app.js";
import type { Pagination } from "../../src/pagination.js";
import { createTestRuntime, createWork } from "../helpers.js";

function countReadQueries<T>(runtime: Runtime, operation: () => T): {
  result: T;
  queryCount: number;
  getSql: string[];
  allSql: string[];
} {
  const getSpy = vi.spyOn(runtime.database, "get");
  const allSpy = vi.spyOn(runtime.database, "all");
  const result = operation();
  const readResult = {
    result,
    queryCount: getSpy.mock.calls.length + allSpy.mock.calls.length,
    getSql: getSpy.mock.calls.map(([sql]) => String(sql)),
    allSql: allSpy.mock.calls.map(([sql]) => String(sql))
  };
  getSpy.mockRestore();
  allSpy.mockRestore();
  return readResult;
}

function pagination(page: number, limit: number): Pagination {
  return { page, limit, offset: (page - 1) * limit };
}

afterEach(() => vi.restoreAllMocks());

describe("组织列表批量映射", () => {
  it("批量读取组织成员和版本，并保持分页、Markdown 与空成员契约", async () => {
    const runtime = createTestRuntime();
    try {
      runtime.store.setRelationshipIndexQueuedHandler(null);
      const workId = String((await createWork(runtime, "组织批量查询")).id);
      const memberB = runtime.store.createCharacter(workId, { name: "角色B" });
      const memberA = runtime.store.createCharacter(workId, { name: "角色A" });
      const created = [
        runtime.store.createOrganization(workId, {
          name: "组织A",
          description: "第一版",
          memberIds: [String(memberB.id), String(memberA.id)],
          settingsSections: [{ title: "章程", contentMarkdown: "共同守望。" }]
        }),
        runtime.store.createOrganization(workId, { name: "组织B" }),
        runtime.store.createOrganization(workId, { name: "组织C", memberIds: [String(memberA.id)] }),
        runtime.store.createOrganization(workId, { name: "组织D" })
      ];
      const firstId = String(created[0]?.id);
      runtime.store.updateOrganization(firstId, { description: "第二版" });
      const details = new Map(created.map((organization) => {
        const detail = runtime.store.getOrganization(String(organization.id));
        return [String(detail.id), detail];
      }));

      const small = countReadQueries(runtime, () => runtime.store.listOrganizationsPage(workId, pagination(1, 1), true));
      const large = countReadQueries(runtime, () => runtime.store.listOrganizationsPage(workId, pagination(1, 3), true));
      const withoutMarkdown = countReadQueries(runtime, () => runtime.store.listOrganizationsPage(workId, pagination(1, 3), false));
      const empty = countReadQueries(runtime, () => runtime.store.listOrganizationsPage(workId, pagination(3, 2), true));

      expect(small.queryCount).toBe(6);
      expect(large.queryCount).toBe(6);
      expect(withoutMarkdown.queryCount).toBe(6);
      expect(empty.queryCount).toBe(4);
      expect([...small.getSql, ...small.allSql].filter((sql) => sql.includes("entity_id = ?"))).toEqual([]);
      expect(small.allSql.filter((sql) => sql.includes("m.organization_id IN ("))).toHaveLength(1);
      expect(small.allSql.filter((sql) => sql.includes("entity_id IN ("))).toHaveLength(1);

      expect(small.result).toMatchObject({ page: 1, limit: 1, hasMore: true, nextPage: 2 });
      expect(large.result).toMatchObject({ page: 1, limit: 3, hasMore: true, nextPage: 2 });
      expect(empty.result).toMatchObject({ items: [], page: 3, limit: 2, hasMore: false, nextPage: null });
      for (const item of large.result.items) expect(item).toEqual(details.get(String(item.id)));
      expect(large.result.items[0]).toMatchObject({
        id: firstId,
        description: "第二版",
        versionNo: 2,
        memberIds: [String(memberA.id), String(memberB.id)],
        members: [{ name: "角色A" }, { name: "角色B" }],
        settings: ["共同守望。"],
        settingsMarkdown: "共同守望。"
      });
      expect(large.result.items[1]).toMatchObject({ memberIds: [], members: [], versionNo: 1 });
      expect(withoutMarkdown.result.items[0]).toMatchObject({ settings: [], settingsCount: 1 });
      expect(withoutMarkdown.result.items[0]).not.toHaveProperty("settingsMarkdown");
      expect(withoutMarkdown.result.items[0]).not.toHaveProperty("settingsSections");
    } finally {
      await runtime.close();
    }
  });
});
