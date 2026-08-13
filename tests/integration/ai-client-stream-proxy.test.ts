import { once } from "node:events";
import { createServer, request as httpRequest, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error 浏览器端模块没有单独的类型声明，测试仅调用纯函数导出。
import { assertAiStreamCompleted, readAiEventStream } from "../../src/public/ai-stream-protocol.js";

async function listen(server: Server): Promise<URL> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务未监听 TCP 端口");
  return new URL(`http://127.0.0.1:${address.port}`);
}

describe("AI 客户端流完成协议", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("反向代理在 complete 前 clean EOF 时保留 delta 并报告上游关闭", async () => {
    const upstream = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write('event: delta\ndata: {"delta":"反代断流前内容"}\n\n');
      setTimeout(() => response.end('event: complete\ndata: {"messageId":"late"}\n\n'), 100);
    });
    servers.push(upstream);
    const upstreamUrl = await listen(upstream);

    const proxy = createServer((incoming, outgoing) => {
      const forwarded = httpRequest(new URL(incoming.url ?? "/", upstreamUrl), (upstreamResponse) => {
        outgoing.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.once("data", (chunk) => {
          outgoing.end(chunk);
          forwarded.destroy();
        });
      });
      forwarded.on("error", () => {
        if (!outgoing.writableEnded) outgoing.destroy();
      });
      forwarded.end();
    });
    servers.push(proxy);
    const proxyUrl = await listen(proxy);

    const response = await fetch(proxyUrl);
    if (!response.body) throw new Error("代理响应缺少正文");
    const deltas: string[] = [];
    const result = await readAiEventStream(response.body, (eventName: string, payload: { delta?: unknown }) => {
      if (eventName === "delta" && typeof payload.delta === "string") deltas.push(payload.delta);
    });

    expect(deltas).toEqual(["反代断流前内容"]);
    expect(result).toEqual({ completed: false });
    let failure: unknown;
    try {
      assertAiStreamCompleted(result.completed);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "AI_STREAM_UPSTREAM_CLOSED",
      status: 502,
      message: "AI 流在收到完成事件前已关闭，已保留已生成内容"
    });
  });

  it("收到 complete 后的 clean EOF 仍视为正常完成", async () => {
    const body = new Response([
      'event: delta\ndata: {"delta":"完整内容"}',
      'event: complete\ndata: {"messageId":"message-complete"}',
      ""
    ].join("\n\n"), { headers: { "Content-Type": "text/event-stream" } }).body;
    if (!body) throw new Error("测试响应缺少正文");
    const events: string[] = [];

    const result = await readAiEventStream(body, (eventName: string) => {
      events.push(eventName);
    });

    expect(events).toEqual(["delta", "complete"]);
    expect(result).toEqual({ completed: true });
    expect(() => assertAiStreamCompleted(result.completed)).not.toThrow();
  });

  it("收到 warningOnly complete 时也视为正常业务结束", async () => {
    const body = new Response([
      'event: context\ndata: {"action":"warn"}',
      'event: complete\ndata: {"warningOnly":true}',
      ""
    ].join("\n\n"), { headers: { "Content-Type": "text/event-stream" } }).body;
    if (!body) throw new Error("测试响应缺少正文");
    const events: string[] = [];

    const result = await readAiEventStream(body, (eventName: string) => {
      events.push(eventName);
    });

    expect(events).toEqual(["context", "complete"]);
    expect(result).toEqual({ completed: true });
    expect(() => assertAiStreamCompleted(result.completed)).not.toThrow();
  });
});
