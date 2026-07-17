import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { shouldRenderGalaxyLabel } from "../app/galaxy-visibility.js";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(new Request("http://localhost/", { headers: { accept: "text/html" } }), {
    ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
  }, { waitUntil() {}, passThroughOnException() {} });
}

test("服务端渲染叙界介绍页", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>叙界 Scriverse/);
  assert.match(html, /让宏大的故事/);
  assert.match(html, /人物关系/);
  assert.match(html, /银河图/);
  assert.match(html, /AI 创作助手/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/);
});

test("关系节点的交互锚点与可见圆点保持重合", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const nodeRule = css.match(/\.relation-node \{([^}]+)\}/)?.[1] ?? "";
  const dotRule = css.match(/\.relation-node i \{([^}]+)\}/)?.[1] ?? "";

  assert.match(nodeRule, /width:\s*var\(--node-size\)/);
  assert.match(nodeRule, /height:\s*var\(--node-size\)/);
  assert.match(nodeRule, /padding:\s*0/);
  assert.doesNotMatch(nodeRule, /transition:[^;}]*\b(?:left|top)\b/);
  assert.match(dotRule, /width:\s*100%/);
  assert.match(dotRule, /height:\s*100%/);
});

test("银河图关闭名称后不再显示选中或关联角色名称", () => {
  assert.equal(shouldRenderGalaxyLabel(true), true);
  assert.equal(shouldRenderGalaxyLabel(false), false);
});
