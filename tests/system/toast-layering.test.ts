import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("系统 Toast 图层", () => {
  it("通过 top layer 保持在模态弹窗和模糊遮罩上方", async () => {
    const publicPath = join(process.cwd(), "src", "public");
    const [page, application, styles] = await Promise.all([
      readFile(join(publicPath, "index.html"), "utf8"),
      readFile(join(publicPath, "app.js"), "utf8"),
      readFile(join(publicPath, "styles.css"), "utf8")
    ]);

    expect(page).toContain('id="toast-region"');
    expect(page).toContain('popover="manual"');
    expect(application).toContain("function raiseToastRegion()");
    expect(application).toContain('region.matches(":popover-open")');
    expect(application).toContain("region.showPopover()");
    expect(application).toContain('document.addEventListener("toggle"');
    expect(application).toContain("target instanceof HTMLDialogElement && target.open");
    expect(styles).toContain("z-index: 2147483647");
    expect(styles).toContain("pointer-events: none");
  });
});
