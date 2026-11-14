import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';

export interface FakeModelApi {
  url: string;
  /** The headers of every request it received. */
  seen: Record<string, string | string[] | undefined>[];
  close(): Promise<void>;
}

/** A model API for specs: `GET /v1/models` answers 200 for the accepted key, as `x-api-key` or a bearer token, and 401 for any other. */
export async function startFakeModelApi(acceptedKey: string): Promise<FakeModelApi> {
  const seen: FakeModelApi['seen'] = [];
  const server: Server = createServer((request, response) => {
    seen.push(request.headers);
    const bearer = String(request.headers.authorization ?? '').replace(/^Bearer /, '');
    const key = request.headers['x-api-key'] ?? bearer;
    response.setHeader('content-type', 'application/json');
    if (key === acceptedKey) {
      response.end(JSON.stringify({ data: [{ id: 'model-1' }] }));
      return;
    }
    response.statusCode = 401;
    response.end(JSON.stringify({ error: { message: 'The key was rejected by the fake model API' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
