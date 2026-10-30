/* ── Moon Sweepers Power-ups ──────────────────────────────────────────
   The list and the live flag both come from /api/powerups/moon-sweepers,
   which reads the same module the bot's announcements and !powerups reply
   do. Nothing about the 21 Power-ups is written into this page: one copy,
   on the server, so the page can never disagree with chat. */

const POLL_MS = 30000;

const el = (id) => document.getElementById(id);

function setLive(live, category) {
  const dot = el('msLive');
  const text = el('msLiveText');
  if (!dot || !text) return;

  if (live) {
    dot.dataset.state = 'on';
    text.textContent = 'Live — your Bits land in the game';
  } else {
    dot.dataset.state = 'off';
    text.textContent = category
      ? `Not live — the stream is on ${category}`
      : 'Not live right now';
  }
}

/* The gravity warnings are the tail of their own description, so they are
   lifted out of the text rather than stored twice — no wording can drift
   between the chip and the sentence it came from. */
function renderEffect(p) {
  const wrap = document.createElement('p');
  wrap.className = 'ms-effect';

  if (p.warning && p.effect.endsWith(p.warning)) {
    wrap.append(document.createTextNode(p.effect.slice(0, -p.warning.length)));
    const warn = document.createElement('strong');
    warn.className = 'ms-warn-strong';
    warn.textContent = p.warning;
    wrap.append(warn);
  } else {
    wrap.textContent = p.effect;
  }
  return wrap;
}

function renderList(powerups) {
  const list = el('msList');
  if (!list) return;
  /* Replace the children rather than appending: the poll below re-renders. */
  list.textContent = '';

  for (const p of powerups) {
    const li = document.createElement('li');
    li.className = 'ms-item';
    if (p.warning) li.classList.add('ms-item-warned');

    const head = document.createElement('div');
    head.className = 'ms-item-head';

    const title = document.createElement('h3');
    title.className = 'ms-item-title';
    title.textContent = p.title;

    const cost = document.createElement('span');
    cost.className = 'ms-cost';
    cost.textContent = `${p.bits.toLocaleString()} Bits`;

    head.append(title, cost);
    li.append(head, renderEffect(p));
    list.append(li);
  }
}

function renderNotes(notes) {
  const wrap = el('msNotes');
  if (!wrap) return;
  wrap.textContent = '';

  for (const n of notes) {
    const card = document.createElement('section');
    card.className = 'card ms-note-card';

    const h = document.createElement('h3');
    h.className = 'ms-note-title';
    h.textContent = n.heading;

    const p = document.createElement('p');
    p.className = 'ms-note-body';
    p.textContent = n.body;

    card.append(h, p);
    wrap.append(card);
  }
}

async function load() {
  try {
    const res = await fetch('/api/powerups/moon-sweepers', { headers: { 'Accept': 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();

    setLive(!!data.live, data.category);

    const count = el('msCount');
    if (count) count.textContent = String(data.count);

    renderList(data.powerups || []);
    renderNotes(data.notes || []);

    const loading = el('msLoading');
    if (loading) loading.hidden = true;
    const error = el('msError');
    if (error) error.hidden = true;
    const body = el('msBody');
    if (body) body.hidden = false;
  } catch (err) {
    console.error('[moonsweepers]', err.message);
    const loading = el('msLoading');
    if (loading) loading.hidden = true;
    /* Only show the failure while there is nothing on screen. A poll that
       fails after a good load should leave the list people are reading. */
    const body = el('msBody');
    if (body && body.hidden) {
      const error = el('msError');
      if (error) error.hidden = false;
    }
  }
}

load();

/* A viewer leaves this open while watching, so the live flag has to keep up
   with him switching games. Paused while the tab is hidden: nothing on the
   page changes without someone looking at it. */
setInterval(() => {
  if (document.hidden) return;
  load();
}, POLL_MS);

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) load();
});
