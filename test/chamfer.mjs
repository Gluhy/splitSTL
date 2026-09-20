// Seam chamfer: the groove must sit exactly where a cut face meets the model's OUTER wall —
// nowhere else. Grooving a perpendicular cut face would open a gap inside the assembly, eating
// into the outer wall past the chamfer depth would change the model's silhouette, and chamfering
// both sides of a thin wall would meet in the middle and cut the seam clean through.
import * as THREE from 'three';
import { cutAndConnect } from '../cutter.js';

let fails = 0;
const chk = (ok, msg) => { if (!ok) { fails++; console.log('   FAIL ' + msg); } else console.log('   ok   ' + msg); };
const O = o => ({ build: [256, 256, 256], margin: 2, connector: 'none', pinD: 5, pinLen: 14,
                  clearance: 0.15, minWall: 1.2, spacing: 40, orient: false, ...o });
const W = 0.6;
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const verts = g => { const p = g.attributes.position, out = [];
  for (let i = 0; i < p.count; i++) out.push(new THREE.Vector3().fromBufferAttribute(p, i)); return out; };
const tris = g => { const p = (g.index ? g.toNonIndexed() : g).attributes.position, out = [];
  for (let i = 0; i < p.count; i += 3)
    out.push([0, 1, 2].map(k => new THREE.Vector3().fromBufferAttribute(p, i + k)));
  return out; };
function volume(g) {                                    // signed volume of the closed mesh
  let v = 0; for (const [a, b, c] of tris(g)) v += a.dot(b.clone().cross(c)) / 6;
  return Math.abs(v);
}
// area of the piece's cut face at x = 0 — the real measure of how far the chamfer ate into it.
// Vertex positions alone lie: a boolean leaves the odd degenerate sliver at a sharp corner.
function faceArea(g, keep = () => true) {
  let a = 0;
  for (const t of tris(g)) {
    if (!t.every(v => Math.abs(v.x) < 1e-4)) continue;
    const c = t[0].clone().add(t[1]).add(t[2]).multiplyScalar(1 / 3);
    if (!keep(c)) continue;
    a += new THREE.Vector3().subVectors(t[1], t[0]).cross(new THREE.Vector3().subVectors(t[2], t[0])).length() / 2;
  }
  return a;
}
const cut = async (g, o) => (await cutAndConnect(g, O(o), new Map())).filter(p => p.name.startsWith('piece_'));
const box = (x, y, z) => new THREE.BoxGeometry(x, y, z).toNonIndexed();

// ---- one cut at x = 0 through a 400 × 200 × 60 box; piece 0-0-0 is the x ∈ [-200, 0] half ----
const plain = await cut(box(400, 200, 60), {}), done = await cut(box(400, 200, 60), { chamfer: true, chamferSize: W });
chk(plain.length === 2 && done.length === 2, `2 pieces either way (${plain.length}/${done.length})`);
const p0 = done.find(p => p.name === 'piece_0-0-0.stl'), q0 = plain.find(p => p.name === 'piece_0-0-0.stl');
const v = verts(p0.geometry), inset = W;                // a full-size 45° chamfer all round

chk(p0.size.every((s, i) => near(s, q0.size[i], 1e-3)), `bbox unchanged: ${p0.size.map(x => x.toFixed(2))}`);
const per = 2 * (200 + 60);                             // perimeter of the cut face
const dv = volume(q0.geometry) - volume(p0.geometry);
chk(dv > 0.6 * per * W * W / 2 && dv < per * W * W / 2,
    `removed ${dv.toFixed(1)} mm³ — a chamfer's worth on a ${per} mm perimeter (a full cone would be ${(per * W * W / 2).toFixed(1)})`);
chk(near(faceArea(p0.geometry), (200 - 2 * inset) * (60 - 2 * inset), 1),
    `cut face inset ${inset} mm all round: ${faceArea(p0.geometry).toFixed(0)} mm² of ${faceArea(q0.geometry).toFixed(0)}`);
chk(dv > 0.97 * per * W * W / 2, 'the groove is a full 45° cone, not a stack of steps');
chk(!v.some(p => p.x > 1e-4), 'nothing pokes past the cut plane');
const wall = v.filter(p => near(Math.abs(p.y), 100, 1e-4));
chk(Math.max(...wall.map(p => p.x)) < -W * 0.5, 'the outer wall itself is untouched up to the groove');
chk(Math.min(...wall.map(p => p.x)) < -199.9, 'the far end of the wall is untouched');

// ---- cuts at x = 0 and y = 0: the seam at x = 0 must stay flat where it meets the y = 0 cut ----
{
  const g = await cut(box(400, 400, 60), { chamfer: true, chamferSize: W });
  chk(g.length === 4, `2×2 grid: ${g.length} pieces`);
  const face = verts(g.find(p => p.name === 'piece_0-0-0.stl').geometry).filter(p => Math.abs(p.x) < 1e-4);
  chk(near(Math.max(...face.map(p => p.y)), 0, 1e-3), 'the x=0 face still reaches the y=0 cut — no groove between two pieces');
  chk(near(Math.min(...face.map(p => p.y)), -200 + inset, 0.02), 'and it is still inset where that seam meets the outer wall');
}

// ---- a wall that leans away from the cut plane still gets its groove, on BOTH pieces ----
// A tapered body: the outer wall drifts sideways as it leaves the seam. A groove swept straight
// down the section outline chamfers only the piece the wall leans into and undercuts a ledge off
// the other, which is how one side of a seam ends up untouched and the ZIP full of flakes.
{
  const cone = new THREE.CylinderGeometry(10, 120, 300, 24).toNonIndexed();   // axis along y, wall at 20°
  const t = await cut(cone, { chamfer: true, chamferSize: W });
  chk(t.length === 2, `tapered body: ${t.length} pieces — no ledges shaved loose`);
  const face = g2 => {                                   // cut face at y = 0, radius 65 there
    let a = 0;
    for (const tri of tris(g2.index ? g2.toNonIndexed() : g2)) {
      if (!tri.every(v => Math.abs(v.y) < 1e-4)) continue;
      a += new THREE.Vector3().subVectors(tri[1], tri[0])
        .cross(new THREE.Vector3().subVectors(tri[2], tri[0])).length() / 2;
    }
    return a;
  };
  const lo = face(t[0].geometry), hi = face(t[1].geometry);
  const poly = 24 * Math.sin(Math.PI / 24) * Math.cos(Math.PI / 24);           // 24-gon vs circle
  chk(near(lo, hi, 0.5), `both sides chamfered the same: ${lo.toFixed(0)} vs ${hi.toFixed(0)} mm²`);
  chk(near(lo, poly * (65 - W) ** 2, 8),
      `each cut face inset the full ${W} mm from the sloped wall (${lo.toFixed(0)} of ${(poly * 65 ** 2).toFixed(0)} mm²)`);
}

// ---- a feather edge: the groove runs out to the tip instead of petering out short of it ----
// A wedge tapering to a knife edge, the way a body-kit lip blends onto the panel. There is no
// wall left to keep out there, so easing the chamfer off leaves the last few mm of the seam
// untouched — visible on the part as a corner the groove never reached.
{
  const sh = new THREE.Shape([[0, -6], [60, 0], [0, 6]].map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(sh, { depth: 400, bevelEnabled: false });
  g.translate(0, 0, -200); g.rotateY(Math.PI / 2);     // extruded along x; tip at z = -60
  const t = await cut(g, { chamfer: true, chamferSize: W });
  chk(t.length === 2, `feather edge: ${t.length} pieces`);
  const tri = [[[-6, 0], [0, -60]], [[0, -60], [6, 0]], [[6, 0], [-6, 0]]];   // section at x = 0, (y, z)
  const toEdge = (y, z) => Math.min(...tri.map(([[ay, az], [by, bz]]) => {
    const ey = by - ay, ez = bz - az, L2 = ey * ey + ez * ez;
    const u = Math.max(0, Math.min(1, ((y - ay) * ey + (z - az) * ez) / L2));
    return Math.hypot(y - ay - ey * u, z - az - ez * u);
  }));
  const face = verts(t[0].geometry).filter(p => Math.abs(p.x) < 1e-4);
  const gap = Math.min(...face.map(p => toEdge(p.y, p.z)));
  chk(gap > 0.8 * W, `the groove holds its width to the tip (closest the face comes to the wall: ${gap.toFixed(2)} of ${W} mm)`);
  chk(Math.max(...face.map(p => -p.z)) < 60 - 2 * W,
      `and the knife tip goes with it (face reaches z=-${Math.max(...face.map(p => -p.z)).toFixed(1)} of -60)`);
}

// ---- thin material keeps its seam ----
// A T profile extruded 400 mm along x: a 40 × 40 body with a 1.2 mm fin sticking out of it, and a
// 2 mm chamfer asked for. Chamfering both sides of the fin would meet in the middle and snip it
// off at the seam, so the fin has to be left alone while the body beside it is still grooved.
{
  const sh = new THREE.Shape([[-20, -20], [20, -20], [20, -0.6], [40, -0.6],
                              [40, 0.6], [20, 0.6], [20, 20], [-20, 20]].map(([x, y]) => new THREE.Vector2(x, y)));
  const g = new THREE.ExtrudeGeometry(sh, { depth: 400, bevelEnabled: false });
  g.translate(0, 0, -200); g.rotateY(Math.PI / 2);      // extruded along x; fin at z ∈ [-40, -20]
  const t = await cut(g, { chamfer: true, chamferSize: 2 });
  chk(t.length === 2, `T profile: ${t.length} pieces — the fin is not snipped off the seam`);
  const f = t.find(p => p.name === 'piece_0-0-0.stl').geometry;
  const finW = faceArea(f, c => c.z < -20) / 20;        // mean width left along the fin's 20 mm
  chk(finW > 0.3 && finW < 0.5,
      `the 1.2 mm fin keeps ${finW.toFixed(2)} mm of seam instead of the 2 mm chamfer that would sever it`);
  const body = faceArea(f, c => c.z > -20), full = (40 - 2 * 2) ** 2;
  chk(body > full && body < full + 25,
      `the thick part of the same seam takes the full 2 mm (${body.toFixed(0)} mm² vs ${full} at full size), easing off only by the fin`);
}

// ---- a wall too thin for the whole chamfer gets as much of one as it can spare ----
{
  const t = await cut(box(400, 200, 1.2), { chamfer: true, chamferSize: W });
  chk(t.length === 2, `1.2 mm plate: ${t.length} pieces`);
  const a = faceArea(t.find(p => p.name === 'piece_0-0-0.stl').geometry), left = a / (200 - 2 * 0.4);
  chk(near(left, 0.4, 0.05),
      `plate keeps ${left.toFixed(2)} mm of its 1.2 mm seam — chamfered ${((1.2 - left) / 2).toFixed(2)} mm, not the full ${W}`);
}

console.log(fails ? `chamfer: ${fails} FAILED` : 'chamfer: all passed');
process.exit(fails ? 1 : 0);
