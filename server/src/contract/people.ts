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
