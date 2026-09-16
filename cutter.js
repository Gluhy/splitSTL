// cutter.js — cut planning + joints (dowels: dowel / plug), boolean cutting.
// Boolean + 2D offset: manifold-3d. Signed distance: three-mesh-bvh.

import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import ManifoldModule from 'manifold-3d';

let wasm = null;
export async function initManifold() {
  if (wasm) return wasm;
  wasm = await ManifoldModule();
  wasm.setup();
  return wasm;
}

const Z = () => new THREE.Vector3(0, 0, 1);
const axisVec = ax => new THREE.Vector3().setComponent(ax, 1);
function mat4(m) { return Array.from(m.elements); }   // Mat4 column-major (16) — manifold.transform(Mat4)

// --------------------------------------------------------------------------- //
// Signed distance (>0 = inside the material) — computed on the WATERTIGHT geometry from manifold
// --------------------------------------------------------------------------- //
// Sign comes from the ANGLE-WEIGHTED PSEUDO-NORMAL (Baerentzen & Aanaes 2005), not from the
// closest triangle's own normal. The closest point on a mesh usually lands on an edge or a
// vertex, and there a single face normal is meaningless: in a concave crease it flips the sign
// and the field reports "deep inside material" centimetres outside the solid. The pseudo-normal
// of the feature actually hit (face / edge / vertex) is correct everywhere on a 2-manifold.
function makeSDF(geometry) {
  const g = geometry.index ? geometry : weldByPosition(geometry);   // adjacency needs shared vertices
  const bvh = new MeshBVH(g);
  const P = g.attributes.position.array, I = g.index.array;
  const nV = g.attributes.position.count, nT = I.length / 3;

  // face normals, and the angle-weighted normal accumulated at every vertex
  const fN = new Float32Array(nT * 3), vN = new Float32Array(nV * 3);
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), fn = new THREE.Vector3();
  const vp = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  for (let t = 0; t < nT; t++) {
    for (let k = 0; k < 3; k++) vp[k].fromArray(P, I[t * 3 + k] * 3);
    fn.crossVectors(e1.subVectors(vp[1], vp[0]), e2.subVectors(vp[2], vp[0]));
    const len = fn.length(); if (len > 0) fn.multiplyScalar(1 / len);
    fn.toArray(fN, t * 3);
    for (let k = 0; k < 3; k++) {
      e1.subVectors(vp[(k + 1) % 3], vp[k]); e2.subVectors(vp[(k + 2) % 3], vp[k]);
      const l1 = e1.length(), l2 = e2.length();
      const ang = (l1 && l2) ? Math.acos(Math.max(-1, Math.min(1, e1.dot(e2) / (l1 * l2)))) : 0;
      const o = I[t * 3 + k] * 3;
      vN[o] += fn.x * ang; vN[o + 1] += fn.y * ang; vN[o + 2] += fn.z * ang;
    }
  }
  // triangle opposite each half-edge -> an edge pseudo-normal is the sum of its two faces
  const opp = new Int32Array(nT * 3).fill(-1), pending = new Map();
  for (let t = 0; t < nT; t++) for (let k = 0; k < 3; k++) {
    const x = I[t * 3 + k], y = I[t * 3 + (k + 1) % 3], key = x < y ? x * nV + y : y * nV + x;
    const prev = pending.get(key);
    if (prev === undefined) pending.set(key, t * 3 + k);
    else { opp[t * 3 + k] = (prev / 3) | 0; opp[prev] = t; pending.delete(key); }
  }
  pending.clear();

  const p = new THREE.Vector3(), dir = new THREE.Vector3(), nrm = new THREE.Vector3();
  const A = new THREE.Vector3(), v0 = new THREE.Vector3(), v1 = new THREE.Vector3(), v2 = new THREE.Vector3();
  const target = {}, EPS = 1e-4;
  return function sd(x, y, z) {
    p.set(x, y, z); bvh.closestPointToPoint(p, target);
    const t = target.faceIndex;
    A.fromArray(P, I[t * 3] * 3);
    v0.fromArray(P, I[t * 3 + 1] * 3).sub(A);
    v1.fromArray(P, I[t * 3 + 2] * 3).sub(A);
    v2.copy(target.point).sub(A);
    // barycentric coords say which feature the closest point really sits on
    const d00 = v0.dot(v0), d01 = v0.dot(v1), d11 = v1.dot(v1),
          d20 = v2.dot(v0), d21 = v2.dot(v1), den = d00 * d11 - d01 * d01;
    let b1 = 0, b2 = 0;
    if (den !== 0) { b1 = (d11 * d20 - d01 * d21) / den; b2 = (d00 * d21 - d01 * d20) / den; }
    const l0 = 1 - b1 - b2 < EPS, l1 = b1 < EPS, l2 = b2 < EPS, nLow = (l0 ? 1 : 0) + (l1 ? 1 : 0) + (l2 ? 1 : 0);
    if (nLow >= 2) {                                   // vertex — the corner that is not ~0
      const k = !l0 ? 0 : (!l1 ? 1 : 2);
      nrm.fromArray(vN, I[t * 3 + k] * 3);
    } else if (nLow === 1) {                           // edge — the one facing the ~0 corner
      const k = l0 ? 0 : (l1 ? 1 : 2), o = opp[t * 3 + (k + 1) % 3];
      nrm.fromArray(fN, t * 3);
      if (o >= 0) { nrm.x += fN[o * 3]; nrm.y += fN[o * 3 + 1]; nrm.z += fN[o * 3 + 2]; }
    } else nrm.fromArray(fN, t * 3);                   // face interior
    dir.subVectors(p, target.point);
    return (dir.dot(nrm) < 0 ? 1 : -1) * target.distance;
  };
}

// --------------------------------------------------------------------------- //
// 3D pin direction (for dowel/plug)
// --------------------------------------------------------------------------- //
export function dirFromTiltAz(ax, tiltDeg, azDeg) {
  const o = [0, 1, 2].filter(a => a !== ax);
  const base = [0, 0, 0]; base[ax] = 1;
  const u = [0, 0, 0]; u[o[0]] = 1; const w = [0, 0, 0]; w[o[1]] = 1;
  const t = tiltDeg * Math.PI / 180, a = azDeg * Math.PI / 180, s = Math.sin(t), cc = Math.cos(t), d = [0, 0, 0];
  for (let i = 0; i < 3; i++) d[i] = base[i] * cc + (u[i] * Math.cos(a) + w[i] * Math.sin(a)) * s;
  return d;
}
function sampleMinSD(sd, p, dir, halfLen, n = 4) {
  let m = Infinity;
  for (let i = 0; i <= n; i++) { const t = -halfLen + 2 * halfLen * i / n; const v = sd(p[0] + dir[0] * t, p[1] + dir[1] * t, p[2] + dir[2] * t); if (v < m) m = v; }
  return m;
}
// Auto = only PERPENDICULAR dowels (tilt 0). Angled dowels on one seam point in different
// directions -> the pieces can't be assembled (assembly needs one common slide-in direction).
// A spot where a straight dowel doesn't fit is left without a dowel (glue joint).
export const MAX_AUTO_TILT = 0;
export function autoDir(sd, point, ax, halfLen, requiredSd, maxTilt = MAX_AUTO_TILT) {
  const p = [point.x ?? point[0], point.y ?? point[1], point.z ?? point[2]];
  const c0 = sampleMinSD(sd, p, dirFromTiltAz(ax, 0, 0), halfLen);
  if (c0 >= requiredSd) return { tilt: 0, az: 0, cost: c0 };
  let best = { tilt: 0, az: 0, cost: c0 };
  for (const tilt of [15, 30, 45, 60, 70]) {
    if (tilt > maxTilt) break;                  // don't tilt the dowel "flat"
    for (const az of [0, 45, 90, 135, 180, 225, 270, 315]) {
      const cost = sampleMinSD(sd, p, dirFromTiltAz(ax, tilt, az), halfLen);
      if (cost > best.cost) best = { tilt, az, cost };
    }
  }
  return best;
}

// Smallest dowel worth placing (mm).
export const MIN_D = 2.5;
// Hole/socket is this much deeper than the pin reaches, per side. Without it the pin bottoms
// out in the hole instead of the two faces meeting: no room for glue, and trapped air.
// The fit test measures over the deeper hole, so `minWall` still holds at the bottom.
export const HOLE_FIT = 0.5;
// Lead-in at the hole mouth / pin tip, as much as the spare wall allows (0 where it is tight).
export const chamferFor = (minSd, d, opts) =>
  Math.max(0, Math.min(0.6, minSd - d / 2 - opts.clearance - opts.minWall));

// What actually limits a pin is the TIGHTEST spot along its whole length, not the wall
// thickness at the seam: the tip needs material around it too.
export function pinFit(sd, point, ax, halfLen) {
  const b = autoDir(sd, point, ax, halfLen, Infinity);
  return { tilt: b.tilt, az: b.az, minSd: b.cost };
}
// Largest Ø (0.5 mm steps) that fits there; 0 = leave this spot without a pin.
// Derived from the SAME measure that later accepts the pin, so "fits" and "chosen Ø" agree.
export function fitDiameter(minSd, opts) {
  const d = Math.min(opts.pinD, Math.floor(4 * (minSd - opts.clearance - opts.minWall)) / 2);
  return d >= MIN_D ? d : 0;
}

// --------------------------------------------------------------------------- //
// three <-> manifold conversions
// --------------------------------------------------------------------------- //
// Welds vertices by POSITION only (within a tolerance). STL keeps a separate normal per
// triangle, so mergeVertices on the full geometry won't fuse shared vertices —
// strip down to position alone, then weld.
function weldByPosition(geometry, tol = 1e-4) {
  const bare = new THREE.BufferGeometry();
  bare.setAttribute('position', geometry.getAttribute('position').clone());
  if (geometry.index) bare.setIndex(geometry.index.clone());
  return mergeVertices(bare, tol);
}

// Topology diagnostics on welded, indexed geometry: distinguishes holes,
// non-manifold edges (3+ triangles) and inconsistent orientation (flipped normals).
function analyzeTopology(welded) {
  const idx = welded.index.array, triCount = idx.length / 3, n = welded.attributes.position.count;
  const edges = new Map(), half = new Map();          // numeric keys: a*n+b
  for (let t = 0; t < triCount; t++) {
    const v0 = idx[t * 3], v1 = idx[t * 3 + 1], v2 = idx[t * 3 + 2];
    const tri = [[v0, v1], [v1, v2], [v2, v0]];
    for (const [a, b] of tri) {
      const u = a < b ? a * n + b : b * n + a;
      edges.set(u, (edges.get(u) || 0) + 1);
      half.set(a * n + b, (half.get(a * n + b) || 0) + 1);
    }
  }
  let boundary = 0, nonManifold = 0, flipped = 0;
  for (const [u, c] of edges) {
    if (c === 1) { boundary++; continue; }
    if (c > 2) { nonManifold++; continue; }
    const a = Math.floor(u / n), b = u % n;            // c === 2 -> check winding
    if ((half.get(a * n + b) || 0) !== 1 || (half.get(b * n + a) || 0) !== 1) flipped++;
  }
  return { boundary, nonManifold, flipped };
}

// Attempts to auto-repair "almost manifold": removes degenerate and duplicate triangles
// (a common source of non-manifold edges) and patches small holes with a fan over the
// boundary loop, preserving orientation. Works on welded, indexed geometry.
function repairTopology(welded) {
  const posAttr = welded.attributes.position, n = posAttr.count, src = welded.index.array;
  let degen = 0, dup = 0;
  const seen = new Set(), faces = [];
  for (let t = 0; t < src.length; t += 3) {
    const a = src[t], b = src[t + 1], c = src[t + 2];
    if (a === b || b === c || a === c) { degen++; continue; }                 // zero area
    const s = [a, b, c].sort((x, y) => x - y), key = s[0] + ',' + s[1] + ',' + s[2];
    if (seen.has(key)) { dup++; continue; }                                   // identical triangle (by vertices)
    seen.add(key); faces.push(a, b, c);
  }
  // directed edges -> a boundary edge = a half with no opposite
  const dir = new Set();
  for (let t = 0; t < faces.length; t += 3) { const a = faces[t], b = faces[t + 1], c = faces[t + 2]; dir.add(a * n + b); dir.add(b * n + c); dir.add(c * n + a); }
  const next = new Map();
  for (const e of dir) { const a = Math.floor(e / n), b = e % n; if (!dir.has(b * n + a)) next.set(a, b); }
  // chain the boundary loops and patch with a fan (v0, v[i+1], v[i]) — reverse of the boundary edges
  let holes = 0, holeTris = 0, failed = 0;
  const used = new Set();
  for (const start of next.keys()) {
    if (used.has(start)) continue;
    const loop = []; let v = start, ok = false;
    while (v !== undefined && !used.has(v)) {
      used.add(v); loop.push(v); v = next.get(v);
      if (v === start) { ok = true; break; }
    }
    if (!ok || loop.length < 3) { failed++; continue; }
    for (let i = 1; i < loop.length - 1; i++) faces.push(loop[0], loop[i + 1], loop[i]);
    holes++; holeTris += loop.length - 2;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', posAttr.clone());
  geo.setIndex(new THREE.BufferAttribute(Uint32Array.from(faces), 1));
  return { geometry: geo, report: { degen, dup, holes, holeTris, failed } };
}

function geometryToManifold(geometry, log = () => {}) {
  const { Manifold, Mesh } = wasm;
  const welded = weldByPosition(geometry);
  const { geometry: fixed, report: r } = repairTopology(welded);
  if (r.degen || r.dup || r.holes)
    log('log.repair', { degen: r.degen, dup: r.dup, holes: r.holes, holeTris: r.holeTris });
  if (r.failed) log('log.repair.failed', { n: r.failed });
  const idx = fixed.index.array;
  const triVerts = idx instanceof Uint32Array ? idx : new Uint32Array(idx);
  const mesh = new Mesh({ numProp: 3, vertProperties: new Float32Array(fixed.attributes.position.array), triVerts });
  mesh.merge();
  let m, bad = false;
  try {
    m = Manifold.ofMesh(mesh);
    const status = typeof m.status === 'function' ? m.status() : (m.status ?? 0);
    if (m.isEmpty() || m.numTri() === 0 || (status && status !== 0 && status !== 'NoError')) bad = true; // numTri() forces evaluation (manifold is lazy)
  } catch { bad = true; }
  mesh.delete?.();   // Mesh data already copied into the manifold
  if (bad) {
    const d = analyzeTopology(fixed), why = [];
    if (d.boundary)    why.push(['err.boundary', { n: d.boundary }]);
    if (d.nonManifold) why.push(['err.nonManifold', { n: d.nonManifold }]);
    if (d.flipped)     why.push(['err.flipped', { n: d.flipped }]);
    if (!why.length)   why.push(['err.selfIntersecting', {}]);
    // the UI translates; the message here is the fallback for anything that just reads .message
    const err = new Error(`Auto-repair was not enough — remaining: ${why.map(w => w[0]).join(', ')}.`);
    err.key = 'err.notManifold'; err.parts = why;
    throw err;
  }
  return m;
}
function manifoldToGeometry(m) {
  const mesh = m.getMesh(), geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(mesh.vertProperties.slice(), 3));
  geo.setIndex(new THREE.BufferAttribute(mesh.triVerts.slice(), 1));
  geo.computeVertexNormals();
  return geo;
}
function manifoldBounds(m) {
  const v = m.getMesh().vertProperties, min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < v.length; i += 3) for (let a = 0; a < 3; a++) { const x = v[i + a]; if (x < min[a]) min[a] = x; if (x > max[a]) max[a] = x; }
  return { min, max };
}

// --------------------------------------------------------------------------- //
// Cut plans + auto pins
// --------------------------------------------------------------------------- //
function cutPositions(lo, hi, usable) {
  const n = Math.max(1, Math.ceil((hi - lo) / usable)); if (n === 1) return [];
  const step = (hi - lo) / n, out = []; for (let k = 1; k < n; k++) out.push(lo + step * k); return out;
}
export function planeKey(axis, coord) { return `${axis},${coord.toFixed(3)}`; }

// --------------------------------------------------------------------------- //
// Seam placement. The even split lands wherever it lands — sometimes on a waist, where there
// is barely enough material for a dowel. With `seamSearch` each cut slides inside a window
// around its even position to the section carrying the most material: more glue area, and room
// for fatter pins. Score is the material area weighted by how close each spot is to being
// thick enough for a full-size pin, so a wide-but-papery section does not beat a solid one.
// --------------------------------------------------------------------------- //
function sectionGrid(lo, hi, axis, budget = 900) {
  const [au, av] = [0, 1, 2].filter(a => a !== axis);
  const n = [au, av].map(a => Math.max(1, Math.min(Math.round((hi[a] - lo[a]) / 2), 120)));
  const k = Math.sqrt(budget / (n[0] * n[1]));
  if (k < 1) { n[0] = Math.max(1, Math.round(n[0] * k)); n[1] = Math.max(1, Math.round(n[1] * k)); }
  const line = (a, i) => { const ext = hi[a] - lo[a], out = [];
    for (let j = 0; j < n[i]; j++) out.push(lo[a] + ext * (j + 0.5) / n[i]); return out; };
  return { au, av, u: line(au, 0), v: line(av, 1) };
}
function seamScore(sd, axis, coord, g, cap) {
  const c = [0, 0, 0]; c[axis] = coord;
  let s = 0;
  for (const u of g.u) { c[g.au] = u; for (const v of g.v) { c[g.av] = v;
    const d = sd(c[0], c[1], c[2]); if (d > 0) s += Math.min(d, cap); } }
  return s;
}
function bestCuts(sd, lo, hi, axis, usable, opts) {
  const even = cutPositions(lo[axis], hi[axis], usable);
  if (!even.length) return even;
  const n = even.length + 1, step = (hi[axis] - lo[axis]) / n;
  const reach = step * 0.35;                       // keep the pieces roughly even
  const minSeg = Math.min(step * 0.5, usable * 0.5);
  const g = sectionGrid(lo, hi, axis), cap = opts.pinD / 2 + opts.clearance + opts.minWall;
  const out = []; let prev = lo[axis];
  for (let k = 0; k < even.length; k++) {
    const left = n - k - 1;                        // segments still to come after this cut
    // hard limits: this piece must fit, and what is left must still be coverable
    const loOk = Math.max(prev + minSeg, hi[axis] - left * usable);
    const hiOk = Math.min(prev + usable, hi[axis] - left * minSeg);
    const min = Math.max(loOk, even[k] - reach), max = Math.min(hiOk, even[k] + reach);
    if (!(max > min)) {                            // nothing to search — stay inside the hard limits,
      const c = Math.min(Math.max(even[k], loOk), hiOk);   // never blindly fall back to the even split
      out.push(c); prev = c; continue;
    }
    let best = even[k], bestScore = -1;
    const steps = 24;
    for (let i = 0; i <= steps; i++) {
      const c = min + (max - min) * i / steps, sc = seamScore(sd, axis, c, g, cap);
      if (sc > bestScore + 1e-9) { bestScore = sc; best = c; }
    }
    out.push(best); prev = best;
  }
  return out;
}

// Auto-placement of dowels on one seam.
// `spacing` thins out the RESULT; it must not drive the search resolution. A grid tied to
// `spacing` and anchored on the bounding box samples a thin seam only on its surface
// (sd ~ 0) and reports "no material". This grid follows the pin size and sits in cell
// centres, then each seed slides to the spot where the pin really fits best.
function materialPoints(sd, lo, hi, axis, coord, opts, halfLen, cuts) {
  const [au, av] = [0, 1, 2].filter(a => a !== axis);
  const spacing = Math.max(1, opts.spacing);
  const reqMin = MIN_D / 2 + opts.clearance + opts.minWall;      // loosest pin we would accept
  const dir = dirFromTiltAz(axis, 0, 0);
  const at = (u, v) => { const c = [0, 0, 0]; c[axis] = coord; c[au] = u; c[av] = v; return c; };
  // a dowel must not straddle a perpendicular cut — re-checked per candidate with its own Ø
  const nearCut = (val, arr, m) => arr && arr.some(cc => Math.abs(val - cc) < m);

  // ---- coarse scan for seeds: cell centres, resolution from the pin, sample count capped
  const step = Math.min(Math.max(reqMin / 2, 0.6), 3), BUDGET = 8000;
  const n = [au, av].map(a => Math.max(1, Math.min(Math.round((hi[a] - lo[a]) / step), 800)));
  const k = Math.sqrt(BUDGET / (n[0] * n[1]));                   // scales both axes -> a thin seam keeps its resolution
  if (k < 1) { n[0] = Math.max(1, Math.round(n[0] * k)); n[1] = Math.max(1, Math.round(n[1] * k)); }
  const grid = (a, i) => { const ext = hi[a] - lo[a], out = [];
    for (let j = 0; j < n[i]; j++) out.push(lo[a] + ext * (j + 0.5) / n[i]); return out; };
  const seeds = []; let maxSd = 0;
  const gu = grid(au, 0), gv = grid(av, 1);
  for (let i = 0; i < gu.length; i++) for (let j = 0; j < gv.length; j++) {
    const u = gu[i], v = gv[j], c = at(u, v), cs = sd(c[0], c[1], c[2]);
    if (cs > maxSd) maxSd = cs;
    if (cs >= reqMin && !nearCut(u, cuts[au], reqMin) && !nearCut(v, cuts[av], reqMin)) seeds.push({ i, j, u, v });
  }

  // ---- measure the real fit (min sd along the whole pin) on a lattice dense enough to place
  // pins on, capped so a huge seam does not cost a second. Every survivor carries its own Ø.
  const CAP = 2500, over = Math.sqrt(seeds.length / CAP);
  const sU = over > 1 ? Math.max(1, Math.min(Math.round(over), Math.floor(gu.length / 8) || 1)) : 1;
  const sV = over > 1 ? Math.max(1, Math.min(Math.round(over), Math.floor(gv.length / 8) || 1)) : 1;
  const viable = [];
  for (const s of seeds) {
    if (s.i % sU || s.j % sV) continue;
    const cost = sampleMinSD(sd, at(s.u, s.v), dir, halfLen);
    const d = fitDiameter(cost, opts);
    if (!d) continue;
    const reqSd = d / 2 + opts.clearance + opts.minWall;
    if (nearCut(s.u, cuts[au], reqSd) || nearCut(s.v, cuts[av], reqSd)) continue;
    if (cost > maxSd) maxSd = cost;
    viable.push({ u: s.u, v: s.v, d, cost });
  }
  if (!viable.length) return { chosen: [], maxSd };

  // ---- place the pins: fattest Ø first, spread out inside each Ø class.
  // Ordering purely by wall thickness made the count flip between 4 and 5 on seams that look
  // identical, because the thickest point wanders along the part and the greedy chain that
  // follows it lands differently. Ordering purely by spread (farthest-point) is stable but
  // walks straight to the thin rim and picks Ø2.5 where Ø5 fits 3 mm away. So: take the Ø
  // classes from fat to thin, and inside each one keep picking the candidate that is furthest
  // from everything already placed. Both the classes and the spread follow the section's shape,
  // not its maximum, so equivalent seams come out with equivalent joints.
  let cu = 0, cv = 0;
  for (const q of viable) { cu += q.u; cv += q.v; }
  cu /= viable.length; cv /= viable.length;
  const classes = [...new Set(viable.map(q => q.d))].sort((a, b) => b - a);
  const rim = viable.map(q => Math.hypot(q.u - cu, q.v - cv));   // only ranks the very first pick
  const gap = viable.map(() => Infinity);                        // distance to the nearest pin placed so far
  const chosen = [];
  for (const dc of classes) {
    for (;;) {
      let bi = -1, bd = -Infinity;
      for (let i = 0; i < viable.length; i++) {
        if (viable[i].d !== dc) continue;
        if (chosen.length && gap[i] < spacing) continue;
        const score = -rim[i];
        if (score > bd + 1e-9) { bd = score; bi = i; }
      }
      if (bi < 0) break;
      const q = viable[bi], c = at(q.u, q.v);
      chosen.push({ x: c[0], y: c[1], z: c[2], _axis: axis, tilt: 0, az: 0, d: q.d, cost: q.cost });
      for (let i = 0; i < viable.length; i++) {
        const dd = Math.hypot(viable[i].u - q.u, viable[i].v - q.v);
        if (dd < gap[i]) gap[i] = dd;
      }
    }
  }
  return { chosen, maxSd };
}

export async function planCuts(geometry, opts, log = () => {}) {
  await initManifold();
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox, lo = [bb.min.x, bb.min.y, bb.min.z], hi = [bb.max.x, bb.max.y, bb.max.z];
  const usable = opts.build.map(v => v - 2 * opts.margin);
  if (usable.some(v => v <= 0)) { const e = new Error('Margin too large for the build volume.'); e.key = 'err.margin'; throw e; }
  const mm = geometryToManifold(geometry, log);
  const clean = manifoldToGeometry(mm); mm.delete();   // consistent normals -> correct sd sign
  const sd = makeSDF(clean);
  const cuts = opts.cuts || [0, 1, 2].map(ax => opts.seamSearch
    ? bestCuts(sd, lo, hi, ax, usable[ax], opts)
    : cutPositions(lo[ax], hi[ax], usable[ax]));
  const planes = []; for (let ax = 0; ax < 3; ax++) for (const coord of cuts[ax]) planes.push({ axis: ax, coord });

  const halfLen = opts.pinLen / 2 + HOLE_FIT;      // fit is measured over the DEEPER hole
  const needPins = opts.connector === 'auto' || opts.connector === 'dowel' || opts.connector === 'plug';
  let maxSd = 0; const pins = new Map(); const planeD = new Map();
  for (const { axis, coord } of planes) {
    const key = planeKey(axis, coord);
    if (!needPins) { pins.set(key, []); continue; }
    const r = materialPoints(sd, lo, hi, axis, coord, opts, halfLen, cuts);
    if (r.maxSd > maxSd) maxSd = r.maxSd;
    pins.set(key, r.chosen);                                   // every pin carries its own Ø
    if (r.chosen.length) planeD.set(key, Math.max(...r.chosen.map(p => p.d)));
  }
  return { lo, hi, usable, cuts, planes, pins, sd, maxWall: 2 * maxSd, planeD };
}

// Re-place the auto pins on a single seam — used when a cut plane is dragged to a new spot.
export function planPlane(plan, axis, coord, opts) {
  return materialPoints(plan.sd, plan.lo, plan.hi, axis, coord, opts,
                        opts.pinLen / 2 + HOLE_FIT, plan.cuts).chosen;
}

// --------------------------------------------------------------------------- //
// Joint geometry
// --------------------------------------------------------------------------- //
// One cone/cylinder segment laid along `dir`: radius r1 at distance t0 from p, r2 at t0 + len.
function orientedCone(r1, r2, len, t0, dir, p, segments = 32) {
  const { Manifold } = wasm;
  const v = new THREE.Vector3(dir[0], dir[1], dir[2]).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(Z(), v);
  const origin = new THREE.Vector3(p.x, p.y, p.z).addScaledVector(v, t0);
  const m = new THREE.Matrix4().compose(origin, q, new THREE.Vector3(1, 1, 1));
  const c = Manifold.cylinder(len, r1, r2, segments, false);     // base at z = 0, top at z = len
  const out = c.transform(mat4(m)); c.delete();
  return out;
}
function unionAll(parts) {
  let r = parts[0];
  for (let i = 1; i < parts.length; i++) { const j = wasm.Manifold.union(r, parts[i]); r.delete(); parts[i].delete(); r = j; }
  return r;
}
function orientedCylinder(radius, height, dir, p, segments = 32) {
  return orientedCone(radius, radius, height, -height / 2, dir, p, segments);
}
// square pyramid: base (side ~2*baseR) at point p on the face, apex going inward along dir.
// Sloped walls -> self-supporting, easier to print than a cylindrical hole.
function orientedPyramid(baseR, height, dir, p) {
  const { Manifold } = wasm;
  const qRoll = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 4); // square axis-aligned
  const qDir = new THREE.Quaternion().setFromUnitVectors(Z(), new THREE.Vector3(dir[0], dir[1], dir[2]).normalize());
  const m = new THREE.Matrix4().compose(new THREE.Vector3(p.x, p.y, p.z), qDir.multiply(qRoll), new THREE.Vector3(1, 1, 1));
  const pyr = Manifold.cylinder(height, baseR, 0, 4, false);   // base at z=0, apex at z=height
  const out = pyr.transform(mat4(m)); pyr.delete();
  return out;
}


// --------------------------------------------------------------------------- //
// Piece numbering — engraved (recessed) grid number on a cut face
// --------------------------------------------------------------------------- //
// digits as a 3x5 matrix of dots (drilled points — print better than thin grooves).
const DOT_DIGITS = {
  '0': ['111', '101', '101', '101', '111'], '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'], '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'], '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'], '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'], '9': ['111', '101', '111', '001', '111'],
};
// dot positions [column, row] in pitch units; u to the right, v up. '-' = a gap.
function dotPositions(label) {
  const dots = []; let col = 0, maxCol = 0;
  for (const ch of label) {
    if (ch === '-') { col += 2; continue; }                 // axis separator = wider gap
    const g = DOT_DIGITS[ch]; if (!g) { col += 4; continue; }
    for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++)
      if (g[r][c] === '1') dots.push([col + c, 4 - r]);      // row 0 = top -> v=4
    col += 4; maxCol = col;                                  // 3 columns + 1 gap
  }
  return { dots, cols: Math.max(0, maxCol - 1), rows: 5 };   // width in pitch; height = 4 gaps
}
// consider ONE flat bbox face (axis `ax`, side `into`); return a number plan or null
function planFace(m, ax, into, bnd, dots, cols, rows) {
  const coord = into === 1 ? bnd.min[ax] : bnd.max[ax];
  const qf = new THREE.Quaternion().setFromUnitVectors(axisVec(ax), Z());
  const fwdM = new THREE.Matrix4().makeRotationFromQuaternion(qf), invM = fwdM.clone().invert();
  const needRot = ax !== 2;
  const rot = needRot ? m.transform(mat4(fwdM)) : m;
  const near = rot.slice(coord + 0.3 * into); if (needRot) rot.delete();   // material just under the face
  if (near.isEmpty()) { near.delete(); return null; }
  let inner = near.offset(-1.4);                                           // keep dots away from the edge
  if (inner.isEmpty()) { inner.delete(); inner = near.offset(-0.7); }      // thin wall -> smaller margin
  near.delete();
  if (inner.isEmpty()) { inner.delete(); return null; }
  const polys = inner.toPolygons(), bb = inner.bounds(); inner.delete();
  const bmin = [bb.min[0] ?? bb.min.x, bb.min[1] ?? bb.min.y], bmax = [bb.max[0] ?? bb.max.x, bb.max[1] ?? bb.max.y];
  const inside = (x, y) => {
    let c = false;
    for (const r of polys) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const xi = r[i][0], yi = r[i][1], xj = r[j][0], yj = r[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) c = !c;
    }
    return c;
  };
  let sx = 0, sy = 0, ncnt = 0;                                           // material centroid
  for (let i = 0; i <= 12; i++) for (let k = 0; k <= 12; k++) {
    const x = bmin[0] + (bmax[0] - bmin[0]) * i / 12, y = bmin[1] + (bmax[1] - bmin[1]) * k / 12;
    if (inside(x, y)) { sx += x; sy += y; ncnt++; }
  }
  if (!ncnt) return null;
  const cx = sx / ncnt, cy = sy / ncnt;
  const ew = bmax[0] - bmin[0], eh = bmax[1] - bmin[1], swap = eh > ew;
  const faceLong = Math.max(ew, eh), faceShort = Math.min(ew, eh);
  const place = pitch => dots.map(([u, v]) => {
    const lu = (u - cols / 2) * pitch, lv = (v - (rows - 1) / 2) * pitch;
    return swap ? [cx + lv, cy + lu] : [cx + lu, cy + lv];
  });
  let pitch = Math.min(faceLong * 0.9 / Math.max(cols, 1), faceShort * 0.85 / (rows - 1), 3.0), pts = null;
  for (; pitch >= 0.9; pitch *= 0.85) { const p = place(pitch); if (p.every(([x, y]) => inside(x, y))) { pts = p; break; } }
  if (!pts) return null;
  return { ax, into, coord, pts, invM, pitch };   // pitch = score (bigger = more legible number)
}
// drill the number with pyramids on the BEST flat face of the piece (where there's material)
function engrave(m, label) {
  const { Manifold } = wasm;
  const { dots, cols, rows } = dotPositions(label);
  if (!dots.length) return m;
  const bnd = manifoldBounds(m);
  const minDim = Math.min(bnd.max[0] - bnd.min[0], bnd.max[1] - bnd.min[1], bnd.max[2] - bnd.min[2]);
  const depth = Math.max(0.5, Math.min(1.2, 0.4 * minDim));   // don't punch through a thin piece
  let best = null;
  for (let ax = 0; ax < 3; ax++) for (const into of [1, -1]) {
    const c = planFace(m, ax, into, bnd, dots, cols, rows);
    if (c && (!best || c.pitch > best.pitch)) best = c;
  }
  if (!best) return m;
  const baseR = Math.max(0.6, Math.min(best.pitch * 0.42, 1.6));
  const dir = [0, 0, 0]; dir[best.ax] = best.into;
  let tool = null;
  for (const [x, y] of best.pts) {
    const w = new THREE.Vector3(x, y, best.coord).applyMatrix4(best.invM);
    const pyr = orientedPyramid(baseR, depth, dir, w);
    if (!tool) tool = pyr; else { const j = Manifold.union(tool, pyr); tool.delete(); pyr.delete(); tool = j; }
  }
  if (!tool) return m;
  let res; try { res = Manifold.difference(m, tool); } catch { tool.delete(); return m; }
  tool.delete();
  return res;
}

// --------------------------------------------------------------------------- //
// Printed dowels — the pins themselves, as their own STL to print alongside the pieces.
// One file per diameter with every copy of that size laid out on the plate, standing on end:
// upright gives a round cross-section (the fit is what matters here), lying down would print
// oval and need supports. Both ends are chamfered so they start into the hole.
// --------------------------------------------------------------------------- //
function pinStock(used, opts, usable, origin) {
  const { Manifold } = wasm;
  const byD = new Map();
  for (const d of used) byD.set(d, (byD.get(d) || 0) + 1);
  const L = opts.pinLen, up = [0, 0, 1], out = [];
  for (const [d, total] of [...byD].sort((a, b) => b[0] - a[0])) {
    const r = d / 2, ch = Math.min(0.6, r * 0.25), pitch = d + 6;
    // One template, then translated copies — building 1000+ dowels from scratch is needlessly slow.
    const at0 = { x: 0, y: 0, z: 0 };
    let tpl = unionAll([
      orientedCone(r - ch, r, ch, 0, up, at0),
      orientedCone(r, r, L - 2 * ch, ch, up, at0),
      orientedCone(r, r - ch, ch, L - ch, up, at0),
    ]);
    // Longitudinal glue flutes. A smooth dowel scrapes the glue off on the way in and traps the
    // rest; the grooves give it somewhere to go. Wooden dowels are fluted for exactly this reason.
    const nf = d >= 6 ? 4 : 3, fr = Math.min(0.5, d * 0.12);
    for (let i = 0; i < nf; i++) {
      const a = 2 * Math.PI * i / nf;
      const groove = orientedCone(fr, fr, L + 2, -1, up, { x: Math.cos(a) * r, y: Math.sin(a) * r, z: 0 }, 12);
      const cut = Manifold.difference(tpl, groove); tpl.delete(); groove.delete(); tpl = cut;
    }
    const cols = Math.max(1, Math.floor((usable[0] - 2) / pitch));
    const rows = Math.max(1, Math.floor((usable[1] - 2) / pitch));
    const perPlate = cols * rows, plates = Math.ceil(total / perPlate);
    for (let pl = 0; pl < plates; pl++) {
      const count = Math.min(perPlate, total - pl * perPlate), parts = [];
      for (let i = 0; i < count; i++) {
        const t = new THREE.Matrix4().makeTranslation(
          origin[0] + (i % cols) * pitch, origin[1] + Math.floor(i / cols) * pitch, origin[2]);
        parts.push(tpl.transform(mat4(t)));
      }
      // the dowels never touch, so compose() just concatenates them — a union chain of 500
      // bodies costs seconds and buys nothing
      const all = Manifold.compose(parts); parts.forEach(x => x.delete());
      const b = manifoldBounds(all);
      const size = [0, 1, 2].map(a => b.max[a] - b.min[a]);
      const tag = plates > 1 ? `_plate${pl + 1}of${plates}` : '';
      out.push({ name: `pins_${d.toFixed(1)}mm_x${count}${tag}.stl`, kind: 'pins', d, count,
                 geometry: manifoldToGeometry(all), size, fits: size.every((v, a) => v <= usable[a] + 1e-3) });
      all.delete();
    }
    tpl.delete();
  }
  return out;
}

// --------------------------------------------------------------------------- //
// Print orientation — lay the biggest CUT face on the bed. It is guaranteed flat, gives a
// full-area first layer, and leaves the dowel holes running straight up, so they print clean.
// The geometry itself is left in model space (the exploded view has to stay assembled); the
// transform rides along on the piece and is applied when the STL is written.
// --------------------------------------------------------------------------- //
function printOrientation(b, idx, cuts, usable) {
  const size = [0, 1, 2].map(a => b.max[a] - b.min[a]);
  const cand = [];
  for (let a = 0; a < 3; a++) {
    if (!cuts[a].length) continue;
    const o = [0, 1, 2].filter(x => x !== a);
    const area = size[o[0]] * size[o[1]];
    if (idx[a] > 0) cand.push({ a, s: -1, area });                 // cut face on the low side
    if (idx[a] < cuts[a].length) cand.push({ a, s: 1, area });     // ...and on the high side
  }
  cand.sort((x, y) => y.area - x.area || x.a - y.a || x.s - y.s);
  const corner = new THREE.Vector3();
  for (const c of cand) {
    const n = new THREE.Vector3().setComponent(c.a, c.s);
    const q = new THREE.Quaternion().setFromUnitVectors(n, new THREE.Vector3(0, 0, -1));
    const m = new THREE.Matrix4().makeRotationFromQuaternion(q);
    const box = new THREE.Box3();
    for (const x of [b.min[0], b.max[0]]) for (const y of [b.min[1], b.max[1]]) for (const z of [b.min[2], b.max[2]])
      box.expandByPoint(corner.set(x, y, z).applyMatrix4(m));
    const s2 = box.getSize(new THREE.Vector3()).toArray();
    if (!s2.every((v, i) => v <= usable[i] + 1e-3)) continue;      // would not fit standing that way
    const ctr = box.getCenter(new THREE.Vector3());                // drop it on the bed, centred in X/Y
    m.premultiply(new THREE.Matrix4().makeTranslation(-ctr.x, -ctr.y, -box.min.z));
    return { matrix: m, size: s2, axis: c.a, side: c.s };
  }
  return null;
}

// --------------------------------------------------------------------------- //
// Cutting + joints
// pinsByPlane: Map(planeKey -> [{x,y,z,dir}])
// --------------------------------------------------------------------------- //
export async function cutAndConnect(geometry, opts, pinsByPlane, log = () => {}) {
  await initManifold();
  const { Manifold } = wasm;
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox, lo = [bb.min.x, bb.min.y, bb.min.z], hi = [bb.max.x, bb.max.y, bb.max.z];
  const usable = opts.build.map(v => v - 2 * opts.margin);
  // opts.cuts wins when it is there: the user may have dragged a plane off the even split
  const cuts = opts.cuts || [0, 1, 2].map(ax => cutPositions(lo[ax], hi[ax], usable[ax]));

  let cells = new Map([['0,0,0', geometryToManifold(geometry, log)]]);
  log('log.model', { size: hi.map((h, i) => (h - lo[i]).toFixed(1)).join(' × ') });
  for (let ax = 0; ax < 3; ax++) {
    if (!cuts[ax].length) continue;
    const edges = [lo[ax], ...cuts[ax], hi[ax]], next = new Map();
    for (const [key, piece] of cells) {
      const idx = key.split(',').map(Number); let rem = piece;
      for (let seg = 0; seg < edges.length - 1; seg++) {
        let part;
        if (seg < edges.length - 2) {
          const nn = [0, 0, 0]; nn[ax] = -1; part = rem.trimByPlane(nn, -edges[seg + 1]);
          const np = [0, 0, 0]; np[ax] = 1; const nr = rem.trimByPlane(np, edges[seg + 1]);
          rem.delete(); rem = nr;                                  // previous fragment consumed
        } else part = rem;
        if (!part.isEmpty()) { const ni = idx.slice(); ni[ax] = seg; next.set(ni.join(','), part); }
        else part.delete();
      }
    }
    cells = next;
  }
  log('log.cells', { n: cells.size });

  let nDowel = 0; const usedPins = [];
  if (opts.connector !== 'none') {
    for (let ax = 0; ax < 3; ax++) {
      if (!cuts[ax].length) continue;
      const edges = [lo[ax], ...cuts[ax], hi[ax]];
      for (let seg = 0; seg < edges.length - 2; seg++) {
        const coord = edges[seg + 1], key = planeKey(ax, coord), pins = pinsByPlane.get(key) || [];
        // `auto` drills a hole on each side where a pin fits and leaves a flat glue joint where it
        // does not; the pins themselves are exported as their own STLs to print (see pinStock).
        const method = opts.connector === 'auto' ? (pins.length ? 'dowel' : 'none') : opts.connector;
        if (method === 'none') continue;
        for (const p of pins) {
          const pc = [p.x, p.y, p.z], idx = [0, 0, 0];
          for (let a = 0; a < 3; a++) {                      // cell index along the other axes
            if (a === ax || !cuts[a].length) continue;
            const e = [lo[a], ...cuts[a], hi[a]]; let s = 0;
            while (s < e.length - 2 && pc[a] >= e[s + 1]) s++;
            idx[a] = s;
          }
          const kn = (() => { const i = idx.slice(); i[ax] = seg; return i.join(','); })();
          const kp = (() => { const i = idx.slice(); i[ax] = seg + 1; return i.join(','); })();
          if (!cells.has(kn) || !cells.has(kp)) continue;
          const pd = p.d || opts.pinD, holeR = pd / 2 + opts.clearance, pinR = pd / 2;
          const dir = p.dir || (() => { const d = [0, 0, 0]; d[ax] = 1; return d; })();
          const back = dir.map(v => -v), half = opts.pinLen / 2;
          const ch = p.cost !== undefined ? chamferFor(p.cost, pd, opts) : 0.4;     // only as much as the wall spares
          const oldKp = cells.get(kp), oldKn = cells.get(kn);
          if (method === 'dowel') {                        // a hole on each side for your own rod
            const tool = unionAll([
              orientedCone(holeR, holeR, opts.pinLen + 2 * HOLE_FIT, -(half + HOLE_FIT), dir, p),
              ...(ch > 0.05 ? [orientedCone(holeR + ch, holeR, ch, 0, dir, p),
                               orientedCone(holeR + ch, holeR, ch, 0, back, p)] : []),
            ]);
            cells.set(kp, Manifold.difference(oldKp, tool));
            cells.set(kn, Manifold.difference(oldKn, tool));
            tool.delete();
          } else {                                         // printed peg on kn, socket in kp
            const socket = unionAll([
              orientedCone(holeR, holeR, half + HOLE_FIT + 1, -1, dir, p),
              ...(ch > 0.05 ? [orientedCone(holeR + ch, holeR, ch, 0, dir, p)] : []),
            ]);
            cells.set(kp, Manifold.difference(oldKp, socket)); socket.delete();
            const tipR = Math.max(0.3, pinR - ch);
            const peg = unionAll([
              orientedCone(pinR, pinR, opts.pinLen - ch, -half, dir, p),
              ...(ch > 0.05 ? [orientedCone(pinR, tipR, ch, half - ch, dir, p)] : []),
            ]);
            cells.set(kn, Manifold.union(oldKn, peg)); peg.delete();
          }
          oldKp.delete(); oldKn.delete();
          if (method === 'dowel') usedPins.push(pd);            // plug prints its peg into the piece
          nDowel++;
        }
      }
    }
    log('log.joints', { n: nDowel });
  }

  const out = []; let nEng = 0, nSplit = 0, nOri = 0;
  for (const [key, m0] of [...cells].sort()) {
    if (m0.isEmpty()) { m0.delete(); continue; }
    // one cell may contain several DISCONNECTED bodies — split them into separate pieces (each its own number)
    let comps = null; try { comps = m0.decompose(); } catch {}
    let parts;
    if (comps && comps.length > 1) { parts = comps; m0.delete(); nSplit++; }
    else { if (comps) comps.forEach(c => c.delete()); parts = [m0]; }
    parts.forEach((m, pi) => {
      if (m.isEmpty()) { m.delete(); return; }
      let cur = m;
      const b = manifoldBounds(cur);
      const lbl = key.replace(/,/g, '-') + (parts.length > 1 ? `-${pi + 1}` : '');   // sub-index only when split
      if (opts.number) {                          // engrave the grid number (e.g. "0-1-2") with pyramids on the best face
        const r = engrave(cur, lbl); if (r !== cur) { cur.delete(); cur = r; nEng++; }
      }
      const raw = [0, 1, 2].map(a => b.max[a] - b.min[a]);    // engraving is recessed -> bbox unchanged
      const ori = opts.orient === false ? null : printOrientation(b, key.split(',').map(Number), cuts, usable);
      const size = ori ? ori.size : raw;
      if (ori) nOri++;
      out.push({ name: `piece_${lbl}.stl`, geometry: manifoldToGeometry(cur), size,
                 fits: size.every((s, a) => s <= usable[a] + 1e-3),
                 orient: ori ? ori.matrix.elements.slice() : null });
      cur.delete();
    });
  }
  if (nSplit) log('log.split', { n: nSplit });
  if (opts.number) log('log.engraved', { n: nEng, total: out.length });
  if (nOri) log('log.oriented', { n: nOri, total: out.length });
  const nPieces = out.length;
  const stock = usedPins.length ? pinStock(usedPins, opts, usable, [hi[0] + 20, lo[1], lo[2]]) : [];
  for (const s of stock) { out.push(s); log('log.stock', { count: s.count, d: s.d.toFixed(1), len: opts.pinLen, name: s.name }); }
  log(stock.length ? 'log.donePins' : 'log.done', { n: nPieces, pins: usedPins.length });
  out.stats = { pieces: nPieces, joints: nDowel, numbered: !!opts.number, engraved: nEng,
                oriented: nOri, pins: usedPins.length,
                pinSizes: [...new Map(stock.map(s => [s.d, 0])).keys()]
                  .map(d => ({ d, count: stock.filter(s => s.d === d).reduce((a, s) => a + s.count, 0) })) };
  return out;
}
