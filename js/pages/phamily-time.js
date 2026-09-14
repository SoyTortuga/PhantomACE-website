/* ══════════════════════════════════════════════
   PHAMILY TIME — Reward Pass & Stats
   ══════════════════════════════════════════════ */

(function () {
  'use strict';

  const MAX_LEVEL = 150;
  const MILESTONE_INTERVAL = 15;
  const GRACE_DAYS = 7;

  /* ── Reward Definitions ──────────────────────── */

  const REWARD_ICONS = {
    giveaway: '🎫',
    egg: '🥚',
    cardback: '🃏',
    emote: '😈',
    bingo: '🎰',
    wildcard: '⭐',
    dice: '🎲',
    cosmetic: '💀',
    badge: '🛡️',
    title: '👑',
    banner: '🏳️',
    nameeffect: '✨',
  };

  function defineFollowerRewards() {
    const r = [];
    const giveawayLevels = [
      [2,'common'],[5,'common'],[8,'common'],[12,'common'],[16,'common'],
      [20,'uncommon'],[25,'uncommon'],[30,'uncommon'],[35,'uncommon'],
      [40,'rare'],[50,'rare'],[60,'rare'],[70,'rare'],
      [80,'rare'],[90,'rare'],[100,'rare'],
      [110,'mythic'],[125,'mythic'],[140,'mythic'],
    ];
    const entries = { common:2, uncommon:5, rare:15, mythic:50 };
    for (const [lvl, rarity] of giveawayLevels) {
      r.push({ level:lvl, rarity, type:'giveaway', icon:REWARD_ICONS.giveaway,
        name:`Giveaway Entries`, desc:`+${entries[rarity]} entries into the monthly giveaway, added automatically` });
    }
    r.push({ level:10, rarity:'common', type:'cardback', icon:REWARD_ICONS.cardback,
      name:'Basic Card Back', desc:'A simple card back for Memory Match' });
    r.push({ level:22, rarity:'uncommon', type:'emote', icon:REWARD_ICONS.emote,
      name:'Emote Pack', desc:'Bonus emote set for Memory Match' });
    r.push({ level:55, rarity:'rare', type:'cardback', icon:REWARD_ICONS.cardback,
      name:'Rare Card Back', desc:'An exclusive card back for Memory Match' });
    r.push({ level:65, rarity:'rare', type:'bingo', icon:REWARD_ICONS.bingo,
      name:'Bonus Bingo Card', desc:'An extra bingo card for Commander Bingo' });
    r.push({ level:85, rarity:'rare', type:'cosmetic', icon:REWARD_ICONS.cosmetic,
      name:'Skull Skin', desc:'A cosmetic skull skin for Skull Clicker' });
    r.push({ level:95, rarity:'rare', type:'dice', icon:REWARD_ICONS.dice,
      name:'Bone Dice', desc:'Cosmetic bone-themed dice for Mana Clash' });
    return r.sort((a,b) => a.level - b.level);
  }

  function definePhamilyRewards() {
    const r = [];
    const giveawayLevels = [
      [2,'uncommon'],[5,'uncommon'],[8,'uncommon'],[12,'uncommon'],[16,'uncommon'],
      [20,'rare'],[25,'rare'],[30,'rare'],[35,'rare'],
      [40,'rare'],[50,'rare'],[60,'rare'],[70,'mythic'],
      [80,'mythic'],[90,'mythic'],[100,'mythic'],
      [110,'mythic'],[125,'mythic'],[140,'mythic'],
    ];
    const entries = { common:2, uncommon:5, rare:15, mythic:50 };
    for (const [lvl, rarity] of giveawayLevels) {
      r.push({ level:lvl, rarity, type:'giveaway', icon:REWARD_ICONS.giveaway,
        name:`Giveaway Entries`, desc:`+${entries[rarity]} entries into the monthly giveaway, added automatically` });
    }
    r.push({ level:6, rarity:'common', type:'egg', icon:REWARD_ICONS.egg,
      name:'Common Egg', desc:'A Dino Park egg — hatch a random common dinosaur' });
    r.push({ level:18, rarity:'uncommon', type:'egg', icon:REWARD_ICONS.egg,
      name:'Uncommon Egg', desc:'A Dino Park egg — hatch a random uncommon dinosaur' });
    r.push({ level:10, rarity:'uncommon', type:'cardback', icon:REWARD_ICONS.cardback,
      name:'Phamily Card Back', desc:'An exclusive card back for Memory Match' });
    r.push({ level:22, rarity:'uncommon', type:'emote', icon:REWARD_ICONS.emote,
      name:'Premium Emote Pack', desc:'Exclusive emote set for Memory Match' });
    r.push({ level:28, rarity:'uncommon', type:'bingo', icon:REWARD_ICONS.bingo,
      name:'Bonus Bingo Card', desc:'An extra bingo card for Commander Bingo' });
    r.push({ level:36, rarity:'rare', type:'egg', icon:REWARD_ICONS.egg,
      name:'Guaranteed Rare Egg', desc:'A Dino Park egg — guaranteed rare dinosaur' });
    r.push({ level:42, rarity:'rare', type:'wildcard', icon:REWARD_ICONS.wildcard,
      name:'Wildcard Stamp', desc:'A wildcard stamp for Commander Bingo' });
    r.push({ level:48, rarity:'rare', type:'dice', icon:REWARD_ICONS.dice,
      name:'Chaos Dice Pack', desc:'Cosmetic chaos-themed dice for Mana Clash' });
    r.push({ level:55, rarity:'rare', type:'cardback', icon:REWARD_ICONS.cardback,
      name:'Legendary Card Back', desc:'A rare card back for Memory Match' });
    r.push({ level:65, rarity:'rare', type:'cosmetic', icon:REWARD_ICONS.cosmetic,
      name:'Dark Altar Skin', desc:'An exclusive building skin for Skull Clicker' });
    r.push({ level:85, rarity:'rare', type:'cosmetic', icon:REWARD_ICONS.cosmetic,
      name:'Void Click Effect', desc:'A cosmetic click effect for Skull Clicker' });
    r.push({ level:95, rarity:'rare', type:'dice', icon:REWARD_ICONS.dice,
      name:'Phantom Dice Pack', desc:'Cosmetic phantom-themed dice for Mana Clash' });
    r.push({ level:105, rarity:'mythic', type:'egg', icon:REWARD_ICONS.egg,
      name:'Guaranteed Mutant Egg', desc:'A Dino Park egg — guaranteed mutant dinosaur' });
    r.push({ level:115, rarity:'mythic', type:'cosmetic', icon:REWARD_ICONS.cosmetic,
      name:'Eternal Darkness Skin', desc:'A mythic building skin for Skull Clicker' });
    r.push({ level:130, rarity:'mythic', type:'dice', icon:REWARD_ICONS.dice,
      name:'Reality Fracture Dice', desc:'Mythic animated dice for Mana Clash' });
    return r.sort((a,b) => a.level - b.level);
  }

  function defineMilestones() {
    const ms = [];
    const followerBundles = [
      ['Initiate','Badge + Title'],
      ['Acolyte','Badge + Title'],
      ['Watcher','Badge + Title'],
      ['Guardian','Badge + Title'],
      ['Sentinel','Badge + Title'],
      ['Phantom','Badge + Title'],
      ['Wraith','Badge + Title'],
      ['Revenant','Badge + Title'],
      ['Specter','Badge + Title'],
      ['Eternal','Badge + Title'],
    ];
    const phamilyBundles = [
      ['Initiate','Badge + Title + Common Egg', [
        { type:'egg', rarity:'common', name:'Common Egg' },
      ]],
      ['Acolyte','Badge + Title + Card Back + Common Egg', [
        { type:'cardback', rarity:'uncommon', name:'Card Back' },
        { type:'egg', rarity:'common', name:'Common Egg' },
      ]],
      ['Watcher','Badge + Title + Profile Banner', [
        { type:'banner', rarity:'rare', name:'Profile Banner' },
      ]],
      ['Guardian','Badge + Title + Uncommon Egg + Dice Pack', [
        { type:'egg', rarity:'uncommon', name:'Uncommon Egg' },
        { type:'dice', rarity:'rare', name:'Dice Pack' },
      ]],
      ['Sentinel','Badge + Title + Name Effect + Rare Giveaway Entries', [
        { type:'nameeffect', rarity:'rare', name:'Name Effect' },
        { type:'giveaway', rarity:'rare', name:'Rare Giveaway Entries' },
      ]],
      ['Phantom','Badge + Title + Profile Banner + Rare Egg', [
        { type:'banner', rarity:'rare', name:'Profile Banner' },
        { type:'egg', rarity:'rare', name:'Rare Egg' },
      ]],
      ['Wraith','Badge + Title + Name Effect + Bingo Wildcard Bundle', [
        { type:'nameeffect', rarity:'mythic', name:'Name Effect' },
        { type:'wildcard', rarity:'rare', name:'Bingo Wildcard Bundle' },
      ]],
      ['Revenant','Badge + Title + Profile Banner + Mutant Egg', [
        { type:'banner', rarity:'mythic', name:'Profile Banner' },
        { type:'egg', rarity:'mythic', name:'Guaranteed Mutant Egg' },
      ]],
      ['Specter','Badge + Title + Mythic Giveaway Entries + Dice Pack', [
        { type:'giveaway', rarity:'mythic', name:'Mythic Giveaway Entries' },
        { type:'dice', rarity:'mythic', name:'Dice Pack' },
      ]],
      ['Eternal','Badge + Title + Exclusive Banner + Exclusive Name Effect + Mythic Giveaway Entries', [
        { type:'banner', rarity:'mythic', name:'Exclusive Banner' },
        { type:'nameeffect', rarity:'mythic', name:'Exclusive Name Effect' },
        { type:'giveaway', rarity:'mythic', name:'Mythic Giveaway Entries' },
      ]],
    ];
    for (let i = 0; i < 10; i++) {
      ms.push({
        level: (i + 1) * MILESTONE_INTERVAL,
        title: followerBundles[i][0],
        followerDesc: followerBundles[i][1],
        phamilyDesc: phamilyBundles[i][1],
        bonusItems: phamilyBundles[i][2],
      });
    }
    return ms;
  }

  const followerRewards = defineFollowerRewards();
  const phamilyRewards = definePhamilyRewards();
  const milestones = defineMilestones();

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

  function rewardKey(reward, track) {
    return reward.level + '_' + track + '_' + reward.type + '_' + reward.rarity;
  }

  function getRewardState(reward, track) {
    const key = rewardKey(reward, track);
    if (claimedRewards.includes(key)) return 'claimed';
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
        node.dataset.tier = (i % 2 === 0) ? 'near' : 'far';
        node.style.left = (xFor(reward.level) + offset - 22) + 'px';

        const stemEl = document.createElement('div');
        stemEl.className = 'pt-reward-stem';

        const iconEl = document.createElement('div');
        iconEl.className = 'pt-reward-icon';
        iconEl.textContent = reward.icon;

        /* The state badge is its own element rather than a ::after on the
           icon. The old one was absolutely positioned inside a non-relative
           box, so the tick rendered in the middle of the icon on top of the
           emoji instead of in a corner. */
        const badgeEl = document.createElement('div');
        badgeEl.className = 'pt-reward-badge';
        badgeEl.textContent = state === 'claimed' ? '✓' : state === 'locked' ? '🔒' : '!';
        iconEl.appendChild(badgeEl);

        const lvlEl = document.createElement('div');
        lvlEl.className = 'pt-reward-lvl';
        lvlEl.textContent = 'LVL ' + reward.level;

        if (track === 'top') {
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

    placeLane(laneTop, followerRewards, 'top');
    placeLane(laneBottom, phamilyRewards, 'bottom');

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
    } else {
      claimBtn.hidden = true;
      statusEl.textContent = 'Reach level ' + reward.level + ' to unlock';
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
        const track = activePopoverTrack === 'top' ? 'follower' : 'phamily';
        const key = rewardKey(activePopoverReward, track);
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

    const readyFollower = followerRewards.filter(r =>
      r.level <= prevMonth.level && !prevMonth.claimedRewards.includes(rewardKey(r, 'follower')));
    const readyPhamily = phamilyRewards.filter(r =>
      r.level <= prevMonth.level && !prevMonth.claimedRewards.includes(rewardKey(r, 'phamily')));
    const readyMilestones = milestones.filter(ms =>
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
    const today = new Date().getDate();
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

    function addItem(iconText, name, rarity, onClick) {
      const el = document.createElement('div');
      el.className = `pt-grace-item pt-rarity-${rarity}`;
      el.innerHTML = `<span class="pt-grace-item-icon">${iconText}</span><span class="pt-grace-item-name">${name}</span>`;
      el.addEventListener('click', onClick);
      itemsWrap.appendChild(el);
    }

    for (const r of readyFollower) {
      addItem(r.icon, r.name, r.rarity, (e) => showPopover(e, r, 'ready', 'top', true));
    }
    for (const r of readyPhamily) {
      addItem(r.icon, r.name, r.rarity, (e) => showPopover(e, r, 'ready', 'bottom', true));
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
    userLevel = data.level;
    userSubTier = data.subTier;
    userIsSub = data.subTier > 0;
    claimedRewards = data.claimedRewards || [];
    claimedMilestones = data.claimedMilestones || [];

    updateDashboard(data.level, data.hours, 0, data.daysLeft);
    updateBoostDisplay(data.subTier);
    buildThermometer(data.level);
    updateRewardsCount();
    renderGraceBanner(data.prevMonth);

    if (data.allTime) {
      document.getElementById('ptTotalHours').textContent = data.allTime.totalHours + 'h';
      document.getElementById('ptMonthsActive').textContent = data.allTime.monthsActive;
      document.getElementById('ptTotalRewards').textContent = data.allTime.totalRewardsClaimed;
      document.getElementById('ptBestLevel').textContent = data.allTime.bestLevel;
      document.getElementById('ptLongestStreak').textContent = data.allTime.longestStreak;
    }

    const attendance = data.attendance || {};
    const today = new Date().getUTCDate();
    let streak = 0;
    for (let d = today; d >= 1; d--) {
      if (attendance[String(d)] > 0) streak++;
      else break;
    }
    document.getElementById('ptCurrentStreak').textContent = streak;

    const daysInMonth = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0).getDate();
    const streamDays = new Set();
    for (let d = 1; d <= daysInMonth; d++) {
      const dow = new Date(new Date().getFullYear(), new Date().getMonth(), d).getDay();
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
