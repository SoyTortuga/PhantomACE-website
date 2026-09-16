#!/usr/bin/env node
/* ══════════════════════════════════════════════
   PROFILES — test suite

     node server/scripts/test-profile.js

   The favourite dino is the first thing in this codebase that takes a value
   from one person's browser and renders it on a page OTHER people read.
   Everything else the client sends is either checked against a server-held
   list or only ever shown back to the person who sent it.

   The park save is stored wholesale and never inspected, which is fine for
   a private document and exactly wrong once one field of it becomes public.
   Two fields make it dangerous:

     src     — left open it accepts any URL, putting a third-party image on
               a public page under somebody else's name.
     filter  — it lands in a style attribute, so anything that can close
               that attribute or smuggle a url() is an injection.
   ══════════════════════════════════════════════ */

import { sanitizeFavorite } from '../../functions/api/dino-park.js';

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

const ASSET = '/games/dino-park/assets/dino-assets/icons/rex.png';
const good = (over = {}) => sanitizeFavorite({
  specId: 'rex', mutation: 'albino', nickname: 'Chomp', src: ASSET,
  filter: 'hue-rotate(90deg) saturate(1.2)', ...over,
});

/* ── What a real favourite keeps ─────────────────────────────────────── */
{
  const f = good();
  ok('a well-formed favourite survives', !!f);
  check('the species', f.specId, 'rex');
  check('the mutation', f.mutation, 'albino');
  check('the nickname', f.nickname, 'Chomp');
  check('the artwork', f.src, ASSET);
  check('and a legitimate filter', f.filter, 'hue-rotate(90deg) saturate(1.2)');
  ok('stamped with a time', typeof f.at === 'number');

  /* An inline sprite, for the species drawn on a canvas rather than shipped
     as a file. */
  const inline = good({ src: 'data:image/png;base64,iVBORw0KGgoAAAA=' });
  ok('an inline sprite is allowed', !!inline);
  check('and kept verbatim', inline.src, 'data:image/png;base64,iVBORw0KGgoAAAA=');
}

/* ── src: the third-party image hole ─────────────────────────────────── */
{
  /* THE ATTACK. A favourite is rendered on a public profile, so an open src
     is an arbitrary image request made by everyone who views that page —
     a tracking pixel at best. */
  check('an external image is refused',
    sanitizeFavorite({ specId: 'rex', src: 'https://evil.example/track.gif' }), null);
  check('and a protocol-relative one',
    sanitizeFavorite({ specId: 'rex', src: '//evil.example/track.gif' }), null);
  check('and javascript:',
    sanitizeFavorite({ specId: 'rex', src: 'javascript:alert(1)' }), null);
  check('and an svg data URL, which can carry script',
    sanitizeFavorite({ specId: 'rex', src: 'data:image/svg+xml;base64,PHN2Zz4=' }), null);

  /* Path traversal out of the asset tree. */
  check('traversal out of the asset tree is refused',
    sanitizeFavorite({ specId: 'rex', src: '/games/dino-park/assets/../../../server/.env' }), null);
  check('another game’s tree is refused',
    sanitizeFavorite({ specId: 'rex', src: '/games/mtgbbb/assets/x.png' }), null);
  check('and a non-image extension',
    sanitizeFavorite({ specId: 'rex', src: '/games/dino-park/assets/x.js' }), null);

  check('a missing src is refused', sanitizeFavorite({ specId: 'rex' }), null);
  check('an oversized inline image is refused',
    sanitizeFavorite({ specId: 'rex', src: 'data:image/png;base64,' + 'A'.repeat(30000) }), null);
}

/* ── filter: the style-attribute injection ───────────────────────────── */
{
  /* The filter is interpolated into a style attribute. A value that can
     close it, or smuggle a url(), is script or an outbound request. The
     favourite is kept — the dino is legitimate — and the filter dropped. */
  const quoted = good({ filter: '" onload="alert(1)' });
  ok('a filter that escapes the attribute is dropped', !!quoted && quoted.filter === '');

  const url = good({ filter: 'url(https://evil.example/x.svg#f)' });
  check('a url() filter is dropped', url.filter, '');

  const semi = good({ filter: 'blur(2px); background:url(x)' });
  check('a filter smuggling a second declaration is dropped', semi.filter, '');

  const close = good({ filter: 'blur(2px)}body{display:none' });
  check('a filter closing the rule is dropped', close.filter, '');

  const tag = good({ filter: '<script>alert(1)</script>' });
  check('markup in a filter is dropped', tag.filter, '');

  const long = good({ filter: 'blur(1px) '.repeat(60) });
  check('an absurdly long filter is dropped', long.filter, '');

  /* Dropping the filter must not drop the dino with it — the sprite is
     still legitimate and still theirs. */
  ok('but the favourite itself survives a bad filter', !!quoted.specId);
  check('with its artwork intact', quoted.src, ASSET);
}

/* ── specId, mutation, nickname ──────────────────────────────────────── */
{
  check('a missing species is refused', sanitizeFavorite({ src: ASSET }), null);
  check('and a species with markup in it',
    sanitizeFavorite({ specId: '<img src=x onerror=alert(1)>', src: ASSET }), null);
  check('and one absurdly long',
    sanitizeFavorite({ specId: 'a'.repeat(50), src: ASSET }), null);

  /* A bad mutation is dropped rather than refused: the dino is real, only
     the variant claim is not. */
  check('a malformed mutation is dropped, not fatal', good({ mutation: 'a<b>c' }).mutation, '');
  check('and an absent one is empty', good({ mutation: null }).mutation, '');

  /* The nickname is player-authored prose and is escaped at render. It is
     length-capped here so one person cannot put a paragraph on a page
     everyone else loads. */
  check('a long nickname is cut to 24', good({ nickname: 'x'.repeat(100) }).nickname.length, 24);
  check('and trimmed', good({ nickname: '  Rexy  ' }).nickname, 'Rexy');
  /* Stored as written — nothing reconstructs markup from it, and mangling
     it here would corrupt a legitimate name containing an apostrophe. */
  check('markup is stored as text, not stripped',
    good({ nickname: '<b>hi</b>' }).nickname, '<b>hi</b>');
}

/* ── Nothing at all ──────────────────────────────────────────────────── */
{
  check('null is null', sanitizeFavorite(null), null);
  check('undefined is null', sanitizeFavorite(undefined), null);
  check('a string is null', sanitizeFavorite('rex'), null);
  check('an array is null', sanitizeFavorite([]), null);
  check('a number is null', sanitizeFavorite(7), null);
}

/* ── Only the known fields survive ───────────────────────────────────── */
{
  /* A whitelist, not a filter: an unknown field added by a modified client
     must not ride along into a public response. */
  const f = sanitizeFavorite({
    specId: 'rex', src: ASSET,
    onclick: 'alert(1)', html: '<script>', __proto__: { polluted: true },
  });
  check('unknown fields are not carried through',
    Object.keys(f).sort(),
    ['at', 'build', 'desc', 'diet', 'era', 'filter', 'habitat', 'mutation',
     'mutationLabel', 'nickname', 'portrait', 'portraitFilter', 'rarity',
     'specId', 'species', 'src']);
}

/* ── The stat block ──────────────────────────────────────────────────
   The favourite carries what the collection shows when you select a
   species: a portrait, the species name, era, habitat, rarity, diet, build
   and the description. All of it is rendered publicly, so all of it is
   bounded — and the portrait is a second image on exactly the same terms
   as the first, which means the same hole if it is left open. */
{
  const PORTRAIT = '/games/dino-park/assets/AncientBeastsPack/Rex-72x72.png';
  const full = (over = {}) => sanitizeFavorite({
    specId: 'rex', src: ASSET, portrait: PORTRAIT,
    portraitFilter: 'hue-rotate(40deg)',
    species: 'Tyrannosaurus', rarity: 'legendary', diet: 'Carnivore',
    habitat: 'Land', era: 'Cretaceous', build: 'theropod',
    desc: 'The tyrant lizard king.', mutationLabel: 'Albino', ...over,
  });

  const f = full();
  check('the portrait is kept', f.portrait, PORTRAIT);
  check('with its own filter', f.portraitFilter, 'hue-rotate(40deg)');
  check('the species name', f.species, 'Tyrannosaurus');
  check('the rarity', f.rarity, 'legendary');
  check('the era', f.era, 'Cretaceous');
  check('the build', f.build, 'theropod');
  check('the mutation label', f.mutationLabel, 'Albino');
  check('and the description', f.desc, 'The tyrant lizard king.');

  /* THE SAME HOLE, TWICE. An unchecked portrait is an external image
     request made by everyone who loads the profile, exactly as src was. */
  check('an external portrait is dropped',
    full({ portrait: 'https://evil.example/track.gif' }).portrait, '');
  check('and an svg data URL portrait',
    full({ portrait: 'data:image/svg+xml;base64,PHN2Zz4=' }).portrait, '');
  check('and one escaping the asset tree',
    full({ portrait: '/games/dino-park/assets/../../server/.env' }).portrait, '');

  /* A bad portrait costs the portrait, not the dino — the icon still
     stands in and the stat block reads fine without it. */
  const noPortrait = full({ portrait: 'https://evil.example/x.png' });
  ok('the favourite survives a refused portrait', !!noPortrait.specId);
  check('and keeps its sprite', noPortrait.src, ASSET);

  check('a portrait filter that escapes the attribute is dropped',
    full({ portraitFilter: '" onload="alert(1)' }).portraitFilter, '');
  check('and one smuggling a url()',
    full({ portraitFilter: 'url(https://evil.example/x.svg)' }).portraitFilter, '');
  /* A dropped portrait takes its filter with it: a filter applied to
     nothing is meaningless, and carrying it forward invites it being
     applied to whatever stands in. */
  check('a refused portrait drops its filter too', noPortrait.portraitFilter, '');

  /* Prose is capped rather than pattern-matched — refusing a species name
     for containing a hyphen would be worse than useless — and every field
     is escaped at render. */
  check('a runaway description is cut', full({ desc: 'x'.repeat(900) }).desc.length, 300);
  check('and a runaway species name', full({ species: 'y'.repeat(200) }).species.length, 40);
  check('markup in prose is stored as text, not stripped',
    full({ species: '<b>Rex</b>' }).species, '<b>Rex</b>');
  check('missing prose becomes empty, never undefined',
    sanitizeFavorite({ specId: 'rex', src: ASSET }).species, '');
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[profile] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[profile] ${passed} assertions passed.`);
console.log('');
