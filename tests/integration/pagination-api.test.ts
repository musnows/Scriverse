import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createTestRuntime, createWork } from "../helpers.js";

describe("列表 API 分页", () => {
  it("按页返回作品和设定，并保留下一页标记", async () => {
      const runtime = createTestRuntime();
      try {
        const work = await createWork(runtime);
        await createWork(runtime);
        const workId = String(work.id);
      for (const title of ["设定一", "设定二", "设定三"]) {
        runtime.store.createSetting(workId, { title, category: "规则", content: `${title}内容` });
      }

      const firstPage = await request(runtime.app).get("/api/works?limit=1&page=1").expect(200);
      expect(firstPage.body.data).toMatchObject({ page: 1, limit: 1, hasMore: true, nextPage: 2 });
      expect(firstPage.body.data.items).toHaveLength(1);

      const secondPage = await request(runtime.app).get(`/api/works/${workId}/settings?limit=2&page=2`).expect(200);
      expect(secondPage.body.data).toMatchObject({ page: 2, limit: 2, hasMore: false, nextPage: null });
      expect(secondPage.body.data.items).toHaveLength(1);
    } finally {
      runtime.close();
    }
  });

  it("拒绝超出上限或非法的分页参数", async () => {
    const runtime = createTestRuntime();
    try {
      await request(runtime.app).get("/api/works?limit=101").expect(400);
      await request(runtime.app).get("/api/works?page=0").expect(400);
      await request(runtime.app).get("/api/works?page=1&page=2").expect(400);
    } finally {
      runtime.close();
    }
  });
});
