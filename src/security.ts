import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import { AppError } from "./errors.js";

export type BasicAuthOptions = {
  username: string;
  password: string;
  realm?: string;
  failureLimit?: number;
  failureWindowMs?: number;
};

export type RuntimeSecurityOptions = {
  auth?: BasicAuthOptions;
  trustProxy?: boolean | number;
  apiRateLimit?: number;
  apiRateWindowMs?: number;
  enforceSameOrigin?: boolean;
  allowPrivateAiEndpoints?: boolean;
};

type RateEntry = { count: number; resetAt: number };

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();
const constantTimeEqual = (left: string, right: string): boolean => timingSafeEqual(digest(left), digest(right));

function requestKey(request: Request): string {
  return request.ip || request.socket.remoteAddress || "unknown";
}

function consumeRate(entries: Map<string, RateEntry>, key: string, limit: number, windowMs: number): { allowed: boolean; retryAfter: number } {
  const currentTime = Date.now();
  const existing = entries.get(key);
  const entry = !existing || existing.resetAt <= currentTime ? { count: 0, resetAt: currentTime + windowMs } : existing;
  entry.count += 1;
  entries.set(key, entry);
  if (entries.size > 10_000) {
    for (const [candidate, value] of entries) if (value.resetAt <= currentTime) entries.delete(candidate);
  }
  return { allowed: entry.count <= limit, retryAfter: Math.max(1, Math.ceil((entry.resetAt - currentTime) / 1000)) };
}

function unauthorized(response: Response, realm: string): void {
  response.setHeader("WWW-Authenticate", `Basic realm="${realm.replace(/["\\]/gu, "")}", charset="UTF-8"`);
  response.setHeader("Cache-Control", "no-store");
  response.status(401).json({ error: { code: "AUTH_REQUIRED", message: "需要管理员身份验证" } });
}

function parseBasicCredentials(header: string | undefined): { username: string; password: string } | null {
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return null;
    return { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
  } catch {
    return null;
  }
}

export function createBasicAuthMiddleware(options: BasicAuthOptions): RequestHandler {
  const realm = options.realm ?? "Scriverse";
  const failureLimit = options.failureLimit ?? 10;
  const failureWindowMs = options.failureWindowMs ?? 15 * 60_000;
  const failures = new Map<string, RateEntry>();
  return (request, response, next) => {
    if (request.path === "/api/health") return next();
    const key = requestKey(request);
    const credentials = parseBasicCredentials(request.get("authorization"));
    const valid = credentials
      && constantTimeEqual(credentials.username, options.username)
      && constantTimeEqual(credentials.password, options.password);
    if (valid) {
      failures.delete(key);
      return next();
    }
    const rate = consumeRate(failures, key, failureLimit, failureWindowMs);
    if (!rate.allowed) {
      response.setHeader("Retry-After", String(rate.retryAfter));
      response.status(429).json({ error: { code: "AUTH_RATE_LIMITED", message: "身份验证失败次数过多，请稍后重试" } });
      return;
    }
    unauthorized(response, realm);
  };
}

export function createSecurityHeadersMiddleware(): RequestHandler {
  return (request, response, next) => {
    response.setHeader("Content-Security-Policy", "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: blob: https:; manifest-src 'self'; media-src 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'none'");
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    response.setHeader("Referrer-Policy", "same-origin");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("X-Permitted-Cross-Domain-Policies", "none");
    response.setHeader("Cache-Control", request.path.startsWith("/api/") ? "no-store" : "private, no-cache");
    response.vary("Authorization");
    if (request.secure) response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    next();
  };
}

export function createSameOriginMiddleware(): RequestHandler {
  return (request, response, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return next();
    if (request.get("sec-fetch-site") === "cross-site") {
      response.status(403).json({ error: { code: "CROSS_ORIGIN_WRITE_BLOCKED", message: "已拒绝跨站写请求" } });
      return;
    }
    const origin = request.get("origin");
    if (!origin) return next();
    const host = request.get("host");
    let expectedOrigin = "";
    try {
      expectedOrigin = new URL(`${request.protocol}://${host}`).origin;
    } catch {
      response.status(400).json({ error: { code: "INVALID_HOST", message: "请求主机信息无效" } });
      return;
    }
    if (origin !== expectedOrigin) {
      response.status(403).json({ error: { code: "CROSS_ORIGIN_WRITE_BLOCKED", message: "已拒绝跨站写请求" } });
      return;
    }
    next();
  };
}

export function createApiRateLimitMiddleware(limit = 600, windowMs = 60_000): RequestHandler {
  const entries = new Map<string, RateEntry>();
  return (request, response, next) => {
    if (!request.path.startsWith("/api/") || request.path === "/api/health") return next();
    const rate = consumeRate(entries, requestKey(request), limit, windowMs);
    if (rate.allowed) return next();
    response.setHeader("Retry-After", String(rate.retryAfter));
    response.status(429).json({ error: { code: "API_RATE_LIMITED", message: "请求过于频繁，请稍后重试" } });
  };
}

function parseIpv4(address: string): number[] | null {
  if (isIP(address) !== 4) return null;
  return address.split(".").map(Number);
}

function unsafeIpKind(address: string): "private" | "blocked" | null {
  const ipv4 = parseIpv4(address);
  if (ipv4) {
    const a = ipv4[0] ?? -1;
    const b = ipv4[1] ?? -1;
    if (a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "private";
    if (a === 0 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || a >= 224) return "blocked";
    return null;
  }
  const normalized = address.toLocaleLowerCase();
  if (normalized === "::1" || normalized.startsWith("fc") || normalized.startsWith("fd")) return "private";
  if (normalized === "::" || normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("ff")) return "blocked";
  if (normalized.startsWith("::ffff:")) return unsafeIpKind(normalized.slice(7));
  return null;
}

export async function assertSafeAiEndpoint(value: string, allowPrivateNetwork = false): Promise<void> {
  const endpoint = new URL(value);
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
    throw new AppError(400, "UNSAFE_PROVIDER_ENDPOINT", "AI 供应商地址必须是无内嵌凭据的 HTTP 或 HTTPS 地址");
  }
  const addresses = isIP(endpoint.hostname)
    ? [{ address: endpoint.hostname }]
    : await lookup(endpoint.hostname, { all: true, verbatim: true }).catch(() => []);
  if (!addresses.length) throw new AppError(400, "UNSAFE_PROVIDER_ENDPOINT", "AI 供应商域名无法解析");
  for (const { address } of addresses) {
    const kind = unsafeIpKind(address);
    if (kind === "blocked" || (kind === "private" && !allowPrivateNetwork)) {
      throw new AppError(400, "UNSAFE_PROVIDER_ENDPOINT", "AI 供应商地址指向受保护的本机、内网或链路本地网络");
    }
  }
}

export function resolveRuntimeSecurity(environment: NodeJS.ProcessEnv, requireAuthentication = environment.NODE_ENV === "production"): RuntimeSecurityOptions {
  const production = environment.NODE_ENV === "production";
  const username = environment.APP_AUTH_USERNAME?.trim() ?? "";
  const password = environment.APP_AUTH_PASSWORD ?? "";
  if (Boolean(username) !== Boolean(password)) throw new Error("APP_AUTH_USERNAME 与 APP_AUTH_PASSWORD 必须同时配置");
  if (requireAuthentication && (!username || !password)) throw new Error("生产环境或非本机监听必须配置 APP_AUTH_USERNAME 与 APP_AUTH_PASSWORD");
  if (password && password.length < 12) throw new Error("APP_AUTH_PASSWORD 至少需要 12 个字符");
  const trustProxyValue = environment.APP_TRUST_PROXY?.trim() ?? "";
  const trustProxy = trustProxyValue === "true" ? true : /^\d+$/u.test(trustProxyValue) ? Number(trustProxyValue) : false;
  if (typeof trustProxy === "number" && (trustProxy < 0 || trustProxy > 10)) throw new Error("APP_TRUST_PROXY 只能是 true 或 0-10 的整数");
  return {
    ...(username ? { auth: { username, password } } : {}),
    trustProxy,
    enforceSameOrigin: true,
    allowPrivateAiEndpoints: environment.APP_ALLOW_PRIVATE_AI_ENDPOINTS === "true" || !production
  };
}
