import { writeFile } from "node:fs/promises";

const origin = process.env.SITE_ORIGIN
  ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : null)
  ?? "https://scriverse-showcase.vercel.app";
const siteUrl = new URL(origin);
const workerUrl = new URL("../dist/server/index.js", import.meta.url);
workerUrl.searchParams.set("static-export", `${Date.now()}`);
const { default: worker } = await import(workerUrl.href);

const response = await worker.fetch(
  new Request(`${origin}/`, {
    headers: {
      accept: "text/html",
      "x-forwarded-host": siteUrl.host,
      "x-forwarded-proto": siteUrl.protocol.slice(0, -1),
    },
  }),
  {
    ASSETS: {
      fetch: async () => new Response("Not found", { status: 404 }),
    },
  },
  {
    waitUntil() {},
    passThroughOnException() {},
  },
);

if (!response.ok) {
  throw new Error(`Static export failed with status ${response.status}.`);
}

const html = await response.text();
if (!html.includes("叙界 Scriverse") || !html.includes("拖拽旋转视角")) {
  throw new Error("Static export is missing required showcase content.");
}

await writeFile(new URL("../dist/client/index.html", import.meta.url), html, "utf8");
console.log("Static export complete.");
