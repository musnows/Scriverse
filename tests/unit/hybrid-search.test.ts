import { describe, expect, it } from "vitest";
import {
  HYBRID_SEARCH_PERMISSION_MODULE_BY_TYPE,
  buildHybridSearchSnippet,
  documentParagraphLineRange,
  fuseHybridSearchChannels,
  hybridSearchPermissionModule,
  normalizeWorkSearchQuery,
  readableHybridSearchTypes,
  type HybridSearchCandidate
} from "../../src/hybrid-search.js";
import { emptyWorkModulePermissions } from "../../src/work-permissions.js";

function candidate(key: string, matchKind: HybridSearchCandidate["matchKind"], overrides: Partial<HybridSearchCandidate> = {}): HybridSearchCandidate {
  return {
    key,
    type: "setting",
    id: key,
    title: key,
    snippet: key,
    matchKind,
    ...overrides
  };
}

describe("混合检索排序", () => {
  it("使用倒数排名融合多个召回通道并合并命中类型", () => {
    const results = fuseHybridSearchChannels([
      { weight: 1.4, candidates: [candidate("metadata", "metadata"), candidate("shared", "metadata")] },
      { weight: 1, candidates: [candidate("shared", "exact", { startLine: 4, endLine: 6 }), candidate("exact", "exact")] },
      { weight: 0.55, candidates: [candidate("phonetic", "phonetic")] }
    ]);

    expect(results.map((item) => item.id)).toEqual(["shared", "metadata", "exact", "phonetic"]);
    expect(results[0]).toMatchObject({ matchKinds: ["metadata", "exact"], startLine: 4, endLine: 6 });
  });

  it("限制返回数量并稳定处理非法上限", () => {
    const channel = { weight: 1, candidates: [candidate("a", "exact"), candidate("b", "exact")] };
    expect(fuseHybridSearchChannels([channel], 1)).toHaveLength(1);
    expect(fuseHybridSearchChannels([channel], 0)).toHaveLength(1);
  });
});

describe("作品搜索输入边界", () => {
  it("保留内部换行并把标准化后的查询限制为 100 字符", () => {
    expect(normalizeWorkSearchQuery("\nＡ北港\n议会\n")).toBe("a北港\n议会");
    expect(normalizeWorkSearchQuery("界".repeat(100))).toHaveLength(100);
    expect(normalizeWorkSearchQuery(`${"界".repeat(100)}外`)).toBe("界".repeat(100));
  });
});

describe("作品搜索权限映射", () => {
  it("按搜索类型解析唯一的作品模块并列出当前可读类型", () => {
    expect(HYBRID_SEARCH_PERMISSION_MODULE_BY_TYPE).toMatchObject({
      chapter: "prose",
      character: "characters",
      "timeline-track": "timeline",
      "timeline-event": "timeline",
      "chapter-outline": "outlines",
      foreshadow: "outlines",
      review: "reviews",
      "agent-history": "ai-chat"
    });
    expect(hybridSearchPermissionModule("character")).toBe("characters");
    expect(hybridSearchPermissionModule("unknown")).toBeNull();

    const permissions = emptyWorkModulePermissions();
    permissions.prose = "read";
    permissions["ai-chat"] = "write";
    expect(readableHybridSearchTypes(permissions)).toEqual(["chapter", "agent-history"]);
  });
});

describe("混合检索摘要", () => {
  it("优先截取关键词附近内容并清理 JSON 符号", () => {
    const snippet = buildHybridSearchSnippet(`{"content":"${"前文".repeat(40)}北港议会通过了新章程${"后文".repeat(40)}"}`, "北港", 60);
    expect(snippet).toContain("北港议会");
    expect(snippet).not.toContain("{");
    expect(snippet).not.toContain("content");
    expect(snippet.startsWith("…")).toBe(true);
  });
});

describe("正文段落行定位", () => {
  it("按空白行分段并返回一基行号", () => {
    const content = "第一行\n第二行\n\n  \n第三行\n第四行\n\n第五行";
    expect(documentParagraphLineRange(content, 0)).toEqual({ startLine: 1, endLine: 2 });
    expect(documentParagraphLineRange(content, 1)).toEqual({ startLine: 5, endLine: 6 });
    expect(documentParagraphLineRange(content, 2)).toEqual({ startLine: 8, endLine: 8 });
    expect(documentParagraphLineRange(content, 3)).toBeNull();
  });
});
