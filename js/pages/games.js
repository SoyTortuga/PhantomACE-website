const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

/* The "Being Played Now" carousel is derived from the "Play Now" cards in
   games.html, so the two can't drift apart: a card opts in with
   data-game="<id>" and the carousel picks up its title, thumb and launch
   path from the card itself. The id must match the key /api/game-activity
   reports so the live player count lands on the right card. */
function collectGames() {
  return Array.from(document.querySelectorAll('.game-card[data-game]')).map((card) => {
    const id = card.dataset.game;
    const titleEl = card.querySelector('.game-card-title');
    const thumbEl = card.querySelector('.game-card-thumb img');
    const playBtn = card.querySelector('.game-play-btn:not(.role-moderator)');

    /* Renaming any of these in the grid would otherwise drop the game from
       the carousel without a trace -- say so instead of failing quietly. */
    const missing = [
      !titleEl && '.game-card-title',
      !thumbEl && '.game-card-thumb img',
      !playBtn && '.game-play-btn:not(.role-moderator)',
    ].filter(Boolean);
    if (missing.length) {
      console.warn(`games: card data-game="${id}" is missing ${missing.join(', ')} — leaving it out of the Being Played Now carousel.`);
      return null;
    }

    return {
      id,
      title: titleEl.textContent.trim(),
      thumb: thumbEl.getAttribute('src'),
      play: () => playBtn.click(),
    };
  }).filter(Boolean);
}

function launchGame(title, src) {
  const launcher = document.getElementById('gameLauncher');
  const frame = document.getElementById('gameLauncherFrame');
  const titleEl = document.getElementById('gameLauncherTitle');

  titleEl.textContent = title;
  frame.title = title;
  frame.src = src;
  launcher.classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeLauncher() {
  const launcher = document.getElementById('gameLauncher');
  const frame = document.getElementById('gameLauncherFrame');

  launcher.classList.remove('open');
  frame.src = 'about:blank';
  document.body.style.overflow = '';
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeLauncher();
});

window.addEventListener('message', (e) => {
  if (e.data === 'close-game') closeLauncher();
});

function renderGameScroller() {
  const track = document.getElementById('gamesScrollerTrack');
  if (!track) return;

  const games = collectGames();
  track.innerHTML = games.map(g => `
    <button class="game-mini-card" data-game="${escHtml(g.id)}" type="button">
      <img src="${escHtml(g.thumb)}" alt="${escHtml(g.title)}" loading="lazy">
      <span class="game-mini-title">${escHtml(g.title)}</span>
      <span class="game-mini-live" data-live="${escHtml(g.id)}" hidden></span>
    </button>
  `).join('');

  track.querySelectorAll('.game-mini-card').forEach((btn, i) => {
    btn.addEventListener('click', games[i].play);
  });
}

function initScrollerButtons() {
  const track = document.getElementById('gamesScrollerTrack');
  const left = document.getElementById('gamesScrollerLeft');
  const right = document.getElementById('gamesScrollerRight');
  if (!track || !left || !right) return;

  left.addEventListener('click', () => track.scrollBy({ left: -320, behavior: 'smooth' }));
  right.addEventListener('click', () => track.scrollBy({ left: 320, behavior: 'smooth' }));
}

async function loadLiveCounts() {
  try {
    const res = await fetch('/api/game-activity');
    if (!res.ok) return;
    const data = await res.json();
    Object.entries(data).forEach(([id, info]) => {
      if (!info || !info.players) return;
      const label = `${info.players} playing`;
      document.querySelectorAll(`[data-live="${id}"]`).forEach(el => {
        el.hidden = false;
        el.textContent = label;
      });
    });
  } catch { /* live counts are a nice-to-have, fail silently */ }
}

async function loadSkullClickerLeaderboard() {
  try {
    const res = await fetch('/api/skull-clicker');
    const lb = await res.json();
    const el = document.getElementById('scLeaderboard');
    if (!lb.length) return;
    const units = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc'];
    function fmt(n) {
      if (n < 1000) return n.toLocaleString();
      const t = Math.min(Math.floor(Math.log10(n) / 3), units.length - 1);
      const s = n / Math.pow(10, t * 3);
      return (s < 10 ? s.toFixed(1) : Math.floor(s)) + units[t];
    }
    const top3 = lb.slice(0, 3);
    el.innerHTML = '<div class="sc-lb-title">Top Players</div>' +
      top3.map((e, i) => `<div class="sc-lb-row"><span class="sc-lb-rank rank-${i + 1}">${i + 1}</span><span class="sc-lb-name">${escHtml(e.name)}</span><span class="sc-lb-score">${fmt(e.score)}</span></div>`).join('');
  } catch { /* leaderboard is a nice-to-have, fail silently */ }
}

document.addEventListener('DOMContentLoaded', () => {
  renderGameScroller();
  initScrollerButtons();
  loadSkullClickerLeaderboard();
  loadLiveCounts();
});
