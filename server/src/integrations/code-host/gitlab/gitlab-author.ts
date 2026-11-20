/** One row of `/users?username=` of GitLab: the account's id, username and name. */
interface GitlabUser {
  id?: number;
  username?: string;
  name?: string | null;
}

/** The signed-in account `/user` says, and one row of `/user/emails`. */
interface GitlabSelf {
  username?: string;
  commit_email?: string | null;
  email?: string | null;
}
interface GitlabEmail {
  email?: string;
  confirmed_at?: string | null;
}

/**
 * The name of an account and the no-reply address GitLab keeps for it (`<id>-<username>@users.noreply.<host>`). With no
 * id the address is the email of the person's own connection: the commit email `/user` shows, else its email, else the
 * first confirmed one. A value is null when the host does not give it. `own` reads with the person's connection and
 * answers null for a refusal of the host.
 */
export async function gitlabAuthor(
  read: (url: string) => Promise<unknown>,
  own: (url: string) => Promise<unknown>,
  root: string,
  username: string,
  host: string,
): Promise<{ name: string | null; email: string | null }> {
  const rows = (await read(`${root}/api/v4/users?username=${encodeURIComponent(username)}`)) as GitlabUser[] | null;
  const user = Array.isArray(rows) ? rows.find((row) => row?.username === username) : undefined;
  const name = user?.name?.trim() || null;
  if (typeof user?.id === 'number') {
    return { name, email: `${user.id}-${username}@users.noreply.${host}` };
  }
  const self = (await own(`${root}/api/v4/user`)) as GitlabSelf | null;
  if (self?.username !== username) {
    return { name, email: null };
  }
  if (self.commit_email || self.email) {
    return { name, email: self.commit_email || self.email || null };
  }
  const emails = (await own(`${root}/api/v4/user/emails`)) as GitlabEmail[] | null;
  const confirmed = Array.isArray(emails) ? emails.find((row) => row?.confirmed_at) : undefined;
  return { name, email: confirmed?.email ?? null };
}
