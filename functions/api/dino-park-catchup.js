/* ══════════════════════════════════════════════
   DINO PARK — OFFLINE EGG CATCH-UP

   Eggs incubate only while PhantomACE is live (games/dino-park/index.html's
   gameTick gates it on isStreamLive) — a deliberate "watch the stream"
   mechanic, not a bug. But a closed browser used to mean lost progress:
   nothing could say whether the stream WAS live while the page was shut.

   This endpoint answers exactly that — "how many seconds between `since` and
   now was PhantomACE live" — from a live-interval log the RIG records itself.
   The server's minute tick already checks whether the channel is live (for
   the broadcast/streak log); recordLiveTick() below rides that same check and
   stamps a running record of the intervals the stream was up. The client
   credits the returned seconds to every incubating egg, additively on top of
   whatever gameTick has ticked locally, so a slow reply never rolls
   incubation backwards.

   WHY NOT TWITCH VODs (the previous approach). VOD scanning only works if the
   channel has "Store Past Broadcasts" enabled AND a broadcast has a queryable
   archive — neither is guaranteed, and with archiving off it silently
   credited nothing, so offline incubation never advanced. The rig watches the
   live state on its own minute tick regardless of VOD settings, so this log
   is the reliable record. It only knows about live time since this shipped —
   there is no retroactive history — which is the right trade: correct from
   here on, rather than dependent on a Twitch setting that may be off.

   NO SESSION REQUIRED. Live intervals are channel-wide public information and
   carry no per-player data, so guests get catch-up exactly like logged-in
   players.
   ══════════════════════════════════════════════ */

const LIVE_LOG_KEY = 'dino_live_log';

/* How far back a catch-up will look. A player gone longer than this is
   credited only for the tail inside the window — the log is pruned to it too,
   so neither the scan nor the stored record grows without bound. */
const MAX_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/* The recorder runs on the rig's ~60s tick. A live tick within this of the
   last one is the SAME broadcast and extends its interval; a longer gap
   (server restart aside) is the stream having been down, so it opens a new
   interval. Set above one tick so a single missed tick doesn't split a run,
   but well below a real between-stream gap. */
const MERGE_GAP_MS = 150 * 1000;

/* Backstop cap on stored intervals. Pruning by window keeps this far under
   normal, but a pathological flap shouldn't grow the row unbounded. */
const MAX_INTERVALS = 500;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Seconds of [start, end) that fall inside [from, now). */
export function overlapSeconds(start, end, from, now) {
  const ms = Math.max(0, Math.min(end, now) - Math.max(start, from));
  return ms / 1000;
}

/**
 * Record the channel's live state at `now`, called from the rig's minute
 * tick. A live tick extends the current interval (or opens one if the last
 * live tick was long enough ago to be a different broadcast); an offline
 * tick records nothing, leaving the last interval ended where its final live
 * tick left it — accurate to within one tick, which is all egg crediting
 * needs. Best-effort: a missed write costs at most one minute of one egg's
 * credit, never an error on the tick.
 *
 * Exported for the recorder AND the tests; not a route.
 */
export async function recordLiveTick(env, live, now = Date.now()) {
  if (!live) return;
  now = Number(now) || Date.now();
  try {
    await env.MARKETPLACE.mutate(LIVE_LOG_KEY, (current) => {
      const rec = current && Array.isArray(current.intervals) ? current : { intervals: [] };
      const last = rec.intervals[rec.intervals.length - 1];
      if (last && now - last.end <= MERGE_GAP_MS) {
        last.end = now;                                   // same broadcast — extend it
      } else {
        rec.intervals.push({ start: now, end: now });     // a new live run
      }
      /* Bound the record: drop intervals wholly past the lookback window,
         then cap the count as a backstop. */
      const cutoff = now - MAX_WINDOW_MS;
      rec.intervals = rec.intervals.filter((iv) => iv.end >= cutoff);
      if (rec.intervals.length > MAX_INTERVALS) rec.intervals = rec.intervals.slice(-MAX_INTERVALS);
      return rec;
    });
  } catch { /* a dropped tick is a minute of catch-up lost, never a crash */ }
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const since = parseInt(url.searchParams.get('since'), 10);
  const now = Date.now();

  /* A bad or missing `since`, or one already in the future, credits
     nothing — there is no gap to have missed. */
  if (!Number.isFinite(since) || since <= 0 || since >= now) {
    return json({ liveSeconds: 0 });
  }

  const from = Math.max(since, now - MAX_WINDOW_MS);

  try {
    const log = await env.MARKETPLACE.get(LIVE_LOG_KEY, 'json');
    const intervals = log && Array.isArray(log.intervals) ? log.intervals : [];

    let liveSeconds = 0;
    for (const iv of intervals) {
      if (!iv || typeof iv.start !== 'number' || typeof iv.end !== 'number') continue;
      liveSeconds += overlapSeconds(iv.start, iv.end, from, now);
    }

    /* Never credit more than the gap itself, whatever the log says. */
    liveSeconds = Math.min(liveSeconds, (now - from) / 1000);
    return json({ liveSeconds: Math.round(liveSeconds) });
  } catch (err) {
    /* A missed catch-up is a cosmetic loss — an egg simply isn't credited
       for this gap — never something that should surface as a page error. */
    return json({ liveSeconds: 0, error: err.message });
  }
}
