import { afterEach, describe, expect, it, vi } from 'vitest';

const io = vi.fn(() => ({}));
vi.mock('socket.io-client', () => ({ io }));

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('liveSocket', () => {
  it('connects to the socket URL of the running container', async () => {
    vi.stubEnv('SWARMLOOP_SOCKET_URL', 'http://live.example:7');
    const { liveSocket } = await import('./live');

    liveSocket();

    expect(io).toHaveBeenCalledWith('http://live.example:7', { transports: ['websocket'], withCredentials: true });
  });
});
