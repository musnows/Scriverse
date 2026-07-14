import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { AppError } from "./errors.js";

type CaptchaChallenge = {
  answerDigest: Buffer;
  expiresAt: number;
};

export type CaptchaChallengeResult = {
  captchaId: string;
  imageDataUrl: string;
  /** 仅测试环境可开启，生产不会返回 */
  answer?: string;
};

const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const captchaLength = 4;
const captchaLifetimeMs = 5 * 60_000;
const maximumChallenges = 5_000;

function digestAnswer(answer: string): Buffer {
  return createHash("sha256").update(answer.toLocaleUpperCase("en-US")).digest();
}

function randomCode(): string {
  const bytes = randomBytes(captchaLength);
  let code = "";
  for (let index = 0; index < captchaLength; index += 1) {
    code += alphabet[(bytes[index] ?? 0) % alphabet.length];
  }
  return code;
}

function escapeXml(value: string): string {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
}

/** 生成带噪点与轻微扭曲的 SVG 验证码图片（无需外部依赖）。 */
export function renderCaptchaSvg(code: string, seed = randomBytes(8)): string {
  const width = 148;
  const height = 48;
  const chars = [...code];
  const noise: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    const x1 = (seed[index % seed.length] ?? 0) % width;
    const y1 = (seed[(index + 1) % seed.length] ?? 0) % height;
    const x2 = (seed[(index + 2) % seed.length] ?? 0) % width;
    const y2 = (seed[(index + 3) % seed.length] ?? 0) % height;
    noise.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#9aa3ad" stroke-width="1" opacity="0.55"/>`);
  }
  for (let index = 0; index < 18; index += 1) {
    const cx = ((seed[index % seed.length] ?? 0) * (index + 3)) % width;
    const cy = ((seed[(index + 4) % seed.length] ?? 0) * (index + 5)) % height;
    noise.push(`<circle cx="${cx}" cy="${cy}" r="1.2" fill="#7d8792" opacity="0.45"/>`);
  }
  const glyphs = chars.map((char, index) => {
    const x = 22 + index * 32;
    const y = 32 + (((seed[index] ?? 0) % 7) - 3);
    const rotate = ((seed[(index + 2) % seed.length] ?? 0) % 21) - 10;
    return `<text x="${x}" y="${y}" transform="rotate(${rotate} ${x} ${y})" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="26" font-weight="700" fill="#1f2933">${escapeXml(char)}</text>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="验证码">
  <rect width="100%" height="100%" rx="6" fill="#eef1f4"/>
  ${noise.join("")}
  ${glyphs}
</svg>`;
}

export class ImageCaptchaService {
  private readonly challenges = new Map<string, CaptchaChallenge>();

  constructor(private readonly options: { revealAnswer?: boolean } = {}) {}

  create(): CaptchaChallengeResult {
    this.pruneExpired();
    if (this.challenges.size >= maximumChallenges) {
      throw new AppError(429, "CAPTCHA_BUSY", "验证码请求过多，请稍后重试");
    }
    const answer = randomCode();
    const captchaId = randomBytes(16).toString("base64url");
    const seed = randomBytes(8);
    const svg = renderCaptchaSvg(answer, seed);
    this.challenges.set(captchaId, {
      answerDigest: digestAnswer(answer),
      expiresAt: Date.now() + captchaLifetimeMs
    });
    return {
      captchaId,
      imageDataUrl: `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`,
      ...(this.options.revealAnswer ? { answer } : {})
    };
  }

  /** 校验并消费验证码；成功或失败都会使该挑战失效。 */
  consume(captchaId: string, answer: string): void {
    const challenge = this.challenges.get(captchaId);
    this.challenges.delete(captchaId);
    if (!challenge || challenge.expiresAt <= Date.now()) {
      throw new AppError(400, "CAPTCHA_INVALID", "验证码已失效，请刷新后重试");
    }
    const provided = digestAnswer(answer.trim());
    if (provided.length !== challenge.answerDigest.length || !timingSafeEqual(provided, challenge.answerDigest)) {
      throw new AppError(400, "CAPTCHA_INVALID", "验证码不正确");
    }
  }

  private pruneExpired(): void {
    const currentTime = Date.now();
    for (const [captchaId, challenge] of this.challenges) {
      if (challenge.expiresAt <= currentTime) this.challenges.delete(captchaId);
    }
  }
}
