import express, { type Express, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import mammoth from "mammoth";
import { randomUUID } from "node:crypto";
import { dirname, extname, join } from "node:path";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { z, ZodError } from "zod";
import { AttachmentStorage } from "./attachment-storage.js";
import { AiManager } from "./ai.js";
import { CredentialVault } from "./credential-vault.js";
import { Database } from "./database.js";
import { assertSafeDocxArchive } from "./docx-security.js";
import { TASK_TYPES, type ContextScope, type TaskType } from "./domain.js";
import { AppError } from "./errors.js";
import { applyImportFileHints, parseNovelText } from "./parser.js";
import { Store, versionedEntityTypes } from "./store.js";
import { parsePagination } from "./pagination.js";
import { normalizeUploadFileName } from "./utils.js";
import { assertSafeAiEndpoint, createApiRateLimitMiddleware, createAuthenticationRateLimitMiddleware, createBasicAuthMiddleware, createSameOriginMiddleware, createSecurityHeadersMiddleware, type RuntimeSecurityOptions } from "./security.js";
import { ImageCaptchaService } from "./image-captcha.js";
import { assertSafeImportedPlainText, decodeUtf8ImportedText } from "./import-security.js";
import { InvalidRasterImageError, readRasterImageMetadata } from "./image-metadata.js";
import { createRequestLoggingMiddleware, sanitizeRequestPath } from "./http-logging.js";
import { accountReference, logger, sanitizeError } from "./logger.js";
import { runWithRequestActor } from "./request-context.js";
import { APP_VERSION } from "./version.js";
import { fullWorkModulePermissions, proseReplacementPermissionModules, type WorkModulePermissions } from "./work-permissions.js";
import {
  clearSessionCookie,
  createCliApiScopeMiddleware,
  createUserSessionMiddleware,
  createWorkAuthorizationMiddleware,
  setSessionCookie,
  UserAuthService,
  type AuthUser
} from "./user-auth.js";

const nonEmpty = z.string().trim().min(1);
const identifier = z.string().trim().min(1).max(200);
const optionalStrings = z.array(z.string()).optional();
const jsonObject = z.record(z.string(), z.unknown());
const chapterTypeSchema = z.enum(["正文", "设定", "作者的话", "其他"]);
const versionedEntityTypeSchema = z.enum(versionedEntityTypes);
const maximumImportedTextLength = 20_000_000;
const maximumKnowledgeSectionsLength = 4_000_000;

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
const memberRoleValueSchema = z.enum(["editor", "settings-editor", "viewer"]);
const moduleAccessSchema = z.enum(["none", "read", "write"]);
const modulePermissionsSchema = z.object({
  prose: moduleAccessSchema,
  settings: moduleAccessSchema,
  characters: moduleAccessSchema,
  races: moduleAccessSchema,
  organizations: moduleAccessSchema,
  timeline: moduleAccessSchema,
  relationships: moduleAccessSchema,
  outlines: moduleAccessSchema,
  reviews: moduleAccessSchema,
  "ai-chat": moduleAccessSchema,
  "ai-analysis": moduleAccessSchema,
  "ai-settings": moduleAccessSchema
}).strict();
const memberSchema = z.union([
  z.object({ userId: identifier, permissions: modulePermissionsSchema }).strict(),
  z.object({ userId: identifier, role: memberRoleValueSchema }).strict()
]);
const memberPermissionSchema = z.union([
  z.object({ permissions: modulePermissionsSchema }).strict(),
  z.object({ role: memberRoleValueSchema }).strict()
]);
const profileSchema = z.object({ displayName: z.string().trim().min(1).max(80) }).strict();
const passwordChangeSchema = z.object({ currentPassword: z.string().max(200), newPassword: passwordSchema, passwordConfirmation: passwordSchema }).strict().refine((input) => input.newPassword === input.passwordConfirmation, {
  path: ["passwordConfirmation"],
  message: "两次输入的密码不一致"
});
const changeNoteSchema = z.string().trim().max(500).optional();
const expectedVersionNoSchema = z.coerce.number().int().positive().optional();

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
  code: z.string().trim().max(200).optional(),
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

const characterProfileSectionSchema = z.object({
  sectionType: z.enum(["overview", "appearance", "abilities", "personality", "ecology", "background", "history", "legends", "research", "notes", "custom"]).optional(),
  title: nonEmpty.max(200),
  contentMarkdown: z.string().max(500_000).optional(),
  summary: z.string().max(20_000).optional(),
  sortOrder: z.number().int().min(0).max(100_000).optional(),
  sourcePath: z.string().max(2_000).nullable().optional(),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/u).nullable().optional()
}).strict();

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

const knowledgeSectionSchema = z.object({
  title: nonEmpty.max(200),
  contentMarkdown: z.string().max(200_000).optional(),
  summary: z.string().max(100_000).optional(),
  sortOrder: z.number().int().min(0).max(100_000).optional()
}).strict();

const knowledgeSectionsSchema = knowledgeSectionSchema.array().max(200).superRefine((sections, context) => {
  const totalLength = sections.reduce((total, section) => total + (section.contentMarkdown?.length ?? 0) + (section.summary?.length ?? 0), 0);
  if (totalLength > maximumKnowledgeSectionsLength) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Markdown 章节总长度不能超过 4000000 个字符" });
  }
});

const organizationSchema = z.object({
  name: nonEmpty.max(200),
  description: z.string().max(100_000).optional(),
  settings: z.array(z.string().trim().min(1).max(20_000)).max(200).optional(),
  settingsMarkdown: z.string().max(200_000).optional(),
  settingsSections: knowledgeSectionsSchema.optional(),
  memberIds: z.array(identifier).max(1000).optional()
}).strict();

const raceSchema = z.object({
  name: nonEmpty.max(200),
  parentRaceId: identifier.nullable().optional(),
  description: z.string().max(100_000).optional(),
  settings: z.array(z.string().trim().min(1).max(20_000)).max(200).optional(),
  settingsMarkdown: z.string().max(200_000).optional(),
  settingsSections: knowledgeSectionsSchema.optional(),
  memberIds: z.array(identifier).max(1000).optional()
}).strict();

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
  agentTools: z.array(z.enum(["story_index", "read_chapters", "grep", "query_story_knowledge", "read_character_sections"])).max(5).optional()
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
  attachmentDirectory?: string;
  fetchImpl?: typeof fetch;
  serveUi?: boolean;
  publicPath?: string;
  security?: RuntimeSecurityOptions;
  disableUserAuth?: boolean;
  /** 开发环境专用：使用已有的第一个活动账户进入工作台，不创建会话。 */
  devAuthBypass?: boolean;
  /** 测试用：在验证码接口中回显答案 */
  revealCaptchaAnswer?: boolean;
  /** 当前服务是否由开发模式启动。 */
  developmentServer?: boolean;
};

export type Runtime = {
  app: Express;
  database: Database;
  store: Store;
  ai: AiManager;
  auth: UserAuthService;
  attachmentStorage: AttachmentStorage;
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

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function mapRecords(value: unknown, mapper: (record: Record<string, unknown>) => Record<string, unknown>): unknown {
  if (Array.isArray(value)) return value.map((item) => recordValue(item) ? mapper(item as Record<string, unknown>) : item);
  const record = recordValue(value);
  if (!record) return value;
  if (Array.isArray(record.items)) {
    return { ...record, items: record.items.map((item) => recordValue(item) ? mapper(item as Record<string, unknown>) : item) };
  }
  return mapper(record);
}

function redactCharacterLinks(record: Record<string, unknown>, permissions: WorkModulePermissions): Record<string, unknown> {
  const result = { ...record };
  if (permissions.races === "none") {
    result.raceId = null;
    result.race = null;
    result.species = "";
  }
  if (permissions.organizations === "none") {
    result.organizationIds = [];
    result.organizations = [];
  }
  return result;
}

function redactRaceMembers(record: Record<string, unknown>, permissions: WorkModulePermissions): Record<string, unknown> {
  return permissions.characters === "none" ? { ...record, memberIds: [], members: [] } : record;
}

function redactOrganizationMembers(record: Record<string, unknown>, permissions: WorkModulePermissions): Record<string, unknown> {
  return permissions.characters === "none" ? { ...record, memberIds: [], members: [] } : record;
}

function redactMergeRecords(
  value: unknown,
  mapper: (record: Record<string, unknown>) => Record<string, unknown>
): unknown {
  const record = recordValue(value);
  if (!record) return value;
  return {
    ...record,
    ...(recordValue(record.target) ? { target: mapper(record.target as Record<string, unknown>) } : {}),
    ...(recordValue(record.source) ? { source: mapper(record.source as Record<string, unknown>) } : {})
  };
}

function redactVersionSnapshots(
  value: unknown,
  mapper: (record: Record<string, unknown>) => Record<string, unknown>
): unknown {
  return mapRecords(value, (version) => {
    const snapshot = recordValue(version.snapshot);
    return snapshot ? { ...version, snapshot: mapper(snapshot) } : version;
  });
}

export function createRuntime(options: RuntimeOptions): Runtime {
  logger.info("runtime.initializing", {
    databasePath: options.databasePath,
    serveUi: options.serveUi ?? true,
    userAuthDisabled: options.disableUserAuth === true,
    devAuthBypass: options.devAuthBypass === true,
    deploymentAuthEnabled: Boolean(options.security?.auth),
    sameOriginEnforced: options.security?.enforceSameOrigin ?? true
  });
  const database = new Database(options.databasePath);
  const temporaryAttachmentRoot = options.databasePath === ":memory:" && !options.attachmentDirectory
    ? mkdtempSync(join(tmpdir(), "scriverse-attachments-"))
    : null;
  const attachmentStorage = new AttachmentStorage(
    options.attachmentDirectory ?? temporaryAttachmentRoot ?? join(dirname(options.databasePath), "attachments")
  );
  mkdirSync(attachmentStorage.temporaryDirectory, { recursive: true, mode: 0o700 });
  const auth = new UserAuthService(database);
  const getDevelopmentUser = (): AuthUser | null => options.devAuthBypass
    ? auth.listUsers().find((user) => user.status === "active") ?? null
    : null;
  const store = new Store(database);
  const requestPermissions = (request: Request, workId?: string): WorkModulePermissions => {
    if (!request.authUser) return fullWorkModulePermissions();
    const resolvedWorkId = workId ?? auth.resolveWorkId(request.path) ?? undefined;
    if (!resolvedWorkId) return fullWorkModulePermissions();
    return auth.workModulePermissions(request.authUser, resolvedWorkId, request.authMethod !== "api-key") ?? fullWorkModulePermissions();
  };
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
  const attachmentUpload = multer({
    storage: multer.diskStorage({
      destination: attachmentStorage.temporaryDirectory,
      filename: (_request, _file, callback) => callback(null, randomUUID())
    }),
    limits: { fileSize: 30 * 1024 * 1024, files: 1, fields: 4, fieldSize: 16 * 1024, parts: 5, headerPairs: 100 }
  });

  app.disable("x-powered-by");
  if (options.security?.trustProxy !== undefined) app.set("trust proxy", options.security.trustProxy);
  app.use(createRequestLoggingMiddleware());
  app.use(createSecurityHeadersMiddleware());

  app.get("/api/health", (_request, response) => {
    data(response, {
      status: "ok",
      version: APP_VERSION,
      protocol: "openai-chat-completions",
      development: options.developmentServer === true
    });
  });

  if (options.security?.auth) app.use(createBasicAuthMiddleware(options.security.auth));
  app.use(createAuthenticationRateLimitMiddleware());
  app.use(createApiRateLimitMiddleware(options.security?.apiRateLimit, options.security?.apiRateWindowMs));
  if (options.security?.enforceSameOrigin ?? true) app.use(createSameOriginMiddleware());
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/auth/session", (request, response) => {
    const session = auth.authenticate(request);
    const registrationOpen = options.security?.allowRegistration === true;
    const developmentUser = getDevelopmentUser();
    if (!session && developmentUser) {
      data(response, { authenticated: true, user: developmentUser, csrfToken: null, setupRequired: false, registrationOpen });
      return;
    }
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

  app.get("/api/users", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination ? auth.listUsersPage(pagination) : auth.listUsers());
  });
  app.get("/api/users/directory", (request, response) => {
    const pagination = parsePagination(request.query);
    const query = String(request.query.q ?? "");
    data(response, pagination ? auth.directoryPage(query, pagination) : auth.directory(query));
  });
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

  app.get("/api/works", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination ? store.listWorksPage(pagination) : store.listWorks());
  });
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
  app.get("/api/works/:workId", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination ? store.getWorkDirectoryPage(request.params.workId, pagination) : store.getWorkDirectory(request.params.workId));
  });
  app.get("/api/works/:workId/members", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination ? auth.listMembersPage(request.params.workId, pagination) : auth.listMembers(request.params.workId));
  });
  app.post("/api/works/:workId/members", (request, response) => {
    if (!request.authUser) throw new AppError(401, "AUTH_REQUIRED", "请先登录");
    const input = parse(memberSchema, request.body);
    const permissionInput = "permissions" in input
      ? { permissions: input.permissions as WorkModulePermissions }
      : { role: input.role };
    const members = database.transaction(() => {
      const result = auth.addMember(request.params.workId, input.userId, permissionInput, request.authUser!.userId);
      store.audit(request.params.workId, "work.member-added", "user", input.userId, permissionInput);
      return result;
    });
    data(response, members, 201);
  });
  app.patch("/api/works/:workId/members/:userId", (request, response) => {
    const input = parse(memberPermissionSchema, request.body);
    const permissionInput = "permissions" in input
      ? { permissions: input.permissions as WorkModulePermissions }
      : { role: input.role };
    const members = database.transaction(() => {
      const result = auth.updateMemberPermissions(request.params.workId, request.params.userId, permissionInput);
      store.audit(request.params.workId, "work.member-role-updated", "user", request.params.userId, permissionInput);
      return result;
    });
    data(response, members);
  });
  app.delete("/api/works/:workId/members/:userId", (request, response) => {
    const members = database.transaction(() => {
      const result = auth.removeMember(request.params.workId, request.params.userId);
      store.audit(request.params.workId, "work.member-removed", "user", request.params.userId);
      return result;
    });
    data(response, members);
  });
  app.patch("/api/works/:workId", (request, response) => {
    const { expectedVersionNo, changeNote, ...input } = parse(
      workSchema.partial().extend({ expectedVersionNo: expectedVersionNoSchema, changeNote: changeNoteSchema }).strict(),
      request.body
    );
    data(response, store.updateWork(request.params.workId, input, expectedVersionNo, "manual", null, changeNote));
  });
  app.delete("/api/works/:workId", async (request, response) => {
    const input = parse(z.object({ expectedVersionNo: expectedVersionNoSchema }).strict(), request.body ?? {});
    const removableStorageKeys = store.deleteWork(request.params.workId, input.expectedVersionNo);
    await Promise.all(removableStorageKeys.map((storageKey) => attachmentStorage.remove(storageKey)));
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
    const expectedVersionNo = parse(expectedVersionNoSchema, request.body.expectedVersionNo);
    data(response, store.setWorkCover(String(request.params.workId), mimeType, bytes, expectedVersionNo));
  });
  app.delete("/api/works/:workId/cover", (request, response) => {
    const input = parse(z.object({ expectedVersionNo: expectedVersionNoSchema }).strict(), request.body ?? {});
    store.deleteWorkCover(request.params.workId, input.expectedVersionNo);
    noContent(response);
  });

  app.get("/api/works/:workId/file-versions", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination ? store.listFileVersionsPage(request.params.workId, pagination) : store.listFileVersions(request.params.workId));
  });
  app.post("/api/works/:workId/file-versions/:fileVersionId/restore", (request, response) => {
    const input = parse(z.object({ expectedVersionNo: expectedVersionNoSchema }).strict(), request.body ?? {});
    data(response, store.restoreFileVersion(request.params.workId, request.params.fileVersionId, input.expectedVersionNo));
  });
  app.post("/api/works/:workId/import", upload.single("file"), async (request, response) => {
    if (!request.file) throw new AppError(400, "FILE_REQUIRED", "请选择要导入的 TXT 或 DOCX 文件");
    const originalFileName = normalizeUploadFileName(request.file.originalname);
    const extension = extname(originalFileName).toLocaleLowerCase();
    if (extension !== ".txt" && extension !== ".docx") {
      throw new AppError(415, "UNSUPPORTED_FILE", "MVP 仅支持 TXT 和 DOCX 导入");
    }
    const mode = parse(z.enum(["append", "overwrite"]), request.body.mode ?? "overwrite");
    if (mode === "overwrite" && request.authUser) {
      auth.assertWorkAccess(
        request.authUser,
        String(request.params.workId),
        { write: proseReplacementPermissionModules },
        false,
        request.authMethod !== "api-key"
      );
    }
    const text = validateImportedText(extension === ".docx"
      ? await extractDocxText(request.file.buffer)
      : decodeUtf8ImportedText(request.file.buffer));
    const parsed = applyImportFileHints(parseNovelText(text), originalFileName);
    const expectedVersionNo = parse(expectedVersionNoSchema, request.body.expectedVersionNo);
    data(response, store.importNovel(String(request.params.workId), originalFileName, extension.slice(1), parsed, mode, expectedVersionNo), 201);
  });

  app.post("/api/works/:workId/volumes", (request, response) => {
    const input = parse(z.object({ title: nonEmpty.max(200), kind: z.enum(["main", "prequel", "extra", "epilogue", "appendix"]).optional(), description: z.string().max(5_000).optional(), keywords: z.array(nonEmpty.max(100)).max(100).optional() }), request.body);
    data(response, store.createVolume(request.params.workId, input), 201);
  });
  app.patch("/api/volumes/:volumeId", (request, response) => {
    const input = parse(z.object({ title: nonEmpty.max(200).optional(), kind: z.enum(["main", "prequel", "extra", "epilogue", "appendix"]).optional(), description: z.string().max(5_000).optional(), keywords: z.array(nonEmpty.max(100)).max(100).optional(), sortOrder: z.number().int().min(0).optional(), expectedVersionNo: expectedVersionNoSchema, changeNote: changeNoteSchema }).strict(), request.body);
    const { expectedVersionNo, changeNote, ...volumeInput } = input;
    data(response, store.updateVolume(request.params.volumeId, volumeInput, expectedVersionNo, "manual", null, changeNote));
  });
  app.get("/api/volumes/:volumeId", (request, response) => data(response, store.getVolume(request.params.volumeId)));
  app.delete("/api/volumes/:volumeId", (request, response) => {
    const input = parse(z.object({ expectedVersionNo: expectedVersionNoSchema }).strict(), request.body ?? {});
    store.deleteVolume(request.params.volumeId, input.expectedVersionNo);
    noContent(response);
  });

  app.post("/api/works/:workId/chapters", (request, response) => {
    const input = parse(z.object({ volumeId: identifier, title: nonEmpty.max(300), content: z.string().max(2_000_000).optional(), chapterType: chapterTypeSchema.optional() }), request.body);
    data(response, store.createChapter(request.params.workId, input), 201);
  });
  app.get("/api/chapters/:chapterId", (request, response) => data(response, store.getChapter(request.params.chapterId)));
  app.patch("/api/chapters/:chapterId", (request, response) => {
    const input = parse(z.object({ title: nonEmpty.max(300).optional(), content: z.string().max(2_000_000).optional(), excludedFromAnalysis: z.boolean().optional(), chapterType: chapterTypeSchema.optional(), source: z.enum(["manual", "auto"]).optional(), changeNote: changeNoteSchema, expectedVersionNo: expectedVersionNoSchema }).strict(), request.body);
    const { source, changeNote, expectedVersionNo, ...chapterInput } = input;
    data(response, store.saveChapter(request.params.chapterId, chapterInput, source ?? "manual", null, changeNote, expectedVersionNo));
  });
  app.delete("/api/chapters/:chapterId", (request, response) => {
    const input = parse(z.object({ expectedVersionNo: expectedVersionNoSchema }).strict(), request.body ?? {});
    store.deleteChapter(request.params.chapterId, input.expectedVersionNo);
    noContent(response);
  });
  app.get("/api/chapters/:chapterId/versions", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination ? store.listChapterVersionsPage(request.params.chapterId, pagination) : store.listChapterVersions(request.params.chapterId));
  });
  app.get("/api/chapters/:chapterId/insights", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination ? store.listChapterInsightsPage(request.params.chapterId, pagination) : store.listChapterInsights(request.params.chapterId));
  });
  app.post("/api/chapters/:chapterId/restore", (request, response) => {
    const input = parse(z.object({ versionNo: z.number().int().positive(), expectedVersionNo: expectedVersionNoSchema }).strict(), request.body);
    data(response, store.restoreChapter(request.params.chapterId, input.versionNo, input.expectedVersionNo));
  });
  app.post("/api/chapters/:chapterId/move", (request, response) => {
    const input = parse(z.object({ volumeId: identifier, sortOrder: z.number().int().min(0), expectedVersionNo: expectedVersionNoSchema }).strict(), request.body);
    const { expectedVersionNo, ...moveInput } = input;
    data(response, store.moveChapter(request.params.chapterId, moveInput, expectedVersionNo));
  });

  app.get("/api/works/:workId/outlines", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination ? store.listChapterOutlinesPage(request.params.workId, pagination) : store.listChapterOutlines(request.params.workId));
  });
  app.get("/api/chapters/:chapterId/outline", (request, response) => data(response, store.getChapterOutline(request.params.chapterId)));
  app.put("/api/chapters/:chapterId/outline", (request, response) => {
    const { changeNote, expectedVersionNo, ...input } = parse(chapterOutlineSchema.extend({ changeNote: changeNoteSchema, expectedVersionNo: expectedVersionNoSchema }).strict(), request.body);
    data(response, store.upsertChapterOutline(request.params.chapterId, input, "manual", null, changeNote, expectedVersionNo));
  });
  app.delete("/api/chapters/:chapterId/outline", (request, response) => {
    const input = parse(z.object({ expectedVersionNo: expectedVersionNoSchema }).strict(), request.body ?? {});
    store.deleteChapterOutline(request.params.chapterId, input.expectedVersionNo);
    noContent(response);
  });

  app.get("/api/works/:workId/foreshadows", (request, response) => {
    const query = parse(z.object({
      status: z.enum(["all", "unresolved", "resolved"]).default("all"),
      currentChapterId: identifier.optional()
    }), request.query);
    const pagination = parsePagination(request.query);
    data(response, pagination
      ? store.listForeshadowsPage(request.params.workId, pagination, query.status, query.currentChapterId)
      : store.listForeshadows(request.params.workId, query.status, query.currentChapterId));
  });
  app.post("/api/works/:workId/foreshadows", (request, response) => {
    data(response, store.createForeshadow(request.params.workId, parse(foreshadowSchema, request.body)), 201);
  });
  app.get("/api/foreshadows/:foreshadowId", (request, response) => data(response, store.getForeshadow(request.params.foreshadowId)));
  app.patch("/api/foreshadows/:foreshadowId", (request, response) => {
    const { changeNote, expectedVersionNo, ...input } = parse(foreshadowSchema.partial().extend({ changeNote: changeNoteSchema, expectedVersionNo: expectedVersionNoSchema }).strict(), request.body);
    data(response, store.updateForeshadow(request.params.foreshadowId, input, "manual", null, changeNote, expectedVersionNo));
  });
  app.delete("/api/foreshadows/:foreshadowId", (request, response) => {
    const input = parse(z.object({ expectedVersionNo: expectedVersionNoSchema }).strict(), request.body ?? {});
    store.deleteForeshadow(request.params.foreshadowId, input.expectedVersionNo);
    noContent(response);
  });
  app.post("/api/foreshadows/:foreshadowId/occurrences", (request, response) => {
    const input = parse(foreshadowOccurrenceSchema.extend({ expectedVersionNo: expectedVersionNoSchema }).strict(), request.body);
    const { expectedVersionNo, ...occurrenceInput } = input;
    data(response, store.createForeshadowOccurrence(request.params.foreshadowId, occurrenceInput, expectedVersionNo), 201);
  });
  app.patch("/api/foreshadow-occurrences/:occurrenceId", (request, response) => {
    const input = parse(foreshadowOccurrenceSchema.partial().extend({ expectedVersionNo: expectedVersionNoSchema }).strict(), request.body);
    const { expectedVersionNo, ...occurrenceInput } = input;
    data(response, store.updateForeshadowOccurrence(request.params.occurrenceId, occurrenceInput, expectedVersionNo));
  });
  app.delete("/api/foreshadow-occurrences/:occurrenceId", (request, response) => {
    const input = parse(z.object({ expectedVersionNo: expectedVersionNoSchema }).strict(), request.body ?? {});
    store.deleteForeshadowOccurrence(request.params.occurrenceId, input.expectedVersionNo);
    noContent(response);
  });

  app.get("/api/works/:workId/settings", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination ? store.listSettingsPage(request.params.workId, pagination) : store.listSettings(request.params.workId));
  });
  app.post("/api/works/:workId/settings", (request, response) => data(response, store.createSetting(request.params.workId, parse(settingSchema, request.body)), 201));
  app.get("/api/settings/:settingId", (request, response) => data(response, store.getSetting(request.params.settingId)));
  app.patch("/api/settings/:settingId", (request, response) => {
    const { changeNote, expectedVersionNo, ...input } = parse(settingSchema.partial().extend({ changeNote: changeNoteSchema, expectedVersionNo: expectedVersionNoSchema }).strict(), request.body);
    data(response, store.updateSetting(request.params.settingId, input, "manual", null, changeNote, expectedVersionNo));
  });
  app.delete("/api/settings/:settingId", (request, response) => {
    const input = parse(z.object({ expectedVersionNo: expectedVersionNoSchema }).strict(), request.body ?? {});
    store.deleteSetting(request.params.settingId, input.expectedVersionNo);
    noContent(response);
  });

  app.get("/api/works/:workId/characters", (request, response) => {
    const { includeSections, includeMerged } = parse(z.object({
      includeSections: z.enum(["true", "false"]).default("false"),
      includeMerged: z.enum(["0", "1"]).default("0")
    }), request.query);
    const pagination = parsePagination(request.query);
    const permissions = requestPermissions(request, request.params.workId);
    const characters = pagination
      ? store.listCharactersPage(request.params.workId, pagination, includeSections === "true", includeMerged === "1")
      : store.listCharacters(request.params.workId, includeSections === "true", includeMerged === "1");
    data(response, mapRecords(characters, (character) => redactCharacterLinks(character, permissions)));
  });
  app.post("/api/works/:workId/characters", (request, response) => {
    const character = store.createCharacter(request.params.workId, parse(characterSchema, request.body));
    data(response, redactCharacterLinks(character, requestPermissions(request, request.params.workId)), 201);
  });
  app.get("/api/characters/:characterId", (request, response) => {
    data(response, redactCharacterLinks(store.getCharacter(request.params.characterId), requestPermissions(request)));
  });
  app.patch("/api/characters/:characterId", (request, response) => {
    const { changeNote, expectedVersionNo, ...input } = parse(characterUpdateSchema.extend({ expectedVersionNo: expectedVersionNoSchema }), request.body);
    const character = store.updateCharacter(request.params.characterId, input, "manual", null, changeNote, expectedVersionNo);
    data(response, redactCharacterLinks(character, requestPermissions(request)));
  });
  app.get("/api/characters/:characterId/versions", (request, response) => {
    const pagination = parsePagination(request.query);
    const versions = pagination ? store.listCharacterVersionsPage(request.params.characterId, pagination) : store.listCharacterVersions(request.params.characterId);
    const permissions = requestPermissions(request);
    data(response, redactVersionSnapshots(versions, (snapshot) => redactCharacterLinks(snapshot, permissions)));
  });
  app.post("/api/characters/:characterId/restore", (request, response) => {
    const input = parse(z.object({ versionNo: z.number().int().positive(), expectedVersionNo: expectedVersionNoSchema }).strict(), request.body);
    const character = store.restoreCharacter(request.params.characterId, input.versionNo, input.expectedVersionNo);
    data(response, redactCharacterLinks(character, requestPermissions(request)));
  });
  app.delete("/api/characters/:characterId", (request, response) => {
    const input = parse(z.object({ expectedVersionNo: expectedVersionNoSchema }).strict(), request.body ?? {});
    store.deleteCharacter(request.params.characterId, input.expectedVersionNo);
    noContent(response);
  });
  app.post("/api/characters/:characterId/merge", (request, response) => {
    const input = parse(z.object({
      targetCharacterId: identifier,
      expectedTargetVersionNo: z.number().int().positive(),
      expectedSourceVersionNo: z.number().int().positive()
    }).strict(), request.body);
    const result = store.mergeCharacters({
      reviewId: null,
      sourceCharacterId: request.params.characterId,
      ...input
    });
    const permissions = requestPermissions(request);
    data(response, redactMergeRecords(result, (character) => redactCharacterLinks(character, permissions)));
  });
  app.get("/api/characters/:characterId/sections", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination
      ? store.listCharacterProfileSectionsPage(request.params.characterId, pagination)
      : store.listCharacterProfileSections(request.params.characterId));
  });
  app.post("/api/characters/:characterId/sections", (request, response) => {
    data(response, store.createCharacterProfileSection(
      request.params.characterId,
      parse(characterProfileSectionSchema, request.body)
    ), 201);
  });
  app.get("/api/character-sections/:sectionId", (request, response) => {
    data(response, store.getCharacterProfileSection(request.params.sectionId));
  });
  app.patch("/api/character-sections/:sectionId", (request, response) => {
    const { changeNote, expectedVersionNo, ...input } = parse(
      characterProfileSectionSchema.partial().extend({ changeNote: changeNoteSchema, expectedVersionNo: expectedVersionNoSchema }).strict(),
      request.body
    );
    data(response, store.updateCharacterProfileSection(request.params.sectionId, input, "manual", null, changeNote, expectedVersionNo));
  });
  app.delete("/api/character-sections/:sectionId", (request, response) => {
    const input = parse(z.object({ expectedVersionNo: expectedVersionNoSchema }).strict(), request.body ?? {});
    store.deleteCharacterProfileSection(request.params.sectionId, input.expectedVersionNo);
    noContent(response);
  });
  app.get("/api/character-sections/:sectionId/versions", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination
      ? store.listCharacterProfileSectionVersionsPage(request.params.sectionId, pagination)
      : store.listCharacterProfileSectionVersions(request.params.sectionId));
  });
  app.post("/api/character-sections/:sectionId/restore", (request, response) => {
    const input = parse(z.object({ versionNo: z.number().int().positive(), expectedVersionNo: expectedVersionNoSchema }).strict(), request.body);
    data(response, store.restoreCharacterProfileSection(request.params.sectionId, input.versionNo, input.expectedVersionNo));
  });

  app.get("/api/works/:workId/attachments", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination ? store.listAttachmentsPage(request.params.workId, pagination) : store.listAttachments(request.params.workId));
  });
  app.post("/api/works/:workId/attachments", attachmentUpload.single("file"), async (request, response) => {
    if (!request.file) throw new AppError(400, "FILE_REQUIRED", "请选择要上传的图片附件");
    let storageKey: string | null = null;
    try {
      const stored = await attachmentStorage.ingest(request.file.path);
      storageKey = stored.storageKey;
      const result = store.createAttachment(String(request.params.workId), {
        originalName: normalizeUploadFileName(request.file.originalname),
        ...stored
      });
      data(response, { ...result.attachment, deduplicated: !result.created }, result.created ? 201 : 200);
    } catch (error) {
      if (storageKey) {
        const inUse = Number(database.get("SELECT COUNT(*) AS count FROM attachments WHERE storage_key = ?", storageKey)?.count ?? 0) > 0;
        if (!inUse) await attachmentStorage.remove(storageKey);
      }
      throw error;
    } finally {
      await rm(request.file.path, { force: true });
    }
  });
  app.get("/api/attachments/:attachmentId/content", async (request, response) => {
    const attachment = store.getAttachment(request.params.attachmentId);
    const content = await attachmentStorage.read(String(attachment.storageKey));
    response.setHeader("Content-Type", String(attachment.storedMimeType));
    response.setHeader("Content-Length", String(attachment.storedByteLength));
    response.setHeader("ETag", `"${String(attachment.storedSha256)}"`);
    response.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.send(content);
  });
  app.delete("/api/attachments/:attachmentId", async (request, response) => {
    const deleted = store.deleteAttachment(request.params.attachmentId);
    if (deleted.removeStoredFile) await attachmentStorage.remove(deleted.storageKey);
    noContent(response);
  });

  app.get("/api/works/:workId/races", (request, response) => {
    const pagination = parsePagination(request.query);
    const races = pagination ? store.listRacesPage(request.params.workId, pagination) : store.listRaces(request.params.workId);
    const permissions = requestPermissions(request, request.params.workId);
    data(response, mapRecords(races, (race) => redactRaceMembers(race, permissions)));
  });
  app.post("/api/works/:workId/races", (request, response) => {
    const race = store.createRace(request.params.workId, parse(raceSchema, request.body));
    data(response, redactRaceMembers(race, requestPermissions(request, request.params.workId)), 201);
  });
  app.get("/api/races/:raceId", (request, response) => {
    data(response, redactRaceMembers(store.getRace(request.params.raceId), requestPermissions(request)));
  });
  app.patch("/api/races/:raceId", (request, response) => {
    const { changeNote, expectedVersionNo, ...input } = parse(raceSchema.partial().extend({ changeNote: changeNoteSchema, expectedVersionNo: expectedVersionNoSchema }).strict(), request.body);
    const race = store.updateRace(request.params.raceId, input, "manual", null, changeNote, expectedVersionNo);
    data(response, redactRaceMembers(race, requestPermissions(request)));
  });
  app.delete("/api/races/:raceId", (request, response) => {
    const input = parse(z.object({ expectedVersionNo: expectedVersionNoSchema }).strict(), request.body ?? {});
    store.deleteRace(request.params.raceId, input.expectedVersionNo);
    noContent(response);
  });
  app.post("/api/races/:raceId/merge", (request, response) => {
    const input = parse(z.object({ targetRaceId: identifier }).strict(), request.body);
    const result = store.mergeRaces(request.params.raceId, input.targetRaceId);
    const permissions = requestPermissions(request);
    data(response, redactMergeRecords(result, (race) => redactRaceMembers(race, permissions)));
  });

  app.get("/api/works/:workId/organizations", (request, response) => {
    const pagination = parsePagination(request.query);
    const organizations = pagination ? store.listOrganizationsPage(request.params.workId, pagination) : store.listOrganizations(request.params.workId);
    const permissions = requestPermissions(request, request.params.workId);
    data(response, mapRecords(organizations, (organization) => redactOrganizationMembers(organization, permissions)));
  });
  app.post("/api/works/:workId/organizations", (request, response) => {
    const organization = store.createOrganization(request.params.workId, parse(organizationSchema, request.body));
    data(response, redactOrganizationMembers(organization, requestPermissions(request, request.params.workId)), 201);
  });
  app.get("/api/organizations/:organizationId", (request, response) => {
    data(response, redactOrganizationMembers(store.getOrganization(request.params.organizationId), requestPermissions(request)));
  });
  app.patch("/api/organizations/:organizationId", (request, response) => {
    const { changeNote, expectedVersionNo, ...input } = parse(organizationSchema.partial().extend({ changeNote: changeNoteSchema, expectedVersionNo: expectedVersionNoSchema }).strict(), request.body);
    const organization = store.updateOrganization(request.params.organizationId, input, "manual", null, changeNote, expectedVersionNo);
    data(response, redactOrganizationMembers(organization, requestPermissions(request)));
  });
  app.delete("/api/organizations/:organizationId", (request, response) => {
    const input = parse(z.object({ expectedVersionNo: expectedVersionNoSchema }).strict(), request.body ?? {});
    store.deleteOrganization(request.params.organizationId, input.expectedVersionNo);
    noContent(response);
  });
  app.post("/api/organizations/:organizationId/merge", (request, response) => {
    const input = parse(z.object({ targetOrganizationId: identifier }).strict(), request.body);
    const result = store.mergeOrganizations(request.params.organizationId, input.targetOrganizationId);
    const permissions = requestPermissions(request);
    data(response, redactMergeRecords(result, (organization) => redactOrganizationMembers(organization, permissions)));
  });

  app.get("/api/works/:workId/timeline-tracks", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination ? store.listTimelineTracksPage(request.params.workId, pagination) : store.listTimelineTracks(request.params.workId));
  });
  app.post("/api/works/:workId/timeline-tracks", (request, response) => data(response, store.createTimelineTrack(request.params.workId, parse(timelineTrackSchema, request.body)), 201));
  app.get("/api/timeline-tracks/:trackId", (request, response) => data(response, store.getTimelineTrack(request.params.trackId)));
  app.patch("/api/timeline-tracks/:trackId", (request, response) => {
    const { changeNote, expectedVersionNo, ...input } = parse(timelineTrackSchema.partial().extend({ changeNote: changeNoteSchema, expectedVersionNo: expectedVersionNoSchema }).strict(), request.body);
    data(response, store.updateTimelineTrack(request.params.trackId, input, "manual", null, changeNote, expectedVersionNo));
  });
  app.delete("/api/timeline-tracks/:trackId", (request, response) => {
    const input = parse(z.object({ expectedVersionNo: expectedVersionNoSchema }).strict(), request.body ?? {});
    store.deleteTimelineTrack(request.params.trackId, input.expectedVersionNo);
    noContent(response);
  });

  app.get("/api/works/:workId/timeline", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination ? store.listTimelineEventsPage(request.params.workId, pagination) : store.listTimelineEvents(request.params.workId));
  });
  app.post("/api/works/:workId/timeline", (request, response) => data(response, store.createTimelineEvent(request.params.workId, parse(timelineSchema, request.body)), 201));
  app.post("/api/works/:workId/timeline/merge", (request, response) => {
    const input = parse(z.object({
      eventIds: z.array(identifier).min(2),
      name: nonEmpty.max(300),
      description: z.string().max(100_000).optional(),
      timeLabel: z.string().max(300).optional(),
      timeSort: z.number().finite().nullable().optional(),
      expectedVersionNos: z.record(identifier, z.number().int().positive()).optional()
    }).strict(), request.body);
    const { expectedVersionNos, ...mergeInput } = input;
    data(response, store.mergeTimelineEvents(request.params.workId, input.eventIds, mergeInput, expectedVersionNos), 201);
  });
  app.get("/api/timeline/:eventId", (request, response) => data(response, store.getTimelineEvent(request.params.eventId)));
  app.patch("/api/timeline/:eventId", (request, response) => {
    const { changeNote, expectedVersionNo, ...input } = parse(timelineSchema.partial().extend({ changeNote: changeNoteSchema, expectedVersionNo: expectedVersionNoSchema }).strict(), request.body);
    data(response, store.updateTimelineEvent(request.params.eventId, input, "manual", null, changeNote, expectedVersionNo));
  });
  app.post("/api/timeline/:eventId/split", (request, response) => {
    const input = parse(z.object({
      parts: z.array(z.object({
        name: nonEmpty.max(300),
        description: z.string().max(100_000).optional(),
        timeLabel: z.string().max(300).optional(),
        timeSort: z.number().finite().nullable().optional()
    })).min(2),
      expectedVersionNo: expectedVersionNoSchema
    }).strict(), request.body);
    data(response, store.splitTimelineEvent(request.params.eventId, input.parts, input.expectedVersionNo), 201);
  });
  app.delete("/api/timeline/:eventId", (request, response) => {
    const input = parse(z.object({ expectedVersionNo: expectedVersionNoSchema }).strict(), request.body ?? {});
    store.deleteTimelineEvent(request.params.eventId, input.expectedVersionNo);
    noContent(response);
  });

  app.get("/api/works/:workId/relationships", (request, response) => {
    const confidence = request.query.minimumConfidence ? Number(request.query.minimumConfidence) : 0;
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new AppError(400, "INVALID_CONFIDENCE", "置信度必须在 0 到 1 之间");
    const pagination = parsePagination(request.query);
    data(response, pagination
      ? store.listRelationshipsPage(request.params.workId, pagination, confidence)
      : store.listRelationships(request.params.workId, confidence));
  });
  app.post("/api/works/:workId/relationships", (request, response) => data(response, store.createRelationship(request.params.workId, parse(relationshipSchema, request.body)), 201));
  app.get("/api/relationships/:relationshipId", (request, response) => data(response, store.getRelationship(request.params.relationshipId)));
  app.patch("/api/relationships/:relationshipId", (request, response) => {
    const { changeNote, expectedVersionNo, ...input } = parse(relationshipSchema.partial().extend({ changeNote: changeNoteSchema, expectedVersionNo: expectedVersionNoSchema }).strict(), request.body);
    data(response, store.updateRelationship(request.params.relationshipId, input, "manual", null, changeNote, expectedVersionNo));
  });
  app.delete("/api/relationships/:relationshipId", (request, response) => {
    const input = parse(z.object({ expectedVersionNo: expectedVersionNoSchema }).strict(), request.body ?? {});
    store.deleteRelationship(request.params.relationshipId, input.expectedVersionNo);
    noContent(response);
  });

  app.get("/api/entity-versions/:entityType/:entityId", (request, response) => {
    const input = parse(z.object({ entityType: versionedEntityTypeSchema, entityId: identifier }), request.params);
    const pagination = parsePagination(request.query);
    const versions = pagination
      ? store.listEntityVersionsPage(input.entityType, input.entityId, pagination)
      : store.listEntityVersions(input.entityType, input.entityId);
    const permissions = requestPermissions(request);
    if (input.entityType === "race") {
      data(response, redactVersionSnapshots(versions, (snapshot) => redactRaceMembers(snapshot, permissions)));
      return;
    }
    if (input.entityType === "organization") {
      data(response, redactVersionSnapshots(versions, (snapshot) => redactOrganizationMembers(snapshot, permissions)));
      return;
    }
    data(response, versions);
  });
  app.post("/api/entity-versions/:entityType/:entityId/restore", (request, response) => {
    const params = parse(z.object({ entityType: versionedEntityTypeSchema, entityId: identifier }), request.params);
    const input = parse(z.object({ versionNo: z.number().int().positive(), expectedVersionNo: expectedVersionNoSchema }).strict(), request.body);
    data(response, store.restoreEntityVersion(params.entityType, params.entityId, input.versionNo, input.expectedVersionNo));
  });

  app.get("/api/works/:workId/reviews", (request, response) => {
    const status = typeof request.query.status === "string" ? request.query.status : undefined;
    const pagination = parsePagination(request.query);
    data(response, pagination ? store.listReviewItemsPage(request.params.workId, pagination, status) : store.listReviewItems(request.params.workId, status));
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

  app.get("/api/works/:workId/tasks", (request, response) => {
    const pagination = parsePagination(request.query);
    const summary = request.query.view === "summary";
    data(response, pagination
      ? (summary ? store.listTaskSummariesPage(request.params.workId, pagination) : store.listTasksPage(request.params.workId, pagination))
      : store.listTasks(request.params.workId));
  });
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

  app.get("/api/platform/ai/providers", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination ? ai.listProvidersPage(pagination) : ai.listProviders());
  });
  app.post("/api/platform/ai/providers", (request, response) => data(response, ai.createProvider(parse(providerSchema, request.body)), 201));
  app.get("/api/platform/ai/models", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination ? ai.listPlatformModelsPage(pagination) : ai.listPlatformModels());
  });
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
  app.get("/api/works/:workId/ai-conversations", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination ? store.listAiConversationsPage(request.params.workId, pagination) : store.listAiConversations(request.params.workId));
  });
  app.post("/api/works/:workId/ai-conversations", (request, response) => {
    const input = parse(z.object({ title: z.string().max(200).optional() }), request.body ?? {});
    data(response, store.createAiConversation(request.params.workId, input.title), 201);
  });
  app.get("/api/ai-conversations/:conversationId", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination ? store.getAiConversationPage(request.params.conversationId, pagination) : store.getAiConversation(request.params.conversationId));
  });
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
  app.get("/api/providers/:providerId/models", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination ? ai.listModelsPage(request.params.providerId, pagination) : ai.listModels(request.params.providerId));
  });
  app.post("/api/providers/:providerId/models", (request, response) => data(response, ai.createModel(request.params.providerId, parse(modelSchema, request.body)), 201));
  app.get("/api/models/:modelId", (request, response) => data(response, ai.getModel(request.params.modelId)));
  app.patch("/api/models/:modelId", (request, response) => data(response, ai.updateModel(request.params.modelId, parse(modelSchema.partial(), request.body))));
  app.delete("/api/models/:modelId", (request, response) => {
    ai.deleteModel(request.params.modelId);
    noContent(response);
  });
  app.get("/api/works/:workId/models", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination ? ai.listWorkModelsPage(request.params.workId, pagination) : ai.listWorkModels(request.params.workId));
  });
  app.get("/api/works/:workId/task-defaults", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination ? ai.listTaskDefaultsPage(request.params.workId, pagination) : ai.listTaskDefaults(request.params.workId));
  });
  app.put("/api/works/:workId/task-defaults/:taskType", (request, response) => {
    const taskType = parse(z.enum(TASK_TYPES), request.params.taskType) as TaskType;
    const input = parse(z.object({ modelId: identifier }), request.body);
    data(response, ai.setTaskDefault(request.params.workId, taskType, input.modelId));
  });

  app.get("/api/works/:workId/suggestions", (request, response) => {
    const status = typeof request.query.status === "string" ? request.query.status : undefined;
    const pagination = parsePagination(request.query);
    data(response, pagination ? ai.listSuggestionsPage(request.params.workId, pagination, status) : ai.listSuggestions(request.params.workId, status));
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
    const pagination = parsePagination(request.query);
    data(response, pagination
      ? store.listContinuationGuardsPage(request.params.suggestionId, pagination)
      : store.listContinuationGuards(request.params.suggestionId));
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
  app.get("/api/works/:workId/ai-calls", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination ? ai.listCallsPage(request.params.workId, pagination) : ai.listCalls(request.params.workId));
  });

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
  app.get("/api/works/:workId/audit-logs", (request, response) => {
    const pagination = parsePagination(request.query);
    data(response, pagination ? store.listAuditLogsPage(request.params.workId, pagination) : store.listAuditLogs(request.params.workId));
  });

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
    const vditorPath = join(process.cwd(), "node_modules", "vditor", "dist");
    if (existsSync(vditorPath)) {
      app.use("/vendor/vditor/dist", express.static(vditorPath, {
        index: false,
        maxAge: 0,
        setHeaders: (response) => response.setHeader("Cache-Control", "no-store")
      }));
    }
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
      if (error.code === "LOGIN_LOCKED" && error.details && typeof error.details === "object") {
        const retryAfterSeconds = Number((error.details as Record<string, unknown>).retryAfterSeconds);
        if (Number.isInteger(retryAfterSeconds) && retryAfterSeconds > 0) {
          response.setHeader("Retry-After", String(retryAfterSeconds));
        }
      }
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
  return { app, database, store, ai, auth, attachmentStorage, close: () => {
    logger.info("runtime.closing");
    ai.dispose();
    database.close();
    if (temporaryAttachmentRoot) rmSync(temporaryAttachmentRoot, { recursive: true, force: true });
    logger.info("runtime.closed");
  } };
}
