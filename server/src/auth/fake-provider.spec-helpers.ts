import { createServer, type IncomingMessage, type Server } from 'http';
import type { AddressInfo } from 'net';

/** A GitHub that answers the OAuth calls. The code is the login name; its token is `tok-<name>`. */
export async function startFakeGithub(orgs: Record<string, string[]>): Promise<{ url: string; stop(): Promise<void> }> {
  const server: Server = createServer((request, response) => {
    void read(request).then((body) => {
      const send = (value: unknown) =>
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));
      const name = String(request.headers.authorization ?? '').replace('Bearer tok-', '');
      if (request.url === '/login/oauth/access_token') {
        const { code } = JSON.parse(body) as { code: string };
        send({ access_token: `tok-${code}` });
      } else if (request.url === '/api/v3/user') {
        send({ login: name });
      } else if (request.url?.startsWith('/api/v3/user/orgs')) {
        send((orgs[name] ?? []).map((login) => ({ login })));
      } else {
        response.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
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
