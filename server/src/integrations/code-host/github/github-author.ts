/** The account `/users/{login}` of GitHub says: its id and its name. */
interface GithubUser {
  id?: number;
  login?: string;
  name?: string | null;
}

/**
 * The name of an account and the no-reply address GitHub keeps for it (`<id>+<login>@users.noreply.<host>`).
 * A value is null when the host does not give it.
 */
export async function githubAuthor(
  read: (url: string) => Promise<unknown>,
  root: string,
  login: string,
  host: string,
): Promise<{ name: string | null; email: string | null }> {
  const user = (await read(`${root}/users/${encodeURIComponent(login)}`)) as GithubUser | null;
  const name = user?.name?.trim() || null;
  if (typeof user?.id !== 'number') {
    return { name, email: null };
  }
  return { name, email: `${user.id}+${user.login || login}@users.noreply.${host}` };
}
