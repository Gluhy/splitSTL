// presets.js — build volumes of common printers (mm), as X / Y / Z.
// Catalog figures. Revisions and firmware limits differ, and a textured plate or a bed clip
// eats a few mm — check yours, and leave the Margin setting some room.
export const PRESETS = [
  { id: 'custom',      brand: '',           name: 'Custom…',              build: [256, 256, 256] },

  { id: 'a1mini',      brand: 'Bambu Lab',  name: 'A1 mini',              build: [180, 180, 180] },
  { id: 'a1',          brand: 'Bambu Lab',  name: 'A1',                   build: [256, 256, 256] },
  { id: 'p1s',         brand: 'Bambu Lab',  name: 'P1P / P1S',            build: [256, 256, 256] },
  { id: 'x1c',         brand: 'Bambu Lab',  name: 'X1 / X1C / X1E',       build: [256, 256, 256] },
  { id: 'h2d',         brand: 'Bambu Lab',  name: 'H2D',                  build: [325, 320, 325] },

  { id: 'mini',        brand: 'Prusa',      name: 'MINI / MINI+',         build: [180, 180, 180] },
  { id: 'mk4',         brand: 'Prusa',      name: 'MK3S+ / MK4 / MK4S',   build: [250, 210, 220] },
  { id: 'coreone',     brand: 'Prusa',      name: 'CORE One',             build: [250, 220, 270] },
  { id: 'xl',          brand: 'Prusa',      name: 'XL',                   build: [360, 360, 360] },

  { id: 'ender3',      brand: 'Creality',   name: 'Ender 3 (V2/S1/V3)',   build: [220, 220, 250] },
  { id: 'ender5plus',  brand: 'Creality',   name: 'Ender 5 Plus',         build: [350, 350, 400] },
  { id: 'cr10',        brand: 'Creality',   name: 'CR-10 / CR-10S',       build: [300, 300, 400] },
  { id: 'k1',          brand: 'Creality',   name: 'K1 / K1C',             build: [220, 220, 250] },
  { id: 'k1max',       brand: 'Creality',   name: 'K1 Max',               build: [300, 300, 300] },
  { id: 'k2plus',      brand: 'Creality',   name: 'K2 Plus',              build: [350, 350, 350] },

  { id: 'neptune4',    brand: 'Elegoo',     name: 'Neptune 4',            build: [225, 225, 265] },
  { id: 'neptune4plus',brand: 'Elegoo',     name: 'Neptune 4 Plus',       build: [320, 320, 385] },
  { id: 'neptune4max', brand: 'Elegoo',     name: 'Neptune 4 Max',        build: [420, 420, 480] },
  { id: 'centauri',    brand: 'Elegoo',     name: 'Centauri Carbon',      build: [256, 256, 256] },

  { id: 'kobra2',      brand: 'Anycubic',   name: 'Kobra 2',              build: [220, 220, 250] },
  { id: 'kobra3',      brand: 'Anycubic',   name: 'Kobra 3',              build: [250, 250, 260] },
  { id: 'kobra2max',   brand: 'Anycubic',   name: 'Kobra 2 Max',          build: [420, 420, 500] },

  { id: 'sv06',        brand: 'Sovol',      name: 'SV06',                 build: [220, 220, 250] },
  { id: 'sv06plus',    brand: 'Sovol',      name: 'SV06 Plus',            build: [300, 300, 340] },
  { id: 'sv08',        brand: 'Sovol',      name: 'SV08',                 build: [350, 350, 345] },

  { id: 'q1pro',       brand: 'Qidi',       name: 'Q1 Pro',               build: [245, 245, 245] },
  { id: 'xplus3',      brand: 'Qidi',       name: 'X-Plus 3',             build: [280, 280, 270] },
  { id: 'plus4',       brand: 'Qidi',       name: 'Plus4',                build: [305, 305, 280] },

  { id: 'voron0',      brand: 'Voron',      name: 'V0.2',                 build: [120, 120, 120] },
  { id: 'voron250',    brand: 'Voron',      name: '2.4 / Trident 250',    build: [250, 250, 250] },
  { id: 'voron300',    brand: 'Voron',      name: '2.4 / Trident 300',    build: [300, 300, 300] },
  { id: 'voron350',    brand: 'Voron',      name: '2.4 / Trident 350',    build: [350, 350, 350] },

  { id: 'ums3',        brand: 'Ultimaker',  name: 'S3',                   build: [230, 190, 200] },
  { id: 'ums5',        brand: 'Ultimaker',  name: 'S5',                   build: [330, 240, 300] },
];
