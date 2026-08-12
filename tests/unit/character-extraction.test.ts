import { describe, expect, it } from "vitest";
import {
  characterExtractionHash,
  characterExtractionSelectionFingerprint,
  editableCharacterExtractionCandidate,
  normalizeCharacterExtractionCandidate,
  parseStoredCharacterExtractionCandidates
} from "../../src/character-extraction.js";

describe("角色抽取结果转换", () => {
  it("规范化标准名和别名，并只保留可写入的证据与属性", () => {
    expect(normalizeCharacterExtractionCandidate({
      name: "  林　舟  ",
      aliases: [" 小舟 ", "小舟", "林 舟", "", "A".repeat(201)],
      species: " 人类 ",
      identity: " 调查员 ",
      firstChapterId: "chapter_1",
      firstEvidence: { chapterId: "chapter_1", chapterTitle: " 第一章 ", quote: " 林舟抵达北港。 " },
      stableCharacterId: "character_1"
    }, 0)).toEqual({
      candidateId: "candidate-1",
      name: "林 舟",
      aliases: ["小舟"],
      species: "人类",
      identity: "调查员",
      firstChapterId: "chapter_1",
      firstEvidence: { chapterId: "chapter_1", chapterTitle: "第一章", quote: "林舟抵达北港。" },
      stableCharacterId: "character_1"
    });
  });

  it("拒绝不完整、超量或候选标识重复的存储结果", () => {
    expect(() => parseStoredCharacterExtractionCandidates([{ candidateId: "bad id", name: "林舟" }]))
      .toThrow("角色抽取预览包含无效字段");
    expect(() => parseStoredCharacterExtractionCandidates([
      { candidateId: "candidate-1", name: "林舟" },
      { candidateId: "candidate-1", name: "沈星" }
    ])).toThrow("角色抽取预览候选标识重复");
    expect(() => parseStoredCharacterExtractionCandidates(Array.from({ length: 501 }, (_, index) => ({ name: `角色${index}` }))))
      .toThrow("角色抽取预览数据无效");
  });

  it("仅接受白名单编辑字段并阻止重复或等同标准名的别名", () => {
    const candidate = parseStoredCharacterExtractionCandidates([{
      candidateId: "candidate-1",
      name: "林舟",
      aliases: ["小舟"],
      species: "人类",
      identity: "调查员"
    }])[0]!;
    expect(editableCharacterExtractionCandidate(candidate, {
      candidateId: candidate.candidateId,
      action: "create",
      name: "林舟（北港）",
      aliases: ["小舟", "林舟"],
      attributes: { identity: "北港调查员" }
    })).toEqual({
      name: "林舟(北港)",
      aliases: ["小舟", "林舟"],
      species: "人类",
      identity: "北港调查员"
    });
    expect(() => editableCharacterExtractionCandidate(candidate, {
      candidateId: candidate.candidateId,
      action: "create",
      aliases: ["林舟"]
    })).toThrow("角色别名不能为空、重复、等同标准名");
    expect(() => editableCharacterExtractionCandidate(candidate, {
      candidateId: candidate.candidateId,
      action: "create",
      aliases: ["小舟", " 小舟 "]
    })).toThrow("角色别名不能为空、重复、等同标准名");
  });

  it("预览和请求指纹对对象键顺序及选择顺序保持稳定", () => {
    expect(characterExtractionHash({ b: 2, a: { d: 4, c: 3 } }))
      .toBe(characterExtractionHash({ a: { c: 3, d: 4 }, b: 2 }));
    expect(characterExtractionSelectionFingerprint([
      { candidateId: "candidate-2", action: "skip" },
      { candidateId: "candidate-1", action: "create", name: "林舟" }
    ])).toBe(characterExtractionSelectionFingerprint([
      { candidateId: "candidate-1", action: "create", name: "林舟" },
      { candidateId: "candidate-2", action: "skip" }
    ]));
  });
});
