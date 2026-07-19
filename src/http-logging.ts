import { randomUUID } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import { accountReference, logger as defaultLogger, type Logger } from "./logger.js";
import { runWithRequestContext } from "./request-context.js";

function maskClientAddress(value: string | undefined): string {
  if (!value) return "unknown";
  const ipv4 = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/u);
  if (ipv4) return `${ipv4[1]}.${ipv4[2]}.${ipv4[3]}.0/24`;
  if (value.includes(":")) return `${value.split(":").slice(0, 3).join(":")}::/48`;
  return "unknown";
}

export function sanitizeRequestPath(path: string): string {
  const segments = path.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    if ((segments[index] === "users" || segments[index] === "user-avatars") && segments[index + 1] && segments[index + 1] !== "directory") {
      segments[index + 1] = "[REDACTED]";
    }
    if (segments[index] === "members" && segments[index + 1]) segments[index + 1] = "[REDACTED]";
  }
  return segments.join("/").slice(0, 2_000);
}

function routePattern(request: Request): string | undefined {
  const route = request.route as { path?: unknown } | undefined;
  return typeof route?.path === "string" ? route.path : undefined;
}

function responseFields(request: Request, response: Response, startedAt: bigint): Record<string, unknown> {
  const contentLength = response.getHeader("content-length");
  return {
    method: request.method,
    path: sanitizeRequestPath(request.path),
    ...(routePattern(request) ? { route: routePattern(request) } : {}),
    status: response.statusCode,
    durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
    ...(contentLength === undefined ? {} : { responseBytes: Number(contentLength) || String(contentLength) }),
    ...(request.authMethod ? { authMethod: request.authMethod } : {}),
    ...(request.authUser ? { actorRef: accountReference(request.authUser.userId) } : {})
  };
}

export function createRequestLoggingMiddleware(log: Logger = defaultLogger): RequestHandler {
  return (request, response, next) => {
    const requestId = randomUUID();
    const startedAt = process.hrtime.bigint();
    let completed = false;
    response.setHeader("X-Request-Id", requestId);
    return runWithRequestContext({ requestId, actor: null }, () => {
      log.info("http.request.started", {
        method: request.method,
        path: sanitizeRequestPath(request.path),
        clientNetwork: maskClientAddress(request.ip || request.socket.remoteAddress),
        protocol: request.protocol,
        contentType: request.get("content-type") ?? null,
        contentLength: request.get("content-length") ?? null,
        userAgent: request.get("user-agent")?.slice(0, 500) ?? null
      });
      response.once("finish", () => {
        completed = true;
        const fields = responseFields(request, response, startedAt);
        if (response.statusCode >= 500) log.error("http.request.completed", fields);
        else if (response.statusCode >= 400) log.warn("http.request.completed", fields);
        else log.info("http.request.completed", fields);
      });
      response.once("close", () => {
        if (!completed) log.warn("http.request.aborted", responseFields(request, response, startedAt));
      });
      next();
    });
  };
}
