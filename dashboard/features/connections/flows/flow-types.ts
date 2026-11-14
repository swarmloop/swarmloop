import type { ConnectionCard, ConnectionFlow } from '@contract/connections';

/** What every flow dialog receives: its card and flow, and what to do when it ends. */
export interface FlowDialogProps {
  card: ConnectionCard;
  flow: ConnectionFlow;
  onClose: () => void;
  /** Called after the connection was stored, so the page reloads the cards. */
  onSaved: () => void;
}

export function messageOf(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}
