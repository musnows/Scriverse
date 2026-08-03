import { describe, expect, it } from "vitest";
import {
  buildScriverseObjectKey,
  formatBackupTimestamp,
  parseS3ListObjectsXml,
  publicS3Config
} from "../../src/s3-client.js";
import { nextScheduleDelayMs } from "../../src/backup-manager.js";

describe("s3-client helpers", () => {
  it("builds scriverse object keys with optional prefix", () => {
    expect(buildScriverseObjectKey("", "db", "novel-20260101T030000.db")).toBe("scriverse/db/novel-20260101T030000.db");
    expect(buildScriverseObjectKey("/prod/backups/", "img", "ab/abcdef.webp")).toBe("prod/backups/scriverse/img/ab/abcdef.webp");
  });

  it("formats backup timestamps without separators except T", () => {
    const stamp = formatBackupTimestamp(new Date("2026-08-03T15:04:05+08:00"));
    expect(stamp).toMatch(/^\d{8}T\d{6}$/u);
  });

  it("parses list objects xml", () => {
    const parsed = parseS3ListObjectsXml(`<?xml version="1.0"?>
      <ListBucketResult>
        <IsTruncated>false</IsTruncated>
        <Contents><Key>scriverse/db/a.db</Key><LastModified>2026-01-01T00:00:00.000Z</LastModified><Size>12</Size></Contents>
        <Contents><Key>scriverse/db/b.db</Key><LastModified>2026-01-02T00:00:00.000Z</LastModified><Size>34</Size></Contents>
      </ListBucketResult>`);
    expect(parsed.truncated).toBe(false);
    expect(parsed.objects).toEqual([
      { key: "scriverse/db/a.db", lastModified: "2026-01-01T00:00:00.000Z", size: 12 },
      { key: "scriverse/db/b.db", lastModified: "2026-01-02T00:00:00.000Z", size: 34 }
    ]);
  });

  it("omits credentials from public failure config", () => {
    expect(publicS3Config({
      targetId: "backup-target_1",
      name: "主站",
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      bucket: "scriverse-backup",
      pathPrefix: "prod",
      enabled: true
    })).toEqual({
      targetId: "backup-target_1",
      name: "主站",
      endpoint: "https://s3.example.com",
      region: "us-east-1",
      bucket: "scriverse-backup",
      pathPrefix: "prod",
      enabled: true,
      forcePathStyle: true
    });
  });
});

describe("backup schedule", () => {
  it("schedules the next daily trigger after the current time", () => {
    const from = new Date("2026-08-03T01:00:00");
    const delay = nextScheduleDelayMs("03:00", from);
    expect(delay).toBe(2 * 60 * 60 * 1000);
  });

  it("rolls to the next day when the trigger time has passed", () => {
    const from = new Date("2026-08-03T04:00:00");
    const delay = nextScheduleDelayMs("03:00", from);
    expect(delay).toBe(23 * 60 * 60 * 1000);
  });
});
