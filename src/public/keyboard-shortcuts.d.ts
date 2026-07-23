export type KeyboardShortcutEvent = {
  key?: unknown;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
};

export function isGlobalSearchShortcut(event?: KeyboardShortcutEvent | null): boolean;
