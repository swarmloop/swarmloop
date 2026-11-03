import { EventEmitter } from 'node:events';
import { vi } from 'vitest';

const sent = vi.fn();

/** The socket.io-client members the dashboard uses. `emit` records what the client sends. */
export const fakeSocket = Object.assign(new EventEmitter(), { connected: false, emit: sent });

/** Delivers a server event to the listeners the code registered with `on`. */
export function receive(event: string, ...args: unknown[]): void {
  EventEmitter.prototype.emit.call(fakeSocket, event, ...args);
}

export function fakeLive(): { liveSocket: () => typeof fakeSocket } {
  return { liveSocket: () => fakeSocket };
}

export function resetFakeSocket(): void {
  fakeSocket.removeAllListeners();
  fakeSocket.connected = false;
  sent.mockClear();
}
