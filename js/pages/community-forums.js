const FORUM_CATEGORIES = [
  { id: 'announcements', name: 'Announcements', icon: '\u{1F4E3}', desc: 'Stream schedules, community updates, and important news from PhantomACE.' },
  { id: 'general', name: 'General Discussion', icon: '\u{1F4AC}', desc: 'Talk about anything — streams, games, music, life. All chaos welcome.' },
  { id: 'gaming', name: 'Gaming', icon: '\u{1F3AE}', desc: 'MTG Commander, co-op sessions, game recommendations, and lobby invites.' },
  { id: 'creative', name: 'Creative Corner', icon: '\u{1F3A8}', desc: 'Fan art, clips, edits, memes, and anything creative from the community.' },
  { id: 'highlights', name: 'Stream Highlights', icon: '\u{1F4A5}', desc: 'Best moments, clutch plays, and legendary fails from the stream.' },
  { id: 'feedback', name: 'Suggestions & Feedback', icon: '\u{1F4A1}', desc: 'Ideas for streams, events, website features, and community improvements.' },
];

let forumState = { view: 'home', categoryId: null, threadId: null };

function getForumData() {
  try {
    return JSON.parse(localStorage.getItem('pa_forum') || '{}');
  } catch { return {}; }
}

function saveForumData(data) {
  try { localStorage.setItem('pa_forum', JSON.stringify(data)); } catch {}
}

function getUser() {
  return localStorage.getItem('pa_forum_user') || null;
}

function escHtml(s) {
  const el = document.createElement('span');
  el.textContent = s;
  return el.innerHTML;
}

function timeAgo(ts) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.floor(hrs / 24);
  return days + 'd ago';
}

function forumNav(view, id) {
  if (view === 'home') {
    forumState = { view: 'home', categoryId: null, threadId: null };
  } else if (view === 'category') {
    forumState = { view: 'category', categoryId: id, threadId: null };
  } else if (view === 'thread') {
    forumState = { view: 'thread', categoryId: forumState.categoryId, threadId: id };
  }
  renderForum();
}

function renderBreadcrumb() {
  const bc = document.getElementById('forumBreadcrumb');
  let html = '<a href="#" onclick="forumNav(\'home\'); return false;">Forums</a>';
  if (forumState.categoryId) {
    const cat = FORUM_CATEGORIES.find(c => c.id === forumState.categoryId);
    if (cat) {
      html += ' <span class="bc-sep">/</span> ';
      html += `<a href="#" onclick="forumNav('category', '${cat.id}'); return false;">${escHtml(cat.name)}</a>`;
    }
  }
  if (forumState.threadId) {
    const data = getForumData();
    const threads = data[forumState.categoryId] || [];
    const thread = threads.find(t => t.id === forumState.threadId);
    if (thread) {
      html += ' <span class="bc-sep">/</span> ';
      html += `<span class="bc-current">${escHtml(thread.title)}</span>`;
    }
  }
  bc.innerHTML = html;
}

function renderForum() {
  renderBreadcrumb();
  const view = document.getElementById('forumView');
  if (forumState.view === 'home') {
    view.innerHTML = renderCategoryList();
  } else if (forumState.view === 'category') {
    view.innerHTML = renderThreadList();
  } else if (forumState.view === 'thread') {
    view.innerHTML = renderThread();
  }
}

function renderCategoryList() {
  const data = getForumData();
  return `<div class="forum-categories">${FORUM_CATEGORIES.map(cat => {
    const threads = data[cat.id] || [];
    const postCount = threads.reduce((sum, t) => sum + 1 + (t.replies || []).length, 0);
    return `
      <div class="card forum-category" onclick="forumNav('category', '${cat.id}')" style="cursor:pointer;">
        <div class="forum-category-icon">${cat.icon}</div>
        <div class="forum-category-info">
          <div class="forum-category-name">${escHtml(cat.name)}</div>
          <div class="forum-category-desc">${escHtml(cat.desc)}</div>
        </div>
        <div class="forum-category-stats">
          <div class="forum-stat"><span class="forum-stat-val">${threads.length}</span><span class="forum-stat-label">Topics</span></div>
          <div class="forum-stat"><span class="forum-stat-val">${postCount}</span><span class="forum-stat-label">Posts</span></div>
        </div>
      </div>`;
  }).join('')}</div>`;
}

function renderThreadList() {
  const cat = FORUM_CATEGORIES.find(c => c.id === forumState.categoryId);
  const data = getForumData();
  const threads = (data[forumState.categoryId] || []).sort((a, b) => b.lastActivity - a.lastActivity);
  const user = getUser();

  let html = `<div class="forum-thread-header">
    <h3>${escHtml(cat.name)}</h3>
    ${user ? `<button class="btn-primary forum-new-btn" onclick="showNewThread()">New Topic</button>` : `<button class="btn-primary forum-new-btn" onclick="promptLogin()">Log In to Post</button>`}
  </div>`;

  html += `<div id="newThreadForm" class="forum-new-form" style="display:none;">
    <input type="text" id="newThreadTitle" class="forum-input" placeholder="Topic title..." maxlength="120">
    <textarea id="newThreadBody" class="forum-textarea" placeholder="What's on your mind?" rows="4" maxlength="2000"></textarea>
    <div class="forum-form-actions">
      <button class="btn-primary" onclick="submitThread()">Post</button>
      <button class="pill-btn" onclick="hideNewThread()">Cancel</button>
    </div>
  </div>`;

  if (threads.length === 0) {
    html += `<div class="forum-empty card">
      <p>No topics yet. Be the first to start a discussion!</p>
    </div>`;
  } else {
    html += `<div class="forum-thread-list">`;
    html += threads.map(t => {
      const replyCount = (t.replies || []).length;
      return `
        <div class="card forum-thread-row" onclick="forumNav('thread', '${t.id}')">
          <div class="forum-thread-title">${escHtml(t.title)}</div>
          <div class="forum-thread-meta">
            <span class="forum-thread-author">${escHtml(t.author)}</span>
            <span class="forum-thread-time">${timeAgo(t.created)}</span>
            <span class="forum-thread-replies">${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}</span>
          </div>
        </div>`;
    }).join('');
    html += `</div>`;
  }

  return html;
}

function renderThread() {
  const data = getForumData();
  const threads = data[forumState.categoryId] || [];
  const thread = threads.find(t => t.id === forumState.threadId);
  if (!thread) return '<div class="forum-empty card"><p>Thread not found.</p></div>';

  const user = getUser();
  let html = `<div class="forum-thread-view">`;

  html += `<div class="card forum-post forum-post-op">
    <div class="forum-post-header">
      <span class="forum-post-author">${escHtml(thread.author)}</span>
      <span class="forum-post-time">${timeAgo(thread.created)}</span>
    </div>
    <h3 class="forum-post-title">${escHtml(thread.title)}</h3>
    <div class="forum-post-body">${escHtml(thread.body).replace(/\n/g, '<br>')}</div>
  </div>`;

  if (thread.replies && thread.replies.length > 0) {
    html += thread.replies.map(r => `
      <div class="card forum-post">
        <div class="forum-post-header">
          <span class="forum-post-author">${escHtml(r.author)}</span>
          <span class="forum-post-time">${timeAgo(r.created)}</span>
        </div>
        <div class="forum-post-body">${escHtml(r.body).replace(/\n/g, '<br>')}</div>
      </div>`).join('');
  }

  if (user) {
    html += `<div class="forum-reply-form">
      <textarea id="replyBody" class="forum-textarea" placeholder="Write a reply..." rows="3" maxlength="2000"></textarea>
      <button class="btn-primary" onclick="submitReply()">Reply</button>
    </div>`;
  } else {
    html += `<div class="forum-reply-prompt card">
      <p>Log in to reply to this topic.</p>
      <button class="btn-primary" onclick="promptLogin()">Log In</button>
    </div>`;
  }

  html += `</div>`;
  return html;
}

function showNewThread() {
  document.getElementById('newThreadForm').style.display = 'block';
  document.getElementById('newThreadTitle').focus();
}

function hideNewThread() {
  document.getElementById('newThreadForm').style.display = 'none';
  document.getElementById('newThreadTitle').value = '';
  document.getElementById('newThreadBody').value = '';
}

function submitThread() {
  const title = document.getElementById('newThreadTitle').value.trim();
  const body = document.getElementById('newThreadBody').value.trim();
  const user = getUser();
  if (!title || !body || !user) return;

  const data = getForumData();
  if (!data[forumState.categoryId]) data[forumState.categoryId] = [];

  const thread = {
    id: 't_' + Date.now(),
    title,
    body,
    author: user,
    created: Date.now(),
    lastActivity: Date.now(),
    replies: [],
  };

  data[forumState.categoryId].unshift(thread);
  saveForumData(data);
  forumNav('thread', thread.id);
}

function submitReply() {
  const body = document.getElementById('replyBody').value.trim();
  const user = getUser();
  if (!body || !user) return;

  const data = getForumData();
  const threads = data[forumState.categoryId] || [];
  const thread = threads.find(t => t.id === forumState.threadId);
  if (!thread) return;

  if (!thread.replies) thread.replies = [];
  thread.replies.push({
    id: 'r_' + Date.now(),
    body,
    author: user,
    created: Date.now(),
  });
  thread.lastActivity = Date.now();
  saveForumData(data);
  renderForum();
}

function promptLogin() {
  const name = prompt('Enter a display name to participate in the forums:');
  if (name && name.trim()) {
    localStorage.setItem('pa_forum_user', name.trim());
    renderForum();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  renderForum();
});
