/* ══════════════════════════════════════════════
   MOON SWEEPERS — CUSTOM BITS POWER-UPS

     GET /api/powerups/moon-sweepers

   THE CONSTRAINT THIS IS BUILT AROUND. Twitch exposes no API to create,
   enable or disable a custom Bits Power-up — an app can only READ the
   available ones and RECEIVE redemptions (channel.bits.use →
   custom_power_up). There is no native category gating either. So the 21
   below are created by hand in the Creator Dashboard and stay buyable in
   every category, including the ones where the mod is not running and a
   viewer's Bits do precisely nothing.

   What the bot can do is a SOFT GATE: say when they are relevant. The
   category change (functions/api/channel-update.js) announces them opening
   and closing, `!powerups` answers whether they are live, and this route
   feeds the on-site list at /moonsweepers.

   ONE LIST, THREE READERS. The titles must match PowerUpMappings in the
   mod's config exactly — capitals do not matter, spaces and punctuation do
   — so they live here once rather than being retyped per consumer. The
   source of truth on paper is docs/MOON-SWEEPERS-POWERUPS.md, and
   server/scripts/test-moon-sweepers-powerups.js fails if this table and
   that document ever disagree.
   ══════════════════════════════════════════════ */

import { getStreamCategory } from '../channel-update.js';

/* The Twitch category name, as Twitch spells it. Matched trimmed and
   case-insensitively everywhere — never compared with === on raw input. */
export const MOON_SWEEPERS = 'Moon Sweepers';

/** Where the full list lives. No scheme: chat reads better without one. */
export const LIST_URL = 'phantomace.tv/moonsweepers';

export const POWERUPS = Object.freeze([
  { n: 1,  title: 'Lights Out',         bits: 250,   effect: "Everyone's helmet lamp switches off and stays off for 15 minutes." },
  { n: 2,  title: 'Half Reach',         bits: 500,   effect: "Everyone's reach for picking up dust canisters is cut in half for 10 minutes." },
  { n: 3,  title: 'Refill a Sector',    bits: 500,   effect: 'A random sector the crew already cleared fills back up with dust.' },
  /* The three gravity descriptions carry the stacking rule themselves —
     these are the exact strings pasted into the Creator Dashboard, so the
     warning is readable at the point of purchase and not only in chat. The
     `warning` field is the tail of `effect`, repeated so the page can lift
     that one sentence out and make it loud without storing it twice. */
  { n: 4,  title: '2x Gravity',         bits: 750,
    effect: 'Gravity doubles for 15 min: falling twice as strong; running, jumping and vehicles at half speed. Buying it again restarts the timer. Does nothing while 4x or 8x Gravity is running.',
    warning: 'Does nothing while 4x or 8x Gravity is running.' },
  { n: 5,  title: 'Spill The Dust',     bits: 1000,  effect: "Everyone drops all the dust they're carrying, scattered on the ground as 1 kg canisters to pick back up." },
  { n: 6,  title: 'Fisheye Filter',     bits: 1000,  effect: "Everyone's field of view widens to 140° for 15 minutes." },
  { n: 7,  title: 'Tunnel Vision',      bits: 1000,  effect: "Everyone's field of view narrows to 30° for 15 minutes." },
  { n: 8,  title: 'Moon Fog',           bits: 1000,  effect: 'A grey fog rolls in for 10 minutes, cutting visibility to about 35 m.' },
  { n: 9,  title: 'Tiny Pockets',       bits: 1250,  effect: 'Everyone can carry only half as much dust, on foot and in vehicles, for 15 minutes. Dust already carried is kept.' },
  { n: 10, title: '4x Gravity',         bits: 1500,
    effect: 'Gravity 4x stronger for 15 min: running, jumping and vehicles at quarter speed. Replaces 2x and restarts the timer. Does nothing while 8x Gravity is running.',
    warning: 'Does nothing while 8x Gravity is running.' },
  { n: 11, title: 'Potato Mode',        bits: 1500,  effect: 'The game renders at a quarter of its resolution for 15 minutes.' },
  { n: 12, title: 'Roomba Shutdown',    bits: 2000,  effect: 'Every Roomba switches off and heads back to its dock until someone switches it back on.' },
  { n: 13, title: 'Back to Square One', bits: 2500,  effect: "Everyone's brush is swapped for the starter toothbrush for 15 minutes, then given back." },
  { n: 14, title: 'Australian Moon',    bits: 2500,  effect: "Everyone's view turns upside down for 10 minutes. The HUD stays upright." },
  { n: 15, title: '8x Gravity',         bits: 3000,
    effect: 'Gravity 8x stronger for 15 min: running, jumping and vehicles at an eighth speed. Replaces any weaker gravity and restarts the timer.' },
  { n: 16, title: 'JOONAS Shutdown',    bits: 3000,  effect: 'J.O.O.N.A.S. switches off. Someone has to find it and switch it back on.' },
  { n: 17, title: 'Shrink-Flation',     bits: 3000,  effect: 'Pay for every kg of dust and every finished sector is cut in half for 30 minutes.' },
  { n: 18, title: 'Inverted Controls',  bits: 3000,  effect: 'Movement and camera controls are reversed for 10 minutes.' },
  { n: 19, title: 'Vehicle Breakdown',  bits: 5000,  effect: "Everyone is thrown out of their vehicle and can't get back in for 15 minutes." },
  { n: 20, title: 'Mercy',              bits: 5000,  effect: 'Ends every active timed effect right away.' },
  { n: 21, title: 'Bankruptcy',         bits: 10000, effect: "The crew's shared money drains to $0." },
]);

/* Worth knowing BEFORE spending Bits, which is why they ship with the list
   rather than living only in the doc. The gravity one is the expensive
   mistake: buy 2x while 8x is running and you have paid 750 Bits for
   nothing at all. */
export const NOTES = Object.freeze([
  {
    heading: 'Gravity stacks by strength, not by order',
    body: 'A stronger gravity Power-up replaces a weaker one and restarts the 15 minutes. Buying the same one again just restarts its timer. '
        + 'A WEAKER one bought while a stronger one is running does nothing — 2x while 8x is up is 750 Bits for no effect. '
        + 'That warning is in the three gravity descriptions on Twitch too, so it is on the buy screen as well as here.',
  },
  {
    heading: 'Effects hit the whole lobby',
    body: 'These are not pranks on PhantomACE alone. Every player in the lobby running the mod gets the fog, the gravity, the inverted controls and the rest.',
  },
  {
    heading: 'Two of them are untested',
    body: 'Roomba Shutdown and JOONAS Shutdown have not been tried in a save with robots in it. They may do nothing. Spend on them knowing that.',
  },
  {
    heading: 'Buyable even when they are closed',
    body: 'Twitch gives no way to switch a custom Power-up off by category, so these stay purchasable while we play other things — and do nothing there. '
        + 'The bot announces in chat when they open and close, and !powerups answers at any time.',
  },
]);

export const CHEAPEST = POWERUPS.reduce((a, b) => (b.bits < a.bits ? b : a));

/** Trimmed and case-insensitive. Twitch hands back whatever the dashboard
    holds, and a stray space must not close the gate. */
export function isMoonSweepers(name) {
  return typeof name === 'string'
    && name.trim().toLowerCase() === MOON_SWEEPERS.toLowerCase();
}

/**
 * Did this category move open the Power-ups, close them, or neither?
 *
 * Only a real move answers anything. A title edit, a Twitch rename of the
 * same category, or a redelivery of an identical event all arrive as the
 * same `channel.update` — and an announcement on any of those is the kind
 * of repeat spam that gets a bot muted. channel-update.js already tells
 * those apart; this is given `changed === 'category'` and nothing else.
 *
 * @returns {'open'|'close'|null}
 */
export function categoryTransition(prevName, nextName) {
  const was = isMoonSweepers(prevName);
  const now = isMoonSweepers(nextName);
  if (now && !was) return 'open';
  if (was && !now) return 'close';
  return null;
}

/* ── The exact wording, in one place ──────────────────────────────────────
   Every line the bot can say about the Power-ups is built here so the
   broadcaster can read and change all of it at once, and so a test can pin
   it. All four sit well inside Twitch's ~500 character chat limit; the
   21-item list deliberately never goes in chat — it is a link. */

export function openAnnouncement() {
  return `🌙 ${MOON_SWEEPERS} Power-ups are OPEN — your Bits land on EVERYONE in the lobby, not just PhantomACE. `
       + `21 of them, from ${CHEAPEST.bits} Bits. Costs, effects and the gravity-stacking trap: ${LIST_URL}`;
}

export function closeAnnouncement() {
  return `🌙 ${MOON_SWEEPERS} Power-ups are CLOSED — we're off the game, so don't spend Bits on them: nothing will happen in the lobby. `
       + `Twitch gives no way to hide them, so that's on us to say. List stays up at ${LIST_URL}`;
}

/**
 * The `!powerups` reply.
 * Names the cheapest one as a teaser; the other twenty are behind the link.
 */
export function powerupsReply(live) {
  if (live) {
    return `🌙 ${MOON_SWEEPERS} Power-ups are LIVE right now — effects hit everyone in the lobby. `
         + `Cheapest is ${CHEAPEST.title} (${CHEAPEST.bits} Bits). All 21 with costs and the gravity rules: ${LIST_URL}`;
  }
  return `🌙 ${MOON_SWEEPERS} Power-ups are NOT live — we're on something else, so Bits spent on them do nothing. `
       + `They're still buyable (Twitch won't let us hide them), so hold off. Full list for when we're back: ${LIST_URL}`;
}

/** Live right now, by category. Never throws — a storage hiccup reads as
    "not live", which is the answer that costs a viewer nothing. */
export async function arePowerupsLive(env) {
  try {
    const cat = await getStreamCategory(env);
    return isMoonSweepers(cat && cat.categoryName);
  } catch {
    return false;
  }
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

export async function onRequestGet(context) {
  const { env } = context;
  let categoryName = null;
  try {
    const cat = await getStreamCategory(env);
    categoryName = (cat && cat.categoryName) || null;
  } catch { /* the list is still worth serving without the live flag */ }

  return json({
    game: MOON_SWEEPERS,
    live: isMoonSweepers(categoryName),
    category: categoryName,
    count: POWERUPS.length,
    powerups: POWERUPS,
    notes: NOTES,
  }, 200, { 'Cache-Control': 'public, max-age=15' });
}
