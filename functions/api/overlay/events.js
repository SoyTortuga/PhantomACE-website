/* ══════════════════════════════════════════════
   OVERLAY EVENT FEED

   Drives the on-stream alert window (an OBS browser source). Everything that
   happens — a code drop, a sub, a raid, a hype train level — gets pushed
   here, and the overlay polls for anything it has not seen.

   WHY POLLING AND NOT WEBSOCKETS/SSE

   One client. OBS opens this page once and holds it. A 1-second poll from a
   single browser is nothing, and it keeps the whole thing inside the
   architecture that already exists — no new transport, no connection state
   to lose, no reconnect logic to get wrong while a stream is live. The
   adapter that turns handler Responses into Node responses has never had to
   stream, and making it do so for one consumer is the wrong trade.

   SEQUENCE NUMBERS, NOT TIMESTAMPS

   The overlay asks for "everything after N". A clock-based cursor would
   replay or skip alerts whenever the two machines disagreed, and OBS runs on
   the streaming PC rather than the server.

   A FIRST LOAD REPLAYS NOTHING. Opening the overlay — or OBS reloading the
   source mid-stream, which it does — returns the current position and no
   backlog. Without that, restarting a source would dump every alert of the
   last hour onto the stream at once.
   ══════════════════════════════════════════════ */

const KEY = 'overlay_events';
const KEYFILE = 'overlay_key';
const MAX_EVENTS = 60;

/** The shared secret in the OBS URL. Generated once, then stable. */
export async function getOverlayKey(env) {
  const existing = await env.MARKETPLACE.get(KEYFILE);
  if (existing) return existing;
  const key = crypto.randomUUID().replace(/-/g, '');
  await env.MARKETPLACE.put(KEYFILE, key);
  return key;
}

/**
 * Append an event. Never throws — an overlay problem must not take down the
 * webhook or the drop that triggered it. A missed alert is a cosmetic loss;
 * a 500 back to Twitch risks the subscription itself.
 */
export async function pushOverlayEvent(env, event) {
  if (!event || !event.type) return;
  try {
    await env.MARKETPLACE.mutate(KEY, (current) => {
      const rec = current && Array.isArray(current.events)
        ? current
        : { events: [], seq: 0 };
      rec.seq = (Number(rec.seq) || 0) + 1;
      rec.events.push({ ...event, seq: rec.seq, at: Date.now() });
      if (rec.events.length > MAX_EVENTS) rec.events = rec.events.slice(-MAX_EVENTS);
      return rec;
    });
  } catch (err) {
    console.error('[overlay] could not record event:', err.message);
  }
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);

  /* Key in the query string because an OBS browser source is a URL and
     nothing else — it cannot send a header or hold a cookie. */
  const key = await getOverlayKey(env);
  if (url.searchParams.get('key') !== key) {
    return new Response(JSON.stringify({ error: 'Bad or missing key' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  const rec = await env.MARKETPLACE.get(KEY, 'json');
  const events = rec && Array.isArray(rec.events) ? rec.events : [];
  const latestSeq = Number(rec && rec.seq) || 0;

  const sinceRaw = url.searchParams.get('since');
  /* No cursor means "just tell me where we are". See the header: a reloaded
     source must not replay an hour of alerts onto the stream. */
  const since = sinceRaw === null || sinceRaw === '' ? null : parseInt(sinceRaw, 10);

  const fresh = since === null || Number.isNaN(since)
    ? []
    : events.filter(e => e.seq > since);

  return new Response(JSON.stringify({ events: fresh, latestSeq, serverNow: Date.now() }), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
