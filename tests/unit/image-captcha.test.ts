import { describe, expect, it } from "vitest";
import { AppError } from "../../src/errors.js";
import {
  CAPTCHA_LIFETIME_DEFAULT_MS,
  CAPTCHA_LIFETIME_MINIMUM_MS,
  ImageCaptchaService,
  normalizeCaptchaAnswer,
  renderCaptchaSvg,
  resolveCaptchaLifetimeMs
} from "../../src/image-captcha.js";

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

  it("接受全角、大小写、空白和零宽字符，且与半角答案相同", () => {
    const captcha = new ImageCaptchaService({ revealAnswer: true });
    const challenge = captcha.create();
    const answer = challenge.answer ?? "";
    const fullwidth = answer.replace(/[A-Z2-9]/gu, (char) => String.fromCodePoint(char.codePointAt(0)! + 0xFEE0));
    expect(normalizeCaptchaAnswer(` \u3000${fullwidth.toLocaleLowerCase("en-US")}\u200b `)).toBe(answer);
    expect(() => captcha.consume(challenge.captchaId, ` ${fullwidth.slice(0, 2)}\u200b ${fullwidth.slice(2)}\u3000`)).not.toThrow();
  });

  it("默认 300 秒内有效，满 300 秒后失效", () => {
    let now = 1_700_000_000_000;
    const captcha = new ImageCaptchaService({ revealAnswer: true, now: () => now });
    const challenge = captcha.create();
    now += CAPTCHA_LIFETIME_DEFAULT_MS - 1;
    expect(() => captcha.consume(challenge.captchaId, challenge.answer ?? "")).not.toThrow();

    const expired = captcha.create();
    now += CAPTCHA_LIFETIME_DEFAULT_MS;
    expect(() => captcha.consume(expired.captchaId, expired.answer ?? "")).toThrow(/已失效/u);
    expect(() => captcha.consume(expired.captchaId, expired.answer ?? "")).toThrow(/已失效/u);
  });

  it("短于 180 秒的有效期会被抬到 180 秒", () => {
    expect(resolveCaptchaLifetimeMs()).toBe(CAPTCHA_LIFETIME_DEFAULT_MS);
    expect(resolveCaptchaLifetimeMs(Number.NaN)).toBe(CAPTCHA_LIFETIME_DEFAULT_MS);
    expect(resolveCaptchaLifetimeMs(1_000)).toBe(CAPTCHA_LIFETIME_MINIMUM_MS);
    expect(resolveCaptchaLifetimeMs(-1)).toBe(CAPTCHA_LIFETIME_MINIMUM_MS);
    expect(resolveCaptchaLifetimeMs(CAPTCHA_LIFETIME_MINIMUM_MS)).toBe(CAPTCHA_LIFETIME_MINIMUM_MS);
    expect(resolveCaptchaLifetimeMs(CAPTCHA_LIFETIME_DEFAULT_MS + 1_000)).toBe(CAPTCHA_LIFETIME_DEFAULT_MS + 1_000);

    let now = 0;
    const captcha = new ImageCaptchaService({ revealAnswer: true, lifetimeMs: 1_000, now: () => now });
    const challenge = captcha.create();
    now += CAPTCHA_LIFETIME_MINIMUM_MS - 1;
    expect(() => captcha.consume(challenge.captchaId, challenge.answer ?? "")).not.toThrow();

    const expired = captcha.create();
    now += CAPTCHA_LIFETIME_MINIMUM_MS;
    expect(() => captcha.consume(expired.captchaId, expired.answer ?? "")).toThrow(/已失效/u);
  });

  it("渲染为无答案文本节点的扭曲点阵字形", () => {
    const svg = renderCaptchaSvg("A2B3", Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(svg).toContain('filter id="glyph-roughen"');
    expect(svg).toContain('feDisplacementMap');
    expect(svg.match(/<path /gu)?.length).toBeGreaterThan(12);
    expect(svg).not.toContain(">A<");
    expect(svg).not.toContain(">2<");
    expect(svg).not.toContain(">B<");
    expect(svg).not.toContain(">3<");
    const untrusted = renderCaptchaSvg("<&>\"", Buffer.alloc(8));
    expect(untrusted).not.toContain("<&>\"");
  });

  it("同一字符的 glyph path 会随种子变化，避免离线查表解码", () => {
    const extractGlyphPaths = (svg: string): string[] => [...svg.matchAll(/\sd="([^"]+)"\s+transform=/gu)].map((match) => match[1] ?? "");
    const first = extractGlyphPaths(renderCaptchaSvg("AAAA", Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])));
    const second = extractGlyphPaths(renderCaptchaSvg("AAAA", Buffer.from([8, 7, 6, 5, 4, 3, 2, 1])));
    const repeated = extractGlyphPaths(renderCaptchaSvg("AAAA", Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])));
    expect(first).toHaveLength(4);
    expect(second).toHaveLength(4);
    expect(first).toEqual(repeated);
    expect(first[0]).not.toEqual(second[0]);
    expect(new Set(first).size).toBeGreaterThan(1);
    expect(first.every((path) => /\.\d{2}/u.test(path))).toBe(true);
  });
});
