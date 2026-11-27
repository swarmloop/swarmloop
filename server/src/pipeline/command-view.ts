import type { CommandState, CommandType, CommandView } from '../contract/command';
import type { CommandEntity } from '../history/entities';

/** The command as its actor reads it, from the stored row. */
export function commandView(stored: CommandEntity): CommandView {
  const result = JSON.parse(stored.result ?? 'null') as {
    value?: unknown;
    error?: { message: string; retryAt?: string };
  } | null;
  return {
    commandId: stored.id,
    type: stored.type as CommandType,
    state: stored.state as CommandState,
    value: result?.value ?? null,
    error: result?.error ? { message: result.error.message, retryAt: result.error.retryAt } : null,
  };
}
