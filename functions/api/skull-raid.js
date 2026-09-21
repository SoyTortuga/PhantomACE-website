/* ══════════════════════════════════════════════
   SKULL CLICKER — the co-op raid boss (Undead Executioner).

   One boss, shared by everyone. While it lives, every skull click across
   every open game chips its health down; the server holds the single source
   of truth for its HP, its mechanics, and who dealt what.

   IT FIGHTS BACK, which is what makes it more than a big health bar and what
   drives its animations:
     • ATTACK  — on a timer it heals a slice of its health, so the room must
                 out-damage the regen (plays `attack`).
     • SKILL   — every third mechanic it raises a scythe-guard instead,
                 halving incoming damage for a few seconds (plays `skill`).
     • SUMMON  — at 66% and 33% it summons minions; while they live, half of
                 every strike is soaked clearing them (plays `summon`, then
                 the minion sprites).
     • DEATH   — at 0 HP it falls (plays `death`) and the whole site gets a
                 cursed-skull frenzy.

   Mechanics resolve LAZILY inside the poll/strike handlers — the same lazy
   advance the room games use — so there is no timer process to run. Damage
   is CLICKS, capped per request: a community pile-on, not a score to solo.
   ══════════════════════════════════════════════ */

const RAID_KEY = 'sc_raid';
const HIT_CAP = 100;                 /* most damage one POST can carry */
const DEFAULT_HP = 5000;
const MAX_HP = 5_000_000;
const DEFAULT_MINUTES = 15;
const FRENZY_MS = 10 * 60 * 1000;    /* the reward on a kill */

const RAID_CODE_SECONDS = 604800;    /* 7-day redemption on defeat codes */
const RAID_REWARD_CAP = 100;         /* most participants paid per kill */

const MECH_INTERVAL_MS = 15000;      /* boss acts this often */
const HEAL_PCT = 0.03;               /* attack heals this much of max HP */
const SHIELD_MS = 6000;              /* skill guard duration */
const SHIELD_REDUCE = 0.5;           /* incoming damage multiplier while guarded */
const SUMMON_THRESHOLDS = [0.66, 0.33];
const MINION_POOL_PCT = 0.15;        /* minion HP pool = this share of max HP */
const MINION_SPLIT = 0.5;            /* share of a strike that clears minions */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

function getPlayer(request, body) {
  const session = getSession(request);
  if (session && session.user_id) return { id: 'u_' + session.user_id, name: session.display_name || 'Reaper' };
  if (body && body.guestId && body.guestName) return { id: 'guest_' + body.guestId, name: String(body.guestName).slice(0, 20) };
  return null;
}

/* Advance the boss's timed mechanics up to now — heal, or every third act a
   damage-guard. Bounded iterations so a boss left alone for hours resolves in
   one pass rather than looping thousands of times. Mutates in place. */
function resolveMechanics(raid) {
  if (!raid || raid.status !== 'active') return;
  let guard = 0;
  while (raid.nextTickAt && Date.now() >= raid.nextTickAt && guard++ < 50) {
    const act = (raid.attackCount + raid.skillCount);
    if ((act + 1) % 3 === 0) {
      raid.shieldUntil = raid.nextTickAt + SHIELD_MS;
      raid.skillCount++;
    } else {
      raid.hp = Math.min(raid.maxHp, raid.hp + Math.ceil(raid.maxHp * HEAL_PCT));
      raid.attackCount++;
    }
    raid.nextTickAt += MECH_INTERVAL_MS;
  }
}

/* Summon minions the first time HP crosses each threshold. */
function maybeSummon(raid) {
  raid.summonedThresholds = raid.summonedThresholds || [];
  for (const t of SUMMON_THRESHOLDS) {
    if (raid.hp / raid.maxHp <= t && !raid.summonedThresholds.includes(t)) {
      raid.summonedThresholds.push(t);
      const pool = Math.ceil(raid.maxHp * MINION_POOL_PCT);
      raid.minions = { hp: pool, maxHp: pool };
      raid.summonCount = (raid.summonCount || 0) + 1;
    }
  }
}

/* On a kill, code everyone who struck: an uncommon for every account that
   landed a hit, upgraded to a rare for the single top damager. Each code is
   RESTRICTED to its recipient, so a whispered code cannot be redeemed by
   whoever else sees it. Guests are skipped — a guest id has no account to
   redeem into. Best-effort per person so one failure never denies the rest. */
async function awardRaidRewards(env, raid) {
  const entries = Object.keys(raid.contributors || {})
    .map(id => ({ id, name: raid.contributors[id].name, dmg: raid.contributors[id].dmg }))
    .filter(e => e.id.startsWith('u_') && e.dmg > 0)
    .sort((a, b) => b.dmg - a.dmg)
    .slice(0, RAID_REWARD_CAP);
  if (!entries.length) return;

  const { createItemCode, activateItemCode } = await import('./item-codes.js');
  const { sendWhisper } = await import('./bot/send-chat.js');
  const bossName = raid.name || 'the boss';

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const top = i === 0;
    const rarity = top ? 'rare' : 'uncommon';
    const userId = e.id.slice(2);          // strip the 'u_' prefix
    try {
      const rec = await createItemCode(env, {
        id: `raid_${raid.id}_${e.id}`,
        game: 'skull-clicker', type: 'badge',
        name: `${bossName} ${top ? 'Slayer' : 'Raider'}`,
        rarity,
      }, { restrictedTo: [userId] });
      await activateItemCode(env, rec.code, RAID_CODE_SECONDS);
      await sendWhisper(env, userId,
        `☠️ You helped fell ${bossName}! Your ${rarity} code: ${rec.code} — ` +
        `redeem at phantomace.tv/redeem.html within 7 days.` +
        (top ? ' 🥇 Top damage — a RARE reward!' : ''));
    } catch { /* skip this raider, keep paying the others */ }
  }

  try {
    const { announceAction } = await import('./bot/send-chat.js');
    await announceAction(env,
      `☠️ ${bossName} has fallen! ${entries.length} raider${entries.length === 1 ? '' : 's'} were whispered codes ` +
      `— top damage to ${entries[0].name} (rare). Log in next time to earn yours!`, 'raid-defeat');
  } catch { /* announcement is a nicety */ }
}

/* Fold the live boss into the small public shape the game and overlay read —
   never the raw contributor map. Resolves the timer so every reader agrees
   without a job: an active boss past its deadline reads as expired. */
function publicState(raid) {
  if (!raid || !raid.status) return { status: 'none' };
  let status = raid.status;
  if (status === 'active' && raid.endsAt && Date.now() > raid.endsAt) status = 'expired';
  const contributors = raid.contributors || {};
  const top = Object.keys(contributors)
    .map(id => ({ name: contributors[id].name, dmg: contributors[id].dmg }))
    .sort((a, b) => b.dmg - a.dmg).slice(0, 5);
  const m = raid.minions || { hp: 0, maxHp: 0 };
  return {
    status,
    name: raid.name || 'Undead Executioner',
    hp: Math.max(0, raid.hp || 0),
    maxHp: raid.maxHp || DEFAULT_HP,
    endsAt: raid.endsAt || 0,
    startedAt: raid.startedAt || 0,
    defeatedBy: raid.defeatedBy || null,
    /* Animation cues — the client plays a one-shot when a counter climbs. */
    attackCount: raid.attackCount || 0,
    skillCount: raid.skillCount || 0,
    summonCount: raid.summonCount || 0,
    minionDeaths: raid.minionDeaths || 0,
    shielded: (raid.shieldUntil || 0) > Date.now(),
    minions: { hp: Math.max(0, m.hp || 0), maxHp: m.maxHp || 0 },
    top,
  };
}

export async function onRequestGet(context) {
  const { env } = context;
  /* Resolve mechanics on read too, so an idle overlay still sees the boss
     heal/guard/summon on schedule. Persist only if something changed. */
  let changed = false;
  const raid = await env.MARKETPLACE.get(RAID_KEY, 'json');
  if (raid && raid.status === 'active') {
    const before = JSON.stringify([raid.attackCount, raid.skillCount, raid.hp, raid.shieldUntil, raid.nextTickAt]);
    resolveMechanics(raid);
    if (JSON.stringify([raid.attackCount, raid.skillCount, raid.hp, raid.shieldUntil, raid.nextTickAt]) !== before) {
      changed = true;
    }
  }
  if (changed) await env.MARKETPLACE.put(RAID_KEY, JSON.stringify(raid));
  return json(publicState(raid));
}

export async function onRequestPost(context) {
  const { env, request } = context;
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  /* ── Start a boss — broadcaster/moderators only ── */
  if (body.action === 'start') {
    const session = getSession(request);
    const { isModerator } = await import('./admin/moderators.js');
    if (!(await isModerator(env, session))) {
      return json({ error: 'Only the broadcaster and moderators can summon a boss.' }, 403);
    }
    const hp = Math.min(MAX_HP, Math.max(100, Math.floor(Number(body.hp) || DEFAULT_HP)));
    const minutes = Math.min(120, Math.max(1, Math.floor(Number(body.minutes) || DEFAULT_MINUTES)));
    const raid = {
      id: 'raid_' + Date.now(),
      name: String(body.name || 'Undead Executioner').slice(0, 40),
      maxHp: hp, hp,
      startedAt: Date.now(),
      endsAt: Date.now() + minutes * 60 * 1000,
      status: 'active',
      contributors: {},
      attackCount: 0, skillCount: 0, summonCount: 0, minionDeaths: 0,
      shieldUntil: 0,
      nextTickAt: Date.now() + MECH_INTERVAL_MS,
      summonedThresholds: [],
      minions: { hp: 0, maxHp: 0 },
    };
    await env.MARKETPLACE.put(RAID_KEY, JSON.stringify(raid));
    return json({ success: true, raid: publicState(raid) });
  }

  /* ── End a boss early — broadcaster/moderators only ── */
  if (body.action === 'end') {
    const session = getSession(request);
    const { isModerator } = await import('./admin/moderators.js');
    if (!(await isModerator(env, session))) return json({ error: 'Moderators only.' }, 403);
    const raid = await env.MARKETPLACE.get(RAID_KEY, 'json');
    if (raid && raid.status === 'active') {
      raid.status = 'expired';
      await env.MARKETPLACE.put(RAID_KEY, JSON.stringify(raid));
    }
    return json({ success: true });
  }

  /* ── Strike the boss — anyone playing ── */
  if (body.action === 'hit') {
    const player = getPlayer(request, body);
    if (!player) return json({ error: 'Not authenticated' }, 401);
    const damage = Math.min(HIT_CAP, Math.max(0, Math.floor(Number(body.damage) || 0)));
    if (damage <= 0) {
      const raid = await env.MARKETPLACE.get(RAID_KEY, 'json');
      return json(publicState(raid));
    }

    let justDefeated = false;
    let after = null;
    await env.MARKETPLACE.mutate(RAID_KEY, (raid) => {
      if (!raid || raid.status !== 'active') { after = raid; return undefined; }
      if (raid.endsAt && Date.now() > raid.endsAt) { raid.status = 'expired'; after = raid; return raid; }

      resolveMechanics(raid);

      /* The scythe-guard halves the strike. */
      let eff = damage * ((raid.shieldUntil || 0) > Date.now() ? SHIELD_REDUCE : 1);

      /* Minions soak half of it until they are cleared. */
      raid.minions = raid.minions || { hp: 0, maxHp: 0 };
      if (raid.minions.hp > 0) {
        const toMin = eff * MINION_SPLIT;
        raid.minions.hp = Math.max(0, raid.minions.hp - toMin);
        eff = eff * (1 - MINION_SPLIT);
        if (raid.minions.hp <= 0) { raid.minions = { hp: 0, maxHp: 0 }; raid.minionDeaths = (raid.minionDeaths || 0) + 1; }
      }

      raid.hp = Math.max(0, raid.hp - eff);
      maybeSummon(raid);

      raid.contributors = raid.contributors || {};
      const c = raid.contributors[player.id] || { name: player.name, dmg: 0 };
      c.dmg += damage; c.name = player.name;
      raid.contributors[player.id] = c;

      if (raid.hp <= 0) {
        raid.status = 'defeated';
        raid.defeatedAt = Date.now();
        /* Credit the top contributor, not whoever landed the last hit — a
           co-op boss should reward the effort, not the reflex. */
        const topC = Object.values(raid.contributors).sort((a, b) => b.dmg - a.dmg)[0];
        raid.defeatedBy = topC ? topC.name : player.name;
        justDefeated = true;
      }
      after = raid;
      return raid;
    });

    if (justDefeated) {
      try {
        const { setSkullEvent } = await import('./skull-clicker.js');
        await setSkullEvent(env, 'frenzy', FRENZY_MS);
      } catch (err) {
        console.error('[skull-raid] could not start victory frenzy:', err.message);
      }
      try {
        await awardRaidRewards(env, after);
      } catch (err) {
        console.error('[skull-raid] could not award raid codes:', err.message);
      }
    }

    return json(publicState(after));
  }

  return json({ error: 'Invalid action' }, 400);
}
