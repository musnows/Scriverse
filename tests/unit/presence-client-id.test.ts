import { describe, expect, it } from "vitest";
import {
  createPresenceClientId,
  PRESENCE_CLIENT_ID_BEFORE_RELOGIN_KEY,
  stagePresenceClientIdForRelogin
} from "../../src/public/presence-client-id.js";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => { values.delete(key); },
    setItem: (key: string, value: string) => { values.set(key, value); },
    values
  };
}

describe("协作客户端标识", () => {
  it("没有暂存值时为每次页面加载生成新的 UUID", () => {
    const storage = memoryStorage();
    const first = createPresenceClientId(storage);
    const second = createPresenceClientId(storage);

    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(second).toMatch(/^[0-9a-f-]{36}$/u);
    expect(second).not.toBe(first);
  });

  it("只在重登录后的第一次页面加载复用并消费旧标识", () => {
    const storage = memoryStorage();
    const previousClientId = "2a6008db-3e39-44a4-a556-42c9979e82e1";
    stagePresenceClientIdForRelogin(storage, previousClientId);

    expect(storage.values.get(PRESENCE_CLIENT_ID_BEFORE_RELOGIN_KEY)).toBe(previousClientId);
    expect(createPresenceClientId(storage)).toBe(previousClientId);
    expect(storage.values.has(PRESENCE_CLIENT_ID_BEFORE_RELOGIN_KEY)).toBe(false);
    expect(createPresenceClientId(storage)).not.toBe(previousClientId);
  });

  it("存储不可用时静默退化为新标识", () => {
    const unavailableStorage = {
      getItem: () => { throw new Error("storage unavailable"); },
      removeItem: () => { throw new Error("storage unavailable"); },
      setItem: () => { throw new Error("storage unavailable"); }
    };

    expect(() => stagePresenceClientIdForRelogin(unavailableStorage, "client-id")).not.toThrow();
    expect(createPresenceClientId(unavailableStorage)).toMatch(/^[0-9a-f-]{36}$/u);
  });
});
