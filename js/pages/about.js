/* ══════════════════════════════════════════════
   ABOUT PAGE — broadcaster-editable copy.

   The bio and the values used to be prose in about.html, so changing a
   sentence meant an edit, a commit, a push and a restart. They are now
   stored server-side and applied over the top of the markup.

   THE HTML IS THE DEFAULT, NOT A PLACEHOLDER. A field that has never been
   edited is absent from the response and simply left alone, and a failed
   fetch changes nothing. So the page reads correctly with an empty database,
   with the API down, and before anyone has ever pressed Edit.

   Everything is written with textContent. The server stores plain text for
   this reason; the two halves have to agree, or the edit box on a public
   page becomes a way to put markup into every visitor's DOM.
   ══════════════════════════════════════════════ */

(function () {
  const FIELDS = {
    subtitle: 'aboutSubtitle',
    bioTitle: 'aboutBioTitle',
    bioBody: 'aboutBioBody',
    valuesHeading: 'aboutValuesHeading',
    value1Title: 'aboutValue1Title',
    value1Body: 'aboutValue1Body',
    value2Title: 'aboutValue2Title',
    value2Body: 'aboutValue2Body',
    value3Title: 'aboutValue3Title',
    value3Body: 'aboutValue3Body',
    statStreams: 'statStreams',
    statGoals: 'statGoals',
    statCommunity: 'statCommunity',
  };

  /* bioBody is many paragraphs; the rest are single elements. */
  const MULTILINE = new Set(['bioBody']);

  let content = {};
  let editing = false;

  const $ = (id) => document.getElementById(id);

  /** What the page currently shows, so Edit starts from the live text. */
  function readCurrent(name) {
    if (content[name]) return content[name];
    const el = $(FIELDS[name]);
    if (!el) return '';
    if (MULTILINE.has(name)) {
      return [...el.querySelectorAll('p')].map(p => p.textContent.trim()).join('\n\n');
    }
    return el.textContent.trim();
  }

  function applyField(name, text) {
    const el = $(FIELDS[name]);
    if (!el || !text) return;
    if (MULTILINE.has(name)) {
      el.textContent = '';
      for (const para of text.split(/\n{2,}/)) {
        const trimmed = para.trim();
        if (!trimmed) continue;
        const p = document.createElement('p');
        /* textContent, so stored copy can never be markup. */
        p.textContent = trimmed;
        el.appendChild(p);
      }
    } else {
      el.textContent = text;
    }
  }

  function apply() {
    for (const name of Object.keys(FIELDS)) {
      if (content[name]) applyField(name, content[name]);
    }
  }

  /* ── The editor ─────────────────────────────────────────────────────── */

  function buildBar(canEdit, updatedAt, updatedBy) {
    if (!canEdit) return;

    const bar = document.createElement('div');
    bar.className = 'about-edit-bar';
    bar.innerHTML =
      '<span class="about-edit-note" id="aboutEditNote"></span>' +
      '<button class="btn-secondary" id="aboutEditBtn">Edit Page</button>' +
      '<button class="btn-primary" id="aboutSaveBtn" hidden>Save</button>' +
      '<button class="btn-secondary" id="aboutCancelBtn" hidden>Cancel</button>';

    const hero = document.querySelector('.page-hero');
    if (hero && hero.parentNode) hero.parentNode.insertBefore(bar, hero.nextSibling);
    else document.body.insertBefore(bar, document.body.firstChild);

    if (updatedAt) {
      $('aboutEditNote').textContent =
        'Last edited ' + new Date(updatedAt).toLocaleDateString('en-US',
          { month: 'short', day: 'numeric', year: 'numeric' }) +
        (updatedBy ? ' by ' + updatedBy : '');
    }

    $('aboutEditBtn').addEventListener('click', openEditor);
    $('aboutCancelBtn').addEventListener('click', () => { closeEditor(); apply(); });
    $('aboutSaveBtn').addEventListener('click', save);
  }

  /* Each editable element is replaced in place by a textarea sized to it, so
     the broadcaster edits the page rather than a form that represents it. */
  function openEditor() {
    if (editing) return;
    editing = true;

    for (const [name, id] of Object.entries(FIELDS)) {
      const el = $(id);
      if (!el) continue;

      const box = document.createElement('textarea');
      box.className = 'about-edit-box' + (MULTILINE.has(name) ? ' is-tall' : '');
      box.value = readCurrent(name);
      box.dataset.field = name;
      box.rows = MULTILINE.has(name) ? 12 : 1;

      el.dataset.aboutHidden = '1';
      el.style.display = 'none';
      el.parentNode.insertBefore(box, el.nextSibling);
    }

    $('aboutEditBtn').hidden = true;
    $('aboutSaveBtn').hidden = false;
    $('aboutCancelBtn').hidden = false;
  }

  function closeEditor() {
    editing = false;
    for (const box of [...document.querySelectorAll('.about-edit-box')]) box.remove();
    for (const el of [...document.querySelectorAll('[data-about-hidden]')]) {
      el.style.display = '';
      delete el.dataset.aboutHidden;
    }
    $('aboutEditBtn').hidden = false;
    $('aboutSaveBtn').hidden = true;
    $('aboutCancelBtn').hidden = true;
  }

  async function save() {
    const btn = $('aboutSaveBtn');
    btn.disabled = true;
    btn.textContent = 'Saving…';

    const patch = {};
    for (const box of document.querySelectorAll('.about-edit-box')) {
      patch[box.dataset.field] = box.value;
    }

    try {
      const res = await fetch('/api/about', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ content: patch }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not save.');

      content = data.content || {};
      closeEditor();
      /* A field cleared to empty falls back to the HTML, so the page is
         reloaded rather than patched — restoring the original markup by hand
         would mean keeping a second copy of it here. */
      if (Object.keys(FIELDS).some(n => !content[n] && readCurrent(n) !== '')) {
        window.location.reload();
        return;
      }
      apply();
      $('aboutEditNote').textContent = 'Saved just now';
    } catch (err) {
      btn.textContent = 'Save';
      btn.disabled = false;
      $('aboutEditNote').textContent = err.message;
      return;
    }

    btn.textContent = 'Save';
    btn.disabled = false;
  }

  /* ── Boot ───────────────────────────────────────────────────────────── */

  document.addEventListener('DOMContentLoaded', async () => {
    try {
      const res = await fetch('/api/about', { credentials: 'same-origin' });
      if (!res.ok) return;                 // leave the markup exactly as it is
      const data = await res.json();
      content = data.content || {};
      apply();
      buildBar(!!data.canEdit, data.updatedAt, data.updatedBy);
    } catch {
      /* Offline or the API is down. The page already reads correctly. */
    }
  });
})();
