const sharp = require('sharp');
const path = require('path');

const SRC = path.join(__dirname, 'assets/dino-assets/jurassic-tiles/Jurassic World Pixel Art Megapack', '9. Wooden tribal fences.png');
const OUT = path.join(__dirname, 'assets/dino-assets');

async function main() {
  const meta = await sharp(SRC).metadata();
  console.log(`Sheet 9: ${meta.width}x${meta.height}`);

  // Extract the top preview area (above the grid at y=222)
  await sharp(SRC)
    .extract({ left: 0, top: 0, width: meta.width, height: 220 })
    .png()
    .toFile(path.join(OUT, '_fence-preview.png'));
  console.log('Saved preview area');

  // Also check if there are additional rows below row 4
  // Row 4 ends at OY + 4*139 + 128 = 222 + 556 + 128 = 906
  if (meta.height > 910) {
    await sharp(SRC)
      .extract({ left: 0, top: 906, width: meta.width, height: Math.min(meta.height - 906, 200) })
      .png()
      .toFile(path.join(OUT, '_fence-bottom.png'));
    console.log('Saved bottom area');
  }
}

main().catch(console.error);
