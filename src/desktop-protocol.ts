import { APP_VERSION } from "./version.js";
import { SYNC_CONTENT_ENTITY_TYPES } from "./offline-sync.js";
import { compareServerAlignment, type ServerVersionRelation } from "./version-compat.js";

export type DesktopServerCompatibility = "compatible" | "upgrade-required";

export type DesktopServerVersionCheck = {
  relation: ServerVersionRelation;
  compatibility: DesktopServerCompatibility;
};

/**
 * 用 Desktop 上报版本的前三段对齐 Server 要求。四段版本可以解析；
 * 只有前三段更低时才需要升级。无法解析时返回 null，不得当成 upgrade-required。
 */
export function classifyDesktopServerCompatibility(
  desktopVersion: string,
  serverMinimum: string
): DesktopServerVersionCheck | null {
  const relation = compareServerAlignment(desktopVersion, serverMinimum);
  if (!relation) return null;
  return {
    relation,
    compatibility: relation === "older" ? "upgrade-required" : "compatible"
  };
}

export const DESKTOP_PRODUCT_ID = "scriverse";
export const DESKTOP_MINIMUM_VERSION = "0.0.1";
export const DESKTOP_SHELL_PROTOCOL = Object.freeze({ min: 1, max: 1 });
export const DESKTOP_SYNC_PROTOCOL = Object.freeze({
  min: 1,
  max: 1,
  entityTypes: Object.freeze([...SYNC_CONTENT_ENTITY_TYPES]),
  maxMutationBytes: 2_500_000
});

export function desktopCompatibilityMetadata(): {
  product: typeof DESKTOP_PRODUCT_ID;
  serverVersion: string;
  webAssetVersion: string;
  shellProtocol: typeof DESKTOP_SHELL_PROTOCOL;
  minimumDesktopVersion: typeof DESKTOP_MINIMUM_VERSION;
  syncProtocol: typeof DESKTOP_SYNC_PROTOCOL;
} {
  return {
    product: DESKTOP_PRODUCT_ID,
    serverVersion: APP_VERSION,
    webAssetVersion: APP_VERSION,
    shellProtocol: DESKTOP_SHELL_PROTOCOL,
    minimumDesktopVersion: DESKTOP_MINIMUM_VERSION,
    syncProtocol: DESKTOP_SYNC_PROTOCOL
  };
}
