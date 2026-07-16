import { AsyncLocalStorage } from "node:async_hooks";

export type RequestActor = {
  userId: string;
  username: string;
  displayName: string;
  role: "admin" | "user";
  authentication?: "session" | "api-key";
};

const actorStorage = new AsyncLocalStorage<RequestActor | null>();

export function runWithRequestActor<T>(actor: RequestActor | null, operation: () => T): T {
  return actorStorage.run(actor, operation);
}

export function currentRequestActor(): RequestActor | null {
  return actorStorage.getStore() ?? null;
}
