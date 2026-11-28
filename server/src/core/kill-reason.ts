/** The ceilings of the agent's own work: a visit they end counts as finished on its input. */
export const KILL_REASONS = ['time', 'idle', 'usd', 'tokens', 'loop'] as const;

/** A launch ended for paid use past the plan is a provider limit, so a wait that runs again, not one of the agent's own ceilings. */
export type KillReason = (typeof KILL_REASONS)[number] | 'paid use';
