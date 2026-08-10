export type PresenceClientIdStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;

export const PRESENCE_CLIENT_ID_BEFORE_RELOGIN_KEY: string;

export function createPresenceClientId(storage?: PresenceClientIdStorage | null): string;

export function stagePresenceClientIdForRelogin(
  storage: PresenceClientIdStorage | null | undefined,
  clientId: string
): void;
