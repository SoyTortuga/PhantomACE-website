#!/usr/bin/env node
/* ══════════════════════════════════════════════
   ITEM CODES — who may touch them, and the list that makes one recoverable

     node server/scripts/test-item-codes.js

   TWO THINGS, and the first is the serious one.

   AUTHORISATION. This was the last handler in the API gating on the
   session cookie's `role` field; the other forty-nine use isModerator.
   The cookie is signed, so the field cannot be forged — but it is
   captured at LOGIN, so a moderator who has since been removed carries
   `role: 'moderator'` until they sign in again, and could go on listing
   every live code and minting new ones. moderators.js states the rule:
   authorisation reads the live list, never what the cookie remembers.

   THE QUEUE IS A RECOVERY PATH. When a monthly prize whisper fails,
   leaderboards.js grants the badge, mints a backup code restricted to
   the winner, logs "whisper not delivered … backup code=XXXX" and
   carries on — correctly, because the badge did land. The code was then
   findable only in the rig's log. The queue endpoint returned
   code/item/expiresAt, which cannot say WHO a restricted code is for or
   whether they have claimed it, so it could not answer the question it
   exists for.
   ══════════════════════════════════════════════ */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { onRequestGet, onRequestPost, createItemCode, activateItemCode } from '../../functions/api/item-codes.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(REPO, p), 'utf8');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const BROADCASTER = '1';

function makeEnv({ moderators = [] } = {}) {
  const store = new Map();
  store.set('site_moderators', JSON.stringify({
    entries: moderators.map(id => ({ userId: String(id) })),
  }));
  return {
    TWITCH_BROADCASTER_ID: BROADCASTER,
    MARKETPLACE: {
      async get(k, t) { if (!store.has(k)) return null; const r = store.get(k); return t === 'json' ? JSON.parse(r) : r; },
      async put(k, v) { store.set(k, typeof v === 'string' ? v : JSON.stringify(v)); },
      async delete(k) { store.delete(k); },
      async mutate(k, fn) {
        const cur = store.has(k) ? JSON.parse(store.get(k)) : null;
        const next = await fn(cur);
        if (next === undefined) return cur;
        store.set(k, JSON.stringify(next));
        return next;
      },
      async listValues({ prefix }) {
        const out = [];
        for (const [name, raw] of store) if (name.startsWith(prefix)) out.push({ name, value: JSON.parse(raw) });
        return out;
      },
    },
    _store: store,
  };
}

/* `role` is what the COOKIE claims. The point of several tests below is
   that it carries no authority of its own. */
const as = (userId, role) => ({
  Cookie: 'pham_session=' + encodeURIComponent(JSON.stringify({
    user_id: String(userId), display_name: 'U' + userId, role,
  })),
});

const queue = async (env, headers) => {
  const res = await onRequestGet({
    env, request: new Request('https://phantomace.tv/api/item-codes?action=queue', { headers: headers || {} }),
  });
  return { status: res.status, data: await res.json() };
};

const post = async (env, body, headers) => {
  const res = await onRequestPost({
    env,
    request: new Request('https://phantomace.tv/api/item-codes', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(headers || {}) },
      body: JSON.stringify(body),
    }),
  });
  return { status: res.status, data: await res.json() };
};

const ITEM = { id: 'test_badge', game: 'profile', type: 'badge', name: 'Test Badge', rarity: 'rare' };

/* ── Authorisation reads the live list, not the cookie ───────────────── */
{
  const env = makeEnv({ moderators: ['50'] });

  check('a logged-out caller cannot list codes', (await queue(env)).status, 401);
  check('nor mint one', (await post(env, { action: 'create', item: ITEM })).status, 401);

  check('an ordinary user cannot list', (await queue(env, as('999'))).status, 403);
  check('nor mint', (await post(env, { action: 'create', item: ITEM }, as('999'))).status, 403);

  check('a real moderator can list', (await queue(env, as('50'))).status, 200);
  check('and the broadcaster can', (await queue(env, as(BROADCASTER))).status, 200);
  check('a real moderator can mint', (await post(env, { action: 'create', item: ITEM }, as('50'))).status, 200);

  /* THE ONE THAT MATTERS. A removed moderator still holding a cookie that
     says role: 'moderator' — which is exactly what they have until they log
     in again. Gating on the cookie let them straight through. */
  check('a REMOVED moderator whose cookie still says moderator cannot list',
    (await queue(env, as('777', 'moderator'))).status, 403);
  check('nor mint',
    (await post(env, { action: 'create', item: ITEM }, as('777', 'moderator'))).status, 403);
  check('and a cookie simply claiming broadcaster is refused too',
    (await queue(env, as('888', 'broadcaster'))).status, 403);

  /* The flip side: being on the list is enough, whatever the cookie says. */
  check('a moderator whose cookie has no role at all is still allowed',
    (await queue(env, as('50'))).status, 200);
}

/* ── The queue says who a code is for, and whether they have it ──────── */
{
  const env = makeEnv({ moderators: ['50'] });
  env._store.set('profile_101', JSON.stringify({ displayName: 'GraveWalker' }));

  /* A prize code, exactly as leaderboards.js mints one when a whisper is
     about to fail: restricted to its winner, live for a week. */
  const prize = await createItemCode(env, { ...ITEM, id: 'monthly_x', name: 'October Champion' },
    { restrictedTo: ['101'] });
  await activateItemCode(env, prize.code, 604800);

  const open = await createItemCode(env, { ...ITEM, id: 'open_x', name: 'Raid Survivor' });
  await activateItemCode(env, open.code, 300);

  const r = await queue(env, as('50'));
  check('the list comes back', r.status, 200);

  const byCode = Object.fromEntries((r.data.active || []).map(a => [a.code, a]));
  ok('both live codes are listed', !!byCode[prize.code] && !!byCode[open.code]);

  /* Defaulted rather than indexed straight into: a missing field should be
     REPORTED alongside everything else, not thrown on so the rest of the
     suite never runs. */
  const p = byCode[prize.code] || {};
  check('the prize code names who it is for', p.restrictedTo, ['101']);
  check('and resolves that id to a name, because an id is not readable',
    p.restrictedNames, ['GraveWalker']);
  check('and reports it unclaimed, which is the actionable state', p.redeemed, 0);
  ok('with an expiry to count down from', p.expiresAt > Date.now());

  const o = byCode[open.code] || {};
  check('an unrestricted code says so with a null', o.restrictedTo, null);
  ok('and carries no names', !('restrictedNames' in o));

  /* Soonest to expire first: the one about to lapse is the one worth
     acting on. The open code has 5 minutes, the prize a week. */
  check('the list is ordered by what lapses first',
    (r.data.active || []).map(a => a.code), [open.code, prize.code]);

  /* Once redeemed it stops being a thing to chase. */
  const rec = JSON.parse(env._store.get('item_code_' + prize.code));
  rec.redeemedBy = ['101'];
  env._store.set('item_code_' + prize.code, JSON.stringify(rec));
  const after = await queue(env, as('50'));
  const claimed = (after.data.active || []).find(a => a.code === prize.code) || {};
  check('a claimed code reports its claim', claimed.redeemed, 1);
}

/* ── An expired code is not live ─────────────────────────────────────── */
{
  const env = makeEnv({ moderators: ['50'] });
  const dead = await createItemCode(env, ITEM);
  await activateItemCode(env, dead.code, 300);
  const rec = JSON.parse(env._store.get('item_code_' + dead.code));
  rec.expiresAt = Date.now() - 1000;
  env._store.set('item_code_' + dead.code, JSON.stringify(rec));

  const r = await queue(env, as('50'));
  check('an expired code is not listed as live',
    (r.data.active || []).map(a => a.code), []);
}

/* ── Something reads it ──────────────────────────────────────────────── */
{
  /* The endpoint existed from the start and no page called it, so the codes
     it lists were only ever visible in the database — including the backup
     code a failed prize whisper leaves behind. */
  const html = read('bot-control.html');
  ok('Bot Control has the codes card', /id="itemCodeSection"/.test(html));
  ok('with somewhere to render them', /id="botItemCodes"/.test(html));

  const js = read('js/pages/bot-control.js');
  ok('and asks the queue endpoint for them', /item-codes\?action=queue/.test(js));
  ok('showing who a restricted code belongs to', /restrictedNames/.test(js));
  ok('and whether it has been claimed', /is-claimed/.test(js));

  /* It rides the page's existing timer rather than starting a second one on
     a machine that is also running a stream. */
  ok('it does not add a timer of its own',
    (js.match(/setInterval\(/g) || []).length <= 3);

  const css = read('css/pages/bot-control.css');
  ok('the list is styled', /\.bot-code \{/.test(css));
  /* House rules: rarity from the tokens, never a hardcoded hex. */
  const block = (css.match(/\/\* ── Live item codes[\s\S]*?\n\.bot-code-state\.is-claimed[^\n]*\n/) || [''])[0];
  ok('rarity colours come from the tokens', /var\(--rarity-/.test(block));
  check('and no hex is hardcoded in it', block.match(/#[0-9a-fA-F]{3,8}\b/g) || [], []);
  check('no box-shadow', block.match(/box-shadow/g) || [], []);
  check('no coloured side rail', block.match(/border-(left|right):/g) || [], []);
}

/* ── Report ─────────────────────────────────────────────────────────── */
if (failures.length) {
  console.error(`\n✗ ${failures.length} failed, ${passed} passed\n`);
  for (const f of failures) console.error('  ✗ ' + f);
  process.exit(1);
}
console.log(`[item-codes] ${passed} assertions passed.`);
