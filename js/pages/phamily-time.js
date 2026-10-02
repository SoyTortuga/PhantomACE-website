/* ══════════════════════════════════════════════
   PHAMILY TIME — Reward Pass & Stats
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  const MAX_LEVEL = 150;
  const GRACE_DAYS = 7;

  /* ── Reward Definitions ──────────────────────── */

  /* ── REWARD ARTWORK ────────────────────────────────────────────────
     Every tile used to be an emoji in a rounded square, so a track of
     seventy rewards read as seventy identical boxes distinguished only by
     border colour. These are the site's own images and PhantomACE's own
     emotes — nothing bought, nothing licensed, nothing new to draw.

     Presentation only, and deliberately NOT on the reward objects: those
     are duplicated server-side and compared entry-for-entry by
     test-phamily-rewards.js, and a picture is not something the server has
     any opinion about.

     Emotes come from Twitch's CDN, hotlinkable by design — it is how every
     chat client renders them. Anything that fails to load falls back to the
     emoji that was there before, so a tile is never empty. */
  const EMOTE = (id, fmt) =>
    `https://static-cdn.jtvnw.net/emoticons/v2/${id}/${fmt || 'static'}/dark/2.0`;

  const REWARD_ART = {
    /* The coin roll IS the giveaway currency, and it is animated, so the
       most common reward on the track is also the one that moves. */
    giveaway:       EMOTE('emotesv2_26bf7acbf75644e69473adf3952110b7', 'animated'),
    emote:          EMOTE('121671'),        // phamPham — an emote, for an emote
    wildcard:       EMOTE('152733'),        // phamHype
    bingo:          EMOTE('121673'),        // phamHi
    'click-effect': EMOTE('120782'),        // phamLit
    'skull-skin':   '/assets/images/skull.png',
    /* Memory Match has no card-back image: the face-down side is a CSS
       surface and the faces are channel emotes. A card back is a crest, and
       this mark already renders as a square badge with its own red-black
       ground — which is exactly what the back of a PhantomACE card would
       be. The games-page banner was here first and was 940x330, so a 44px
       tile showed an unreadable strip of it. */
    cardback:       '/assets/images/phantomace-logo.png',
    dice:           '/games/mana-clash/assets/r.png',
  };

  /* Eggs are the one reward whose art already exists per rarity, so a
     mythic egg looks like a mythic egg rather than like a common one. */
  const EGG_ART = {
    common:   '/assets/images/eggs/egg-common.png',
    uncommon: '/assets/images/eggs/egg-uncommon.png',
    rare:     '/assets/images/eggs/egg-rare.png',
    mythic:   '/assets/images/eggs/egg-mythic.png',
  };

  function rewardArt(reward) {
    if (!reward) return null;
    if (reward.type === 'egg') return EGG_ART[reward.rarity] || EGG_ART.common;
    return REWARD_ART[reward.type] || null;
  }

  /* ── ONE SEASON REGISTRY, FETCHED ────────────────────────────────────
     The reward tables are the server's, not a copy kept here. The page used
     to carry a verbatim mirror of the whole table (and a drift guard to keep
     the two honest); now it fetches the finished tables from the server at
     init — /api/phamily-time?action=tables, which returns the CURRENT month
     for the pass ladder and the PREVIOUS month for the grace view, each built
     from the canonical rewardTablesFor(mk). The track draws the month the
     server says it is (status.month); the grace banner draws LAST month's, so
     a September reward claimed in October's grace week is shown — and paid —
     as September's. The Pacific month is still computed locally for the demo
     fallback (NOT raw getMonth/UTC, or the two drift at the boundary). */
  function localMonthKey() {
    return new Intl.DateTimeFormat('en-CA',
      { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit' }).format(new Date());
  }

  /* Pacific wall-clock Y/M/D for now — the same calendar the server keys on
     (season-time.js). The streak, grace window and attendance grid count by
     day-of-month, so they must read the Pacific day, not the browser's UTC or
     local day, or they jump a day a few hours either side of local midnight
     and disagree with the server at the month boundary. */
  function localYMD() {
    const s = new Intl.DateTimeFormat('en-CA',
      { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
    const [y, m, day] = s.split('-').map(Number);
    return { y, m, day };
  }

  /* Reward tables keyed by month, filled by loadTables() before the first
     render. Each value is { follower, phamily, milestones } — the same arrays
     the old in-page builder returned, so everything downstream is unchanged. */
  const TABLES = new Map();
  async function loadTables() {
    const res = await fetch('/api/phamily-time?action=tables', { credentials: 'same-origin' });
    if (!res.ok) throw new Error('tables unavailable');
    const data = await res.json();
    for (const t of [data && data.current, data && data.prev]) {
      if (t && t.month) {
        TABLES.set(String(t.month), {
          follower: t.follower || [], phamily: t.phamily || [], milestones: t.milestones || [],
        });
      }
    }
  }
  function rewardTablesFor(mk) {
    return TABLES.get(String(mk)) || { follower: [], phamily: [], milestones: [] };
  }

  let followerRewards = [], phamilyRewards = [], milestones = [];
  function useMonth(mk) {
    const t = rewardTablesFor(mk);
    followerRewards = t.follower;
    phamilyRewards = t.phamily;
    milestones = t.milestones;
  }

  /* ── State ───────────────────────────────────── */

  let userLevel = 0;
  let userIsSub = false;
  let userSubTier = 0;
  let claimedRewards = [];
  let claimedMilestones = [];
  let isLoggedIn = false;
  let heartbeatTimer = null;
  let activePopoverIsPrev = false;
  let prevMonthInfo = null;

  /* THE TRACK HAS ONE NAME: 'follower' or 'phamily'.
     'top' and 'bottom' describe where a lane is drawn and must never reach
     this function. They did: nodes were built with 'top'/'bottom' while
     claims were stored under 'follower'/'phamily', so the key a claimed
     reward was saved under could never match the key its node was checked
     with. Every claimed reward kept its "!" badge for ever, and clicking it
     again answered "Already claimed" — the claim had worked the first time
     and the track simply never said so. Throwing is deliberate: a silent
     mismatch is what made this survive. */
  function rewardKey(reward, track) {
    if (track !== 'follower' && track !== 'phamily') {
      throw new Error('rewardKey needs follower/phamily, got ' + track);
    }
    return reward.level + '_' + track + '_' + reward.type + '_' + reward.rarity;
  }

  function getRewardState(reward, track) {
    const key = rewardKey(reward, track);
    if (claimedRewards.includes(key)) return 'claimed';
    /* The phamily track is the subscriber bonus on top of the follower
       track, not a second track viewers pick between — so it stays locked
       for non-subs no matter their level. The follower track has no such
       gate; everyone, subs included, earns it. */
    if (track === 'phamily' && !userIsSub) return 'locked';
    /* Giveaway-entry rewards are credited automatically when the level is
       reached — the server does it on the watch heartbeat, so there is no
       Claim step. 'credited' is a distinct state from 'ready' precisely so the
       pass never shows a Claim button for them. */
    if (reward.type === 'giveaway') return reward.level <= userLevel ? 'credited' : 'locked';
    if (reward.level <= userLevel) return 'ready';
    return 'locked';
  }

  function getMilestoneState(ms) {
    if (claimedMilestones.includes(ms.level)) return 'claimed';
    if (ms.level <= userLevel) return 'ready';
    return 'locked';
  }

  /* ── Rates Modal ─────────────────────────────── */

  const ratesModal = document.getElementById('ptRatesModal');
  const claimAllBtn = document.getElementById('ptClaimAllBtn');
  if (claimAllBtn) claimAllBtn.addEventListener('click', claimAll);

  document.getElementById('ptRatesBtn').addEventListener('click', () => {
    ratesModal.hidden = false;
  });
  document.getElementById('ptRatesClose').addEventListener('click', () => {
    ratesModal.hidden = true;
  });
  ratesModal.addEventListener('click', (e) => {
    if (e.target === ratesModal) ratesModal.hidden = true;
  });

  /* ── Recheck Roles ───────────────────────────── */

  document.getElementById('ptRecheckBtn').addEventListener('click', async () => {
    const btn = document.getElementById('ptRecheckBtn');
    btn.textContent = 'Checking...';
    btn.disabled = true;
    try {
      const res = await fetch('/api/auth/recheck-roles');
      if (res.ok) {
        const data = await res.json();
        updateBoostDisplay(data.subTier || 0);
      }
    } catch (e) { /* silent */ }
    btn.textContent = 'Recheck Roles';
    btn.disabled = false;
  });

  function updateBoostDisplay(tier) {
    const rates = { 0: ['1.0x', 'No Boost'], 1: ['1.33x', 'Tier 1'], 2: ['1.67x', 'Tier 2'], 3: ['2x', 'Tier 3'] };
    const r = rates[tier] || rates[0];
    document.getElementById('ptBoostRate').textContent = r[0];
    document.getElementById('ptBoostLabel').textContent = r[1];
  }

  /* ── Build Thermometer ───────────────────────── */

  function buildThermometer(currentLevel) {
    const inner = document.getElementById('ptThermometer');
    const laneTop = document.getElementById('ptLaneTop');
    const laneBottom = document.getElementById('ptLaneBottom');
    const milestoneLane = document.getElementById('ptMilestoneLane');
    const ticks = document.getElementById('ptThermoTicks');

    laneTop.innerHTML = '';
    laneBottom.innerHTML = '';
    milestoneLane.innerHTML = '';
    ticks.innerHTML = '';

    /* ── SPACING ────────────────────────────────────────────────────────────
       Nodes used to be positioned as a percentage of MAX_LEVEL inside a
       2400px container: 16px per level against a 36px node, so every reward
       sat on top of its neighbours and the track read as one clump.

       Each level now owns a fixed number of pixels and the track is as wide
       as it needs to be, scrolling horizontally. Two things still collide at
       this density and are handled explicitly below:

         adjacent levels — rewards sit every 2 levels in places, so nodes are
           STAGGERED to two different distances from the spine. Neighbours
           pass each other vertically instead of overlapping.
         the same level — several rewards share a level (two at 30). Those
           are spread sideways around their level's position, since nothing
           about the vertical stagger separates them. */
    const PX_PER_LEVEL = 42;
    const trackWidth = MAX_LEVEL * PX_PER_LEVEL;
    inner.style.width = trackWidth + 'px';

    const xFor = (level) => level * PX_PER_LEVEL;

    for (let h = 10; h <= MAX_LEVEL; h += 10) {
      const mark = document.createElement('div');
      mark.className = 'pt-thermo-hour-mark';
      mark.style.left = (xFor(h) - 16) + 'px';
      mark.textContent = h + 'h';
      ticks.appendChild(mark);
    }

    /* How many rewards share each level, so same-level ones can be fanned
       out rather than stacked invisibly. */
    function levelCounts(list) {
      const counts = new Map();
      for (const r of list) counts.set(r.level, (counts.get(r.level) || 0) + 1);
      return counts;
    }

    function placeLane(lane, list, track) {
      const counts = levelCounts(list);
      const seen = new Map();

      list.forEach(function (reward, i) {
        const state = getRewardState(reward, track);
        const total = counts.get(reward.level) || 1;
        const nth = seen.get(reward.level) || 0;
        seen.set(reward.level, nth + 1);

        /* Centre the group on the level, then fan outwards. */
        const spread = 46;
        const offset = total > 1 ? (nth - (total - 1) / 2) * spread : 0;

        const node = document.createElement('div');
        node.className = `pt-reward-node pt-rarity-${reward.rarity}`;
        node.dataset.state = state;
        /* Read by the stylesheet: egg sprites are small pixel art and want
           pixelated scaling, where the emotes and banners do not. */
        node.dataset.type = reward.type;
        node.dataset.tier = (i % 2 === 0) ? 'near' : 'far';
        node.style.left = (xFor(reward.level) + offset - 22) + 'px';

        const stemEl = document.createElement('div');
        stemEl.className = 'pt-reward-stem';

        const iconEl = document.createElement('div');
        iconEl.className = 'pt-reward-icon';
        const artUrl = rewardArt(reward);
        if (artUrl) {
          const img = document.createElement('img');
          img.className = 'pt-reward-art';
          img.src = artUrl;
          img.alt = '';
          img.loading = 'lazy';
          /* One retry to the emoji, then stop. Without removing the handler
             a fallback that also failed would loop forever. */
          img.addEventListener('error', function handler() {
            img.removeEventListener('error', handler);
            iconEl.textContent = reward.icon;
          });
          iconEl.appendChild(img);
        } else {
          iconEl.textContent = reward.icon;
        }

        /* The state badge is its own element rather than a ::after on the
           icon. The old one was absolutely positioned inside a non-relative
           box, so the tick rendered in the middle of the icon on top of the
           emoji instead of in a corner. */
        const badgeEl = document.createElement('div');
        badgeEl.className = 'pt-reward-badge';
        badgeEl.textContent = (state === 'claimed' || state === 'credited') ? '✓' : state === 'locked' ? '🔒' : '!';
        iconEl.appendChild(badgeEl);

        const lvlEl = document.createElement('div');
        lvlEl.className = 'pt-reward-lvl';
        lvlEl.textContent = 'LVL ' + reward.level;

        if (track === 'follower') {
          node.appendChild(lvlEl);
          node.appendChild(iconEl);
          node.appendChild(stemEl);
        } else {
          node.appendChild(stemEl);
          node.appendChild(iconEl);
          node.appendChild(lvlEl);
        }

        node.addEventListener('click', (e) => showPopover(e, reward, state, track));
        lane.appendChild(node);
      });
    }

    placeLane(laneTop, followerRewards, 'follower');
    placeLane(laneBottom, phamilyRewards, 'phamily');

    for (const ms of milestones) {
      const state = getMilestoneState(ms);
      const node = document.createElement('div');
      node.className = 'pt-milestone-node';
      node.dataset.state = state;
      node.style.left = (xFor(ms.level) - 22) + 'px';

      const iconEl = document.createElement('div');
      iconEl.className = 'pt-milestone-icon';
      iconEl.textContent = '💀';

      const labelEl = document.createElement('div');
      labelEl.className = 'pt-milestone-label';
      labelEl.textContent = ms.title;

      node.appendChild(iconEl);
      node.appendChild(labelEl);
      node.addEventListener('click', (e) => showMilestonePopover(e, ms, state));
      milestoneLane.appendChild(node);
    }

    const fillPct = Math.min((currentLevel / MAX_LEVEL) * 100, 100);
    document.getElementById('ptThermoFill').style.width = fillPct + '%';

    const bulb = document.getElementById('ptBulbInner');
    if (currentLevel >= MAX_LEVEL) bulb.classList.add('filled');
    else bulb.classList.remove('filled');

    /* A "YOU ARE HERE" marker on the spine, and scroll to it.
       The track is now several thousand pixels wide, so it opens showing
       level 0 — which for anyone past the first few levels is the one part
       of it they do not need to see. */
    const youEl = document.getElementById('ptYouMarker');
    if (youEl) {
      youEl.style.left = (xFor(Math.min(currentLevel, MAX_LEVEL)) - 24) + 'px';
      youEl.hidden = false;
    }

    const wrap = document.getElementById('ptThermometerWrap');
    if (wrap) {
      const target = xFor(currentLevel) - wrap.clientWidth / 2;
      wrap.scrollTo({ left: Math.max(0, target), behavior: 'auto' });
    }
  }

  /* ── Popover ─────────────────────────────────── */

  const popover = document.getElementById('ptPopover');

  let activePopoverReward = null;
  let activePopoverTrack = null;
  let activePopoverMilestone = null;

  function showPopover(e, reward, state, track, isPrev) {
    e.stopPropagation();
    activePopoverReward = reward;
    activePopoverTrack = track;
    activePopoverMilestone = null;
    activePopoverIsPrev = !!isPrev;

    const rarityEl = document.getElementById('ptPopRarity');
    rarityEl.textContent = reward.rarity;
    rarityEl.className = 'pt-popover-rarity pt-pop-' + reward.rarity;
    document.getElementById('ptPopLevel').textContent = 'Level ' + reward.level;
    document.getElementById('ptPopTitle').textContent = reward.name;
    document.getElementById('ptPopDesc').textContent = reward.desc;

    const claimBtn = document.getElementById('ptPopClaim');
    const statusEl = document.getElementById('ptPopStatus');

    if (state === 'ready') {
      claimBtn.hidden = false;
      claimBtn.disabled = false;
      claimBtn.textContent = 'Claim';
      statusEl.textContent = '';
    } else if (state === 'claimed') {
      claimBtn.hidden = true;
      statusEl.textContent = 'Claimed';
    } else if (state === 'credited') {
      /* No Claim button: giveaway entries are added to this month's ledger
         automatically as soon as the level is reached. */
      claimBtn.hidden = true;
      statusEl.textContent = 'Added automatically — no claim needed';
    } else {
      claimBtn.hidden = true;
      statusEl.textContent = (track === 'phamily' && !userIsSub)
        ? 'Subscribe to unlock the Phamily track'
        : reward.type === 'giveaway'
          ? 'Reach level ' + reward.level + ' — added automatically'
          : 'Reach level ' + reward.level + ' to unlock';
    }

    positionPopover(e);
    popover.hidden = false;
  }

  function showMilestonePopover(e, ms, state, isPrev) {
    e.stopPropagation();
    activePopoverMilestone = ms;
    activePopoverReward = null;
    activePopoverTrack = null;
    activePopoverIsPrev = !!isPrev;

    const rarityEl = document.getElementById('ptPopRarity');
    rarityEl.textContent = 'Milestone';
    rarityEl.className = 'pt-popover-rarity pt-pop-mythic';
    document.getElementById('ptPopLevel').textContent = 'Level ' + ms.level;
    document.getElementById('ptPopTitle').textContent = ms.title;

    const desc = userIsSub
      ? 'Phamily: ' + ms.phamilyDesc
      : 'Follower: ' + ms.followerDesc + '\nPhamily: ' + ms.phamilyDesc;
    document.getElementById('ptPopDesc').textContent = desc;

    const claimBtn = document.getElementById('ptPopClaim');
    const statusEl = document.getElementById('ptPopStatus');

    if (state === 'ready') {
      claimBtn.hidden = false;
      claimBtn.disabled = false;
      claimBtn.textContent = 'Claim';
      statusEl.textContent = '';
    } else if (state === 'claimed') {
      claimBtn.hidden = true;
      statusEl.textContent = 'Claimed';
    } else {
      claimBtn.hidden = true;
      statusEl.textContent = 'Reach level ' + ms.level + ' to unlock';
    }

    positionPopover(e);
    popover.hidden = false;
  }

  document.getElementById('ptPopClaim').addEventListener('click', async () => {
    const btn = document.getElementById('ptPopClaim');
    btn.disabled = true;
    btn.textContent = 'Claiming...';

    try {
      if (activePopoverReward) {
        const key = rewardKey(activePopoverReward, activePopoverTrack);
        const payload = activePopoverIsPrev
          ? { action: 'claim-prev', type: 'reward', rewardKey: key,
              rewardType: activePopoverReward.type, rewardRarity: activePopoverReward.rarity,
              rewardName: activePopoverReward.name }
          : { action: 'claim-reward', rewardKey: key,
              rewardType: activePopoverReward.type, rewardRarity: activePopoverReward.rarity,
              rewardName: activePopoverReward.name };
        const res = await fetch('/api/phamily-time', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          if (activePopoverIsPrev) {
            prevMonthInfo.claimedRewards.push(key);
            renderGraceBanner(prevMonthInfo);
          } else {
            claimedRewards.push(key);
            buildThermometer(userLevel);
          }
          btn.hidden = true;
          document.getElementById('ptPopStatus').textContent = 'Claimed';
          updateRewardsCount();
        } else {
          const err = await res.json();
          document.getElementById('ptPopStatus').textContent = err.error || 'Failed';
          btn.textContent = 'Claim';
          btn.disabled = false;
        }
      } else if (activePopoverMilestone) {
        const payload = activePopoverIsPrev
          ? { action: 'claim-prev', type: 'milestone', milestoneLevel: activePopoverMilestone.level,
              milestoneTitle: activePopoverMilestone.title, bonusItems: activePopoverMilestone.bonusItems }
          : { action: 'claim-milestone', milestoneLevel: activePopoverMilestone.level,
              milestoneTitle: activePopoverMilestone.title, bonusItems: activePopoverMilestone.bonusItems };
        const res = await fetch('/api/phamily-time', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          if (activePopoverIsPrev) {
            prevMonthInfo.claimedMilestones.push(activePopoverMilestone.level);
            renderGraceBanner(prevMonthInfo);
          } else {
            claimedMilestones.push(activePopoverMilestone.level);
            buildThermometer(userLevel);
          }
          btn.hidden = true;
          document.getElementById('ptPopStatus').textContent = 'Claimed';
          updateRewardsCount();
        } else {
          const err = await res.json();
          document.getElementById('ptPopStatus').textContent = err.error || 'Failed';
          btn.textContent = 'Claim';
          btn.disabled = false;
        }
      }
    } catch {
      document.getElementById('ptPopStatus').textContent = 'Network error';
      btn.textContent = 'Claim';
      btn.disabled = false;
    }
  });

  /* Shown only when something is actually claimable, and labelled with how
     many — a "Claim All" that might do nothing is worse than no button. */
  function updateClaimAllBtn() {
    const btn = document.getElementById('ptClaimAllBtn');
    if (!btn) return;
    /* Follower track counts for everyone; phamily is the subscriber bonus
       on top of it, so it only adds to the count for subs. Giveaway rewards
       are excluded — they are auto-credited, not claimable. */
    let ready = followerRewards.filter(r =>
      r.type !== 'giveaway' && r.level <= userLevel && !claimedRewards.includes(rewardKey(r, 'follower'))).length;
    if (userIsSub) {
      ready += phamilyRewards.filter(r =>
        r.type !== 'giveaway' && r.level <= userLevel && !claimedRewards.includes(rewardKey(r, 'phamily'))).length;
    }
    ready += milestones.filter(m => m.level <= userLevel && !claimedMilestones.includes(m.level)).length;
    btn.hidden = ready === 0;
    btn.textContent = ready === 1 ? 'Claim 1' : `Claim All (${ready})`;
    btn.disabled = false;
  }

  async function claimAll() {
    const btn = document.getElementById('ptClaimAllBtn');
    btn.disabled = true;
    btn.textContent = 'Claiming…';

    try {
      const res = await fetch('/api/phamily-time', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'claim-all' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not claim.');

      /* Reloaded rather than patched. Claiming everything changes the track,
         the rewards count, the all-time totals and the inventory behind it;
         re-deriving all of that here would be a second copy of the render
         path that has to stay in step with the first. */
      window.location.reload();
    } catch (err) {
      btn.disabled = false;
      updateClaimAllBtn();
      window.alert(err.message);
    }
  }

  function updateRewardsCount() {
    const ready = followerRewards.filter(r => getRewardState(r, 'follower') === 'ready').length
      + phamilyRewards.filter(r => getRewardState(r, 'phamily') === 'ready').length
      + milestones.filter(m => getMilestoneState(m) === 'ready').length;
    document.getElementById('ptRewards').textContent = ready;
  }

  function positionPopover(e) {
    const x = Math.min(e.clientX - 130, window.innerWidth - 280);
    const y = e.clientY > window.innerHeight / 2 ? e.clientY - 200 : e.clientY + 20;
    popover.style.left = Math.max(10, x) + 'px';
    popover.style.top = Math.max(10, y) + 'px';
  }

  document.addEventListener('click', (e) => {
    if (!popover.contains(e.target)) popover.hidden = true;
  });

  /* ── Watch Time Chart ────────────────────────── */

  function renderWatchChart(data) {
    const canvas = document.getElementById('ptWatchChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = 160 * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = '160px';
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = 160;
    const padL = 30, padR = 10, padT = 10, padB = 24;
    const chartW = w - padL - padR;
    const chartH = h - padT - padB;

    const maxVal = Math.max(...data.map(d => d.hours), 1);
    const barW = Math.max(4, (chartW / data.length) - 2);

    ctx.fillStyle = '#0a0a0a';
    ctx.fillRect(0, 0, w, h);

    for (let i = 0; i <= 4; i++) {
      const y = padT + (chartH / 4) * i;
      ctx.strokeStyle = '#1a1a1a';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(w - padR, y);
      ctx.stroke();

      ctx.fillStyle = '#444';
      ctx.font = '9px system-ui';
      ctx.textAlign = 'right';
      ctx.fillText(Math.round(maxVal - (maxVal / 4) * i) + 'h', padL - 4, y + 3);
    }

    for (let i = 0; i < data.length; i++) {
      const x = padL + (chartW / data.length) * i + (chartW / data.length - barW) / 2;
      const barH = (data[i].hours / maxVal) * chartH;
      const y = padT + chartH - barH;

      const grad = ctx.createLinearGradient(x, y, x, y + barH);
      grad.addColorStop(0, '#ff0000');
      grad.addColorStop(1, '#990000');
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, barW, barH);

      if (data.length <= 31) {
        ctx.fillStyle = '#444';
        ctx.font = '8px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText(data[i].label, x + barW / 2, h - 4);
      }
    }
  }

  /* ── Attendance Grid ─────────────────────────── */

  function renderAttendanceGrid(streams) {
    const grid = document.getElementById('ptAttendanceGrid');
    const summary = document.getElementById('ptAttendanceSummary');
    if (!grid) return;
    grid.innerHTML = '';
    let attended = 0;
    let total = 0;
    for (const s of streams) {
      const cell = document.createElement('div');
      cell.className = 'pt-attendance-cell ' + s.status;
      cell.title = s.date + (s.hours ? ' — ' + s.hours + 'h' : '');
      grid.appendChild(cell);
      if (s.status !== 'future') total++;
      if (s.status === 'attended') attended++;
    }
    summary.textContent = attended + ' of ' + total + ' streams this month';
  }

  /* ── Grace Period Banner (previous month) ────── */

  function renderGraceBanner(prevMonth) {
    const anchor = document.getElementById('ptPersonalStats');
    let banner = document.getElementById('ptGraceBanner');

    if (!prevMonth) {
      if (banner) banner.remove();
      prevMonthInfo = null;
      return;
    }

    prevMonthInfo = prevMonth;

    /* LAST month's table, not this one's: the names, art and milestone
       titles shown here are what the claim will actually pay. */
    const prevTables = rewardTablesFor(prevMonth.month);
    /* Giveaway rewards are excluded: they were auto-credited last month as the
       levels were reached, so there is nothing to claim here in grace. */
    const readyFollower = prevTables.follower.filter(r =>
      r.type !== 'giveaway' && r.level <= prevMonth.level && !prevMonth.claimedRewards.includes(rewardKey(r, 'follower')));
    /* Same gate as getRewardState: the phamily track requires a CURRENT
       subscription, not whatever the viewer's status was last month. */
    const readyPhamily = userIsSub
      ? prevTables.phamily.filter(r =>
          r.type !== 'giveaway' && r.level <= prevMonth.level && !prevMonth.claimedRewards.includes(rewardKey(r, 'phamily')))
      : [];
    const readyMilestones = prevTables.milestones.filter(ms =>
      ms.level <= prevMonth.level && !prevMonth.claimedMilestones.includes(ms.level));

    const totalReady = readyFollower.length + readyPhamily.length + readyMilestones.length;

    if (totalReady === 0) {
      if (banner) banner.remove();
      return;
    }

    if (!banner) {
      banner = document.createElement('section');
      banner.className = 'page-container';
      banner.id = 'ptGraceBanner';
      anchor.insertAdjacentElement('beforebegin', banner);
    }
    banner.innerHTML = '';

    const [y, mo] = prevMonth.month.split('-').map(Number);
    const monthLabel = new Date(y, mo - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    const today = localYMD().day;
    const graceDaysLeft = Math.max(0, GRACE_DAYS - today + 1);

    const card = document.createElement('div');
    card.className = 'card pt-grace-card';

    const header = document.createElement('div');
    header.className = 'pt-grace-header';
    header.innerHTML = `
      <span class="pt-grace-icon">⏳</span>
      <div>
        <div class="pt-grace-title">Unclaimed rewards from ${monthLabel}</div>
        <div class="pt-grace-sub">${totalReady} reward${totalReady === 1 ? '' : 's'} waiting — claim within ${graceDaysLeft} day${graceDaysLeft === 1 ? '' : 's'} before they're gone.</div>
      </div>`;
    card.appendChild(header);

    const itemsWrap = document.createElement('div');
    itemsWrap.className = 'pt-grace-items';

    function addItem(icon, name, rarity, onClick) {
      const el = document.createElement('div');
      el.className = `pt-grace-item pt-rarity-${rarity}`;

      const iconEl = document.createElement('span');
      iconEl.className = 'pt-grace-item-icon';
      /* `icon` is now either a URL or an emoji. Built as nodes rather than
         interpolated into innerHTML, so a name with an ampersand in it
         cannot become markup. */
      if (typeof icon === 'string' && (icon.startsWith('/') || icon.startsWith('https://'))) {
        const img = document.createElement('img');
        img.className = 'pt-reward-art';
        img.src = icon;
        img.alt = '';
        iconEl.appendChild(img);
      } else {
        iconEl.textContent = icon;
      }

      const nameEl = document.createElement('span');
      nameEl.className = 'pt-grace-item-name';
      nameEl.textContent = name;

      el.appendChild(iconEl);
      el.appendChild(nameEl);
      el.addEventListener('click', onClick);
      itemsWrap.appendChild(el);
    }

    for (const r of readyFollower) {
      addItem(rewardArt(r) || r.icon, r.name, r.rarity, (e) => showPopover(e, r, 'ready', 'follower', true));
    }
    for (const r of readyPhamily) {
      addItem(rewardArt(r) || r.icon, r.name, r.rarity, (e) => showPopover(e, r, 'ready', 'phamily', true));
    }
    for (const ms of readyMilestones) {
      addItem('💀', ms.title, 'mythic', (e) => showMilestonePopover(e, ms, 'ready', true));
    }

    card.appendChild(itemsWrap);
    banner.appendChild(card);
  }

  /* ── Dashboard Update ────────────────────────── */

  function updateDashboard(level, hours, rewardsAvailable, daysLeft) {
    document.getElementById('ptLevel').textContent = level;
    document.getElementById('ptHours').textContent = hours + 'h';
    document.getElementById('ptRewards').textContent = rewardsAvailable;
    document.getElementById('ptDays').textContent = daysLeft;
  }

  /* ── Days remaining this month ───────────────── */

  function daysLeftInMonth() {
    const now = new Date();
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return Math.ceil((end - now) / 86400000);
  }

  /* ── API Integration ──────────────────────────── */

  async function loadFromAPI() {
    const res = await fetch('/api/phamily-time?action=status');
    if (!res.ok) return null;
    return await res.json();
  }

  async function loadChartFromAPI() {
    const res = await fetch('/api/phamily-time?action=chart');
    if (!res.ok) return null;
    return await res.json();
  }

  function applyAPIData(data) {
    isLoggedIn = true;
    if (data.month) useMonth(data.month);
    userLevel = data.level;
    userSubTier = data.subTier;
    userIsSub = data.subTier > 0;
    claimedRewards = data.claimedRewards || [];
    claimedMilestones = data.claimedMilestones || [];

    updateDashboard(data.level, data.hours, 0, data.daysLeft);
    updateBoostDisplay(data.subTier);
    buildThermometer(data.level);
    updateRewardsCount();
    updateClaimAllBtn();
    renderGraceBanner(data.prevMonth);

    if (data.allTime) {
      document.getElementById('ptTotalHours').textContent = data.allTime.totalHours + 'h';
      document.getElementById('ptMonthsActive').textContent = data.allTime.monthsActive;
      document.getElementById('ptTotalRewards').textContent = data.allTime.totalRewardsClaimed;
      document.getElementById('ptBestLevel').textContent = data.allTime.bestLevel;
      document.getElementById('ptLongestStreak').textContent = data.allTime.longestStreak;
    }

    const attendance = data.attendance || {};
    const { y: curY, m: curM, day: today } = localYMD();
    let streak = 0;
    for (let d = today; d >= 1; d--) {
      if (attendance[String(d)] > 0) streak++;
      else break;
    }
    document.getElementById('ptCurrentStreak').textContent = streak;

    const daysInMonth = new Date(curY, curM, 0).getDate();
    const streamDays = new Set();
    for (let d = 1; d <= daysInMonth; d++) {
      const dow = new Date(curY, curM - 1, d).getDay();
      if (dow >= 1 && dow <= 5) streamDays.add(d);
    }
    const streams = [];
    for (let d = 1; d <= daysInMonth; d++) {
      if (!streamDays.has(d)) continue;
      let status;
      if (d > today) status = 'future';
      else if (attendance[String(d)] > 0) status = 'attended';
      else status = 'missed';
      const hrs = attendance[String(d)] || 0;
      streams.push({ date: 'Day ' + d, status, hours: +(hrs).toFixed(1) });
    }
    renderAttendanceGrid(streams);

    if (userIsSub) {
      document.getElementById('ptSubInfo').hidden = false;
      document.getElementById('ptSubBadge').textContent = '💀';
      const tierNames = { 1: 'Tier 1', 2: 'Tier 2', 3: 'Tier 3' };
      document.getElementById('ptSubTier').textContent = tierNames[data.subTier] || '';
    }
  }

  /* The actual heartbeat POST now happens globally from js/twitch.js (every
     page, not just this one — see sendPhamilyHeartbeatIfLive() there), so
     the numbers keep accruing correctly no matter where the user is on the
     site. This just re-fetches and re-renders this page's own display
     periodically, so it doesn't go stale while left open. */
  function startHeartbeat() {
    if (heartbeatTimer) return;
    async function refresh() {
      try {
        const data = await loadFromAPI();
        if (data && !data.error) applyAPIData(data);
      } catch { /* silent — try again next cycle */ }
    }
    heartbeatTimer = setInterval(refresh, 60000);
  }

  /* ── Demo Data (fallback) ───────────────────── */

  function loadDemoData() {
    /* The logged-out preview still draws the current month's track from the
       fetched tables; applyAPIData does this for the logged-in path. */
    useMonth(localMonthKey());
    const level = 23;
    userLevel = level;
    const hours = 23.4;
    const daysLeft = daysLeftInMonth();

    updateDashboard(level, hours.toFixed(1), 0, daysLeft);
    updateBoostDisplay(0);
    buildThermometer(level);
    updateRewardsCount();

    const today = new Date().getDate();
    const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
    const chartData = [];
    for (let d = 1; d <= today; d++) {
      const hrs = +(Math.random() * 3 + (d % 6 === 0 ? 0 : 0.5)).toFixed(1);
      chartData.push({ label: d.toString(), hours: hrs });
    }
    renderWatchChart(chartData);

    const streams = [];
    const streamDays = new Set();
    for (let d = 1; d <= daysInMonth; d++) {
      const dow = new Date(new Date().getFullYear(), new Date().getMonth(), d).getDay();
      if (dow >= 1 && dow <= 5) streamDays.add(d);
    }
    for (let d = 1; d <= daysInMonth; d++) {
      if (!streamDays.has(d)) continue;
      let status;
      if (d > today) status = 'future';
      else if (Math.random() > 0.15) status = 'attended';
      else status = 'missed';
      const hrs = status === 'attended' ? +(Math.random() * 4 + 1).toFixed(1) : 0;
      streams.push({ date: 'Day ' + d, status, hours: hrs });
    }
    renderAttendanceGrid(streams);

    document.getElementById('ptCurrentStreak').textContent = '5';
    document.getElementById('ptLongestStreak').textContent = '14';
    document.getElementById('ptTotalHours').textContent = '247h';
    document.getElementById('ptMonthsActive').textContent = '6';
    document.getElementById('ptTotalRewards').textContent = '83';
    document.getElementById('ptBestLevel').textContent = '42';
  }

  /* ── Init ────────────────────────────────────── */

  document.addEventListener('DOMContentLoaded', async () => {
    /* The reward tables are the server's now — fetch them before any render
       that reads them (the track, the grace banner, the demo preview). */
    try { await loadTables(); } catch { /* render degrades to an empty track */ }

    try {
      const data = await loadFromAPI();
      if (data && !data.error) {
        applyAPIData(data);
        const chartData = await loadChartFromAPI();
        if (chartData) renderWatchChart(chartData);
        document.getElementById('ptLoginPrompt').hidden = true;
        document.getElementById('ptPersonalStats').hidden = false;
        startHeartbeat();
        return;
      }
    } catch { /* API unavailable, fall through */ }

    loadDemoData();
    document.getElementById('ptLoginPrompt').hidden = true;
    document.getElementById('ptPersonalStats').hidden = false;
  });

})();

/* ══════════════════════════════════════════════
   ACCRUAL INDICATOR

   Answers the only question a viewer actually has while the page is open:
   is my time counting right now?

   It reports the SERVER's answer about the last heartbeat, not the page's
   assumption. Three of the states below happen while the channel is live and
   credit nothing, and before this they were indistinguishable from working —
   the number simply did not move and there was nothing to explain why.

   Deliberately never says "counting" unless the server said it credited
   time. A reassuring indicator that is wrong is worse than none: it turns a
   fixable problem into one nobody reports.
   ══════════════════════════════════════════════ */
(function () {
  const STATES = {
    credited:   { state: 'on',      text: 'Counting your time',        sub: 'PhantomACE is live and this page is checked in.' },
    'first-beat':{ state: 'pending', text: 'Starting…',                sub: 'Your first check-in landed. Time counts from the next one.' },
    gap:        { state: 'pending', text: 'Resumed',                   sub: 'The gap since your last check-in was too long to count. Counting again from now.' },
    offline:    { state: 'off',     text: 'PhantomACE is offline',     sub: 'Watch time only counts while the stream is live.' },
    'logged-out':{ state: 'off',    text: 'Not logged in',             sub: 'Log in with Twitch to earn watch time.' },
    unreachable:{ state: 'error',   text: 'Can’t reach the server',    sub: 'Time is not being counted right now. It should resume on its own.' },
    error:      { state: 'error',   text: 'Server error',              sub: 'Time is not being counted right now.' },
    idle:       { state: 'idle',    text: 'Checking…',                 sub: '' },
    unknown:    { state: 'idle',    text: 'Checking…',                 sub: '' },
  };

  const box = document.getElementById('ptAccrual');
  const textEl = document.getElementById('ptAccrualText');
  const subEl = document.getElementById('ptAccrualSub');
  if (!box || !textEl || !subEl) return;

  let last = null;

  function render() {
    const hb = last || window.phamilyHeartbeat || { reason: 'idle' };
    const conf = STATES[hb.reason] || STATES.unknown;

    box.dataset.state = conf.state;
    textEl.textContent = conf.text;

    let sub = conf.sub;
    if (hb.reason === 'credited') {
      const mins = Math.round((hb.creditedSeconds || 0) / 60);
      const ago = Math.max(0, Math.round((Date.now() - (hb.at || Date.now())) / 1000));
      sub = `Last counted ${mins >= 1 ? mins + ' min' : (hb.creditedSeconds || 0) + 's'}` +
            (hb.boostRate && hb.boostRate !== 1 ? ` at ${hb.boostRate}x` : '') +
            `, ${ago}s ago.`;
    }
    subEl.textContent = sub;
  }

  document.addEventListener('pham-heartbeat', function (e) { last = e.detail; render(); });

  /* Re-render on a timer as well as on each beat, so the "Xs ago" stays
     honest between heartbeats instead of freezing at whatever it said when
     the last one landed. */
  setInterval(render, 5000);
  render();
})();

/* ══════════════════════════════════════════════
   WEEKLY QUESTS

   Reads /api/quests (server-verified progress, claimed state, and any
   completion notices the bell has not yet announced), renders the cards, and
   claims on demand. Progress and payout are entirely the server's call; this
   only draws what it is told and relays a claim.

   Completed quests are announced through the shared notification bell
   (js/notifications.js). Each announcement is KEYED quest:<week>:<id> so it
   shows once however many times it is surfaced — the in-page claim and the
   next page load both try to add it, and the key dedupes the second away. The
   server notices are then acked so they are not re-sent.
   ══════════════════════════════════════════════ */
(function () {
  'use strict';

  const section = document.getElementById('ptQuestsSection');
  const list = document.getElementById('ptQuestsList');
  if (!section || !list) return;

  let weekKey = '';

  function rewardLabel(reward) {
    if (!reward) return '';
    if (reward.type === 'entries') return `+${reward.amount} ${reward.amount === 1 ? 'entry' : 'entries'}`;
    if (reward.type === 'minutes') return `+${reward.amount} pass min`;
    return '';
  }

  function announce(q) {
    if (typeof window.addNotification !== 'function') return;
    window.addNotification({
      type: 'system',
      key: 'quest:' + weekKey + ':' + q.id,
      message: `Quest complete: ${q.title} — ${rewardLabel(q.reward)}`,
    });
  }

  function makeCard(q) {
    const card = document.createElement('div');
    card.className = 'pt-quest-card' + (q.claimed ? ' is-claimed' : q.completed ? ' is-complete' : '');

    const head = document.createElement('div');
    head.className = 'pt-quest-head';
    const title = document.createElement('div');
    title.className = 'pt-quest-title';
    title.textContent = q.title;
    const reward = document.createElement('div');
    reward.className = 'pt-quest-reward';
    reward.textContent = rewardLabel(q.reward);
    head.appendChild(title);
    head.appendChild(reward);

    const desc = document.createElement('p');
    desc.className = 'pt-quest-desc';
    desc.textContent = q.desc;

    const progWrap = document.createElement('div');
    progWrap.className = 'pt-quest-progress';
    const bar = document.createElement('div');
    bar.className = 'pt-quest-bar';
    const fill = document.createElement('div');
    fill.className = 'pt-quest-bar-fill';
    fill.style.width = Math.round((Math.min(q.progress, q.goal) / q.goal) * 100) + '%';
    bar.appendChild(fill);

    const meta = document.createElement('div');
    meta.className = 'pt-quest-meta';
    const count = document.createElement('span');
    count.className = 'pt-quest-count';
    count.textContent = Math.min(q.progress, q.goal) + ' / ' + q.goal;
    meta.appendChild(count);

    if (q.claimed) {
      const st = document.createElement('span');
      st.className = 'pt-quest-state';
      st.textContent = 'Claimed';
      meta.appendChild(st);
    } else if (q.completed) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn-primary pt-quest-claim';
      btn.textContent = 'Claim';
      btn.addEventListener('click', () => claim(q, btn));
      meta.appendChild(btn);
    } else {
      const st = document.createElement('span');
      st.className = 'pt-quest-state';
      st.textContent = 'In progress';
      meta.appendChild(st);
    }

    progWrap.appendChild(bar);
    progWrap.appendChild(meta);
    card.appendChild(head);
    card.appendChild(desc);
    card.appendChild(progWrap);
    return card;
  }

  function render(quests) {
    list.innerHTML = '';
    for (const q of quests) list.appendChild(makeCard(q));
    section.hidden = quests.length === 0;
  }

  async function claim(q, btn) {
    btn.disabled = true;
    btn.textContent = 'Claiming…';
    try {
      const res = await fetch('/api/quests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'claim', questId: q.id }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not claim.');
      announce(q);
      await load();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Claim';
      window.alert(err.message);
    }
  }

  async function load() {
    let data;
    try {
      const res = await fetch('/api/quests', { cache: 'no-store', credentials: 'same-origin' });
      if (!res.ok) return;
      data = await res.json();
    } catch { return; }
    if (!data || !data.loggedIn || !Array.isArray(data.quests)) return;

    weekKey = data.weekKey || '';
    render(data.quests);

    /* Announce anything the server recorded as completed but not yet shown,
       then ack so it is announced once. The keyed add dedupes against an
       in-page claim that already surfaced it. */
    if (Array.isArray(data.notices) && data.notices.length) {
      for (const n of data.notices) {
        announce({ id: n.questId, title: n.title, reward: n.reward });
      }
      fetch('/api/quests', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'ack-notices' }),
      }).catch(() => {});
    }
  }

  document.addEventListener('DOMContentLoaded', load);
})();
