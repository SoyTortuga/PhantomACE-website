const sharp = require('sharp');
const path = require('path');

const SRC = 'C:\\Users\\jmweb\\AppData\\Local\\Temp\\claude\\fences-temp\\7. Fences and palisades.png';
const OUT = path.join(__dirname, 'assets/dino-assets');
const OX = 55, OY = 222, STRIDE = 139, CELL = 128;

async function autoExtract(row, col, inset) {
  const left = OX + col * STRIDE;
  const top = OY + row * STRIDE;

  const { data, info } = await sharp(SRC)
    .extract({ left, top, width: CELL, height: CELL })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = info.width, h = info.height, ch = info.channels;
  const px = (x, y) => {
    const i = (y * w + x) * ch;
    return data[i + 3] > 20 && (data[i] + data[i+1] + data[i+2]) > 40;
  };

  let ct = 0, cb = h-1, cl = 0, cr = w-1;
  outer: for (let y = 0; y < h; y++) { for (let x = 0; x < w; x++) { if (px(x,y)) { ct = y; break outer; } } }
  outer: for (let y = h-1; y >= 0; y--) { for (let x = 0; x < w; x++) { if (px(x,y)) { cb = y; break outer; } } }
  outer: for (let x = 0; x < w; x++) { for (let y = ct; y <= cb; y++) { if (px(x,y)) { cl = x; break outer; } } }
  outer: for (let x = w-1; x >= 0; x--) { for (let y = ct; y <= cb; y++) { if (px(x,y)) { cr = x; break outer; } } }

  const I = inset || 2;
  return {
    left: left + cl + I,
    top: top + ct + I,
    width: (cr - cl + 1) - I * 2,
    height: (cb - ct + 1) - I * 2,
  };
}

async function main() {
  // 1. fence-h.png: r0c8 dense palisade (main horizontal)
  const boundsH = await autoExtract(0, 8);
  await sharp(SRC).extract(boundsH).png().toFile(path.join(OUT, 'fence-h.png'));
  console.log(`fence-h.png: ${boundsH.width}x${boundsH.height}`);

  // 2. fence-h2.png: r0c9 variant palisade (alternate)
  const boundsH2 = await autoExtract(0, 9);
  await sharp(SRC).extract(boundsH2).png().toFile(path.join(OUT, 'fence-h2.png'));
  console.log(`fence-h2.png: ${boundsH2.width}x${boundsH2.height}`);

  // 3. fence-gate.png: r0c6 (gap in middle for gate)
  const boundsG = await autoExtract(0, 6);
  await sharp(SRC).extract(boundsG).png().toFile(path.join(OUT, 'fence-gate.png'));
  console.log(`fence-gate.png: ${boundsG.width}x${boundsG.height}`);

  // 4. fence-post.png: extract a single center post from r0c8
  // r0c8 is ~115x97 after trim, has about 6 posts
  // A single post is about 1/6 of the width
  const { data, info } = await sharp(SRC)
    .extract({ left: boundsH.left, top: boundsH.top, width: boundsH.width, height: boundsH.height })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = boundsH.width, h = boundsH.height, ch = info.channels;

  // Find vertical gaps between posts by scanning columns for transparency
  const colAlpha = [];
  for (let x = 0; x < w; x++) {
    let total = 0;
    for (let y = 0; y < h; y++) {
      total += data[(y * w + x) * ch + 3];
    }
    colAlpha.push(total / h);
  }

  // Find post boundaries: look for columns with high alpha (post) vs low alpha (gap)
  const threshold = 128;
  const posts = [];
  let inPost = false, postStart = 0;
  for (let x = 0; x < w; x++) {
    if (!inPost && colAlpha[x] > threshold) {
      inPost = true;
      postStart = x;
    } else if (inPost && (colAlpha[x] <= threshold || x === w - 1)) {
      inPost = false;
      const postEnd = x === w - 1 && colAlpha[x] > threshold ? x : x - 1;
      const pw = postEnd - postStart + 1;
      if (pw > 5) posts.push({ start: postStart, end: postEnd, width: pw });
    }
  }

  console.log(`Found ${posts.length} posts:`, posts.map(p => `${p.start}-${p.end}(${p.width}px)`).join(', '));

  // Extract the 2nd or 3rd post (center-ish, most complete)
  const pick = posts.length >= 3 ? posts[2] : posts[Math.floor(posts.length / 2)];
  const postPad = 2;

  await sharp(SRC)
    .extract({
      left: boundsH.left + pick.start - postPad,
      top: boundsH.top,
      width: pick.width + postPad * 2,
      height: boundsH.height,
    })
    .png()
    .toFile(path.join(OUT, 'fence-post.png'));

  console.log(`fence-post.png: single post ${pick.width + postPad * 2}x${boundsH.height}`);
}

main().catch(console.error);
