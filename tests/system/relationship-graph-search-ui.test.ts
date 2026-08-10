import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

describe("人物关系图搜索界面", () => {
  const runtimes: Runtime[] = [];

  afterEach(async () => {
    while (runtimes.length) await runtimes.pop()?.close();
  });

  it("在普通图、放大图和银河图提供可访问的人物搜索与定位入口", async () => {
    const runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "relationship-graph-search-system-test-secret",
      disableUserAuth: true,
      serveUi: true
    });
    runtimes.push(runtime);

    const page = await request(runtime.app).get("/").expect(200);
    const application = await request(runtime.app).get("/app.js").expect(200);
    const graph = await request(runtime.app).get("/relationship-graph.js").expect(200);
    const styles = await request(runtime.app).get("/styles.css").expect(200);

    expect(page.text).toContain('/styles.css?v=20260811-analysis-task-mention-presence-backup-v1');
    expect(page.text).toContain('/app.js?v=20260811-collaboration-recipient-v1');
    expect(application.text).toContain('/relationship-graph.js?v=20260809-galaxy-size-threshold-v1');
    expect(graph.text).toContain('export function searchRelationshipNodes(nodes, query, limit = 8)');
    expect(graph.text).toContain('testId: "relationship-node-search"');
    expect(graph.text).toContain('testId: "galaxy-node-search"');
    expect(graph.text).toContain('searchInput.setAttribute("role", "combobox")');
    expect(graph.text).toContain('focusViewOnNode(node.id)');
    expect(graph.text).toContain('focusCameraOnNode(node)');
    expect(styles.text).toContain('.relationship-node-search-results');
    expect(styles.text).toContain('.relationship-node-search.is-galaxy');
    expect(styles.text).toContain('.relationship-node-search:not(.is-galaxy)');
    expect(styles.text).toContain('.relationship-map-dialog { position: fixed; inset: 0; width: 100vw; max-width: none; height: 100dvh;');
    expect(styles.text).not.toContain('width: min(1400px, 96vw);');
  });
});
