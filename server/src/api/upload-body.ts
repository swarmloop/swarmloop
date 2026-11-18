import type { Credentials } from '../auth/auth.service';
import { MAX_UPLOAD_BYTES } from '../contract/attachments';

/** The part of a request this reads: the raw bytes arrive as a stream and end up on `body`. */
interface UploadRequest {
  url?: string;
  body?: unknown;
  headers: Credentials & { 'content-length'?: string };
  query?: { name?: unknown };
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  on(event: 'end' | 'error', listener: () => void): unknown;
  destroy(): unknown;
}

interface UploadResponse {
  status(code: number): { json(body: unknown): void };
  set(name: string, value: string): unknown;
  once(event: 'finish', listener: () => void): unknown;
}

/** Tells whether the request holds a session or the machine token. */
type UploadAccess = (credentials: Credentials) => Promise<boolean>;

export const UPLOAD_PATH = '/uploads';

export function isUploadRoute(method: string, url: string | undefined): boolean {
  return method === 'POST' && (url ?? '').split('?')[0] === UPLOAD_PATH;
}

/** The plain-words refusal of a file above the limit, naming the file. */
function tooLargeText(name: string): string {
  return `${name || 'The file'} is larger than ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB. Send a smaller file.`;
}

/** The refusal of a body above the limit: nothing more is read, and the connection closes once the answer left. */
function refuseLarge(request: UploadRequest, response: UploadResponse): void {
  const name = typeof request.query?.name === 'string' ? request.query.name : '';
  response.set('Connection', 'close');
  response.once('finish', () => request.destroy());
  response.status(413).json({ statusCode: 413, message: tooLargeText(name) });
}

/**
 * The raw body parser of the upload route and of no other: it keeps the bytes of an `application/octet-stream` body
 * as a Buffer on `body`. It runs before the app's guard, so it checks the credentials first and reads nothing for a
 * request that has none. A body above the limit is answered with 413 and the connection closes.
 */
export function uploadBodyParser(allowed: UploadAccess) {
  return (request: UploadRequest, response: UploadResponse, next: (error?: unknown) => void): void => {
    allowed(request.headers).then((ok) => {
      if (!ok) {
        response.status(401).json({ statusCode: 401, message: 'log in first' });
        return;
      }
      if (Number(request.headers['content-length']) > MAX_UPLOAD_BYTES) {
        refuseLarge(request, response);
        return;
      }
      readBody(request, response, next);
    }, next);
  };
}

function readBody(request: UploadRequest, response: UploadResponse, next: (error?: unknown) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let refused = false;
  request.on('data', (chunk) => {
    size += chunk.length;
    if (size <= MAX_UPLOAD_BYTES) {
      chunks.push(chunk);
    } else if (!refused) {
      refused = true;
      chunks.length = 0;
      refuseLarge(request, response);
    }
  });
  request.on('error', () => response.status(400).json({ statusCode: 400, message: 'The upload was cut off.' }));
  request.on('end', () => {
    if (!refused) {
      request.body = Buffer.concat(chunks);
      next();
    }
  });
}
