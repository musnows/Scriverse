import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

describe("人物关系图搜索界面", () => {
  const runtimes: Runtime[] = [];

  afterEach(async () => {
    while (runtimes.length) await runtimes.pop()?.close();
  });

  it("在普通图、放大图和银河图提供可访问的人物搜索、定位与动效控制", async () => {
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

    expect(page.text).toContain('/styles.css?v=20260816-task-scope-volume-collapse-v2');
    expect(page.text).toContain('feature=galaxy-compact-controls-v2');
    expect(page.text).toContain('feature=galaxy-motion-mode-v2');
    expect(page.text).toContain('/app.js?v=20260816-extended-thinking-effort-v1');
    expect(application.text).toContain('/relationship-graph.js?v=20260817-relationship-canvas-scale-v1&feature=galaxy-motion-mode-v3&feature=galaxy-edge-label-threshold-v1');
    expect(application.text).toContain('class="relationship-table-wrapper"');
    expect(application.text).toContain('GALAXY_MOTION_MODE_STORAGE_KEY');
    expect(application.text).toContain('motionMode: storedGalaxyMotionMode()');
    expect(application.text).toContain('onMotionModeChange: persistGalaxyMotionMode');
    expect(page.text).toContain('id="galaxy-motion-mode"');
    expect(page.text).toContain('<option value="auto">自动</option><option value="on">开启</option><option value="reduced">减少</option><option value="off">关闭</option>');
    expect(page.text).toContain('id="galaxy-motion-status"');
    expect(graph.text).toContain('export function searchRelationshipNodes(nodes, query, limit = 8)');
    expect(graph.text).toContain('export function getGalaxyMotionProfile');
    expect(graph.text).toContain('shell.dataset.motionAutoReduced');
    expect(graph.text).toContain('motionProfile.starfieldPhysics');
    expect(graph.text).toContain('const shouldRotate = () => !rotationPaused;');
    expect(graph.text).not.toContain('motionProfile.autoRotation');
    expect(graph.text).toContain('testId: "relationship-node-search"');
    expect(graph.text).toContain('testId: "galaxy-node-search"');
    expect(graph.text).toContain('searchInput.setAttribute("role", "combobox")');
    expect(graph.text).toContain('focusViewOnNode(node.id)');
    expect(graph.text).toContain('focusCameraOnNode(node)');
    expect(styles.text).toContain('.relationship-node-search-results');
    expect(styles.text).toContain('.relationship-node-search.is-galaxy');
    expect(styles.text).toContain('.relationship-node-search.is-galaxy input { min-height: 36px; padding-block: 5px;');
    expect(styles.text).toContain('.galaxy-close { position: fixed; z-index: 8; top: 22px; right: 25px; width: 36px; height: 36px; min-height: 0;');
    expect(styles.text).toContain('.galaxy-shell.is-motion-off');
    expect(styles.text).toContain('.galaxy-motion-field');
    expect(styles.text).toContain('.galaxy-motion-field select option { background: #101722; color: #dcecff; }');
    expect(styles.text).toContain('.relationship-node-search:not(.is-galaxy)');
    expect(styles.text).toContain('.relationship-map-dialog { position: fixed; inset: 0; width: 100vw; max-width: none; height: 100dvh;');
    expect(styles.text).not.toContain('width: min(1400px, 96vw);');
  });
});
