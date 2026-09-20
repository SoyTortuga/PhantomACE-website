/* ══════════════════════════════════════════════
   MOD TOOLBOX — the staff landing page.

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

   /mod-toolbox.html is a static shim that redirects here, purely so the
   URL people remember is a pretty one.
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
<title>Mod Toolbox | PhantomACE</title>
<style>
  body { background: #0a0a0a; color: #fff; font-family: system-ui, sans-serif; margin: 0; padding: 24px; }
  .wrap { max-width: 900px; margin: 0 auto; }
  h1 { color: #ff0000; font-size: 22px; letter-spacing: 0.06em; }
  .sub { color: #ffffffaa; font-size: 13px; margin-bottom: 20px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 12px; }
  a.tool { display: block; background: #111; border: 1px solid #ffffff1f; border-radius: 8px;
           padding: 14px; color: #fff; text-decoration: none; }
  a.tool:hover { border-color: #ff0000; }
  .tool h2 { font-size: 15px; margin: 0 0 6px; }
  .tool p { font-size: 12px; color: #ffffffaa; margin: 0 0 8px; line-height: 1.45; }
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

/* Every card names its gate honestly: the page never grants anything, so
   listing a broadcaster-only step for a moderator is information, not a
   door. Descriptions say what you would GO there to do. */
const TOOLS = [
  { href: '/bot-control.html', name: 'Bot Control',
    desc: 'Drops and giveaways live on stream: post codes, open and draw entries, run the overlay reel, point the overlay at a game room.',
    tags: ['Moderators'] },
  { href: '/api/admin/bot-setup', name: 'Bot & EventSub Setup',
    desc: 'One-time wiring: authorize the bot and broadcaster, create channel point rewards, create or delete EventSub subscriptions.',
    tags: ['Moderators', 'Some steps broadcaster-only'] },
  { href: '/background-studio.html', name: 'Background Studio',
    desc: 'Paint Dino Park backgrounds from the tile palette and publish them as data — no deploy involved.',
    tags: ['Moderators'] },
  { href: '/media.html', name: 'Media Uploads',
    desc: 'Upload images and clips to the community media wall.',
    tags: ['Moderators'] },
  { href: '/maze-test.html', name: 'Chat Maze (test)',
    desc: 'Start, stop and test-drive the chat-played maze: live board view, keyboard steering, no chat required. Real play is chat typing directions.',
    tags: ['Moderators'] },
  { href: '/games/commander-bingo/host.html', name: 'Commander Bingo Host',
    desc: 'Host controls for stream bingo: create the room, call squares, end the game.',
    tags: ['Moderators'] },
];

export async function onRequestGet(context) {
  const { env, request } = context;
  const session = getSession(request);

  const broadcaster = isBroadcaster(env, session);
  if (!broadcaster && !(await isModerator(env, session))) {
    /* The refusal names the requirement and nothing else — not the tools,
       not who the moderators are. */
    return html(`<div class="denied"><h1>Staff only</h1>
      <p class="sub">The Mod Toolbox is for the broadcaster and approved moderators.
      ${session ? 'This account is not on the staff list.' : 'Sign in on the main site first.'}</p>
      <p><a href="/" style="color:#ff6666">Back to phantomace.tv</a></p></div>`, 403);
  }

  const cards = TOOLS.map(t => `<a class="tool" href="${t.href}">
    <h2>${esc(t.name)}</h2><p>${esc(t.desc)}</p>
    ${t.tags.map(tag => `<span class="tag${/broadcaster/i.test(tag) ? ' bc' : ''}">${esc(tag)}</span>`).join('')}
  </a>`).join('');

  const { entries } = await getModerators(env);
  const staff = entries.map(e => `<li>${esc(e.displayName || e.userId)}</li>`).join('')
    || '<li>(no moderators listed yet)</li>';

  return html(`<h1>🛠 Mod Toolbox</h1>
    <p class="sub">Signed in as <b>${esc(session.display_name || session.user_id)}</b>${broadcaster ? ' — broadcaster' : ' — moderator'}.
    Every tool keeps its own permission checks; this page is just the map.</p>
    <div class="grid">${cards}</div>
    <div class="staff"><h2>Current staff</h2>
      <ul><li>PhantomACE (broadcaster)</li>${staff}</ul>
      <p style="font-size:11px;color:#ffffff77">Membership is managed by the broadcaster in Bot &amp; EventSub Setup.</p>
    </div>`);
}
