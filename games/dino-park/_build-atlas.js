const sharp = require('sharp');
const path = require('path');

const SRC = path.join(__dirname, 'assets/dino-assets/jurassic-tiles/Jurassic World Pixel Art Megapack');
const OUT = path.join(__dirname, 'assets/dino-assets/park-atlas.png');

// Grid: 128×128 tiles at stride 139, origin (55, 222) in each 1536×1024 sheet
const TILE = 128, STRIDE = 139, OX = 55, OY = 222;
const tileRect = (row, col) => ({ left: OX + col * STRIDE, top: OY + row * STRIDE, width: TILE, height: TILE });

// Source sheets
const SHEETS = {
  ground: path.join(SRC, '1. Prehistoric ground tiles.png'),
  grass:  path.join(SRC, '2. Jungle grass tiles.png'),
  mud:    path.join(SRC, '3. Muddy terrain tiles.png'),
  water:  path.join(SRC, '5. Water and swamp tiles.png'),
  trees:  path.join(SRC, '7. Tropical trees and ferns.png'),
  plants: path.join(SRC, '8. Jurassic plants and mushrooms.png'),
  fence:  path.join(SRC, '9. Wooden tribal fences.png'),
  ruins:  path.join(SRC, '10. Stone ruins.png'),
  nests:  path.join(SRC, '11. Dinosaur nests and eggs.png'),
  bones:  path.join(SRC, '16. Bones and skeleton decorations.png'),
  cliffs: path.join(SRC, '17. Cliffs and rock formations.png'),
};

// Atlas layout: 8 columns × 6 rows = 48 tiles max
const ATLAS_COLS = 8, ATLAS_ROWS = 6;

// Tile definitions: [atlasRow, atlasCol, sheetKey, sheetRow, sheetCol]
const TILES = [
  // Row 0: Ground/dirt variants (inside park)
  [0, 0, 'ground', 0, 0],  // brown dirt 1
  [0, 1, 'ground', 0, 1],  // brown dirt 2
  [0, 2, 'ground', 0, 2],  // brown dirt 3
  [0, 3, 'ground', 0, 3],  // sandy dirt
  [0, 4, 'ground', 0, 7],  // dirt with grass sprouts
  [0, 5, 'ground', 0, 8],  // dirt with more grass
  [0, 6, 'ground', 1, 0],  // grey stone dirt
  [0, 7, 'ground', 1, 1],  // grey stone 2

  // Row 1: Jungle grass variants (outside park)
  [1, 0, 'grass', 0, 0],   // plain grass 1
  [1, 1, 'grass', 0, 1],   // plain grass 2
  [1, 2, 'grass', 0, 2],   // grass with rocks
  [1, 3, 'grass', 0, 3],   // grass with pebbles
  [1, 4, 'grass', 0, 6],   // darker grass
  [1, 5, 'grass', 0, 9],   // grass dirt edge
  [1, 6, 'grass', 1, 0],   // dense grass 1
  [1, 7, 'grass', 1, 1],   // dense grass 2

  // Row 2: More grass + water
  [2, 0, 'grass', 2, 0],   // fern on grass (big plant)
  [2, 1, 'grass', 2, 1],   // bush on grass
  [2, 2, 'grass', 3, 2],   // flowers 1
  [2, 3, 'grass', 3, 5],   // flowers 2
  [2, 4, 'water', 0, 0],   // clean water 1
  [2, 5, 'water', 0, 1],   // water 2
  [2, 6, 'water', 0, 4],   // water with lily pads
  [2, 7, 'water', 0, 7],   // water with waves

  // Row 3: Swamp/mud + grass variants
  [3, 0, 'water', 2, 0],   // swamp/marsh 1
  [3, 1, 'water', 2, 1],   // swamp 2
  [3, 2, 'mud', 0, 0],     // mud 1
  [3, 3, 'mud', 0, 1],     // mud 2
  [3, 4, 'grass', 4, 0],   // grass dirt mix 1
  [3, 5, 'grass', 4, 1],   // grass dirt mix 2
  [3, 6, 'grass', 4, 4],   // grass dirt mix 3
  [3, 7, 'grass', 4, 5],   // grass dirt mix 4

  // Row 4: More vegetation and mixed ground
  [4, 0, 'grass', 1, 4],   // tall grass 1
  [4, 1, 'grass', 1, 5],   // tall grass 2
  [4, 2, 'grass', 2, 4],   // large bush 1
  [4, 3, 'grass', 2, 5],   // large bush 2
  [4, 4, 'grass', 4, 2],   // jungle floor 1
  [4, 5, 'grass', 4, 3],   // jungle floor 2
  [4, 6, 'grass', 1, 8],   // grass variant 3
  [4, 7, 'grass', 1, 9],   // grass variant 4

  // Row 5: ground details
  [5, 0, 'ground', 3, 5],  // fossil in dirt
  [5, 1, 'ground', 3, 6],  // bones in dirt
  [5, 2, 'ground', 3, 7],  // bones 2
  [5, 3, 'ground', 0, 4],  // cracked earth
  [5, 4, 'ground', 0, 5],  // dry dirt
  [5, 5, 'ground', 4, 0],  // sandy 1
  [5, 6, 'ground', 4, 1],  // sandy 2
  [5, 7, 'ground', 4, 5],  // stone ground
];

async function buildAtlas() {
  console.log(`Building atlas: ${ATLAS_COLS}×${ATLAS_ROWS} = ${ATLAS_COLS * ATLAS_ROWS} tiles at ${TILE}px each`);
  console.log(`Output: ${ATLAS_COLS * TILE}×${ATLAS_ROWS * TILE}px`);

  // Create base canvas
  const width = ATLAS_COLS * TILE;
  const height = ATLAS_ROWS * TILE;

  // Load all needed sheets
  const sheetCache = {};
  const neededSheets = [...new Set(TILES.map(t => t[2]))];
  for (const key of neededSheets) {
    console.log(`  Loading ${key}...`);
    sheetCache[key] = await sharp(SHEETS[key]).raw().toBuffer({ resolveWithObject: true });
  }

  // Extract each tile and build composite inputs
  const composites = [];
  for (const [aRow, aCol, sheetKey, sRow, sCol] of TILES) {
    const rect = tileRect(sRow, sCol);
    const tileBuffer = await sharp(SHEETS[sheetKey])
      .extract(rect)
      .png()
      .toBuffer();

    composites.push({
      input: tileBuffer,
      left: aCol * TILE,
      top: aRow * TILE,
    });
  }

  // Compose atlas
  const atlas = await sharp({
    create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 255 } }
  })
    .composite(composites)
    .png({ compressionLevel: 9 })
    .toFile(OUT);

  console.log(`Atlas saved: ${OUT} (${(atlas.size / 1024).toFixed(0)}KB)`);
  console.log(`${TILES.length} tiles extracted`);
}

buildAtlas().catch(console.error);
