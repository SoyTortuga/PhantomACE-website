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
   advance the room games use — so there is no timer process to run. Every
   write goes through mutate() (the per-key lock), including the read path's
   timed-action advance, so a poll can never overwrite a strike. Damage is
   CLICKS, capped per request AND per striker over time: a community
   pile-on, not a score to solo.

   The record is never deleted from a read. A boss that runs out its clock
   is marked 'escaped' (shown for ESCAPE_LINGER_MS so every client sees the
   toast), a kill lingers as 'defeated', and both then read as 'none' until
   the next summon overwrites the record.
   ══════════════════════════════════════════════ */

const RAID_KEY = 'sc_raid';
const rewardKey = (userId) => `sc_raid_reward_${userId}`;   /* a raider's pending code, per account */
const HIT_CAP = 100;                 /* most damage one POST can carry */
const DEFAULT_HP = 5000;
const MAX_HP = 5_000_000;
const DEFAULT_MINUTES = 15;
const FRENZY_MS = 10 * 60 * 1000;    /* the reward on a kill */
const DEFEAT_LINGER_MS = 15000;      /* a defeated boss shows this long, then clears */
const ESCAPE_LINGER_MS = 15000;      /* an escaped boss reads 'escaped' this long after its deadline */

/* ── Damage over TIME, per striker ──────────────────────────────────────
   HIT_CAP bounds one request, not a stream of them. Derived from the real
   client (games/skull-clicker/index.html):
     • one strike per skull click — sustained human mashing is ~10-15/s,
       bursts touch ~20/s — plus the Reaping auto-clicker (a 200ms
       setInterval = 5/s);
     • strikes are queued and flushed every 3s, at most 100 per POST, so
       even a flawless client tops out at 100/3s ≈ 33/s.
   RAID_RATE_PER_SEC sits ~20% above that ceiling so no real player is ever
   clipped; RAID_BURST (three full flushes) absorbs a retried flush or a
   throttled background tab catching up. Each striker carries a token
   bucket inside the raid record, updated under mutate()'s lock; strikes
   past it are dropped, not errored. Guest ids are minted client-side, so a
   guest strike also draws from a per-IP bucket — rotating guest ids cannot
   multiply the rate. */
const RAID_RATE_PER_SEC = 40;
const RAID_BURST = 300;
const GUEST_IP_RATE_PER_SEC = 80;    /* a household of guests behind one address */
const GUEST_IP_BURST = 600;
const RAID_MAX_CONTRIBUTORS = 500;   /* contributor map ceiling (accounts may evict the weakest guest) */
const RAID_MAX_IP_BUCKETS = 300;

/* A defeat code needs a real share of the fight, not one stray click:
   1% of the boss's max HP, at least 50 and at most 500 strikes (~1 minute of
   honest mashing on the biggest redemption bosses), and never more than 10%
   of a tiny manual test boss. */
const RAID_MIN_REWARD_SHARE = 0.01;
const RAID_MIN_REWARD_FLOOR = 50;
const RAID_MIN_REWARD_CEIL = 500;
function minRewardDamage(maxHp) {
  const hp = Math.max(1, Number(maxHp) || DEFAULT_HP);
  return Math.min(
    Math.max(RAID_MIN_REWARD_FLOOR, Math.ceil(hp * RAID_MIN_REWARD_SHARE)),
    RAID_MIN_REWARD_CEIL,
    Math.ceil(hp * 0.1),
  );
}

/* ── The channel-point boss: sized to who's actually watching ────────────
   Summoned by redeeming "Summon Raid Boss" (10,000 points) — see
   REWARD_HANDLERS['raid-boss'] in channel-points.js. Cost, the 1-hour
   cooldown, and the 3-per-stream cap are all configured on the reward
   itself in the Twitch dashboard, exactly like Pham Check-in's
   once-per-stream limit: Twitch enforces them, so there is nothing to
   count or reset here. This file only reacts to a redemption that already
   cleared Twitch's gate.

   1 click landed on the boss = 1 damage (see the `hit` action), so HP is
   already denominated in raw clicks -- which is what makes "550
   clicks/minute, for a third of the room" a clean multiply rather than
   needing a currency conversion.

   FIRST PASS, DELIBERATELY. 550/min is a sustainable-but-real mashing
   rate, not a spreadsheet number, 1/3 assumes most viewers watch rather
   than play, and 10 minutes is what the request asked to start with. All
   three are knobs to retune after watching a few fights actually play out. */
const REDEMPTION_CLICKS_PER_MIN = 550;
const REDEMPTION_MINUTES = 10;
const REDEMPTION_PARTICIPATION = 1 / 3;
const REDEMPTION_MIN_VIEWERS = 3;   /* a boss redeemed off-stream/in testing still gets a real fight, not 0 HP */

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
  const match = cookie.match(/(?:^|;\s*)pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

/* Names reach the stream overlay, so strip anything that is not plain
   visible text (control, zero-width, bidi-override and other format
   characters), collapse whitespace and cap the length. */
const NAME_MAX = 25;
function cleanName(raw, fallback) {
  const s = String(raw == null ? '' : raw)
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(s).slice(0, NAME_MAX).join('') || fallback;
}

/* A guest's display name is NEVER taken from the request: the client's own
   default is 'Skull#' + four characters of its guest id, so the server
   derives exactly that, and a guest can put nothing of its own choosing on
   the overlay. */
const GUEST_ID_RE = /^[A-Za-z0-9_-]{3,40}$/;
function guestNameFor(guestId) {
  const tag = guestId.replace(/^g_/, '').replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase();
  return 'Skull#' + (tag || 'ANON');
}

function getPlayer(request, body) {
  const session = getSession(request);
  if (session && session.user_id) {
    return { id: 'u_' + String(session.user_id).slice(0, 40), name: cleanName(session.display_name, 'Reaper'), guest: false };
  }
  const gid = body && typeof body.guestId === 'string' ? body.guestId : '';
  if (GUEST_ID_RE.test(gid)) return { id: 'guest_' + gid, name: guestNameFor(gid), guest: true };
  return null;
}

/* The caller's address as a short opaque key (never stored raw). Null when
   no proxy header is present, in which case only the per-guest bucket
   applies. */
async function clientIpKey(request) {
  const ip = request.headers.get('CF-Connecting-IP')
    || (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim();
  if (!ip) return null;
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('sc_raid:' + ip));
    return Array.from(new Uint8Array(buf).slice(0, 8), b => b.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}

/* Token bucket: refill for the time since its last touch, capped at burst.
   A bucket with no stamp (new striker, or a record from before this
   existed) starts full. Mutates in place. */
function refill(bucket, now, rate, burst) {
  const known = Number.isFinite(bucket.k) && Number.isFinite(bucket.t);
  const k = known ? bucket.k + (Math.max(0, now - bucket.t) / 1000) * rate : burst;
  bucket.k = Math.min(burst, Math.max(0, k));
  bucket.t = now;
}

/* Room for a new contributor. Under the ceiling, always. At it, an account
   may evict the lowest-damage guest (guests are never rewarded); a guest,
   or an account with no guest to displace, is refused. */
function admitContributor(contributors, player) {
  const ids = Object.keys(contributors);
  if (ids.length < RAID_MAX_CONTRIBUTORS) return true;
  if (player.guest) return false;
  let worst = null;
  for (const id of ids) {
    if (id.startsWith('guest_') && (worst === null || (contributors[id].dmg || 0) < (contributors[worst].dmg || 0))) worst = id;
  }
  if (worst === null) return false;
  delete contributors[worst];
  return true;
}

/* The shared per-IP bucket for guest strikes. An idle bucket that has fully
   refilled is identical to a missing one, so those are pruned when the
   table is full; if it is still full the guest strike is refused. */
const IP_FULL_MS = (GUEST_IP_BURST / GUEST_IP_RATE_PER_SEC) * 1000;
function ipBucket(raid, ipKey, now) {
  raid.guestIps = (raid.guestIps && typeof raid.guestIps === 'object') ? raid.guestIps : {};
  let b = raid.guestIps[ipKey];
  if (!b) {
    if (Object.keys(raid.guestIps).length >= RAID_MAX_IP_BUCKETS) {
      for (const k of Object.keys(raid.guestIps)) {
        if (now - (raid.guestIps[k].t || 0) >= IP_FULL_MS) delete raid.guestIps[k];
      }
      if (Object.keys(raid.guestIps).length >= RAID_MAX_IP_BUCKETS) return null;
    }
    b = raid.guestIps[ipKey] = {};
  }
  refill(b, now, GUEST_IP_RATE_PER_SEC, GUEST_IP_BURST);
  return b;
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

/* An active boss past its deadline escapes. Stamped at the deadline itself,
   not "now", so the display window is the same for every reader however
   late the first one arrives. Returns whether it flipped. */
function expireIfDue(raid, now) {
  if (!raid || raid.status !== 'active' || !raid.endsAt || now <= raid.endsAt) return false;
  raid.status = 'escaped';
  raid.escapedAt = raid.endsAt;
  return true;
}

/* Whether a read has timed work to persist (an escape, or a due mechanic). */
function raidDue(raid, now) {
  if (!raid || raid.status !== 'active') return false;
  return (raid.endsAt && now > raid.endsAt) || (raid.nextTickAt && now >= raid.nextTickAt);
}

/* Apply every timed change up to now, in place. Returns whether anything
   changed, so the caller writes only when it must. */
function advanceRaid(raid, now) {
  if (!raid || raid.status !== 'active') return false;
  if (expireIfDue(raid, now)) return true;
  const before = JSON.stringify([raid.attackCount, raid.skillCount, raid.hp, raid.shieldUntil, raid.nextTickAt]);
  resolveMechanics(raid);
  return JSON.stringify([raid.attackCount, raid.skillCount, raid.hp, raid.shieldUntil, raid.nextTickAt]) !== before;
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

/* On a kill, code everyone who pulled their weight: an uncommon for every
   account that dealt at least minRewardDamage(), upgraded to a rare for the
   single top damager. Each code is RESTRICTED to its recipient, so a
   whispered code cannot be redeemed by whoever else sees it. Guests are
   skipped — a guest id has no account to redeem into. Best-effort per person
   so one failure never denies the rest. */
async function awardRaidRewards(env, raid) {
  const minDmg = minRewardDamage(raid.maxHp);
  const entries = Object.keys(raid.contributors || {})
    .map(id => ({ id, name: raid.contributors[id].name, dmg: Number(raid.contributors[id].dmg) || 0 }))
    .filter(e => e.id.startsWith('u_') && e.dmg >= minDmg)
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
      const itemName = `${bossName} ${top ? 'Slayer' : 'Raider'}`;
      const rec = await createItemCode(env, {
        id: `raid_${raid.id}_${e.id}`,
        game: 'skull-clicker', type: 'badge',
        name: itemName,
        rarity,
      }, { restrictedTo: [userId] });
      await activateItemCode(env, rec.code, RAID_CODE_SECONDS);
      /* Stash it as an in-game reward the player can claim on their next poll,
         so a code never depends on the whisper arriving. Expires with it. */
      try {
        await env.MARKETPLACE.put(rewardKey(userId), JSON.stringify({
          code: rec.code, rarity, name: itemName, top, boss: bossName, at: Date.now(),
        }), { expirationTtl: RAID_CODE_SECONDS });
      } catch { /* the whisper is still the backup */ }
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

/* Shared by a moderator's manual `start` and the redemption spawn, so both
   ever construct exactly one shape of raid record. `source` is carried
   only for logs/observability -- the fight itself plays out identically
   either way. */
function buildRaid({ hp, minutes, name, source }) {
  return {
    id: 'raid_' + Date.now(),
    name: String(name || 'Undead Executioner').slice(0, 40),
    maxHp: hp, hp,
    startedAt: Date.now(),
    endsAt: Date.now() + minutes * 60 * 1000,
    status: 'active',
    source: source || 'manual',
    contributors: {},
    attackCount: 0, skillCount: 0, summonCount: 0, minionDeaths: 0,
    shieldUntil: 0,
    nextTickAt: Date.now() + MECH_INTERVAL_MS,
    summonedThresholds: [],
    minions: { hp: 0, maxHp: 0 },
  };
}

/* Called by channel-points.js when "Summon Raid Boss" is redeemed. Twitch
   has already collected the points and enforced the cooldown/per-stream cap
   on the reward itself -- the only thing left to check here is whether a
   fight is already underway, since a viewer paying 10,000 points to summon
   a boss that already exists would just be a refund waiting to happen.
   mutate() makes that check-and-spawn atomic against a second redemption
   landing in the same instant.
   @returns the spawned raid, or null if one refused (caller refunds). */
export async function spawnRaidFromRedemption(env, { viewers } = {}) {
  const effectiveViewers = viewers > 0 ? viewers : REDEMPTION_MIN_VIEWERS;
  const hp = Math.min(MAX_HP, Math.max(100, Math.round(
    effectiveViewers * REDEMPTION_PARTICIPATION * REDEMPTION_CLICKS_PER_MIN * REDEMPTION_MINUTES
  )));
  let spawned = null;
  await env.MARKETPLACE.mutate(RAID_KEY, (current) => {
    /* publicState() derives the same effective status the client sees, so
       "already fighting" also covers a stored 'active' record that has
       actually timed out or a 'defeated' one still lingering for its
       banner -- not just a literal status === 'active'. */
    const status = current ? publicState(current).status : 'none';
    if (status === 'active' || status === 'defeated') return undefined;
    spawned = buildRaid({ hp, minutes: REDEMPTION_MINUTES, source: 'redemption' });
    return spawned;
  });
  return spawned;
}

/* Fold the live boss into the small public shape the game and overlay read —
   never the raw contributor map or the rate buckets. Resolves the timer so
   every reader agrees without a job: an active boss past its deadline reads
   as escaped (the legacy stored 'expired' too), for ESCAPE_LINGER_MS after
   the deadline, then as gone. */
function publicState(raid) {
  if (!raid || !raid.status) return { status: 'none' };
  const now = Date.now();
  let status = raid.status === 'expired' ? 'escaped' : raid.status;
  if (status === 'active' && raid.endsAt && now > raid.endsAt) status = 'escaped';
  if (status === 'escaped' && now - (raid.escapedAt || raid.endsAt || 0) > ESCAPE_LINGER_MS) status = 'none';
  /* A defeated boss shows just long enough for the death + banner, then reads
     as gone so the overlay panel clears itself rather than lingering. */
  if (status === 'defeated' && raid.defeatedAt && now - raid.defeatedAt > DEFEAT_LINGER_MS) status = 'none';
  if (status !== 'active' && status !== 'escaped' && status !== 'defeated') return { status: 'none' };
  const contributors = raid.contributors || {};
  const top = Object.keys(contributors)
    .map(id => ({ name: cleanName(contributors[id].name, 'Reaper'), dmg: Number(contributors[id].dmg) || 0 }))
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
    source: raid.source || 'manual',
  };
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);

  /* `?reward=1` — a logged-in raider's pending defeat code, delivered
     in-game rather than only by whisper. Session only; guests have none. */
  if (url.searchParams.get('reward')) {
    const session = getSession(request);
    if (!session || !session.user_id) return json({ reward: null });
    const reward = await env.MARKETPLACE.get(rewardKey(session.user_id), 'json');
    return json({ reward: reward || null });
  }

  /* Resolve mechanics on read too, so an idle overlay still sees the boss
     heal/guard/summon/escape on schedule. The plain read is lock-free; only
     when timed work is due does it take the lock, re-read inside mutate()
     and apply it there — so it can never overwrite a strike that landed in
     between, and it never deletes anything. */
  let raid = await env.MARKETPLACE.get(RAID_KEY, 'json');
  if (raidDue(raid, Date.now())) {
    await env.MARKETPLACE.mutate(RAID_KEY, (current) => {
      raid = current;
      return advanceRaid(current, Date.now()) ? current : undefined;
    });
  }
  return json(publicState(raid));
}

export async function onRequestPost(context) {
  const { env, request } = context;
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  /* ── Dismiss the in-game reward banner (the player has noted their code) ── */
  if (body.action === 'claim-reward') {
    const session = getSession(request);
    if (!session || !session.user_id) return json({ error: 'Not authenticated' }, 401);
    await env.MARKETPLACE.delete(rewardKey(session.user_id));
    return json({ success: true });
  }

  /* ── Start a boss — broadcaster/moderators only ── */
  if (body.action === 'start') {
    const session = getSession(request);
    const { isModerator } = await import('./admin/moderators.js');
    if (!(await isModerator(env, session))) {
      return json({ error: 'Only the broadcaster and moderators can summon a boss.' }, 403);
    }
    const hp = Math.min(MAX_HP, Math.max(100, Math.floor(Number(body.hp) || DEFAULT_HP)));
    const minutes = Math.min(120, Math.max(1, Math.floor(Number(body.minutes) || DEFAULT_MINUTES)));
    const raid = buildRaid({ hp, minutes, name: body.name, source: 'manual' });
    /* Under the lock, so a strike mid-commit on the old boss cannot write
       its record back over the new one. */
    await env.MARKETPLACE.mutate(RAID_KEY, () => raid);
    return json({ success: true, raid: publicState(raid) });
  }

  /* ── Remove the boss — broadcaster/moderators only. Replaces the record
     with an 'ended' marker whatever its state (active, defeated-but-
     lingering, or a stuck record), so it reads as 'none' at once. Written
     under the lock rather than deleted, so a strike already holding the
     lock cannot resurrect the boss by writing it back afterwards. ── */
  if (body.action === 'end') {
    const session = getSession(request);
    const { isModerator } = await import('./admin/moderators.js');
    if (!(await isModerator(env, session))) return json({ error: 'Moderators only.' }, 403);
    await env.MARKETPLACE.mutate(RAID_KEY, () => ({ status: 'ended', endedAt: Date.now() }));
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
    const ipKey = player.guest ? await clientIpKey(request) : null;

    let justDefeated = false;
    let after = null;
    let landed = 0;
    await env.MARKETPLACE.mutate(RAID_KEY, (raid) => {
      after = raid;
      if (!raid || raid.status !== 'active') return undefined;
      const now = Date.now();
      if (expireIfDue(raid, now)) return raid;

      resolveMechanics(raid);

      /* Rate limit: the strike lands only as far as this striker's bucket
         (and, for a guest, its address's bucket) allows. A refused or
         fully-throttled strike still persists the mechanics/bucket state. */
      raid.contributors = (raid.contributors && typeof raid.contributors === 'object') ? raid.contributors : {};
      const known = Object.prototype.hasOwnProperty.call(raid.contributors, player.id);
      if (!known && !admitContributor(raid.contributors, player)) return raid;
      const c = known ? raid.contributors[player.id] : { name: player.name, dmg: 0 };
      refill(c, now, RAID_RATE_PER_SEC, RAID_BURST);
      let allowed = Math.min(damage, Math.floor(c.k));
      let ipB = null;
      if (ipKey) {
        ipB = ipBucket(raid, ipKey, now);
        allowed = ipB ? Math.min(allowed, Math.floor(ipB.k)) : 0;
      }
      if (allowed <= 0) {
        if (known) raid.contributors[player.id] = c;
        return raid;
      }
      c.k -= allowed;
      if (ipB) ipB.k -= allowed;
      landed = allowed;

      /* The scythe-guard halves the strike. */
      let eff = allowed * ((raid.shieldUntil || 0) > now ? SHIELD_REDUCE : 1);

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

      c.dmg = (Number(c.dmg) || 0) + allowed;
      c.name = player.name;
      raid.contributors[player.id] = c;

      if (raid.hp <= 0) {
        raid.status = 'defeated';
        raid.defeatedAt = now;
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

    return json({ ...publicState(after), landed, throttled: landed < damage });
  }

  return json({ error: 'Invalid action' }, 400);
}
