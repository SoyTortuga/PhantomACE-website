/* ══════════════════════════════════════════════
   SHARED COSMETIC VARIANTS — single client source of truth

   The ONE place the client maps an equipped cosmetic item to its visual
   variant, and the ONE place a name effect is applied to a displayed name.
   Reused by:
     - js/auth.js            (nav header name)
     - js/pages/profile.js   (profile heading name + banner)
     - js/pages/leaderboards.js (leaderboard rows)
     - chat (community/thread) once chat-system wires it in

   Loaded as a plain <script defer> before those scripts; it attaches its API
   to window.CosmeticVariants. The server has its own mirror of the mapping in
   functions/api/cosmetics.js (a browser script can't be imported there); the
   two are kept identical by server/scripts/test-cosmetics.js.

   THE CONTRACT (also used by the leaderboard/chat integrations):
     CosmeticVariants.nameEffectVariant(item) -> 'rare'|'mythic'|'exclusive'|null
     CosmeticVariants.bannerVariant(item)     -> same
     CosmeticVariants.bannerPath(variant)     -> '/assets/banners/banner-<v>.png' | null
     CosmeticVariants.applyNameFx(el, variant, { managed })
       Adds the name-fx-<variant> class to `el`. For mythic/exclusive it also
       drives the animation: unmanaged (single names — nav, profile) animate
       immediately; managed (dense lists — leaderboards, chat) are registered
       with the in-view + count cap so only visible names animate and never
       more than CAP at once. Call with variant null (or re-call) to clear.
   ══════════════════════════════════════════════ */
(function (global) {
  'use strict';

  /* variant mapping — extracted & tested by test-cosmetics / test-name-effects
     / test-banner. Name effects and banners map identically: first the rarity
     TIER — an explicit effect id wins, then a name containing "exclusive",
     then mythic rarity, else the rare floor — then an optional THEME prefix.
     When meta.theme is a known theme (e.g. 'halloween', 'harvest') the
     variant becomes "<theme>-<tier>" (harvest-rare/-mythic/-exclusive); otherwise it stays
     the plain tier (rare/mythic/exclusive) so existing items are unchanged.
     `effect`/`theme` are read from meta (raw inventory items) or flattened onto
     the item (the public profile payload). null → null. */
  function variantOf(item) {
    if (!item) return null;
    var meta = item.meta || {};
    var effect = meta.effect || item.effect || '';
    var name = String(item.name || '');
    var tier;
    if (effect === 'exclusive' || /exclusive/i.test(name)) tier = 'exclusive';
    else if (effect === 'mythic') tier = 'mythic';
    else if (effect === 'rare') tier = 'rare';
    else if (item.rarity === 'mythic') tier = 'mythic';
    else tier = 'rare';
    var theme = meta.theme || item.theme || '';
    return KNOWN_THEMES.indexOf(theme) !== -1 ? theme + '-' + tier : tier;
  }
  /* Themes that have CSS (name-fx-<theme>-<tier>) and banner art
     (banner-<theme>-<tier>.png). Anything else — a month nobody drew, a typo,
     a value with a space that would throw in classList.add — falls back to
     the plain tier. Mirrored exactly in functions/api/cosmetics.js; add a
     theme to BOTH only once its CSS and art have shipped. */
  var KNOWN_THEMES = ['halloween', 'harvest'];
  /* end variant mapping */

  function bannerPath(variant) {
    return variant ? '/assets/banners/banner-' + variant + '.png' : null;
  }

  /* ── Animation cap ────────────────────────────────────────────────
     name-fx-<variant> gives the static glow; name-fx-animate turns on the
     keyframe loop (see css/components.css). Only mythic/exclusive animate.
     For managed elements an IntersectionObserver adds name-fx-animate when a
     name scrolls into view (up to FX_CAP at once) and removes it when it
     leaves, so a long board never animates dozens of names simultaneously. */
  var FX_ANIMATED = { mythic: true, exclusive: true };
  var FX_CAP = 14;

  /* A variant is "<theme>-<tier>" or just "<tier>"; the animated flag keys on
     the tier (last segment), so themed variants animate exactly like their
     plain tier does. */
  function tierOf(variant) {
    return variant ? variant.slice(variant.lastIndexOf('-') + 1) : '';
  }
  var animating = new Set();     // managed elements currently animating (counted)
  var pending = new Set();       // in-view managed elements waiting for a slot
  var observer = null;

  function ensureObserver() {
    if (observer) return observer;
    if (typeof IntersectionObserver === 'undefined') return null;
    observer = new IntersectionObserver(function (entries) {
      for (var i = 0; i < entries.length; i++) {
        var el = entries[i].target;
        if (entries[i].isIntersecting) startAnimate(el);
        else stopAnimate(el);
      }
    }, { threshold: 0.1 });
    return observer;
  }

  function isAnimatedEl(el) {
    for (var i = 0; i < el.classList.length; i++) {
      var c = el.classList[i];
      if (c.indexOf('name-fx-') === 0 && FX_ANIMATED[tierOf(c)]) return true;
    }
    return false;
  }

  function startAnimate(el) {
    if (!isAnimatedEl(el) || animating.has(el)) return;
    if (animating.size >= FX_CAP) { pending.add(el); return; }
    el.classList.add('name-fx-animate');
    animating.add(el);
    pending.delete(el);
  }

  function stopAnimate(el) {
    pending.delete(el);
    if (animating.has(el)) {
      el.classList.remove('name-fx-animate');
      animating.delete(el);
      promote();
    }
  }

  function promote() {
    if (animating.size >= FX_CAP) return;
    var it = pending.values();
    var next = it.next();
    while (!next.done && animating.size < FX_CAP) {
      var el = next.value;
      pending.delete(el);
      el.classList.add('name-fx-animate');
      animating.add(el);
      next = it.next();
    }
  }

  function applyNameFx(el, variant, opts) {
    if (!el) return;
    opts = opts || {};
    /* Clear any prior state first — leaderboard/chat rows are reused. */
    stopAnimate(el);
    if (observer) observer.unobserve(el);
    /* Drop every prior name-fx-* class (plain or themed) — rows are reused. */
    var stale = [];
    for (var k = 0; k < el.classList.length; k++) {
      if (el.classList[k].indexOf('name-fx-') === 0) stale.push(el.classList[k]);
    }
    for (var m = 0; m < stale.length; m++) el.classList.remove(stale[m]);
    if (!variant) return;
    el.classList.add('name-fx-' + variant);
    if (!FX_ANIMATED[tierOf(variant)]) return;   // rare: static glow only
    if (opts.managed) {
      var ob = ensureObserver();
      if (ob) ob.observe(el);                     // observer toggles the class
      else el.classList.add('name-fx-animate');   // no IO support → just animate
    } else {
      el.classList.add('name-fx-animate');        // single name: always animate
    }
  }

  var api = {
    nameEffectVariant: variantOf,
    bannerVariant: variantOf,
    bannerPath: bannerPath,
    applyNameFx: applyNameFx,
  };

  global.CosmeticVariants = api;
  /* Bare globals for convenience / older call sites. */
  global.nameEffectVariant = variantOf;
  global.bannerVariant = variantOf;
})(typeof window !== 'undefined' ? window : this);
