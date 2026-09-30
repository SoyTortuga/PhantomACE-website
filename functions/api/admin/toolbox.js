/* ══════════════════════════════════════════════
   ADMIN DASHBOARD — the staff landing page.

   One place that answers "where do I go to do X" for the broadcaster and
   moderators, gated ON THE SERVER like bot-setup: a static page can only
   hide itself with JavaScript, and hiding is not refusing. Anyone else
   gets a 403 with a sign-in pointer and learns nothing about what tools
   exist.

   The individual tools keep their own gates — this page granting access
   to nothing is what makes it safe to link everything from here. It also
   shows the current staff list inline (read-only; membership is managed
   by the broadcaster through the moderators API) so "who else can do
   this" has an answer on the same screen.

   Cards are grouped by ACCESS LEVEL and all of them are visible to every
   staff member. A card whose access is broadcaster-only renders LOCKED —
   greyed, un-clickable, with a 🔒 — for a moderator, and as a normal link
   for the broadcaster. That is discoverability: a moderator can see what
   the broadcaster's tools are without being able to open them.

   /mod-toolbox.html is a static shim that redirects here, kept working for
   back-compat (membership pages link to it).
   ══════════════════════════════════════════════ */

import { isModerator, isBroadcaster, getModerators } from './moderators.js';

function getSession(request) {
  const cookie = request.headers.get('Cookie') || '';
  const match = cookie.match(/pham_session=([^;]+)/);
  if (!match) return null;
  try { return JSON.parse(decodeURIComponent(match[1])); } catch { return null; }
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function html(body, status = 200) {
  return new Response(`<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Admin Dashboard | PhantomACE</title>
<style>
  body { background: #0a0a0a; color: #fff; font-family: system-ui, sans-serif; margin: 0; padding: 24px; }
  .wrap { max-width: 900px; margin: 0 auto; }
  h1 { color: #ff0000; font-size: 22px; letter-spacing: 0.06em; }
  .sub { color: #ffffffaa; font-size: 13px; margin-bottom: 20px; }
  .section-label { color: #ff6666; font-size: 12px; text-transform: uppercase; letter-spacing: 0.09em;
                   margin: 24px 0 10px; padding-bottom: 6px; border-bottom: 1px solid #ffffff1f; }
  .section-note { color: #ffffff77; font-size: 12px; margin: 0 0 8px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
  a.tool { display: block; background: #111; border: 1px solid #ffffff1f; border-radius: 8px;
           padding: 14px; color: #fff; text-decoration: none; }
  a.tool:hover { border-color: #ff0000; }
  .tool h2 { font-size: 15px; margin: 0 0 6px; }
  .tool p { font-size: 12px; color: #ffffffaa; margin: 0 0 8px; line-height: 1.45; }
  /* Locked: broadcaster-only tool seen by a moderator. Not a link, no hover
     lift, dimmed with a dashed full border so it reads as "present but not
     yours" rather than missing. */
  .tool.locked { background: #0d0d0d; border-style: dashed; border-color: #ffffff26; opacity: 0.6; cursor: not-allowed; }
  .tool.locked .lock { font-size: 13px; color: #ff9999; }
  .tag { display: inline-block; font-size: 10px; padding: 2px 7px; border-radius: 3px;
         border: 1px solid #ffffff33; color: #ffffffcc; margin-right: 4px; }
  .tag.bc { border-color: #ff000066; color: #ff9999; }
  .staff { margin-top: 22px; background: #111; border: 1px solid #ffffff1f; border-radius: 8px; padding: 14px; }
  .staff h2 { font-size: 14px; margin: 0 0 8px; }
  .staff ul { margin: 0; padding-left: 18px; font-size: 12px; color: #ffffffcc; }
  .denied { background: #111; border: 1px solid #ff000040; border-radius: 8px; padding: 18px; max-width: 480px; margin: 60px auto; }
</style></head><body><div class="wrap">${body}</div></body></html>`, {
    status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/* Every card names its gate honestly. `access` is the DASHBOARD's own
   grouping: 'moderator' means a moderator can genuinely use the tool (even
   if some steps inside are broadcaster-only — those keep their informational
   tag); 'broadcaster' means a moderator cannot use it at all, so its card is
   locked for them. Descriptions say what you would GO there to do.

   NOTE: every tool below gates at isModerator on its own route, so a
   moderator can genuinely operate all of them — hence all are 'moderator'.
   The broadcaster-only grouping and its locked-card rendering are in place
   for any tool later marked access:'broadcaster'; locking one of the tools
   below would wrongly cut a moderator off from a tool they actually use. */
const TOOLS = [
  { href: '/bot-control.html', name: 'Bot Control', access: 'moderator',
    desc: 'Drops and giveaways live on stream: post codes, open and draw entries, run the overlay reel, point the overlay at a game room.',
    tags: ['Moderators'] },
  { href: '/overlay-dashboard.html', name: 'Overlay Dashboard', access: 'moderator',
    desc: 'Everything the stream overlay does in one place: overlay game panels, alert volume, layout presets, reload, test any alert, and replay the last giveaway reveal.',
    tags: ['Moderators'] },
  { href: '/api/admin/bot-setup', name: 'Bot & EventSub Setup', access: 'moderator',
    desc: 'One-time wiring: authorize the bot and broadcaster, create channel point rewards, create or delete EventSub subscriptions.',
    tags: ['Moderators', 'Some steps broadcaster-only'] },
  { href: '/background-studio.html', name: 'Background Studio', access: 'moderator',
    desc: 'Paint Dino Park backgrounds from the tile palette and publish them as data — no deploy involved.',
    tags: ['Moderators'] },
  { href: '/media.html', name: 'Media Uploads', access: 'moderator',
    desc: 'Upload images and clips to the community media wall.',
    tags: ['Moderators'] },
  { href: '/users.html', name: 'Users & Moderators', access: 'moderator',
    desc: 'Everyone who has logged in. The broadcaster can elevate a user to moderator or remove that role; moderators can view the roster.',
    tags: ['Moderators', 'Editing broadcaster-only'] },
  { href: '/users.html', name: 'Manage Moderators', access: 'broadcaster',
    desc: 'Elevate a user to moderator or remove that role. Broadcaster only — moderators can view the roster from Users & Moderators above.',
    tags: ['Broadcaster only'] },
  { href: '/overlay-editor.html', name: 'Overlay Layout', access: 'moderator',
    desc: 'Drag the stream overlay panels where you want them and save — the live overlay picks it up on its next load, no OBS edits. Preview it offline at /overlay?layout=1.',
    tags: ['Moderators'] },
  { href: '/maze-test.html', name: 'Chat Maze (test)', access: 'moderator',
    desc: 'Start, stop and test-drive the chat-played maze: live board view, keyboard steering, no chat required. Real play is chat typing directions.',
    tags: ['Moderators'] },
  { href: '/games/commander-bingo/host.html', name: 'Commander Bingo Host', access: 'moderator',
    desc: 'Host controls for stream bingo: create the room, call squares, end the game.',
    tags: ['Moderators'] },
  { href: '/games/mtgbbb/host.html', name: 'MTGBBB Host', access: 'moderator',
    desc: 'Booster Box Bingo host panel: open a room for a set, mark pulls as you crack packs, call shots, end the game and award prizes.',
    tags: ['Moderators'] },
];

/* One card. A broadcaster-only tool viewed by a non-broadcaster is a locked
   <div> (no href, aria-disabled, 🔒); everything else is a normal <a>.
   Exported so the test can exercise the lock without a full request. */
export function renderToolCard(t, broadcaster) {
  const tags = (t.tags || []).map(tag =>
    `<span class="tag${/broadcaster/i.test(tag) ? ' bc' : ''}">${esc(tag)}</span>`).join('');
  const bcTag = t.access === 'broadcaster' ? '<span class="tag bc">Broadcaster only</span>' : '';
  const locked = t.access === 'broadcaster' && !broadcaster;

  if (locked) {
    return `<div class="tool locked" aria-disabled="true" title="Broadcaster only — you are signed in as a moderator">
      <h2>${esc(t.name)} <span class="lock">🔒</span></h2><p>${esc(t.desc)}</p>${tags}${bcTag}
    </div>`;
  }
  return `<a class="tool" href="${esc(t.href)}">
    <h2>${esc(t.name)}</h2><p>${esc(t.desc)}</p>${tags}${bcTag}
  </a>`;
}

export { TOOLS };

export async function onRequestGet(context) {
  const { env, request } = context;
  const session = getSession(request);

  const broadcaster = isBroadcaster(env, session);
  if (!broadcaster && !(await isModerator(env, session))) {
    /* The refusal names the requirement and nothing else — not the tools,
       not who the moderators are. */
    return html(`<div class="denied"><h1>Staff only</h1>
      <p class="sub">The Admin Dashboard is for the broadcaster and approved moderators.
      ${session ? 'This account is not on the staff list.' : 'Sign in on the main site first.'}</p>
      <p><a href="/" style="color:#ff6666">Back to phantomace.tv</a></p></div>`, 403);
  }

  const modTools = TOOLS.filter(t => t.access !== 'broadcaster');
  const bcTools = TOOLS.filter(t => t.access === 'broadcaster');

  const modSection = `<h2 class="section-label">Moderator</h2>
    <p class="section-note">Tools the broadcaster and every moderator can use.</p>
    <div class="grid">${modTools.map(t => renderToolCard(t, broadcaster)).join('')}</div>`;

  /* The broadcaster-only section is always labelled so the split is visible.
     When there is nothing to show it says so plainly rather than rendering an
     empty grid. */
  const bcSection = `<h2 class="section-label">Broadcaster only</h2>
    ${bcTools.length
      ? `<p class="section-note">${broadcaster
          ? 'Yours to run.'
          : 'Visible so you know they exist; locked because they are the broadcaster\'s.'}</p>
         <div class="grid">${bcTools.map(t => renderToolCard(t, broadcaster)).join('')}</div>`
      : '<p class="section-note">Nothing here right now — every tool above is usable by moderators too.</p>'}`;

  const { entries } = await getModerators(env);
  const staff = entries.map(e => `<li>${esc(e.displayName || e.userId)}</li>`).join('')
    || '<li>(no moderators listed yet)</li>';

  return html(`<h1>🛠 Admin Dashboard</h1>
    <p class="sub">Signed in as <b>${esc(session.display_name || session.user_id)}</b>${broadcaster ? ' — broadcaster' : ' — moderator'}.
    Every tool keeps its own permission checks; this page is just the map.</p>
    ${modSection}
    ${bcSection}
    <div class="staff"><h2>Current staff</h2>
      <ul><li>PhantomACE (broadcaster)</li>${staff}</ul>
      <p style="font-size:11px;color:#ffffff77">Membership is managed by the broadcaster in Bot &amp; EventSub Setup.</p>
    </div>`);
}
