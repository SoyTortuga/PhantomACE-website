/* Populated by real uploads via /api/media/upload once the media backend
   (currently being reworked to use the dedicated server instead of R2 —
   see wrangler.toml) is live. Empty until then; renderGallery() already
   shows a clean "No items in this category yet." state for an empty array. */
const GALLERY_DATA = [];

let currentFilter = 'all';
let lightboxIndex = -1;
let filteredItems = [];

document.addEventListener('DOMContentLoaded', () => {
  renderGallery();
  initFilters();
  initLightbox();
  initUpload();
});

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
  const isClip = item.category === 'clip';
  const lockHtml = item.role
    ? `<span class="gallery-item-lock">${item.role}+</span>`
    : '';
  const playHtml = isClip
    ? '<div class="gallery-item-play"></div>'
    : '';
  const roleClass = item.role ? `role-${item.role}` : '';

  return `
    <div class="gallery-item ${roleClass}" data-index="${index}" onclick="openLightbox(${index})">
      <img src="${escapeAttr(item.src)}" alt="${escapeAttr(item.title)}" loading="lazy">
      <span class="gallery-item-badge ${badgeClass}">${escapeHtml(item.category)}</span>
      ${lockHtml}
      ${playHtml}
      <div class="gallery-item-overlay">
        <div class="gallery-item-title">${escapeHtml(item.title)}</div>
        <div class="gallery-item-meta">${formatDate(item.date)}</div>
      </div>
    </div>
  `;
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

  content.innerHTML = `<img src="${escapeAttr(item.src)}" alt="${escapeAttr(item.title)}">`;
  title.textContent = item.title;
  meta.textContent = `${item.category} · ${formatDate(item.date)}`;

  prevBtn.style.display = lightboxIndex > 0 ? '' : 'none';
  nextBtn.style.display = lightboxIndex < filteredItems.length - 1 ? '' : 'none';
}

function formatDate(dateStr) {
  const d = new Date(dateStr);
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
      body: formData,
    });

    if (!res.ok) throw new Error('Upload failed');

    const data = await res.json();

    GALLERY_DATA.unshift({
      id: data.id || Date.now(),
      title: title,
      category: category,
      type: file.type.startsWith('video/') ? 'video' : 'image',
      src: data.url || URL.createObjectURL(file),
      date: new Date().toISOString().split('T')[0],
      role: role,
    });

    renderGallery();
    status.textContent = 'Uploaded successfully!';
    status.className = 'upload-status success';
    setTimeout(closeUploadModal, 1500);
  } catch {
    status.textContent = 'Upload endpoint not available yet. This feature will activate once the backend API is connected.';
    status.className = 'upload-status error';
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Upload';
  }
}
