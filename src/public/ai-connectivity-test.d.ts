export type ConnectivityToastType = "info" | "warning" | "error";
export type ConnectivityToast = { message: string; type: ConnectivityToastType };
export type ConnectivityObjectType = "provider" | "model";

export function connectivityTestResultToast(result: unknown, objectType: ConnectivityObjectType): ConnectivityToast;
export function connectivityTestErrorToast(error: unknown, objectType: ConnectivityObjectType): ConnectivityToast;
export function connectivityConfigurationSavedToast(objectType: ConnectivityObjectType): string;
