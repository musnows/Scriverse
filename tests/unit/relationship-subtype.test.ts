import { describe, expect, it } from "vitest";
import { canonicalizeRelationshipCategory, canonicalizeRelationshipSubtype } from "../../src/ai.js";

describe("关系子类规范化", () => {
  it("合并中英文和分隔符不同的同义关系", () => {
    expect(canonicalizeRelationshipSubtype("emotional", "romantic_partners")).toBe("伴侣");
    expect(canonicalizeRelationshipSubtype("emotional", "lover")).toBe("伴侣");
    expect(canonicalizeRelationshipSubtype("social", "monarch-subject")).toBe("君臣");
    expect(canonicalizeRelationshipSubtype("social", "subject_to_ruler")).toBe("君臣");
    expect(canonicalizeRelationshipSubtype("conflict", "rival")).toBe("宿敌");
    expect(canonicalizeRelationshipSubtype("social", "同僚")).toBe("同事");
    expect(canonicalizeRelationshipSubtype("social", "同盟")).toBe("盟友");
    expect(canonicalizeRelationshipSubtype("social", "旧友")).toBe("朋友");
  });

  it("保留不在受控词表中的明确中文关系", () => {
    expect(canonicalizeRelationshipSubtype("social", "救命恩人")).toBe("救命恩人");
    expect(canonicalizeRelationshipSubtype("social", "姐弟般挚友与监护")).toBe("姐弟般挚友与监护");
  });

  it("按受控关系词纠正错误分类", () => {
    expect(canonicalizeRelationshipCategory("social", "伴侣")).toBe("emotional");
    expect(canonicalizeRelationshipCategory("social", "rival")).toBe("conflict");
    expect(canonicalizeRelationshipCategory("emotional", "父女")).toBe("family");
    expect(canonicalizeRelationshipCategory("emotional", "旧友")).toBe("social");
    expect(canonicalizeRelationshipCategory("family", "监护与旧友")).toBe("family");
    expect(canonicalizeRelationshipCategory("family", "姐弟般挚友与监护")).toBe("family");
  });
});
