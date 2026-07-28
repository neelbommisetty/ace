import type { Hono } from 'hono';
import { normalizeBaseUrl } from '../../lib/config.js';
import { readJsonBody } from '../route-helpers.js';
import {
  getSettingsInfo,
  SettingsValidationError,
  updateSettings,
  type SettingsPatch,
} from '../settings.js';
import type { RouteContext } from './context.js';

export function registerSettingsRoutes(app: Hono, _ctx: RouteContext): void {
  app.get('/api/settings', (c) => c.json(getSettingsInfo()));

  app.put('/api/settings', async (c) => {
    const body = await readJsonBody(c);
    if (!body) return c.json({ error: 'invalid JSON body' }, 400);

    const patch: SettingsPatch = {};
    if (body.openaiKey !== undefined) {
      if (typeof body.openaiKey !== 'string' || body.openaiKey.trim().length === 0) {
        return c.json({ error: 'openaiKey must be a non-empty string' }, 400);
      }
      patch.openaiKey = body.openaiKey.trim();
    }
    if (body.anthropicKey !== undefined) {
      if (typeof body.anthropicKey !== 'string' || body.anthropicKey.trim().length === 0) {
        return c.json({ error: 'anthropicKey must be a non-empty string' }, 400);
      }
      patch.anthropicKey = body.anthropicKey.trim();
    }
    for (const field of ['openaiBaseUrl', 'anthropicBaseUrl'] as const) {
      const value = body[field];
      if (value === undefined) continue;
      if (value === null) {
        patch[field] = null;
        continue;
      }
      if (typeof value !== 'string' || value.trim().length === 0) {
        return c.json({ error: `${field} must be a non-empty string or null` }, 400);
      }
      const normalized = normalizeBaseUrl(value);
      if (!normalized) {
        return c.json({ error: `${field} must be a valid http(s) URL` }, 400);
      }
      patch[field] = normalized;
    }
    if (body.defaultProvider !== undefined) {
      if (body.defaultProvider !== 'openai' && body.defaultProvider !== 'anthropic') {
        return c.json({ error: 'defaultProvider must be "openai" or "anthropic"' }, 400);
      }
      patch.defaultProvider = body.defaultProvider;
    }

    try {
      return c.json(await updateSettings(patch));
    } catch (err) {
      if (err instanceof SettingsValidationError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });
}
