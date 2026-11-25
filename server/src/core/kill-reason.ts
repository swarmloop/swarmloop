export const KILL_REASONS = ['time', 'idle', 'usd', 'tokens', 'calls', 'loop'] as const;

export type KillReason = (typeof KILL_REASONS)[number];
