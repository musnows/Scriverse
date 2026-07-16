import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { cliResourceDefinitions, cliResourceTypes, cliWorkDefinition, type CliResourceType } from "./cli-contract.js";

type OutputStream = { write(chunk: string): unknown };
type InputStream = NodeJS.ReadableStream & AsyncIterable<Buffer | string>;

type CliDependencies = {
  fetchImpl?: typeof fetch;
  stdin?: InputStream;
  stdout?: OutputStream;
  stderr?: OutputStream;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  homeDirectory?: string;
};

type ParsedArguments = {
  positionals: string[];
  options: Map<string, string[]>;
};

type CliConfig = {
  version: 1;
  server: string;
  apiKey: string;
  apiKeyPrefix: string | null;
  user: {
    userId: string;
    username: string;
    displayName: string;
    role: "admin" | "user";
  };
};

type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH";
  body?: Record<string, unknown>;
  text?: boolean;
};

const booleanOptions = new Set(["compact", "help"]);
const maximumInputBytes = 2_500_000;

export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
  }
}

export function parseCliArguments(args: string[]): ParsedArguments {
  const positionals: string[] = [];
  const options = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index] ?? "";
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const equalsIndex = argument.indexOf("=");
    const name = argument.slice(2, equalsIndex >= 0 ? equalsIndex : undefined);
    if (!name) throw new CliError("CLI_ARGUMENT_INVALID", "选项名称不能为空");
    let value = "true";
    if (equalsIndex >= 0) {
      value = argument.slice(equalsIndex + 1);
    } else if (!booleanOptions.has(name)) {
      const candidate = args[index + 1];
      if (candidate === undefined || candidate.startsWith("--")) {
        throw new CliError("CLI_OPTION_VALUE_REQUIRED", `选项 --${name} 缺少值`);
      }
      value = candidate;
      index += 1;
    }
    const values = options.get(name) ?? [];
    values.push(value);
    options.set(name, values);
  }
  return { positionals, options };
}

function option(parsed: ParsedArguments, name: string): string | undefined {
  return parsed.options.get(name)?.at(-1);
}

function optionValues(parsed: ParsedArguments, name: string): string[] {
  return parsed.options.get(name) ?? [];
}

function assertAllowedOptions(parsed: ParsedArguments, allowed: string[]): void {
  const allowedSet = new Set(["config", "compact", "help", ...allowed]);
  for (const name of parsed.options.keys()) {
    if (!allowedSet.has(name)) throw new CliError("CLI_OPTION_UNKNOWN", `当前命令不支持 --${name}`);
  }
}

function requiredPosition(positionals: string[], index: number, label: string): string {
  const value = positionals[index];
  if (!value) throw new CliError("CLI_ARGUMENT_REQUIRED", `缺少 ${label}`);
  return value;
}

function assertPositionCount(positionals: string[], expected: number): void {
  if (positionals.length > expected) {
    throw new CliError("CLI_ARGUMENT_UNEXPECTED", `存在多余参数：${positionals.slice(expected).join(" ")}`);
  }
}

function emitJson(stream: OutputStream, value: unknown, compact: boolean): void {
  stream.write(`${JSON.stringify(value, null, compact ? 0 : 2)}\n`);
}

function emitText(stream: OutputStream, value: string): void {
  stream.write(value.endsWith("\n") ? value : `${value}\n`);
}

function configPath(parsed: ParsedArguments, dependencies: Required<Pick<CliDependencies, "env" | "cwd" | "homeDirectory">>): string {
  const configured = option(parsed, "config") ?? dependencies.env.SCRIVERSE_CONFIG;
  if (configured) return isAbsolute(configured) ? configured : resolve(dependencies.cwd, configured);
  const base = dependencies.env.XDG_CONFIG_HOME?.trim() || join(dependencies.homeDirectory, ".config");
  return join(base, "scriverse", "cli.json");
}

function normalizeServer(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CliError("CLI_SERVER_INVALID", "服务端地址不是有效 URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new CliError("CLI_SERVER_INVALID", "服务端地址必须是无内嵌凭据的 HTTP 或 HTTPS 地址");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new CliError("CLI_SERVER_INVALID", "服务端地址不能包含路径，请只填写协议、主机和端口");
  }
  return url.origin;
}

function readConfig(path: string): CliConfig {
  if (!existsSync(path)) throw new CliError("CLI_LOGIN_REQUIRED", "请先执行 auth login");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new CliError("CLI_CONFIG_INVALID", `CLI 配置文件无法读取：${path}`);
  }
  if (!parsed || typeof parsed !== "object") throw new CliError("CLI_CONFIG_INVALID", "CLI 配置内容无效");
  const value = parsed as Partial<CliConfig>;
  if (value.version !== 1 || typeof value.server !== "string" || typeof value.apiKey !== "string" || !value.user || typeof value.user.userId !== "string") {
    throw new CliError("CLI_CONFIG_INVALID", "CLI 配置字段不完整，请重新登录");
  }
  return value as CliConfig;
}

function writeConfig(path: string, config: CliConfig): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function readBoundedFile(path: string, cwd: string): string {
  const resolved = isAbsolute(path) ? path : resolve(cwd, path);
  const content = readFileSync(resolved);
  if (content.byteLength > maximumInputBytes) throw new CliError("CLI_INPUT_TOO_LARGE", `输入文件超过 ${maximumInputBytes} 字节限制`);
  return content.toString("utf8");
}

async function readBoundedStdin(stdin: InputStream): Promise<string> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.byteLength;
    if (length > maximumInputBytes) throw new CliError("CLI_INPUT_TOO_LARGE", `标准输入超过 ${maximumInputBytes} 字节限制`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseJsonObject(text: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliError("CLI_INPUT_INVALID", "编辑输入不是有效的 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError("CLI_INPUT_INVALID", "编辑输入必须是 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

async function editInput(parsed: ParsedArguments, dependencies: Required<Pick<CliDependencies, "stdin" | "cwd">>, allowChangeNote: boolean): Promise<Record<string, unknown>> {
  const inputPath = option(parsed, "input");
  const fieldFiles = optionValues(parsed, "field-file");
  if (!inputPath && !fieldFiles.length) {
    throw new CliError("CLI_INPUT_REQUIRED", "请使用 --input <json-file|->，或至少提供一个 --field-file field=path");
  }
  const input = inputPath
    ? parseJsonObject(inputPath === "-" ? await readBoundedStdin(dependencies.stdin) : readBoundedFile(inputPath, dependencies.cwd))
    : {};
  for (const binding of fieldFiles) {
    const separator = binding.indexOf("=");
    const field = separator > 0 ? binding.slice(0, separator) : "";
    const path = separator > 0 ? binding.slice(separator + 1) : "";
    if (!/^[A-Za-z][A-Za-z0-9]*$/u.test(field) || !path) {
      throw new CliError("CLI_FIELD_FILE_INVALID", "--field-file 必须使用 field=path 格式");
    }
    input[field] = readBoundedFile(path, dependencies.cwd);
  }
  const note = option(parsed, "change-note");
  if (note !== undefined) {
    if (!allowChangeNote) throw new CliError("CLI_CHANGE_NOTE_UNSUPPORTED", "当前资源不支持版本说明");
    input.changeNote = note;
  }
  return input;
}

async function apiRequest(fetchImpl: typeof fetch, config: CliConfig, path: string, options: RequestOptions = {}): Promise<unknown> {
  const response = await fetchImpl(`${config.server}${path}`, {
    method: options.method ?? "GET",
    headers: {
      Accept: options.text ? "text/plain" : "application/json",
      Authorization: `Bearer ${config.apiKey}`,
      ...(options.body ? { "Content-Type": "application/json" } : {})
    },
    ...(options.body ? { body: JSON.stringify(options.body) } : {})
  }).catch((error: unknown) => {
    throw new CliError("CLI_NETWORK_ERROR", error instanceof Error ? error.message : "无法连接服务端");
  });
  const text = await response.text();
  if (!response.ok) {
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    const remote = payload && typeof payload === "object" && "error" in payload
      ? (payload as { error?: { code?: unknown; message?: unknown; details?: unknown } }).error
      : undefined;
    throw new CliError(
      typeof remote?.code === "string" ? remote.code : `HTTP_${response.status}`,
      typeof remote?.message === "string" ? remote.message : `服务端请求失败，状态码 ${response.status}`,
      remote?.details
    );
  }
  if (options.text) return text;
  if (!text) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new CliError("CLI_RESPONSE_INVALID", "服务端返回了无效 JSON");
  }
  if (payload && typeof payload === "object" && "data" in payload) return (payload as { data: unknown }).data;
  return payload;
}

function resourceType(value: string): CliResourceType {
  if ((cliResourceTypes as readonly string[]).includes(value)) return value as CliResourceType;
  throw new CliError("CLI_RESOURCE_UNKNOWN", `未知资源类型：${value}`);
}

function encoded(value: string): string {
  return encodeURIComponent(value);
}

function resourceListPath(type: CliResourceType, workId: string): string {
  const suffix: Record<Exclude<CliResourceType, "volume" | "chapter" | "chapter-outline">, string> = {
    setting: "settings",
    character: "characters",
    race: "races",
    organization: "organizations",
    "timeline-track": "timeline-tracks",
    "timeline-event": "timeline",
    relationship: "relationships",
    foreshadow: "foreshadows"
  };
  if (type === "volume" || type === "chapter") return `/api/works/${encoded(workId)}`;
  if (type === "chapter-outline") return `/api/works/${encoded(workId)}/outlines`;
  return `/api/works/${encoded(workId)}/${suffix[type]}${type === "foreshadow" ? "?status=all" : ""}`;
}

function resourceGetPath(type: CliResourceType, id: string): string {
  const prefix: Record<Exclude<CliResourceType, "chapter-outline">, string> = {
    volume: "volumes",
    chapter: "chapters",
    setting: "settings",
    character: "characters",
    race: "races",
    organization: "organizations",
    "timeline-track": "timeline-tracks",
    "timeline-event": "timeline",
    relationship: "relationships",
    foreshadow: "foreshadows"
  };
  if (type === "chapter-outline") return `/api/chapters/${encoded(id)}/outline`;
  return `/api/${prefix[type]}/${encoded(id)}`;
}

function resourceCreatePath(type: CliResourceType, scopeId: string): { path: string; method: "POST" | "PUT" } {
  if (type === "chapter-outline") return { path: `/api/chapters/${encoded(scopeId)}/outline`, method: "PUT" };
  const suffix: Record<Exclude<CliResourceType, "chapter-outline">, string> = {
    volume: "volumes",
    chapter: "chapters",
    setting: "settings",
    character: "characters",
    race: "races",
    organization: "organizations",
    "timeline-track": "timeline-tracks",
    "timeline-event": "timeline",
    relationship: "relationships",
    foreshadow: "foreshadows"
  };
  return { path: `/api/works/${encoded(scopeId)}/${suffix[type]}`, method: "POST" };
}

function resourceUpdatePath(type: CliResourceType, id: string): { path: string; method: "PATCH" | "PUT" } {
  if (type === "chapter-outline") return { path: `/api/chapters/${encoded(id)}/outline`, method: "PUT" };
  return { path: resourceGetPath(type, id), method: "PATCH" };
}

function resourceHistoryPath(type: CliResourceType, id: string): string {
  if (type === "chapter") return `/api/chapters/${encoded(id)}/versions`;
  if (type === "character") return `/api/characters/${encoded(id)}/versions`;
  if (type === "volume") throw new CliError("CLI_ACTION_UNSUPPORTED", "volume 不支持 history");
  return `/api/entity-versions/${encoded(type)}/${encoded(id)}`;
}

function resourceRestorePath(type: CliResourceType, id: string): string {
  if (type === "chapter") return `/api/chapters/${encoded(id)}/restore`;
  if (type === "character") return `/api/characters/${encoded(id)}/restore`;
  if (type === "volume") throw new CliError("CLI_ACTION_UNSUPPORTED", "volume 不支持 restore");
  return `/api/entity-versions/${encoded(type)}/${encoded(id)}/restore`;
}

function summarizeTreeList(type: "volume" | "chapter", tree: unknown): unknown[] {
  if (!tree || typeof tree !== "object" || !Array.isArray((tree as { volumes?: unknown }).volumes)) return [];
  const volumes = (tree as { volumes: Array<Record<string, unknown>> }).volumes;
  if (type === "volume") {
    return volumes.map(({ chapters, ...volume }) => ({ ...volume, chapterCount: Array.isArray(chapters) ? chapters.length : 0 }));
  }
  return volumes.flatMap((volume) => {
    const chapters = Array.isArray(volume.chapters) ? volume.chapters as Array<Record<string, unknown>> : [];
    return chapters.map((chapter) => ({
      id: chapter.id,
      workId: chapter.workId,
      volumeId: volume.id,
      volumeTitle: volume.title,
      title: chapter.title,
      chapterType: chapter.chapterType,
      sortOrder: chapter.sortOrder,
      wordCount: chapter.wordCount,
      versionNo: chapter.versionNo,
      analysisStatus: chapter.analysisStatus,
      updatedAt: chapter.updatedAt
    }));
  });
}

function helpText(): string {
  return `Scriverse CLI

认证：
  scriverse auth login --server <url> [--api-key <key> | --api-key-file <path>]
  scriverse auth status
  scriverse auth logout

查询：
  scriverse work list
  scriverse work get <workId>
  scriverse manuscript get <workId> [--format json|markdown|txt]
  scriverse search <workId> --query <text>
  scriverse audit <workId>

编辑：
  scriverse work create --input <json-file|->
  scriverse work update <workId> --input <json-file|->
  scriverse resource list <type> <workId>
  scriverse resource get <type> <id>
  scriverse resource create <type> <workId|chapterId> --input <json-file|->
  scriverse resource update <type> <id> --input <json-file|-> [--change-note <text>]
  scriverse resource history <type> <id>
  scriverse resource restore <type> <id> --version <number>

AI 编辑辅助：
  scriverse schema list
  scriverse schema show <type>
  --field-file content=chapter.txt 可把长文本写入 JSON 字段

全局选项：
  --config <path>  指定登录配置文件
  --compact        输出单行 JSON
`;
}

function schemaList(): Record<string, unknown> {
  return {
    output: "除 manuscript 的 markdown/txt 外，所有成功结果都输出 JSON；错误输出到 stderr 并返回非零状态码。",
    input: {
      json: "create/update 使用 --input file.json 或 --input - 从标准输入读取 JSON 对象",
      longText: "使用可重复的 --field-file field=path 注入长文本字段",
      history: "版本化资源更新时使用 --change-note 说明修改原因"
    },
    prohibited: ["用户管理", "作品成员管理", "系统管理", "AI 供应商与模型管理", "删除操作", "任意 HTTP 请求"],
    resources: cliResourceTypes.map((type) => ({
      type,
      description: cliResourceDefinitions[type].description,
      scopeArgument: cliResourceDefinitions[type].scopeArgument,
      actions: cliResourceDefinitions[type].actions
    })),
    work: cliWorkDefinition
  };
}

async function execute(parsed: ParsedArguments, dependencies: Required<CliDependencies>): Promise<void> {
  const compact = option(parsed, "compact") === "true";
  const [group, action] = parsed.positionals;
  if (!group || group === "help" || option(parsed, "help") === "true") {
    assertAllowedOptions(parsed, []);
    emitText(dependencies.stdout, helpText());
    return;
  }

  const path = configPath(parsed, dependencies);
  if (group === "auth") {
    if (action === "login") {
      assertAllowedOptions(parsed, ["server", "api-key", "api-key-file"]);
      assertPositionCount(parsed.positionals, 2);
      const server = normalizeServer(option(parsed, "server") ?? "");
      const directKey = option(parsed, "api-key");
      const keyFile = option(parsed, "api-key-file");
      const environmentKey = dependencies.env.SCRIVERSE_API_KEY?.trim();
      const supplied = [directKey, keyFile ? readBoundedFile(keyFile, dependencies.cwd).trim() : undefined, environmentKey].filter((value): value is string => Boolean(value));
      if (supplied.length !== 1) {
        throw new CliError("CLI_API_KEY_REQUIRED", "请通过 --api-key、--api-key-file 或 SCRIVERSE_API_KEY 三者之一提供 API Key");
      }
      const apiKey = supplied[0]!;
      const temporary: CliConfig = {
        version: 1,
        server,
        apiKey,
        apiKeyPrefix: null,
        user: { userId: "", username: "", displayName: "", role: "user" }
      };
      const session = await apiRequest(dependencies.fetchImpl, temporary, "/api/cli/session") as {
        user?: CliConfig["user"];
        apiKeyPrefix?: string | null;
      };
      if (!session.user?.userId) throw new CliError("CLI_RESPONSE_INVALID", "服务端没有返回有效用户信息");
      const config: CliConfig = {
        version: 1,
        server,
        apiKey,
        apiKeyPrefix: session.apiKeyPrefix ?? null,
        user: session.user
      };
      writeConfig(path, config);
      emitJson(dependencies.stdout, { authenticated: true, server, user: config.user, apiKeyPrefix: config.apiKeyPrefix, configPath: path }, compact);
      return;
    }
    if (action === "status") {
      assertAllowedOptions(parsed, []);
      assertPositionCount(parsed.positionals, 2);
      if (!existsSync(path)) {
        emitJson(dependencies.stdout, { authenticated: false, configPath: path }, compact);
        return;
      }
      const config = readConfig(path);
      const session = await apiRequest(dependencies.fetchImpl, config, "/api/cli/session");
      emitJson(dependencies.stdout, { ...(session as Record<string, unknown>), server: config.server, configPath: path }, compact);
      return;
    }
    if (action === "logout") {
      assertAllowedOptions(parsed, []);
      assertPositionCount(parsed.positionals, 2);
      rmSync(path, { force: true });
      emitJson(dependencies.stdout, { authenticated: false, configPath: path }, compact);
      return;
    }
    throw new CliError("CLI_COMMAND_UNKNOWN", "未知 auth 命令");
  }

  if (group === "schema") {
    if (action === "list") {
      assertAllowedOptions(parsed, []);
      assertPositionCount(parsed.positionals, 2);
      emitJson(dependencies.stdout, schemaList(), compact);
      return;
    }
    if (action === "show") {
      assertAllowedOptions(parsed, []);
      const requestedType = requiredPosition(parsed.positionals, 2, "resource type");
      assertPositionCount(parsed.positionals, 3);
      if (requestedType === "work") {
        emitJson(dependencies.stdout, { type: "work", ...cliWorkDefinition }, compact);
        return;
      }
      const type = resourceType(requestedType);
      emitJson(dependencies.stdout, { type, ...cliResourceDefinitions[type] }, compact);
      return;
    }
    throw new CliError("CLI_COMMAND_UNKNOWN", "未知 schema 命令");
  }

  if (!["work", "manuscript", "search", "audit", "resource"].includes(group)) {
    throw new CliError("CLI_COMMAND_UNKNOWN", "未知命令；使用 --help 查看可用命令");
  }
  const config = readConfig(path);
  if (group === "work") {
    if (action === "list") {
      assertAllowedOptions(parsed, []);
      assertPositionCount(parsed.positionals, 2);
      emitJson(dependencies.stdout, await apiRequest(dependencies.fetchImpl, config, "/api/works"), compact);
      return;
    }
    if (action === "get") {
      assertAllowedOptions(parsed, []);
      const workId = requiredPosition(parsed.positionals, 2, "workId");
      assertPositionCount(parsed.positionals, 3);
      emitJson(dependencies.stdout, await apiRequest(dependencies.fetchImpl, config, `/api/works/${encoded(workId)}`), compact);
      return;
    }
    if (action === "create") {
      assertAllowedOptions(parsed, ["input", "field-file"]);
      assertPositionCount(parsed.positionals, 2);
      const body = await editInput(parsed, dependencies, false);
      emitJson(dependencies.stdout, await apiRequest(dependencies.fetchImpl, config, "/api/works", { method: "POST", body }), compact);
      return;
    }
    if (action === "update") {
      assertAllowedOptions(parsed, ["input", "field-file"]);
      const workId = requiredPosition(parsed.positionals, 2, "workId");
      assertPositionCount(parsed.positionals, 3);
      const body = await editInput(parsed, dependencies, false);
      emitJson(dependencies.stdout, await apiRequest(dependencies.fetchImpl, config, `/api/works/${encoded(workId)}`, { method: "PATCH", body }), compact);
      return;
    }
    throw new CliError("CLI_COMMAND_UNKNOWN", "未知 work 命令");
  }

  if (group === "manuscript" && action === "get") {
    assertAllowedOptions(parsed, ["format"]);
    const workId = requiredPosition(parsed.positionals, 2, "workId");
    assertPositionCount(parsed.positionals, 3);
    const format = option(parsed, "format") ?? "json";
    if (!["json", "markdown", "txt"].includes(format)) throw new CliError("CLI_FORMAT_INVALID", "format 必须是 json、markdown 或 txt");
    if (format === "json") {
      emitJson(dependencies.stdout, await apiRequest(dependencies.fetchImpl, config, `/api/works/${encoded(workId)}`), compact);
    } else {
      emitText(dependencies.stdout, String(await apiRequest(dependencies.fetchImpl, config, `/api/works/${encoded(workId)}/export?format=${format}`, { text: true })));
    }
    return;
  }

  if (group === "search") {
    assertAllowedOptions(parsed, ["query"]);
    const workId = requiredPosition(parsed.positionals, 1, "workId");
    assertPositionCount(parsed.positionals, 2);
    const query = option(parsed, "query")?.trim();
    if (!query) throw new CliError("CLI_QUERY_REQUIRED", "请使用 --query 提供搜索词");
    emitJson(dependencies.stdout, await apiRequest(dependencies.fetchImpl, config, `/api/works/${encoded(workId)}/search?q=${encodeURIComponent(query)}`), compact);
    return;
  }

  if (group === "audit") {
    assertAllowedOptions(parsed, []);
    const workId = requiredPosition(parsed.positionals, 1, "workId");
    assertPositionCount(parsed.positionals, 2);
    emitJson(dependencies.stdout, await apiRequest(dependencies.fetchImpl, config, `/api/works/${encoded(workId)}/audit-logs`), compact);
    return;
  }

  if (group === "resource") {
    const type = resourceType(requiredPosition(parsed.positionals, 2, "resource type"));
    const id = requiredPosition(parsed.positionals, 3, action === "list" ? "workId" : (action === "create" ? cliResourceDefinitions[type].scopeArgument : "resource id"));
    assertPositionCount(parsed.positionals, 4);
    if (!cliResourceDefinitions[type].actions.includes(action as never)) {
      throw new CliError("CLI_ACTION_UNSUPPORTED", `${type} 不支持 ${action}`);
    }
    if (action === "list") {
      assertAllowedOptions(parsed, []);
      const result = await apiRequest(dependencies.fetchImpl, config, resourceListPath(type, id));
      emitJson(dependencies.stdout, type === "volume" || type === "chapter" ? summarizeTreeList(type, result) : result, compact);
      return;
    }
    if (action === "get") {
      assertAllowedOptions(parsed, []);
      emitJson(dependencies.stdout, await apiRequest(dependencies.fetchImpl, config, resourceGetPath(type, id)), compact);
      return;
    }
    if (action === "create") {
      assertAllowedOptions(parsed, ["input", "field-file"]);
      const body = await editInput(parsed, dependencies, false);
      const endpoint = resourceCreatePath(type, id);
      emitJson(dependencies.stdout, await apiRequest(dependencies.fetchImpl, config, endpoint.path, { method: endpoint.method, body }), compact);
      return;
    }
    if (action === "update") {
      assertAllowedOptions(parsed, ["input", "field-file", "change-note"]);
      const body = await editInput(parsed, dependencies, type !== "volume");
      const endpoint = resourceUpdatePath(type, id);
      emitJson(dependencies.stdout, await apiRequest(dependencies.fetchImpl, config, endpoint.path, { method: endpoint.method, body }), compact);
      return;
    }
    if (action === "history") {
      assertAllowedOptions(parsed, []);
      emitJson(dependencies.stdout, await apiRequest(dependencies.fetchImpl, config, resourceHistoryPath(type, id)), compact);
      return;
    }
    if (action === "restore") {
      assertAllowedOptions(parsed, ["version"]);
      const version = Number(option(parsed, "version"));
      if (!Number.isInteger(version) || version <= 0) throw new CliError("CLI_VERSION_INVALID", "请使用 --version 提供正整数版本号");
      emitJson(dependencies.stdout, await apiRequest(dependencies.fetchImpl, config, resourceRestorePath(type, id), { method: "POST", body: { versionNo: version } }), compact);
      return;
    }
    throw new CliError("CLI_COMMAND_UNKNOWN", "未知 resource 命令");
  }

  throw new CliError("CLI_COMMAND_UNKNOWN", "未知命令；使用 --help 查看可用命令");
}

export async function runCli(args: string[], inputDependencies: CliDependencies = {}): Promise<number> {
  const dependencies: Required<CliDependencies> = {
    fetchImpl: inputDependencies.fetchImpl ?? fetch,
    stdin: inputDependencies.stdin ?? process.stdin,
    stdout: inputDependencies.stdout ?? process.stdout,
    stderr: inputDependencies.stderr ?? process.stderr,
    env: inputDependencies.env ?? process.env,
    cwd: inputDependencies.cwd ?? process.cwd(),
    homeDirectory: inputDependencies.homeDirectory ?? homedir()
  };
  try {
    await execute(parseCliArguments(args), dependencies);
    return 0;
  } catch (error) {
    const compact = args.includes("--compact");
    if (error instanceof CliError) {
      emitJson(dependencies.stderr, { error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } }, compact);
    } else {
      emitJson(dependencies.stderr, { error: { code: "CLI_INTERNAL_ERROR", message: error instanceof Error ? error.message : "CLI 内部错误" } }, compact);
    }
    return 1;
  }
}
