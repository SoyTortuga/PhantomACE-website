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
  if (uploadBtn) uploadBtn.style.display = canManage ? '' : 'none';

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
  const playHtml = item.type === 'video' ? '<div class="gallery-item-play"></div>' : '';
  const roleClass = item.role ? `role-${item.role}` : '';

  /* Videos have no still to show, so the tile renders the video element
     itself with preload="metadata" — enough for the browser to paint a
     first frame without fetching the whole file for a thumbnail. */
  const mediaHtml = item.type === 'video'
    ? `<video src="${escapeAttr(item.url)}" preload="metadata" muted playsinline></video>`
    : `<img src="${escapeAttr(item.url)}" alt="${escapeAttr(item.title)}" loading="lazy">`;

  const removeHtml = canManage
    ? `<button class="gallery-item-remove" data-id="${escapeAttr(item.id)}" title="Remove">&times;</button>`
    : '';

  return `
    <div class="gallery-item ${roleClass}" data-index="${index}" role="button" tabindex="0" aria-label="Open ${escapeAttr(item.title)}">
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
  content.innerHTML = item.type === 'video'
    ? `<video src="${escapeAttr(item.url)}" controls autoplay playsinline></video>`
    : `<img src="${escapeAttr(item.url)}" alt="${escapeAttr(item.title)}">`;
  title.textContent = item.title;
  meta.textContent = `${item.category} · ${formatDate(item.uploadedAt)}` +
    (item.uploadedBy ? ` · ${item.uploadedBy}` : '');

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

function clearUploadForm() {
  const form = document.getElementById('uploadForm');
  const preview = document.getElementById('uploadPreview');
  const status = document.getElementById('uploadStatus');
  if (form) form.reset();
  if (preview) preview.innerHTML = '';
  if (status) { status.textContent = ''; status.className = 'upload-status'; }
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
