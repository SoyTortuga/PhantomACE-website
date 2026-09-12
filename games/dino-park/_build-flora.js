const sharp = require('sharp');
const path = require('path');

const TREES_SRC = path.join(__dirname, 'assets/dino-assets/jurassic-tiles/Jurassic World Pixel Art Megapack', '7. Tropical trees and ferns.png');
const OUT = path.join(__dirname, 'assets/dino-assets');
const OX = 55, OY = 222, STRIDE = 139, CELL = 128;

// Flora positions on sheet 7 (row, col) => output name
// Trees are typically 1 cell but may have artifacts from adjacent cells
const FLORA = [
  { row: 0, col: 0, name: 'tree-palm1' },
  { row: 0, col: 1, name: 'tree-palm2' },
  { row: 0, col: 2, name: 'tree-palm3' },
  { row: 0, col: 3, name: 'tree-palm4' },
  { row: 0, col: 4, name: 'tree-big' },
  { row: 0, col: 5, name: 'tree-big2' },
  { row: 1, col: 0, name: 'fern1' },
  { row: 1, col: 1, name: 'fern2' },
  { row: 1, col: 2, name: 'fern3' },
  { row: 1, col: 3, name: 'flower1' },
  { row: 1, col: 4, name: 'flower2' },
];

async function floodFillMask(data, w, h, ch, startX, startY) {
  const mask = new Uint8Array(w * h);
  const stack = [[startX, startY]];
  const visited = new Set();

  const isContent = (x, y) => {
    if (x < 0 || x >= w || y < 0 || y >= h) return false;
    const i = (y * w + x) * ch;
    return data[i + 3] > 20 && (data[i] + data[i+1] + data[i+2]) > 30;
  };

  // Find the nearest content pixel to start from
  let found = false;
  for (let r = 0; r < Math.max(w, h) && !found; r++) {
    for (let dy = -r; dy <= r && !found; dy++) {
      for (let dx = -r; dx <= r && !found; dx++) {
        if (Math.abs(dx) === r || Math.abs(dy) === r) {
          const x = startX + dx, y = startY + dy;
          if (isContent(x, y)) {
            stack.length = 0;
            stack.push([x, y]);
            found = true;
          }
        }
      }
    }
  }

  while (stack.length > 0) {
    const [x, y] = stack.pop();
    const key = y * w + x;
    if (visited.has(key)) continue;
    if (!isContent(x, y)) continue;
    visited.add(key);
    mask[key] = 1;

    // 8-connected neighbors
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx, ny = y + dy;
        if (nx >= 0 && nx < w && ny >= 0 && ny < h && !visited.has(ny * w + nx)) {
          stack.push([nx, ny]);
        }
      }
    }
  }

  return mask;
}

async function extractFlora(src, row, col, name) {
  const left = OX + col * STRIDE;
  const top = OY + row * STRIDE;

  const { data, info } = await sharp(src)
    .extract({ left, top, width: CELL, height: CELL })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width, h = info.height, ch = info.channels;

  // Flood fill from center to find main sprite
  const mask = await floodFillMask(data, w, h, ch, w >> 1, h >> 1);

  // Apply mask - zero out non-connected pixels
  const cleaned = Buffer.from(data);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) {
        const i = (y * w + x) * ch;
        cleaned[i] = cleaned[i+1] = cleaned[i+2] = cleaned[i+3] = 0;
      }
    }
  }

  // Find bounds of remaining content
  let ct = h, cb = 0, cl = w, cr = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) {
        if (y < ct) ct = y;
        if (y > cb) cb = y;
        if (x < cl) cl = x;
        if (x > cr) cr = x;
      }
    }
  }

  if (ct > cb) {
    console.log(`${name}: EMPTY after isolation`);
    return;
  }

  const cw = cr - cl + 1;
  const ch2 = cb - ct + 1;

  // Extract the clean bounds
  await sharp(cleaned, { raw: { width: w, height: h, channels: ch } })
    .extract({ left: cl, top: ct, width: cw, height: ch2 })
    .png()
    .toFile(path.join(OUT, `${name}.png`));

  console.log(`${name}.png: ${cw}x${ch2} (cleaned)`);
}

async function main() {
  for (const { row, col, name } of FLORA) {
    await extractFlora(TREES_SRC, row, col, name);
  }
}

main().catch(console.error);
