import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";

describe("角色性别界面", () => {
  let runtime: Runtime;

  beforeEach(() => {
    runtime = createRuntime({
      databasePath: ":memory:",
      masterSecret: "character-gender-system-test-secret",
      disableUserAuth: true,
      serveUi: true
    });
  });
  afterEach(() => runtime.close());

  it("在角色表单、卡片和列表行中使用同一性别枚举", async () => {
    const [application, styles, page] = await Promise.all([
      request(runtime.app).get("/app.js").expect(200),
      request(runtime.app).get("/styles.css").expect(200),
      request(runtime.app).get("/").expect(200)
    ]);

    expect(application.text).toContain('const CHARACTER_GENDER_OPTIONS = [["unknown", "未知"], ["male", "男 / 雄"], ["female", "女 / 雌"], ["none", "无性别"]]');
    expect(application.text).toContain('field("gender", "性别", "select", item?.gender ?? "unknown", CHARACTER_GENDER_OPTIONS)');
    expect(application.text).toContain('gender: String(form.get("gender") ?? "unknown")');
    expect(application.text).toContain('class="character-gender"><b>性别</b>');
    expect(application.text).toContain('`性别 ${characterGenderLabel(item.gender)}`');
    expect(styles.text).toContain(".character-species, .character-gender {");
    expect(page.text).toContain("feature=character-gender-v1");
  });
});
