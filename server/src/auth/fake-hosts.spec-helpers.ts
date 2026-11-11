import { createServer, type IncomingMessage, type Server } from 'http';
import type { AddressInfo } from 'net';

export interface Seen {
  method: string;
  path: string;
  authorization: string;
  body: string;
}

export interface FakeHost {
  url: string;
  seen: Seen[];
  /** Refresh tokens that no longer work: the next refresh answers `bad_refresh_token`. */
  revoked: Set<string>;
  /** Every secret the fake handed out. */
  secrets: string[];
  stop(): Promise<void>;
}

/**
 * A GitHub and a GitLab in one: the App manifest conversion, the OAuth token endpoint with refresh, the user and
 * installation reads, and a merge request. The OAuth code is the login name; its tokens are `ghu_<name>_<n>` and
 * `ghr_<name>_<n>`, which expire in an hour.
 */
export async function startFakeHosts(): Promise<FakeHost> {
  const seen: Seen[] = [];
  const secrets: string[] = [];
  const revoked = new Set<string>();
  const issued = new Map<string, number>();
  const issue = (name: string) => {
    const count = (issued.get(name) ?? 0) + 1;
    issued.set(name, count);
    const grant = {
      access_token: `ghu_${name}_${count}`,
      refresh_token: `ghr_${name}_${count}`,
      expires_in: 3600,
    };
    secrets.push(grant.access_token, grant.refresh_token);
    return grant;
  };
  const server: Server = createServer((request, response) => {
    void read(request).then((body) => {
      const authorization = String(request.headers.authorization ?? '');
      const path = request.url ?? '';
      seen.push({ method: request.method ?? 'GET', path, authorization, body });
      const send = (value: unknown, status = 200) =>
        response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));
      const name = authorization.replace(/^Bearer ghu_/, '').split('_')[0];
      if (path.includes('/app-manifests/')) {
        secrets.push('fake-client-secret', '-----BEGIN FAKE KEY-----');
        send(
          {
            id: 42,
            slug: 'swarmloop-app',
            client_id: 'Iv.fake',
            client_secret: 'fake-client-secret',
            pem: '-----BEGIN FAKE KEY-----',
          },
          201,
        );
      } else if (path === '/login/oauth/access_token' || path === '/oauth/token') {
        const sent = JSON.parse(body) as { code?: string; refresh_token?: string; grant_type: string };
        if (sent.grant_type === 'refresh_token') {
          const who = String(sent.refresh_token).replace('ghr_', '').split('_')[0];
          send(revoked.has(String(sent.refresh_token)) ? { error: 'bad_refresh_token' } : issue(who));
        } else {
          send(issue(String(sent.code)));
        }
      } else if (path === '/api/v3/user') {
        send({ login: name });
      } else if (path === '/api/v4/user') {
        send({ username: name });
      } else if (path.startsWith('/api/v4/groups')) {
        send([]);
      } else if (path.startsWith('/api/v3/user/orgs')) {
        send([]);
      } else if (path.startsWith('/api/v3/user/installations?')) {
        send({ installations: [{ id: 7, app_id: 42, repository_selection: 'selected' }] });
      } else if (path.startsWith('/api/v3/user/installations/7/repositories') && request.method === 'GET') {
        send({ repositories: [{ full_name: `${name}/site` }] });
      } else if (path.startsWith('/api/v3/user/installations/7/repositories/') && request.method === 'PUT') {
        response.writeHead(204).end();
      } else if (path.startsWith('/api/v3/repos/') && request.method === 'GET') {
        send({ id: 99 });
      } else if (path.endsWith('/pulls') && request.method === 'POST') {
        send({ number: 5, html_url: `https://example.test/pull/5`, body: '' }, 201);
      } else {
        response.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    revoked,
    secrets,
    stop: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function read(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => resolve(body));
  });
}
