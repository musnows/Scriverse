import express, { type Express, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import mammoth from "mammoth";
import { extname, join } from "node:path";
import { readFileSync } from "node:fs";
import { z, ZodError } from "zod";
import { AiManager } from "./ai.js";
import { CredentialVault } from "./credential-vault.js";
import { Database } from "./database.js";
import { assertSafeDocxArchive } from "./docx-security.js";
import { TASK_TYPES, type ContextScope, type TaskType } from "./domain.js";
import { AppError } from "./errors.js";
import { applyImportFileHints, parseNovelText } from "./parser.js";
import { Store, versionedEntityTypes } from "./store.js";
import { normalizeUploadFileName } from "./utils.js";
import { assertSafeAiEndpoint, createApiRateLimitMiddleware, createAuthenticationRateLimitMiddleware, createBasicAuthMiddleware, createSameOriginMiddleware, createSecurityHeadersMiddleware, type RuntimeSecurityOptions } from "./security.js";
import { ImageCaptchaService } from "./image-captcha.js";
import { assertSafeImportedPlainText, decodeUtf8ImportedText } from "./import-security.js";
import { InvalidRasterImageError, readRasterImageMetadata } from "./image-metadata.js";
import { createRequestLoggingMiddleware, sanitizeRequestPath } from "./http-logging.js";
import { accountReference, logger, sanitizeError } from "./logger.js";
import { runWithRequestActor } from "./request-context.js";
import { APP_VERSION } from "./version.js";
import {
  clearSessionCookie,
  createCliApiScopeMiddleware,
  createUserSessionMiddleware,
  createWorkAuthorizationMiddleware,
  setSessionCookie,
  UserAuthService
} from "./user-auth.js";

const nonEmpty = z.string().trim().min(1);
const identifier = z.string().trim().min(1).max(200);
const optionalStrings = z.array(z.string()).optional();
const jsonObject = z.record(z.string(), z.unknown());
const chapterTypeSchema = z.enum(["正文", "设定", "作者的话", "其他"]);
const versionedEntityTypeSchema = z.enum(versionedEntityTypes);
const maximumImportedTextLength = 20_000_000;

const captchaFields = {
  captchaId: z.string().trim().min(1).max(200),
  captchaAnswer: z.string().trim().min(1).max(16)
};
const usernameSchema = z.string().trim().min(3).max(40).regex(/^[\p{L}\p{N}_.-]+$/u, "用户名只能包含文字、数字、点、下划线和短横线");
const passwordSchema = z.string().min(10).max(200);
const registrationSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  passwordConfirmation: passwordSchema,
  ...captchaFields
}).strict().refine((input) => input.password === input.passwordConfirmation, {
  path: ["passwordConfirmation"],
  message: "两次输入的密码不一致"
});
const loginSchema = z.object({
  username: z.string().trim().min(1).max(100),
  password: z.string().max(200),
  ...captchaFields
}).strict();
const userUpdateSchema = z.object({ role: z.enum(["admin", "user"]).optional(), status: z.enum(["active", "disabled"]).optional() }).strict();
const memberSchema = z.object({ userId: identifier, role: z.enum(["editor", "viewer"]) }).strict();
const memberRoleSchema = z.object({ role: z.enum(["editor", "viewer"]) }).strict();
const profileSchema = z.object({ displayName: z.string().trim().min(1).max(80) }).strict();
const passwordChangeSchema = z.object({ currentPassword: z.string().max(200), newPassword: passwordSchema }).strict();
const changeNoteSchema = z.string().trim().max(500).optional();

function validateImportedText(text: string): string {
  if (text.length > maximumImportedTextLength) throw new AppError(413, "IMPORT_TEXT_TOO_LARGE", "导入文件解压后的文本超过 2000 万字符限制");
  assertSafeImportedPlainText(text);
  return text;
}

async function extractDocxText(buffer: Buffer): Promise<string> {
  assertSafeDocxArchive(buffer);
  try {
    return (await mammoth.extractRawText({ buffer })).value;
  } catch {
    throw new AppError(415, "INVALID_DOCX_FILE", "文件内容不是有效的 DOCX 文档");
  }
}

const workSchema = z.object({
  title: nonEmpty.max(200),
  author: z.string().max(200).optional(),
  description: z.string().max(10_000).optional(),
  language: z.string().max(30).optional(),
  coverUrl: z.string().url().nullable().optional(),
  tags: optionalStrings
});

const settingSchema = z.object({
  title: nonEmpty.max(200),
  category: nonEmpty.max(100),
  content: nonEmpty.max(200_000),
  tags: optionalStrings,
  status: z.enum(["draft", "pending", "confirmed", "deprecated"]).optional(),
  locked: z.boolean().optional(),
  evidence: z.array(z.unknown()).optional(),
  scope: jsonObject.optional(),
  authorNote: z.string().max(20_000).optional()
});

const characterSchema = z.object({
  name: nonEmpty.max(200),
  aliases: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  raceId: identifier.nullable().optional(),
  organizationIds: z.array(identifier).max(100).optional(),
  attributes: jsonObject.optional(),
  profile: jsonObject.optional(),
  currentState: jsonObject.optional(),
  lockedFields: optionalStrings,
  visibility: z.enum(["public", "author", "collaborators"]).optional(),
  firstChapterId: identifier.nullable().optional()
}).strict();

const characterUpdateSchema = characterSchema.partial().extend({
  changeNote: z.string().trim().max(500).optional()
});

const timelineSchema = z.object({
  name: nonEmpty.max(300),
  trackId: identifier.nullable().optional(),
  description: z.string().max(100_000).optional(),
  eventType: z.string().max(100).optional(),
  timeLabel: z.string().max(300).optional(),
  timeSort: z.number().finite().nullable().optional(),
  chapterIds: optionalStrings,
  participantIds: optionalStrings,
  location: z.string().max(500).optional(),
  causes: optionalStrings,
  impactScope: z.enum(["personal", "organization", "regional", "world", "galaxy"]).optional(),
  evidence: z.array(z.unknown()).optional(),
  status: z.enum(["candidate", "pending", "confirmed", "deprecated"]).optional()
});

const timelineTrackSchema = z.object({
  name: nonEmpty.max(200),
  description: z.string().max(20_000).optional(),
  sortOrder: z.number().int().min(0).optional()
});

const aiCitationSchema = z.object({
  chapterId: identifier,
  chapterTitle: nonEmpty.max(300),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  text: z.string().max(20_000)
}).refine((citation) => citation.endLine >= citation.startLine, "引用结束行不能早于开始行");

const aiCitationsSchema = z.array(aiCitationSchema).max(20).refine(
  (citations) => citations.reduce((total, citation) => total + citation.text.length, 0) <= 100_000,
  "引用正文总长度不能超过 100000 字符"
);

type AiCitation = z.infer<typeof aiCitationSchema>;

function instructionWithCitations(instruction: string, citations: AiCitation[]): string {
  if (!citations.length) return instruction;
  const references = citations.map((citation) => {
    const lines = citation.startLine === citation.endLine ? `L${citation.startLine}` : `L${citation.startLine}-L${citation.endLine}`;
    return `[${citation.chapterTitle} ${lines}]\n${citation.text}`;
  }).join("\n\n");
  return `${instruction}\n\n作者显式添加了以下正文引用。请优先依据这些引用回答，并在引用相关结论中注明章节与行号：\n\n${references}`;
}

const relationshipSchema = z.object({
  fromCharacterId: identifier,
  toCharacterId: identifier,
  category: z.enum(["family", "social", "emotional", "conflict", "uncertain"]),
  subtype: z.string().max(100).optional(),
  keywords: z.array(z.string().trim().min(1).max(100)).max(30).optional(),
  directed: z.boolean().optional(),
  currentStatus: z.string().max(100).optional(),
  timeRange: jsonObject.optional(),
  confidence: z.number().min(0).max(1).optional(),
  evidence: z.array(z.unknown()).optional(),
  confirmationStatus: z.enum(["pending", "confirmed", "rejected"]).optional(),
  locked: z.boolean().optional()
});

const organizationSchema = z.object({
  name: nonEmpty.max(200),
  description: z.string().max(100_000).optional(),
  settings: z.array(z.string().trim().min(1).max(20_000)).max(200).optional(),
  memberIds: z.array(identifier).max(1000).optional()
});

const raceSchema = z.object({
  name: nonEmpty.max(200),
  description: z.string().max(100_000).optional(),
  settings: z.array(z.string().trim().min(1).max(20_000)).max(200).optional(),
  memberIds: z.array(identifier).max(1000).optional()
});

const chapterOutlineSchema = z.object({
  goal: z.string().max(100_000).optional(),
  conflict: z.string().max(100_000).optional(),
  turningPoint: z.string().max(100_000).optional(),
  notes: z.string().max(100_000).optional(),
  status: z.enum(["draft", "ready", "completed"]).optional()
});

const foreshadowOccurrenceSchema = z.object({
  chapterId: identifier,
  role: z.enum(["setup", "reminder", "payoff"]),
  note: z.string().max(100_000).optional(),
  evidence: z.array(z.unknown()).optional()
});

const foreshadowSchema = z.object({
  title: nonEmpty.max(300),
  description: z.string().max(100_000).optional(),
  status: z.enum(["planned", "planted", "resolved", "abandoned"]).optional(),
  importance: z.enum(["low", "medium", "high"]).optional(),
  plannedPayoffChapterId: identifier.nullable().optional(),
  resolutionNote: z.string().max(100_000).optional(),
  occurrences: z.array(foreshadowOccurrenceSchema).max(500).optional()
});

const reviewSchema = z.object({
  itemType: nonEmpty.max(100),
  severity: z.enum(["low", "medium", "high"]).optional(),
  title: nonEmpty.max(300),
  description: z.string().max(100_000).optional(),
  entityRefs: z.array(z.unknown()).optional(),
  evidence: z.array(z.unknown()).optional(),
  suggestion: z.string().max(100_000).optional(),
  status: z.enum(["pending", "ignored", "fixing", "fixed", "exception"]).optional(),
  resolutionNote: z.string().max(20_000).optional()
});

const providerSchema = z.object({
  name: nonEmpty.max(200),
  baseUrl: z.string().url().refine((value) => value.startsWith("http://") || value.startsWith("https://"), "接口地址必须使用 HTTP 或 HTTPS"),
  apiKey: nonEmpty.max(10_000),
  status: z.enum(["enabled", "disabled"]).optional(),
  note: z.string().max(10_000).optional(),
  concurrencyLimit: z.number().int().min(1).max(100).optional(),
  rpmLimit: z.number().int().min(1).max(10_000).optional(),
  maxTokens: z.number().int().min(1).max(32_768).optional()
});

const modelSchema = z.object({
  displayName: nonEmpty.max(200),
  modelId: nonEmpty.max(300),
  purposes: optionalStrings,
  contextNote: z.string().max(10_000).optional(),
  contextWindow: z.number().int().min(1_024).max(2_000_000).optional(),
  outputNote: z.string().max(10_000).optional(),
  preset: jsonObject.optional(),
  thinkingEnabled: z.boolean().optional(),
  enabled: z.boolean().optional(),
  note: z.string().max(10_000).optional()
});

const aiPromptSchema = z.object({
  systemPrompt: z.string().max(100_000).optional()
});

const platformUiSettingsSchema = z.object({
  toastPosition: z.enum(["bottom-right", "top-right"])
}).strict();

const aiToolCallResultSchema = z.object({
  id: z.string().min(1).max(300),
  name: z.string().min(1).max(200),
  calledAt: z.string().datetime({ offset: true }).optional(),
  arguments: z.record(z.string(), z.unknown()).nullable(),
  status: z.enum(["completed", "failed"]),
  result: z.record(z.string(), z.unknown())
}).strict();

const aiProcessStepSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string().min(1).max(300),
    type: z.literal("thinking"),
    round: z.number().int().min(1).max(20),
    content: z.string().max(500_000),
    createdAt: z.string().datetime({ offset: true })
  }).strict(),
  z.object({
    id: z.string().min(1).max(300),
    type: z.literal("intermediate"),
    round: z.number().int().min(1).max(20),
    content: z.string().max(500_000),
    createdAt: z.string().datetime({ offset: true })
  }).strict(),
  z.object({
    id: z.string().min(1).max(300),
    type: z.literal("tool"),
    round: z.number().int().min(1).max(20),
    toolCall: aiToolCallResultSchema,
    createdAt: z.string().datetime({ offset: true })
  }).strict()
]);

const workAiSettingsSchema = z.object({
  systemPrompt: z.string().max(100_000).optional(),
  autoRunEnabled: z.boolean().optional(),
  autoRunConcurrency: z.number().int().min(1).max(8).optional(),
  autoRunBatchLimit: z.number().int().min(1).max(200).optional(),
  bookSummaryContextPercent: z.number().int().min(1).max(90).optional(),
  contextCompactThreshold: z.number().int().min(50).max(90).optional(),
  agentTools: z.array(z.enum(["story_index", "read_chapters", "grep", "query_story_knowledge"])).max(4).optional()
}).strict();

const contextSchema = z.object({
  type: z.enum(["none", "selection", "chapter", "volume", "book", "entities"]),
  chapterId: identifier.optional(),
  volumeId: identifier.optional(),
  selection: z.string().max(200_000).optional(),
  chapterIds: z.array(identifier).max(20).optional(),
  characterIds: optionalStrings,
  settingIds: optionalStrings,
  includeBookSummary: z.boolean().optional()
});

export type RuntimeOptions = {
  databasePath: string;
  masterSecret: string;
  fetchImpl?: typeof fetch;
  serveUi?: boolean;
  publicPath?: string;
  security?: RuntimeSecurityOptions;
  disableUserAuth?: boolean;
  /** 测试用：在验证码接口中回显答案 */
  revealCaptchaAnswer?: boolean;
};

export type Runtime = {
  app: Express;
  database: Database;
  store: Store;
  ai: AiManager;
  auth: UserAuthService;
  close: () => void;
};

function data(response: Response, value: unknown, status = 200): void {
  response.status(status).json({ data: value });
}

function noContent(response: Response): void {
  response.status(204).end();
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  return schema.parse(value);
}

export function createRuntime(options: RuntimeOptions): Runtime {
  logger.info("runtime.initializing", {
    databasePath: options.databasePath,
    serveUi: options.serveUi ?? true,
    userAuthDisabled: options.disableUserAuth === true,
    deploymentAuthEnabled: Boolean(options.security?.auth),
    sameOriginEnforced: options.security?.enforceSameOrigin ?? true
  });
  const database = new Database(options.databasePath);
  const auth = new UserAuthService(database);
  const store = new Store(database);
  const captcha = new ImageCaptchaService({ revealAnswer: options.revealCaptchaAnswer === true });
  const ai = new AiManager(
    store,
    new CredentialVault(options.masterSecret),
    options.fetchImpl ?? fetch,
    options.security ? (url) => assertSafeAiEndpoint(url, options.security?.allowPrivateAiEndpoints) : undefined
  );
  const app = express();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 30 * 1024 * 1024, files: 1, fields: 10, fieldSize: 64 * 1024, parts: 11, headerPairs: 100 }
  });
  const coverUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 4, fieldSize: 16 * 1024, parts: 5, headerPairs: 100 }
  });
  const avatarUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 1, fieldSize: 1024, parts: 2, headerPairs: 50 }
  });

  app.disable("x-powered-by");
  if (options.security?.trustProxy !== undefined) app.set("trust proxy", options.security.trustProxy);
  app.use(createRequestLoggingMiddleware());
  app.use(createSecurityHeadersMiddleware());

  app.get("/api/health", (_request, response) => {
    data(response, { status: "ok", version: APP_VERSION, protocol: "openai-chat-completions" });
  });

  if (options.security?.auth) app.use(createBasicAuthMiddleware(options.security.auth));
  app.use(createAuthenticationRateLimitMiddleware());
  app.use(createApiRateLimitMiddleware(options.security?.apiRateLimit, options.security?.apiRateWindowMs));
  if (options.security?.enforceSameOrigin ?? true) app.use(createSameOriginMiddleware());
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/auth/session", (request, response) => {
    const session = auth.authenticate(request);
    const registrationOpen = options.security?.allowRegistration === true;
    data(response, session
      ? { authenticated: true, user: session.user, csrfToken: session.csrfToken, setupRequired: false, registrationOpen }
      : { authenticated: false, user: null, csrfToken: null, setupRequired: !auth.hasUsers(), registrationOpen });
  });
  app.get("/api/auth/captcha", (_request, response) => {
    data(response, captcha.create());
  });
  app.post("/api/auth/register", (request, response) => {
    if (options.security?.allowRegistration !== true) {
      throw new AppError(403, "REGISTRATION_DISABLED", "当前部署已关闭新用户注册");
    }
    const input = parse(registrationSchema, request.body);
    captcha.consume(input.captchaId, input.captchaAnswer);
    const result = auth.register({ username: input.username, password: input.password });
    setSessionCookie(response, result.token, request.secure);
    runWithRequestActor(result.session.user, () => store.audit(null, "user.registered", "user", result.session.user.userId, { role: result.session.user.role }));
    logger.info("auth.registration.succeeded", { actorRef: accountReference(result.session.user.userId) });
    data(response, { user: result.session.user, csrfToken: result.session.csrfToken }, 201);
  });
  app.post("/api/auth/login", (request, response) => {
    const input = parse(loginSchema, request.body);
    captcha.consume(input.captchaId, input.captchaAnswer);
    const result = auth.login(input.username, input.password);
    setSessionCookie(response, result.token, request.secure);
    runWithRequestActor(result.session.user, () => store.audit(null, "user.logged-in", "user", result.session.user.userId));
    logger.info("auth.login.succeeded", { actorRef: accountReference(result.session.user.userId) });
    data(response, { user: result.session.user, csrfToken: result.session.csrfToken });
  });
  app.use(createUserSessionMiddleware(auth, options.disableUserAuth));
  app.use(createCliApiScopeMiddleware(options.disableUserAuth));
  app.use(createWorkAuthorizationMiddleware(auth, options.disableUserAuth));
  app.get("/api/cli/session", (request, response) => {
    if (!request.authUser || request.authMethod !== "api-key") throw new AppError(401, "API_KEY_REQUIRED", "请使用 API Key 登录");
    data(response, { authenticated: true, user: request.authUser, apiKeyPrefix: request.authApiKey?.prefix ?? null });
  });
  app.delete("/api/auth/session", (request, response) => {
    if (request.authSession) auth.revoke(request.authSession.id);
    clearSessionCookie(response, request.secure);
    noContent(response);
  });
  app.post("/api/auth/onboarding/complete", (request, response) => {
    if (!request.authUser || request.authMethod !== "session") throw new AppError(401, "SESSION_REQUIRED", "请使用网页会话完成新手引导");
    parse(z.object({}).strict(), request.body ?? {});
    const updated = auth.completeOnboarding(request.authUser.userId);
    store.audit(null, "user.onboarding-completed", "user", updated.userId);
    data(response, updated);
  });
  app.patch("/api/auth/profile", (request, response) => {
    if (!request.authUser) throw new AppError(401, "AUTH_REQUIRED", "请先登录");
    const updated = auth.updateProfile(request.authUser.userId, parse(profileSchema, request.body).displayName);
    store.audit(null, "user.profile-updated", "user", updated.userId);
    data(response, updated);
  });
  app.put("/api/auth/avatar", avatarUpload.single("file"), (request, response) => {
    if (!request.authUser) throw new AppError(401, "AUTH_REQUIRED", "请先登录");
    if (!request.file) throw new AppError(400, "FILE_REQUIRED", "请选择 PNG、JPEG 或 WebP 头像");
    try {
      const metadata = readRasterImageMetadata(request.file.buffer);
      const updated = database.transaction(() => {
        const user = auth.setAvatar(request.authUser!.userId, { ...metadata, content: request.file!.buffer });
        store.audit(null, "user.avatar-updated", "user", user.userId, {
          mimeType: metadata.mimeType,
          byteLength: request.file!.buffer.byteLength,
          width: metadata.width,
          height: metadata.height
        });
        return user;
      });
      data(response, updated);
    } catch (error) {
      if (error instanceof InvalidRasterImageError) throw new AppError(415, "INVALID_AVATAR", error.message);
      throw error;
    }
  });
  app.delete("/api/auth/avatar", (request, response) => {
    if (!request.authUser) throw new AppError(401, "AUTH_REQUIRED", "请先登录");
    const updated = database.transaction(() => {
      const user = auth.deleteAvatar(request.authUser!.userId);
      store.audit(null, "user.avatar-deleted", "user", user.userId);
      return user;
    });
    data(response, updated);
  });
  app.patch("/api/auth/password", (request, response) => {
    if (!request.authUser || !request.authSession) throw new AppError(401, "AUTH_REQUIRED", "请先登录");
    const input = parse(passwordChangeSchema, request.body);
    auth.changePassword(request.authUser.userId, request.authSession.id, input.currentPassword, input.newPassword);
    store.audit(null, "user.password-changed", "user", request.authUser.userId);
    noContent(response);
  });
  app.get("/api/auth/api-key", (request, response) => {
    if (!request.authUser || request.authMethod !== "session") throw new AppError(401, "SESSION_REQUIRED", "请使用网页会话管理 API Key");
    data(response, auth.getApiKeyStatus(request.authUser.userId));
  });
  app.post("/api/auth/api-key/reset", (request, response) => {
    if (!request.authUser || request.authMethod !== "session") throw new AppError(401, "SESSION_REQUIRED", "请使用网页会话管理 API Key");
    parse(z.object({}).strict(), request.body ?? {});
    const userId = request.authUser.userId;
    const result = database.transaction(() => {
      const reset = auth.resetApiKey(userId);
      store.audit(null, "user.api-key-reset", "user", userId, { prefix: reset.prefix });
      return reset;
    });
    data(response, result);
  });

  app.get("/api/users", (_request, response) => data(response, auth.listUsers()));
  app.get("/api/users/directory", (request, response) => data(response, auth.directory(String(request.query.q ?? ""))));
  app.get("/api/user-avatars/:userId", (request, response) => {
    const avatar = auth.getAvatar(request.params.userId);
    response.setHeader("Content-Type", avatar.mimeType);
    response.setHeader("Content-Length", String(avatar.byteLength));
    response.setHeader("ETag", `\"${avatar.sha256}\"`);
    response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    response.send(avatar.content);
  });
  app.patch("/api/users/:userId", (request, response) => {
    if (!request.authUser) throw new AppError(401, "AUTH_REQUIRED", "请先登录");
    const updated = auth.updateUser(request.authUser, request.params.userId, parse(userUpdateSchema, request.body));
    store.audit(null, "user.updated", "user", updated.userId, { role: updated.role, status: updated.status });
    data(response, updated);
  });

  app.get("/api/works", (_request, response) => data(response, store.listWorks()));
  app.post("/api/works", (request, response) => data(response, store.createWork(parse(workSchema, request.body)), 201));
  app.post("/api/works/import", upload.single("file"), async (request, response) => {
    if (!request.file) throw new AppError(400, "FILE_REQUIRED", "请选择要导入的 TXT 或 DOCX 文件");
    const originalFileName = normalizeUploadFileName(request.file.originalname);
    const extension = extname(originalFileName).toLocaleLowerCase();
    if (extension !== ".txt" && extension !== ".docx") throw new AppError(415, "UNSUPPORTED_FILE", "仅支持 TXT 和 DOCX 导入");
    const text = validateImportedText(extension === ".docx"
      ? await extractDocxText(request.file.buffer)
      : decodeUtf8ImportedText(request.file.buffer));
    const parsedNovel = applyImportFileHints(parseNovelText(text), originalFileName);
    const inferredTitle = originalFileName.replace(/\.(txt|docx)$/iu, "").trim() || "未命名作品";
    const input = parse(workSchema, {
      title: typeof request.body.title === "string" && request.body.title.trim() ? request.body.title : inferredTitle,
      author: typeof request.body.author === "string" ? request.body.author : "",
      description: typeof request.body.description === "string" ? request.body.description : ""
    });
    data(response, store.createImportedWork(input, originalFileName, extension.slice(1), parsedNovel), 201);
  });
  app.get("/api/works/:workId", (request, response) => data(response, store.getWorkDirectory(request.params.workId)));
  app.get("/api/works/:workId/members", (request, response) => data(response, auth.listMembers(request.params.workId)));
  app.post("/api/works/:workId/members", (request, response) => {
    if (!request.authUser) throw new AppError(401, "AUTH_REQUIRED", "请先登录");
    const input = parse(memberSchema, request.body);
    const members = auth.addMember(request.params.workId, input.userId, input.role, request.authUser.userId);
    store.audit(request.params.workId, "work.member-added", "user", input.userId, { role: input.role });
    data(response, members, 201);
  });
  app.patch("/api/works/:workId/members/:userId", (request, response) => {
    const input = parse(memberRoleSchema, request.body);
    const members = auth.updateMemberRole(request.params.workId, request.params.userId, input.role);
    store.audit(request.params.workId, "work.member-role-updated", "user", request.params.userId, { role: input.role });
    data(response, members);
  });
  app.delete("/api/works/:workId/members/:userId", (request, response) => {
    const members = auth.removeMember(request.params.workId, request.params.userId);
    store.audit(request.params.workId, "work.member-removed", "user", request.params.userId);
    data(response, members);
  });
  app.patch("/api/works/:workId", (request, response) => data(response, store.updateWork(request.params.workId, parse(workSchema.partial(), request.body))));
  app.delete("/api/works/:workId", (request, response) => {
    store.deleteWork(request.params.workId);
    noContent(response);
  });
  app.get("/api/works/:workId/cover", (request, response) => {
    const cover = store.getWorkCover(request.params.workId);
    response.setHeader("Content-Type", cover.mimeType);
    response.setHeader("Content-Length", String(cover.byteLength));
    response.setHeader("ETag", `\"${cover.sha256}\"`);
    response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    response.send(cover.content);
  });
  app.put("/api/works/:workId/cover", coverUpload.single("file"), (request, response) => {
    if (!request.file) throw new AppError(400, "FILE_REQUIRED", "请选择 PNG、JPEG 或 WebP 封面");
    const bytes = request.file.buffer;
    const isPng = bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isJpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const isWebp = bytes.length >= 12 && bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
    const mimeType: "image/png" | "image/jpeg" | "image/webp" | null = isPng ? "image/png" : isJpeg ? "image/jpeg" : isWebp ? "image/webp" : null;
    if (!mimeType) throw new AppError(415, "INVALID_COVER", "封面文件内容不是有效的 PNG、JPEG 或 WebP 图片");
    data(response, store.setWorkCover(String(request.params.workId), mimeType, bytes));
  });
  app.delete("/api/works/:workId/cover", (request, response) => {
    store.deleteWorkCover(request.params.workId);
    noContent(response);
  });

  app.get("/api/works/:workId/file-versions", (request, response) => data(response, store.listFileVersions(request.params.workId)));
  app.post("/api/works/:workId/file-versions/:fileVersionId/restore", (request, response) => {
    data(response, store.restoreFileVersion(request.params.workId, request.params.fileVersionId));
  });
  app.post("/api/works/:workId/import", upload.single("file"), async (request, response) => {
    if (!request.file) throw new AppError(400, "FILE_REQUIRED", "请选择要导入的 TXT 或 DOCX 文件");
    const originalFileName = normalizeUploadFileName(request.file.originalname);
    const extension = extname(originalFileName).toLocaleLowerCase();
    if (extension !== ".txt" && extension !== ".docx") {
      throw new AppError(415, "UNSUPPORTED_FILE", "MVP 仅支持 TXT 和 DOCX 导入");
    }
    const text = validateImportedText(extension === ".docx"
      ? await extractDocxText(request.file.buffer)
      : decodeUtf8ImportedText(request.file.buffer));
    const parsed = applyImportFileHints(parseNovelText(text), originalFileName);
    data(response, store.importNovel(String(request.params.workId), originalFileName, extension.slice(1), parsed), 201);
  });

  app.post("/api/works/:workId/volumes", (request, response) => {
    const input = parse(z.object({ title: nonEmpty.max(200), kind: z.enum(["main", "prequel", "extra", "epilogue", "appendix"]).optional(), description: z.string().max(5_000).optional(), keywords: z.array(nonEmpty.max(100)).max(100).optional() }), request.body);
    data(response, store.createVolume(request.params.workId, input), 201);
  });
  app.patch("/api/volumes/:volumeId", (request, response) => {
    const input = parse(z.object({ title: nonEmpty.max(200).optional(), kind: z.enum(["main", "prequel", "extra", "epilogue", "appendix"]).optional(), description: z.string().max(5_000).optional(), keywords: z.array(nonEmpty.max(100)).max(100).optional(), sortOrder: z.number().int().min(0).optional() }), request.body);
    data(response, store.updateVolume(request.params.volumeId, input));
  });
  app.get("/api/volumes/:volumeId", (request, response) => data(response, store.getVolume(request.params.volumeId)));
  app.delete("/api/volumes/:volumeId", (request, response) => {
    store.deleteVolume(request.params.volumeId);
    noContent(response);
  });

  app.post("/api/works/:workId/chapters", (request, response) => {
    const input = parse(z.object({ volumeId: identifier, title: nonEmpty.max(300), content: z.string().max(2_000_000).optional(), chapterType: chapterTypeSchema.optional() }), request.body);
    data(response, store.createChapter(request.params.workId, input), 201);
  });
  app.get("/api/chapters/:chapterId", (request, response) => data(response, store.getChapter(request.params.chapterId)));
  app.patch("/api/chapters/:chapterId", (request, response) => {
    const input = parse(z.object({ title: nonEmpty.max(300).optional(), content: z.string().max(2_000_000).optional(), excludedFromAnalysis: z.boolean().optional(), chapterType: chapterTypeSchema.optional(), source: z.enum(["manual", "auto"]).optional(), changeNote: changeNoteSchema }).strict(), request.body);
    const { source, changeNote, ...chapterInput } = input;
    data(response, store.saveChapter(request.params.chapterId, chapterInput, source ?? "manual", null, changeNote));
  });
  app.delete("/api/chapters/:chapterId", (request, response) => {
    store.deleteChapter(request.params.chapterId);
    noContent(response);
  });
  app.get("/api/chapters/:chapterId/versions", (request, response) => data(response, store.listChapterVersions(request.params.chapterId)));
  app.get("/api/chapters/:chapterId/insights", (request, response) => data(response, store.listChapterInsights(request.params.chapterId)));
  app.post("/api/chapters/:chapterId/restore", (request, response) => {
    const input = parse(z.object({ versionNo: z.number().int().positive() }), request.body);
    data(response, store.restoreChapter(request.params.chapterId, input.versionNo));
  });
  app.post("/api/chapters/:chapterId/move", (request, response) => {
    const input = parse(z.object({ volumeId: identifier, sortOrder: z.number().int().min(0) }), request.body);
    data(response, store.moveChapter(request.params.chapterId, input));
  });

  app.get("/api/works/:workId/outlines", (request, response) => data(response, store.listChapterOutlines(request.params.workId)));
  app.get("/api/chapters/:chapterId/outline", (request, response) => data(response, store.getChapterOutline(request.params.chapterId)));
  app.put("/api/chapters/:chapterId/outline", (request, response) => {
    const { changeNote, ...input } = parse(chapterOutlineSchema.extend({ changeNote: changeNoteSchema }), request.body);
    data(response, store.upsertChapterOutline(request.params.chapterId, input, "manual", null, changeNote));
  });
  app.delete("/api/chapters/:chapterId/outline", (request, response) => {
    store.deleteChapterOutline(request.params.chapterId);
    noContent(response);
  });

  app.get("/api/works/:workId/foreshadows", (request, response) => {
    const query = parse(z.object({
      status: z.enum(["all", "unresolved", "resolved"]).default("all"),
      currentChapterId: identifier.optional()
    }), request.query);
    data(response, store.listForeshadows(request.params.workId, query.status, query.currentChapterId));
  });
  app.post("/api/works/:workId/foreshadows", (request, response) => {
    data(response, store.createForeshadow(request.params.workId, parse(foreshadowSchema, request.body)), 201);
  });
  app.get("/api/foreshadows/:foreshadowId", (request, response) => data(response, store.getForeshadow(request.params.foreshadowId)));
  app.patch("/api/foreshadows/:foreshadowId", (request, response) => {
    const { changeNote, ...input } = parse(foreshadowSchema.partial().extend({ changeNote: changeNoteSchema }), request.body);
    data(response, store.updateForeshadow(request.params.foreshadowId, input, "manual", null, changeNote));
  });
  app.delete("/api/foreshadows/:foreshadowId", (request, response) => {
    store.deleteForeshadow(request.params.foreshadowId);
    noContent(response);
  });
  app.post("/api/foreshadows/:foreshadowId/occurrences", (request, response) => {
    data(response, store.createForeshadowOccurrence(request.params.foreshadowId, parse(foreshadowOccurrenceSchema, request.body)), 201);
  });
  app.patch("/api/foreshadow-occurrences/:occurrenceId", (request, response) => {
    data(response, store.updateForeshadowOccurrence(request.params.occurrenceId, parse(foreshadowOccurrenceSchema.partial(), request.body)));
  });
  app.delete("/api/foreshadow-occurrences/:occurrenceId", (request, response) => {
    store.deleteForeshadowOccurrence(request.params.occurrenceId);
    noContent(response);
  });

  app.get("/api/works/:workId/settings", (request, response) => data(response, store.listSettings(request.params.workId)));
  app.post("/api/works/:workId/settings", (request, response) => data(response, store.createSetting(request.params.workId, parse(settingSchema, request.body)), 201));
  app.get("/api/settings/:settingId", (request, response) => data(response, store.getSetting(request.params.settingId)));
  app.patch("/api/settings/:settingId", (request, response) => {
    const { changeNote, ...input } = parse(settingSchema.partial().extend({ changeNote: changeNoteSchema }), request.body);
    data(response, store.updateSetting(request.params.settingId, input, "manual", null, changeNote));
  });
  app.delete("/api/settings/:settingId", (request, response) => {
    store.deleteSetting(request.params.settingId);
    noContent(response);
  });

  app.get("/api/works/:workId/characters", (request, response) => {
    data(response, store.listCharacters(request.params.workId, request.query.includeMerged === "1"));
  });
  app.post("/api/works/:workId/characters", (request, response) => data(response, store.createCharacter(request.params.workId, parse(characterSchema, request.body)), 201));
  app.get("/api/characters/:characterId", (request, response) => data(response, store.getCharacter(request.params.characterId)));
  app.patch("/api/characters/:characterId", (request, response) => {
    const { changeNote, ...input } = parse(characterUpdateSchema, request.body);
    data(response, store.updateCharacter(request.params.characterId, input, "manual", null, changeNote));
  });
  app.get("/api/characters/:characterId/versions", (request, response) => data(response, store.listCharacterVersions(request.params.characterId)));
  app.post("/api/characters/:characterId/restore", (request, response) => {
    const input = parse(z.object({ versionNo: z.number().int().positive() }), request.body);
    data(response, store.restoreCharacter(request.params.characterId, input.versionNo));
  });
  app.delete("/api/characters/:characterId", (request, response) => {
    store.deleteCharacter(request.params.characterId);
    noContent(response);
  });

  app.get("/api/works/:workId/races", (request, response) => data(response, store.listRaces(request.params.workId)));
  app.post("/api/works/:workId/races", (request, response) => {
    data(response, store.createRace(request.params.workId, parse(raceSchema, request.body)), 201);
  });
  app.get("/api/races/:raceId", (request, response) => data(response, store.getRace(request.params.raceId)));
  app.patch("/api/races/:raceId", (request, response) => {
    const { changeNote, ...input } = parse(raceSchema.partial().extend({ changeNote: changeNoteSchema }), request.body);
    data(response, store.updateRace(request.params.raceId, input, "manual", null, changeNote));
  });
  app.delete("/api/races/:raceId", (request, response) => {
    store.deleteRace(request.params.raceId);
    noContent(response);
  });

  app.get("/api/works/:workId/organizations", (request, response) => data(response, store.listOrganizations(request.params.workId)));
  app.post("/api/works/:workId/organizations", (request, response) => {
    data(response, store.createOrganization(request.params.workId, parse(organizationSchema, request.body)), 201);
  });
  app.get("/api/organizations/:organizationId", (request, response) => data(response, store.getOrganization(request.params.organizationId)));
  app.patch("/api/organizations/:organizationId", (request, response) => {
    const { changeNote, ...input } = parse(organizationSchema.partial().extend({ changeNote: changeNoteSchema }), request.body);
    data(response, store.updateOrganization(request.params.organizationId, input, "manual", null, changeNote));
  });
  app.delete("/api/organizations/:organizationId", (request, response) => {
    store.deleteOrganization(request.params.organizationId);
    noContent(response);
  });

  app.get("/api/works/:workId/timeline-tracks", (request, response) => data(response, store.listTimelineTracks(request.params.workId)));
  app.post("/api/works/:workId/timeline-tracks", (request, response) => data(response, store.createTimelineTrack(request.params.workId, parse(timelineTrackSchema, request.body)), 201));
  app.get("/api/timeline-tracks/:trackId", (request, response) => data(response, store.getTimelineTrack(request.params.trackId)));
  app.patch("/api/timeline-tracks/:trackId", (request, response) => {
    const { changeNote, ...input } = parse(timelineTrackSchema.partial().extend({ changeNote: changeNoteSchema }), request.body);
    data(response, store.updateTimelineTrack(request.params.trackId, input, "manual", null, changeNote));
  });
  app.delete("/api/timeline-tracks/:trackId", (request, response) => {
    store.deleteTimelineTrack(request.params.trackId);
    noContent(response);
  });

  app.get("/api/works/:workId/timeline", (request, response) => data(response, store.listTimelineEvents(request.params.workId)));
  app.post("/api/works/:workId/timeline", (request, response) => data(response, store.createTimelineEvent(request.params.workId, parse(timelineSchema, request.body)), 201));
  app.post("/api/works/:workId/timeline/merge", (request, response) => {
    const input = parse(z.object({
      eventIds: z.array(identifier).min(2),
      name: nonEmpty.max(300),
      description: z.string().max(100_000).optional(),
      timeLabel: z.string().max(300).optional(),
      timeSort: z.number().finite().nullable().optional()
    }), request.body);
    data(response, store.mergeTimelineEvents(request.params.workId, input.eventIds, input), 201);
  });
  app.get("/api/timeline/:eventId", (request, response) => data(response, store.getTimelineEvent(request.params.eventId)));
  app.patch("/api/timeline/:eventId", (request, response) => {
    const { changeNote, ...input } = parse(timelineSchema.partial().extend({ changeNote: changeNoteSchema }), request.body);
    data(response, store.updateTimelineEvent(request.params.eventId, input, "manual", null, changeNote));
  });
  app.post("/api/timeline/:eventId/split", (request, response) => {
    const input = parse(z.object({
      parts: z.array(z.object({
        name: nonEmpty.max(300),
        description: z.string().max(100_000).optional(),
        timeLabel: z.string().max(300).optional(),
        timeSort: z.number().finite().nullable().optional()
      })).min(2)
    }), request.body);
    data(response, store.splitTimelineEvent(request.params.eventId, input.parts), 201);
  });
  app.delete("/api/timeline/:eventId", (request, response) => {
    store.deleteTimelineEvent(request.params.eventId);
    noContent(response);
  });

  app.get("/api/works/:workId/relationships", (request, response) => {
    const confidence = request.query.minimumConfidence ? Number(request.query.minimumConfidence) : 0;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new AppError(400, "INVALID_CONFIDENCE", "置信度必须在 0 到 1 之间");
    data(response, store.listRelationships(request.params.workId, confidence));
  });
  app.post("/api/works/:workId/relationships", (request, response) => data(response, store.createRelationship(request.params.workId, parse(relationshipSchema, request.body)), 201));
  app.get("/api/relationships/:relationshipId", (request, response) => data(response, store.getRelationship(request.params.relationshipId)));
  app.patch("/api/relationships/:relationshipId", (request, response) => {
    const { changeNote, ...input } = parse(relationshipSchema.partial().extend({ changeNote: changeNoteSchema }), request.body);
    data(response, store.updateRelationship(request.params.relationshipId, input, "manual", null, changeNote));
  });
  app.delete("/api/relationships/:relationshipId", (request, response) => {
    store.deleteRelationship(request.params.relationshipId);
    noContent(response);
  });

  app.get("/api/entity-versions/:entityType/:entityId", (request, response) => {
    const input = parse(z.object({ entityType: versionedEntityTypeSchema, entityId: identifier }), request.params);
    data(response, store.listEntityVersions(input.entityType, input.entityId));
  });
  app.post("/api/entity-versions/:entityType/:entityId/restore", (request, response) => {
    const params = parse(z.object({ entityType: versionedEntityTypeSchema, entityId: identifier }), request.params);
    const input = parse(z.object({ versionNo: z.number().int().positive() }), request.body);
    data(response, store.restoreEntityVersion(params.entityType, params.entityId, input.versionNo));
  });

  app.get("/api/works/:workId/reviews", (request, response) => {
    const status = typeof request.query.status === "string" ? request.query.status : undefined;
    data(response, store.listReviewItems(request.params.workId, status));
  });
  app.post("/api/works/:workId/reviews", (request, response) => data(response, store.createReviewItem(request.params.workId, parse(reviewSchema, request.body)), 201));
  app.patch("/api/reviews/:reviewId", (request, response) => data(response, store.updateReviewItem(request.params.reviewId, parse(reviewSchema.partial(), request.body))));
  app.post("/api/reviews/:reviewId/character-resolution", (request, response) => {
    const input = parse(z.discriminatedUnion("action", [
      z.object({ action: z.literal("keep-separate") }).strict(),
      z.object({
        action: z.literal("merge"),
        targetCharacterId: identifier,
        sourceCharacterId: identifier,
        expectedTargetVersionNo: z.number().int().positive(),
        expectedSourceVersionNo: z.number().int().positive()
      }).strict()
    ]), request.body);
    if (input.action === "keep-separate") {
      data(response, store.resolveCharacterDuplicateReview(request.params.reviewId));
      return;
    }
    data(response, store.mergeCharacters({ reviewId: request.params.reviewId, ...input }));
  });

  app.get("/api/works/:workId/tasks", (request, response) => data(response, store.listTasks(request.params.workId)));
  app.post("/api/works/:workId/tasks", (request, response) => {
    const input = parse(z.object({ taskType: z.enum(["structure", "chapter-analysis", "character-extraction", "character-summary", "character-identity-audit", "timeline-analysis", "relationship-analysis", "worldview-analysis", "setting-extraction", "consistency-check", "report-update", "book-analysis"]), scope: jsonObject.optional() }), request.body);
    data(response, store.createTask(request.params.workId, input), 201);
  });
  app.post("/api/works/:workId/tasks/auto-run", (request, response) => {
    data(response, ai.startAutoRunBatch(request.params.workId));
  });
  app.get("/api/tasks/:taskId", (request, response) => data(response, store.getTask(request.params.taskId)));
  app.post("/api/tasks/:taskId/run", async (request, response) => {
    const input = parse(z.object({ modelId: identifier.optional() }), request.body ?? {});
    data(response, await ai.runTask(request.params.taskId, input.modelId));
  });
  app.post("/api/tasks/:taskId/cancel", (request, response) => data(response, ai.cancelTask(request.params.taskId)));

  app.get("/api/platform/ai/providers", (_request, response) => data(response, ai.listProviders()));
  app.post("/api/platform/ai/providers", (request, response) => data(response, ai.createProvider(parse(providerSchema, request.body)), 201));
  app.get("/api/platform/ai/models", (_request, response) => data(response, ai.listPlatformModels()));
  app.get("/api/platform/ai/settings", (_request, response) => data(response, store.getPlatformAiSettings()));
  app.patch("/api/platform/ai/settings", (request, response) => data(response, store.updatePlatformAiSettings(parse(aiPromptSchema, request.body))));
  app.get("/api/ui-settings", (_request, response) => data(response, store.getPlatformUiSettings()));
  app.get("/api/platform/ui-settings", (_request, response) => data(response, store.getPlatformUiSettings()));
  app.patch("/api/platform/ui-settings", (request, response) => {
    data(response, store.updatePlatformUiSettings(parse(platformUiSettingsSchema, request.body)));
  });

  app.get("/api/works/:workId/ai-settings", (request, response) => data(response, store.getWorkAiSettings(request.params.workId)));
  app.patch("/api/works/:workId/ai-settings", (request, response) => {
    const workId = request.params.workId;
    const before = store.getWorkAiSettings(workId);
    const updated = store.updateWorkAiSettings(workId, parse(workAiSettingsSchema, request.body));
    if (updated.autoRunEnabled) {
      if (!before.autoRunEnabled) ai.resetAutoRunBatch(workId);
      ai.scheduleAutoRun(workId);
    }
    data(response, updated);
  });
  app.get("/api/works/:workId/ai-conversations", (request, response) => data(response, store.listAiConversations(request.params.workId)));
  app.post("/api/works/:workId/ai-conversations", (request, response) => {
    const input = parse(z.object({ title: z.string().max(200).optional() }), request.body ?? {});
    data(response, store.createAiConversation(request.params.workId, input.title), 201);
  });
  app.get("/api/ai-conversations/:conversationId", (request, response) => data(response, store.getAiConversation(request.params.conversationId)));
  app.post("/api/ai-conversations/:conversationId/fork", (request, response) => {
    const input = parse(z.object({ messageId: identifier, title: z.string().max(200).optional() }), request.body);
    data(response, store.forkAiConversation(request.params.conversationId, input.messageId, input.title), 201);
  });
  app.post("/api/ai-conversations/:conversationId/messages", (request, response) => {
    const input = parse(z.object({
      role: z.enum(["user", "assistant"]),
      content: nonEmpty.max(200_000),
      citations: z.array(z.unknown()).max(100).optional(),
      metadata: z.object({
        modelDisplayName: z.string().max(200).optional(),
        outputTokens: z.number().int().min(0).max(10_000_000).optional(),
        processDurationMs: z.number().int().min(0).max(86_400_000).optional(),
        toolCalls: z.array(aiToolCallResultSchema).max(12).optional(),
        processSteps: z.array(aiProcessStepSchema).max(50).optional()
      }).optional()
    }), request.body);
    data(response, store.addAiConversationMessage(request.params.conversationId, input), 201);
  });
  app.post("/api/ai-conversations/:conversationId/context/prepare", async (request, response) => {
    const input = parse(z.object({
      modelId: identifier.optional(),
      scope: contextSchema,
      instruction: z.string().max(100_000).default(""),
      citations: aiCitationsSchema.optional()
    }), request.body ?? {});
    const conversation = store.getAiConversation(request.params.conversationId);
    data(response, await ai.prepareConversationContext({
      conversationId: request.params.conversationId,
      workId: String(conversation.workId),
      modelId: input.modelId,
      scope: input.scope,
      instruction: instructionWithCitations(input.instruction, input.citations ?? [])
    }));
  });
  app.post("/api/ai-conversations/:conversationId/compact", async (request, response) => {
    const input = parse(z.object({ modelId: identifier.optional(), scope: contextSchema }), request.body);
    const conversation = store.getAiConversation(request.params.conversationId);
    data(response, await ai.compactConversation({
      conversationId: request.params.conversationId,
      workId: String(conversation.workId),
      modelId: input.modelId,
      scope: input.scope
    }));
  });
  app.post("/api/works/:workId/ai-context-usage", (request, response) => {
    const input = parse(z.object({
      modelId: identifier.optional(),
      taskType: z.enum(TASK_TYPES).default("chat"),
      scope: contextSchema,
      instruction: z.string().max(100_000).default(""),
      citations: aiCitationsSchema.optional(),
      conversationId: identifier.optional(),
      currentMessageId: identifier.optional()
    }), request.body ?? {});
    data(response, ai.getContextUsage({
      workId: request.params.workId,
      modelId: input.modelId,
      taskType: input.taskType,
      scope: input.scope,
      instruction: instructionWithCitations(input.instruction, input.citations ?? []),
      conversationId: input.conversationId,
      excludeConversationMessageId: input.currentMessageId
    }));
  });

  app.get("/api/works/:workId/providers", (request, response) => {
    store.getWork(request.params.workId);
    data(response, ai.listProviders());
  });
  app.post("/api/works/:workId/providers", (request, response) => {
    store.getWork(request.params.workId);
    data(response, ai.createProvider(parse(providerSchema, request.body)), 201);
  });
  app.get("/api/providers/:providerId", (request, response) => data(response, ai.getProvider(request.params.providerId)));
  app.patch("/api/providers/:providerId", (request, response) => data(response, ai.updateProvider(request.params.providerId, parse(providerSchema.partial(), request.body))));
  app.delete("/api/providers/:providerId", (request, response) => {
    ai.deleteProvider(request.params.providerId);
    noContent(response);
  });
  app.post("/api/providers/:providerId/test", async (request, response) => data(response, await ai.testProvider(request.params.providerId)));
  app.get("/api/providers/:providerId/models", (request, response) => data(response, ai.listModels(request.params.providerId)));
  app.post("/api/providers/:providerId/models", (request, response) => data(response, ai.createModel(request.params.providerId, parse(modelSchema, request.body)), 201));
  app.get("/api/models/:modelId", (request, response) => data(response, ai.getModel(request.params.modelId)));
  app.patch("/api/models/:modelId", (request, response) => data(response, ai.updateModel(request.params.modelId, parse(modelSchema.partial(), request.body))));
  app.delete("/api/models/:modelId", (request, response) => {
    ai.deleteModel(request.params.modelId);
    noContent(response);
  });
  app.get("/api/works/:workId/models", (request, response) => data(response, ai.listWorkModels(request.params.workId)));
  app.get("/api/works/:workId/task-defaults", (request, response) => data(response, ai.listTaskDefaults(request.params.workId)));
  app.put("/api/works/:workId/task-defaults/:taskType", (request, response) => {
    const taskType = parse(z.enum(TASK_TYPES), request.params.taskType) as TaskType;
    const input = parse(z.object({ modelId: identifier }), request.body);
    data(response, ai.setTaskDefault(request.params.workId, taskType, input.modelId));
  });

  app.get("/api/works/:workId/suggestions", (request, response) => {
    const status = typeof request.query.status === "string" ? request.query.status : undefined;
    data(response, ai.listSuggestions(request.params.workId, status));
  });
  app.post("/api/works/:workId/suggestions", async (request, response) => {
    const input = parse(z.object({
      taskType: z.enum(TASK_TYPES),
      instruction: nonEmpty.max(100_000),
      scope: contextSchema,
      modelId: identifier.optional(),
      parameters: jsonObject.optional(),
      citations: aiCitationsSchema.optional()
    }), request.body);
    const citations = input.citations ?? [];
    for (const citation of citations) {
      if (store.getChapter(citation.chapterId).workId !== request.params.workId) throw new AppError(400, "CITATION_WORK_MISMATCH", "引用章节不属于当前作品");
    }
    data(response, await ai.createSuggestion({
      workId: request.params.workId,
      taskType: input.taskType,
      instruction: instructionWithCitations(input.instruction, citations),
      scope: input.scope as ContextScope,
      ...(input.modelId ? { modelId: input.modelId } : {}),
      ...(input.parameters ? { parameters: input.parameters } : {})
    }), 201);
  });
  app.post("/api/works/:workId/chat/stream", async (request, response) => {
    const input = parse(z.object({
      instruction: nonEmpty.max(100_000),
      scope: contextSchema,
      modelId: identifier.optional(),
      parameters: jsonObject.optional(),
      citations: aiCitationsSchema.optional(),
      conversationId: identifier.optional(),
      currentMessageId: identifier.optional()
    }), request.body);
    const citations = input.citations ?? [];
    for (const citation of citations) {
      if (store.getChapter(citation.chapterId).workId !== request.params.workId) throw new AppError(400, "CITATION_WORK_MISMATCH", "引用章节不属于当前作品");
    }
    const controller = new AbortController();
    response.on("close", () => {
      if (!response.writableEnded) controller.abort(new Error("浏览器已中断流式请求"));
    });
    response.status(200);
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-cache, no-transform");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders();
    const sendEvent = (event: string, payload: unknown): void => {
      if (!response.writableEnded && !response.destroyed) response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    sendEvent("ready", { streaming: true });
    try {
      const suggestion = await ai.createStreamingChat({
        workId: request.params.workId,
        instruction: instructionWithCitations(input.instruction, citations),
        scope: input.scope as ContextScope,
        signal: controller.signal,
        onToolCall: (toolCall, round) => sendEvent("tool_call", { ...toolCall, round }),
        onProcessStep: (step) => sendEvent("process_step", step),
        conversationId: input.conversationId,
        excludeConversationMessageId: input.currentMessageId,
        ...(input.modelId ? { modelId: input.modelId } : {}),
        ...(input.parameters ? { parameters: input.parameters } : {})
      }, (delta) => sendEvent("delta", { delta }));
      sendEvent("complete", {
        suggestionId: suggestion.id,
        callId: suggestion.callId,
        provider: suggestion.provider,
        model: suggestion.model,
        outputTokens: suggestion.outputTokens,
        chapterVersion: suggestion.chapterVersion,
        toolCalls: suggestion.toolCalls,
        processSteps: suggestion.processSteps
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        sendEvent("error", {
          code: error instanceof AppError ? error.code : "AI_STREAM_FAILED",
          message: error instanceof Error ? error.message : "AI 流式调用失败"
        });
      }
    } finally {
      if (!response.writableEnded && !response.destroyed) response.end();
    }
  });
  app.get("/api/suggestions/:suggestionId", (request, response) => data(response, ai.getSuggestion(request.params.suggestionId)));
  app.get("/api/suggestions/:suggestionId/guards", (request, response) => {
    data(response, store.listContinuationGuards(request.params.suggestionId));
  });
  app.post("/api/suggestions/:suggestionId/guard", async (request, response) => {
    const input = parse(z.object({ content: z.string().max(2_000_000).optional() }), request.body ?? {});
    data(response, await ai.runSuggestionGuard(request.params.suggestionId, input.content), 201);
  });
  app.post("/api/suggestions/:suggestionId/accept", (request, response) => {
    const input = parse(z.object({ content: z.string().max(2_000_000).optional() }), request.body ?? {});
    data(response, ai.acceptSuggestion(request.params.suggestionId, input.content));
  });
  app.post("/api/suggestions/:suggestionId/reject", (request, response) => data(response, ai.rejectSuggestion(request.params.suggestionId)));
  app.get("/api/works/:workId/ai-calls", (request, response) => data(response, ai.listCalls(request.params.workId)));

  app.get("/api/works/:workId/search", (request, response) => {
    const query = parse(z.string().trim().min(1).max(500), request.query.q);
    data(response, store.search(request.params.workId, query));
  });
  app.get("/api/works/:workId/export", (request, response) => {
    const format = parse(z.enum(["json", "txt", "markdown"]), request.query.format ?? "json");
    if (format === "json") {
      response.setHeader("Content-Disposition", `attachment; filename=novel-${request.params.workId}.json`);
      data(response, store.exportWork(request.params.workId));
      return;
    }
    response.type(format === "txt" ? "text/plain" : "text/markdown");
    response.setHeader("Content-Disposition", `attachment; filename=novel-${request.params.workId}.${format === "markdown" ? "md" : "txt"}`);
    response.send(store.exportText(request.params.workId, format));
  });
  app.get("/api/works/:workId/audit-logs", (request, response) => data(response, store.listAuditLogs(request.params.workId)));

  if (options.serveUi ?? true) {
    const publicPath = options.publicPath ?? join(process.cwd(), "src", "public");
    // index.html 按登录态动态下发：未登录时注入 login-route 类，首帧直接渲染登录页；
    // 已登录时保持骨架屏，由前端恢复会话后进入工作台，避免两种闪烁。
    const sendIndexHtml = (request: Request, response: Response) => {
      const authenticated = options.disableUserAuth === true || auth.authenticate(request) !== null;
      let html = readFileSync(join(publicPath, "index.html"), "utf8");
      if (!authenticated) html = html.replace('<html lang="zh-CN">', '<html lang="zh-CN" class="login-route">');
      response.setHeader("Cache-Control", "no-store");
      response.type("text/html").send(html);
    };
    app.get(["/", "/index.html"], sendIndexHtml);
    app.use(express.static(publicPath, {
      index: false,
      maxAge: 0,
      setHeaders: (response) => response.setHeader("Cache-Control", "no-store")
    }));
    app.get("/{*path}", (request, response, next) => {
      if (request.path.startsWith("/api/")) return next();
      sendIndexHtml(request, response);
    });
  }

  app.use((_request, _response, next) => next(new AppError(404, "ROUTE_NOT_FOUND", "请求的接口不存在")));
  app.use((error: unknown, request: Request, response: Response, _next: NextFunction) => {
    const commonFields = { method: request.method, path: sanitizeRequestPath(request.path), error: sanitizeError(error) };
    if (error instanceof ZodError) {
      logger.warn("http.request.validation_failed", { ...commonFields, issuePaths: error.issues.map((issue) => issue.path.join(".")) });
      response.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "请求参数不符合要求",
          details: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }))
        }
      });
      return;
    }
    if (error instanceof multer.MulterError) {
      logger.warn("http.request.upload_rejected", { ...commonFields, uploadCode: error.code });
      response.status(400).json({ error: { code: "UPLOAD_ERROR", message: error.message } });
      return;
    }
    if (error instanceof SyntaxError && "status" in error && error.status === 400) {
      logger.warn("http.request.invalid_json", commonFields);
      response.status(400).json({ error: { code: "INVALID_JSON", message: "请求体不是有效的 JSON" } });
      return;
    }
    if (error && typeof error === "object" && "type" in error && error.type === "entity.too.large") {
      logger.warn("http.request.body_too_large", commonFields);
      response.status(413).json({ error: { code: "REQUEST_TOO_LARGE", message: "请求体超过大小限制" } });
      return;
    }
    if (error instanceof AppError) {
      const logFields = { ...commonFields, errorCode: error.code, status: error.status };
      if (error.status >= 500) logger.error("http.request.application_error", logFields);
      else logger.warn("http.request.application_error", logFields);
      response.status(error.status).json({ error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } });
      return;
    }
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
      logger.warn("http.request.duplicate_record", commonFields);
      response.status(409).json({ error: { code: "DUPLICATE_RECORD", message: "记录已存在" } });
      return;
    }
    logger.error("http.request.unhandled_error", commonFields);
    response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "服务器内部错误" } });
  });

  logger.info("runtime.ready", { serveUi: options.serveUi ?? true });
  return { app, database, store, ai, auth, close: () => {
    logger.info("runtime.closing");
    ai.dispose();
    database.close();
    logger.info("runtime.closed");
  } };
}
