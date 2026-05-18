import { io, type Socket } from 'socket.io-client';

let socket: Socket | null = null;

export function useSocket(): Socket {
  if (!socket) {
    socket = io({
      transports: ['websocket', 'polling'],
      autoConnect: true,
    });
  }
  return socket;
}

export function getSocket(): Socket | null {
  return socket;
}

export function disposeSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

export type SocketHandler = [event: string, handler: (...args: unknown[]) => void];

export function bindHandlers(sock: Socket, handlers: SocketHandler[]): () => void {
  for (const [event, handler] of handlers) sock.on(event, handler);
  return () => {
    for (const [event, handler] of handlers) sock.off(event, handler);
  };
}
