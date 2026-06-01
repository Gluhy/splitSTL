// presets.js — pole robocze popularnych drukarek (mm). Wartosci nominalne.
// CHECK: H2D zweryfikuj u siebie; reszta to typowe wartosci katalogowe.
export const PRESETS = [
  { id: 'custom',     name: 'Wlasne…',                 build: [256, 256, 256] },
  { id: 'a1mini',     name: 'Bambu Lab A1 mini',       build: [180, 180, 180] },
  { id: 'a1',         name: 'Bambu Lab A1',            build: [256, 256, 256] },
  { id: 'p1s',        name: 'Bambu Lab P1S / P1P',     build: [256, 256, 256] },
  { id: 'x1c',        name: 'Bambu Lab X1C',           build: [256, 256, 256] },
  { id: 'h2d',        name: 'Bambu Lab H2D (CHECK)',   build: [325, 320, 325] },
  { id: 'mk4',        name: 'Prusa MK4 / MK3S',        build: [250, 210, 220] },
  { id: 'mini',       name: 'Prusa MINI+',             build: [180, 180, 180] },
  { id: 'ender3',     name: 'Creality Ender 3 (V2/S1)',build: [220, 220, 250] },
  { id: 'voron350',   name: 'Voron 2.4 350',           build: [350, 350, 350] },
];
