'use client';

import { io, Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@contract/live';

let socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;

export function liveSocket(): Socket<ServerToClientEvents, ClientToServerEvents> {
  if (!socket) {
    socket = io<ServerToClientEvents, ClientToServerEvents>(
      process.env.NEXT_PUBLIC_SWARMLOOP_SOCKET ?? 'http://127.0.0.1:3920',
      {
        transports: ['websocket'],
      },
    );
  }
  return socket;
}
