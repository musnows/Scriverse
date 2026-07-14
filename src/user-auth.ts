import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import { Database, PLATFORM_AI_WORK_ID, type Row } from "./database.js";
import { AppError, notFound } from "./errors.js";
import { runWithRequestActor, type RequestActor } from "./request-context.js";

export type AuthUser = RequestActor & {
  status: "active" | "disabled";
  createdAt: string;
};

export type AuthSession = {
  id: string;
  user: AuthUser;
  csrfToken: string;
};

declare global {
  namespace Express {
    interface Request {
      authSession?: AuthSession;
      authUser?: AuthUser;
    }
  }
}

const sessionCookieName = "scriverse_session";
const sessionLifetimeMs = 30 * 24 * 60 * 60_000;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeUsername(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
}

function parseCookies(header: string | undefined): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of header?.split(";") ?? []) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    try {
      result.set(name, decodeURIComponent(part.slice(separator + 1).trim()));
    } catch {
      // 无效 Cookie 不参与身份验证。
    }
  }
  return result;
}

function mapUser(row: Row): AuthUser {
  return {
    userId: String(row.id),
    username: String(row.username),
    displayName: String(row.display_name),
    role: String(row.role) === "admin" ? "admin" : "user",
    status: String(row.status) === "disabled" ? "disabled" : "active",
    createdAt: String(row.created_at)
  };
}

function passwordDigest(password: string, salt: string): string {
  return scryptSync(password, salt, 64, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }).toString("base64");
}

function workIdFromPath(database: Database, pathname: string): string | null {
  const decoded = pathname.split("/").map((part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
  if (decoded[1] !== "api") return null;
  if (decoded[2] === "works" && decoded[3] && decoded[3] !== "import") return decoded[3];
  const tableByResource: Record<string, string> = {
    volumes: "volumes",
    chapters: "chapters",
    settings: "settings",
    characters: "characters",
    races: "races",
    organizations: "organizations",
    "timeline-tracks": "timeline_tracks",
    timeline: "timeline_events",
    relationships: "relationships",
    foreshadows: "foreshadows",
    reviews: "review_items",
    tasks: "analysis_tasks",
    "ai-conversations": "ai_conversations",
    suggestions: "ai_suggestions"
  };
  const table = tableByResource[decoded[2] ?? ""];
  if (table && decoded[3]) {
    const row = database.get<{ work_id: string }>(`SELECT work_id FROM ${table} WHERE id = ?`, decoded[3]);
    if (row) return row.work_id;
    if (table === "chapters") {
      const version = database.get<{ work_id: string }>(
        "SELECT work_id FROM chapter_versions WHERE chapter_id = ? LIMIT 1",
        decoded[3]
      );
      if (version) return version.work_id;
    }
    if (table === "characters") {
      const version = database.get<{ work_id: string }>(
        "SELECT work_id FROM character_versions WHERE character_id = ? LIMIT 1",
        decoded[3]
      );
      if (version) return version.work_id;
    }
    throw notFound("记录");
  }
  if (decoded[2] === "foreshadow-occurrences" && decoded[3]) {
    const row = database.get<{ work_id: string }>(
      `SELECT foreshadow.work_id FROM foreshadow_occurrences occurrence
       JOIN foreshadows foreshadow ON foreshadow.id = occurrence.foreshadow_id WHERE occurrence.id = ?`,
      decoded[3]
    );
    if (!row) throw notFound("伏笔出现点");
    return row.work_id;
  }
  if (decoded[2] === "entity-versions" && decoded[3] && decoded[4]) {
    const row = database.get<{ work_id: string }>(
      "SELECT work_id FROM entity_versions WHERE entity_type = ? AND entity_id = ? LIMIT 1",
      decoded[3],
      decoded[4]
    );
    if (!row) throw notFound("版本记录");
    return row.work_id;
  }
  return null;
}

export class UserAuthService {
  constructor(private readonly database: Database) {}

  resolveWorkId(pathname: string): string | null {
    return workIdFromPath(this.database, pathname);
  }

  hasUsers(): boolean {
    return Number(this.database.get("SELECT COUNT(*) AS count FROM users")?.count ?? 0) > 0;
  }

  private createSession(userId: string): { token: string; session: AuthSession } {
    const token = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(24).toString("base64url");
    const sessionId = randomUUID();
    const timestamp = new Date();
    this.database.run(
      `INSERT INTO user_sessions (id, user_id, token_hash, csrf_token, created_at, expires_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      sessionId,
      userId,
      sha256(token),
      csrfToken,
      timestamp.toISOString(),
      new Date(timestamp.getTime() + sessionLifetimeMs).toISOString(),
      timestamp.toISOString()
    );
    const user = this.getUser(userId);
    return { token, session: { id: sessionId, user, csrfToken } };
  }

  register(input: { username: string; displayName: string; password: string }): { token: string; session: AuthSession } {
    const normalizedUsername = normalizeUsername(input.username);
    const timestamp = new Date().toISOString();
    const userId = randomUUID();
    const salt = randomBytes(16).toString("base64url");
    return this.database.transaction(() => {
      const role = Number(this.database.get("SELECT COUNT(*) AS count FROM users")?.count ?? 0) === 0 ? "admin" : "user";
      this.database.run(
        `INSERT INTO users (id, username, normalized_username, display_name, password_hash, password_salt, role, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        userId,
        input.username.trim(),
        normalizedUsername,
        input.displayName.trim(),
        passwordDigest(input.password, salt),
        salt,
        role,
        timestamp,
        timestamp
      );
      if (role === "admin") {
        this.database.run("UPDATE works SET owner_user_id = ? WHERE owner_user_id IS NULL AND id <> ?", userId, PLATFORM_AI_WORK_ID);
        this.database.run(
          `INSERT OR IGNORE INTO work_memberships (work_id, user_id, role, invited_by_user_id, created_at)
           SELECT id, ?, 'owner', ?, ? FROM works WHERE owner_user_id = ? AND id <> ?`,
          userId,
          userId,
          timestamp,
          userId,
          PLATFORM_AI_WORK_ID
        );
      }
      return this.createSession(userId);
    });
  }

  login(username: string, password: string): { token: string; session: AuthSession } {
    const row = this.database.get(
      "SELECT * FROM users WHERE normalized_username = ?",
      normalizeUsername(username)
    );
    const fallbackSalt = "invalid-login-salt";
    const calculated = passwordDigest(password, String(row?.password_salt ?? fallbackSalt));
    const valid = row && safeEqual(calculated, String(row.password_hash));
    if (!valid) throw new AppError(401, "INVALID_CREDENTIALS", "用户名或密码不正确");
    const user = mapUser(row);
    if (user.status !== "active") throw new AppError(403, "ACCOUNT_DISABLED", "该账户已被停用");
    this.database.run("UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?", new Date().toISOString(), new Date().toISOString(), user.userId);
    return this.createSession(user.userId);
  }

  authenticate(request: Request): AuthSession | null {
    const token = parseCookies(request.get("cookie")).get(sessionCookieName);
    if (!token) return null;
    const row = this.database.get(
      `SELECT session.id AS session_id, session.csrf_token, session.expires_at, session.revoked_at,
       user.* FROM user_sessions session JOIN users user ON user.id = session.user_id WHERE session.token_hash = ?`,
      sha256(token)
    );
    if (!row || row.revoked_at || String(row.expires_at) <= new Date().toISOString()) return null;
    const user = mapUser(row);
    if (user.status !== "active") return null;
    this.database.run("UPDATE user_sessions SET last_seen_at = ? WHERE id = ?", new Date().toISOString(), String(row.session_id));
    return { id: String(row.session_id), csrfToken: String(row.csrf_token), user };
  }

  revoke(sessionId: string): void {
    this.database.run("UPDATE user_sessions SET revoked_at = ? WHERE id = ?", new Date().toISOString(), sessionId);
  }

  getUser(userId: string): AuthUser {
    const row = this.database.get("SELECT * FROM users WHERE id = ?", userId);
    if (!row) throw notFound("用户");
    return mapUser(row);
  }

  listUsers(): AuthUser[] {
    return this.database.all("SELECT * FROM users ORDER BY created_at, username").map(mapUser);
  }

  directory(query: string): Pick<AuthUser, "userId" | "username" | "displayName">[] {
    const escapedQuery = query.trim().slice(0, 100).replace(/[\\%_]/gu, (character) => `\\${character}`);
    const pattern = `%${escapedQuery}%`;
    return this.database.all(
      `SELECT * FROM users WHERE status = 'active' AND (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')
       ORDER BY username LIMIT 50`,
      pattern,
      pattern
    ).map((row) => {
      const user = mapUser(row);
      return { userId: user.userId, username: user.username, displayName: user.displayName };
    });
  }

  updateUser(actor: AuthUser, userId: string, input: { role?: "admin" | "user"; status?: "active" | "disabled" }): AuthUser {
    const current = this.getUser(userId);
    const nextRole = input.role ?? current.role;
    const nextStatus = input.status ?? current.status;
    if (actor.userId === userId && (nextRole !== "admin" || nextStatus !== "active")) {
      throw new AppError(409, "CANNOT_DISABLE_SELF", "不能停用自己或移除自己的管理员身份");
    }
    if (current.role === "admin" && current.status === "active" && (nextRole !== "admin" || nextStatus !== "active")) {
      const activeAdmins = Number(this.database.get("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND status = 'active'")?.count ?? 0);
      if (activeAdmins <= 1) throw new AppError(409, "LAST_ADMIN_REQUIRED", "系统至少需要保留一名可用管理员");
    }
    this.database.run("UPDATE users SET role = ?, status = ?, updated_at = ? WHERE id = ?", nextRole, nextStatus, new Date().toISOString(), userId);
    if (nextStatus === "disabled") this.database.run("UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", new Date().toISOString(), userId);
    return this.getUser(userId);
  }

  updateProfile(userId: string, displayName: string): AuthUser {
    this.database.run("UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?", displayName.trim(), new Date().toISOString(), userId);
    return this.getUser(userId);
  }

  changePassword(userId: string, sessionId: string, currentPassword: string, newPassword: string): void {
    const row = this.database.get("SELECT * FROM users WHERE id = ?", userId);
    if (!row) throw notFound("用户");
    const calculated = passwordDigest(currentPassword, String(row.password_salt));
    if (!safeEqual(calculated, String(row.password_hash))) throw new AppError(401, "INVALID_CURRENT_PASSWORD", "当前密码不正确");
    const salt = randomBytes(16).toString("base64url");
    const timestamp = new Date().toISOString();
    this.database.transaction(() => {
      this.database.run("UPDATE users SET password_hash = ?, password_salt = ?, updated_at = ? WHERE id = ?", passwordDigest(newPassword, salt), salt, timestamp, userId);
      this.database.run("UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL", timestamp, userId, sessionId);
    });
  }

  listMembers(workId: string): Record<string, unknown>[] {
    return this.database.all(
      `SELECT membership.role, membership.created_at, user.id, user.username, user.display_name, user.status
       FROM work_memberships membership JOIN users user ON user.id = membership.user_id
       WHERE membership.work_id = ? ORDER BY CASE membership.role WHEN 'owner' THEN 0 ELSE 1 END, user.username`,
      workId
    ).map((row) => ({
      userId: String(row.id), username: String(row.username), displayName: String(row.display_name),
      role: String(row.role), status: String(row.status), createdAt: String(row.created_at)
    }));
  }

  addMember(workId: string, userId: string, invitedByUserId: string): Record<string, unknown>[] {
    const user = this.getUser(userId);
    if (user.status !== "active") throw new AppError(409, "USER_DISABLED", "不能邀请已停用用户");
    this.database.run(
      `INSERT INTO work_memberships (work_id, user_id, role, invited_by_user_id, created_at)
       VALUES (?, ?, 'editor', ?, ?) ON CONFLICT(work_id, user_id) DO UPDATE SET role = 'editor', invited_by_user_id = excluded.invited_by_user_id`,
      workId,
      userId,
      invitedByUserId,
      new Date().toISOString()
    );
    return this.listMembers(workId);
  }

  removeMember(workId: string, userId: string): Record<string, unknown>[] {
    const work = this.database.get("SELECT owner_user_id FROM works WHERE id = ?", workId);
    if (!work) throw notFound("作品");
    if (String(work.owner_user_id ?? "") === userId) throw new AppError(409, "OWNER_REQUIRED", "不能移除作品创建者");
    this.database.run("DELETE FROM work_memberships WHERE work_id = ? AND user_id = ?", workId, userId);
    return this.listMembers(workId);
  }

  workRole(user: AuthUser, workId: string): "admin" | "owner" | "editor" | null {
    if (user.role === "admin") return "admin";
    const work = this.database.get("SELECT owner_user_id FROM works WHERE id = ?", workId);
    if (!work) throw notFound("作品");
    if (String(work.owner_user_id ?? "") === user.userId) return "owner";
    const membership = this.database.get("SELECT role FROM work_memberships WHERE work_id = ? AND user_id = ?", workId, user.userId);
    return String(membership?.role ?? "") === "editor" ? "editor" : null;
  }

  assertWorkAccess(user: AuthUser, workId: string, write = false, ownerOnly = false): void {
    if (workId === PLATFORM_AI_WORK_ID && user.role !== "admin") throw new AppError(403, "ADMIN_REQUIRED", "该操作仅限系统管理员");
    const role = this.workRole(user, workId);
    if (!role) throw new AppError(403, "WORK_ACCESS_DENIED", "你没有访问这部作品的权限");
    if (ownerOnly && role !== "admin" && role !== "owner") throw new AppError(403, "WORK_OWNER_REQUIRED", "该操作仅限作品创建者或系统管理员");
    if (write && !["admin", "owner", "editor"].includes(role)) throw new AppError(403, "WORK_EDIT_DENIED", "你没有编辑这部作品的权限");
  }
}

export function setSessionCookie(response: Response, token: string, secure: boolean): void {
  response.cookie(sessionCookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    secure,
    path: "/",
    maxAge: sessionLifetimeMs
  });
}

export function clearSessionCookie(response: Response, secure: boolean): void {
  response.clearCookie(sessionCookieName, { httpOnly: true, sameSite: "lax", secure, path: "/" });
}

export function createUserSessionMiddleware(auth: UserAuthService, disabled = false): RequestHandler {
  return (request, response, next) => {
    if (disabled) return runWithRequestActor(null, next);
    const session = auth.authenticate(request);
    if (session) {
      request.authSession = session;
      request.authUser = session.user;
    }
    const isPublic = request.path === "/api/health"
      || request.path === "/api/auth/session"
      || (request.path === "/api/auth/register" && request.method === "POST")
      || (request.path === "/api/auth/login" && request.method === "POST")
      || !request.path.startsWith("/api/");
    if (!session && !isPublic) {
      response.status(401).json({ error: { code: "AUTH_REQUIRED", message: "请先登录" } });
      return;
    }
    if (session && !["GET", "HEAD", "OPTIONS"].includes(request.method) && request.path !== "/api/auth/login" && request.path !== "/api/auth/register") {
      const csrf = request.get("x-csrf-token") ?? "";
      if (!safeEqual(csrf, session.csrfToken)) {
        response.status(403).json({ error: { code: "CSRF_TOKEN_INVALID", message: "请求校验失败，请刷新页面后重试" } });
        return;
      }
    }
    return runWithRequestActor(session?.user ?? null, next);
  };
}

export function createWorkAuthorizationMiddleware(auth: UserAuthService, disabled = false): RequestHandler {
  return (request, _response, next) => {
    if (disabled || !request.path.startsWith("/api/") || request.path.startsWith("/api/auth/") || request.path === "/api/health") return next();
    const user = request.authUser;
    if (!user) throw new AppError(401, "AUTH_REQUIRED", "请先登录");
    if (request.path.startsWith("/api/platform/") || request.path.startsWith("/api/providers/") || request.path.startsWith("/api/models/")) {
      if (user.role !== "admin") throw new AppError(403, "ADMIN_REQUIRED", "该操作仅限系统管理员");
      return next();
    }
    if (/^\/api\/works\/[^/]+\/providers/u.test(request.path)) {
      if (user.role !== "admin") throw new AppError(403, "ADMIN_REQUIRED", "该操作仅限系统管理员");
      return next();
    }
    if (request.path.startsWith("/api/users") && !request.path.startsWith("/api/users/directory")) {
      if (user.role !== "admin") throw new AppError(403, "ADMIN_REQUIRED", "该操作仅限系统管理员");
      return next();
    }
    const workId = auth.resolveWorkId(request.path);
    if (!workId) return next();
    const write = !["GET", "HEAD", "OPTIONS"].includes(request.method);
    const ownerOnly = write && (
      /^\/api\/works\/[^/]+$/u.test(request.path)
      || /^\/api\/works\/[^/]+\/cover$/u.test(request.path)
      || /^\/api\/works\/[^/]+\/members(?:\/[^/]+)?$/u.test(request.path)
    );
    auth.assertWorkAccess(user, workId, write, ownerOnly);
    next();
  };
}
