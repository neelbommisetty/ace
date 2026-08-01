import type { Hono } from 'hono';
import { normalizeBaseUrl } from '../../lib/config.js';
import { isLLMSlot, type LLMSlot } from '../../lib/llm.js';
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
    // Per-slot model overrides: null clears one back to its default. Shape
    // only here — whether the model exists and its provider has a key is
    // decided against the effective config in updateSettings (400 either way).
    if (body.models !== undefined) {
      const models = body.models;
      if (typeof models !== 'object' || models === null || Array.isArray(models)) {
        return c.json({ error: 'models must be an object of slot -> model id or null' }, 400);
      }
      const parsed: Partial<Record<LLMSlot, string | null>> = {};
      for (const [slot, value] of Object.entries(models)) {
        if (!isLLMSlot(slot)) return c.json({ error: `unknown model slot "${slot}"` }, 400);
        if (value === null) {
          parsed[slot] = null;
          continue;
        }
        if (typeof value !== 'string' || value.trim().length === 0) {
          return c.json({ error: `models.${slot} must be a non-empty string or null` }, 400);
        }
        parsed[slot] = value.trim();
      }
      patch.models = parsed;
    }

    try {
      return c.json(await updateSettings(patch));
    } catch (err) {
      if (err instanceof SettingsValidationError) return c.json({ error: err.message }, 400);
      throw err;
    }
  });
}
