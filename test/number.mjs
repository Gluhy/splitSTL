// Numbering: with numberCutOnly the dimples must sit on a cut face (glued, hidden), not on the
// model's big outer wall, and their walls must be 45° so they print without support either way.
import * as THREE from 'three';
import { cutAndConnect } from '../cutter.js';

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
console.log(fails ? `${fails} FAILED` : 'numbering: all passed');
process.exit(fails ? 1 : 0);
