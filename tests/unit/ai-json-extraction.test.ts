import { describe, expect, it } from "vitest";
import { extractJson } from "../../src/ai.js";
import { AppError } from "../../src/errors.js";

describe("AI JSON 提取", () => {
  it("解析带首尾空白的纯对象", () => {
    expect(extractJson<Record<string, unknown>>("  \n{\"status\":\"ok\",\"count\":2}\n  ")).toEqual({ status: "ok", count: 2 });
  });

  it("解析纯数组", () => {
    expect(extractJson<Array<Record<string, unknown>>>("[{\"id\":1},{\"id\":2}]")).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it.each([
    ["JSON 标记代码块", "```json\n{\"status\":\"ok\"}\n```"],
    ["大小写 JSON 标记代码块", "```JSON  \n{\"status\":\"ok\"}\n```"],
    ["无语言标记代码块", "```\n{\"status\":\"ok\"}\n```"]
  ])("解析%s", (_name, content) => {
    expect(extractJson<Record<string, unknown>>(content)).toEqual({ status: "ok" });
  });

  it.each([
    ["JSON 标签", "<json>{\"status\":\"ok\"}</json>"],
    ["大小写 JSON 标签", "<JSON>\n{\"status\":\"ok\"}\n</JSON>"],
    ["包含 XML 特殊字符的标签内容", "<json>{\"text\":\"A & B < C\"}</json>"]
  ])("解析%s", (name, content) => {
    const expected = name === "包含 XML 特殊字符的标签内容" ? { text: "A & B < C" } : { status: "ok" };
    expect(extractJson<Record<string, unknown>>(content)).toEqual(expected);
  });

  it("存在多个 JSON 标签时优先使用最后的正式结果", () => {
    const content = "<think><json>{\"status\":\"planning\"}</json></think>\n<json>{\"status\":\"ok\"}</json>";
    expect(extractJson<Record<string, unknown>>(content)).toEqual({ status: "ok" });
  });

  it("JSON 标签损坏时回退到已有裸 JSON 兼容路径", () => {
    const content = "<json>{not-json}</json>\n正式结果：{\"status\":\"ok\"}";
    expect(extractJson<Record<string, unknown>>(content)).toEqual({ status: "ok" });
  });

  it("JSON 字符串包含标签文本时仍能提取完整对象", () => {
    const content = "<json>{\"template\":\"<json>内容</json>\",\"status\":\"ok\"}</json>";
    expect(extractJson<Record<string, unknown>>(content)).toEqual({ template: "<json>内容</json>", status: "ok" });
  });

  it("从前后说明文字中提取对象", () => {
    expect(extractJson<Record<string, unknown>>("分析如下：\n{\"summary\":\"完成\"}\n以上为结果。")).toEqual({ summary: "完成" });
  });

  it("通过候选条件跳过思考文本中的临时 JSON", () => {
    const content = [
      "<think>{\"status\":\"planning\"}</think>",
      "分析完成：",
      "```json",
      "{\"summary\":\"正式结果\",\"dimensions\":[]}",
      "```"
    ].join("\n");
    const result = extractJson<Record<string, unknown>>(content, (value) => {
      return Boolean(value && typeof value === "object" && !Array.isArray(value) && "dimensions" in value);
    });
    expect(result).toEqual({ summary: "正式结果", dimensions: [] });
  });

  it("跳过多个不符合条件的平衡 JSON 片段", () => {
    const decoys = Array.from({ length: 25 }, (_, index) => `{\"step\":${index}}`).join("\n");
    const content = `${decoys}\n最终结果：{\"summary\":\"命中\",\"dimensions\":[]}`;
    const result = extractJson<Record<string, unknown>>(content, (value) => {
      return Boolean(value && typeof value === "object" && !Array.isArray(value) && "dimensions" in value);
    });
    expect(result).toEqual({ summary: "命中", dimensions: [] });
  });

  it("跳过损坏片段并提取后续有效 JSON", () => {
    const content = "草稿：{not-json}\n正式结果：{\"status\":\"ok\"}";
    expect(extractJson<Record<string, unknown>>(content)).toEqual({ status: "ok" });
  });

  it("前一个 JSON 未闭合时仍提取后续完整对象", () => {
    const content = "未完成草稿：{\"status\":\"planning\"\n正式结果：{\"status\":\"ok\"}";
    expect(extractJson<Record<string, unknown>>(content)).toEqual({ status: "ok" });
  });

  it("正确处理嵌套结构、转义引号以及字符串内括号", () => {
    const content = String.raw`说明：{"items":[{"text":"他说：\"保留 {花括号} 和 [方括号]\"","meta":{"valid":true}}]}`;
    expect(extractJson<Record<string, unknown>>(content)).toEqual({
      items: [{ text: "他说：\"保留 {花括号} 和 [方括号]\"", meta: { valid: true } }]
    });
  });

  it("接受带 BOM 的 JSON", () => {
    expect(extractJson<Record<string, unknown>>("\uFEFF{\"status\":\"ok\"}")).toEqual({ status: "ok" });
  });

  it.each([
    ["没有 JSON", "分析完成，但没有结构化内容。"],
    ["JSON 未闭合", "结果：{\"status\":\"ok\""],
    ["括号类型不匹配", "结果：{\"items\":[1,2}}"]
  ])("拒绝%s", (_name, content) => {
    expect(() => extractJson(content)).toThrowError(AppError);
  });

  it("所有候选都不符合筛选条件时返回结构化错误", () => {
    try {
      extractJson("{\"status\":\"ok\"}", (value) => Boolean(value && typeof value === "object" && "summary" in value));
      throw new Error("预期 JSON 提取失败");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect(error).toMatchObject({ status: 502, code: "AI_INVALID_JSON" });
    }
  });

  it("错误详情最多保留 500 个字符", () => {
    try {
      extractJson("x".repeat(800));
      throw new Error("预期 JSON 提取失败");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).details).toEqual({ output: "x".repeat(500) });
    }
  });
});
