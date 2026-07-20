import crypto from 'node:crypto';

let lastTs = -1;
let seq = 0;

/**
 * UUIDv7: 48-bit unix ms timestamp + version/variant bits + crypto random.
 * The rand_a field carries a per-ms sequence so ids generated in the same
 * millisecond still sort lexicographically by creation order.
 */
export function uuidv7(): string {
  let ts = Date.now();
  if (ts <= lastTs) {
    ts = lastTs;
    seq += 1;
    if (seq > 0x0fff) {
      // 12-bit sequence exhausted within this ms — borrow the next one
      ts += 1;
      seq = 0;
    }
  } else {
    seq = 0;
  }
  lastTs = ts;

  const bytes = crypto.randomBytes(16);
  const hi = Math.floor(ts / 0x100000000);
  const lo = ts >>> 0;
  bytes[0] = (hi >>> 8) & 0xff;
  bytes[1] = hi & 0xff;
  bytes[2] = (lo >>> 24) & 0xff;
  bytes[3] = (lo >>> 16) & 0xff;
  bytes[4] = (lo >>> 8) & 0xff;
  bytes[5] = lo & 0xff;
  // version 7 + 12-bit sequence in rand_a
  bytes[6] = 0x70 | ((seq >> 8) & 0x0f);
  bytes[7] = seq & 0xff;
  // RFC 4122 variant
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
