import { existsSync } from "node:fs";
import request from "supertest";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestRuntime, createWork } from "../helpers.js";

describe("人物 Markdown 章节与附件", () => {
  let runtime: ReturnType<typeof createTestRuntime>;

  beforeEach(() => { runtime = createTestRuntime(); });
  afterEach(() => { runtime.close(); });

  it("将上传图片转为更小的无损 WebP 并按内容去重", async () => {
    const work = await createWork(runtime);
    const png = await sharp({
      create: { width: 512, height: 512, channels: 4, background: { r: 20, g: 80, b: 160, alpha: 1 } }
    }).png().toBuffer();

    const first = await request(runtime.app)
      .post(`/api/works/${String(work.id)}/attachments`)
      .attach("file", png, { filename: "泰坦立绘.png", contentType: "image/png" });
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({
      originalName: "泰坦立绘.png",
      originalMimeType: "image/png",
      storedMimeType: "image/webp",
      width: 512,
      height: 512,
      pageCount: 1,
      animated: false,
      deduplicated: false
    });
    expect(first.body.data.storedByteLength).toBeLessThan(first.body.data.originalByteLength);
    expect(existsSync(runtime.attachmentStorage.path(first.body.data.storageKey))).toBe(true);

    const duplicate = await request(runtime.app)
      .post(`/api/works/${String(work.id)}/attachments`)
      .attach("file", png, { filename: "同一张图片.png", contentType: "image/png" });
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.data).toMatchObject({ id: first.body.data.id, deduplicated: true });
    expect(runtime.store.listAttachments(String(work.id))).toHaveLength(1);
  });

  it("维护 Markdown 附件引用、章节版本和删除保护", async () => {
    const work = await createWork(runtime);
    const character = runtime.store.createCharacter(String(work.id), { name: "魔克拉·姆边贝" });
    const image = await sharp({
      create: { width: 128, height: 128, channels: 3, background: { r: 10, g: 90, b: 40 } }
    }).png().toBuffer();
    const upload = await request(runtime.app)
      .post(`/api/works/${String(work.id)}/attachments`)
      .attach("file", image, { filename: "档案图.png", contentType: "image/png" });
    const attachmentId = String(upload.body.data.id);
    const storageKey = String(upload.body.data.storageKey);

    const created = await request(runtime.app)
      .post(`/api/characters/${String(character.id)}/sections`)
      .send({
        sectionType: "background",
        title: "背景故事",
        contentMarkdown: `## 远古时期\n\n![档案图](attachment://${attachmentId})\n\n曾经与其他泰坦发生冲突。`
      });
    expect(created.status).toBe(201);
    const sectionId = String(created.body.data.id);

    const compactCharacters = await request(runtime.app).get(`/api/works/${String(work.id)}/characters`);
    expect(compactCharacters.body.data[0]).toMatchObject({ profileSectionCount: 1 });
    expect(compactCharacters.body.data[0].profile.sections).toBeUndefined();
    const expandedCharacters = await request(runtime.app).get(`/api/works/${String(work.id)}/characters?includeSections=true`);
    expect(expandedCharacters.body.data[0].profile.sections[0]).toMatchObject({ id: sectionId, title: "背景故事" });

    const content = await request(runtime.app).get(`/api/attachments/${attachmentId}/content`);
    expect(content.status).toBe(200);
    expect(content.headers["content-type"]).toMatch(/^image\/webp/u);
    expect(content.headers["x-content-type-options"]).toBe("nosniff");

    const inUse = await request(runtime.app).delete(`/api/attachments/${attachmentId}`);
    expect(inUse.status).toBe(409);
    expect(inUse.body.error.code).toBe("ATTACHMENT_IN_USE");

    const updated = await request(runtime.app)
      .patch(`/api/character-sections/${sectionId}`)
      .send({ contentMarkdown: "## 远古时期\n\n曾经与其他泰坦发生冲突。", changeNote: "移除旧图" });
    expect(updated.status).toBe(200);
    expect(updated.body.data.versionNo).toBe(2);
    const versions = await request(runtime.app).get(`/api/character-sections/${sectionId}/versions`);
    expect(versions.body.data.map((version: Record<string, unknown>) => version.changeNote)).toEqual(["移除旧图", "建立人物 Markdown 章节"]);

    const restored = await request(runtime.app)
      .post(`/api/character-sections/${sectionId}/restore`)
      .send({ versionNo: 1 });
    expect(restored.status).toBe(200);
    expect(restored.body.data.contentMarkdown).toContain(`attachment://${attachmentId}`);
    await request(runtime.app).patch(`/api/character-sections/${sectionId}`).send({ contentMarkdown: "无附件" });

    const deleted = await request(runtime.app).delete(`/api/attachments/${attachmentId}`);
    expect(deleted.status).toBe(204);
    expect(existsSync(runtime.attachmentStorage.path(storageKey))).toBe(false);
  });

  it("拒绝在人物章节中引用其他作品的附件", async () => {
    const firstWork = await createWork(runtime, "第一部作品");
    const secondWork = await createWork(runtime, "第二部作品");
    const character = runtime.store.createCharacter(String(secondWork.id), { name: "第二部角色" });
    const image = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 30, b: 30 } }
    }).png().toBuffer();
    const upload = await request(runtime.app)
      .post(`/api/works/${String(firstWork.id)}/attachments`)
      .attach("file", image, { filename: "越权图.png", contentType: "image/png" });

    const response = await request(runtime.app)
      .post(`/api/characters/${String(character.id)}/sections`)
      .send({ title: "错误引用", contentMarkdown: `![](attachment://${String(upload.body.data.id)})` });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe("ATTACHMENT_WORK_MISMATCH");
    expect(runtime.store.listCharacterProfileSections(String(character.id))).toEqual([]);
  });

  it("按中文短词和正文片段检索人物 Markdown 章节", async () => {
    const work = await createWork(runtime);
    const character = runtime.store.createCharacter(String(work.id), { name: "哥斯拉" });
    runtime.store.createCharacterProfileSection(String(character.id), {
      sectionType: "abilities",
      title: "能力",
      contentMarkdown: "能够释放原子吐息，并通过背鳍积蓄辐射能量。"
    });

    expect(runtime.store.searchCharacterProfileSections(String(work.id), "背鳍")).toHaveLength(1);
    expect(runtime.store.searchCharacterProfileSections(String(work.id), "原子吐息")[0]).toMatchObject({
      characterName: "哥斯拉",
      title: "能力"
    });
  });
});
