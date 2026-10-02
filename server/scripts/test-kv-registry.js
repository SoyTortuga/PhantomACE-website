#!/usr/bin/env node
/* ══════════════════════════════════════════════
   KV KEYS ARE ALL REGISTERED — test suite

     node server/scripts/test-kv-registry.js

   THE BUG THIS EXISTS FOR. The Mana Clash overlay panel shipped writing a
   new key, `overlay_mana_clash`, that nothing in lib/registry.js mapped to
   a table. resolveKey returned null, the DAL threw — correctly, and with a
   good message — and the control panel reported HTTP 500 on a live stream.

   Nothing caught it earlier because the route's own suite fakes the KV
   shim, so the registry was never consulted; and because the key is one
   string in one file, invisible to any test of behaviour. The registry
   deliberately refuses to guess a table, which is right: guessing writes a
   row nothing can ever read back. But it can only refuse at runtime.

   So this reads the SOURCE and asks the real registry about every key it
   can see being used. A new key now fails here, on a laptop, in a second.

   THE SECOND TIME. milestones.js built `follow_seen_${uid}` into a local
   const and passed the const to get()/put(). The first version of this
   scanner only followed consts holding a single-quoted literal, so it never
   saw the key — and every channel.follow 500'd on "no table mapping". It now
   evaluates a key expression's STATIC SHAPE: literals, templates, `+`
   concatenation, ternaries, consts (any of those, transitively) and simple
   key-builder functions in the same file, with each dynamic part kept as a
   wildcard. A shape resolves when its literal head lands in a registered
   family, or when it matches an exact singleton with the wildcards filled.

   It still cannot see a key whose head is itself dynamic, or one built by a
   function imported from another file, which is why it reports what it
   checked rather than claiming completeness.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveKey, SINGLETONS } from '../lib/registry.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');

let passed = 0;
const failures = [];
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; return; }
  failures.push(`${label}\n      expected ${e}\n      got      ${a}`);
}
const ok = (label, cond) => check(label, !!cond, true);

/* Where application code talks to the shim. server/lib is excluded: that IS
   the shim, and registry.js is full of key names by definition. */
const ROOTS = ['functions', 'server/scripts'];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    /* Test files are skipped, including this one. They fake the shim, so
       the key strings in them are fixtures that never reach the registry —
       and the examples in this file's own header would otherwise be read as
       real usage, which is exactly what happened the first time it ran. */
    else if (e.name.endsWith('.js') && !e.name.startsWith('test-')) out.push(full);
  }
  return out;
}

/* ── A tiny expression reader ────────────────────────────────────────── */

/* Stands for "some runtime value" inside a key shape. */
const ANY = '\u0000';

function skipQuoted(src, i) {
  const q = src[i];
  i++;
  while (i < src.length && src[i] !== q) {
    if (src[i] === '\\') i++;
    else if (src[i] === '\n') return i;
    i++;
  }
  return i + 1;
}

function skipTemplate(src, i) {
  i++;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '`') return i + 1;
    if (c === '$' && src[i + 1] === '{') { i = readExpr(src, i + 2, '}').end + 1; continue; }
    i++;
  }
  return i;
}

function skipComment(src, i) {
  if (src[i] !== '/') return i;
  if (src[i + 1] === '/') { const nl = src.indexOf('\n', i); return nl < 0 ? src.length : nl; }
  if (src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); return e < 0 ? src.length : e + 2; }
  return i;
}

const OPERATOR_TAIL = /[+\-*/?:=(,[{&|!<>]$/;
const OPERATOR_HEAD = /^[+\-*/?:.&|]/;

/**
 * Read from i to the first depth-0 char in `stops` (or an unmatched closer).
 * A newline stop is skipped when the expression visibly continues on the
 * next line, so multi-line ternaries and concatenations read whole.
 */
function readExpr(src, i, stops) {
  const start = i;
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === "'" || c === '"') { i = skipQuoted(src, i); continue; }
    if (c === '`') { i = skipTemplate(src, i); continue; }
    const past = skipComment(src, i);
    if (past !== i) { i = past; continue; }
    if (depth === 0 && stops.includes(c)) {
      if (c !== '\n') break;
      const before = src.slice(start, i).trimEnd();
      const after = src.slice(i).trimStart();
      if (!OPERATOR_TAIL.test(before) && !OPERATOR_HEAD.test(after)) break;
    }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) { if (depth === 0) break; depth--; }
    i++;
  }
  return { text: src.slice(start, i), end: i };
}

/** Split at depth-0 occurrences of `sep`, ignoring strings and comments. */
function splitTop(text, sep) {
  const parts = [];
  let depth = 0, from = 0, i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"') { i = skipQuoted(text, i); continue; }
    if (c === '`') { i = skipTemplate(text, i); continue; }
    const past = skipComment(text, i);
    if (past !== i) { i = past; continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (depth === 0 && c === sep) { parts.push(text.slice(from, i)); from = i + 1; }
    i++;
  }
  parts.push(text.slice(from));
  return parts;
}

function stripComments(text) {
  let out = '', i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"') { const e = skipQuoted(text, i); out += text.slice(i, e); i = e; continue; }
    if (c === '`') { const e = skipTemplate(text, i); out += text.slice(i, e); i = e; continue; }
    const past = skipComment(text, i);
    if (past !== i) { out += ' '; i = past; continue; }
    out += c;
    i++;
  }
  return out;
}

/** [cond, whenTrue, whenFalse] for a depth-0 ternary, else null. */
function splitTernary(text) {
  let depth = 0, q = -1, nest = 0, i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "'" || c === '"') { i = skipQuoted(text, i); continue; }
    if (c === '`') { i = skipTemplate(text, i); continue; }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (depth === 0 && c === '?') {
      if (text[i + 1] === '?' || (text[i + 1] === '.' && !/\d/.test(text[i + 2] || ''))) { i += 2; continue; }
      if (q < 0) q = i; else nest++;
    } else if (depth === 0 && c === ':' && q >= 0) {
      if (nest === 0) return [text.slice(0, q), text.slice(q + 1, i), text.slice(i + 1)];
      nest--;
    }
    i++;
  }
  return null;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

function unescapeLiteral(body) {
  return body.replace(/\\(.)/gs, '$1');
}

function isWhole(text, skipper) {
  return skipper(text, 0) === text.length;
}

function callName(text) {
  const m = text.match(/^([A-Za-z_$][\w$]*)\s*\(/);
  if (!m) return null;
  const close = readExpr(text, m[0].length, ')').end;
  return close === text.length - 1 ? m[1] : null;
}

/** The one shape a sub-expression stands for, or ANY when that is unknowable. */
function single(text, ctx) {
  const shapes = shapesOf(text, ctx);
  return shapes.length === 1 ? shapes[0] : ANY;
}

function templateShape(text, ctx) {
  let out = '', i = 1;
  while (i < text.length - 1) {
    const c = text[i];
    if (c === '\\') { out += text[i + 1] || ''; i += 2; continue; }
    if (c === '$' && text[i + 1] === '{') {
      const inner = readExpr(text, i + 2, '}');
      out += single(inner.text, ctx);
      i = inner.end + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

function partShape(part, ctx) {
  const p = part.trim();
  if (!p) return ANY;
  if ((p[0] === "'" || p[0] === '"') && isWhole(p, skipQuoted)) return unescapeLiteral(p.slice(1, -1));
  if (p[0] === '`' && isWhole(p, skipTemplate)) return templateShape(p, ctx);
  if (p[0] === '(' && readExpr(p, 1, ')').end === p.length - 1) return single(p.slice(1, -1), ctx);
  if (IDENT.test(p) || callName(p)) return single(p, ctx);
  return ANY;
}

/**
 * Every static shape an expression can evaluate to, with runtime parts as
 * ANY. [] means "nothing knowable" — an unknown identifier, for instance,
 * which is usually a parameter and checked wherever its caller builds it.
 */
function shapesOf(expr, ctx, guard = 0) {
  if (guard > 8) return [];
  let text = stripComments(expr).trim();
  while (text[0] === '(' && readExpr(text, 1, ')').end === text.length - 1) text = text.slice(1, -1).trim();
  if (!text) return [];

  const tern = splitTernary(text);
  if (tern) return [...shapesOf(tern[1], ctx, guard + 1), ...shapesOf(tern[2], ctx, guard + 1)];

  if (IDENT.test(text)) return ctx.consts.get(text) || [];
  const fn = callName(text);
  if (fn) return ctx.fns.get(fn) || [];

  const shape = splitTop(text, '+').map(p => partShape(p, ctx)).join('');
  return shape.replace(/\u0000+/g, ANY) === ANY ? [] : [shape.replace(/\u0000+/g, ANY)];
}

const ARROW = /^(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*/;

function returnsOf(body, ctx) {
  const out = [];
  for (const m of body.matchAll(/\breturn\s+/g)) {
    out.push(...shapesOf(readExpr(body, m.index + m[0].length, ';\n}').text, ctx));
  }
  return out;
}

/** Module and local consts, and key-builder functions, as shapes. */
function bindings(src) {
  const decls = [];
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*/g)) {
    decls.push({ name: m[1], text: readExpr(src, m.index + m[0].length, ';\n,').text });
  }
  const fnDecls = [];
  for (const m of src.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g)) {
    fnDecls.push({ name: m[1], body: readExpr(src, m.index + m[0].length, '}').text });
  }

  /* Two passes so a binding can refer to one declared further down — a
     module const used inside a function above it, a hoisted builder. */
  let ctx = { consts: new Map(), fns: new Map() };
  for (let pass = 0; pass < 2; pass++) {
    const next = { consts: new Map(), fns: new Map() };
    const add = (map, name, shapes) => {
      if (!shapes.length) return;
      const all = new Set([...(map.get(name) || []), ...shapes]);
      map.set(name, [...all]);
    };
    for (const d of decls) {
      const arrow = d.text.trim().match(ARROW);
      if (arrow) {
        const body = d.text.trim().slice(arrow[0].length);
        add(next.fns, d.name, body.startsWith('{') ? returnsOf(body, ctx) : shapesOf(body, ctx));
      } else {
        add(next.consts, d.name, shapesOf(d.text, ctx));
      }
    }
    for (const f of fnDecls) add(next.fns, f.name, returnsOf(f.body, ctx));
    ctx = next;
  }
  return ctx;
}

/**
 * Every KV key shape this file can be seen to use: the first argument of
 * get/put/delete/mutate/claim on the store (env.MARKETPLACE, or `tx` inside
 * withLock), and the prefix handed to list()/listValues().
 */
function keysIn(src) {
  const ctx = bindings(src);
  const found = new Set();
  const take = (expr) => { for (const s of shapesOf(expr, ctx)) found.add(s); };

  for (const m of src.matchAll(/\b(?:MARKETPLACE|tx)\.(?:get|put|delete|mutate|claim)\(\s*/g)) {
    take(readExpr(src, m.index + m[0].length, ',)').text);
  }
  for (const m of src.matchAll(/\b(?:MARKETPLACE\.list|listValues)\(\s*\{/g)) {
    const obj = readExpr(src, m.index + m[0].length, '}').text;
    const p = obj.match(/\bprefix\b\s*(:)?\s*/);
    if (!p) continue;
    take(p[1] ? readExpr(obj, p.index + p[0].length, ',}').text : 'prefix');
  }
  return found;
}

const show = (shape) => shape.replace(/\u0000/g, '${…}');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Does a key shape land on a table? A whole literal must resolve as-is, or
 * as a family prefix (list() prefixes end in _). A shape with runtime parts
 * resolves if its literal head falls in a family, or if some exact
 * singleton fits the shape — giveaway_reward_${rarity}_id is three
 * singletons, not a family.
 */
function resolves(shape) {
  const at = shape.indexOf(ANY);
  if (at < 0) return !!(resolveKey(shape) || resolveKey(shape + 'x'));
  if (resolveKey(shape.slice(0, at) + ANY)) return true;
  const re = new RegExp('^' + shape.split(ANY).map(escapeRe).join('.+') + '$');
  return Object.keys(SINGLETONS).some(k => re.test(k));
}

const files = ROOTS.flatMap(r => walk(path.join(REPO, r)));
const unmapped = [];
let checked = 0;

for (const file of files) {
  const src = fs.readFileSync(file, 'utf8');
  for (const key of keysIn(src)) {
    checked++;
    if (!resolves(key)) {
      unmapped.push(`${path.relative(REPO, file).replace(/\\/g, '/')} → "${show(key)}"`);
    }
  }
}

/* ── The whole point ─────────────────────────────────────────────────── */
{
  ok('there is application code to scan', files.length > 20);
  ok('and keys were actually found in it', checked > 40);

  /* A failure here names the file and the key. The fix is one line in
     server/lib/registry.js, and the question it asks is whether the row
     should expire on its own — 'real' if the TTL IS the rule, 'none' if
     something inside the value decides instead. */
  check('every KV key the source uses has a table', unmapped, []);
}

/* ── The keys from the outages themselves ────────────────────────────── */
{
  /* Read once and null-guarded. Dereferencing this directly made the suite
     die with a TypeError when the entry was missing — which is the one case
     it exists to describe, and a stack trace names the test rather than the
     key somebody has to go and register. */
  const pointer = resolveKey('overlay_mana_clash');
  ok('the overlay pointer resolves', !!pointer);
  /* It sits with the other overlay singletons, and must not have been
     dropped into a family by accident. */
  check('to the singletons table', pointer && pointer.table, 'singletons');
  /* 'none' is a decision: a pointer expiring on its own would switch the
     panel off mid-stream with nothing to explain it. */
  check('and never expires on its own', pointer && pointer.expiry, 'none');

  /* Every channel.follow threw on this one. It is a 10-minute dedupe
     marker: the row disappearing IS the window closing, so 'real'. */
  const follow = resolveKey('follow_seen_115385716');
  ok('follow_seen_ resolves', !!follow);
  check('follow_seen_ is in a reaped table', follow && follow.table, 'singletons');
  check('follow_seen_ really expires', follow && follow.expiry, 'real');

  /* EventSub message-id dedupe (lib/eventsub.js). Same shape of rule. */
  const msg = resolveKey('eventsub_msg_6d2c1b6e-1f0a-4c1e-9e57-1b2d3c4d5e6f');
  ok('eventsub_msg_ resolves', !!msg);
  check('eventsub_msg_ is in a reaped table', msg && msg.table, 'singletons');
  check('eventsub_msg_ really expires', msg && msg.expiry, 'real');
  /* And the family must not swallow the exact singleton beside it. */
  check('eventsub_subscriptions is still its own singleton',
    resolveKey('eventsub_subscriptions'), { table: 'singletons', expiry: 'none' });
}

/* ── The scanner is not fooling itself ───────────────────────────────── */
{
  /* If keysIn() silently matched nothing, the suite above would pass while
     checking nothing at all — the worst way for a guard to fail. */
  const sample = keysIn(`
    const MY_KEY = 'overlay_mana_clash';
    const PREFIX = "park_bg_";
    await env.MARKETPLACE.get(MY_KEY, 'json');
    await env.MARKETPLACE.put('checkin_current', x);
    await env.MARKETPLACE.mutate(\`inv_\${id}\`, f);
    await env.MARKETPLACE.get('mc_room_' + code, 'json');
    await env.MARKETPLACE.listValues({ prefix: 'gwe_' });
    await env.MARKETPLACE.list({ prefix: PREFIX });
    function handler(event) {
      const seenKey = \`follow_seen_\${uid}\`;
      if (await env.MARKETPLACE.get(seenKey)) return;
      const listingKey = 'listing_' + body.listingId;
      await env.MARKETPLACE.delete(listingKey);
      const which = flag
        ? WINNER_KEY
        : OTHER_KEY;
      await env.MARKETPLACE.get(which);
      await env.MARKETPLACE.put(slotIdKey('rare', 2), id);
      await env.MARKETPLACE.get(bgKey(id));
      await env.MARKETPLACE.get(\`\${PREFIX}\${id}\`);
      await env.MARKETPLACE.get(someParam);
    }
    const WINNER_KEY = 'giveaway_winner';
    const OTHER_KEY = 'giveaway_monthly_winner';
    function slotIdKey(rarity, slot) {
      return slot === 1 ? \`giveaway_reward_\${rarity}_id\` : \`giveaway_reward_\${rarity}_\${slot}_id\`;
    }
    const bgKey = (id) => PREFIX + String(id);
  `);
  const has = (s) => sample.has(s.replace(/\*/g, ANY));
  check('a const key is seen', has('overlay_mana_clash'), true);
  check('a literal key is seen', has('checkin_current'), true);
  check('a template family is seen by its shape', has('inv_*'), true);
  check('a concatenated family too', has('mc_room_*'), true);
  check('and a listValues prefix', has('gwe_'), true);
  check('a list() prefix held in a const', has('park_bg_'), true);
  check('a template held in a local const (the follow_seen_ outage)', has('follow_seen_*'), true);
  check('a concatenation held in a local const', has('listing_*'), true);
  check('both arms of a ternary const', has('giveaway_winner') && has('giveaway_monthly_winner'), true);
  check('a key-builder function', has('giveaway_reward_*_id') && has('giveaway_reward_*_*_id'), true);
  check('an arrow key-builder over a const', has('park_bg_*'), true);
  check('a template whose head is a const', has('park_bg_*'), true);
  check('a bare parameter is not guessed at', sample.size, 13);

  check('a variable-middle shape resolves against exact singletons',
    resolves('giveaway_reward_' + ANY + '_' + ANY + '_id'), true);
  check('the follow_seen_ shape resolves now it is registered',
    resolves('follow_seen_' + ANY), true);

  /* And it must reject, or it proves nothing. */
  ok('an unregistered key does not resolve', !resolves('overlay_not_a_real_key'));
  ok('an unregistered family does not resolve', !resolves('not_a_family_' + ANY));
  ok('a shape fitting no singleton does not resolve', !resolves('giveaway_reward_' + ANY + '_nope'));
}

/* ── Report ──────────────────────────────────────────────────────────── */
console.log('');
if (failures.length) {
  console.log(`[kv-registry] ${passed} passed, ${failures.length} FAILED`);
  console.log('');
  for (const f of failures) console.log(`  FAIL: ${f}`);
  console.log('');
  process.exit(1);
}
console.log(`[kv-registry] ${passed} assertions passed — ${checked} key uses across ${files.length} files.`);
console.log('');
