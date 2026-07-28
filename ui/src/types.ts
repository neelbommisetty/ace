/**
 * The wire contract lives in shared/wire-types.ts (NEE-284), compiled by both
 * the server and this SPA — re-exported here so `../types` importers keep
 * working. No shapes are declared in ui/ anymore: a route response shape
 * change is now a compile error here instead of a runtime `undefined`.
 */

export * from '@shared/wire-types';
