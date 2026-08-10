export const PRESENCE_CLIENT_ID_BEFORE_RELOGIN_KEY = "scriverse-presence-client-id-before-relogin-v1";

function generatePresenceClientId() {
  if (typeof globalThis.crypto.randomUUID === "function") return globalThis.crypto.randomUUID();
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const value = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function createPresenceClientId(storage) {
  try {
    const stagedClientId = storage?.getItem(PRESENCE_CLIENT_ID_BEFORE_RELOGIN_KEY) ?? "";
    if (stagedClientId) {
      storage?.removeItem(PRESENCE_CLIENT_ID_BEFORE_RELOGIN_KEY);
      return stagedClientId;
    }
  } catch {
    // 浏览器禁用存储时退化为当前页面的新客户端标识
  }
  return generatePresenceClientId();
}

export function stagePresenceClientIdForRelogin(storage, clientId) {
  try {
    storage?.setItem(PRESENCE_CLIENT_ID_BEFORE_RELOGIN_KEY, clientId);
  } catch {
    // 浏览器禁用存储时保持现有刷新行为
  }
}
