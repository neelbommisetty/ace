import type { SseEventMap, SseEventName } from './types.js';

/**
 * Tiny typed event bus. Server modules emit typed SSE events; the /api/events
 * route subscribes and fans them out to connected clients.
 */
export type Bus = {
  emit<N extends SseEventName>(name: N, data: SseEventMap[N]): void;
  subscribe(fn: (name: string, data: unknown) => void): () => void;
};

export function createBus(): Bus {
  const listeners = new Set<(name: string, data: unknown) => void>();

  return {
    emit(name, data) {
      for (const fn of [...listeners]) {
        try {
          fn(name, data);
        } catch {
          // A throwing listener is a dead client — drop it.
          listeners.delete(fn);
        }
      }
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
