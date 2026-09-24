/* ══════════════════════════════════════════════
   DINO HATCH — the on-stream gambling minigame

   One act by a viewer rolls one or more dinosaurs at the broadcaster's odds
   (dino-species.js HATCH_RARITY_WEIGHTS) and gives them the exact dinos that
   hatch. Three triggers, each wired in its own webhook, all funnel here:

     • a GIFT SUB          — one roll per sub gifted   (milestones.js)
     • a 300-bit POWER-UP  — one roll                  (bits.js)
     • 30,000 CHANNEL POINTS — one roll                (channel-points.js)

   ONE ANIMATION, BATCH REVEAL. A community gift bomb of N rolls N dinos and
   pushes ONE overlay event carrying all of them, so the overlay plays a single
   hatch and then reveals the whole clutch together rather than N cards in a row.

   GRANTED + ANNOUNCED. The triggerer keeps every dino AND their name is shown
   on the reveal. grantDino places each into their park, overflows to the vault,
   and — when both are full — this module holds it as an inventory egg pinned to
   the exact species, so nothing is lost. A viewer who has never opened Dino
   Park still gets a save created server-side and inherits the dinos on first
   login; an anonymous gifter (no account to grant to) still gets the on-stream
   reveal, just no grant.
   ══════════════════════════════════════════════ */

const CONFIG_KEY = 'dino_hatch_config';

/* On by default — the feature is the point, and unlike milestone code drops it
   is not a spend the broadcaster tunes per stream. Still toggleable so it can
   be switched off without a deploy (see setHatchConfig, called from the bot
   panel). */
/* `sound` gates the overlay's per-rarity hatch stings (the visual reveal always
   plays). Defaults OFF so the stings stay muted until the broadcaster turns them
   on from the bot panel — the overlay reads this on its poll, so it flips live
   with no deploy. */
const DEFAULTS = { enabled: true, sound: false };

/* A community bomb is realistically a few dozen; the cap is a guard against a
   pathological event tying up the lock, not an expected value. All rolls are
   still granted — only the overlay reveal is trimmed (below). */
const HATCH_MAX_ROLLS = 100;

/* How many dinos the overlay reveal scrolls through before collapsing the rest
   into a "+N more" row — the reel shows the whole clutch, but a pathological
   100-gift bomb is bounded so the overlay never holds a hundred portraits at
   once. Every rolled dino is still granted regardless. */
const HATCH_REVEAL_CAP = 50;

const RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

export async function getHatchConfig(env) {
  const rec = await env.MARKETPLACE.get(CONFIG_KEY, 'json');
  return { ...DEFAULTS, ...(rec || {}) };
}

/** Turn the minigame on/off and its sounds on/off. Called from /api/bot/trigger,
    not exposed as a route of its own. */
export async function setHatchConfig(env, patch) {
  const next = {};
  if (patch && patch.enabled !== undefined) next.enabled = !!patch.enabled;
  if (patch && patch.sound !== undefined) next.sound = !!patch.sound;
  await env.MARKETPLACE.mutate(CONFIG_KEY, (cur) => ({ ...DEFAULTS, ...(cur || {}), ...next }));
  return { success: true, config: await getHatchConfig(env) };
}

function inventoryKey(userId) { return `inv_${userId}`; }
function capitalize(s) { return String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1); }

/* Park AND vault were both full, so the hatched dino is held as an inventory
   egg instead of being lost — the same overflow the Eggs tab already surfaces
   for a full incubator, but pinned to the EXACT rolled species (meta.speciesId,
   honoured by useInventoryEgg) so the dino the stream saw hatch is the dino
   they get. Under mutate() because the check-in and theme handlers also write
   inv_ and a viewer redeeming two things at once must not lose one. */
async function overflowToInventoryEgg(env, userId, roll, source) {
  try {
    await env.MARKETPLACE.mutate(inventoryKey(userId), (cur) => {
      const inv = cur && typeof cur === 'object' ? cur : { userId: String(userId), items: [], equips: {} };
      if (!Array.isArray(inv.items)) inv.items = [];
      inv.items.push({
        id: `hatch_egg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        game: 'dino-park',
        type: 'egg',
        name: `${capitalize(roll.rarity)} Dino Park Egg`,
        rarity: roll.rarity,
        consumable: true,
        quantity: 1,
        grantedAt: Date.now(),
        source: `hatch:${source}`,
        meta: { guaranteed: true, rarity: roll.rarity, speciesId: roll.speciesId },
      });
      return inv;
    });
    return true;
  } catch (err) {
    console.error('[dino-hatch] overflow to inventory failed:', err.message);
    return false;
  }
}

/**
 * Roll `count` dinos for one triggering act, grant them, and push a single
 * batch-reveal overlay event. Never throws — a hatch is cosmetic and must not
 * take down the webhook that triggered it.
 *
 * @param {object} opts
 * @param {string|null} opts.userId       who to grant to; null = reveal only
 * @param {string}      opts.displayName  name shown on the overlay
 * @param {number}      [opts.count=1]    rolls (a gift bomb = one per sub)
 * @param {string}      [opts.source]     'giftsub' | 'bits' | 'channel-points'
 * @returns {Promise<{fired:boolean, reason?:string, granted?:number, count?:number}>}
 */
export async function runDinoHatch(env, { userId = null, displayName = 'Someone', count = 1, source = 'hatch' } = {}) {
  const cfg = await getHatchConfig(env);
  if (!cfg.enabled) return { fired: false, reason: 'hatch minigame is off' };

  const n = Math.max(1, Math.min(HATCH_MAX_ROLLS, Math.floor(Number(count) || 1)));

  const { grantDino } = await import('./dino-park.js');

  const results = [];
  let granted = 0;
  for (let i = 0; i < n; i++) {
    let roll;
    try {
      roll = await grantDino(env, userId, { source });
    } catch (err) {
      console.error('[dino-hatch] grant failed:', err.message);
      continue;
    }
    if (!roll || !roll.success) continue;

    if (roll.placed === 'full' && userId) {
      if (await overflowToInventoryEgg(env, userId, roll, source)) granted++;
    } else if (roll.granted) {
      granted++;
    }

    results.push({
      speciesId: roll.speciesId, rarity: roll.rarity, name: roll.name,
      icon: roll.icon, portrait: roll.portrait, mutation: roll.mutation || null,
    });
  }

  if (!results.length) return { fired: false, reason: 'nothing rolled' };

  let top = 'common';
  for (const r of results) {
    if (RARITY_ORDER.indexOf(r.rarity) > RARITY_ORDER.indexOf(top)) top = r.rarity;
  }

  try {
    const { pushOverlayEvent } = await import('./overlay/events.js');
    await pushOverlayEvent(env, {
      type: 'dino-hatch',
      who: displayName || 'Someone',
      source,
      count: n,
      granted,
      top,
      results: results.slice(0, HATCH_REVEAL_CAP),
      more: Math.max(0, results.length - HATCH_REVEAL_CAP),
    });
  } catch (err) {
    console.error('[dino-hatch] could not push overlay event:', err.message);
  }

  /* Tell chat what just happened — one message per event (a gift bomb is one
     announcement, not one per sub). Best-effort and isolated: a chat failure
     must never fail the webhook. */
  try {
    const msg = hatchAnnouncement(source, displayName, n);
    if (msg) {
      const { sendChatMessage } = await import('./bot/send-chat.js');
      await sendChatMessage(env, msg);
    }
  } catch (err) {
    console.error('[dino-hatch] chat announce failed:', err.message);
  }

  return { fired: true, granted, count: n, results };
}

/* The bot's chat line for a hatch, worded per trigger. A gift bomb (count > 1)
   reads in the plural. Unknown sources get no line. */
function hatchAnnouncement(source, who, count) {
  who = who || 'Someone';
  if (source === 'channel-points') return `${who} has hatched a free dino egg with channel points!`;
  if (source === 'bits') return `${who} has hatched a dino egg with bits!`;
  if (source === 'giftsub') {
    return count > 1
      ? `${who} has hatched ${count} dino eggs by gifting ${count} subs to the community!`
      : `${who} has hatched a dino egg by gifting a sub to the community!`;
  }
  return null;
}
