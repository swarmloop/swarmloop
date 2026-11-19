/** One row of `/users?username=` of GitLab: the account's id, username and name. */
interface GitlabUser {
  id?: number;
  username?: string;
  name?: string | null;
}

/**
 * The name of an account and the no-reply address GitLab keeps for it (`<id>-<username>@users.noreply.<host>`).
 * A value is null when the host does not give it.
 */
export async function gitlabAuthor(
  read: (url: string) => Promise<unknown>,
  root: string,
  username: string,
  host: string,
): Promise<{ name: string | null; email: string | null }> {
  const rows = (await read(`${root}/api/v4/users?username=${encodeURIComponent(username)}`)) as GitlabUser[] | null;
  const user = Array.isArray(rows) ? rows.find((row) => row?.username === username) : undefined;
  const name = user?.name?.trim() || null;
  if (typeof user?.id !== 'number') {
    return { name, email: null };
  }
  return { name, email: `${user.id}-${username}@users.noreply.${host}` };
}
