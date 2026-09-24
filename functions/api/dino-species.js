/* ══════════════════════════════════════════════
   DINO SPECIES TABLE + RARITY ROLLS  (server-side)

   The one server-side source of truth for "what dinos exist, what are they
   called, and where is their sprite". Hand-synced from the client roster in
   games/dino-park/index.html (its ROSTER + ASSET_MAP), because a Pages
   Function / the Node server cannot import from the game's inline <script> —
   there is no shared module between them. Regenerate with
   server/scripts/dump-dino-species.mjs if the client roster ever changes
   (species added/removed/re-tiered, or an icon path moves).

   icon is a SITE-ABSOLUTE path under /games/dino-park/assets/dino-assets/, which is
   gitignored and shipped to the rig out of band (829 files, verified). The
   overlay renders these with an onerror fallback, so a missing sprite shows
   the PhantomACE mark rather than a broken image on stream.

   Consumed by:
     • functions/api/dino-park.js   — grantEgg / grantDino roll a species here
     • functions/api/dino-hatch.js  — the overlay hatch minigame's roll + grant
   ══════════════════════════════════════════════ */

/** id -> { name, rarity, icon }. Grouped by rarity for readability. */
export const SPECIES = {
  /* common */
  compy      : { name: "Compsognathus", rarity: "common", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/dinosaurs/compsognathus.png" },
  proto      : { name: "Protoceratops", rarity: "common", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/dinosaurs/protoceratops.png" },
  galli      : { name: "Gallimimus", rarity: "common", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/dinosaurs/gallimimus.png" },
  coelo      : { name: "Coelophysis", rarity: "common", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320-expansion160/icons/more_named_species/coelophysis.png" },
  dimetro    : { name: "Dimetrodon", rarity: "common", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/dinosaurs/dimetrodon.png" },
  iguan      : { name: "Iguanodon", rarity: "common", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/dinosaurs/iguanodon.png" },
  dimor      : { name: "Dimorphodon", rarity: "common", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320-expansion160/icons/flying_marine_reptiles/dimorphodon.png" },
  pachy      : { name: "Pachycephalosaurus", rarity: "common", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/dinosaurs/pachycephalosaurus.png" },
  kentro     : { name: "Kentrosaurus", rarity: "common", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/dinosaurs/kentrosaurus.png" },
  ovira      : { name: "Oviraptor", rarity: "common", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/dinosaurs/oviraptor.png" },
  micro      : { name: "Microraptor", rarity: "common", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/dinosaurs/microraptor.png" },
  archae     : { name: "Archaeopteryx", rarity: "common", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/dinosaurs/archaeopteryx.png" },
  dodo       : { name: "Dodo", rarity: "common", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/prehistoric_mammals/dodo_bird.png" },
  ornitho    : { name: "Ornithomimus", rarity: "common", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/dinosaurs/ornithomimus.png" },
  guanl      : { name: "Guanlong", rarity: "common", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320-expansion160/icons/more_named_species/guanlong.png" },
  hetero     : { name: "Heterodontosaurus", rarity: "common", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320-expansion160/icons/more_named_species/heterodontosaurus.png" },
  plat       : { name: "Plateosaurus", rarity: "common", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320-expansion160/icons/more_named_species/plateosaurus.png" },
  psitt      : { name: "Psittacosaurus", rarity: "common", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320-expansion160/icons/more_named_species/psittacosaurus.png" },
  sinosaur   : { name: "Sinosauropteryx", rarity: "common", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320-expansion160/icons/more_named_species/sinosauropteryx.png" },
  ptdac      : { name: "Pterodactylus", rarity: "common", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320-expansion160/icons/flying_marine_reptiles/pterodactylus.png" },
  /* uncommon */
  raptor     : { name: "Velociraptor", rarity: "uncommon", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/dinosaurs/velociraptor.png" },
  dilopho    : { name: "Dilophosaurus", rarity: "uncommon", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/dinosaurs/dilophosaurus.png" },
  stego      : { name: "Stegosaurus", rarity: "uncommon", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/dinosaurs/stegosaurus.png" },
  para       : { name: "Parasaurolophus", rarity: "uncommon", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/dinosaurs/parasaurolophus.png" },
  baryo      : { name: "Baryonyx", rarity: "uncommon", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/dinosaurs/baryonyx.png" },
  cory       : { name: "Corythosaurus", rarity: "uncommon", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/dinosaurs/corythosaurus.png" },
  styra      : { name: "Styracosaurus", rarity: "uncommon", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/dinosaurs/styracosaurus.png" },
  rhamph     : { name: "Rhamphorhynchus", rarity: "uncommon", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320-expansion160/icons/flying_marine_reptiles/rhamphorhynchus.png" },
  ichthy     : { name: "Ichthyosaurus", rarity: "uncommon", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/dinosaurs/ichthyosaur.png" },
  megalo     : { name: "Megalosaurus", rarity: "uncommon", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/dinosaurs/megalosaurus.png" },
  utah       : { name: "Utahraptor", rarity: "uncommon", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/dinosaurs/utahraptor.png" },
  deino      : { name: "Deinonychus", rarity: "uncommon", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/dinosaurs/deinonychus.png" },
  cerato     : { name: "Ceratosaurus", rarity: "uncommon", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/dinosaurs/ceratosaurus.png" },
  trood      : { name: "Troodon", rarity: "uncommon", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/dinosaurs/troodon.png" },
  concav     : { name: "Concavenator", rarity: "uncommon", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320-expansion160/icons/more_named_species/concavenator.png" },
  stygi      : { name: "Stygimoloch", rarity: "uncommon", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320-expansion160/icons/more_named_species/stygimoloch.png" },
  anhan      : { name: "Anhanguera", rarity: "uncommon", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320-expansion160/icons/flying_marine_reptiles/anhanguera.png" },
  tape       : { name: "Tapejara", rarity: "uncommon", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320-expansion160/icons/flying_marine_reptiles/tapejara.png" },
  nycto      : { name: "Nyctosaurus", rarity: "uncommon", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320-expansion160/icons/flying_marine_reptiles/nyctosaurus.png" },
  notho      : { name: "Nothosaurus", rarity: "uncommon", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320-expansion160/icons/flying_marine_reptiles/nothosaurus.png" },
  archel     : { name: "Archelon", rarity: "uncommon", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320-expansion160/icons/flying_marine_reptiles/archelon_sea_turtle.png" },
  tbird      : { name: "Terror Bird", rarity: "uncommon", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/prehistoric_mammals/terror_bird.png" },
  cbear      : { name: "Cave Bear", rarity: "uncommon", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/prehistoric_mammals/cave_bear.png" },
  dwolf      : { name: "Dire Wolf", rarity: "uncommon", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/prehistoric_mammals/prehistoric_dire_wolf.png" },
  glypto     : { name: "Glyptodon", rarity: "uncommon", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/prehistoric_mammals/glyptodon.png" },
  entelo     : { name: "Entelodont", rarity: "uncommon", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/prehistoric_mammals/entelodont.png" },
  /* rare */
  trike      : { name: "Triceratops", rarity: "rare", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/dinosaurs/triceratops.png" },
  allo       : { name: "Allosaurus", rarity: "rare", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/dinosaurs/allosaurus.png" },
  anky       : { name: "Ankylosaurus", rarity: "rare", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/dinosaurs/ankylosaurus.png" },
  diplo      : { name: "Diplodocus", rarity: "rare", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/dinosaurs/diplodocus.png" },
  carno      : { name: "Carnotaurus", rarity: "rare", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/dinosaurs/carnotaurus.png" },
  plesio     : { name: "Plesiosaurus", rarity: "rare", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/dinosaurs/plesiosaurus.png" },
  pterano    : { name: "Pteranodon", rarity: "rare", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/dinosaurs/pteranodon.png" },
  brachio    : { name: "Brachiosaurus", rarity: "rare", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/dinosaurs/brachiosaurus.png" },
  smilo      : { name: "Smilodon", rarity: "rare", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/prehistoric_mammals/smilodon.png" },
  therizo    : { name: "Therizinosaurus", rarity: "rare", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/dinosaurs/therizinosaurus.png" },
  amarg      : { name: "Amargasaurus", rarity: "rare", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320-expansion160/icons/more_named_species/amargasaurus.png" },
  cryo       : { name: "Cryolophosaurus", rarity: "rare", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320-expansion160/icons/more_named_species/cryolophosaurus.png" },
  deinoch    : { name: "Deinocheirus", rarity: "rare", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320-expansion160/icons/more_named_species/deinocheirus.png" },
  mamen      : { name: "Mamenchisaurus", rarity: "rare", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320-expansion160/icons/more_named_species/mamenchisaurus.png" },
  tylo       : { name: "Tylosaurus", rarity: "rare", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320-expansion160/icons/flying_marine_reptiles/tylosaurus.png" },
  shoni      : { name: "Shonisaurus", rarity: "rare", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320-expansion160/icons/flying_marine_reptiles/shonisaurus.png" },
  heli       : { name: "Helicoprion", rarity: "rare", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320-expansion160/icons/flying_marine_reptiles/helicoprion.png" },
  megarach   : { name: "Megarachne", rarity: "rare", icon: "/games/dino-park/assets/dino-assets/AncientBeastsPack/Megarachne-72x72.png" },
  wrhino     : { name: "Woolly Rhino", rarity: "rare", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/prehistoric_mammals/woolly_rhino.png" },
  clion      : { name: "Cave Lion", rarity: "rare", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/prehistoric_mammals/cave_lion.png" },
  gsloth     : { name: "Giant Ground Sloth", rarity: "rare", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/prehistoric_mammals/giant_ground_sloth.png" },
  masto      : { name: "Mastodon", rarity: "rare", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/prehistoric_mammals/mastodon.png" },
  /* epic */
  trex       : { name: "Tyrannosaurus Rex", rarity: "epic", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/dinosaurs/tyrannosaurus_rex.png" },
  spino      : { name: "Spinosaurus", rarity: "epic", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/dinosaurs/spinosaurus.png" },
  apato      : { name: "Apatosaurus", rarity: "epic", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/dinosaurs/apatosaurus.png" },
  gigano     : { name: "Giganotosaurus", rarity: "epic", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/dinosaurs/giganotosaurus.png" },
  mosa       : { name: "Mosasaurus", rarity: "epic", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/dinosaurs/mosasaurus.png" },
  bronto     : { name: "Brontosaurus", rarity: "epic", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/dinosaurs/brontosaurus.png" },
  mammoth    : { name: "Woolly Mammoth", rarity: "epic", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/prehistoric_mammals/woolly_mammoth.png" },
  elasmo     : { name: "Elasmosaurus", rarity: "epic", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320-expansion160/icons/flying_marine_reptiles/elasmosaurus.png" },
  hatz       : { name: "Hatzegopteryx", rarity: "epic", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320-expansion160/icons/flying_marine_reptiles/hatzegopteryx.png" },
  dunky      : { name: "Dunkleosteus", rarity: "epic", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320-expansion160/icons/flying_marine_reptiles/dunkleosteus.png" },
  krono      : { name: "Kronosaurus", rarity: "epic", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320-expansion160/icons/flying_marine_reptiles/kronosaurus.png" },
  andrew     : { name: "Andrewsarchus", rarity: "epic", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/prehistoric_mammals/andrewsarchus.png" },
  /* legendary */
  argent     : { name: "Argentinosaurus", rarity: "legendary", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/dinosaurs/long_neck_dinosaur.png" },
  megashark  : { name: "Megalodon", rarity: "legendary", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320-expansion160/icons/flying_marine_reptiles/megalodon.png" },
  quetz      : { name: "Quetzalcoatlus", rarity: "legendary", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320/icons/dinosaurs/quetzalcoatlus.png" },
  liopl      : { name: "Liopleurodon", rarity: "legendary", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320-expansion160/icons/flying_marine_reptiles/liopleurodon.png" },
  anomal     : { name: "Anomalocaris", rarity: "legendary", icon: "/games/dino-park/assets/dino-assets/jurassic-dino-320-expansion160/icons/flying_marine_reptiles/anomalocaris.png" },
};

export const RARITIES = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

/** rarity -> [speciesId, …], derived from SPECIES so the two never drift. */
export const ROSTER_BY_RARITY = (() => {
  const by = { common: [], uncommon: [], rare: [], epic: [], legendary: [] };
  for (const [id, s] of Object.entries(SPECIES)) {
    if (by[s.rarity]) by[s.rarity].push(id);
  }
  return by;
})();

/** { name, rarity, icon } for a species id, or null. */
export function speciesMeta(id) {
  return SPECIES[id] || null;
}

/** A random species id AT the given rarity (uniform within the tier). */
export function rollSpeciesId(rarity) {
  const pool = ROSTER_BY_RARITY[rarity];
  if (!pool || !pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

/* ── HATCH MINIGAME RARITY WEIGHTS ──────────────────────────────────────
   The broadcaster's stated odds, kept as the raw fractions he gave rather
   than pre-normalised percentages so the source reads exactly like the
   spec — "Common 4 out of 5, Uncommon 1 in 6, Rare 1 in 31, Epic 1 in 156,
   Legendary 1 in 385". They are treated as WEIGHTS: summed and normalised at
   roll time, so they need not add to 1. Resulting odds are roughly
   Common 79.4% · Uncommon 16.5% · Rare 3.2% · Epic 0.64% · Legendary 0.26%. */
export const HATCH_RARITY_WEIGHTS = {
  common:    4 / 5,
  uncommon:  1 / 6,
  rare:      1 / 31,
  epic:      1 / 156,
  legendary: 1 / 385,
};

/** One weighted rarity roll for the hatch minigame. */
export function rollHatchRarity() {
  const entries = Object.entries(HATCH_RARITY_WEIGHTS);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = Math.random() * total;
  for (const [rarity, w] of entries) {
    r -= w;
    if (r < 0) return rarity;
  }
  return entries[0][0];   // float dust — fall back to the first (common)
}
