const GAMES = [
  { id: 'memory-match', title: 'Memory Match', thumb: '/assets/images/game-memory-match.png', play: () => launchGame('Memory Match', '/games/memory-match/') },
  { id: 'skull-clicker', title: 'Skull Clicker', thumb: '/assets/images/game-skull-clicker.png', play: () => launchGame('Skull Clicker', '/games/skull-clicker/') },
  { id: 'commander-bingo', title: 'Commander Bingo', thumb: '/assets/images/game-commander-bingo.png', play: () => launchGame('Commander Bingo', '/games/commander-bingo/'), live: true },
  { id: 'dino-park', title: 'Dino Park', thumb: '/assets/images/game-dino-park.png', play: () => launchGame('Dino Park', '/games/dino-park/') },
  { id: 'mana-clash', title: 'Mana Clash', thumb: '/assets/images/game-mana-clash.png', play: () => launchGame('Mana Clash', '/games/mana-clash/'), live: true },
  { id: 'pham-shock', title: 'PhamShock', thumb: '/assets/images/game-phamshock.png', play: () => launchGame('PhamShock', '/games/shell-shock/'), live: true },
];

function launchGame(title, src) {
  const launcher = document.getElementById('gameLauncher');
  const frame = document.getElementById('gameLauncherFrame');
  const titleEl = document.getElementById('gameLauncherTitle');

  titleEl.textContent = title;
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

  track.innerHTML = GAMES.map(g => `
    <button class="game-mini-card" data-game="${g.id}" type="button">
      <img src="${g.thumb}" alt="${g.title}" loading="lazy">
      <span class="game-mini-title">${g.title}</span>
      <span class="game-mini-live" data-live="${g.id}" hidden></span>
    </button>
  `).join('');

  track.querySelectorAll('.game-mini-card').forEach((btn, i) => {
    btn.addEventListener('click', GAMES[i].play);
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
      top3.map((e, i) => `<div class="sc-lb-row"><span class="sc-lb-rank rank-${i + 1}">${i + 1}</span><span class="sc-lb-name">${e.name}</span><span class="sc-lb-score">${fmt(e.score)}</span></div>`).join('');
  } catch { /* leaderboard is a nice-to-have, fail silently */ }
}

document.addEventListener('DOMContentLoaded', () => {
  renderGameScroller();
  initScrollerButtons();
  loadSkullClickerLeaderboard();
  loadLiveCounts();
});
