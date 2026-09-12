const sharp = require('sharp');
const path = require('path');

const SRC = path.join(__dirname, 'assets/dino-assets/jurassic-tiles/Jurassic World Pixel Art Megapack');
const OUT = path.join(__dirname, 'assets/dino-assets/park-atlas.png');

const OX = 55, OY = 222, STRIDE = 139, CELL = 128;
const TILE = 96;      // content size per tile
const EXTRUDE = 1;    // 1px edge extrusion on each side
const CELL_OUT = TILE + EXTRUDE * 2; // 98px per atlas cell
const ATLAS_COLS = 8, ATLAS_ROWS = 6;

const SHEETS = {
  ground: path.join(SRC, '1. Prehistoric ground tiles.png'),
  grass:  path.join(SRC, '2. Jungle grass tiles.png'),
  mud:    path.join(SRC, '3. Muddy terrain tiles.png'),
  water:  path.join(SRC, '5. Water and swamp tiles.png'),
};

const TILES = [
  [0,0,'ground',0,0],[0,1,'ground',0,1],[0,2,'ground',0,2],[0,3,'ground',0,3],
  [0,4,'ground',0,7],[0,5,'ground',0,8],[0,6,'ground',1,0],[0,7,'ground',1,1],
  [1,0,'grass',0,0],[1,1,'grass',0,1],[1,2,'grass',0,2],[1,3,'grass',0,3],
  [1,4,'grass',0,6],[1,5,'grass',0,9],[1,6,'grass',1,0],[1,7,'grass',1,1],
  [2,0,'grass',2,0],[2,1,'grass',2,1],[2,2,'grass',3,2],[2,3,'grass',3,5],
  [2,4,'water',0,0],[2,5,'water',0,1],[2,6,'water',0,4],[2,7,'water',0,7],
  [3,0,'water',2,0],[3,1,'water',2,1],[3,2,'mud',0,0],[3,3,'mud',0,1],
  [3,4,'grass',4,0],[3,5,'grass',4,1],[3,6,'grass',4,4],[3,7,'grass',4,5],
  [4,0,'grass',1,4],[4,1,'grass',1,5],[4,2,'grass',2,4],[4,3,'grass',2,5],
  [4,4,'grass',4,2],[4,5,'grass',4,3],[4,6,'grass',1,8],[4,7,'grass',1,9],
  [5,0,'ground',3,5],[5,1,'ground',3,6],[5,2,'ground',3,7],[5,3,'ground',0,4],
  [5,4,'ground',0,5],[5,5,'ground',4,0],[5,6,'ground',4,1],[5,7,'ground',4,5],
];

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

async function extractAndExtrude(sheetPath, sRow, sCol) {
  const bounds = await findContentBounds(sheetPath, sRow, sCol);

  // Inset 4px on each side to remove dark pixel-art outlines
  const INSET = 4;
  const insetBounds = {
    left: bounds.left + INSET,
    top: bounds.top + INSET,
    width: Math.max(bounds.width - INSET * 2, 16),
    height: Math.max(bounds.height - INSET * 2, 16),
  };

  // Extract content (minus dark outlines) and resize to uniform TILE x TILE
  const content = await sharp(sheetPath)
    .extract(insetBounds)
    .resize(TILE, TILE, { kernel: sharp.kernel.nearest })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const w = TILE, h = TILE, ch = 4;
  const src = content.data;

  // Build extruded tile: (TILE + 2) x (TILE + 2)
  const ew = CELL_OUT, eh = CELL_OUT;
  const dst = Buffer.alloc(ew * eh * ch);

  // Copy content to center (offset by EXTRUDE)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * w + x) * ch;
      const di = ((y + EXTRUDE) * ew + (x + EXTRUDE)) * ch;
      src.copy(dst, di, si, si + ch);
    }
  }

  // Extrude top edge: duplicate row 0 into row -1
  for (let x = 0; x < w; x++) {
    const si = x * ch;
    const di = (0 * ew + (x + EXTRUDE)) * ch;
    src.copy(dst, di, si, si + ch);
  }
  // Extrude bottom edge: duplicate last row into row h
  for (let x = 0; x < w; x++) {
    const si = ((h - 1) * w + x) * ch;
    const di = ((h + EXTRUDE) * ew + (x + EXTRUDE)) * ch;
    src.copy(dst, di, si, si + ch);
  }
  // Extrude left edge: duplicate col 0 into col -1
  for (let y = 0; y < h; y++) {
    const si = (y * w) * ch;
    const di = ((y + EXTRUDE) * ew) * ch;
    src.copy(dst, di, si, si + ch);
  }
  // Extrude right edge: duplicate last col into col w
  for (let y = 0; y < h; y++) {
    const si = (y * w + (w - 1)) * ch;
    const di = ((y + EXTRUDE) * ew + (w + EXTRUDE)) * ch;
    src.copy(dst, di, si, si + ch);
  }
  // Extrude corners
  const copyCorner = (sx, sy, dx, dy) => {
    const si = (sy * w + sx) * ch;
    const di = (dy * ew + dx) * ch;
    src.copy(dst, di, si, si + ch);
  };
  copyCorner(0, 0, 0, 0);             // top-left
  copyCorner(w-1, 0, w+1, 0);         // top-right
  copyCorner(0, h-1, 0, h+1);         // bottom-left
  copyCorner(w-1, h-1, w+1, h+1);     // bottom-right

  return sharp(dst, { raw: { width: ew, height: eh, channels: ch } }).png().toBuffer();
}

async function buildAtlas() {
  console.log(`Building seamless atlas with ${EXTRUDE}px extrusion`);
  console.log(`Tile content: ${TILE}x${TILE}, Cell: ${CELL_OUT}x${CELL_OUT}`);
  console.log(`Atlas: ${ATLAS_COLS * CELL_OUT}x${ATLAS_ROWS * CELL_OUT}px\n`);

  const composites = [];

  for (const [aRow, aCol, sheetKey, sRow, sCol] of TILES) {
    const tileBuffer = await extractAndExtrude(SHEETS[sheetKey], sRow, sCol);
    composites.push({
      input: tileBuffer,
      left: aCol * CELL_OUT,
      top: aRow * CELL_OUT,
    });
    console.log(`  [${aRow},${aCol}] ${sheetKey}(${sRow},${sCol})`);
  }

  const aw = ATLAS_COLS * CELL_OUT;
  const ah = ATLAS_ROWS * CELL_OUT;

  const result = await sharp({
    create: { width: aw, height: ah, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(composites)
    .png({ compressionLevel: 9 })
    .toFile(OUT);

  console.log(`\nSaved: ${OUT} (${(result.size / 1024).toFixed(0)}KB, ${TILES.length} tiles)`);
}

buildAtlas().catch(console.error);
