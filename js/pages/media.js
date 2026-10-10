/* The gallery is loaded from the server. This used to be a hardcoded empty
   array that nothing ever filled, so an upload appeared on the page until
   the next refresh and then vanished — the file and the index entry both
   survived, and no endpoint ever read them back. */
let GALLERY_DATA = [];
let canManage = false;

let currentFilter = 'all';
let lightboxIndex = -1;
let filteredItems = [];

document.addEventListener('DOMContentLoaded', () => {
  initFilters();
  initLightbox();
  initGalleryClicks();
  initUpload();
  loadGallery();
});

async function loadGallery() {
  const grid = document.getElementById('galleryGrid');
  if (grid) grid.innerHTML = '<div class="gallery-empty"><p>Loading…</p></div>';

  try {
    const res = await fetch('/api/media', { credentials: 'same-origin' });
    if (!res.ok) throw new Error('Could not load the gallery.');
    const data = await res.json();
    GALLERY_DATA = Array.isArray(data.items) ? data.items : [];
    canManage = !!data.canManage;
  } catch {
    GALLERY_DATA = [];
    canManage = false;
    if (grid) grid.innerHTML = '<div class="gallery-empty"><p>Could not load the gallery. Try again shortly.</p></div>';
    return;
  }

  /* The server decides who sees Upload. media.html tags the button
     `role-moderator`, which reads the cookie's role field — and that field
     does not know about site moderators, so the button was hidden from
     exactly the people it is for. */
  const uploadBtn = document.getElementById('uploadBtn');
  if (uploadBtn) {
    /* Drop the cookie-role class too: with it still on, display '' falls
       back to roles.css's `display: none` for a list moderator. */
    uploadBtn.classList.remove('role-moderator');
    uploadBtn.style.display = canManage ? '' : 'none';
  }

  renderGallery();
}

function renderGallery() {
  const grid = document.getElementById('galleryGrid');
  if (!grid) return;

  filteredItems = currentFilter === 'all'
    ? GALLERY_DATA
    : GALLERY_DATA.filter(item => item.category === currentFilter);

  if (filteredItems.length === 0) {
    grid.innerHTML = '<div class="gallery-empty"><p>No items in this category yet.</p></div>';
    return;
  }

  grid.innerHTML = filteredItems.map((item, index) => renderItem(item, index)).join('');
}

function renderItem(item, index) {
  const badgeClass = `badge-${item.category}`;
  const lockHtml = item.role
    ? `<span class="gallery-item-lock">${escapeHtml(item.role)}+</span>`
    : '';
  /* Driven by the item's own type rather than by its category. A clip filed
     under Highlights is still a video, and an image filed under Clips is
     still an image — the old check read the category and got both wrong. */
  /* A Twitch clip plays too, so it gets the same affordance. */
  const playHtml = (item.type === 'video' || item.type === 'twitch-clip')
    ? '<div class="gallery-item-play"></div>' : '';
  /* No role-<role> class on the tile. /api/media already left out
     everything this viewer may not see, judged with the moderator list;
     roles.css would hide the rest again by the cookie's role, which says
     "follower" for a site moderator, so they lost moderator-only items the
     server had deliberately sent them. The lock chip still says who it is
     for. */

  /* Videos have no still to show, so the tile renders the video element
     itself with preload="metadata" — enough for the browser to paint a
     first frame without fetching the whole file for a thumbnail. */
  /* Audio has no still either, and rendering it as an <img> is what put a
     broken tile on this page for every alert sting ever uploaded.
     preload="none" so a gallery of stings costs nothing until one is
     played. */
  /* A Twitch clip is a REFERENCE — nothing of it is stored here. The tile
     is Twitch's own thumbnail, so the grid costs one image rather than an
     embedded player per tile; the player appears when it is opened. */
  const mediaHtml = item.type === 'twitch-clip'
    ? `<img src="${escapeAttr(item.thumbnail || '')}" alt="${escapeAttr(item.title)}" loading="lazy">` +
      (item.duration ? `<span class="gallery-item-dur">${escapeHtml(item.duration)}</span>` : '')
    : item.type === 'video'
      ? `<video src="${escapeAttr(item.url)}" preload="metadata" muted playsinline></video>`
      : item.type === 'audio'
        ? `<div class="gallery-audio"><span class="gallery-audio-mark" aria-hidden="true">&#9834;</span>` +
          `<audio src="${escapeAttr(item.url)}" controls preload="none"></audio></div>`
        : `<img src="${escapeAttr(item.url)}" alt="${escapeAttr(item.title)}" loading="lazy">`;

  const removeHtml = canManage
    ? `<button class="gallery-item-remove" data-id="${escapeAttr(item.id)}" title="Remove">&times;</button>`
    : '';

  return `
    <div class="gallery-item" data-index="${index}" role="button" tabindex="0" aria-label="Open ${escapeAttr(item.title)}">
      ${mediaHtml}
      <span class="gallery-item-badge ${badgeClass}">${escapeHtml(item.category)}</span>
      ${lockHtml}
      ${playHtml}
      ${removeHtml}
      <div class="gallery-item-overlay">
        <div class="gallery-item-title">${escapeHtml(item.title)}</div>
        <div class="gallery-item-meta">${formatDate(item.uploadedAt)}${item.uploadedBy ? ' · ' + escapeHtml(item.uploadedBy) : ''}</div>
      </div>
    </div>
  `;
}

/* Delegated, so it survives every re-render, and bound once. Clicking the
   tile opens the lightbox; clicking Remove must not. */
function initGalleryClicks() {
  const grid = document.getElementById('galleryGrid');
  if (!grid) return;
  grid.addEventListener('click', async (e) => {
    const remove = e.target.closest('.gallery-item-remove');
    if (remove) {
      e.stopPropagation();
      await removeItem(remove.dataset.id, remove);
      return;
    }
    const tile = e.target.closest('.gallery-item');
    if (tile) openLightbox(Number(tile.dataset.index));
  });
  /* Keyboard: the tiles are role="button" tabindex="0", so Enter/Space open
     the lightbox just like a click. */
  grid.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const tile = e.target.closest('.gallery-item');
    if (!tile || e.target.closest('.gallery-item-remove')) return;
    e.preventDefault();
    openLightbox(Number(tile.dataset.index));
  });
}

async function removeItem(id, btn) {
  const item = GALLERY_DATA.find(i => i.id === id);
  if (!item) return;
  if (!window.confirm(`Remove “${item.title}”? This deletes the file and cannot be undone.`)) return;

  btn.disabled = true;
  try {
    const res = await fetch('/api/media/upload', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ id }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Could not remove it.');
    }
    GALLERY_DATA = GALLERY_DATA.filter(i => i.id !== id);
    renderGallery();
  } catch (err) {
    btn.disabled = false;
    window.alert(err.message);
  }
}

function initFilters() {
  const buttons = document.querySelectorAll('.filter-btn');
  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      buttons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.dataset.filter;
      renderGallery();
    });
  });
}

function initLightbox() {
  const lightbox = document.getElementById('lightbox');
  if (!lightbox) return;

  const closeBtn = lightbox.querySelector('.lightbox-close');
  const prevBtn = lightbox.querySelector('.lightbox-prev');
  const nextBtn = lightbox.querySelector('.lightbox-next');

  closeBtn.addEventListener('click', closeLightbox);
  prevBtn.addEventListener('click', () => navigateLightbox(-1));
  nextBtn.addEventListener('click', () => navigateLightbox(1));

  lightbox.addEventListener('click', (e) => {
    if (e.target === lightbox) closeLightbox();
  });

  document.addEventListener('keydown', (e) => {
    if (!lightbox.classList.contains('open')) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft') navigateLightbox(-1);
    if (e.key === 'ArrowRight') navigateLightbox(1);
  });
}

function openLightbox(index) {
  const lightbox = document.getElementById('lightbox');
  const item = filteredItems[index];
  if (!lightbox || !item) return;

  lightboxIndex = index;
  updateLightboxContent(item);
  lightbox.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  const lightbox = document.getElementById('lightbox');
  if (!lightbox) return;

  lightbox.classList.remove('open');
  document.body.style.overflow = '';
  lightboxIndex = -1;

  const content = lightbox.querySelector('.lightbox-content');
  content.innerHTML = '';
}

function navigateLightbox(direction) {
  const newIndex = lightboxIndex + direction;
  if (newIndex < 0 || newIndex >= filteredItems.length) return;

  lightboxIndex = newIndex;
  updateLightboxContent(filteredItems[newIndex]);
}

function updateLightboxContent(item) {
  const content = document.querySelector('.lightbox-content');
  const title = document.querySelector('.lightbox-title');
  const meta = document.querySelector('.lightbox-meta');
  const prevBtn = document.querySelector('.lightbox-prev');
  const nextBtn = document.querySelector('.lightbox-next');

  /* Video was rendered as an <img> here, so opening a clip showed a broken
     image icon. The item knows what it is; use it. */
  /* TWITCH'S OWN PLAYER, so the view counts on the real clip.

     No `sandbox`: CLAUDE.md's sandbox rule is about OUR games, which we
     control and therefore confine. This is a third-party origin — already
     isolated by being one — and Twitch's player needs scripts and
     same-origin for itself, so a sandbox attribute simply breaks it.

     `parent` must name the host serving this page or Twitch refuses to
     frame at all, so it comes from location.hostname. Hardcoding
     phantomace.tv would work there and nowhere else, previews included. */
  content.innerHTML = item.type === 'twitch-clip'
    ? `<iframe class="lightbox-clip" src="https://clips.twitch.tv/embed?clip=${
        encodeURIComponent(item.slug)}&parent=${encodeURIComponent(location.hostname)}&autoplay=true"
        allow="fullscreen" referrerpolicy="strict-origin-when-cross-origin"
        title="${escapeAttr(item.title)}"></iframe>`
    : item.type === 'video'
      ? `<video src="${escapeAttr(item.url)}" controls autoplay playsinline></video>`
      : item.type === 'audio'
        ? `<div class="gallery-audio"><span class="gallery-audio-mark" aria-hidden="true">&#9834;</span>` +
          `<audio src="${escapeAttr(item.url)}" controls autoplay></audio></div>`
        : `<img src="${escapeAttr(item.url)}" alt="${escapeAttr(item.title)}">`;
  title.textContent = item.title;
  /* A clip was made by someone, and that is a different fact from who put
     it on the wall. Both are worth saying. */
  meta.textContent = `${item.category} · ${formatDate(item.uploadedAt)}` +
    (item.clipCreator ? ` · clipped by ${item.clipCreator}` : '') +
    (item.uploadedBy ? ` · added by ${item.uploadedBy}` : '');

  prevBtn.style.display = lightboxIndex > 0 ? '' : 'none';
  nextBtn.style.display = lightboxIndex < filteredItems.length - 1 ? '' : 'none';
}

/* Accepts a millisecond timestamp (what the API returns) or a date string.
   Anything unparseable renders as nothing rather than "Invalid Date". */
function formatDate(value) {
  if (value === null || value === undefined || value === '') return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function escapeHtml(str) {
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}

function escapeAttr(str) {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Upload functionality (moderator+ only)
function initUpload() {
  const dropzone = document.getElementById('uploadDropzone');
  const fileInput = document.getElementById('uploadFile');
  if (!dropzone || !fileInput) return;

  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });

  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover');
  });

  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files.length) {
      fileInput.files = e.dataTransfer.files;
      showFilePreview(e.dataTransfer.files[0]);
    }
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) {
      showFilePreview(fileInput.files[0]);
    }
  });

  const modal = document.getElementById('uploadModal');
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeUploadModal();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.classList.contains('open')) {
        closeUploadModal();
      }
    });
  }
}

function showFilePreview(file) {
  const preview = document.getElementById('uploadPreview');
  if (!preview) return;

  if (file.type.startsWith('image/')) {
    const reader = new FileReader();
    reader.onload = (e) => {
      preview.innerHTML = `<img src="${e.target.result}" alt="Preview">`;
    };
    reader.readAsDataURL(file);
  } else {
    preview.innerHTML = `<p style="font-size:12px;color:var(--text-sec);">${escapeHtml(file.name)} (${(file.size / 1024 / 1024).toFixed(1)} MB)</p>`;
  }
}

function openUploadModal() {
  const modal = document.getElementById('uploadModal');
  if (!modal) return;
  modal.classList.add('open');
  document.body.style.overflow = 'hidden';
  clearUploadForm();
}

function closeUploadModal() {
  const modal = document.getElementById('uploadModal');
  if (!modal) return;
  modal.classList.remove('open');
  document.body.style.overflow = '';
  clearUploadForm();
}

/* ── Twitch clips ────────────────────────────────────────────────────────
   Adding one meant downloading it off Twitch and uploading the file, which
   cost the rig the storage and split the view count off the real clip. A
   clip is a reference now: paste a link, or pick one off the channel's
   recent list, which is the half that makes it genuinely easier. */

function setUploadMode(mode) {
  const fileForm = document.getElementById('uploadForm');
  const clipForm = document.getElementById('clipForm');
  const fileBtn = document.getElementById('modeFileBtn');
  const clipBtn = document.getElementById('modeClipBtn');
  const title = document.getElementById('uploadModalTitle');
  if (!fileForm || !clipForm) return;

  const clip = mode === 'clip';
  fileForm.hidden = clip;
  clipForm.hidden = !clip;
  if (fileBtn) { fileBtn.classList.toggle('active', !clip); fileBtn.setAttribute('aria-selected', String(!clip)); }
  if (clipBtn) { clipBtn.classList.toggle('active', clip); clipBtn.setAttribute('aria-selected', String(clip)); }
  if (title) title.textContent = clip ? 'Add a Twitch Clip' : 'Upload Media';
}

function clipStatus(text, kind) {
  const el = document.getElementById('clipStatus');
  if (!el) return;
  el.textContent = text;
  el.className = 'upload-status' + (kind ? ' ' + kind : '');
}

/* The channel's recent clips, to click instead of hunting for a URL. Loaded
   on demand rather than when the modal opens — it is a Twitch round trip,
   and the paste box works without it. */
async function loadRecentClips() {
  const box = document.getElementById('clipRecent');
  const btn = document.getElementById('clipRefreshBtn');
  if (!box) return;
  box.innerHTML = '<p class="clip-recent-note">Loading…</p>';
  if (btn) btn.disabled = true;

  try {
    const res = await fetch('/api/media/clip?recent=1', { credentials: 'same-origin' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not load clips.');

    const clips = data.clips || [];
    if (!clips.length) {
      box.innerHTML = '<p class="clip-recent-note">No clips on the channel yet.</p>';
      return;
    }
    const already = new Set(data.already || []);
    /* WHEN, not just how popular. Twitch hands this list back sorted by view
       count and the server re-sorts it by date; showing the date is what
       makes that visible rather than something to take on trust. */
    box.innerHTML = clips.map(c => `
      <button type="button" class="clip-card${already.has(c.slug) ? ' is-added' : ''}"
              data-slug="${escapeAttr(c.slug)}" title="${escapeAttr(c.title)}">
        <img src="${escapeAttr(c.thumbnail)}" alt="" loading="lazy">
        <span class="clip-card-title">${escapeHtml(c.title)}</span>
        <span class="clip-card-meta">${escapeHtml(formatDate(c.createdAt))} · ${
          escapeHtml(String(c.views))} views${
          already.has(c.slug) ? ' · on the wall' : ''}</span>
      </button>`).join('');

    /* Say which window these came from. "Recent" is a claim, and when the
       last month was quiet the server falls back to all-time — the label
       should not keep insisting otherwise. */
    const head = document.querySelector('.clip-recent-head label');
    if (head) {
      head.textContent = data.window === 'all'
        ? 'Clips (nothing in the last ' + (data.days || 30) + ' days)'
        : 'Recent clips — last ' + (data.days || 30) + ' days';
    }

    box.querySelectorAll('.clip-card').forEach(card => {
      card.addEventListener('click', () => {
        const input = document.getElementById('clipUrl');
        if (input) input.value = card.dataset.slug;
        box.querySelectorAll('.clip-card').forEach(c => c.classList.remove('is-picked'));
        card.classList.add('is-picked');
        clipStatus('Picked — press Add Clip.', '');
      });
    });
  } catch (err) {
    box.innerHTML = '';
    clipStatus(err.message || 'Could not load clips.', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function handleAddClip(event) {
  event.preventDefault();
  const btn = document.getElementById('clipSubmitBtn');
  const url = (document.getElementById('clipUrl') || {}).value || '';
  if (!url.trim()) { clipStatus('Paste a clip link first.', 'error'); return; }

  const label = btn ? btn.textContent : '';
  let added = null;
  if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
  clipStatus('Checking the clip with Twitch…', '');

  try {
    const res = await fetch('/api/media/clip', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: url.trim(),
        title: (document.getElementById('clipTitle') || {}).value || '',
        category: (document.getElementById('clipCategory') || {}).value || 'clip',
        role: (document.getElementById('clipRole') || {}).value || '',
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || 'Could not add the clip.');

    /* THE ADD IS DONE. Everything below is the page catching up, so it is
       reported first and kept out of the try — a refresh that threw used to
       surface as "could not add the clip" for a clip that was already on the
       wall, which is the most misleading thing this could say. */
    clipStatus(data.replaced ? 'Updated — it was already on the wall.' : 'Added.', 'success');
    added = data.item;
  } catch (err) {
    clipStatus(err.message || 'Could not add the clip.', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
  }

  /* Same refresh the file upload does: put it at the front of the data the
     page already has and re-render, rather than re-fetching the whole wall. */
  if (added) {
    /* Drop any copy already on the page first. The server replaces rather
       than doubling (the id is the slug), so re-adding a clip must not leave
       two tiles behind until the next reload. */
    const dupe = GALLERY_DATA.findIndex(i => i && i.id === added.id);
    if (dupe !== -1) GALLERY_DATA.splice(dupe, 1);
    GALLERY_DATA.unshift(added);
    renderGallery();
    setTimeout(closeUploadModal, 900);
  }
}

function clearUploadForm() {
  const form = document.getElementById('uploadForm');
  const preview = document.getElementById('uploadPreview');
  const status = document.getElementById('uploadStatus');
  if (form) form.reset();
  if (preview) preview.innerHTML = '';
  if (status) { status.textContent = ''; status.className = 'upload-status'; }

  /* The clip side as well, or a refused link and a half-loaded picker are
     still sitting there the next time the modal opens. */
  const clipForm = document.getElementById('clipForm');
  if (clipForm) clipForm.reset();
  const recent = document.getElementById('clipRecent');
  if (recent) recent.innerHTML = '';
  clipStatus('', '');
  setUploadMode('file');
}

async function handleUpload(e) {
  e.preventDefault();
  const status = document.getElementById('uploadStatus');
  const submitBtn = document.getElementById('uploadSubmitBtn');
  const fileInput = document.getElementById('uploadFile');

  const title = document.getElementById('uploadTitle').value.trim();
  const category = document.getElementById('uploadCategory').value;
  const role = document.getElementById('uploadRole').value || null;
  const file = fileInput.files[0];

  if (!title || !file) return;

  submitBtn.disabled = true;
  submitBtn.textContent = 'Uploading...';
  status.textContent = '';
  status.className = 'upload-status';

  const formData = new FormData();
  formData.append('title', title);
  formData.append('category', category);
  if (role) formData.append('role', role);
  formData.append('file', file);

  try {
    const res = await fetch('/api/media/upload', {
      method: 'POST',
      credentials: 'same-origin',
      body: formData,
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Upload failed.');

    /* The SERVER's record goes into the gallery, not a locally assembled
       one. The old code pushed a guess — a blob: URL when the response had
       no url, a date of today, an id of Date.now() — so the tile looked
       right until the page was reloaded and the real item replaced it, or
       didn't. */
    GALLERY_DATA.unshift(data.item);

    renderGallery();
    status.textContent = 'Uploaded.';
    status.className = 'upload-status success';
    setTimeout(closeUploadModal, 1200);
  } catch (err) {
    /* The real reason, not a standing apology. This used to print "Upload
       endpoint not available yet" for every failure, which was true when it
       was written and has been misleading ever since — it hid the actual
       message for a file that was too large, a wrong type, or a session
       that had expired. */
    status.textContent = err.message || 'Upload failed.';
    status.className = 'upload-status error';
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Upload';
  }
}
