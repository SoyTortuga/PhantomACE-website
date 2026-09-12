const sharp = require('sharp');
const path = require('path');

const SRC = path.join(__dirname, 'assets/dino-assets/jurassic-tiles/Jurassic World Pixel Art Megapack');
const OX = 55, OY = 222, STRIDE = 139, TILE = 128;

async function analyzeTile(sheetPath, row, col, label) {
  const left = OX + col * STRIDE;
  const top = OY + row * STRIDE;

  const { data, info } = await sharp(sheetPath)
    .extract({ left, top, width: TILE, height: TILE })
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Scan each edge to find where content starts (non-black, non-transparent pixels)
  const w = info.width, h = info.height, ch = info.channels;

  function isBlackOrTransparent(x, y) {
    const i = (y * w + x) * ch;
    const r = data[i], g = data[i+1], b = data[i+2];
    const a = ch === 4 ? data[i+3] : 255;
    return (r < 10 && g < 10 && b < 10) || a < 10;
  }

  // Find content bounds from each edge
  let topBorder = 0, bottomBorder = 0, leftBorder = 0, rightBorder = 0;

  // Top: scan rows from top until we find non-black content
  for (let y = 0; y < h; y++) {
    let allBlack = true;
    for (let x = 0; x < w; x++) {
      if (!isBlackOrTransparent(x, y)) { allBlack = false; break; }
    }
    if (allBlack) topBorder++;
    else break;
  }

  // Bottom
  for (let y = h - 1; y >= 0; y--) {
    let allBlack = true;
    for (let x = 0; x < w; x++) {
      if (!isBlackOrTransparent(x, y)) { allBlack = false; break; }
    }
    if (allBlack) bottomBorder++;
    else break;
  }

  // Left
  for (let x = 0; x < w; x++) {
    let allBlack = true;
    for (let y = 0; y < h; y++) {
      if (!isBlackOrTransparent(x, y)) { allBlack = false; break; }
    }
    if (allBlack) leftBorder++;
    else break;
  }

  // Right
  for (let x = w - 1; x >= 0; x--) {
    let allBlack = true;
    for (let y = 0; y < h; y++) {
      if (!isBlackOrTransparent(x, y)) { allBlack = false; break; }
    }
    if (allBlack) rightBorder++;
    else break;
  }

  // Sample the border pixels at row 0 to check alpha
  const borderPixels = [];
  for (let x = 0; x < Math.min(15, w); x++) {
    const i = x * ch;
    borderPixels.push({ x, r: data[i], g: data[i+1], b: data[i+2], a: ch === 4 ? data[i+3] : 255 });
  }

  console.log(`${label}: borders T=${topBorder} B=${bottomBorder} L=${leftBorder} R=${rightBorder} | content=${w - leftBorder - rightBorder}x${h - topBorder - bottomBorder}`);
  console.log(`  Top-left corner pixels:`, borderPixels.slice(0, 5).map(p => `(${p.r},${p.g},${p.b},${p.a})`).join(' '));

  return { topBorder, bottomBorder, leftBorder, rightBorder };
}

async function main() {
  const sheets = {
    ground: path.join(SRC, '1. Prehistoric ground tiles.png'),
    grass: path.join(SRC, '2. Jungle grass tiles.png'),
    water: path.join(SRC, '5. Water and swamp tiles.png'),
  };

  console.log('=== GROUND SHEET ===');
  await analyzeTile(sheets.ground, 0, 0, 'Ground r0c0');
  await analyzeTile(sheets.ground, 0, 1, 'Ground r0c1');
  await analyzeTile(sheets.ground, 0, 3, 'Ground r0c3');
  await analyzeTile(sheets.ground, 0, 7, 'Ground r0c7');

  console.log('\n=== GRASS SHEET ===');
  await analyzeTile(sheets.grass, 0, 0, 'Grass r0c0');
  await analyzeTile(sheets.grass, 0, 1, 'Grass r0c1');

  console.log('\n=== WATER SHEET ===');
  await analyzeTile(sheets.water, 0, 0, 'Water r0c0');
  await analyzeTile(sheets.water, 0, 1, 'Water r0c1');

  // Also check the GAP between tiles - what's in the 11px between content areas
  console.log('\n=== GAP ANALYSIS (between r0c0 and r0c1 on ground sheet) ===');
  const gapLeft = OX + 0 * STRIDE + TILE; // end of tile 0
  const gapRight = OX + 1 * STRIDE;       // start of tile 1
  console.log(`Gap between tiles: x=${gapLeft} to x=${gapRight} (${gapRight - gapLeft}px)`);

  const { data: gapData, info: gapInfo } = await sharp(sheets.ground)
    .extract({ left: gapLeft - 2, top: OY + 50, width: gapRight - gapLeft + 4, height: 1 })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const gapPixels = [];
  for (let x = 0; x < gapInfo.width; x++) {
    const i = x * gapInfo.channels;
    gapPixels.push(`(${gapData[i]},${gapData[i+1]},${gapData[i+2]})`);
  }
  console.log(`Gap pixels at y=50:`, gapPixels.join(' '));
}

main().catch(console.error);
