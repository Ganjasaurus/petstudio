/**
 * persist.js: versioned JSON records in a Storage-like object (storage).
 *
 * Shared by the teaching memory and the creation gallery. Every record is
 * { schema, version, ... }; saving keeps the previous valid record as a
 * last-known-good backup, loading falls back to that backup when the main
 * record is torn or corrupt, and a record written by a newer app version is
 * copied aside instead of being overwritten. localStorage.setItem replaces a
 * key atomically, so a failed write leaves the previous save intact.
 * Pure ES module (no DOM): the Node tests inject an in-memory storage.
 */

/** Reads and parses a key. status: 'ok' | 'missing' | 'corrupt' | 'unavailable'. */
export function readJSON(storage, key) {
  let raw = null;
  try {
    raw = storage.getItem(key);
  } catch {
    return { status: 'unavailable', raw: null, value: null };
  }
  if (raw == null) return { status: 'missing', raw: null, value: null };
  try {
    return { status: 'ok', raw, value: JSON.parse(raw) };
  } catch {
    return { status: 'corrupt', raw, value: null };
  }
}

/**
 * Checks schema and version of a parsed record.
 * Returns { ok: true } or { ok: false, reason } where reason may be 'future-version'.
 */
export function checkEnvelope(obj, schema, version) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, reason: 'not-an-object' };
  if (obj.schema !== schema) return { ok: false, reason: 'wrong-schema' };
  if (!Number.isInteger(obj.version) || obj.version < 1) return { ok: false, reason: 'bad-version' };
  if (obj.version > version) return { ok: false, reason: 'future-version' };
  return { ok: true };
}

/**
 * Loads a versioned record with backup fallback. Never throws.
 * `sanitize(obj)` receives a parsed record that passed the envelope check and
 * returns clean data. status: 'loaded' | 'restored-backup' | 'new' |
 * 'future-version' | 'unavailable'. `record` is null for 'new',
 * 'future-version' and 'unavailable'.
 */
export function loadVersioned({ storage, key, backupKey, futureKey, schema, version, sanitize }) {
  if (!storage) return { record: null, status: 'unavailable' };
  const attempt = (k) => {
    const r = readJSON(storage, k);
    if (r.status !== 'ok') return { ...r, check: null };
    return { ...r, check: checkEnvelope(r.value, schema, version) };
  };
  const main = attempt(key);
  if (main.status === 'unavailable') return { record: null, status: 'unavailable' };
  if (main.check && !main.check.ok && main.check.reason === 'future-version') {
    try {
      if (futureKey) storage.setItem(futureKey, main.raw);
    } catch {
      /* keep going: the newer record itself is untouched until the next save */
    }
    return { record: null, status: 'future-version' };
  }
  if (main.check?.ok) {
    try {
      return { record: sanitize(main.value), status: 'loaded' };
    } catch {
      /* fall through to the backup */
    }
  }
  if (!backupKey) return { record: null, status: 'new' };
  const bak = attempt(backupKey);
  if (bak.check?.ok) {
    try {
      return { record: sanitize(bak.value), status: 'restored-backup' };
    } catch {
      /* unusable backup */
    }
  }
  return { record: null, status: 'new' };
}

const isQuota = (err) => /quota|exceeded/i.test(String(err?.name ?? '')) || /quota|exceeded/i.test(String(err?.message ?? ''));

/**
 * Writes `json` to `key`, first copying the previous record to `backupKey`
 * when it is still a valid record of this schema (a corrupt main record never
 * overwrites a good backup). Returns { ok, bytes } or { ok: false, reason, quota }.
 */
export function saveVersioned({ storage, key, backupKey, json, schema, version }) {
  if (!storage) return { ok: false, reason: 'no-storage', quota: false };
  try {
    if (backupKey) {
      const prev = readJSON(storage, key);
      if (prev.status === 'ok' && prev.raw !== json && checkEnvelope(prev.value, schema, version).ok) {
        storage.setItem(backupKey, prev.raw);
      }
    }
    storage.setItem(key, json);
    return { ok: true, bytes: json.length };
  } catch (err) {
    return { ok: false, reason: String(err?.name ?? err), quota: isQuota(err) };
  }
}

export function removeKeys(storage, keys) {
  try {
    for (const k of keys) storage?.removeItem(k);
    return true;
  } catch {
    return false;
  }
}
