import { useEffect, useRef, useSyncExternalStore } from 'react';
import { getToken } from './api';
import type { SseEventMap, SseEventName } from './types';

type AnyListener = (payload: unknown) => void;

/**
 * Module-singleton SSE client. One EventSource for the whole app; named-event
 * listeners fan out to React hooks. EventSource auto-reconnects on transient
 * errors; if the browser gives up (readyState CLOSED, e.g. after a non-200)
 * we recreate the connection after a short delay.
 */
class SseClient {
  private es: EventSource | null = null;
  private listeners = new Map<string, Set<AnyListener>>();
  private stateListeners = new Set<() => void>();
  private attachedNames = new Set<string>();
  private reconnectTimer: number | null = null;
  private started = false;
  connected = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  private connect(): void {
    const token = getToken();
    if (token == null) return;
    this.es = new EventSource(`/api/events?t=${encodeURIComponent(token)}`);
    this.attachedNames.clear();
    for (const name of this.listeners.keys()) this.attach(name);
    this.es.onopen = () => this.setConnected(true);
    this.es.onerror = () => {
      this.setConnected(false);
      if (this.es && this.es.readyState === EventSource.CLOSED && this.reconnectTimer == null) {
        this.reconnectTimer = window.setTimeout(() => {
          this.reconnectTimer = null;
          this.connect();
        }, 3000);
      }
    };
  }

  private setConnected(connected: boolean): void {
    if (this.connected === connected) return;
    this.connected = connected;
    for (const fn of this.stateListeners) fn();
  }

  private attach(name: string): void {
    if (!this.es || this.attachedNames.has(name)) return;
    this.attachedNames.add(name);
    this.es.addEventListener(name, (ev) => {
      let payload: unknown = null;
      try {
        payload = JSON.parse((ev as MessageEvent).data as string);
      } catch {
        return;
      }
      const set = this.listeners.get(name);
      if (set) for (const fn of [...set]) fn(payload);
    });
  }

  on(name: string, fn: AnyListener): () => void {
    let set = this.listeners.get(name);
    if (!set) {
      set = new Set();
      this.listeners.set(name, set);
    }
    set.add(fn);
    this.attach(name);
    return () => {
      set.delete(fn);
    };
  }

  onStateChange(fn: () => void): () => void {
    this.stateListeners.add(fn);
    return () => {
      this.stateListeners.delete(fn);
    };
  }
}

const client = new SseClient();

/** Subscribe to a named SSE event. The handler may be an unstable closure. */
export function useSseEvent<K extends SseEventName>(
  name: K,
  handler: (payload: SseEventMap[K]) => void,
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    client.start();
    return client.on(name, (payload) => handlerRef.current(payload as SseEventMap[K]));
  }, [name]);
}

/** Current SSE connection state, for the "reconnecting…" strip. */
export function useSseConnected(): boolean {
  useEffect(() => {
    client.start();
  }, []);
  return useSyncExternalStore(
    (cb) => client.onStateChange(cb),
    () => client.connected,
  );
}
