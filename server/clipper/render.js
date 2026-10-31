/* ══════════════════════════════════════════════
   16:9 CLIP -> 1080×1920 GOTHIC SHORT.

   The look, held to the site's design rules (CLAUDE.md):
     - a blurred, DARKENED copy of the clip fills the 9:16 frame (the standard
       Shorts/TikTok fill that works for any aspect);
     - the sharp gameplay sits centred at full width;
     - a near-solid black band (rgba ~0x0A0A0A) frames top and bottom with a
       single red HAIRLINE at the inner edge — a border-top / border-bottom, the
       only decoration the design rules permit (NO side rails, NO box-shadow, NO
       blur on a box — the blur here is a background layer, not backdrop-filter);
     - GodOfWar sets the title in the top band (the one display face), the
       channel handle sits in the bottom band, both literal white on the dark
       fill so they read in either theme.

   FILTER PATHS ARE A WINDOWS TRAP. ffmpeg's filtergraph parser treats `:` and
   `\` specially, so an absolute path like C:\fonts\x.ttf in `fontfile=` is a
   parse error. We dodge it entirely: the caller stages font / title / logo into
   the job directory under bare names and runs ffmpeg with cwd set there, so the
   graph only ever names `font.ttf`, `title.txt`, `logo.png` — no colon, no
   backslash, nothing to escape.

   buildFilter() and wrapTitle() are pure so the graph is unit-tested without a
   render; renderVertical() does the staging and the spawn.
   ══════════════════════════════════════════════ */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const FRAME = {
  width: 1080,
  height: 1920,
  bandTop: 320,       // top band height (logo + title)
  bandBottom: 300,    // bottom band height (handle)
  accent: '0xFF0000', // the one red hairline
  band: '0x0A0A0A@0.96',
  fontSize: 52,
  logoHeight: 120,
};

/* HOW MUCH OF THE SOURCE WIDTH TO KEEP, as a divisor.
   A 16:9 clip laid full-width into a 9:16 frame is only 1080x608 — a third of
   the height, and a 44% horizontal downscale from a 1920-wide source, which is
   what makes gameplay text go soft. Cropping the sides first makes what
   remains both BIGGER and SHARPER:

     1.00  1080x608   32% of height   1920->1080, 44% lost   full width
     1.33  1080x810   42% of height   1440->1080, 25% lost   keeps 75%
     1.78  1080x1080  56% of height   native crop, 0% lost   keeps 56%

   1.78 is the sharpest possible but takes the minimap and killfeed off a
   shooter. 1.33 is the default: most of the gain, a crop nobody notices.
   Per-route, because MTG's action is central and tolerates more than an FPS
   does. */
export const DEFAULT_ZOOM = 1.33;

/** Greedy word-wrap for drawtext, which does not wrap on its own. Pure. */
export function wrapTitle(title, maxChars = 24, maxLines = 2) {
  const words = String(title || '').trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const w of words) {
    const next = line ? `${line} ${w}` : w;
    if (next.length > maxChars && line) { lines.push(line); line = w; }
    else line = next;
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = kept[maxLines - 1].replace(/\s+\S*$/, '') + '…';
    return kept;
  }
  return lines;
}

/**
 * The -filter_complex string. Pure: references the staged bare filenames.
 * @param {object} o
 * @param {boolean} o.hasLogo  include a [1:v] logo overlay
 * @param {boolean} o.hasFooter draw the handle in the bottom band
 * @param {string}  o.footer   handle text (already escaped-safe; plain ASCII)
 * @returns {string}
 */
export function buildFilter({ hasLogo = true, hasFooter = true, footer = '@PhantomACE', frame = FRAME, zoom = DEFAULT_ZOOM } = {}) {
  const { width: W, height: H, bandTop: BT, bandBottom: BB, accent, band, fontSize, logoHeight } = frame;
  const z = Number(zoom) > 0 ? Number(zoom) : 1;

  const bg = `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,` +
    `crop=${W}:${H},boxblur=20:2,eq=brightness=-0.38:saturation=0.65[bg]`;
  /* Crop the sides BEFORE scaling, in source pixels — `iw` keeps this correct
     whatever the clip's own resolution is. The blurred background still comes
     from the uncropped frame, so the edges we remove are what bleeds behind. */
  const fg = `[0:v]crop=iw/${z}:ih,scale=${W}:-2[fg]`;

  /* One chain on the composited frame: centre the clip, lay the bands, the red
     hairlines, then the title (and footer). */
  const draws = [
    `[bg][fg]overlay=(W-w)/2:(H-h)/2`,
    `drawbox=x=0:y=0:w=${W}:h=${BT}:t=fill:color=${band}`,
    `drawbox=x=0:y=${H}-${BB}:w=${W}:h=${BB}:t=fill:color=${band}`,
    `drawbox=x=0:y=${BT}-4:w=${W}:h=4:t=fill:color=${accent}`,
    `drawbox=x=0:y=${H}-${BB}:w=${W}:h=4:t=fill:color=${accent}`,
    `drawtext=fontfile=font.ttf:textfile=title.txt:fontsize=${fontSize}:fontcolor=white:` +
      `x=(w-text_w)/2:y=${hasLogo ? 170 : 110}:line_spacing=14`,
  ];
  if (hasFooter) {
    draws.push(
      `drawtext=fontfile=font.ttf:text='${footer}':fontsize=40:fontcolor=white:` +
      `x=(w-text_w)/2:y=${H}-${Math.round(BB / 2)}-20`);
  }

  let chain = `${bg};${fg};${draws.join(',')}`;
  if (hasLogo) {
    chain += `[vtxt];[1:v]scale=-1:${logoHeight}[logo];[vtxt][logo]overlay=(W-w)/2:40[vout]`;
  } else {
    chain += `[vout]`;
  }
  return chain;
}

/** The full ffmpeg argv. Pure. */
export function ffmpegArgs({ input, output, filter, hasLogo, logoFile, maxDurationSec = 60 }) {
  const args = ['-y', '-i', input];
  if (hasLogo) args.push('-i', logoFile);
  args.push(
    '-t', String(maxDurationSec),
    '-filter_complex', filter,
    '-map', '[vout]', '-map', '0:a?',
    /* NO -r. Twitch clips are commonly 60fps and Shorts plays 60fps; forcing
       30 threw away half the frames of every gameplay clip. */
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '18',
    '-pix_fmt', 'yuv420p', '-profile:v', 'high',
    '-c:a', 'aac', '-b:a', '160k', '-ar', '44100',
    '-movflags', '+faststart',
    output);
  return args;
}

/**
 * Render a vertical Short. Stages font/title/logo into the job dir and spawns
 * ffmpeg there so the filtergraph needs no path escaping.
 *
 * @param {object} o
 * @param {string} o.input      downloaded clip .mp4
 * @param {string} o.output     target .mp4 (should sit in the job dir)
 * @param {string} o.title      clip title (wrapped for the top band)
 * @param {string} o.fontFile   absolute path to GODOFWAR.TTF
 * @param {string} [o.logoFile] absolute path to the logo PNG (optional)
 * @param {string} [o.footer]   bottom-band handle
 * @param {number} [o.maxDurationSec]
 * @param {number} [o.zoom]  how much of the source width to keep (see DEFAULT_ZOOM)
 * @param {string} [o.ffmpegPath]
 */
export async function renderVertical(o) {
  const jobDir = path.dirname(o.output);
  fs.mkdirSync(jobDir, { recursive: true });

  fs.copyFileSync(o.fontFile, path.join(jobDir, 'font.ttf'));
  fs.writeFileSync(path.join(jobDir, 'title.txt'), wrapTitle(o.title).join('\n'), 'utf8');

  const hasLogo = Boolean(o.logoFile && fs.existsSync(o.logoFile));
  if (hasLogo) fs.copyFileSync(o.logoFile, path.join(jobDir, 'logo.png'));

  const filter = buildFilter({ hasLogo, footer: o.footer || '@PhantomACE', zoom: o.zoom });
  const args = ffmpegArgs({
    input: path.resolve(o.input),
    output: path.basename(o.output),
    filter,
    hasLogo,
    logoFile: 'logo.png',
    maxDurationSec: o.maxDurationSec || 60,
  });

  await runFfmpeg(o.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg', args, jobDir);
  return { output: o.output };
}

function runFfmpeg(bin, args, cwd) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 8000) stderr = stderr.slice(-8000); });
    proc.on('error', (err) => reject(new Error(`Could not start ffmpeg (${bin}): ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}:\n${stderr.slice(-2000)}`));
    });
  });
}
