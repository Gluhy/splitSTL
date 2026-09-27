// Tongue and groove: the rib on one piece has to go into the groove on the other with the
// clearance all round — overlapping, it would not assemble; loose, it would not align — and the
// groove has to keep `minWall` of material outside it, or it breaks through the model's wall.
import * as THREE from 'three';
import ManifoldModule from 'manifold-3d';
import { cutAndConnect } from '../cutter.js';

let fails = 0;
const chk = (ok, msg) => { if (!ok) { fails++; console.log('   FAIL ' + msg); } else console.log('   ok   ' + msg); };
const O = o => ({ build: [256, 256, 256], margin: 2, connector: 'tongue', pinD: 5, pinLen: 14,
                  clearance: 0.15, minWall: 1.2, spacing: 40, orient: false, tongueW: 4, tongueH: 3, ...o });
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const wasm = await ManifoldModule(); wasm.setup();
const { Manifold, Mesh } = wasm;
const toM = g => {
  const pos = g.attributes.position.array;
  return new Manifold(new Mesh({ numProp: 3, vertProperties: Float32Array.from(pos),
                                 triVerts: Uint32Array.from(g.index ? g.index.array : pos.map((_, i) => i).slice(0, pos.length / 3)) }));
};
const toG = m => {
  const mesh = m.getMesh(), g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(mesh.vertProperties.slice(), 3));
  g.setIndex(new THREE.BufferAttribute(mesh.triVerts.slice(), 1));
  return g;
};
const verts = g => { const p = g.attributes.position, out = [];
  for (let i = 0; i < p.count; i++) out.push(new THREE.Vector3().fromBufferAttribute(p, i)); return out; };
const logs = [];
const cut = async (g, o) => (await cutAndConnect(g, O(o), new Map(), (k, p) => logs.push([k, p])))
  .filter(p => p.name.startsWith('piece_'));
const piece = (ps, n) => ps.find(p => p.name === `piece_${n}.stl`);
const box = (x, y, z) => new THREE.BoxGeometry(x, y, z).toNonIndexed();
// a square tube along x, `wall` thick, open at both ends
const tube = (len, side, wall) => {
  const o = Manifold.cube([len, side, side], true), i = Manifold.cube([len + 2, side - 2 * wall, side - 2 * wall], true);
  const t = o.subtract(i); o.delete(); i.delete(); const g = toG(t); t.delete(); return g;
};

// ---- one cut at x = 0 through a solid 400 × 200 × 60 box ----
{
  const ps = await cut(box(400, 200, 60), {});
  chk(ps.length === 2, `2 pieces (${ps.length})`);
  const a = piece(ps, '0-0-0'), b = piece(ps, '1-0-0');
  const va = verts(a.geometry), vb = verts(b.geometry);
  const out = va.filter(p => p.x > 1e-3);
  chk(out.length > 0 && near(Math.max(...out.map(p => p.x)), 3, 0.05), `the rib stands ${Math.max(...out.map(p => p.x)).toFixed(2)} mm proud of the low piece`);
  chk(!vb.some(p => p.x < -1e-3), 'nothing of the high piece reaches past the seam');
  // the groove sits back from the wall by minWall + clearance, at least
  const gv = vb.filter(p => p.x > 1e-3 && p.x < 3.5 && Math.abs(p.y) < 99.9 && Math.abs(p.z) < 29.9);
  const inset = Math.min(...gv.map(p => Math.min(100 - Math.abs(p.y), 30 - Math.abs(p.z))));
  chk(gv.length > 0 && inset >= 1.2 + 0.15 - 1e-3, `groove keeps ${inset.toFixed(2)} mm of wall`);
  const groove = vb.filter(p => p.x > 1e-3 && p.x < 10 && Math.abs(p.y) < 99.9 && Math.abs(p.z) < 29.9);
  chk(near(Math.max(...groove.map(p => p.x)), 3.5, 0.05), `the groove is ${Math.max(...groove.map(p => p.x)).toFixed(2)} mm deep — the rib does not bottom out`);
  const ma = toM(a.geometry), mb = toM(b.geometry), both = ma.intersect(mb);
  chk(both.isEmpty() || both.volume() < 1e-3, `rib and groove do not overlap (${both.isEmpty() ? 0 : both.volume().toFixed(4)} mm³)`);
  // grown by a hair under the clearance, the rib still misses the groove walls; grown past it, it hits
  // Only the rib is grown: grown whole, the piece's own seam face would run straight into the
  // other piece. Its foot starts a hair above the face for the same reason.
  const rib = ma.trimByPlane([1, 0, 0], 0.01);
  const hit = d => { const s = Manifold.cube([2 * d, 2 * d, 2 * d], true), g = rib.minkowskiSum(s); s.delete();
                     const r = g.intersect(mb), v = r.isEmpty() ? 0 : r.volume(); g.delete(); r.delete(); return v; };
  chk(hit(0.08) < 1e-3, 'clearance is really there: rib grown by 0.08 mm still clears the groove');
  chk(hit(0.3) > 1, 'and the fit is snug: grown by 0.3 mm it hits the groove');
  chk(logs.some(([k, p]) => k === 'log.tongue' && p.n === 1 && p.total === 1), 'logged 1 of 1 seams');
  both.delete(); rib.delete(); ma.delete(); mb.delete();
}

// ---- a 6 mm tube wall: too thin for a dowel, just right for one rib down the middle ----
{
  logs.length = 0;
  const ps = await cut(tube(400, 60, 6), {});
  const a = piece(ps, '0-0-0'), b = piece(ps, '1-0-0');
  // what of a piece is at x = `at`, across the side wall at z = 0: [from, to] in from the outside.
  // A straight rib has no vertices mid-wall to read, so it is sliced and cut down to a strip.
  const across = (g, at) => {
    const m = toM(g), r = m.rotate([0, 90, 0]), cs = r.slice(-at); m.delete(); r.delete();   // x -> -z
    const strip = wasm.CrossSection.square([0.1, 11]).translate([-0.05, 20]);
    const s2 = cs.intersect(strip); cs.delete(); strip.delete();
    if (s2.isEmpty()) { s2.delete(); return null; }
    const bb = s2.bounds(); s2.delete();
    return [30 - (bb.max[1] ?? bb.max.y), 30 - (bb.min[1] ?? bb.min.y)];
  };
  const rib = across(a.geometry, 0.5);
  chk(!!rib, 'a 6 mm wall still gets a rib');
  chk(rib && rib[0] > 1.2 && rib[1] < 6 - 1.2, `the rib stays inside the wall (${rib?.map(v => v.toFixed(2)).join('–')} mm in from the outside)`);
  chk(rib && near(rib[0] + rib[1], 6, 0.05), 'and runs down the middle of it');
  // the high piece at the groove's mouth: wall, gap, wall — the gap is the groove
  const m = toM(b.geometry), r = m.rotate([0, 90, 0]), cs = r.slice(-0.5); m.delete(); r.delete();
  const strip = wasm.CrossSection.square([0.1, 11]).translate([-0.05, 20]), s2 = cs.intersect(strip); cs.delete(); strip.delete();
  const walls = s2.toPolygons().map(pl => pl.map(q => 30 - (q[1] ?? q.y))).map(ys => [Math.min(...ys), Math.max(...ys)]); s2.delete();
  walls.sort((x, y) => x[0] - y[0]);
  chk(walls.length === 2 && walls[0][1] - walls[0][0] >= 1.2 - 1e-3 && walls[1][1] - walls[1][0] >= 1.2 - 1e-3,
      `the groove leaves min. wall both sides (${walls.map(w => (w[1] - w[0]).toFixed(2)).join(' / ')} mm)`);
}

// ---- a 4.3 mm wall (a body panel) is too narrow for a full-size rib: it gets a lower one, sized to
// the wall, rather than none at all ----
{
  logs.length = 0;
  const ps = await cut(tube(400, 60, 4.3), {});
  // read mid-wall: at the tube's corners the wall is wider on the diagonal and the rib full height
  const at = x => { const m = toM(piece(ps, '0-0-0').geometry), r = m.rotate([0, 90, 0]), cs = r.slice(-x); m.delete(); r.delete();
                    const strip = wasm.CrossSection.square([0.1, 11]).translate([-0.05, 20]), s2 = cs.intersect(strip);
                    const any = !s2.isEmpty(); cs.delete(); strip.delete(); s2.delete(); return any; };
  let top = 0; for (let x = 0.1; x < 3.2; x += 0.1) if (at(x)) top = x;
  chk(top > 1 && top < 2.9, `a 4.3 mm wall gets a rib ~${top.toFixed(1)} mm high — lower, not missing`);
  chk(logs.some(([k, p]) => k === 'log.tongue' && p.n === 1), 'logged 1 seam');
}

// ---- the rib stands proud of its piece: the cuts are spaced so that piece still fits the bed ----
{
  const ps = await cut(box(500, 100, 60), { build: [254, 256, 256], margin: 2 });   // 250 usable: 2 pieces would be exactly full
  chk(ps.length === 3, `a 500 mm box on 250 mm of bed takes 3 pieces once a 3 mm rib is allowed for (${ps.length})`);
  chk(ps.every(p => p.fits), `every piece fits: ${ps.map(p => p.size[0].toFixed(1)).join(', ')} mm`);
}

// ---- a 3 mm wall has no room for a groove: a flat glue joint, not a rib that breaks through ----
{
  logs.length = 0;
  const ps = await cut(tube(400, 60, 3), {});
  chk(!verts(piece(ps, '0-0-0').geometry).some(p => p.x > 1e-3), '3 mm wall: no rib');
  chk(logs.some(([k, p]) => k === 'log.tongue' && p.n === 0), 'logged 0 seams');
}

// ---- cuts at x = 0 and y = 0: the x rib keeps clear of the y seam, so the joints never meet ----
{
  logs.length = 0;
  const ps = await cut(box(400, 400, 60), { build: [256, 256, 256] });
  chk(ps.length === 4, `4 pieces (${ps.length})`);
  const keep = 3 + 0.5 + 1.2;
  for (const p of ps) {
    const v = verts(p.geometry);
    // whatever of the piece is past the x = 0 seam is its rib, whichever side the rib went on
    const past = p.name.startsWith('piece_0') ? q => q.x > 1e-3 : q => q.x < -1e-3;
    const xr = v.filter(q => past(q) && Math.abs(q.x) < 3.4);
    // the rib's end is a 45° ramp: `keep` off the y seam at the cut face, 1 mm more per mm up
    const worst = Math.min(Infinity, ...xr.map(q => Math.abs(q.y) - keep - Math.abs(q.x)));
    chk(worst > -1e-3, `${p.name}: rib ends on a 45° ramp, ${keep} mm off the y seam at the face`);
    const tip = xr.filter(q => Math.abs(q.x) > 2.9);
    chk(!xr.length || (tip.length && Math.min(...tip.map(q => Math.abs(q.y))) > keep + 2.8), `${p.name}: and the rib's top ends ~3 mm further back than its foot`);
  }
  chk(logs.some(([k, p]) => k === 'log.tongue' && p.n === 2 && p.total === 2), 'both seams got a rib');
}

// ---- standing each piece on its cut face must never put the rib on the bed ----
{
  const ps = await cut(box(400, 200, 60), { orient: true });
  const a = piece(ps, '0-0-0');
  chk(!a.orient, 'the low piece has only its ribbed face to stand on, so it is left as it lies');
  chk(!!piece(ps, '1-0-0').orient, 'the high piece stands on its grooved face');
}

// ---- a 2 × 2 grid: with every rib on the low piece, the corner piece would get ribs on both its
// cut faces and nothing flat to print on. Four seams for four pieces — each gets a groove ----
{
  logs.length = 0;
  const ps = await cut(box(400, 400, 60), { orient: true });
  chk(ps.length === 4 && ps.every(p => p.orient), `every piece of a 2 × 2 grid stands on a groove face (${ps.filter(p => p.orient).length}/${ps.length})`);
  chk(!logs.some(([k]) => k === 'log.noBedFace'), 'and none is reported without one');
  const ms = ps.map(p => toM(p.geometry));
  let worst = 0;
  for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < ms.length; j++) {
    const x = ms[i].intersect(ms[j]); worst = Math.max(worst, x.isEmpty() ? 0 : x.volume()); x.delete(); }
  chk(worst < 1e-3, `ribs turned either way still clear their grooves (${worst.toFixed(4)} mm³)`);
  ms.forEach(m => m.delete());
}

// ---- the number on the ribbed face goes beside the rib, never under it: a dimple the rib sits on
// is sealed in, a hollow in the print instead of a number on it ----
{
  // a face just big enough that the label would otherwise land across the rib
  const ps = await cut(box(400, 40, 30), { number: true, numberCutOnly: true });
  const v = verts(piece(ps, '0-0-0').geometry);
  const inset = p => Math.min(20 - Math.abs(p.y), 15 - Math.abs(p.z));
  const ribIn = Math.max(...v.filter(p => p.x > 0.01).map(inset));          // the rib's inner outline
  const dots = v.filter(p => p.x < -0.01 && p.x > -1.3);
  chk(dots.length > 0, `the ribbed face is numbered (${dots.length} verts)`);
  chk(dots.every(p => inset(p) > ribIn), `every dimple is inside the rib (${Math.min(...dots.map(inset)).toFixed(2)} > ${ribIn.toFixed(2)} mm from the edge)`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall ok');
process.exit(fails ? 1 : 0);
