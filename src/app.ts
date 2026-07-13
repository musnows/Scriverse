import express, { type Express, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import mammoth from "mammoth";
import { extname, join } from "node:path";
import { z, ZodError } from "zod";
import { AiManager } from "./ai.js";
import { CredentialVault } from "./credential-vault.js";
import { Database } from "./database.js";
import { TASK_TYPES, type ContextScope, type TaskType } from "./domain.js";
import { AppError } from "./errors.js";
import { applyImportFileHints, parseNovelText } from "./parser.js";
import { Store } from "./store.js";
import { normalizeUploadFileName } from "./utils.js";
import { assertSafeAiEndpoint, createApiRateLimitMiddleware, createBasicAuthMiddleware, createSameOriginMiddleware, createSecurityHeadersMiddleware, type RuntimeSecurityOptions } from "./security.js";
import { assertSafeImportedPlainText } from "./import-security.js";

const nonEmpty = z.string().trim().min(1);
const identifier = z.string().trim().min(1).max(200);
const optionalStrings = z.array(z.string()).optional();
const jsonObject = z.record(z.string(), z.unknown());
const chapterTypeSchema = z.enum(["正文", "设定", "作者的话", "其他"]);
const maximumImportedTextLength = 20_000_000;

function validateImportedText(text: string): string {
  if (text.length > maximumImportedTextLength) throw new AppError(413, "IMPORT_TEXT_TOO_LARGE", "导入文件解压后的文本超过 2000 万字符限制");
  assertSafeImportedPlainText(text);
  return text;
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
  enabled: z.boolean().optional(),
  note: z.string().max(10_000).optional()
});

const aiPromptSchema = z.object({
  systemPrompt: z.string().max(100_000).optional()
});

const contextSchema = z.object({
  type: z.enum(["selection", "chapter", "volume", "book", "entities"]),
  chapterId: identifier.optional(),
  volumeId: identifier.optional(),
  selection: z.string().max(200_000).optional(),
  characterIds: optionalStrings,
  settingIds: optionalStrings
});

export type RuntimeOptions = {
  databasePath: string;
  masterSecret: string;
  fetchImpl?: typeof fetch;
  serveUi?: boolean;
  security?: RuntimeSecurityOptions;
};

export type Runtime = {
  app: Express;
  database: Database;
  store: Store;
  ai: AiManager;
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
  const database = new Database(options.databasePath);
  const store = new Store(database);
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

  app.disable("x-powered-by");
  if (options.security?.trustProxy !== undefined) app.set("trust proxy", options.security.trustProxy);
  app.use(createSecurityHeadersMiddleware());

  app.get("/api/health", (_request, response) => {
    data(response, { status: "ok", version: "0.1.0", protocol: "openai-chat-completions" });
  });

  if (options.security?.auth) app.use(createBasicAuthMiddleware(options.security.auth));
  app.use(createApiRateLimitMiddleware(options.security?.apiRateLimit, options.security?.apiRateWindowMs));
  if (options.security?.enforceSameOrigin ?? true) app.use(createSameOriginMiddleware());
  app.use(express.json({ limit: "2mb" }));

  app.get("/api/works", (_request, response) => data(response, store.listWorks()));
  app.post("/api/works", (request, response) => data(response, store.createWork(parse(workSchema, request.body)), 201));
  app.post("/api/works/import", upload.single("file"), async (request, response) => {
    if (!request.file) throw new AppError(400, "FILE_REQUIRED", "请选择要导入的 TXT 或 DOCX 文件");
    const originalFileName = normalizeUploadFileName(request.file.originalname);
    const extension = extname(originalFileName).toLocaleLowerCase();
    if (extension !== ".txt" && extension !== ".docx") throw new AppError(415, "UNSUPPORTED_FILE", "仅支持 TXT 和 DOCX 导入");
    const text = validateImportedText(extension === ".docx"
      ? (await mammoth.extractRawText({ buffer: request.file.buffer })).value
      : request.file.buffer.toString("utf8"));
    const parsedNovel = applyImportFileHints(parseNovelText(text), originalFileName);
    const inferredTitle = originalFileName.replace(/\.(txt|docx)$/iu, "").trim() || "未命名作品";
    const input = parse(workSchema, {
      title: typeof request.body.title === "string" && request.body.title.trim() ? request.body.title : inferredTitle,
      author: typeof request.body.author === "string" ? request.body.author : "",
      description: typeof request.body.description === "string" ? request.body.description : ""
    });
    data(response, store.createImportedWork(input, originalFileName, extension.slice(1), parsedNovel), 201);
  });
  app.get("/api/works/:workId", (request, response) => data(response, store.getWorkTree(request.params.workId)));
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
  app.post("/api/works/:workId/import", upload.single("file"), async (request, response) => {
    if (!request.file) throw new AppError(400, "FILE_REQUIRED", "请选择要导入的 TXT 或 DOCX 文件");
    const originalFileName = normalizeUploadFileName(request.file.originalname);
    const extension = extname(originalFileName).toLocaleLowerCase();
    if (extension !== ".txt" && extension !== ".docx") {
      throw new AppError(415, "UNSUPPORTED_FILE", "MVP 仅支持 TXT 和 DOCX 导入");
    }
    const text = validateImportedText(extension === ".docx"
      ? (await mammoth.extractRawText({ buffer: request.file.buffer })).value
      : request.file.buffer.toString("utf8"));
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
    const input = parse(z.object({ title: nonEmpty.max(300).optional(), content: z.string().max(2_000_000).optional(), excludedFromAnalysis: z.boolean().optional(), chapterType: chapterTypeSchema.optional(), source: z.enum(["manual", "auto"]).optional() }), request.body);
    const { source, ...chapterInput } = input;
    data(response, store.saveChapter(request.params.chapterId, chapterInput, source ?? "manual"));
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
    data(response, store.upsertChapterOutline(request.params.chapterId, parse(chapterOutlineSchema, request.body)));
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
    data(response, store.updateForeshadow(request.params.foreshadowId, parse(foreshadowSchema.partial(), request.body)));
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
  app.patch("/api/settings/:settingId", (request, response) => data(response, store.updateSetting(request.params.settingId, parse(settingSchema.partial(), request.body))));
  app.delete("/api/settings/:settingId", (request, response) => {
    store.deleteSetting(request.params.settingId);
    noContent(response);
  });

  app.get("/api/works/:workId/characters", (request, response) => data(response, store.listCharacters(request.params.workId)));
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
    data(response, store.updateRace(request.params.raceId, parse(raceSchema.partial(), request.body)));
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
    data(response, store.updateOrganization(request.params.organizationId, parse(organizationSchema.partial(), request.body)));
  });
  app.delete("/api/organizations/:organizationId", (request, response) => {
    store.deleteOrganization(request.params.organizationId);
    noContent(response);
  });

  app.get("/api/works/:workId/timeline-tracks", (request, response) => data(response, store.listTimelineTracks(request.params.workId)));
  app.post("/api/works/:workId/timeline-tracks", (request, response) => data(response, store.createTimelineTrack(request.params.workId, parse(timelineTrackSchema, request.body)), 201));
  app.get("/api/timeline-tracks/:trackId", (request, response) => data(response, store.getTimelineTrack(request.params.trackId)));
  app.patch("/api/timeline-tracks/:trackId", (request, response) => data(response, store.updateTimelineTrack(request.params.trackId, parse(timelineTrackSchema.partial(), request.body))));
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
  app.patch("/api/timeline/:eventId", (request, response) => data(response, store.updateTimelineEvent(request.params.eventId, parse(timelineSchema.partial(), request.body))));
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
  app.patch("/api/relationships/:relationshipId", (request, response) => data(response, store.updateRelationship(request.params.relationshipId, parse(relationshipSchema.partial(), request.body))));
  app.delete("/api/relationships/:relationshipId", (request, response) => {
    store.deleteRelationship(request.params.relationshipId);
    noContent(response);
  });

  app.get("/api/works/:workId/reviews", (request, response) => {
    const status = typeof request.query.status === "string" ? request.query.status : undefined;
    data(response, store.listReviewItems(request.params.workId, status));
  });
  app.post("/api/works/:workId/reviews", (request, response) => data(response, store.createReviewItem(request.params.workId, parse(reviewSchema, request.body)), 201));
  app.patch("/api/reviews/:reviewId", (request, response) => data(response, store.updateReviewItem(request.params.reviewId, parse(reviewSchema.partial(), request.body))));

  app.get("/api/works/:workId/tasks", (request, response) => data(response, store.listTasks(request.params.workId)));
  app.post("/api/works/:workId/tasks", (request, response) => {
    const input = parse(z.object({ taskType: z.enum(["structure", "chapter-analysis", "character-extraction", "character-summary", "timeline-analysis", "relationship-analysis", "consistency-check", "report-update", "book-analysis"]), scope: jsonObject.optional() }), request.body);
    data(response, store.createTask(request.params.workId, input), 201);
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

  app.get("/api/works/:workId/ai-settings", (request, response) => data(response, store.getWorkAiSettings(request.params.workId)));
  app.patch("/api/works/:workId/ai-settings", (request, response) => data(response, store.updateWorkAiSettings(request.params.workId, parse(aiPromptSchema, request.body))));
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
        outputTokens: z.number().int().min(0).max(10_000_000).optional()
      }).optional()
    }), request.body);
    data(response, store.addAiConversationMessage(request.params.conversationId, input), 201);
  });
  app.post("/api/works/:workId/ai-context-usage", (request, response) => {
    const input = parse(z.object({
      modelId: identifier.optional(),
      taskType: z.enum(TASK_TYPES).default("chat"),
      scope: contextSchema,
      instruction: z.string().max(100_000).default(""),
      citations: aiCitationsSchema.optional()
    }), request.body ?? {});
    data(response, ai.getContextUsage({
      workId: request.params.workId,
      modelId: input.modelId,
      taskType: input.taskType,
      scope: input.scope,
      instruction: instructionWithCitations(input.instruction, input.citations ?? [])
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
      citations: aiCitationsSchema.optional()
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
        ...(input.modelId ? { modelId: input.modelId } : {}),
        ...(input.parameters ? { parameters: input.parameters } : {})
      }, (delta) => sendEvent("delta", { delta }));
      sendEvent("complete", {
        suggestionId: suggestion.id,
        callId: suggestion.callId,
        provider: suggestion.provider,
        model: suggestion.model,
        outputTokens: suggestion.outputTokens,
        chapterVersion: suggestion.chapterVersion
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
    const publicPath = join(process.cwd(), "src", "public");
    app.use(express.static(publicPath, {
      index: "index.html",
      maxAge: 0,
      setHeaders: (response) => response.setHeader("Cache-Control", "no-store")
    }));
    app.get("/{*path}", (request, response, next) => {
      if (request.path.startsWith("/api/")) return next();
      response.sendFile(join(publicPath, "index.html"));
    });
  }

  app.use((_request, _response, next) => next(new AppError(404, "ROUTE_NOT_FOUND", "请求的接口不存在")));
  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof ZodError) {
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
      response.status(400).json({ error: { code: "UPLOAD_ERROR", message: error.message } });
      return;
    }
    if (error instanceof SyntaxError && "status" in error && error.status === 400) {
      response.status(400).json({ error: { code: "INVALID_JSON", message: "请求体不是有效的 JSON" } });
      return;
    }
    if (error && typeof error === "object" && "type" in error && error.type === "entity.too.large") {
      response.status(413).json({ error: { code: "REQUEST_TOO_LARGE", message: "请求体超过大小限制" } });
      return;
    }
    if (error instanceof AppError) {
      response.status(error.status).json({ error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } });
      return;
    }
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
      response.status(409).json({ error: { code: "DUPLICATE_RECORD", message: "记录已存在" } });
      return;
    }
    console.error("Unhandled request error", error);
    response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "服务器内部错误" } });
  });

  return { app, database, store, ai, close: () => database.close() };
}
