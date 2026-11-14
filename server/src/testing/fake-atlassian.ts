import { createServer } from 'http';
import type { ServerResponse } from 'http';
import type { AddressInfo } from 'net';

interface FakeAtlassianAccount {
  email: string;
  token: string;
  name: string;
}

interface FakeAtlassianContent {
  /** The issues Jira knows, by key: the summary, and a page address its description links to, where `{base}` is this site. */
  issues?: Record<string, { summary: string; pageUrl?: string }>;
  /** The Confluence pages by id, with their titles. */
  pages?: Record<string, string>;
}

/** One request the fake saw: the path and the `Authorization` header it carried. */
export interface FakeAtlassianRequest {
  path: string;
  authorization: string | null;
}

export interface FakeAtlassian {
  base: string;
  requests: FakeAtlassianRequest[];
  /** The `Authorization` headers of the requests whose path starts with the given text, in order. */
  authorizations(prefix: string): (string | null)[];
  close(): Promise<void>;
}

const PROJECT = /^\/rest\/api\/3\/project\/([^/]+)$/;
const ISSUE = /^\/rest\/api\/3\/issue\/([^/]+)$/;
const COMMENTS = /^\/rest\/api\/3\/issue\/[^/]+\/comment$/;
const PAGE = /^\/wiki\/rest\/api\/content\/([^/]+)$/;

/** A local Jira and Confluence that checks Basic auth per account and answers a bad login with Atlassian's own 401 message. */
export async function startFakeAtlassian(
  accounts: FakeAtlassianAccount[],
  content: FakeAtlassianContent = {},
): Promise<FakeAtlassian> {
  const requests: FakeAtlassianRequest[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const authorization = req.headers.authorization ?? null;
    requests.push({ path: url.pathname, authorization });
    const account = accounts.find((item) => matches(authorization, item));
    if (!account) {
      send(res, 401, { message: 'Client must be authenticated to access this resource.' });
      return;
    }
    answer(res, url.pathname, account, content, `http://${req.headers.host ?? ''}`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    authorizations: (prefix) =>
      requests.filter((request) => request.path.startsWith(prefix)).map((request) => request.authorization),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function matches(authorization: string | null, account: FakeAtlassianAccount): boolean {
  const expected = Buffer.from(`${account.email}:${account.token}`).toString('base64');
  return authorization === `Basic ${expected}`;
}

function answer(
  res: ServerResponse,
  path: string,
  account: FakeAtlassianAccount,
  content: FakeAtlassianContent,
  base: string,
): void {
  const issues = content.issues ?? {};
  const pages = content.pages ?? {};
  const issue = path.match(ISSUE)?.[1];
  const page = path.match(PAGE)?.[1];
  const project = path.match(PROJECT)?.[1];
  if (path === '/rest/api/3/myself') {
    send(res, 200, { displayName: account.name, emailAddress: account.email });
  } else if (path === '/rest/api/3/project/search') {
    send(res, 200, { values: [{ key: 'PROJ', name: 'Project' }] });
  } else if (project) {
    send(res, project === 'PROJ' ? 200 : 404, {});
  } else if (path === '/rest/api/3/field') {
    send(res, 200, []);
  } else if (COMMENTS.test(path)) {
    send(res, 200, { comments: [], total: 0 });
  } else if (issue && issues[issue] !== undefined) {
    send(res, 200, {
      key: issue,
      fields: { summary: issues[issue].summary, description: linkTo(issues[issue].pageUrl, base) },
    });
  } else if (path === '/wiki/rest/api/user/current') {
    send(res, 200, { displayName: account.name, email: account.email });
  } else if (path === '/wiki/rest/api/space') {
    send(res, 200, { results: [{ key: 'ENG', name: 'Engineering' }] });
  } else if (page && pages[page] !== undefined) {
    send(res, 200, { title: pages[page], body: { storage: { value: `<p>${pages[page]}</p>` } } });
  } else {
    send(res, 404, { message: 'Not found' });
  }
}

/** An Atlassian document whose one paragraph links to the address. */
function linkTo(address: string | undefined, base: string): unknown {
  if (!address) {
    return null;
  }
  const url = address.replace('{base}', base);
  const text = { type: 'text', text: 'the page', marks: [{ type: 'link', attrs: { href: url } }] };
  return { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [text] }] };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}
