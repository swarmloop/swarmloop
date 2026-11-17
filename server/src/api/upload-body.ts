import { MAX_UPLOAD_BYTES } from '../contract/attachments';

/** The part of a request this reads: the raw bytes arrive as a stream and end up on `body`. */
interface UploadRequest {
  url?: string;
  body?: unknown;
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  on(event: 'end' | 'error', listener: () => void): unknown;
}

interface UploadResponse {
  status(code: number): { json(body: unknown): void };
}

export const UPLOAD_PATH = '/uploads';

export function isUploadRoute(method: string, url: string | undefined): boolean {
  return method === 'POST' && (url ?? '').split('?')[0] === UPLOAD_PATH;
}

/** The plain-words refusal of a file above the limit, naming the file. */
function tooLargeText(name: string): string {
  return `${name || 'The file'} is larger than ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB. Send a smaller file.`;
}

/**
 * The raw body parser of the upload route and of no other: it keeps the bytes of an `application/octet-stream` body
 * as a Buffer on `body`. A body above the limit is read to its end without being kept and answered with 413.
 */
export function uploadBodyParser(
  request: UploadRequest & { query?: { name?: unknown } },
  response: UploadResponse,
  next: () => void,
): void {
  const chunks: Buffer[] = [];
  let size = 0;
  request.on('data', (chunk) => {
    size += chunk.length;
    if (size <= MAX_UPLOAD_BYTES) {
      chunks.push(chunk);
    }
  });
  request.on('error', () => response.status(400).json({ statusCode: 400, message: 'The upload was cut off.' }));
  request.on('end', () => {
    if (size > MAX_UPLOAD_BYTES) {
      const name = typeof request.query?.name === 'string' ? request.query.name : '';
      response.status(413).json({ statusCode: 413, message: tooLargeText(name) });
      return;
    }
    request.body = Buffer.concat(chunks);
    next();
  });
}
