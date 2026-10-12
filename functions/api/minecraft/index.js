/* ══════════════════════════════════════════════
   /api/minecraft — the subscriber whitelist, self-service

   GET   what the page needs: whether you may join, your entry if you have
         one, and the server's live status.
   POST  { action: 'join', name }   put your Minecraft name on the whitelist
   POST  { action: 'leave' }        take it off again

   NO NEW TABLE. The entry lives on the profile record as `minecraft`,
   beside the comment and mention switches, so this needs no migration on
   the rig — `profile_` is already a registered family and `mutate()` on it
   is the same call the login flow uses. The whitelist feed reads the same
   records through the scan the member directory already does.

   THE NAME IS RESOLVED WITH MOJANG BEFORE IT IS STORED. Three reasons, and
   the first is the one that matters: a typo'd name whitelists nobody, and
   the player finds out by being kicked at the door rather than by being
   told here. It also gets us the UUID, which is what whitelist.json
   actually keys on — a name-only whitelist breaks the moment somebody
   changes their Minecraft name.

   ELIGIBILITY IS A SNAPSHOT, AND THAT IS DELIBERATE. The cookie's role is
   from last login, and the site holds no broadcaster token to re-check a
   subscription on demand. So `lastSubAt` is stamped every time an eligible
   person loads this page, and the whitelist keeps anyone whose stamp is
   within GRACE_DAYS. A lapsed sub simply stops refreshing it and ages out;
   nobody has to detect the lapse, which is good, because nothing here
   can.
   ══════════════════════════════════════════════ */

/** Everything about the server that the page states as fact. */
export const SERVER = {
  name: 'Cursed Walking',
  packVersion: 'v3.3',
  minecraft: '1.20.1',
  loader: 'Forge',
  host: 'mc.phantomace.tv',
  port: 25566,
  pack: 'Cursed Walking - A Modern Zombie Apocalypse',
  curseforge: 'https://www.curseforge.com/minecraft/modpacks/cursed-walking-a-modern-zombie-apocalypse',
  /* The pack's own recommendation. Players who allocate the default 2GB
     bounce off it, and the failure looks like the server's fault. */
  ramMinGb: 4,
  ramRecommendedGb: 6,
};

/** How long a lapsed subscriber keeps their place. */
export const GRACE_DAYS = 7;
const GRACE_MS = GRACE_DAYS * 24 * 60 * 60 * 1000;

/** Roles that may put a name on the list. Staff included — they moderate it. */
const ELIGIBLE = new Set(['sub_tier1', 'sub_tier2', 'sub_tier3', 'moderator', 'broadcaster']);

/* Mojang's rule: 3-16 of letters, digits and underscore. Checked here so an
   obviously bad name never becomes an outbound request. */
const NAME_RE = /^[A-Za-z0-9_]{3,16}$/;

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

/** 32 hex characters as Mojang returns them, into the dashed form files use. */
export function dashUuid(raw) {
  const s = String(raw || '').replace(/-/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(s)) return null;
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/**
 * The whitelist entry as the rest of the site should read it.
 * Exported because the feed applies exactly the same rule — one definition
 * of "still whitelisted", or the page and the server disagree about who is
 * allowed in, which is the worst possible bug here.
 */
export function entryOf(profile, now = Date.now()) {
  const m = profile && profile.minecraft;
  if (!m || !m.name || !m.uuid) return null;
  const since = Number(m.lastSubAt) || Number(m.addedAt) || 0;
  const expiresAt = since + GRACE_MS;
  return {
    name: m.name,
    uuid: m.uuid,
    addedAt: Number(m.addedAt) || since,
    expiresAt,
    /* Expired entries are still RETURNED, flagged — the page has to be able
       to say "you aged out" rather than silently showing an empty form, and
       the feed filters on this same flag. */
    active: now < expiresAt,
  };
}

/** Ask Mojang whether this name exists, and what its UUID is. */
async function resolveName(name) {
  let res;
  try {
    res = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`, {
      headers: { Accept: 'application/json' },
    });
  } catch {
    return { error: 'Could not reach Mojang to check that name. Try again in a moment.', status: 502 };
  }
  /* 404 and 204 both mean "no such player" depending on which of Mojang's
     fronts answers. Neither is an outage. */
  if (res.status === 404 || res.status === 204) {
    return { error: 'No Minecraft account with that name. Check the spelling — it is your Java username, not your Twitch name.', status: 404 };
  }
  if (res.status === 429) {
    return { error: 'Mojang is rate-limiting us. Wait a minute and try again.', status: 503 };
  }
  if (!res.ok) return { error: 'Mojang could not be reached right now.', status: 502 };

  let body;
  try { body = await res.json(); } catch { return { error: 'Mojang sent something unreadable.', status: 502 }; }
  const uuid = dashUuid(body && body.id);
  if (!uuid || !body.name) return { error: 'Mojang sent something unreadable.', status: 502 };
  /* Their capitalisation, not the player's — it is what shows in game. */
  return { name: String(body.name), uuid };
}

/* ── GET ─────────────────────────────────────────────────────────────── */

export async function onRequestGet(context) {
  const { env, request } = context;
  const session = getSession(request);

  const join = {
    host: SERVER.host, port: SERVER.port, name: SERVER.name,
    packVersion: SERVER.packVersion, minecraft: SERVER.minecraft, loader: SERVER.loader,
    pack: SERVER.pack, curseforge: SERVER.curseforge,
    ramMinGb: SERVER.ramMinGb, ramRecommendedGb: SERVER.ramRecommendedGb,
  };

  if (!session || !session.user_id) {
    return json({ loggedIn: false, eligible: false, you: null, join, graceDays: GRACE_DAYS });
  }

  const me = String(session.user_id);
  const role = session.role || 'visitor';
  const eligible = ELIGIBLE.has(role);

  /* THE STAMP. Loading the page as an eligible person is what keeps the
     entry alive, because it is the only moment we have evidence the sub is
     current. Only ever moved forward, and only for somebody already on the
     list — this must not create an entry. */
  let profile = await env.MARKETPLACE.get(`profile_${me}`, 'json');
  if (eligible && profile && profile.minecraft && profile.minecraft.name) {
    const now = Date.now();
    profile = await env.MARKETPLACE.mutate(`profile_${me}`, (p) => {
      if (!p || !p.minecraft || !p.minecraft.name) return undefined;
      if (Number(p.minecraft.lastSubAt) >= now) return undefined;   // nothing to move
      return { ...p, minecraft: { ...p.minecraft, lastSubAt: now } };
    }) || profile;
  }

  return json({
    loggedIn: true,
    eligible,
    role,
    twitchName: session.display_name || '',
    you: entryOf(profile),
    join,
    graceDays: GRACE_DAYS,
    server: await pingServer(),
  });
}

/* ── POST ────────────────────────────────────────────────────────────── */

export async function onRequestPost(context) {
  const { env, request } = context;
  const session = getSession(request);
  if (!session || !session.user_id) return json({ error: 'Log in first.' }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }
  if (!body || typeof body !== 'object') return json({ error: 'Bad request' }, 400);

  const me = String(session.user_id);

  if (body.action === 'leave') {
    const after = await env.MARKETPLACE.mutate(`profile_${me}`, (p) => {
      if (!p) return undefined;
      if (!p.minecraft) return undefined;
      const next = { ...p };
      delete next.minecraft;
      return next;
    });
    /* Idempotent on purpose: leaving twice is a double-click, not an error. */
    return json({ ok: true, you: entryOf(after) });
  }

  if (body.action !== 'join') return json({ error: 'Unknown action' }, 400);

  /* THE GATE. Checked on the write, never only in the UI. */
  if (!ELIGIBLE.has(session.role || '')) {
    return json({ error: 'The server is for subscribers. Subscribe on Twitch and log in again to pick the new role up.' }, 403);
  }

  const raw = String(body.name == null ? '' : body.name).trim();
  if (!NAME_RE.test(raw)) {
    return json({ error: 'That is not a Minecraft username — 3 to 16 letters, numbers or underscores.' }, 400);
  }

  const resolved = await resolveName(raw);
  if (resolved.error) return json({ error: resolved.error }, resolved.status);

  /* ONE ACCOUNT PER NAME. Without this, two people can whitelist the same
     Minecraft account and the second silently inherits the first's place —
     and when one leaves, the other is removed from the server too. */
  const taken = await nameTakenBy(env, resolved.uuid, me);
  if (taken) {
    return json({ error: `That Minecraft account is already on the list under another Twitch account (${taken}).` }, 409);
  }

  const now = Date.now();
  const after = await env.MARKETPLACE.mutate(`profile_${me}`, (p) => {
    if (!p || typeof p !== 'object') return undefined;        // no record: nothing to attach to
    const prev = p.minecraft || {};
    return {
      ...p,
      minecraft: {
        name: resolved.name,
        uuid: resolved.uuid,
        addedAt: Number(prev.addedAt) || now,
        lastSubAt: now,
      },
    };
  });

  if (!after) return json({ error: 'There is no profile to attach that to yet. Log out and back in once.' }, 404);
  return json({ ok: true, you: entryOf(after) });
}

/**
 * Is this Minecraft account already claimed by somebody else?
 * Returns the other person's display name, or null.
 */
async function nameTakenBy(env, uuid, meId) {
  let rows = [];
  try {
    rows = await env.MARKETPLACE.listValues({ prefix: 'profile_' });
  } catch {
    /* A scan that fails must not block a legitimate join. The feed de-dupes
       by uuid as well, so the worst case is caught before it reaches the
       server's whitelist. */
    return null;
  }
  for (const row of rows || []) {
    const p = row && (row.value !== undefined ? row.value : row);
    if (!p || typeof p !== 'object' || !p.minecraft) continue;
    if (p.minecraft.uuid !== uuid) continue;
    if (String(p.userId || '') === String(meId)) continue;
    /* A row keyed by somebody else holding the same uuid. The key is not
       returned by every shim shape, so identify by the record itself. */
    if (p.login || p.displayName) return p.displayName || p.login;
    return 'another account';
  }
  return null;
}

/* ── Live status ─────────────────────────────────────────────────────
   The Server List Ping handshake, which is what the multiplayer menu uses:
   a varint-framed handshake packet, then an empty status request, then a
   JSON blob back. ~40 lines rather than a dependency.

   BEST EFFORT, ALWAYS. The page is useful without it, so every failure
   path returns `{ online: false }` rather than throwing — a server that is
   down must not take the whitelist form down with it. */

function varint(value) {
  const out = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}

function readVarint(buf, offset) {
  let result = 0, shift = 0, pos = offset;
  while (pos < buf.length) {
    const b = buf[pos++];
    result |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return { value: result >>> 0, next: pos };
    shift += 7;
    if (shift > 35) break;
  }
  return null;
}

export async function pingServer(host = SERVER.host, port = SERVER.port, timeoutMs = 2500) {
  let net;
  try { net = await import('node:net'); } catch { return { online: false }; }

  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; try { socket.destroy(); } catch {} resolve(v); } };

    const socket = new net.Socket();
    const timer = setTimeout(() => done({ online: false }), timeoutMs);
    socket.setTimeout(timeoutMs);

    let chunks = Buffer.alloc(0);

    socket.on('error', () => { clearTimeout(timer); done({ online: false }); });
    socket.on('timeout', () => { clearTimeout(timer); done({ online: false }); });

    socket.on('data', (d) => {
      chunks = Buffer.concat([chunks, d]);
      const head = readVarint(chunks, 0);
      if (!head) return;                                  // length not complete
      if (chunks.length < head.next + head.value) return; // body not complete
      const pid = readVarint(chunks, head.next);
      if (!pid || pid.value !== 0x00) { clearTimeout(timer); return done({ online: false }); }
      const str = readVarint(chunks, pid.next);
      if (!str) { clearTimeout(timer); return done({ online: false }); }
      const payload = chunks.slice(str.next, str.next + str.value).toString('utf8');
      clearTimeout(timer);
      try {
        const s = JSON.parse(payload);
        done({
          online: true,
          players: Number(s.players && s.players.online) || 0,
          max: Number(s.players && s.players.max) || 0,
          version: (s.version && s.version.name) || '',
          /* The MOTD arrives as either a string or a chat component tree. */
          motd: flattenMotd(s.description).slice(0, 200),
        });
      } catch { done({ online: false }); }
    });

    socket.connect(port, host, () => {
      const hostBuf = Buffer.from(host, 'utf8');
      const payload = Buffer.concat([
        varint(0x00),                 // handshake
        varint(765),                  // protocol version; any recent number works for a status ping
        varint(hostBuf.length), hostBuf,
        Buffer.from([(port >> 8) & 0xff, port & 0xff]),
        varint(1),                    // next state: status
      ]);
      socket.write(Buffer.concat([varint(payload.length), payload]));
      socket.write(Buffer.concat([varint(1), varint(0x00)]));   // status request
    });
  });
}

/** A MOTD is a string, or a nested chat component. Flatten either to text. */
export function flattenMotd(d) {
  if (d == null) return '';
  if (typeof d === 'string') return d;
  if (Array.isArray(d)) return d.map(flattenMotd).join('');
  if (typeof d === 'object') {
    return (typeof d.text === 'string' ? d.text : '') +
      (Array.isArray(d.extra) ? d.extra.map(flattenMotd).join('') : '');
  }
  return '';
}
