import request from "supertest";
import { describe, expect, it } from "vitest";
import { createRuntime, type Runtime } from "../../src/app.js";
import { DESKTOP_MINIMUM_VERSION } from "../../src/desktop-protocol.js";
import { APP_VERSION } from "../../src/version.js";

const setupToken = "desktop-version-check-setup-token-32ch";
const password = "secure-password-123";
const desktopId = "22222222-2222-4222-8222-222222222222";
const profileId = "11111111-1111-4111-8111-111111111111";

function createRuntimeForDesktopVersion(): Runtime {
  return createRuntime({
    databasePath: ":memory:",
    masterSecret: "desktop-version-check-master-secret-32",
    serveUi: false,
    revealCaptchaAnswer: true,
    security: { enforceSameOrigin: true, setupToken, allowRegistration: true }
  });
}

async function solveCaptcha(app: Runtime["app"]): Promise<{ captchaId: string; captchaAnswer: string }> {
  const response = await request(app).get("/api/auth/captcha").expect(200);
  return { captchaId: response.body.data.captchaId, captchaAnswer: response.body.data.answer };
}

async function desktopAuth(
  runtime: Runtime,
  path: "/api/desktop/auth/register" | "/api/desktop/auth/login",
  username: string,
  clientVersion: string
) {
  const captcha = await solveCaptcha(runtime.app);
  return request(runtime.app).post(path).send({
    username,
    password,
    ...(path === "/api/desktop/auth/register" ? { passwordConfirmation: password, setupToken } : {}),
    desktopId,
    profileId,
    clientVersion,
    ...captcha
  });
}

describe("Desktop 上报版本检查", () => {
  it("接受对齐当前 Server 的四段版本，并只拒绝前三段更低的客户端", async () => {
    const runtime = createRuntimeForDesktopVersion();
    try {
      const health = await request(runtime.app).get("/api/health").expect(200);
      expect(health.body.data.version).toBe(APP_VERSION);
      expect(health.body.data.serverVersion).toBe(APP_VERSION);
      expect(String(health.body.data.serverVersion).split(".")).toHaveLength(3);
      expect(health.body.data.minimumDesktopVersion).toBe(DESKTOP_MINIMUM_VERSION);

      const registered = await desktopAuth(runtime, "/api/desktop/auth/register", "desktop_author", "1.1.7.1");
      expect(registered.status).toBe(201);
      expect(runtime.database.get(
        "SELECT client_version FROM user_desktop_sessions WHERE desktop_id = ?",
        desktopId
      )).toEqual({ client_version: "1.1.7.1" });

      const newerDesktop = await desktopAuth(runtime, "/api/desktop/auth/login", "desktop_author", "1.1.8.0");
      expect(newerDesktop.status).toBe(200);
      expect(runtime.database.get(
        "SELECT client_version FROM user_desktop_sessions WHERE revoked_at IS NULL AND desktop_id = ?",
        desktopId
      )).toEqual({ client_version: "1.1.8.0" });

      const olderDesktop = await desktopAuth(runtime, "/api/desktop/auth/login", "desktop_author", "0.0.0.1");
      expect(olderDesktop.status).toBe(409);
      expect(olderDesktop.body.error).toMatchObject({
        code: "DESKTOP_UPGRADE_REQUIRED",
        message: `当前 Desktop 版本过低，Server 要求至少 ${DESKTOP_MINIMUM_VERSION}`
      });

      const unparsed = await desktopAuth(runtime, "/api/desktop/auth/login", "desktop_author", "latest");
      expect(unparsed.status).toBe(200);
    } finally {
      await runtime.close();
    }
  });
});
