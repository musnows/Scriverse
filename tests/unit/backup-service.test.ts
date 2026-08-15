import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackupService } from "../../src/backup-service.js";
import { CredentialVault } from "../../src/credential-vault.js";
import { Database } from "../../src/database.js";
import { Store } from "../../src/store.js";

describe("BackupService", () => {
  let database: Database;
  let store: Store;
  let vault: CredentialVault;
  let attachmentDirectory: string;
  let service: BackupService;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    database = new Database(":memory:");
    store = new Store(database);
    vault = new CredentialVault("a".repeat(32));
    attachmentDirectory = mkdtempSync(join(tmpdir(), "scriverse-backup-test-"));
    mkdirSync(join(attachmentDirectory, "ab"), { recursive: true });
    writeFileSync(join(attachmentDirectory, "ab", "abc.webp"), "fake-image");
    fetchMock = vi.fn(async (input: any, init?: RequestInit) => {
      const url = input instanceof URL ? input : input instanceof Request ? new URL(input.url) : new URL(String(input));
      const method = String(init?.method ?? "GET").toUpperCase();
      if (method === "HEAD" && url.pathname.endsWith(".webp")) {
        return new Response(null, { status: 404 });
      }
      if (method === "PUT") {
        return new Response(null, { status: 200 });
      }
      if (method === "GET" && url.searchParams.get("list-type") === "2") {
        return new Response("<?xml version=\"1.0\" encoding=\"UTF-8\"?><ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>", {
          status: 200,
          headers: { "Content-Type": "application/xml" }
        });
      }
      return new Response(null, { status: 500 });
    });
    service = new BackupService(store, vault, {
      databasePath: ":memory:",
      attachmentDirectory,
      fetchImpl: fetchMock as unknown as typeof fetch
    });
  });

  afterEach(() => {
    service.stop();
    database.close();
    rmSync(attachmentDirectory, { recursive: true, force: true });
  });

  it("creates a target and does not expose the secret key", () => {
    const target = service.createTarget({
      name: "MinIO",
      endpoint: "http://127.0.0.1:9000",
      region: "us-east-1",
      bucket: "novel-backup",
      prefix: "books",
      accessKeyId: "ak",
      secretAccessKey: "super-secret",
      backupImages: true,
      enabled: true
    });

    expect(target.id).toMatch(/^backup_/);
    expect(target.secretAccessKeyHint).not.toContain("super-secret");
    expect(target.prefix).toBe("books");
    expect(service.listTargets()).toHaveLength(1);
  });

  it("runs backup for an enabled target and uploads database and missing image", async () => {
    service.createTarget({
      name: "MinIO",
      endpoint: "http://127.0.0.1:9000",
      region: "us-east-1",
      bucket: "novel-backup",
      prefix: "",
      accessKeyId: "ak",
      secretAccessKey: "super-secret",
      backupImages: true,
      enabled: true
    });

    const results = await service.runNow();

    expect(results).toHaveLength(1);
    expect(results[0]?.ok).toBe(true);
    expect(results[0]?.uploadedImages).toBe(1);
    expect(results[0]?.skippedImages).toBe(0);
    const calls = fetchMock.mock.calls as Array<[URL | string, RequestInit?]>;
    expect(calls.some((call) => String(call[0]).includes("/novel-backup/scriverse/db/database-"))).toBe(true);
    expect(calls.some((call) => String(call[0]).includes("/novel-backup/scriverse/img/ab/abc.webp"))).toBe(true);
  });
});
