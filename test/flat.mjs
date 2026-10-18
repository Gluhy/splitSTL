// Lay flat: whatever way round a model comes in, it should end up as low as it goes, on its
// biggest flat and with its long side along X — on a small mesh (every point in the hull) and
// on one big enough to take the thinned path.
import * as THREE from 'three';
import { flattestRotation } from '../cutter.js';

let fails = 0;
const chk = (ok, msg) => { if (!ok) { fails++; console.log('   FAIL ' + msg); } else console.log('   ok   ' + msg); };
const size = g => { g.computeBoundingBox(); return g.boundingBox.getSize(new THREE.Vector3()).toArray(); };
const fmt = s => s.map(v => v.toFixed(2)).join(' × ');
const flat = g => { const f = g.clone().applyQuaternion(new THREE.Quaternion(...flattestRotation(g))); f.center(); return f; };
const tilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.7, -1.1, 0.4));

// a slab turned at an odd angle comes back to 100 × 40 × 10
const slab = new THREE.BoxGeometry(100, 40, 10).toNonIndexed().applyQuaternion(tilt);
let s = size(flat(slab));
chk(Math.abs(s[0] - 100) < 0.01 && Math.abs(s[1] - 40) < 0.01 && Math.abs(s[2] - 10) < 0.01, `turned slab lies flat, long side on X (${fmt(s)})`);

// an L lies with the whole L on the bed (30 mm), not standing on one leg (70)
const L = new THREE.BoxGeometry(80, 10, 30);
const leg = new THREE.BoxGeometry(10, 60, 30).translate(-35, 35, 0);
const Lgeo = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(
  [...L.toNonIndexed().attributes.position.array, ...leg.toNonIndexed().attributes.position.array], 3)).applyQuaternion(tilt);
s = size(flat(Lgeo));
chk(Math.abs(s[2] - 30) < 0.01, `turned L lies on its side (${fmt(s)})`);

// a dense sphere-capped slab: over the thinned-hull threshold, still within 2 % of its 12 mm
const dense = new THREE.CapsuleGeometry(6, 80, 64, 256).toNonIndexed();   // ~400k vertices
dense.applyQuaternion(tilt);
s = size(flat(dense));
chk(dense.attributes.position.count > 200000 && s[2] < 12 * 1.02 && Math.abs(s[0] - 92) < 0.5,
    `dense capsule (${dense.attributes.position.count} verts) lies down (${fmt(s)})`);

console.log(fails ? `\n${fails} FAILED` : '\nall ok');
process.exit(fails ? 1 : 0);
