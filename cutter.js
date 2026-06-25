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
function makeSDF(geometry) {
  const bvh = new MeshBVH(geometry);
  const pos = geometry.attributes.position, idx = geometry.index;
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3(), n = new THREE.Vector3();
  const dir = new THREE.Vector3(), p = new THREE.Vector3(), target = {};
  return function sd(x, y, z) {
    p.set(x, y, z); bvh.closestPointToPoint(p, target);
    const fi = target.faceIndex;
    const i0 = idx ? idx.getX(fi * 3) : fi * 3, i1 = idx ? idx.getX(fi * 3 + 1) : fi * 3 + 1, i2 = idx ? idx.getX(fi * 3 + 2) : fi * 3 + 2;
    a.fromBufferAttribute(pos, i0); b.fromBufferAttribute(pos, i1); c.fromBufferAttribute(pos, i2);
    ab.subVectors(b, a); ac.subVectors(c, a); n.crossVectors(ab, ac).normalize();
    dir.subVectors(p, target.point);
    return (dir.dot(n) < 0 ? 1 : -1) * target.distance;
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
    log(`Auto-repair: -${r.degen} degenerate, -${r.dup} duplicate triangles; patched ${r.holes} holes (+${r.holeTris} triangles)${r.failed ? `, ${r.failed} loops skipped (non-manifold edges remain)` : ''}.`);
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
    if (d.boundary)    why.push(`${d.boundary} boundary edges (holes)`);
    if (d.nonManifold) why.push(`${d.nonManifold} non-manifold edges (3+ faces meet)`);
    if (d.flipped)     why.push(`${d.flipped} edges with inconsistent orientation (flipped normals)`);
    if (!why.length)   why.push('self-intersecting geometry (watertight, but not 2-manifold)');
    throw new Error(`Auto-repair was not enough — remaining: ${why.join(', ')}. ` +
      `Make it solid in Meshmixer "Make Solid" / PrusaSlicer "Repair" / Blender "Make Manifold".`);
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

function materialPoints(sd, lo, hi, axis, coord, requiredSd, halfLen, spacing, step, minWall, cuts) {
  const [au, av] = [0, 1, 2].filter(a => a !== axis); const found = []; let maxSd = 0;
  // don't place a dowel near a perpendicular cut (plane intersection) — it would land on the border of 2 pieces
  const margin = Math.max(requiredSd, spacing / 2);
  const nearCut = (val, arr) => arr && arr.some(cc => Math.abs(val - cc) < margin);
  for (let u = lo[au]; u <= hi[au] + 1e-9; u += step) for (let v = lo[av]; v <= hi[av] + 1e-9; v += step) {
    if (nearCut(u, cuts[au]) || nearCut(v, cuts[av])) continue;
    const c = [0, 0, 0]; c[axis] = coord; c[au] = u; c[av] = v;
    const cs = sd(c[0], c[1], c[2]); if (cs > maxSd) maxSd = cs;
    if (cs < minWall) continue;
    const b = autoDir(sd, c, axis, halfLen, requiredSd);
    if (b.cost >= requiredSd) found.push({ x: c[0], y: c[1], z: c[2], _axis: axis, tilt: b.tilt, az: b.az, cost: b.cost });
  }
  found.sort((p, q) => q.cost - p.cost);
  const chosen = [];
  for (const f of found) if (chosen.every(o => Math.hypot(f.x - o.x, f.y - o.y, f.z - o.z) >= spacing)) chosen.push(f);
  return { chosen, maxSd };
}

export async function planCuts(geometry, opts, log = () => {}) {
  await initManifold();
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox, lo = [bb.min.x, bb.min.y, bb.min.z], hi = [bb.max.x, bb.max.y, bb.max.z];
  const usable = opts.build.map(v => v - 2 * opts.margin);
  if (usable.some(v => v <= 0)) throw new Error('Margin too large for the build volume.');
  const mm = geometryToManifold(geometry, log);
  const clean = manifoldToGeometry(mm); mm.delete();   // consistent normals -> correct sd sign
  const sd = makeSDF(clean);
  const cuts = [0, 1, 2].map(ax => cutPositions(lo[ax], hi[ax], usable[ax]));
  const planes = []; for (let ax = 0; ax < 3; ax++) for (const coord of cuts[ax]) planes.push({ axis: ax, coord });

  const halfLen = opts.pinLen / 2, step = Math.max(1, opts.spacing / 4);
  const needPins = opts.connector === 'auto' || opts.connector === 'dowel' || opts.connector === 'plug';
  const MIN_D = 2.5;
  let maxSd = 0; const pins = new Map(); const planeD = new Map();
  for (const { axis, coord } of planes) {
    const key = planeKey(axis, coord);
    if (!needPins) { pins.set(key, []); continue; }
    let d = opts.pinD, reqSd = d / 2 + opts.clearance + opts.minWall;
    let r = materialPoints(sd, lo, hi, axis, coord, reqSd, halfLen, opts.spacing, step, opts.minWall, cuts);
    if (r.maxSd > maxSd) maxSd = r.maxSd;
    if (!r.chosen.length) {                                    // requested Ø doesn't fit -> shrink to fit
      const fitD = 2 * (r.maxSd - opts.minWall - opts.clearance);
      if (fitD >= MIN_D) {
        d = Math.min(opts.pinD, Math.floor(fitD * 2) / 2);
        reqSd = d / 2 + opts.clearance + opts.minWall;
        r = materialPoints(sd, lo, hi, axis, coord, reqSd, halfLen, opts.spacing, step, opts.minWall, cuts);
      }
    }
    pins.set(key, r.chosen.map(p => ({ ...p, d })));
    if (r.chosen.length) planeD.set(key, d);
  }
  return { lo, hi, usable, cuts, planes, pins, sd, maxWall: 2 * maxSd, planeD };
}

// --------------------------------------------------------------------------- //
// Joint geometry
// --------------------------------------------------------------------------- //
function orientedCylinder(radius, height, dir, p, segments = 32) {
  const { Manifold } = wasm;
  const q = new THREE.Quaternion().setFromUnitVectors(Z(), new THREE.Vector3(dir[0], dir[1], dir[2]).normalize());
  const m = new THREE.Matrix4().compose(new THREE.Vector3(p.x, p.y, p.z), q, new THREE.Vector3(1, 1, 1));
  const cyl = Manifold.cylinder(height, radius, radius, segments, true);
  const out = cyl.transform(mat4(m)); cyl.delete();
  return out;
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
// Cutting + joints
// pinsByPlane: Map(planeKey -> [{x,y,z,dir}])
// --------------------------------------------------------------------------- //
export async function cutAndConnect(geometry, opts, pinsByPlane, log = () => {}) {
  await initManifold();
  const { Manifold } = wasm;
  geometry.computeBoundingBox();
  const bb = geometry.boundingBox, lo = [bb.min.x, bb.min.y, bb.min.z], hi = [bb.max.x, bb.max.y, bb.max.z];
  const usable = opts.build.map(v => v - 2 * opts.margin);
  const cuts = [0, 1, 2].map(ax => cutPositions(lo[ax], hi[ax], usable[ax]));

  let cells = new Map([['0,0,0', geometryToManifold(geometry, log)]]);
  log(`Model: ${hi.map((h, i) => (h - lo[i]).toFixed(1)).join(' x ')} mm`);
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
  log(`Pieces after cutting: ${cells.size}`);

  let nDowel = 0;
  if (opts.connector !== 'none') {
    for (let ax = 0; ax < 3; ax++) {
      if (!cuts[ax].length) continue;
      const edges = [lo[ax], ...cuts[ax], hi[ax]];
      for (let seg = 0; seg < edges.length - 2; seg++) {
        const coord = edges[seg + 1], key = planeKey(ax, coord), pins = pinsByPlane.get(key) || [];
        const method = opts.connector === 'auto' ? (pins.length ? 'dowel' : 'none') : opts.connector;
        if (method === 'none') continue;
        for (const p of pins) {   // dowel (holes) / plug (peg + socket)
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
          const holeTool = orientedCylinder(holeR, opts.pinLen, dir, p);            // hole on the kp side
          const oldKp = cells.get(kp); cells.set(kp, Manifold.difference(oldKp, holeTool)); oldKp.delete(); holeTool.delete();
          const tool = orientedCylinder(method === 'dowel' ? holeR : pinR, opts.pinLen, dir, p);
          const oldKn = cells.get(kn);
          cells.set(kn, method === 'dowel' ? Manifold.difference(oldKn, tool) : Manifold.union(oldKn, tool));
          oldKn.delete(); tool.delete();
          nDowel++;
        }
      }
    }
    log(`Joints: ${nDowel} dowels`);
  }

  const out = []; let nEng = 0, nSplit = 0;
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
      const size = [0, 1, 2].map(a => b.max[a] - b.min[a]);   // engraving is recessed -> bbox unchanged
      out.push({ name: `piece_${lbl}.stl`, geometry: manifoldToGeometry(cur), size, fits: size.every((s, a) => s <= usable[a] + 1e-3) });
      cur.delete();
    });
  }
  if (nSplit) log(`Split ${nSplit} cell(s) with disconnected bodies into separate pieces`);
  if (opts.number) log(`Numbers (dots) engraved: ${nEng}/${out.length} pieces`);
  log(`Done: ${out.length} pieces`);
  out.stats = { pieces: out.length, joints: nDowel, numbered: !!opts.number, engraved: nEng };   // for the UI stat boxes
  return out;
}
