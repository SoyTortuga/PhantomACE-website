/* ══════════════════════════════════════════════
   PER-ALERT SOUNDS

   The overlay plays one default sting for every celebratory alert. This lets
   the broadcaster (or an approved moderator) give each alert type its OWN
   uploaded sound and volume. The config is a single singleton record keyed by
   alert type; the overlay reads it on every poll (see overlay/events.js) and
   falls back to the default sting for any type left unset.

   WHAT IS STORED, AND WHY IT IS VALIDATED

   { [alertType]: { url, volume } } — nothing else. The url must be one of OUR
   own uploads (a /cdn/media path matching the exact name the media store
   generates for an audio file), never an arbitrary address: the overlay sets
   it as an <audio> src on the stream, so an open url field would be a way to
   point the broadcaster's overlay at anything. Volume is clamped to 0..1.
   ══════════════════════════════════════════════ */

const KEY = 'alert_sounds';

/* EVERY ALERT THE OVERLAY SHOWS may have a sound — this used to be only the
   six celebratory ones, which left a mythic MTGBBB pull silent while a follow
   chimed.

   Two different sets, and the difference matters:

     these                      — may have an UPLOADED sound
     SOUND_ALERT_TYPES (overlay.js) — play the DEFAULT sting when none is set

   The six remain the only ones that make a noise out of the box. The eleven
   added here are silent until the broadcaster uploads something for them,
   because defaulting them to the sting would mean a bingo night firing the
   same sound on every call the moment this shipped.

   egg-video is deliberately absent: that clip carries its own audio, on the
   same volume and mute plumbing, so a sting would play over it. */
export const ALERT_SOUND_TYPES = [
  /* The celebratory six, which also have a default sting. */
  'sub', 'resub', 'giftsub', 'raid', 'follow', 'cheer',
  /* Opt-in: silent until given a sound. */
  'hype-level', 'drop', 'dino-hatch', 'giveaway-spin', 'prediction',
  'bingo-call', 'bingo-win', 'bingo-claim', 'mtgbbb-pull', 'mtgbbb-bingo',
];

/* Exactly a stored audio file from the media store: the 13-digit timestamp and
   10-char suffix it generates, with an audio extension. Rejects image/video
   names and any url we did not mint. */
const MEDIA_AUDIO_RE = /^\/cdn\/media\/[0-9]{13}_[a-z0-9]{10}\.(mp3|ogg|wav|m4a)$/;

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

/** The stored config, always an object keyed by a known alert type. */
export async function readAlertSounds(env) {
  let rec = null;
  try { rec = await env.MARKETPLACE.get(KEY, 'json'); } catch (e) { /* default empty */ }
  const out = {};
  if (rec && typeof rec === 'object') {
    for (const type of ALERT_SOUND_TYPES) {
      const v = rec[type];
      if (v && typeof v.url === 'string') {
        out[type] = { url: v.url, volume: typeof v.volume === 'number' ? v.volume : 1 };
      }
    }
  }
  return out;
}

/* Public read: the overlay is a keyed OBS URL with no cookie, and the config is
   only sound urls and volumes. The overlay actually gets this through its poll
   payload; this endpoint backs the dashboard UI and any direct reader. */
export async function onRequestGet(context) {
  const { env } = context;
  return json({ sounds: await readAlertSounds(env), types: ALERT_SOUND_TYPES });
}

export async function onRequestPost(context) {
  const { env, request } = context;

  const { isModerator } = await import('./admin/moderators.js');
  const session = getSession(request);
  if (!(await isModerator(env, session))) {
    return json({ error: 'You need broadcaster or moderator access for this.' }, 403);
  }

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  const type = body && body.type;
  if (ALERT_SOUND_TYPES.indexOf(type) === -1) {
    return json({ error: 'Unknown alert type.' }, 400);
  }

  /* Clear reverts the type to the default sting. */
  if (body && body.clear === true) {
    await env.MARKETPLACE.mutate(KEY, (cur) => {
      const rec = (cur && typeof cur === 'object') ? { ...cur } : {};
      delete rec[type];
      return rec;
    });
    return json({ success: true, sounds: await readAlertSounds(env) });
  }

  const url = body && typeof body.url === 'string' ? body.url : '';
  if (!MEDIA_AUDIO_RE.test(url)) {
    return json({ error: 'Upload a sound first — the url must be an uploaded audio file.' }, 400);
  }

  const rawVol = Number(body && body.volume);
  const volume = Number.isFinite(rawVol) ? Math.max(0, Math.min(1, rawVol)) : 1;

  await env.MARKETPLACE.mutate(KEY, (cur) => {
    const rec = (cur && typeof cur === 'object') ? { ...cur } : {};
    rec[type] = { url, volume };
    return rec;
  });

  return json({ success: true, sounds: await readAlertSounds(env) });
}
