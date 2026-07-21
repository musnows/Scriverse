import { describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { AppError } from "../../src/errors.js";
import { assertSafeAiEndpoint, fetchSafeAiEndpoint } from "../../src/security.js";

const safePublicAddress = { address: "93.184.216.34", family: 4 as const };
const validateTestEndpoint = async (candidate: string) => {
  if (new URL(candidate).hostname === "127.0.0.1") return assertSafeAiEndpoint(candidate, false);
  return [safePublicAddress];
};

describe("assertSafeAiEndpoint", () => {
  it("拒绝指向环回地址的供应商 URL", async () => {
    await expect(assertSafeAiEndpoint("http://127.0.0.1:8080/v1")).rejects.toMatchObject({
      code: "UNSAFE_PROVIDER_ENDPOINT"
    });
  });

  it("允许公网 HTTPS 地址", async () => {
    await expect(assertSafeAiEndpoint("https://example.com/v1")).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ family: expect.any(Number) })
    ]));
  });
});

describe("fetchSafeAiEndpoint", () => {
  it("不自动跟随重定向到内网地址", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (String(url).includes("evil.example")) {
        return new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1:9000/secret" }
        });
      }
      return new Response("should-not-reach", { status: 200 });
    }) as unknown as typeof fetch;

    await expect(
      fetchSafeAiEndpoint(
        fetchImpl,
        "https://evil.example/v1/models",
        { headers: { Authorization: "Bearer secret-key" } },
        validateTestEndpoint
      )
    ).rejects.toBeInstanceOf(AppError);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("同主机重定向时保留 Authorization 并继续请求", async () => {
    const seenAuth: Array<string | null> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seenAuth.push(headers.get("authorization"));
      if (String(url).endsWith("/start")) {
        return new Response(null, {
          status: 307,
          headers: { location: "/v1/models" }
        });
      }
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as unknown as typeof fetch;

    const response = await fetchSafeAiEndpoint(
      fetchImpl,
      "https://example.com/start",
      { headers: { Authorization: "Bearer secret-key" } },
      validateTestEndpoint
    );

    expect(response.status).toBe(200);
    expect(seenAuth).toEqual(["Bearer secret-key", "Bearer secret-key"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("跨主机重定向时剥离 Authorization", async () => {
    const seenAuth: Array<string | null> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seenAuth.push(headers.get("authorization"));
      if (String(url).includes("provider.example")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example/v1/models" }
        });
      }
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;

    const response = await fetchSafeAiEndpoint(
      fetchImpl,
      "https://provider.example/v1/models",
      { headers: { Authorization: "Bearer secret-key" } },
      validateTestEndpoint
    );

    expect(response.status).toBe(200);
    expect(seenAuth).toEqual(["Bearer secret-key", null]);
  });

  it("使用通过校验的地址建立实际连接", async () => {
    const server = createServer((_request, response) => response.end("pinned"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("测试服务器未监听端口");

    try {
      const response = await fetchSafeAiEndpoint(
        fetch,
        `http://localhost:${address.port}/models`,
        {},
        async () => [{ address: "127.0.0.1", family: 4 }]
      );
      expect(await response.text()).toBe("pinned");
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
