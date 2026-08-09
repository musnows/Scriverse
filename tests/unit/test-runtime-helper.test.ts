import type { Server } from "node:http";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { createTestRuntime } from "../helpers.js";

describe("测试运行时辅助工具", () => {
  it("只在 IPv4 回环地址监听 API 请求", async () => {
    const runtime = createTestRuntime();
    const server = runtime.app as unknown as Server;
    try {
      if (!server.listening) await once(server, "listening");
      const address = server.address();
      expect(address).not.toBeNull();
      expect(typeof address).not.toBe("string");
      if (!address || typeof address === "string") return;
      expect(address).toMatchObject({ address: "127.0.0.1", family: "IPv4" });
    } finally {
      runtime.close();
    }
  });
});
