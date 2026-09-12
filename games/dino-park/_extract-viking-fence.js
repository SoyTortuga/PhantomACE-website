const sharp = require('sharp');
const path = require('path');

const SRC = 'C:\\Users\\jmweb\\AppData\\Local\\Temp\\claude\\fences-temp\\7. Fences and palisades.png';
const OUT = path.join(__dirname, 'assets/dino-assets');

const OX = 55, OY = 222, STRIDE = 139, CELL = 128;

async function findContentBounds(data, info, offX, offY) {
  const w = info.width, ch = info.channels;
  const px = (x, y) => {
    const gx = x + offX, gy = y + offY;
    const i = (gy * w + gx) * ch;
    return data[i + 3] > 20 && (data[i] + data[i+1] + data[i+2]) > 40;
  };

  let t = 0, b = CELL-1, l = 0, r = CELL-1;
  outer: for (let y = 0; y < CELL; y++) { for (let x = 0; x < CELL; x++) { if (px(x,y)) { t = y; break outer; } } }
  outer: for (let y = CELL-1; y >= 0; y--) { for (let x = 0; x < CELL; x++) { if (px(x,y)) { b = y; break outer; } } }
  outer: for (let x = 0; x < CELL; x++) { for (let y = t; y <= b; y++) { if (px(x,y)) { l = x; break outer; } } }
  outer: for (let x = CELL-1; x >= 0; x--) { for (let y = t; y <= b; y++) { if (px(x,y)) { r = x; break outer; } } }

  return { t, b, l, r, w: r-l+1, h: b-t+1 };
}

async function extract() {
  const meta = await sharp(SRC).metadata();
  console.log(`Sheet: ${meta.width}x${meta.height}`);

  const { data, info } = await sharp(SRC)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Extract candidates from top row (dense palisades are at cols 5-7)
  // and bottom row (dense palisade walls)
  const candidates = [
    { row: 0, col: 5, label: 'top-r0c5' },
    { row: 0, col: 6, label: 'top-r0c6' },
    { row: 0, col: 7, label: 'top-r0c7' },
    { row: 0, col: 8, label: 'top-r0c8' },
    { row: 0, col: 9, label: 'top-r0c9' },
    { row: 4, col: 0, label: 'bot-r4c0' },
    { row: 4, col: 1, label: 'bot-r4c1' },
    { row: 4, col: 4, label: 'bot-r4c4' },
    { row: 4, col: 5, label: 'bot-r4c5' },
    { row: 4, col: 6, label: 'bot-r4c6' },
    { row: 4, col: 7, label: 'bot-r4c7' },
    { row: 4, col: 8, label: 'bot-r4c8' },
    { row: 4, col: 9, label: 'bot-r4c9' },
  ];

  for (const { row, col, label } of candidates) {
    const left = OX + col * STRIDE;
    const top = OY + row * STRIDE;
    if (left + CELL > meta.width || top + CELL > meta.height) continue;

    const bounds = await findContentBounds(data, info, left, top);
    if (bounds.w < 10 || bounds.h < 10) {
      console.log(`${label}: EMPTY`);
      continue;
    }

    const INSET = 2;
    await sharp(SRC)
      .extract({
        left: left + bounds.l + INSET,
        top: top + bounds.t + INSET,
        width: bounds.w - INSET * 2,
        height: bounds.h - INSET * 2,
      })
      .png()
      .toFile(path.join(OUT, `_vfence-${label}.png`));

    console.log(`${label}: ${bounds.w}x${bounds.h}`);
  }
}

extract().catch(console.error);
