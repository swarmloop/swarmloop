import type { NestExpressApplication } from '@nestjs/platform-express';
import { isAllowedHost } from './allowed-hosts';

interface GuardRequest {
  method: string;
  headers: { host?: string; 'content-type'?: string };
}

interface GuardResponse {
  status(code: number): { json(body: unknown): void };
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Refuses a foreign `Host` (421) and any mutating request that is not JSON (415), so a web page cannot send a form. */
function requestGuard(publicUrl: string) {
  return (request: GuardRequest, response: GuardResponse, next: () => void): void => {
    if (!isAllowedHost(request.headers.host, publicUrl)) {
      response.status(421).json({ statusCode: 421, message: 'Misdirected Request' });
      return;
    }
    if (MUTATING.has(request.method) && !/^application\/json\s*(;|$)/i.test(request.headers['content-type'] ?? '')) {
      response.status(415).json({ statusCode: 415, message: 'Only application/json is accepted' });
      return;
    }
    next();
  };
}

/** The app takes JSON bodies only (the urlencoded and text parsers stay off) and answers only to its own hosts. */
export function secureHttp(app: NestExpressApplication, publicUrl: string): void {
  app.use(requestGuard(publicUrl));
  app.useBodyParser('json');
}
