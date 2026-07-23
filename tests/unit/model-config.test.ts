import { describe, expect, it } from "vitest";
import { isKimiModelId, modelFormValues, modelPayload } from "../../src/public/model-config.js";

describe("AI 模型配置", () => {
  it("新模型默认开启 thinking 并写入配置载荷", () => {
    const values = modelFormValues();
    expect(values.thinkingEnabled).toBe(true);
    expect(modelPayload({ ...values, displayName: "思考模型", modelId: "thinking-model" }).thinkingEnabled).toBe(true);
  });

  it("保留模型已有的 thinking 关闭状态", () => {
    const values = modelFormValues({ thinkingEnabled: false });
    expect(values.thinkingEnabled).toBe(false);
    expect(modelPayload({ ...values, displayName: "普通模型", modelId: "plain-model" }).thinkingEnabled).toBe(false);
  });

  it("Kimi 模型默认温度为 1 并允许手动调整", () => {
    expect(isKimiModelId("kimi-for-coding")).toBe(true);
    expect(modelFormValues({ modelId: "kimi-for-coding" }).temperature).toBe(1);
    expect(modelFormValues({ modelId: "kimi-for-coding", preset: { temperature: 0.7 } }).temperature).toBe(0.7);
    const payload = modelPayload({ ...modelFormValues(), displayName: "Kimi", modelId: "KIMI-K2", temperature: 0.2 });
    expect((payload.preset as { temperature: number }).temperature).toBe(0.2);
  });
});
