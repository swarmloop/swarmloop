export type Role = 'admin' | 'member';

/** One personal API token as its owner sees it. The value is never part of it. */
export interface TokenView {
  id: number;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

/** A token just made: the value is shown this once. */
export interface CreatedTokenView extends TokenView {
  value: string;
}

export interface PersonView {
  login: string;
  role: Role;
  createdAt: string;
}

/** The `madeBy` and `startedBy` of rows recorded while the server had a machine token. */
export const LEGACY_MACHINE = 'machine';

/** How a maker is named in a message: a login, or the legacy label for rows from before personal tokens. */
export function personLabel(login: string): string {
  return login === LEGACY_MACHINE ? 'machine (before personal tokens)' : login;
}
