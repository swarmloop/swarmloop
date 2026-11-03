import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';

function respond(status: number, body: unknown): void {
  const response = { ok: status < 400, status, json: () => Promise.resolve(body) };
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api', () => {
  it('throws an ApiError with the status and the message of a 404', async () => {
    respond(404, { message: 'run not found' });

    const failure = await api('/runs/missing').catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ status: 404, message: 'run not found' });
  });

  it('joins an array message', async () => {
    respond(400, { message: ['a', 'b'] });

    await expect(api('/runs')).rejects.toMatchObject({ status: 400, message: 'a, b' });
  });

  it('falls back to the HTTP status when there is no message', async () => {
    respond(500, {});

    await expect(api('/runs')).rejects.toMatchObject({ status: 500, message: 'HTTP 500' });
  });

  it('returns the body of a successful response', async () => {
    respond(200, { runs: [] });

    await expect(api('/runs')).resolves.toEqual({ runs: [] });
  });
});
