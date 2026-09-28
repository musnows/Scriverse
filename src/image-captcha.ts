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
/** 默认有效期 300 秒。任何配置或调用若短于下限，都会被抬到 180 秒。 */
export const CAPTCHA_LIFETIME_DEFAULT_MS = 300_000;
export const CAPTCHA_LIFETIME_MINIMUM_MS = 180_000;
const maximumChallenges = 5_000;

/** 把请求的有效期抬到下限；未提供或非法时使用默认 300 秒。 */
export function resolveCaptchaLifetimeMs(requestedMs?: number): number {
  if (typeof requestedMs !== "number" || !Number.isFinite(requestedMs)) return CAPTCHA_LIFETIME_DEFAULT_MS;
  return Math.max(CAPTCHA_LIFETIME_MINIMUM_MS, Math.trunc(requestedMs));
}

/**
 * 5×7 点阵字形会被渲染为 path，而不是 SVG text：这样不会把答案以可直接读取的
 * 文本节点放进 data URL。它不是对抗专业视觉模型的单独安全边界，但能阻止最基础的
 * 文本提取，并与干扰元素共同提高 OCR 的成本。
 */
const glyphPatterns: Record<string, readonly string[]> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01111", "10000", "10000", "10111", "10001", "10001", "01110"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  J: ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"]
};
const fallbackGlyph = ["11111", "00001", "00010", "00100", "00100", "00000", "00100"];

/**
 * 全角字母和数字与半角外观相同，但直接比较会失败。
 * 先做 NFKC，再去掉空白和格式字符（含零宽空格），最后按 en-US 大写。
 */
export function normalizeCaptchaAnswer(answer: string): string {
  return answer.normalize("NFKC").replace(/[\p{Cf}\p{Z}\s]+/gu, "").toLocaleUpperCase("en-US");
}

function digestAnswer(answer: string): Buffer {
  return createHash("sha256").update(normalizeCaptchaAnswer(answer)).digest();
}

function randomCode(): string {
  const bytes = randomBytes(captchaLength);
  let code = "";
  for (let index = 0; index < captchaLength; index += 1) {
    code += alphabet[(bytes[index] ?? 0) % alphabet.length];
  }
  return code;
}

function seededRandom(seed: Buffer): () => number {
  let state = 0x9e3779b9;
  for (const byte of seed) state = Math.imul(state ^ byte, 0x45d9f3b) >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function glyphPath(pattern: readonly string[], cellSize: number, random: () => number): string {
  return pattern.flatMap((row, rowIndex) => [...row].flatMap((pixel, columnIndex) => {
    if (pixel !== "1") return [];
    // 把种子派生的扰动直接写入 path 坐标，避免仅依赖浏览器端滤镜、导致同一字符 path 恒定可查表。
    const x = columnIndex * cellSize + randomBetween(random, -0.65, 0.65);
    const y = rowIndex * cellSize + randomBetween(random, -0.65, 0.65);
    const width = cellSize + randomBetween(random, -0.4, 0.4);
    const height = cellSize + randomBetween(random, -0.4, 0.4);
    return `M${x.toFixed(2)} ${y.toFixed(2)}h${width.toFixed(2)}v${height.toFixed(2)}h-${width.toFixed(2)}Z`;
  })).join("");
}

function randomBetween(random: () => number, minimum: number, maximum: number): number {
  return minimum + random() * (maximum - minimum);
}

/** 生成带有点阵字形、扭曲、噪点与交叉曲线的 SVG 验证码图片（无需外部依赖）。 */
export function renderCaptchaSvg(code: string, seed = randomBytes(8)): string {
  const width = 148;
  const height = 48;
  const chars = [...code];
  const random = seededRandom(seed);
  const backgroundNoise: string[] = [];
  const foregroundNoise: string[] = [];
  for (let index = 0; index < 42; index += 1) {
    const cx = randomBetween(random, 2, width - 2).toFixed(1);
    const cy = randomBetween(random, 2, height - 2).toFixed(1);
    const radius = randomBetween(random, 0.45, 1.35).toFixed(1);
    backgroundNoise.push(`<circle cx="${cx}" cy="${cy}" r="${radius}" fill="#6b7c93" opacity="${randomBetween(random, 0.2, 0.42).toFixed(2)}"/>`);
  }
  for (let index = 0; index < 13; index += 1) {
    const x = randomBetween(random, 3, width - 13).toFixed(1);
    const y = randomBetween(random, 3, height - 3).toFixed(1);
    const length = randomBetween(random, 5, 14).toFixed(1);
    const angle = randomBetween(random, -1.1, 1.1);
    const x2 = (Number(x) + Math.cos(angle) * Number(length)).toFixed(1);
    const y2 = (Number(y) + Math.sin(angle) * Number(length)).toFixed(1);
    backgroundNoise.push(`<path d="M${x} ${y}L${x2} ${y2}" stroke="#8291a5" stroke-width="${randomBetween(random, 0.5, 1.1).toFixed(1)}" opacity="${randomBetween(random, 0.18, 0.34).toFixed(2)}" stroke-linecap="round"/>`);
  }
  const glyphs = chars.map((char, index) => {
    const x = 10 + index * 34 + randomBetween(random, -2, 2);
    const y = 6 + randomBetween(random, -2, 2);
    const rotate = randomBetween(random, -11, 11);
    const skew = randomBetween(random, -8, 8);
    const color = ["#132d4b", "#1e3a5f", "#243f64", "#173451"][index % 4];
    const pattern = glyphPatterns[char] ?? fallbackGlyph;
    return `<path d="${glyphPath(pattern, 4.9, random)}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${rotate.toFixed(1)} 12.3 17.2) skewX(${skew.toFixed(1)})" fill="${color}" filter="url(#glyph-roughen)"/>`;
  }).join("");
  for (let index = 0; index < 3; index += 1) {
    const startY = randomBetween(random, 8, height - 8).toFixed(1);
    const controlY = randomBetween(random, 0, height).toFixed(1);
    const endY = randomBetween(random, 8, height - 8).toFixed(1);
    foregroundNoise.push(`<path d="M-6 ${startY} Q${(width * 0.34).toFixed(1)} ${controlY} ${(width * 0.68).toFixed(1)} ${randomBetween(random, 0, height).toFixed(1)} T${width + 6} ${endY}" fill="none" stroke="#55718f" stroke-width="${randomBetween(random, 0.8, 1.35).toFixed(1)}" opacity="${randomBetween(random, 0.42, 0.6).toFixed(2)}" stroke-linecap="round"/>`);
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="验证码">
  <defs>
    <linearGradient id="captcha-background" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#f3f7fb"/><stop offset="1" stop-color="#dbe7f4"/></linearGradient>
    <filter id="glyph-roughen" x="-12%" y="-12%" width="124%" height="124%"><feTurbulence type="fractalNoise" baseFrequency="0.012 0.09" numOctaves="1" seed="${Math.floor(random() * 10_000)}" result="texture"/><feDisplacementMap in="SourceGraphic" in2="texture" scale="0.7" xChannelSelector="R" yChannelSelector="G"/></filter>
  </defs>
  <rect width="100%" height="100%" rx="6" fill="url(#captcha-background)"/>
  ${backgroundNoise.join("")}
  ${glyphs}
  ${foregroundNoise.join("")}
</svg>`;
}

export class ImageCaptchaService {
  private readonly challenges = new Map<string, CaptchaChallenge>();
  private readonly lifetimeMs: number;

  constructor(private readonly options: {
    revealAnswer?: boolean;
    /** 请求的有效期（毫秒）。短于 180 秒时抬到 180 秒；缺省 300 秒。 */
    lifetimeMs?: number;
    now?: () => number;
  } = {}) {
    this.lifetimeMs = resolveCaptchaLifetimeMs(options.lifetimeMs);
  }

  private currentTime(): number {
    return this.options.now?.() ?? Date.now();
  }

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
      expiresAt: this.currentTime() + this.lifetimeMs
    });
    return {
      captchaId,
      imageDataUrl: `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`,
      ...(this.options.revealAnswer ? { answer } : {})
    };
  }

  /** 校验并消费验证码；成功或失败都会使该挑战失效。 */
  consume(captchaId: string, answer: string): void {
    const currentTime = this.currentTime();
    const challenge = this.challenges.get(captchaId);
    this.challenges.delete(captchaId);
    if (!challenge || challenge.expiresAt <= currentTime) {
      throw new AppError(400, "CAPTCHA_INVALID", "验证码已失效，请刷新后重试");
    }
    const provided = digestAnswer(answer);
    if (provided.length !== challenge.answerDigest.length || !timingSafeEqual(provided, challenge.answerDigest)) {
      throw new AppError(400, "CAPTCHA_INVALID", "验证码不正确");
    }
  }

  private pruneExpired(): void {
    const currentTime = this.currentTime();
    for (const [captchaId, challenge] of this.challenges) {
      if (challenge.expiresAt <= currentTime) this.challenges.delete(captchaId);
    }
  }
}
