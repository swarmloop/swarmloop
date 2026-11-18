/** Why the server stopped answering: its own main loop was blocked, or the whole machine paused. */
export type ServerStallKind = 'server-blocked' | 'host-paused';

export const STALL_KIND_WORDS: Record<ServerStallKind, string> = {
  'server-blocked': 'server blocked',
  'host-paused': 'machine paused',
};
