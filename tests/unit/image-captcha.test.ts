import { describe, expect, it } from "vitest";
import { AppError } from "../../src/errors.js";
import { ImageCaptchaService, renderCaptchaSvg } from "../../src/image-captcha.js";

describe("ImageCaptchaService", () => {
  it("生成 SVG 图片并校验正确答案", () => {
    const captcha = new ImageCaptchaService({ revealAnswer: true });
    const challenge = captcha.create();
    expect(challenge.captchaId).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(challenge.imageDataUrl.startsWith("data:image/svg+xml;base64,")).toBe(true);
    expect(challenge.answer).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/u);
    expect(() => captcha.consume(challenge.captchaId, challenge.answer ?? "")).not.toThrow();
  });

  it("答案大小写不敏感，且验证码只能使用一次", () => {
    const captcha = new ImageCaptchaService({ revealAnswer: true });
    const challenge = captcha.create();
    captcha.consume(challenge.captchaId, (challenge.answer ?? "").toLocaleLowerCase("en-US"));
    expect(() => captcha.consume(challenge.captchaId, challenge.answer ?? "")).toThrow(AppError);
  });

  it("错误答案会失效并拒绝", () => {
    const captcha = new ImageCaptchaService({ revealAnswer: true });
    const challenge = captcha.create();
    expect(() => captcha.consume(challenge.captchaId, "XXXX")).toThrow(/验证码不正确/u);
    expect(() => captcha.consume(challenge.captchaId, challenge.answer ?? "")).toThrow(/已失效/u);
  });

  it("渲染结果包含全部字符且转义特殊内容", () => {
    const svg = renderCaptchaSvg("A2B3", Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(svg).toContain(">A<");
    expect(svg).toContain(">2<");
    expect(svg).toContain(">B<");
    expect(svg).toContain(">3<");
    const escaped = renderCaptchaSvg("<&>\"", Buffer.alloc(8));
    expect(escaped).toContain(">&lt;<");
    expect(escaped).toContain(">&amp;<");
    expect(escaped).toContain(">&gt;<");
    expect(escaped).toContain(">&quot;<");
  });
});
