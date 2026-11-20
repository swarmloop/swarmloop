/** The account `/users/{login}` of GitHub says: its id and its name. */
interface GithubUser {
  id?: number;
  login?: string;
  name?: string | null;
}

/** The signed-in account `/user` says, and one row of `/user/emails`. */
interface GithubSelf {
  login?: string;
  email?: string | null;
}
interface GithubEmail {
  email?: string;
  primary?: boolean;
  verified?: boolean;
}

/**
 * The name of an account and the no-reply address GitHub keeps for it (`<id>+<login>@users.noreply.<host>`). With no
 * id the address is the email of the person's own connection: the one `/user` shows, else the primary verified one.
 * A value is null when the host does not give it. `own` reads with the person's connection and answers null for a
 * refusal of the host, as a token with no email scope gets.
 */
export async function githubAuthor(
  read: (url: string) => Promise<unknown>,
  own: (url: string) => Promise<unknown>,
  root: string,
  login: string,
  host: string,
): Promise<{ name: string | null; email: string | null }> {
  const user = (await read(`${root}/users/${encodeURIComponent(login)}`)) as GithubUser | null;
  const name = user?.name?.trim() || null;
  if (typeof user?.id === 'number') {
    return { name, email: `${user.id}+${user.login || login}@users.noreply.${host}` };
  }
  const self = (await own(`${root}/user`)) as GithubSelf | null;
  if (self?.login?.toLowerCase() !== login.toLowerCase()) {
    return { name, email: null };
  }
  if (self.email) {
    return { name, email: self.email };
  }
  const emails = (await own(`${root}/user/emails`)) as GithubEmail[] | null;
  const primary = Array.isArray(emails) ? emails.find((row) => row?.primary && row.verified) : undefined;
  return { name, email: primary?.email ?? null };
}
