const sharp = require('sharp');
const path = require('path');

const SRC = path.join(__dirname, 'assets/dino-assets/jurassic-tiles/Jurassic World Pixel Art Megapack', '9. Wooden tribal fences.png');
const OUT = path.join(__dirname, 'assets/dino-assets');

const OX = 55, OY = 222, STRIDE = 139, CELL = 128;

async function findContentBounds(sheetPath, sRow, sCol) {
  const left = OX + sCol * STRIDE;
  const top = OY + sRow * STRIDE;
  const { data, info } = await sharp(sheetPath)
    .extract({ left, top, width: CELL, height: CELL })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width, h = info.height, ch = info.channels;
  const px = (x, y) => {
    const i = (y * w + x) * ch;
    return data[i + 3] > 20 && (data[i] + data[i+1] + data[i+2]) > 40;
  };

  let t = 0, b = h - 1, l = 0, r = w - 1;
  outer: for (let y = 0; y < h; y++) { for (let x = 0; x < w; x++) { if (px(x,y)) { t = y; break outer; } } }
  outer: for (let y = h-1; y >= 0; y--) { for (let x = 0; x < w; x++) { if (px(x,y)) { b = y; break outer; } } }
  outer: for (let x = 0; x < w; x++) { for (let y = t; y <= b; y++) { if (px(x,y)) { l = x; break outer; } } }
  outer: for (let x = w-1; x >= 0; x--) { for (let y = t; y <= b; y++) { if (px(x,y)) { r = x; break outer; } } }

  return { left: left + l, top: top + t, width: r - l + 1, height: b - t + 1 };
}

async function extract() {
  // Extract fence candidates from sheet 9 - check multiple rows/cols
  // Row 0: main fence variants
  // Row 1-4: may have vertical posts, corners, etc.
  const candidates = [];
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 8; col++) {
      candidates.push({ row, col });
    }
  }

  for (const { row, col } of candidates) {
    try {
      const bounds = await findContentBounds(SRC, row, col);
      if (bounds.width < 5 || bounds.height < 5) continue; // skip empty

      const INSET = 3;
      const insetBounds = {
        left: bounds.left + INSET,
        top: bounds.top + INSET,
        width: Math.max(bounds.width - INSET * 2, 8),
        height: Math.max(bounds.height - INSET * 2, 8),
      };

      await sharp(SRC)
        .extract(insetBounds)
        .png()
        .toFile(path.join(OUT, `_fence-r${row}c${col}.png`));
      console.log(`r${row}c${col}: ${insetBounds.width}x${insetBounds.height}`);
    } catch (e) {
      // Skip tiles that fail
    }
  }
}

extract().catch(console.error);
