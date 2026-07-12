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
    expect(imported.body.data.warnings[0]).toContain("默认卷");

    await request(runtime.app)
      .post(`/api/works/${workId}/import`)
      .attach("file", Buffer.from("invalid"), "novel.pdf")
      .expect(415);
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
    expect(imported.body.data.tree.volumes[0].chapters[0]).toMatchObject({ title: "第一章 抵达", content: "林舟抵达星港。" });
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
});
