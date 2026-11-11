'use client';

import type { Socket } from 'socket.io-client';
import { io } from 'socket.io-client';
import { socketUrl } from './runtime-config';
import type { ClientToServerEvents, ServerToClientEvents } from '@contract/live';

let socket: Socket<ServerToClientEvents, ClientToServerEvents> | null = null;

export function liveSocket(): Socket<ServerToClientEvents, ClientToServerEvents> {
  if (!socket) {
    socket = io(socketUrl(), {
      transports: ['websocket'],
      withCredentials: true,
    });
  }
  return socket;
}
