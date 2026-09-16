import * as THREE from 'three';
import { planCuts, cutAndConnect } from '../cutter.js';
const NI = g => g.index ? g.toNonIndexed() : g;
const O = (o={}) => ({ build:[256,256,256], margin:2, connector:'auto', pinD:5, pinLen:14,
                       clearance:0.15, minWall:1.2, spacing:40, number:false, ...o });
// A thin wall swept along a curve — how a real body panel is built, and the shape that breaks a
// naive sign test. Its quads are non-planar, so a quad's two triangles have clearly different
// normals and slivers appear; the closest point then lands on a shared EDGE, where one
// triangle's own normal is meaningless. The field ends up claiming "inside material" over a
// metre out in the open air, and pins get planted there.
const sweptPanel = () => {
  const s = new THREE.Shape(), R = 40, wall = 5, N = 10;
  for (let i = 0; i <= N; i++) { const a = Math.PI*0.1 + Math.PI*0.8*i/N;
    if (i === 0) s.moveTo(R*Math.cos(a), R*Math.sin(a)); else s.lineTo(R*Math.cos(a), R*Math.sin(a)); }
  for (let i = N; i >= 0; i--) { const a = Math.PI*0.1 + Math.PI*0.8*i/N; s.lineTo((R-wall)*Math.cos(a), (R-wall)*Math.sin(a)); }
  s.closePath();
  const path = new THREE.CatmullRomCurve3([
    new THREE.Vector3(0, 0, -400), new THREE.Vector3(90, 45, -150),
    new THREE.Vector3(-75, 60, 150), new THREE.Vector3(0, 0, 400)]);
  return new THREE.ExtrudeGeometry(s, { extrudePath: path, steps: 8, bevelEnabled: false });
};
// `min` = pins this seam must produce. The thin ones are the regression guard: a search grid
// tied to `spacing` samples them only on their surface and finds nothing.
const MODELS = {
  'slab 400x200x6':  { min: 3,   mk: () => NI(new THREE.BoxGeometry(400,200,6)) },
  'slab 400x200x10': { min: 4,   mk: () => NI(new THREE.BoxGeometry(400,200,10)) },
  'cyl r4 h400':     { min: 1,   mk: () => NI(new THREE.CylinderGeometry(4,4,400,64)) },
  'cyl r8 h400':     { min: 1,   mk: () => NI(new THREE.CylinderGeometry(8,8,400,64)) },
  'frustum 40->5':   { min: 1,   mk: () => NI(new THREE.CylinderGeometry(5,40,400,64)) },
  // thick at the seam but short along the pin: the old shrink-to-fit retry was a no-op here
  'flange pinD=20':  { min: 1,   mk: () => NI(new THREE.LatheGeometry([[0,-200],[8,-200],[8,-10],[40,-10],[40,10],[8,10],[8,200],[0,200]].map(([x,y])=>new THREE.Vector2(x,y)),64)) },
  'box 600^3':       { min: 900, mk: () => NI(new THREE.BoxGeometry(600,600,600)) },
  'sphere r180':     { min: 150, mk: () => NI(new THREE.SphereGeometry(180,96,64)) },
  'swept panel':     { min: 0,   mk: sweptPanel },   // 5 mm wall takes no dowel — here for the sign check below
};
let fails = 0;
const chk = (ok, msg) => { if (!ok) { fails++; console.log('   FAIL ' + msg); } };

// Ground truth for inside/outside: parity of ray crossings, brute force over the raw triangles.
// Independent of the BVH and of any normal, so it catches a wrong sign in makeSDF.
function rayParity(pos, nTri, px, py, pz, [dx, dy, dz]) {
  let hits = 0;
  for (let t = 0; t < nTri; t++) {
    const o = t * 9, ax = pos[o], ay = pos[o+1], az = pos[o+2];
    const e1x = pos[o+3]-ax, e1y = pos[o+4]-ay, e1z = pos[o+5]-az;
    const e2x = pos[o+6]-ax, e2y = pos[o+7]-ay, e2z = pos[o+8]-az;
    const hx = dy*e2z-dz*e2y, hy = dz*e2x-dx*e2z, hz = dx*e2y-dy*e2x;
    const a = e1x*hx+e1y*hy+e1z*hz; if (Math.abs(a) < 1e-12) continue;
    const f = 1/a, sx = px-ax, sy = py-ay, sz = pz-az;
    const u = f*(sx*hx+sy*hy+sz*hz); if (u < 0 || u > 1) continue;
    const qx = sy*e1z-sz*e1y, qy = sz*e1x-sx*e1z, qz = sx*e1y-sy*e1x;
    const v = f*(dx*qx+dy*qy+dz*qz); if (v < 0 || u+v > 1) continue;
    if (f*(e2x*qx+e2y*qy+e2z*qz) > 1e-9) hits++;
  }
  return hits % 2 === 1;
}
const DIRS = [[1,0,0], [0,1,0], [0,0,1], [0.577,0.577,0.577]];


for (const [name, { min, mk }] of Object.entries(MODELS)) {
  const o = O(name.includes('pinD=20') ? { pinD: 20 } : {});
  const plan = await planCuts(mk(), o, ()=>{});
  const pins = [...plan.pins.values()].flat();
  // invariant: at every pin, the material along the WHOLE pin leaves >= minWall around the hole
  let worst = Infinity;
  for (const p of pins) {
    const dir = [0,0,0]; dir[p._axis] = 1;
    const hl = o.pinLen / 2;
    let m = Infinity;
    for (let i = 0; i <= 8; i++) { const t = -hl + 2*hl*i/8;
      m = Math.min(m, plan.sd(p.x+dir[0]*t, p.y+dir[1]*t, p.z+dir[2]*t)); }
    const wall = m - p.d/2 - o.clearance;
    worst = Math.min(worst, wall);
    chk(p.d >= 2.5 && p.d <= o.pinD, `${name}: Ø ${p.d} out of range`);
    chk(p.tilt === 0, `${name}: tilt != 0`);
    chk(p._u === undefined && p._v === undefined, `${name}: internal field leaked`);
  }
  // spacing respected
  for (let i = 0; i < pins.length; i++) for (let j = i+1; j < pins.length; j++) {
    if (pins[i]._axis !== pins[j]._axis) continue;
    const d = Math.hypot(pins[i].x-pins[j].x, pins[i].y-pins[j].y, pins[i].z-pins[j].z);
    if (d < 1e-6) chk(false, `${name}: duplicate pins at the same point`);
  }
  // end to end
  const pinsByPlane = new Map();
  for (const [k, arr] of plan.pins) pinsByPlane.set(k, arr.map(p => ({ x:p.x, y:p.y, z:p.z, d:p.d,
    dir: (()=>{ const v=[0,0,0]; v[p._axis]=1; return v; })() })));
  const all = await cutAndConnect(mk(), o, pinsByPlane, ()=>{});
  const pieces = all.filter(p => p.kind !== 'pins'), stock = all.filter(p => p.kind === 'pins');
  chk(pieces.length > 0, `${name}: no pieces`);
  chk(all.stats.joints === pins.length, `${name}: joints ${all.stats.joints} != pins ${pins.length}`);
  // the dowels themselves ship as their own STLs — one per diameter, every pin accounted for
  const wantD = [...new Set(pins.map(p=>p.d))].sort((a,b)=>a-b).join('/');
  chk(stock.reduce((a, x) => a + x.count, 0) === pins.length,
      `${name}: pin stock holds ${stock.reduce((a,x)=>a+x.count,0)} dowels, ${pins.length} placed`);
  chk([...new Set(stock.map(x => x.d))].sort((a,b)=>a-b).join('/') === wantD,
      `${name}: pin stock sizes ${[...new Set(stock.map(x=>x.d))].join('/')} != ${wantD}`);
  for (const st of stock) {
    chk(!!st.geometry.index && st.geometry.index.count > 0, `${name}: empty pin stock ${st.name}`);
    chk(Math.abs(st.size[2] - o.pinLen) < 0.05, `${name}: dowel is ${st.size[2].toFixed(2)} mm long, want ${o.pinLen}`);
    chk(st.fits, `${name}: dowel plate ${st.name} is ${st.size.map(v=>v.toFixed(0)).join('x')} mm — does not fit the bed`);
  }
  console.log(`${name.padEnd(18)} pins=${String(pins.length).padStart(4)}  Ø=${wantD||'—'}  min wall left=${pins.length?worst.toFixed(2):'n/a'} mm (need >= ${o.minWall})  pieces=${pieces.length}  stock=${stock.length}`);
  chk(!pins.length || worst >= o.minWall - 0.05, `${name}: wall ${worst.toFixed(2)} < minWall ${o.minWall}`);
  chk(pins.length >= min, `${name}: ${pins.length} pins, expected at least ${min}`);
}
// --- seam search: an even split can drop a seam straight into a neck, where no dowel fits.
// This bar has a 6 mm waist exactly where the even cut lands.
{
  const neckedBar = () => {
    const sh = new THREE.Shape();
    const pts = [[-300,-40],[-110,-40],[-110,-3],[-90,-3],[-90,-40],[90,-40],[90,-3],[110,-3],[110,-40],[300,-40],
                 [300,40],[110,40],[110,3],[90,3],[90,40],[-90,40],[-90,3],[-110,3],[-110,40],[-300,40]];
    sh.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) sh.lineTo(pts[i][0], pts[i][1]);
    sh.closePath();
    const g = new THREE.ExtrudeGeometry(sh, { depth: 80, bevelEnabled: false }); g.translate(0, 0, -40); return g;
  };
  const count = p => [...p.pins.values()].flat().length;
  const even = await planCuts(neckedBar(), O(), () => {});
  const best = await planCuts(neckedBar(), O({ seamSearch: true }), () => {});
  console.log(`\nseam search on a necked bar: even split ${count(even)} pins at ${even.cuts[0].map(v=>v.toFixed(0)).join('/')}` +
              `, searched ${count(best)} pins at ${best.cuts[0].map(v=>v.toFixed(0)).join('/')}`);
  chk(count(even) === 0, `the necked bar should defeat the even split, got ${count(even)} pins`);
  chk(count(best) > 0, 'seam search found no better seam on the necked bar');

  // whatever it picks, every piece must still fit the bed
  for (const [name, plan] of [['e30-like bar', best]]) {
    for (let ax = 0; ax < 3; ax++) {
      const edges = [plan.lo[ax], ...plan.cuts[ax], plan.hi[ax]];
      for (let i = 1; i < edges.length; i++)
        chk(edges[i] - edges[i-1] <= plan.usable[ax] + 1e-3,
            `${name}: seam search left a ${(edges[i]-edges[i-1]).toFixed(1)} mm segment on ${'XYZ'[ax]}, bed allows ${plan.usable[ax]}`);
    }
  }
}

// --- does the printed dowel actually go into the hole cut for it?
// Probe an exported piece with ray parity: on the pin axis it must be void where the dowel
// reaches, and a ring at pin radius + clearance + minWall must still be material.
{
  const o = O(), mk = MODELS['slab 400x200x10'].mk;
  const plan = await planCuts(mk(), o, ()=>{});
  const byPlane = new Map();
  for (const [k, arr] of plan.pins) byPlane.set(k, arr.map(p => ({ x:p.x, y:p.y, z:p.z, d:p.d, cost:p.cost,
    dir: (() => { const v=[0,0,0]; v[p._axis]=1; return v; })() })));
  const all = await cutAndConnect(mk(), o, byPlane, ()=>{});
  const piece = all.find(p => p.kind !== 'pins');
  const geo = piece.geometry.toNonIndexed(), pos = geo.attributes.position.array, nTri = pos.length / 9;
  const solid = (v) => DIRS.filter(d => rayParity(pos, nTri, v[0], v[1], v[2], d)).length >= 3;
  const bb = new THREE.Box3().setFromBufferAttribute(geo.attributes.position);
  let checked = 0, holeBad = 0, wallBad = 0;
  for (const p of [...plan.pins.values()].flat()) {
    const ax = p._axis, c = [p.x, p.y, p.z];
    const mid = (bb.min.getComponent(ax) + bb.max.getComponent(ax)) / 2;
    const step = c[ax] < mid ? 3 : -3;                       // 3 mm into THIS piece, away from the seam
    const at = off => { const v = c.slice(); v[ax] += step; v[(ax+1)%3] += off; return v; };
    if (!bb.containsPoint(new THREE.Vector3(...at(0)))) continue;
    checked++;
    if (solid(at(0))) holeBad++;                              // the axis must be drilled out
    if (!solid(at(p.d/2 + o.clearance + o.minWall + 0.3))) wallBad++;   // the wall must survive
  }
  console.log(`\ndowel vs its hole (${checked} pins probed 3 mm in): axis still solid ${holeBad}, wall missing ${wallBad}`);
  chk(checked > 0, 'hole check probed nothing');
  chk(holeBad === 0, `${holeBad} holes were not drilled`);
  chk(wallBad === 0, `${wallBad} pins broke through the wall`);
}

// --- sd() sign on a swept thin-walled panel. Taking the sign from the closest triangle's own normal
// flips it there and reports "deep inside material" ~18 mm outside the part, which plants pins
// in mid air: in dowel mode they drill nothing, in plug mode they drop loose pegs into the ZIP.
{
  const geo = sweptPanel(), pos = geo.attributes.position.array, nTri = pos.length / 9;
  geo.computeBoundingBox();
  const lo = geo.boundingBox.min, hi = geo.boundingBox.max;
  const plan = await planCuts(sweptPanel(), O(), () => {});
  let n = 0, bad = 0, worst = 0, seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 1500; i++) {
    const x = lo.x + rnd()*(hi.x-lo.x), y = lo.y + rnd()*(hi.y-lo.y), z = lo.z + rnd()*(hi.z-lo.z);
    const sd = plan.sd(x, y, z);
    if (Math.abs(sd) < 0.05) continue;                       // skip points sitting on the surface
    n++;
    const inside = DIRS.filter(d => rayParity(pos, nTri, x, y, z, d)).length >= 3;
    if ((sd > 0) !== inside) { bad++; worst = Math.max(worst, Math.abs(sd)); }
  }
  console.log(`\nsd() sign on a swept thin-walled panel: ${n-bad}/${n} agree with ray parity` +
              (bad ? `, worst wrong |sd| = ${worst.toFixed(2)} mm` : ''));
  chk(bad === 0, `sd() sign wrong at ${bad}/${n} points (worst |sd| = ${worst.toFixed(2)} mm)`);
}

console.log(fails ? `\n${fails} FAILED` : '\nall invariants OK');
process.exit(fails ? 1 : 0);
