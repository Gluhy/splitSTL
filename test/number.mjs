// Numbering: with numberCutOnly the dimples must sit on a cut face (glued, hidden), not on the
// model's big outer wall, and their walls must be 45° so they print without support either way.
import * as THREE from 'three';
import { cutAndConnect, dotPositions } from '../cutter.js';

let fails = 0;
const chk = (ok, msg) => { if (!ok) { fails++; console.log('   FAIL ' + msg); } else console.log('   ok   ' + msg); };
const O = o => ({ build: [256, 256, 256], margin: 2, connector: 'none', pinD: 5, pinLen: 14,
                  clearance: 0.15, minWall: 1.2, spacing: 40, number: true, ...o });

// a slab whose biggest face is the outer wall (400×200) — the old picker always drilled there
const slab = () => new THREE.BoxGeometry(400, 200, 60).toNonIndexed();

// triangles of the dimples = the ones not lying on the piece's bbox faces
function dimples(g) {
  g.computeBoundingBox(); const b = g.boundingBox, p = g.attributes.position, out = [];
  const onFace = v => ['x', 'y', 'z'].some(k => Math.abs(v[k] - b.min[k]) < 1e-4 || Math.abs(v[k] - b.max[k]) < 1e-4);
  for (let i = 0; i < p.count; i += 3) {
    const t = [0, 1, 2].map(k => new THREE.Vector3().fromBufferAttribute(p, i + k));
    if (t.every(onFace) && ['x', 'y', 'z'].some(k => t.every(v => Math.abs(v[k] - t[0][k]) < 1e-4))) continue;
    const n = new THREE.Vector3().subVectors(t[1], t[0]).cross(new THREE.Vector3().subVectors(t[2], t[0]));
    if (n.lengthSq() < 1e-12) continue;
    out.push({ t, n: n.normalize() });
  }
  return out;
}

for (const cutOnly of [true, false]) {
  const pieces = (await cutAndConnect(slab(), O({ numberCutOnly: cutOnly }), new Map())).filter(p => p.name.startsWith('piece_'));
  console.log(`numberCutOnly=${cutOnly}: ${pieces.length} pieces`);
  for (const p of pieces) {
    const d = dimples(p.geometry.index ? p.geometry.toNonIndexed() : p.geometry);
    chk(d.length > 0, `${p.name}: engraved (${d.length} tris)`);
    const onCut = d.every(({ t }) => t.every(v => Math.abs(v.x) < 1.3));          // the one cut is at x=0
    if (cutOnly) chk(onCut, `${p.name}: every dimple on the cut face x=0`);
    else chk(!onCut, `${p.name}: without the option the face is not limited to the cut`);
    const bad = d.filter(({ n }) => Math.abs(Math.max(...n.toArray().map(Math.abs)) - Math.SQRT1_2) > 1e-3);
    chk(!bad.length, `${p.name}: all dimple walls at 45° (${bad.length} off)`);
  }
}
// a middle piece has two cut faces; one lies on the bed after orienting, the number goes on the other
{
  const res = await cutAndConnect(new THREE.BoxGeometry(600, 200, 60).toNonIndexed(), O({}), new Map());
  const mid = res.find(p => p.name === 'piece_1-0-0.stl');
  chk(!!mid, 'long slab: middle piece exists');
  if (mid) {
    const m = new THREE.Matrix4().fromArray(mid.orient);
    const g = mid.geometry.index ? mid.geometry.toNonIndexed() : mid.geometry.clone();
    const d = dimples(g);
    g.applyMatrix4(m); g.computeBoundingBox();
    const z0 = g.boundingBox.min.z;
    // dimple vertices in print frame: none may be within the dimple depth of the bed
    const dz = d.flatMap(({ t }) => t.map(v => v.clone().applyMatrix4(m).z - z0));
    chk(d.length > 0 && Math.min(...dz) > 0.2, `long slab: middle piece numbered off the bed face (min z ${Math.min(...dz).toFixed(2)})`);
  }
}
// --------------------------------------------------------------------------- //
// The label must never come out MIRRORED. Reading a face means looking along the drill direction,
// and planFace's `swap` transposes u and v — two independent flips of handedness. Where they used
// to agree the number was engraved as a mirror image, and a mirrored 2 is exactly a 5. Rebuild the
// dot grid the way a reader standing outside the face sees it, and demand a plain rotation of the
// layout: one of the four rotations, never one of the four reflections.
// --------------------------------------------------------------------------- //
{
  const XF = { id: p => [p[0], p[1]], rot90: p => [-p[1], p[0]], rot180: p => [-p[0], -p[1]],
               rot270: p => [p[1], -p[0]], 'mirror-x': p => [-p[0], p[1]], 'mirror-y': p => [p[0], -p[1]],
               transpose: p => [p[1], p[0]], 'anti-transpose': p => [-p[1], -p[0]] };
  const ROT = ['id', 'rot90', 'rot180', 'rot270'];
  const norm = pts => {
    const x0 = Math.min(...pts.map(p => p[0])), y0 = Math.min(...pts.map(p => p[1]));
    return new Set(pts.map(p => `${p[0] - x0},${p[1] - y0}`));
  };
  const eq = (a, b) => a.size === b.size && [...a].every(k => b.has(k));
  const axis = i => new THREE.Vector3().setComponent(i, 1);

  // which dihedral transform takes the canonical layout to what a reader sees on this piece?
  const seen = piece => {
    const g = piece.geometry.index ? piece.geometry.toNonIndexed() : piece.geometry;
    const pos = g.attributes.position; g.computeBoundingBox(); const bb = g.boundingBox;
    const onFace = (v, a) => Math.abs(v.getComponent(a) - bb.min.getComponent(a)) < 1e-4 ||
                             Math.abs(v.getComponent(a) - bb.max.getComponent(a)) < 1e-4;
    const uniq = new Map();                       // a dimple apex is the only vertex off every bbox face
    for (let i = 0; i < pos.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(pos, i);
      if ([0, 1, 2].some(a => onFace(v, a))) continue;
      uniq.set(`${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`, v);
    }
    const ap = [...uniq.values()];
    if (ap.length < 5) return null;
    // every apex sits one depth off the engraved face, so that axis is the one they agree on
    const spread = a => Math.max(...ap.map(v => v.getComponent(a))) - Math.min(...ap.map(v => v.getComponent(a)));
    const ax = [0, 1, 2].reduce((b, a) => spread(a) < spread(b) ? a : b, 0);
    const c = ap[0].getComponent(ax);
    const into = Math.abs(c - bb.min.getComponent(ax)) < Math.abs(c - bb.max.getComponent(ax)) ? 1 : -1;
    // a reader outside that face: looking against the outward normal, world +Z up
    const nOut = axis(ax).multiplyScalar(-into), fwd = nOut.clone().negate();
    const upW = Math.abs(nOut.z) > 0.9 ? axis(1) : axis(2);
    const up = upW.sub(nOut.clone().multiplyScalar(upW.dot(nOut))).normalize();
    const right = new THREE.Vector3().crossVectors(fwd, up);
    const raw = ap.map(v => [v.dot(right), v.dot(up)]);
    const x0 = Math.min(...raw.map(q => q[0])), y0 = Math.min(...raw.map(q => q[1]));
    const step = Math.min(...raw.flatMap(q => [q[0] - x0, q[1] - y0]).filter(d => d > 0.3));
    const got = norm(raw.map(q => [Math.round((q[0] - x0) / step), Math.round((q[1] - y0) / step)]));
    const want = dotPositions(piece.name.replace(/^piece_|\.stl$/g, '')).dots;
    const hit = Object.entries(XF).filter(([, f]) => eq(norm(want.map(f)), got)).map(([k]) => k);
    return { into, hit };
  };

  // the three box shapes below cover both values of `swap` and both drill directions
  for (const [tag, dims] of [['square cut face', [500, 500, 500]],
                             ['face wider than tall', [500, 120, 400]],
                             ['face taller than wide', [500, 400, 120]]]) {
    const res = await cutAndConnect(new THREE.BoxGeometry(...dims).toNonIndexed(), O({ orient: false }), new Map());
    const pieces = res.filter(p => p.name.startsWith('piece_'));
    const sides = new Set();
    for (const p of pieces) {
      const r = seen(p);
      chk(!!r && r.hit.length > 0, `${tag} ${p.name}: layout recognised`);
      if (!r || !r.hit.length) continue;
      sides.add(r.into);
      chk(r.hit.every(h => ROT.includes(h)), `${tag} ${p.name}: read as a rotation, not a mirror (${r.hit.join('/')})`);
      // the marker dot breaks the layout's own symmetry, so the reading direction is unambiguous
      chk(r.hit.length === 1, `${tag} ${p.name}: exactly one orientation fits (${r.hit.join('/')})`);
    }
    chk(sides.size === 2, `${tag}: covers faces drilled both ways (${[...sides].join(', ')})`);
  }
}

console.log(fails ? `${fails} FAILED` : 'numbering: all passed');
process.exit(fails ? 1 : 0);
