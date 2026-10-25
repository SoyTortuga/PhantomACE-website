/* ══════════════════════════════════════════════
   A throwaway in-memory KV for the scripts that need Twitch but not Postgres.

   getAppToken() caches the Twitch app token through env.MARKETPLACE, so ANY
   code path that reaches Helix needs a store — including `run.js --dry-run`
   and list-games.js, which deliberately do not open a database connection.
   Without this they crash on `env.MARKETPLACE.get` before reaching Twitch at
   all.

   Ephemeral on purpose: a token minted by a one-off script should not outlive
   it, and the rig's real cache in Postgres stays untouched.
   ══════════════════════════════════════════════ */

export function memoryKv() {
  const store = new Map();
  const parse = (v, type) => (type === 'json' && typeof v === 'string' ? safeJson(v) : v);
  return {
    async get(key, type) {
      const v = store.get(key);
      return v === undefined ? null : parse(v, type);
    },
    async put(key, value) { store.set(key, value); return undefined; },
    async delete(key) { store.delete(key); },
    async mutate(key, fn) {
      const cur = parse(store.get(key) ?? null, 'json');
      const next = fn(cur);
      store.set(key, next);
      return next;
    },
  };
}

function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }
