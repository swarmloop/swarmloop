import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiBaseUrl, socketUrl } from './runtime-config';

afterEach(() => {
  vi.unstubAllEnvs();
  delete window.__SWARMLOOP_SOCKET__;
});

describe('runtime config', () => {
  it('reads both URLs from the env set after the import', () => {
    vi.stubEnv('SWARMLOOP_API_URL', 'http://api.example:1');
    vi.stubEnv('SWARMLOOP_SOCKET_URL', 'http://live.example:2');

    expect(apiBaseUrl()).toBe('http://api.example:1');
    expect(socketUrl()).toBe('http://live.example:2');
  });

  it('defaults both URLs when the env is unset', () => {
    vi.stubEnv('SWARMLOOP_API_URL', undefined);
    vi.stubEnv('SWARMLOOP_SOCKET_URL', undefined);

    expect(apiBaseUrl()).toBe('http://127.0.0.1:3920');
    expect(socketUrl()).toBe('http://127.0.0.1:3920');
  });

  it('prefers the value the server rendered into the page', () => {
    vi.stubEnv('SWARMLOOP_SOCKET_URL', 'http://env.example');
    window.__SWARMLOOP_SOCKET__ = 'http://page.example';

    expect(socketUrl()).toBe('http://page.example');
  });
});
