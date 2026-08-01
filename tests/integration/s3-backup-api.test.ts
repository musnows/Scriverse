import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { createTestRuntime } from "../helpers.js";
import type { Runtime } from "../../src/app.js";

describe("S3 备份管理 API", () => {
  let runtime: Runtime;

  beforeAll(() => {
    runtime = createTestRuntime();
  });

  afterAll(() => {
    runtime.close();
  });

  describe("备份目标 CRUD", () => {
    let targetId: string;

    it("创建备份目标", async () => {
      const response = await request(runtime.app as never)
        .post("/api/platform/backup/targets")
        .send({
          name: "测试 OSS",
          endpoint: "https://oss-cn-hangzhou.aliyuncs.com",
          region: "cn-hangzhou",
          bucket: "test-backup",
          prefix: "novel-data",
          accessKeyId: "LTAI5tTestKeyId",
          secretAccessKey: "TestSecretKey123456",
          enabled: true
        })
        .expect(201);
      expect(response.body.data).toMatchObject({
        name: "测试 OSS",
        endpoint: "https://oss-cn-hangzhou.aliyuncs.com",
        region: "cn-hangzhou",
        bucket: "test-backup",
        prefix: "novel-data",
        enabled: true
      });
      expect(response.body.data.id).toBeDefined();
      targetId = response.body.data.id;
    });

    it("列出备份目标", async () => {
      const response = await request(runtime.app as never)
        .get("/api/platform/backup/targets")
        .expect(200);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0].name).toBe("测试 OSS");
    });

    it("更新备份目标", async () => {
      const response = await request(runtime.app as never)
        .patch(`/api/platform/backup/targets/${targetId}`)
        .send({ name: "更新后的 OSS", enabled: false })
        .expect(200);
      expect(response.body.data.name).toBe("更新后的 OSS");
      expect(response.body.data.enabled).toBe(false);
    });

    it("拒绝无效输入", async () => {
      await request(runtime.app as never)
        .post("/api/platform/backup/targets")
        .send({ name: "", endpoint: "not-a-url", region: "x", bucket: "b", accessKeyId: "a", secretAccessKey: "s" })
        .expect(400);
    });

    it("删除备份目标", async () => {
      await request(runtime.app as never)
        .delete(`/api/platform/backup/targets/${targetId}`)
        .expect(204);
      const response = await request(runtime.app as never)
        .get("/api/platform/backup/targets")
        .expect(200);
      expect(response.body.data).toHaveLength(0);
    });

    it("删除不存在的目标返回 404", async () => {
      await request(runtime.app as never)
        .delete("/api/platform/backup/targets/nonexistent-id")
        .expect(404);
    });
  });

  describe("备份策略设置", () => {
    it("获取默认设置", async () => {
      const response = await request(runtime.app as never)
        .get("/api/platform/backup/settings")
        .expect(200);
      expect(response.body.data).toMatchObject({
        includeImages: true,
        scheduleHour: 3,
        scheduleMinute: 0,
        retentionCount: 5
      });
    });

    it("更新设置", async () => {
      const response = await request(runtime.app as never)
        .patch("/api/platform/backup/settings")
        .send({ includeImages: false, scheduleHour: 2, scheduleMinute: 30, retentionCount: 10 })
        .expect(200);
      expect(response.body.data).toMatchObject({
        includeImages: false,
        scheduleHour: 2,
        scheduleMinute: 30,
        retentionCount: 10
      });
    });

    it("拒绝超出范围的设置", async () => {
      await request(runtime.app as never)
        .patch("/api/platform/backup/settings")
        .send({ scheduleHour: 25 })
        .expect(400);
    });

    it("拒绝未知字段", async () => {
      await request(runtime.app as never)
        .patch("/api/platform/backup/settings")
        .send({ unknownField: true })
        .expect(400);
    });
  });

  describe("手动触发备份", () => {
    it("无启用目标时返回空结果", async () => {
      const response = await request(runtime.app as never)
        .post("/api/platform/backup/run")
        .expect(200);
      expect(response.body.data.results).toHaveLength(0);
    });
  });
});
