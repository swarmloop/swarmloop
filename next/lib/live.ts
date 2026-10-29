'use client';

import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;

export function liveSocket(): Socket {
  if (!socket) {
    socket = io(process.env.NEXT_PUBLIC_SWARMLOOP_SOCKET ?? 'http://127.0.0.1:3920', {
      transports: ['websocket'],
    });
  }
  return socket;
}
