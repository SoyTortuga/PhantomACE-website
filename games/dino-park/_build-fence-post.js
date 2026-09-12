const sharp = require('sharp');
const path = require('path');

const SRC = path.join(__dirname, 'assets/dino-assets/jurassic-tiles/Jurassic World Pixel Art Megapack', '9. Wooden tribal fences.png');
const OUT = path.join(__dirname, 'assets/dino-assets');

const OX = 55, OY = 222, STRIDE = 139, CELL = 128;

async function extractPost() {
  // r0c0 is the clean 3-post palisade fence
  const left = OX + 0 * STRIDE;
  const top = OY + 0 * STRIDE;

  // Extract the full tile
  const { data, info } = await sharp(SRC)
    .extract({ left, top, width: CELL, height: CELL })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width, h = info.height, ch = info.channels;

  // Find content bounds
  const px = (x, y) => {
    const i = (y * w + x) * ch;
    return data[i + 3] > 20 && (data[i] + data[i+1] + data[i+2]) > 40;
  };

  let ct = 0, cb = h-1, cl = 0, cr = w-1;
  outer: for (let y = 0; y < h; y++) { for (let x = 0; x < w; x++) { if (px(x,y)) { ct = y; break outer; } } }
  outer: for (let y = h-1; y >= 0; y--) { for (let x = 0; x < w; x++) { if (px(x,y)) { cb = y; break outer; } } }
  outer: for (let x = 0; x < w; x++) { for (let y = ct; y <= cb; y++) { if (px(x,y)) { cl = x; break outer; } } }
  outer: for (let x = w-1; x >= 0; x--) { for (let y = ct; y <= cb; y++) { if (px(x,y)) { cr = x; break outer; } } }

  const contentW = cr - cl + 1;
  const contentH = cb - ct + 1;
  console.log(`Full fence content: ${contentW}x${contentH} at (${cl},${ct})`);

  // The 3-post fence: posts are roughly evenly spaced
  // Extract center post (middle third with some overlap)
  const postW = Math.ceil(contentW / 3);
  const centerX = cl + Math.floor(contentW / 2) - Math.floor(postW / 2);

  console.log(`Single post: x=${centerX}, w=${postW + 4}`);

  // Extract center post with a little extra width
  const postLeft = left + centerX - 2;
  const postTop = top + ct;

  await sharp(SRC)
    .extract({ left: postLeft, top: postTop, width: postW + 4, height: contentH })
    .png()
    .toFile(path.join(OUT, 'fence-post.png'));

  console.log('Saved fence-post.png');

  // Also re-extract clean horizontal fence (r0c0) with content auto-crop
  const INSET = 3;
  await sharp(SRC)
    .extract({
      left: left + cl + INSET,
      top: top + ct + INSET,
      width: contentW - INSET * 2,
      height: contentH - INSET * 2,
    })
    .png()
    .toFile(path.join(OUT, 'fence-h.png'));

  console.log('Saved fence-h.png (clean horizontal)');

  // Also extract the X-pattern variant (r0c5) clean
  const left5 = OX + 5 * STRIDE;
  const top5 = OY + 0 * STRIDE;

  const { data: d5, info: i5 } = await sharp(SRC)
    .extract({ left: left5, top: top5, width: CELL, height: CELL })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const px5 = (x, y) => {
    const i = (y * i5.width + x) * i5.channels;
    return d5[i + 3] > 20 && (d5[i] + d5[i+1] + d5[i+2]) > 40;
  };

  let t5 = 0, b5 = CELL-1, l5 = 0, r5 = CELL-1;
  outer: for (let y = 0; y < CELL; y++) { for (let x = 0; x < CELL; x++) { if (px5(x,y)) { t5 = y; break outer; } } }
  outer: for (let y = CELL-1; y >= 0; y--) { for (let x = 0; x < CELL; x++) { if (px5(x,y)) { b5 = y; break outer; } } }
  outer: for (let x = 0; x < CELL; x++) { for (let y = t5; y <= b5; y++) { if (px5(x,y)) { l5 = x; break outer; } } }
  outer: for (let x = CELL-1; x >= 0; x--) { for (let y = t5; y <= b5; y++) { if (px5(x,y)) { r5 = x; break outer; } } }

  await sharp(SRC)
    .extract({
      left: left5 + l5 + INSET,
      top: top5 + t5 + INSET,
      width: (r5 - l5 + 1) - INSET * 2,
      height: (b5 - t5 + 1) - INSET * 2,
    })
    .png()
    .toFile(path.join(OUT, 'fence-h2.png'));

  console.log('Saved fence-h2.png (X-pattern clean)');

  // Extract gate (r0c3)
  const left3 = OX + 3 * STRIDE;
  const top3 = OY + 0 * STRIDE;

  const { data: d3, info: i3 } = await sharp(SRC)
    .extract({ left: left3, top: top3, width: CELL, height: CELL })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const px3 = (x, y) => {
    const i = (y * i3.width + x) * i3.channels;
    return d3[i + 3] > 20 && (d3[i] + d3[i+1] + d3[i+2]) > 40;
  };

  let t3 = 0, b3 = CELL-1, l3 = 0, r3 = CELL-1;
  outer: for (let y = 0; y < CELL; y++) { for (let x = 0; x < CELL; x++) { if (px3(x,y)) { t3 = y; break outer; } } }
  outer: for (let y = CELL-1; y >= 0; y--) { for (let x = 0; x < CELL; x++) { if (px3(x,y)) { b3 = y; break outer; } } }
  outer: for (let x = 0; x < CELL; x++) { for (let y = t3; y <= b3; y++) { if (px3(x,y)) { l3 = x; break outer; } } }
  outer: for (let x = CELL-1; x >= 0; x--) { for (let y = t3; y <= b3; y++) { if (px3(x,y)) { r3 = x; break outer; } } }

  await sharp(SRC)
    .extract({
      left: left3 + l3 + INSET,
      top: top3 + t3 + INSET,
      width: (r3 - l3 + 1) - INSET * 2,
      height: (b3 - t3 + 1) - INSET * 2,
    })
    .png()
    .toFile(path.join(OUT, 'fence-gate.png'));

  console.log('Saved fence-gate.png (clean)');
}

extractPost().catch(console.error);
