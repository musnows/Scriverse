import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../src/errors.js";
import { assertSafeAiEndpoint, fetchSafeAiEndpoint } from "../../src/security.js";

describe("assertSafeAiEndpoint", () => {
  it("拒绝指向环回地址的供应商 URL", async () => {
    await expect(assertSafeAiEndpoint("http://127.0.0.1:8080/v1")).rejects.toMatchObject({
      code: "UNSAFE_PROVIDER_ENDPOINT"
    });
  });

  it("允许公网 HTTPS 地址", async () => {
    await expect(assertSafeAiEndpoint("https://example.com/v1")).resolves.toBeUndefined();
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
        (candidate) => assertSafeAiEndpoint(candidate, false)
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
      (candidate) => assertSafeAiEndpoint(candidate, false)
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
      (candidate) => assertSafeAiEndpoint(candidate, false)
    );

    expect(response.status).toBe(200);
    expect(seenAuth).toEqual(["Bearer secret-key", null]);
  });
});
