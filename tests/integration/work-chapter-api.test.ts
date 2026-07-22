import request from "supertest";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Runtime } from "../../src/app.js";
import { createTestRuntime } from "../helpers.js";

describe("作品、导入和章节版本 API", () => {
  let runtime: Runtime;

  beforeEach(() => { runtime = createTestRuntime(); });
  afterEach(() => runtime.close());

  it("完成作品创建、TXT 导入、保存、增量失效和版本恢复", async () => {
    const created = await request(runtime.app).post("/api/works").send({ title: "星际纪元", author: "M" }).expect(201);
    const workId = created.body.data.id;
    const imported = await request(runtime.app)
      .post(`/api/works/${workId}/import`)
      .attach("file", Buffer.from("第一卷 启航\n第一章 信号\n林舟收到信号。\n第二章 离港\n飞船离开北港。\n第二卷 深空\n第三章 遭遇\n警报响起。"), "novel.txt")
      .expect(201);

    expect(imported.body.data.tree.volumes).toHaveLength(2);
    const chapter = imported.body.data.tree.volumes[0].chapters[0];
    expect(chapter.versionNo).toBe(1);
    expect(chapter).not.toHaveProperty("content");
    expect(JSON.stringify(imported.body)).not.toContain("林舟收到信号。");

    const saved = await request(runtime.app)
      .patch(`/api/chapters/${chapter.id}`)
      .send({ content: "林舟收到来自深空的信号。" })
      .expect(200);
    expect(saved.body.data).toMatchObject({ versionNo: 2, analysisStatus: "expired" });

    await request(runtime.app)
      .patch(`/api/chapters/${chapter.id}`)
      .send({ content: "林舟收到来自深空的求救信号。", source: "auto" })
      .expect(200);

    const versions = await request(runtime.app).get(`/api/chapters/${chapter.id}/versions`).expect(200);
    expect(versions.body.data.map((item: { versionNo: number }) => item.versionNo)).toEqual([3, 2, 1]);
    expect(versions.body.data[0].source).toBe("auto");

    const tasks = await request(runtime.app).get(`/api/works/${workId}/tasks`).expect(200);
    expect(tasks.body.data).toHaveLength(1);
    expect(tasks.body.data[0]).toMatchObject({ status: "pending", sourceVersions: { [chapter.id]: 3 } });

    const restored = await request(runtime.app).post(`/api/chapters/${chapter.id}/restore`).send({ versionNo: 1 }).expect(200);
    expect(restored.body.data).toMatchObject({ content: "林舟收到信号。", versionNo: 4 });
  });

  it("无卷标题导入维持默认卷，并拒绝不支持文件", async () => {
    const created = await request(runtime.app).post("/api/works").send({ title: "无卷作品" }).expect(201);
    const workId = created.body.data.id;
    const imported = await request(runtime.app)
      .post(`/api/works/${workId}/import`)
      .attach("file", Buffer.from("第一章 开始\n正文。\n第二章 继续\n后续。"), "novel.txt")
      .expect(201);
    expect(imported.body.data.tree.volumes).toHaveLength(1);
    expect(imported.body.data.tree.volumes[0]).toMatchObject({ title: "正文", source: "default" });
    expect(imported.body.data.tree.volumes[0].chapters[0]).not.toHaveProperty("content");
    expect(imported.body.data.warnings[0]).toContain("默认卷");

    await request(runtime.app)
      .post(`/api/works/${workId}/import`)
      .attach("file", Buffer.from("invalid"), "novel.pdf")
      .expect(415);
  });

  it("按选择追加或覆盖已有作品正文", async () => {
    const created = await request(runtime.app).post("/api/works").send({ title: "导入方式作品" }).expect(201);
    const workId = created.body.data.id;
    const initial = await request(runtime.app)
      .post(`/api/works/${workId}/import`)
      .field("mode", "overwrite")
      .field("expectedVersionNo", "1")
      .attach("file", Buffer.from("第一卷 旧篇\n第一章 旧章\n旧正文。"), "old.txt")
      .expect(201);
    expect(initial.body.data.tree.versionNo).toBe(2);
    const oldChapterId = initial.body.data.firstImportedChapterId;

    const appended = await request(runtime.app)
      .post(`/api/works/${workId}/import`)
      .field("mode", "append")
      .field("expectedVersionNo", "2")
      .attach("file", Buffer.from("第二卷 新篇\n第二章 新章\n新正文。"), "append.txt")
      .expect(201);
    expect(appended.body.data).toMatchObject({ mode: "append" });
    expect(appended.body.data.tree.versionNo).toBe(3);
    expect(appended.body.data.tree.volumes.map((volume: { title: string }) => volume.title)).toEqual(["第一卷 旧篇", "第二卷 新篇"]);
    await request(runtime.app).get(`/api/chapters/${oldChapterId}`).expect(200);
    const appendedChapter = await request(runtime.app).get(`/api/chapters/${appended.body.data.firstImportedChapterId}`).expect(200);
    expect(appendedChapter.body.data.content).toBe("新正文。");

    const overwritten = await request(runtime.app)
      .post(`/api/works/${workId}/import`)
      .field("mode", "overwrite")
      .field("expectedVersionNo", "3")
      .attach("file", Buffer.from("第三卷 终篇\n第三章 终章\n最终正文。"), "overwrite.txt")
      .expect(201);
    expect(overwritten.body.data).toMatchObject({ mode: "overwrite" });
    expect(overwritten.body.data.tree.versionNo).toBe(4);
    expect(overwritten.body.data.tree.volumes.map((volume: { title: string }) => volume.title)).toEqual(["第三卷 终篇"]);
    await request(runtime.app).get(`/api/chapters/${oldChapterId}`).expect(404);

    await request(runtime.app)
      .post(`/api/works/${workId}/import`)
      .field("mode", "append")
      .field("expectedVersionNo", "3")
      .attach("file", Buffer.from("第四卷 过期导入\n第四章 不应写入\n正文。"), "stale.txt")
      .expect(409);
    const unchanged = await request(runtime.app).get(`/api/works/${workId}`).expect(200);
    expect(unchanged.body.data.volumes.map((volume: { title: string }) => volume.title)).toEqual(["第三卷 终篇"]);
  });

  it("拒绝未知的已有作品导入方式", async () => {
    const created = await request(runtime.app).post("/api/works").send({ title: "导入方式校验" }).expect(201);
    await request(runtime.app)
      .post(`/api/works/${created.body.data.id}/import`)
      .field("mode", "merge")
      .attach("file", Buffer.from("第一章 无效导入\n正文。"), "invalid-mode.txt")
      .expect(400);
    const unchanged = await request(runtime.app).get(`/api/works/${created.body.data.id}`).expect(200);
    expect(unchanged.body.data.volumes).toHaveLength(0);
  });

  it("拒绝伪装成 DOCX 的普通文件，且不创建或覆盖作品", async () => {
    const before = await request(runtime.app).get("/api/works").expect(200);
    const createResponse = await request(runtime.app)
      .post("/api/works/import")
      .attach("file", Buffer.from("普通文本改成了 docx 后缀"), "fake.docx")
      .expect(415);
    expect(createResponse.body.error.code).toBe("INVALID_DOCX_FILE");
    const after = await request(runtime.app).get("/api/works").expect(200);
    expect(after.body.data).toHaveLength(before.body.data.length);

    const disguisedZip = new JSZip();
    disguisedZip.file("[Content_Types].xml", "普通内容");
    disguisedZip.file("_rels/.rels", "普通内容");
    disguisedZip.file("word/document.xml", "普通内容");
    const disguisedResponse = await request(runtime.app)
      .post("/api/works/import")
      .attach("file", await disguisedZip.generateAsync({ type: "nodebuffer" }), "disguised.docx")
      .expect(415);
    expect(disguisedResponse.body.error.code).toBe("INVALID_DOCX_FILE");

    const work = await request(runtime.app).post("/api/works").send({ title: "不可覆盖作品" }).expect(201);
    const importResponse = await request(runtime.app)
      .post(`/api/works/${work.body.data.id}/import`)
      .attach("file", Buffer.from("这同样不是 DOCX"), "fake.docx")
      .expect(415);
    expect(importResponse.body.error.code).toBe("INVALID_DOCX_FILE");
    const unchanged = await request(runtime.app).get(`/api/works/${work.body.data.id}`).expect(200);
    expect(unchanged.body.data.volumes).toHaveLength(0);
  });

  it("拒绝非 UTF-8 编码的 TXT，且不创建或覆盖作品", async () => {
    const gbkText = Buffer.from([0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2]);
    const before = await request(runtime.app).get("/api/works").expect(200);
    const createResponse = await request(runtime.app)
      .post("/api/works/import")
      .attach("file", gbkText, "gbk.txt")
      .expect(415);
    expect(createResponse.body.error.code).toBe("INVALID_TEXT_ENCODING");
    const after = await request(runtime.app).get("/api/works").expect(200);
    expect(after.body.data).toHaveLength(before.body.data.length);

    const work = await request(runtime.app).post("/api/works").send({ title: "UTF-8 作品" }).expect(201);
    const importResponse = await request(runtime.app)
      .post(`/api/works/${work.body.data.id}/import`)
      .attach("file", gbkText, "gbk.txt")
      .expect(415);
    expect(importResponse.body.error.code).toBe("INVALID_TEXT_ENCODING");
    const unchanged = await request(runtime.app).get(`/api/works/${work.body.data.id}`).expect(200);
    expect(unchanged.body.data.volumes).toHaveLength(0);
  });

  it("创建和保存章节时自动压缩段间多余空行", async () => {
    const work = await request(runtime.app).post("/api/works").send({ title: "空行规则作品" }).expect(201);
    const volume = await request(runtime.app).post(`/api/works/${work.body.data.id}/volumes`).send({ title: "正文" }).expect(201);
    const chapter = await request(runtime.app).post(`/api/works/${work.body.data.id}/chapters`).send({
      volumeId: volume.body.data.id,
      title: "第一章",
      content: "\n\n第一段。\n\n\n\n第二段。\n\n"
    }).expect(201);
    expect(chapter.body.data.content).toBe("第一段。\n\n第二段。");

    const saved = await request(runtime.app).patch(`/api/chapters/${chapter.body.data.id}`).send({
      content: "第一段。\n　\n\t\n\n第二段。"
    }).expect(200);
    expect(saved.body.data.content).toBe("第一段。\n\n第二段。");
  });

  it("作品目录不返回章节正文并按章节加载正文", async () => {
    const work = await request(runtime.app).post("/api/works").send({ title: "按需加载作品" }).expect(201);
    const workId = work.body.data.id;
    const volume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "正文" }).expect(201);
    const chapter = await request(runtime.app).post(`/api/works/${workId}/chapters`).send({
      volumeId: volume.body.data.id,
      title: "第一章",
      content: "这段正文只能通过章节接口返回。"
    }).expect(201);

    const directory = await request(runtime.app).get(`/api/works/${workId}`).expect(200);
    expect(directory.body.data.volumes[0].chapters[0]).toMatchObject({
      id: chapter.body.data.id,
      title: "第一章",
      wordCount: 14
    });
    expect(directory.body.data.volumes[0].chapters[0]).not.toHaveProperty("content");
    expect(JSON.stringify(directory.body)).not.toContain("这段正文只能通过章节接口返回。");

    const loadedChapter = await request(runtime.app).get(`/api/chapters/${chapter.body.data.id}`).expect(200);
    expect(loadedChapter.body.data.content).toBe("这段正文只能通过章节接口返回。");
  });

  it("从 DOCX 正文中提取并解析卷章", async () => {
    const zip = new JSZip();
    zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
        <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
        <Default Extension="xml" ContentType="application/xml"/>
        <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
      </Types>`);
    zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
        <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
      </Relationships>`);
    zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
        <w:p><w:r><w:t>第一卷 星港</w:t></w:r></w:p>
        <w:p><w:r><w:t>第一章 抵达</w:t></w:r></w:p>
        <w:p><w:r><w:t>林舟抵达星港。</w:t></w:r></w:p>
        <w:sectPr/></w:body></w:document>`);
    zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
      <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`);
    const docx = await zip.generateAsync({ type: "nodebuffer" });
    const created = await request(runtime.app).post("/api/works").send({ title: "DOCX 作品" }).expect(201);
    const imported = await request(runtime.app)
      .post(`/api/works/${created.body.data.id}/import`)
      .attach("file", docx, "novel.docx")
      .expect(201);

    expect(imported.body.data.tree.volumes[0]).toMatchObject({ title: "第一卷 星港", source: "explicit" });
    const chapter = imported.body.data.tree.volumes[0].chapters[0];
    expect(chapter).toMatchObject({ title: "第一章 抵达" });
    expect(chapter).not.toHaveProperty("content");
    expect(JSON.stringify(imported.body)).not.toContain("林舟抵达星港。");
    const loadedChapter = await request(runtime.app).get(`/api/chapters/${chapter.id}`).expect(200);
    expect(loadedChapter.body.data.content).toBe("林舟抵达星港。");
  });

  it("正确解码 multipart 中文文件名并应用含前传提示", async () => {
    const created = await request(runtime.app).post("/api/works").send({ title: "含前传作品" }).expect(201);
    const imported = await request(runtime.app)
      .post(`/api/works/${created.body.data.id}/import`)
      .attach("file", Buffer.from("第一章 旧日\n前传正文。\n第一卷 归来\n第一章 新章\n主线正文。"), "作品（含前传）.txt")
      .expect(201);

    expect(imported.body.data.tree.volumes[0]).toMatchObject({ title: "前传", kind: "prequel" });
    expect(imported.body.data.warnings).toContain("根据文件名将首个未分卷内容识别为前传");
    const fileVersions = await request(runtime.app).get(`/api/works/${created.body.data.id}/file-versions`).expect(200);
    expect(fileVersions.body.data[0].fileName).toBe("作品（含前传）.txt");
  });

  it("校验空卷删除与跨作品移动规则", async () => {
    const first = await request(runtime.app).post("/api/works").send({ title: "A" }).expect(201);
    const second = await request(runtime.app).post("/api/works").send({ title: "B" }).expect(201);
    const firstVolume = await request(runtime.app).post(`/api/works/${first.body.data.id}/volumes`).send({ title: "第一卷" }).expect(201);
    const secondVolume = await request(runtime.app).post(`/api/works/${second.body.data.id}/volumes`).send({ title: "第二卷" }).expect(201);
    const chapter = await request(runtime.app).post(`/api/works/${first.body.data.id}/chapters`).send({ volumeId: firstVolume.body.data.id, title: "第一章" }).expect(201);

    await request(runtime.app).delete(`/api/volumes/${firstVolume.body.data.id}`).expect(409);
    await request(runtime.app).post(`/api/chapters/${chapter.body.data.id}/move`).send({ volumeId: secondVolume.body.data.id, sortOrder: 0 }).expect(400);
  });

  it("创建和编辑带简介及关键词的分卷", async () => {
    const work = await request(runtime.app).post("/api/works").send({ title: "分卷设定作品" }).expect(201);
    const volume = await request(runtime.app).post(`/api/works/${work.body.data.id}/volumes`).send({
      title: "第二卷 暗潮",
      kind: "main",
      description: "双面间谍进入敌方组织。",
      keywords: ["谍战", "身份危机", "谍战"]
    }).expect(201);
    expect(volume.body.data).toMatchObject({
      description: "双面间谍进入敌方组织。",
      keywords: ["谍战", "身份危机"]
    });

    const updated = await request(runtime.app).patch(`/api/volumes/${volume.body.data.id}`).send({
      description: "间谍身份开始暴露。",
      keywords: ["身份暴露", "阵营冲突"]
    }).expect(200);
    expect(updated.body.data).toMatchObject({
      description: "间谍身份开始暴露。",
      keywords: ["身份暴露", "阵营冲突"]
    });
    const tree = await request(runtime.app).get(`/api/works/${work.body.data.id}`).expect(200);
    expect(tree.body.data.volumes[0]).toMatchObject({ description: "间谍身份开始暴露。", keywords: ["身份暴露", "阵营冲突"] });
  });

  it("支持四种章节类型且只修改类型时不增加正文版本", async () => {
    const work = await request(runtime.app).post("/api/works").send({ title: "章节类型作品" }).expect(201);
    const volume = await request(runtime.app).post(`/api/works/${work.body.data.id}/volumes`).send({ title: "正文" }).expect(201);
    const chapter = await request(runtime.app).post(`/api/works/${work.body.data.id}/chapters`).send({
      volumeId: volume.body.data.id,
      title: "资料章",
      content: "世界观资料。",
      chapterType: "设定"
    }).expect(201);
    expect(chapter.body.data).toMatchObject({ chapterType: "设定", versionNo: 1 });

    const marked = await request(runtime.app).patch(`/api/chapters/${chapter.body.data.id}`).send({ chapterType: "作者的话" }).expect(200);
    expect(marked.body.data).toMatchObject({ chapterType: "作者的话", versionNo: 1, analysisStatus: "expired" });
    await request(runtime.app).patch(`/api/chapters/${chapter.body.data.id}`).send({ chapterType: "无效类型" }).expect(400);

    const exported = await request(runtime.app).get(`/api/works/${work.body.data.id}/export?format=json`).expect(200);
    expect(exported.body.data.work.volumes[0].chapters[0]).toMatchObject({ chapterType: "作者的话" });
  });

  it("删除章节后可列出版本并恢复", async () => {
    const work = await request(runtime.app).post("/api/works").send({ title: "章节删除恢复" }).expect(201);
    const workId = work.body.data.id;
    const volume = await request(runtime.app).post(`/api/works/${workId}/volumes`).send({ title: "正文" }).expect(201);
    const chapter = await request(runtime.app).post(`/api/works/${workId}/chapters`).send({
      volumeId: volume.body.data.id,
      title: "第一章",
      content: "原始正文。"
    }).expect(201);
    const chapterId = chapter.body.data.id;

    await request(runtime.app).delete(`/api/chapters/${chapterId}`).expect(204);
    await request(runtime.app).get(`/api/chapters/${chapterId}`).expect(404);

    const versions = await request(runtime.app).get(`/api/chapters/${chapterId}/versions`).expect(200);
    expect(versions.body.data[0]).toMatchObject({ versionNo: 2, source: "delete", title: "第一章", content: "原始正文。" });
    expect(versions.body.data.some((item: { versionNo: number }) => item.versionNo === 1)).toBe(true);

    const restored = await request(runtime.app).post(`/api/chapters/${chapterId}/restore`).send({ versionNo: 1 }).expect(200);
    expect(restored.body.data).toMatchObject({ id: chapterId, title: "第一章", content: "原始正文。", volumeId: volume.body.data.id });
    expect(restored.body.data.versionNo).toBeGreaterThan(2);
  });

  it("可从文件版本快照恢复作品正文树", async () => {
    const created = await request(runtime.app).post("/api/works").send({ title: "文件版本恢复" }).expect(201);
    const workId = created.body.data.id;
    await request(runtime.app)
      .post(`/api/works/${workId}/import`)
      .attach("file", Buffer.from("第一卷 启航\n第一章 信号\n初版正文。"), "v1.txt")
      .expect(201);

    await request(runtime.app)
      .post(`/api/works/${workId}/import`)
      .attach("file", Buffer.from("第一卷 启航\n第一章 信号\n改写后的正文。"), "v2.txt")
      .expect(201);

    const directoryBefore = await request(runtime.app).get(`/api/works/${workId}`).expect(200);
    const chapterId = directoryBefore.body.data.volumes[0].chapters[0].id;
    const chapterBefore = await request(runtime.app).get(`/api/chapters/${chapterId}`).expect(200);
    expect(chapterBefore.body.data.content).toBe("改写后的正文。");

    const fileVersions = await request(runtime.app).get(`/api/works/${workId}/file-versions`).expect(200);
    const v2VersionId = fileVersions.body.data.find((item: { fileName: string }) => item.fileName === "v2.txt").id;

    const restored = await request(runtime.app)
      .post(`/api/works/${workId}/file-versions/${v2VersionId}/restore`)
      .expect(200);
    expect(restored.body.data.restoredFrom).toBe(v2VersionId);
    const restoredChapter = restored.body.data.tree.volumes[0].chapters[0];
    expect(restoredChapter).not.toHaveProperty("content");
    expect(JSON.stringify(restored.body)).not.toContain("初版正文。");
    const restoredChapterDetails = await request(runtime.app).get(`/api/chapters/${restoredChapter.id}`).expect(200);
    expect(restoredChapterDetails.body.data.content).toBe("初版正文。");

    const fileVersionsAfter = await request(runtime.app).get(`/api/works/${workId}/file-versions`).expect(200);
    expect(fileVersionsAfter.body.data[0].fileType).toBe("snapshot");
  });

  it("拒绝损坏的文件版本快照且不改动当前正文", async () => {
    const created = await request(runtime.app).post("/api/works").send({ title: "损坏快照保护" }).expect(201);
    const workId = String(created.body.data.id);
    await request(runtime.app)
      .post(`/api/works/${workId}/import`)
      .attach("file", Buffer.from("第一章\n\n当前正文。"), "broken.txt")
      .expect(201);

    const directoryBefore = await request(runtime.app).get(`/api/works/${workId}`).expect(200);
    const chapterId = String(directoryBefore.body.data.volumes[0].chapters[0].id);
    const version = (await request(runtime.app).get(`/api/works/${workId}/file-versions`).expect(200)).body.data[0];
    const versionCountBefore = Number(runtime.database.get(
      "SELECT COUNT(*) AS count FROM file_versions WHERE work_id = ?",
      workId
    )?.count);
    runtime.database.run("UPDATE file_versions SET snapshot_json = ? WHERE id = ?", "{invalid", version.id);

    const failed = await request(runtime.app)
      .post(`/api/works/${workId}/file-versions/${version.id}/restore`)
      .expect(409);
    expect(failed.body.error.code).toBe("FILE_VERSION_INVALID");
    const directoryAfter = await request(runtime.app).get(`/api/works/${workId}`).expect(200);
    expect(directoryAfter.body.data.volumes[0].chapters[0].id).toBe(chapterId);
    const chapterAfter = await request(runtime.app).get(`/api/chapters/${chapterId}`).expect(200);
    expect(chapterAfter.body.data.content).toBe("当前正文。");
    expect(Number(runtime.database.get(
      "SELECT COUNT(*) AS count FROM file_versions WHERE work_id = ?",
      workId
    )?.count)).toBe(versionCountBefore);
  });
});
