/* ══════════════════════════════════════════════
   VISITING SOMEBODY ELSE'S PARK — the things you can DO there

     GET  /api/park-visit?owner=<id>            the guest book
     POST { action: 'tidy', owner }             clear one piece of rubbish
     POST { action: 'sign', owner, text }       write in the guest book

   Visiting already worked, and was entirely read-only: you could look at
   a park and leave. These are the two things worth being able to leave
   behind — a tidier yard and a note — and both of them are the visitor
   doing something, not a number ticking up.

   WHY THIS IS SERVER-SIDE WHEN THE REST OF THE PARK IS NOT. A park save
   is written by exactly one browser, its owner's. A visitor cannot edit
   it: their change would be overwritten by the owner's very next sync,
   which happens every twenty seconds. So a tidy is recorded as an OP on
   the owner's save — the mechanism the marketplace already uses — and the
   owner's own client applies it once, exactly as it applies a sale. The
   guest book has no such problem and lives in its own key.

   A TIDY SAYS HOW MANY, NEVER WHICH. The visitor is looking at a snapshot
   that may be minutes old, so naming a debris id would mean deleting
   whichever piece happened to inherit that index. The owner's client
   removes `n` pieces from whatever is actually there, and removing more
   than exist is simply a no-op.

   THE CAPS ARE THE WHOLE SECURITY MODEL, because the coins a visitor
   earns land in a client-held save that they could edit anyway. The point
   of the caps is not to stop a determined cheat — nothing here can — but
   to stop tidying being a grind worth automating, and to stop one visitor
   filling a guest book.
   ══════════════════════════════════════════════ */

import { saveKey, visitKey, prepareMarketState, sealMarketState, applyCoins, pushParkOp } from './dino-park.js';

/* Per visitor per day. Small on purpose: this is a courtesy you pay
   someone, not a coin faucet. */
const TIDY_PER_PARK = 3;
const TIDY_PER_DAY = 15;
const TIDY_REWARD = 12;

/* One note per park per day. A guest book is a nice thing to find, and
   twenty notes from one person is not. */
const BOOK_MAX_ENTRIES = 40;
const BOOK_TEXT_MAX = 140;

const actKey = (userId) => `parkact_${userId}`;
const bookKey = (userId) => `parkbook_${userId}`;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/(?:^|;\s*)pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

/** The day a tally belongs to. Pacific, like every other cycle on the site. */
export function visitDay(now = Date.now()) {
  const d = new Date(now);
  const pacific = new Date(d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  return `${pacific.getFullYear()}-${pacific.getMonth() + 1}-${pacific.getDate()}`;
}

/** A visitor's tally for today, fresh if the day has rolled. */
export function todaysTally(record, now = Date.now()) {
  const day = visitDay(now);
  if (!record || record.day !== day) return { day, tidied: {}, signed: [] };
  return {
    day,
    tidied: (record.tidied && typeof record.tidied === 'object') ? { ...record.tidied } : {},
    signed: Array.isArray(record.signed) ? [...record.signed] : [],
  };
}

export function tidyTotal(tally) {
  return Object.values(tally.tidied || {}).reduce((t, n) => t + (Number(n) || 0), 0);
}

/** Strip a guest book note down to something safe to render as text. */
export function cleanNote(text) {
  return String(text == null ? '' : text)
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, BOOK_TEXT_MAX);
}

function validOwner(id) {
  return /^[0-9]{1,20}$/.test(String(id));
}

/** The visited park must have opted in, and it must not be your own. */
async function checkTarget(env, session, owner) {
  if (!validOwner(owner)) return { error: 'Unknown park', status: 404 };
  if (String(owner) === String(session.user_id)) {
    return { error: 'That is your own park.', status: 400 };
  }
  const pass = await env.MARKETPLACE.get(visitKey(owner), 'json');
  if (!pass) return { error: 'That park is not open to visitors.', status: 403 };
  return { pass };
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const owner = new URL(request.url).searchParams.get('owner');
  if (!validOwner(owner)) return json({ entries: [] });
  const book = await env.MARKETPLACE.get(bookKey(owner), 'json');
  return json({ entries: Array.isArray(book && book.entries) ? book.entries : [] });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session || !session.user_id) return json({ error: 'Log in to do that.' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }

  const owner = String(body.owner || '');
  const target = await checkTarget(env, session, owner);
  if (target.error) return json({ error: target.error }, target.status);

  const now = Date.now();
  const visitorName = String(session.display_name || 'A visitor').slice(0, 40);

  if (body.action === 'tidy') {
    /* The tally is claimed FIRST. Doing the owner's write first and the
       tally second would let a burst of parallel requests each see an
       unspent allowance and all go through. */
    let allowed = false;
    let remaining = 0;
    await env.MARKETPLACE.mutate(actKey(session.user_id), (current) => {
      const tally = todaysTally(current, now);
      const here = Number(tally.tidied[owner]) || 0;
      if (here >= TIDY_PER_PARK || tidyTotal(tally) >= TIDY_PER_DAY) return undefined;
      tally.tidied[owner] = here + 1;
      allowed = true;
      remaining = TIDY_PER_PARK - tally.tidied[owner];
      return tally;
    });
    if (!allowed) {
      return json({ error: 'You have done all the tidying you can today.' }, 429);
    }

    /* The owner's yard. A tidy op, applied once by their own client. */
    await env.MARKETPLACE.mutate(saveKey(owner), (record) => {
      if (!record) return undefined;                 // nothing to tidy in a park with no save
      const prep = prepareMarketState(record, null);
      if (prep.error || prep.stale) return undefined;
      pushParkOp(prep.state, { t: 'tidy', n: 1, by: visitorName });
      return sealMarketState(owner, prep.state, prep.nextSeq);
    });

    /* The visitor's thank-you, which has to travel as an op too: their own
       save is also written only by their own browser. */
    await env.MARKETPLACE.mutate(saveKey(session.user_id), (record) => {
      const prep = prepareMarketState(record, null);
      if (prep.error || prep.stale) return undefined;
      applyCoins(prep.state, TIDY_REWARD, 'Tidied a park');
      return sealMarketState(session.user_id, prep.state, prep.nextSeq);
    });

    return json({ success: true, reward: TIDY_REWARD, remainingHere: Math.max(0, remaining) });
  }

  if (body.action === 'sign') {
    const text = cleanNote(body.text);
    if (!text) return json({ error: 'Write something first.' }, 400);

    let signed = false;
    await env.MARKETPLACE.mutate(actKey(session.user_id), (current) => {
      const tally = todaysTally(current, now);
      if (tally.signed.includes(owner)) return undefined;
      tally.signed.push(owner);
      signed = true;
      return tally;
    });
    if (!signed) return json({ error: 'You have already signed this book today.' }, 429);

    await env.MARKETPLACE.mutate(bookKey(owner), (current) => {
      const entries = Array.isArray(current && current.entries) ? current.entries : [];
      /* Newest first, and bounded: a guest book is a page, not a log. */
      return {
        entries: [{ from: String(session.user_id), name: visitorName, text, at: now }]
          .concat(entries).slice(0, BOOK_MAX_ENTRIES),
      };
    });

    return json({ success: true });
  }

  return json({ error: 'Unknown action' }, 400);
}
