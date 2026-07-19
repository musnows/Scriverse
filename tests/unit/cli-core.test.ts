import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cliResourceDefinitions, cliResourceTypes, cliWorkDefinition } from "../../src/cli-contract.js";
import { parseCliArguments, runCli } from "../../src/cli-core.js";

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "scriverse-cli-"));
  roots.push(root);
  return root;
}

function outputCapture(): { stream: { write: (chunk: string) => void }; text: () => string } {
  let value = "";
  return {
    stream: { write: (chunk) => { value += chunk; } },
    text: () => value
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Scriverse CLI 核心", () => {
  it("解析重复选项、等号选项和位置参数", () => {
    const parsed = parseCliArguments([
      "resource", "update", "chapter", "chapter-1",
      "--input=-",
      "--field-file", "content=chapter.txt",
      "--field-file=title=title.txt",
      "--compact"
    ]);
    expect(parsed.positionals).toEqual(["resource", "update", "chapter", "chapter-1"]);
    expect(parsed.options.get("input")).toEqual(["-"]);
    expect(parsed.options.get("field-file")).toEqual(["content=chapter.txt", "title=title.txt"]);
    expect(parsed.options.get("compact")).toEqual(["true"]);
  });

  it("资源契约只开放受控读写动作且不包含删除", () => {
    expect(cliResourceTypes).toHaveLength(11);
    expect(cliWorkDefinition.actions).not.toContain("delete");
    for (const type of cliResourceTypes) {
      expect(cliResourceDefinitions[type].actions).not.toContain("delete");
      expect(cliResourceDefinitions[type].create.example).toBeTruthy();
      expect(cliResourceDefinitions[type].update.example).toBeTruthy();
    }
  });

  it("登录仅在校验 API Key 后写入 0600 配置，并可查询与退出", async () => {
    const root = temporaryRoot();
    const path = join(root, "cli.json");
    const stdout = outputCapture();
    const stderr = outputCapture();
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer scrv_test_key");
      return new Response(JSON.stringify({
        data: {
          authenticated: true,
          apiKeyPrefix: "scrv_test",
          user: { userId: "user-1", username: "writer", displayName: "Writer", role: "user" }
        }
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    expect(await runCli([
      "auth", "login", "--server", "http://127.0.0.1:13210", "--api-key", "scrv_test_key", "--config", path
    ], { fetchImpl, stdout: stdout.stream, stderr: stderr.stream })).toBe(0);
    expect(stderr.text()).toBe("");
    expect(JSON.parse(stdout.text())).toMatchObject({ authenticated: true, apiKeyPrefix: "scrv_test" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      version: 2,
      defaultServer: "http://127.0.0.1:13210",
      servers: {
        "http://127.0.0.1:13210": { apiKey: "scrv_test_key", user: { userId: "user-1" } }
      }
    });

    const statusOutput = outputCapture();
    expect(await runCli(["auth", "status", "--config", path], {
      fetchImpl,
      stdout: statusOutput.stream,
      stderr: stderr.stream
    })).toBe(0);
    expect(JSON.parse(statusOutput.text())).toMatchObject({ authenticated: true, server: "http://127.0.0.1:13210" });

    const logoutOutput = outputCapture();
    expect(await runCli(["auth", "logout", "--config", path], {
      stdout: logoutOutput.stream,
      stderr: stderr.stream
    })).toBe(0);
    expect(JSON.parse(logoutOutput.text())).toMatchObject({ authenticated: false });
  });

  it("保存默认服务器，并允许子命令临时覆盖到已登录的其他服务器", async () => {
    const root = temporaryRoot();
    const path = join(root, "cli.json");
    const stderr = outputCapture();
    const connectOutput = outputCapture();

    expect(await runCli(["connect", "https://default.example.com", "--config", path], {
      stdout: connectOutput.stream,
      stderr: stderr.stream
    })).toBe(0);
    expect(JSON.parse(connectOutput.text())).toMatchObject({
      defaultServer: "https://default.example.com",
      authenticated: false
    });

    const loginOutput = outputCapture();
    const loginFetch = (async () => new Response(JSON.stringify({
      data: {
        authenticated: true,
        apiKeyPrefix: "scrv_ove",
        user: { userId: "user-2", username: "override", displayName: "Override", role: "user" }
      }
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as typeof fetch;
    expect(await runCli([
      "auth", "login",
      "--server", "https://override.example.com",
      "--api-key", "scrv_override",
      "--config", path
    ], {
      fetchImpl: loginFetch,
      stdout: loginOutput.stream,
      stderr: stderr.stream
    })).toBe(0);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      defaultServer: "https://default.example.com",
      servers: { "https://override.example.com": { apiKey: "scrv_override" } }
    });

    writeFileSync(path, JSON.stringify({
      version: 2,
      defaultServer: "https://default.example.com",
      servers: {
        "https://default.example.com": {
          apiKey: "scrv_default",
          apiKeyPrefix: "scrv_def",
          user: { userId: "user-1", username: "default", displayName: "Default", role: "admin" }
        },
        "https://override.example.com": {
          apiKey: "scrv_override",
          apiKeyPrefix: "scrv_ove",
          user: { userId: "user-2", username: "override", displayName: "Override", role: "user" }
        }
      }
    }));
    const requestedUrls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      requestedUrls.push(String(input));
      const server = String(input).startsWith("https://override.example.com") ? "override" : "default";
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer scrv_${server}`);
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;

    expect(await runCli(["work", "list", "--config", path], {
      fetchImpl,
      stdout: outputCapture().stream,
      stderr: stderr.stream
    })).toBe(0);
    expect(await runCli(["work", "list", "--server", "https://override.example.com", "--config", path], {
      fetchImpl,
      stdout: outputCapture().stream,
      stderr: stderr.stream
    })).toBe(0);
    expect(requestedUrls).toEqual([
      "https://default.example.com/api/works",
      "https://override.example.com/api/works"
    ]);
    expect(stderr.text()).toBe("");
  });

  it("解析 serve 选项并启动隔离的数据目录", async () => {
    const root = temporaryRoot();
    const stdout = outputCapture();
    const stderr = outputCapture();
    let received: Record<string, unknown> | null = null;

    expect(await runCli([
      "serve",
      "--host", "0.0.0.0",
      "--port", "14321",
      "--data-dir", "local-data"
    ], {
      cwd: root,
      env: {},
      stdout: stdout.stream,
      stderr: stderr.stream,
      serveImpl: async (options) => {
        received = options;
        return { url: "http://0.0.0.0:14321", port: 14321, dataDirectory: options.dataDirectory, databasePath: options.databasePath };
      }
    })).toBe(0);
    expect(received).toMatchObject({
      host: "0.0.0.0",
      port: 14321,
      dataDirectory: join(root, "local-data"),
      databasePath: join(root, "local-data", "novel.db")
    });
    expect(JSON.parse(stdout.text())).toMatchObject({ running: true, url: "http://0.0.0.0:14321" });
    expect(stderr.text()).toBe("");
  });

  it("通过字段文件和 changeNote 生成适合长正文的版本化编辑请求", async () => {
    const root = temporaryRoot();
    const path = join(root, "cli.json");
    const bodyPath = join(root, "patch.json");
    const contentPath = join(root, "chapter.txt");
    writeFileSync(path, JSON.stringify({
      version: 1,
      server: "http://127.0.0.1:13210",
      apiKey: "scrv_test_key",
      apiKeyPrefix: "scrv_test",
      user: { userId: "user-1", username: "writer", displayName: "Writer", role: "user" }
    }));
    writeFileSync(bodyPath, JSON.stringify({ title: "新标题" }));
    writeFileSync(contentPath, "第一段。\n\n第二段。");
    const stdout = outputCapture();
    const stderr = outputCapture();
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe("http://127.0.0.1:13210/api/chapters/chapter-1");
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(String(init?.body))).toEqual({
        title: "新标题",
        content: "第一段。\n\n第二段。",
        changeNote: "重写章节节奏"
      });
      return new Response(JSON.stringify({ data: { id: "chapter-1", versionNo: 2 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }) as typeof fetch;

    expect(await runCli([
      "resource", "update", "chapter", "chapter-1",
      "--input", bodyPath,
      "--field-file", `content=${contentPath}`,
      "--change-note", "重写章节节奏",
      "--config", path
    ], { fetchImpl, stdout: stdout.stream, stderr: stderr.stream })).toBe(0);
    expect(stderr.text()).toBe("");
    expect(JSON.parse(stdout.text())).toEqual({ id: "chapter-1", versionNo: 2 });
  });

  it("未登录的数据命令和未开放命令返回结构化错误", async () => {
    const root = temporaryRoot();
    const stdout = outputCapture();
    const stderr = outputCapture();
    expect(await runCli(["work", "list", "--config", join(root, "missing.json")], {
      stdout: stdout.stream,
      stderr: stderr.stream
    })).toBe(1);
    expect(JSON.parse(stderr.text())).toMatchObject({ error: { code: "CLI_LOGIN_REQUIRED" } });

    const unknownError = outputCapture();
    expect(await runCli(["users", "list"], { stdout: stdout.stream, stderr: unknownError.stream })).toBe(1);
    expect(JSON.parse(unknownError.text())).toMatchObject({ error: { code: "CLI_COMMAND_UNKNOWN" } });
  });
});
