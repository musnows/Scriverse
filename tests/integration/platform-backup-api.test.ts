import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestRuntime } from "../helpers.js";

type Runtime = ReturnType<typeof createTestRuntime>;

function xmlList(keys: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <IsTruncated>false</IsTruncated>
  ${keys.map((key) => `<Contents><Key>${key}</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><Size>10</Size></Contents>`).join("")}
</ListBucketResult>`;
}

describe("platform backup api", () => {
  let runtime: Runtime | null = null;

  afterEach(() => {
    runtime?.close();
    runtime = null;
  });

  it("stores encrypted secrets and runs sequential backups without printing credentials", async () => {
    const putKeys: string[] = [];
    const headKeys: string[] = [];
    const deletedKeys: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.includes("list-type=2")) {
        if (url.includes("prefix=")) {
          const existing = putKeys.filter((key) => key.includes("/scriverse/db/"));
          return new Response(xmlList(existing), { status: 200, headers: { "content-type": "application/xml" } });
        }
        return new Response(xmlList([]), { status: 200, headers: { "content-type": "application/xml" } });
      }
      if (method === "HEAD") {
        const key = decodeURIComponent(new URL(url).pathname.replace(/^\/[^/]+\//u, ""));
        headKeys.push(key);
        return new Response(null, { status: putKeys.includes(key) ? 200 : 404 });
      }
      if (method === "PUT") {
        const key = decodeURIComponent(new URL(url).pathname.replace(/^\/[^/]+\//u, ""));
        putKeys.push(key);
        return new Response(null, { status: 200, headers: { etag: "\"abc\"" } });
      }
      if (method === "DELETE") {
        const key = decodeURIComponent(new URL(url).pathname.replace(/^\/[^/]+\//u, ""));
        deletedKeys.push(key);
        return new Response(null, { status: 204 });
      }
      return new Response("unexpected", { status: 500 });
    }) as unknown as typeof fetch;

    runtime = createTestRuntime(fetchMock);
    mkdirSync(join(runtime.attachmentStorage.rootDirectory, "ab"), { recursive: true });
    writeFileSync(join(runtime.attachmentStorage.rootDirectory, "ab", `${"a".repeat(64)}.webp`), Buffer.from("image-bytes"));

    const created = await request(runtime.app)
      .post("/api/platform/backup/targets")
      .send({
        name: "主备份",
        endpoint: "https://s3.example.com",
        region: "us-east-1",
        bucket: "scriverse-backup",
        accessKeyId: "AKIAEXAMPLEKEY",
        secretAccessKey: "super-secret-access-key-value",
        pathPrefix: "prod",
        enabled: true
      })
      .expect(201);

    expect(created.body.data.secretAccessKeyHint).toContain("*");
    expect(created.body.data.secretAccessKeyHint).not.toContain("super-secret-access-key-value");
    expect(JSON.stringify(created.body)).not.toContain("super-secret-access-key-value");

    const row = runtime.database.get("SELECT * FROM platform_backup_targets WHERE id = ?", created.body.data.id);
    expect(String(row?.encrypted_secret_key)).not.toContain("super-secret-access-key-value");
    expect(String(row?.access_key_id)).toBe("AKIAEXAMPLEKEY");

    await request(runtime.app)
      .patch("/api/platform/backup/settings")
      .send({ enabled: false, scheduleTime: "04:30", retentionCount: 2, includeImages: true })
      .expect(200);

    const run = await request(runtime.app).post("/api/platform/backup/run").send({}).expect(200);
    expect(run.body.data.status).toBe("success");
    expect(putKeys.some((key) => key.startsWith("prod/scriverse/db/novel-") && key.endsWith(".db"))).toBe(true);
    expect(putKeys.some((key) => key.includes("prod/scriverse/img/ab/"))).toBe(true);
    expect(headKeys.some((key) => key.includes("prod/scriverse/img/ab/"))).toBe(true);

    await request(runtime.app).post("/api/platform/backup/run").send({}).expect(200);
    await request(runtime.app).post("/api/platform/backup/run").send({}).expect(200);
    expect(deletedKeys.length).toBeGreaterThanOrEqual(1);

    const settings = await request(runtime.app).get("/api/platform/backup/settings").expect(200);
    expect(settings.body.data.settings.lastRunStatus).toBe("success");
    expect(settings.body.data.targets).toHaveLength(1);
    expect(JSON.stringify(settings.body)).not.toContain("super-secret-access-key-value");
  });

  it("surfaces s3 failures with toastable errors and does not silently succeed", async () => {
    const fetchMock = vi.fn(async () => new Response("<Error><Code>AccessDenied</Code></Error>", {
      status: 403,
      statusText: "Forbidden",
      headers: { "content-type": "application/xml" }
    })) as unknown as typeof fetch;
    runtime = createTestRuntime(fetchMock);

    const created = await request(runtime.app)
      .post("/api/platform/backup/targets")
      .send({
        name: "失败目标",
        endpoint: "https://s3.example.com",
        region: "us-east-1",
        bucket: "scriverse-backup",
        accessKeyId: "AKIAFAILKEY",
        secretAccessKey: "should-not-appear-in-response",
        enabled: true
      })
      .expect(201);

    const failed = await request(runtime.app)
      .post(`/api/platform/backup/targets/${created.body.data.id}/test`)
      .send({})
      .expect(502);

    expect(failed.body.error.code).toBe("S3_REQUEST_FAILED");
    expect(failed.body.error.message).toContain("返回 HTTP 403");
    expect(JSON.stringify(failed.body)).not.toContain("should-not-appear-in-response");
    expect(failed.body.error.details?.endpoint).toBe("https://s3.example.com");
    expect(failed.body.error.details?.bucket).toBe("scriverse-backup");
    expect(failed.body.error.details?.accessKeyId).toBeUndefined();
    expect(failed.body.error.details?.secretAccessKey).toBeUndefined();
  });

  it("skips image upload when includeImages is false", async () => {
    const putKeys: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.includes("list-type=2")) {
        return new Response(xmlList(putKeys.filter((key) => key.includes("/scriverse/db/"))), {
          status: 200,
          headers: { "content-type": "application/xml" }
        });
      }
      if (method === "PUT") {
        const key = decodeURIComponent(new URL(url).pathname.replace(/^\/[^/]+\//u, ""));
        putKeys.push(key);
        return new Response(null, { status: 200 });
      }
      if (method === "DELETE") return new Response(null, { status: 204 });
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;

    runtime = createTestRuntime(fetchMock);
    mkdirSync(join(runtime.attachmentStorage.rootDirectory, "cd"), { recursive: true });
    writeFileSync(join(runtime.attachmentStorage.rootDirectory, "cd", `${"b".repeat(64)}.png`), Buffer.from("png"));

    await request(runtime.app)
      .post("/api/platform/backup/targets")
      .send({
        name: "仅数据库",
        endpoint: "https://s3.example.com",
        region: "us-east-1",
        bucket: "scriverse-backup",
        accessKeyId: "AKIADBONLY",
        secretAccessKey: "db-only-secret-key-value",
        enabled: true
      })
      .expect(201);

    await request(runtime.app)
      .patch("/api/platform/backup/settings")
      .send({ includeImages: false, retentionCount: 5 })
      .expect(200);

    const run = await request(runtime.app).post("/api/platform/backup/run").send({}).expect(200);
    expect(run.body.data.status).toBe("success");
    expect(run.body.data.includeImages).toBe(false);
    expect(run.body.data.targets[0].dbUploaded).toBe(true);
    expect(run.body.data.targets[0].dbKey).toContain("scriverse/db/");
    expect(run.body.data.targets[0].imagesUploaded).toBe(0);
    expect(putKeys.some((key) => String(key).includes("scriverse/img/"))).toBe(false);
  });
});
