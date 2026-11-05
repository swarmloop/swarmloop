export const RUNTIME_NAMES = ['cursor', 'claude', 'codex'] as const;

export type RuntimeName = (typeof RUNTIME_NAMES)[number];
