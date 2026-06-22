// cutter.js — planowanie ciec + zlacza (auto: dowel / pioro-wpust), ciecie boolean.
// Boolean + 2D offset: manifold-3d. Signed distance: three-mesh-bvh.
// CHECK = do zweryfikowania wzgledem wersji bibliotek (manifold slice/offset/extrude/transform).

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
function mat4(m) { return Array.from(m.elements); }   // Mat4 kolumnowo (16) — manifold.transform(Mat4)
function rotMat(from, to) {                            // Mat4 obrotu from->to
  const q = new THREE.Quaternion().setFromUnitVectors(from.clone().normalize(), to.clone().normalize());
  return mat4(new THREE.Matrix4().makeRotationFromQuaternion(q));
}

// --------------------------------------------------------------------------- //
// Signed distance (>0 = wewnatrz materialu) — liczony na SPOJNEJ geometrii z manifolda
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
// Kierunek pinu 3D (dla dowel/plug)
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
// Auto = tylko kolki PROSTOPADLE (tilt 0). Kolki pod katem na jednym szwie maja rozne
// kierunki -> kawalkow nie da sie zlozyc (montaz wymaga jednego wspolnego kierunku nasuniecia).
// Spot, gdzie prosty kolek sie nie miesci, zostaje bez kolka (styk na klej).
export const MAX_AUTO_TILT = 0;
export function autoDir(sd, point, ax, halfLen, requiredSd, maxTilt = MAX_AUTO_TILT) {
  const p = [point.x ?? point[0], point.y ?? point[1], point.z ?? point[2]];
  const c0 = sampleMinSD(sd, p, dirFromTiltAz(ax, 0, 0), halfLen);
  if (c0 >= requiredSd) return { tilt: 0, az: 0, cost: c0 };
  let best = { tilt: 0, az: 0, cost: c0 };
  for (const tilt of [15, 30, 45, 60, 70]) {
    if (tilt > maxTilt) break;                  // nie pochylaj kolka „na plasko"
    for (const az of [0, 45, 90, 135, 180, 225, 270, 315]) {
      const cost = sampleMinSD(sd, p, dirFromTiltAz(ax, tilt, az), halfLen);
      if (cost > best.cost) best = { tilt, az, cost };
    }
  }
  return best;
}

// --------------------------------------------------------------------------- //
// Konwersje three <-> manifold
// --------------------------------------------------------------------------- //
// Zgrzewa wierzcholki TYLKO po pozycji (tolerancja). STL trzyma osobna normale na
// trojkat, wiec mergeVertices na pelnej geometrii nie sklei wspolnych wierzcholkow —
// rozbieramy do samej pozycji, dopiero potem zgrzewamy.
function weldByPosition(geometry, tol = 1e-4) {
  const bare = new THREE.BufferGeometry();
  bare.setAttribute('position', geometry.getAttribute('position').clone());
  if (geometry.index) bare.setIndex(geometry.index.clone());
  return mergeVertices(bare, tol);
}

// Diagnostyka topologii na zgrzewanej, indeksowanej geometrii: rozroznia dziury,
// krawedzie non-manifold (3+ trojkatow) i niespojna orientacje (odwrocone normalne).
function analyzeTopology(welded) {
  const idx = welded.index.array, triCount = idx.length / 3, n = welded.attributes.position.count;
  const edges = new Map(), half = new Map();          // klucze numeryczne: a*n+b
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
    const a = Math.floor(u / n), b = u % n;            // c === 2 -> sprawdz winding
    if ((half.get(a * n + b) || 0) !== 1 || (half.get(b * n + a) || 0) !== 1) flipped++;
  }
  return { boundary, nonManifold, flipped };
}

// Proba auto-naprawy "prawie manifold": usuwa zdegenerowane i zdublowane trojkaty
// (typowe zrodlo krawedzi non-manifold) oraz lata male dziury wachlarzem po petli
// brzegowej z zachowaniem orientacji. Dziala na zgrzewanej, indeksowanej geometrii.
function repairTopology(welded) {
  const posAttr = welded.attributes.position, n = posAttr.count, src = welded.index.array;
  let degen = 0, dup = 0;
  const seen = new Set(), faces = [];
  for (let t = 0; t < src.length; t += 3) {
    const a = src[t], b = src[t + 1], c = src[t + 2];
    if (a === b || b === c || a === c) { degen++; continue; }                 // zerowa powierzchnia
    const s = [a, b, c].sort((x, y) => x - y), key = s[0] + ',' + s[1] + ',' + s[2];
    if (seen.has(key)) { dup++; continue; }                                   // identyczny trojkat (po wierzcholkach)
    seen.add(key); faces.push(a, b, c);
  }
  // krawedzie skierowane -> brzegowa = polowka bez przeciwnej
  const dir = new Set();
  for (let t = 0; t < faces.length; t += 3) { const a = faces[t], b = faces[t + 1], c = faces[t + 2]; dir.add(a * n + b); dir.add(b * n + c); dir.add(c * n + a); }
  const next = new Map();
  for (const e of dir) { const a = Math.floor(e / n), b = e % n; if (!dir.has(b * n + a)) next.set(a, b); }
  // lancuchuj petle brzegowe i lataj wachlarzem (v0, v[i+1], v[i]) — odwrotnosc krawedzi brzegowych
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
    log(`Auto-naprawa: -${r.degen} zdegen., -${r.dup} zdublowanych trojkatow; zalatano ${r.holes} dziur (+${r.holeTris} trojkatow)${r.failed ? `, ${r.failed} petli pominieto (zostaja krawedzie non-manifold)` : ''}.`);
  const idx = fixed.index.array;
  const triVerts = idx instanceof Uint32Array ? idx : new Uint32Array(idx);
  const mesh = new Mesh({ numProp: 3, vertProperties: new Float32Array(fixed.attributes.position.array), triVerts });
  mesh.merge();
  let m, bad = false;
  try {
    m = Manifold.ofMesh(mesh);
    const status = typeof m.status === 'function' ? m.status() : (m.status ?? 0);
    if (m.isEmpty() || m.numTri() === 0 || (status && status !== 0 && status !== 'NoError')) bad = true; // numTri() wymusza ewaluacje (manifold jest leniwy)
  } catch { bad = true; }
  mesh.delete?.();   // dane Mesh juz przekopiowane do manifolda
  if (bad) {
    const d = analyzeTopology(fixed), why = [];
    if (d.boundary)    why.push(`${d.boundary} krawedzi brzegowych (dziury)`);
    if (d.nonManifold) why.push(`${d.nonManifold} krawedzi non-manifold (styki 3+ scian)`);
    if (d.flipped)     why.push(`${d.flipped} krawedzi z niespojna orientacja (odwrocone normalne)`);
    if (!why.length)   why.push('samoprzecinajaca sie geometria (watertight, ale nie 2-manifold)');
    throw new Error(`Auto-naprawa nie wystarczyla — zostalo: ${why.join(', ')}. ` +
      `Domknij w Meshmixer „Make Solid" / PrusaSlicer „Napraw" / Blender „Make Manifold".`);
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
// Plany ciec + auto-piny
// --------------------------------------------------------------------------- //
function cutPositions(lo, hi, usable) {
  const n = Math.max(1, Math.ceil((hi - lo) / usable)); if (n === 1) return [];
  const step = (hi - lo) / n, out = []; for (let k = 1; k < n; k++) out.push(lo + step * k); return out;
}
export function planeKey(axis, coord) { return `${axis},${coord.toFixed(3)}`; }

function materialPoints(sd, lo, hi, axis, coord, requiredSd, halfLen, spacing, step, minWall, cuts) {
  const [au, av] = [0, 1, 2].filter(a => a !== axis); const found = []; let maxSd = 0;
  // nie stawiaj kolka blisko prostopadlego ciecia (przeciecia plaszczyzn) — kolek wpadlby na granice 2 kawalkow
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
  if (usable.some(v => v <= 0)) throw new Error('Margines za duzy wzgledem pola roboczego.');
  const mm = geometryToManifold(geometry, log);
  const clean = manifoldToGeometry(mm); mm.delete();   // spojne normalne -> dobry znak sd
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
    if (!r.chosen.length) {                                    // zadane Ø sie nie miesci -> dopasuj w dol
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
// Geometria zlaczy
// --------------------------------------------------------------------------- //
function orientedCylinder(radius, height, dir, p, segments = 32) {
  const { Manifold } = wasm;
  const q = new THREE.Quaternion().setFromUnitVectors(Z(), new THREE.Vector3(dir[0], dir[1], dir[2]).normalize());
  const m = new THREE.Matrix4().compose(new THREE.Vector3(p.x, p.y, p.z), q, new THREE.Vector3(1, 1, 1));
  const cyl = Manifold.cylinder(height, radius, radius, segments, true);
  const out = cyl.transform(mat4(m)); cyl.delete();
  return out;
}

// pioro + wpust z przekroju ELEMENTU `cell` na plaszczyznie ax=coord
function tongueGroove(cell, ax, coord, faceGap, width, clearance, depth) {
  const fwd = rotMat(axisVec(ax), Z()), inv = rotMat(Z(), axisVec(ax));   // os <-> Z
  const rotated = cell.transform(fwd);
  const section = rotated.slice(coord - 0.05); rotated.delete();   // przekroj sciany przy plaszczyznie styku
  if (section.isEmpty()) { section.delete(); return null; }
  const outer = section.offset(-faceGap); section.delete();        // odsuniecie od zewn. krawedzi
  if (outer.isEmpty()) { outer.delete(); return null; }            // za cienko -> klej
  const innerOff = outer.offset(-width);
  const tProf = outer.subtract(innerOff); innerOff.delete(); outer.delete();   // LIP wzdluz obrysu
  if (tProf.isEmpty()) { tProf.delete(); return null; }
  const tExt = tProf.extrude(depth, 0, 0, 1, true);
  const tongueZ = tExt.translate([0, 0, coord]); tExt.delete();
  const gOff = tProf.offset(clearance);
  const gExt = gOff.extrude(depth + 1, 0, 0, 1, true); gOff.delete();
  const grooveZ = gExt.translate([0, 0, coord]); gExt.delete(); tProf.delete();
  const tongue = tongueZ.transform(inv); tongueZ.delete();
  const groove = grooveZ.transform(inv); grooveZ.delete();
  return { tongue, groove };
}

// --------------------------------------------------------------------------- //
// Numerowanie kawalkow — wygrawerowany (wglebiony) numer siatki na scianie ciecia
// --------------------------------------------------------------------------- //
// cyfry jako matryca 3x5 kropek (wiercone punkty — lepsze do druku niz cienkie rowki).
const DOT_DIGITS = {
  '0': ['111', '101', '101', '101', '111'], '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'], '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'], '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'], '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'], '9': ['111', '101', '111', '001', '111'],
};
// pozycje kropek [kolumna, rzad] w jednostkach pitch; u w prawo, v w gore. '-' = przerwa.
function dotPositions(label) {
  const dots = []; let col = 0, maxCol = 0;
  for (const ch of label) {
    if (ch === '-') { col += 2; continue; }                 // separator osi = wieksza przerwa
    const g = DOT_DIGITS[ch]; if (!g) { col += 4; continue; }
    for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++)
      if (g[r][c] === '1') dots.push([col + c, 4 - r]);      // rzad 0 = gora -> v=4
    col += 4; maxCol = col;                                  // 3 kolumny + 1 przerwa
  }
  return { dots, cols: Math.max(0, maxCol - 1), rows: 5 };   // szerokosc w pitch; wysokosc = 4 odstepy
}
// plaska sciana ciecia kawalka: { ax, coord, into } (into = w glab bryly)
function pickEngraveFace(idx, cuts, lo, hi) {
  for (let ax = 0; ax < 3; ax++) {
    if (!cuts[ax].length) continue;
    const e = [lo[ax], ...cuts[ax], hi[ax]];
    if (idx[ax] > 0) return { ax, coord: e[idx[ax]], into: 1 };
    if (idx[ax] < cuts[ax].length) return { ax, coord: e[idx[ax] + 1], into: -1 };
  }
  return null;
}
// wywierc numer kropkami na scianie `face`; zwraca nowy manifold lub niezmieniony m
function engrave(m, label, face, bounds, depth = 1.0) {
  const { Manifold } = wasm;
  const [au, av] = [0, 1, 2].filter(a => a !== face.ax);
  const ea = bounds.max[au] - bounds.min[au], eb = bounds.max[av] - bounds.min[av];
  const long = ea >= eb ? au : av, short = ea >= eb ? av : au;            // numer wzdluz dluzszego boku
  const faceLong = Math.max(ea, eb), faceShort = Math.min(ea, eb);
  const { dots, cols, rows } = dotPositions(label);
  if (!dots.length) return m;
  let pitch = Math.min(faceLong * 0.8 / Math.max(cols, 1), faceShort * 0.7 / (rows - 1), 3.0);
  if (pitch < 1.2) return m;                                              // za waska sciana -> bez numeru
  const dotR = Math.max(0.6, Math.min(pitch * 0.32, 1.4));
  const dir = [0, 0, 0]; dir[face.ax] = face.into;
  const cLong = (bounds.min[long] + bounds.max[long]) / 2, cShort = (bounds.min[short] + bounds.max[short]) / 2;
  const halfW = cols * pitch / 2, halfH = (rows - 1) * pitch / 2, ax3 = 'xyz';
  let tool = null;
  for (const [u, v] of dots) {
    const p = { x: 0, y: 0, z: 0 };
    p[ax3[face.ax]] = face.coord;
    p[ax3[long]] = cLong - halfW + u * pitch;
    p[ax3[short]] = cShort - halfH + v * pitch;
    const cyl = orientedCylinder(dotR, depth * 2, dir, p, 16);            // h=2*depth, srodek na scianie -> dolek gleboki na depth
    if (!tool) tool = cyl; else { const j = Manifold.union(tool, cyl); tool.delete(); cyl.delete(); tool = j; }
  }
  if (!tool) return m;
  let res; try { res = Manifold.difference(m, tool); } catch { tool.delete(); return m; }
  tool.delete();
  return res;
}

// --------------------------------------------------------------------------- //
// Ciecie + zlacza
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
          rem.delete(); rem = nr;                                  // poprzedni fragment zuzyty
        } else part = rem;
        if (!part.isEmpty()) { const ni = idx.slice(); ni[ax] = seg; next.set(ni.join(','), part); }
        else part.delete();
      }
    }
    cells = next;
  }
  log(`Kawalkow po cieciu: ${cells.size}`);

  if (opts.connector !== 'none') {
    const faceGap = Math.max(0.6, opts.clearance + 0.4), tongueW = 3, depth = Math.min(opts.pinLen, 6);
    let nDowel = 0, nTng = 0, nThin = 0;

    for (let ax = 0; ax < 3; ax++) {
      if (!cuts[ax].length) continue;
      const edges = [lo[ax], ...cuts[ax], hi[ax]];
      for (let seg = 0; seg < edges.length - 2; seg++) {
        const coord = edges[seg + 1], key = planeKey(ax, coord), pins = pinsByPlane.get(key) || [];
        const method = opts.connector === 'auto' ? (pins.length ? 'dowel' : 'none')
                     : opts.connector === 'tongue' ? 'tongue' : opts.connector;

        if (method === 'tongue') {
          for (const [k] of [...cells]) {
            const idx = k.split(',').map(Number); if (idx[ax] !== seg) continue;
            const pidx = idx.slice(); pidx[ax] = seg + 1; const pk = pidx.join(',');
            if (!cells.has(pk)) continue;
            const tg = tongueGroove(cells.get(k), ax, coord, faceGap, tongueW, opts.clearance, depth);
            if (!tg) { nThin++; continue; }
            const oldK = cells.get(k); cells.set(k, Manifold.union(oldK, tg.tongue)); oldK.delete();
            const oldPk = cells.get(pk); cells.set(pk, Manifold.difference(oldPk, tg.groove)); oldPk.delete();
            tg.tongue.delete(); tg.groove.delete();
            nTng++;
          }
        } else { // dowel / plug
          for (const p of pins) {
            const pc = [p.x, p.y, p.z], idx = [0, 0, 0];
            for (let a = 0; a < 3; a++) {                      // indeks komorki wzdluz innych osi
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
            const holeTool = orientedCylinder(holeR, opts.pinLen, dir, p);            // otwor po stronie kp
            const oldKp = cells.get(kp); cells.set(kp, Manifold.difference(oldKp, holeTool)); oldKp.delete(); holeTool.delete();
            const tool = orientedCylinder(method === 'dowel' ? holeR : pinR, opts.pinLen, dir, p);
            const oldKn = cells.get(kn);
            cells.set(kn, method === 'dowel' ? Manifold.difference(oldKn, tool) : Manifold.union(oldKn, tool));
            oldKn.delete(); tool.delete();
            nDowel++;
          }
        }
      }
    }
    log(`Zlacza: ${nDowel} kolkow, ${nTng} pioro-wpust${nThin ? `, ${nThin} styk za cienki (klej)` : ''}`);
  }

  const out = []; let nEng = 0;
  for (const [key, m0] of [...cells].sort()) {
    let m = m0;
    if (m.isEmpty()) { m.delete(); continue; }
    const b = manifoldBounds(m);
    if (opts.number) {                            // wywierc numer siatki (np. "0-1-2") kropkami na scianie ciecia
      const face = pickEngraveFace(key.split(',').map(Number), cuts, lo, hi);
      if (face) { const m2 = engrave(m, key.replace(/,/g, '-'), face, b); if (m2 !== m) { m.delete(); m = m2; nEng++; } }
    }
    const size = [0, 1, 2].map(a => b.max[a] - b.min[a]);   // grawer jest wglebny -> bbox bez zmian
    out.push({ name: `piece_${key.replace(/,/g, '-')}.stl`, geometry: manifoldToGeometry(m), size, fits: size.every((s, a) => s <= usable[a] + 1e-3) });
    m.delete();
  }
  if (opts.number) log(`Numery (kropki) wywiercone: ${nEng}/${out.length} kawalkow`);
  log(`Gotowe: ${out.length} kawalkow`);
  return out;
}
