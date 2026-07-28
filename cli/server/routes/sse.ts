import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { RouteContext } from './context.js';

const HEARTBEAT_MS = 25_000;

export function registerSseRoutes(app: Hono, ctx: RouteContext): void {
  app.get('/api/events', (c) =>
    streamSSE(c, async (stream) => {
      let alive = true;
      let unsubscribe: () => void = () => {};
      let heartbeat: NodeJS.Timeout | null = null;
      let release!: () => void;
      const closed = new Promise<void>((resolve) => {
        release = resolve;
      });
      const stop = () => {
        if (!alive) return;
        alive = false;
        unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
        release();
      };
      stream.onAbort(stop);

      try {
        await stream.writeSSE({
          event: 'hello',
          data: JSON.stringify({
            version: ctx.version,
            workspaceRoot: ctx.getWorkspaceRoot(),
            epoch: ctx.getSession()?.epoch ?? null,
          }),
        });
      } catch {
        stop();
        return;
      }
      // The client may have aborted during the hello write; registering the
      // listener/heartbeat after stop() ran would leak them forever.
      if (!alive) return;

      unsubscribe = ctx.bus.subscribe((name, data) => {
        if (!alive) return;
        stream.writeSSE({ event: name, data: JSON.stringify(data) }).catch(stop);
      });
      heartbeat = setInterval(() => {
        if (!alive) return;
        stream.write(': heartbeat\n\n').catch(stop);
      }, HEARTBEAT_MS);

      await closed;
    }),
  );
}
