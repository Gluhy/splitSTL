// app.js — UI, three.js scene, interactive 3D pin editing, export.
import * as THREE from 'three';
import { STLLoader }    from 'three/addons/loaders/STLLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLExporter }  from 'three/addons/exporters/STLExporter.js';
import { zipSync } from 'fflate';
import { PRESETS } from './presets.js';
import { t, setLang, getLang, LANGS } from './i18n.js';
import { planCuts, cutAndConnect, planeKey, dirFromTiltAz, pinFit, fitDiameter, planPlane, MIN_D, HOLE_FIT } from './cutter.js';

const $ = id => document.getElementById(id);
const log = (key, p) => { const el = $('log'); if (!el) return; el.textContent += t(key, p) + '\n'; el.scrollTop = 1e9; };
addEventListener('error', e => log('log.jsError', { msg: e.message || e.error }));
addEventListener('unhandledrejection', e => log('log.promiseError', { msg: e.reason?.message || e.reason }));
const AXIS_COLOR = [0xff5555, 0x55ff7f, 0x5599ff];
const PALETTE = [0x4caf50, 0x2196f3, 0xff9800, 0xe91e63, 0x9c27b0, 0x00bcd4, 0xcddc39, 0xff5722];

// ----- scene -----
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.localClippingEnabled = true;   // model section in edit mode (preview the interior)
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x15171b);
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 8000);
camera.position.set(200, 160, 200);
const controls = new OrbitControls(camera, canvas);
scene.add(new THREE.AmbientLight(0xffffff, 0.65));
const dl = new THREE.DirectionalLight(0xffffff, 0.8); dl.position.set(1, 1.4, 0.8); scene.add(dl);
const modelGroup = new THREE.Group(), planeGroup = new THREE.Group(),
      pinGroup = new THREE.Group(), arrowGroup = new THREE.Group(), pieceGroup = new THREE.Group();
scene.add(modelGroup, planeGroup, pinGroup, arrowGroup, pieceGroup);

// ----- GPU resource hygiene -----
// Group.clear() only unlinks children: their geometries, materials and canvas textures stay
// on the GPU until something calls dispose(). Re-cutting a model leaked ~53 geometries and one
// label texture per piece, every time. KEEP holds the resources shared between objects — three
// keeps ONE geometry behind every ArrowHelper and every Sprite, so disposing them per object
// would yank the buffers out from under all the others.
const KEEP = new Set();
function disposeObject(root) {
  root.traverse(n => {
    if (n.geometry && !KEEP.has(n.geometry)) n.geometry.dispose();
    const mats = Array.isArray(n.material) ? n.material : n.material ? [n.material] : [];
    for (const m of mats) {
      if (KEEP.has(m)) continue;
      if (m.map) m.map.dispose();
      m.dispose();
    }
  });
}
function clearGroup(g) { for (const c of [...g.children]) disposeObject(c); g.clear(); }

// One sphere and two materials for every pin marker — there used to be a set per pin.
const PIN_GEO = new THREE.SphereGeometry(1, 16, 12);
const PIN_OK = new THREE.MeshBasicMaterial({ color: 0x37d67a });
const PIN_BAD = new THREE.MeshBasicMaterial({ color: 0xff4d4d });
[PIN_GEO, PIN_OK, PIN_BAD].forEach(r => KEEP.add(r));

// ----- state ----- (before the render loop — updateClip() reaches into S on frame 1)
const S = { geometry: null, plan: null, sd: null, pins: new Map(),
            pieces: null, pieceMeshes: [], pieceLabels: [], mode: 'view', activeKey: null,
            dragging: null, dragPlane: null, planeMarked: false, selected: null, modelMat: null, clip: new THREE.Plane(),
            lastHover: null, planOpts: null };

function resize() {
  const w = canvas.parentElement.clientWidth, h = canvas.parentElement.clientHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();
(function loop(){ requestAnimationFrame(loop); controls.update(); updateClip(); renderer.render(scene, camera); })();

// In edit mode, clip the model with the active plane on the camera side -> shows the section and interior.
const _clipN = new THREE.Vector3();
function updateClip() {
  if (!S.modelMat) return;
  const pl = (S.mode === 'edit' && S.plan) ? activePlaneObj() : null;
  const want = pl ? 1 : 0, cur = S.modelMat.clippingPlanes?.length ?? 0;   // clippingPlanes defaults to null
  if (cur !== want) {       // changing the plane count = shader recompile
    S.modelMat.clippingPlanes = pl ? [S.clip] : null;
    S.modelMat.needsUpdate = true;
  }
  if (pl) {
    const ax = pl.userData.axis;
    const s = camera.position.getComponent(ax) > pl.userData.coord ? -1 : 1;   // normal points away from camera -> hides the half nearer the eye
    _clipN.set(0, 0, 0).setComponent(ax, s);
    S.clip.setFromNormalAndCoplanarPoint(_clipN, pl.position);
  }
}

function frame(obj) {
  const box = new THREE.Box3().setFromObject(obj); if (box.isEmpty()) return;
  const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
  controls.target.copy(c);
  camera.position.copy(c).add(new THREE.Vector3(1, 0.8, 1).multiplyScalar(s.length()));
}

function opts() {
  return { build: [+$('bx').value, +$('by').value, +$('bz').value],
    margin: +$('margin').value, connector: $('connector').value,
    pinD: +$('pinD').value, pinLen: +$('pinLen').value,
    clearance: +$('clearance').value, minWall: +$('minWall').value, spacing: +$('spacing').value,
    number: $('number').checked, orient: $('orient').checked, seamSearch: $('seamSearch').checked };
}
const reqSdFor = d => d / 2 + +$('clearance').value + +$('minWall').value;
const halfLen = () => +$('pinLen').value / 2 + HOLE_FIT;   // fit is judged over the DEEPER hole
const dirOf   = p => dirFromTiltAz(p._axis, p.tilt, p.az);
const clampD = v => Math.min(20, Math.max(2.5, Math.round(v * 2) / 2));
// Picks pin Ø and 3D angle for a point on the plane (used both when adding and in the preview).
// Auto Ø comes from the tightest spot along the pin — the same measure `validate()` uses,
// so the green/red preview and the Ø it offers can never disagree.
function pinSpecAt(hit, axis) {
  const f = pinFit(S.sd, hit, axis, halfLen());
  const d = $('manualD').checked                       // manual: exactly the chosen Ø (mix sizes freely)
    ? clampD(+$('pinD').value)
    : (fitDiameter(f.minSd, opts()) || MIN_D);         // nothing fits -> offer the smallest, shown red
  return { d, tilt: f.tilt, az: f.az, minSd: f.minSd };
}

// ----- presets -----
// cutter.js has no dictionary, so it tags its errors with a key and the pieces to fill in
function errText(err) {
  if (!err.key) return err.message;
  const p = err.parts ? { why: err.parts.map(([k, q]) => t(k, q)).join(', ') } : undefined;
  return t(err.key, p);
}

// ----- language -----
function applyLang(l) {
  setLang(l);
  try { localStorage.setItem('stlcutter.lang', l); } catch {}
  document.documentElement.lang = l;
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-html]')) el.innerHTML = t(el.dataset.i18nHtml);
  for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
  $('editToggle').textContent = t(S.mode === 'edit' ? 'edit.on' : 'edit.off');
  if (S.pieces) showPieces();                              // stats and the piece list are built strings
}
LANGS.forEach(([id, name]) => $('lang').add(new Option(name, id)));
$('lang').value = (() => {
  try { const v = localStorage.getItem('stlcutter.lang'); if (v) return v; } catch {}
  return navigator.language?.startsWith('pl') ? 'pl' : 'en';
})();
$('lang').onchange = () => applyLang($('lang').value);
applyLang($('lang').value);

// ----- joint diagram: hovering a pin setting lights up the dimension it controls -----
(function wireDiagram() {
  const fig = $('pinDiagram'); if (!fig) return;
  const dims = [...fig.querySelectorAll('.dim')];
  const light = k => dims.forEach(g => g.classList.toggle('on', g.dataset.k === k));
  for (const k of ['pinD', 'pinLen', 'clearance', 'minWall', 'spacing']) {
    const el = $(k), box = el.parentElement;
    for (const ev of ['pointerenter', 'focus']) box.addEventListener(ev, () => light(k), true);
    for (const ev of ['pointerleave', 'blur']) box.addEventListener(ev, () => light(null), true);
  }
})();

const DIM = ['bx', 'by', 'bz'];
(function fillPresets() {                                 // grouped by brand — the flat list got long
  const sel = $('preset'), groups = new Map();
  for (const p of PRESETS) {
    const opt = new Option(p.brand ? `${p.name} — ${p.build.join('×')}` : p.name, p.id);
    if (!p.brand) { sel.add(opt); continue; }
    if (!groups.has(p.brand)) { const g = document.createElement('optgroup'); g.label = p.brand; groups.set(p.brand, g); sel.add(g); }
    groups.get(p.brand).appendChild(opt);
  }
})();
$('preset').value = 'p1s';
$('preset').onchange = () => {
  const p = PRESETS.find(x => x.id === $('preset').value);
  if (p && p.id !== 'custom') DIM.forEach((id, i) => $(id).value = p.build[i]);
};
$('preset').onchange();
// once the numbers are typed by hand they are not that printer any more
DIM.forEach(id => $(id).addEventListener('input', () => {
  const p = PRESETS.find(x => x.id === $('preset').value);
  if (p && p.id !== 'custom' && p.build.some((v, i) => v !== +$(DIM[i]).value)) $('preset').value = 'custom';
}));

// ----- load STL -----
async function loadFile(f) {
  try {
    $('log').textContent = ''; log('log.loading', { name: f.name, kb: (f.size / 1024).toFixed(0) });
    const geo = new STLLoader().parse(await f.arrayBuffer());
    if (!geo.attributes.position) throw new Error(t('err.noGeometry'));
    geo.center();
    S.geometry = geo; S.plan = null; S.pieces = null; $('stats').innerHTML = ''; $('pieceList').innerHTML = '';
    [modelGroup, planeGroup, pinGroup, arrowGroup, pieceGroup].forEach(clearGroup);   // frees the old model material too
    S.pins = new Map(); selectPin(null);
    S.modelMat = new THREE.MeshStandardMaterial({ color: 0x6b7785, flatShading: true, side: THREE.DoubleSide });   // DoubleSide -> interior walls visible after sectioning
    modelGroup.add(new THREE.Mesh(geo, S.modelMat));
    frame(modelGroup);
    $('plan').disabled = false; $('cut').disabled = true; $('download').disabled = true;
    setMode('view'); $('editToggle').disabled = true;
    log('log.loaded', { tris: (geo.attributes.position.count / 3).toFixed(0) });
  } catch (err) { log('log.loadError', { msg: err.message }); console.error(err); }
}
$('file').onchange = e => e.target.files[0] && loadFile(e.target.files[0]);
canvas.parentElement.addEventListener('dragover', e => e.preventDefault());
canvas.parentElement.addEventListener('drop', e => {
  e.preventDefault(); const f = [...e.dataTransfer.files].find(x => /\.stl$/i.test(x.name)); if (f) loadFile(f);
});

// ----- planning -----
$('plan').onclick = async () => {
  $('plan').disabled = true;
  try {
    S.planOpts = opts();                                   // the cut must use the settings the pins were placed with
    history.past.length = 0; history.future.length = 0;
    S.plan = await planCuts(S.geometry, S.planOpts, log);
    S.sd = S.plan.sd;
    buildPlanes(); buildPinsFromPlan(); selectPin(null);
    clearGroup(pieceGroup); $('stats').innerHTML = '';
    modelGroup.visible = planeGroup.visible = pinGroup.visible = arrowGroup.visible = true;
    $('editToggle').disabled = false; $('cut').disabled = false; $('download').disabled = true;
    let n = 0; S.pins.forEach(a => n += a.length);
    const o = opts();
    log('log.plan', { planes: S.plan.planes.length, pins: n });
    if (S.plan.maxWall > 0) {
      const maxD = S.plan.maxWall - 2 * (o.minWall + o.clearance);
      log('log.maxWall', { wall: S.plan.maxWall.toFixed(1), d: Math.max(0, maxD).toFixed(1) });
    }
    const ds = [...new Set([...S.pins.values()].flat().map(p => p.d))].sort((a, b) => a - b);
    if (ds.length) log('log.used', { list: ds.map(d => d.toFixed(1)).join(', ') });
    if (o.connector !== 'none') log(n ? 'log.mixed' : 'log.noPins');
  } catch (err) { log('log.error', { msg: errText(err) }); console.error(err); }
  $('plan').disabled = false;
};

function buildPlanes() {
  clearGroup(planeGroup); $('activePlane').innerHTML = '';
  const { lo, hi, planes } = S.plan;
  planes.forEach(pl => {
    const [au, av] = [0, 1, 2].filter(a => a !== pl.axis);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(hi[au] - lo[au], hi[av] - lo[av]),
      new THREE.MeshBasicMaterial({ color: AXIS_COLOR[pl.axis], transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
    if (pl.axis === 0) mesh.rotation.y = Math.PI / 2; else if (pl.axis === 1) mesh.rotation.x = Math.PI / 2;
    const ctr = [0, 0, 0]; ctr[pl.axis] = pl.coord; ctr[au] = (lo[au] + hi[au]) / 2; ctr[av] = (lo[av] + hi[av]) / 2;
    mesh.position.set(...ctr);
    mesh.userData = { key: planeKey(pl.axis, pl.coord), axis: pl.axis, coord: pl.coord };
    const edge = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry),   // outline of the cut region -> shows where you're aiming
      new THREE.LineBasicMaterial({ color: AXIS_COLOR[pl.axis], transparent: true, opacity: 0.9 }));
    mesh.add(edge); mesh.userData.edge = edge;
    planeGroup.add(mesh);
    $('activePlane').add(new Option(`${['X', 'Y', 'Z'][pl.axis]} @ ${pl.coord.toFixed(1)}`, mesh.userData.key));
  });
  S.activeKey = planeGroup.children[0]?.userData.key ?? null;
  $('activePlane').value = S.activeKey ?? ''; highlightActive();
}
$('activePlane').onchange = () => { S.activeKey = $('activePlane').value; highlightActive(); };
function highlightActive() {
  const edit = S.mode === 'edit';
  planeGroup.children.forEach(m => {
    const active = m.userData.key === S.activeKey;
    m.visible = active || !edit;                                               // while editing show only the active plane
    m.material.opacity = active ? (edit ? 0.34 : 0.26) : 0.1;
    if (m.userData.edge) m.userData.edge.material.opacity = active ? 0.9 : 0.35;
  });
  buildSection(); buildCutLines(); updatePinVisibility();
}
// While editing, show only the pins on the active plane — hide the ones on other planes/axes.
function updatePinVisibility() {
  const edit = S.mode === 'edit';
  for (const [key, arr] of S.pins) { const show = !edit || key === S.activeKey; for (const p of arr) { p.mesh.visible = show; p.arrow.visible = show; } }
}

// Where the OTHER (perpendicular) cut planes cross the active plane — piece borders; don't put a pin on them.
const cutLines = new THREE.LineSegments(new THREE.BufferGeometry(),
  new THREE.LineDashedMaterial({ color: 0xff3df0, transparent: true, opacity: 0.9, depthTest: false, dashSize: 3, gapSize: 2 }));
cutLines.renderOrder = 996; cutLines.visible = false; scene.add(cutLines);
function buildCutLines() {
  const pl = (S.mode === 'edit' && S.plan) ? activePlaneObj() : null;
  if (!pl) { cutLines.visible = false; return; }
  const ax = pl.userData.axis, coord = pl.userData.coord, { lo, hi, cuts } = S.plan, pts = [];
  const inPlane = [0, 1, 2].filter(a => a !== ax);
  for (const a of inPlane) {                                   // perpendicular cuts along this in-plane axis...
    const b = inPlane.find(x => x !== a);                      // ...draw a line spanning the other in-plane axis
    for (const c of cuts[a]) {
      const p0 = [0, 0, 0], p1 = [0, 0, 0];
      p0[ax] = p1[ax] = coord; p0[a] = p1[a] = c; p0[b] = lo[b]; p1[b] = hi[b];
      pts.push(...p0, ...p1);
    }
  }
  cutLines.geometry.dispose();
  cutLines.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  cutLines.computeLineDistances(); cutLines.visible = pts.length > 0;
}

// Section outline: the contour where the active plane intersects the model mesh.
const sectionLines = new THREE.LineSegments(new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: 0xffe066, transparent: true, opacity: 0.95, depthTest: false }));
sectionLines.renderOrder = 997; sectionLines.visible = false; scene.add(sectionLines);
function buildSection() {
  const pl = (S.mode === 'edit' && S.plan) ? activePlaneObj() : null;
  if (!pl || !S.geometry) { sectionLines.visible = false; return; }
  const ax = pl.userData.axis, coord = pl.userData.coord, arr = S.geometry.attributes.position.array, pts = [];
  for (let o = 0; o < arr.length; o += 9) {                  // triangle = 9 floats (non-indexed STL)
    const seg = [];
    for (let e = 0; e < 3; e++) {                            // 3 triangle edges
      const i = o + e * 3, j = o + ((e + 1) % 3) * 3, dp = arr[i + ax] - coord, dq = arr[j + ax] - coord;
      if ((dp >= 0) === (dq >= 0)) continue;                 // edge doesn't cross the plane
      const t = dp / (dp - dq);
      const p = [arr[i] + (arr[j] - arr[i]) * t, arr[i + 1] + (arr[j + 1] - arr[i + 1]) * t, arr[i + 2] + (arr[j + 2] - arr[i + 2]) * t];
      p[ax] = coord; seg.push(p);
    }
    if (seg.length === 2) pts.push(...seg[0], ...seg[1]);    // two intersections -> a contour segment
  }
  sectionLines.geometry.dispose();
  sectionLines.geometry = new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  sectionLines.visible = pts.length > 0;
}

// ----- pins: visualization -----
function addPinVisual(p) {
  p.mesh = new THREE.Mesh(PIN_GEO, PIN_OK);                      // unit sphere scaled by Ø -> size changeable live
  p.arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 1, 0x37d67a);
  KEEP.add(p.arrow.line.geometry).add(p.arrow.cone.geometry);    // three shares these across all arrows
  pinGroup.add(p.mesh); arrowGroup.add(p.arrow);
  updatePinVisual(p);
}
function updatePinVisual(p) {
  const ok = validate(p), col = ok ? 0x37d67a : 0xff4d4d, hl = halfLen();
  const r = Math.max(1.2, (p.d || +$('pinD').value) / 2) * (S.selected === p ? 1.6 : 1);
  p.mesh.position.set(p.x, p.y, p.z); p.mesh.scale.setScalar(r); p.mesh.material = ok ? PIN_OK : PIN_BAD;
  const d = new THREE.Vector3(...dirOf(p)).normalize();
  p.arrow.position.set(p.x, p.y, p.z).addScaledVector(d, -hl);
  p.arrow.setDirection(d); p.arrow.setLength(hl * 2, Math.min(5, hl), Math.min(3.5, hl * 0.7)); p.arrow.setColor(col);
}
// Tightest wall along the whole pin — the one measure that decides whether a pin fits,
// how big it may be and how much lead-in its hole gets.
function minSdOf(p) {
  const d = dirOf(p), hl = halfLen(); let m = Infinity;
  for (const t of [-hl, -hl / 2, 0, hl / 2, hl]) {
    const v = S.sd(p.x + d[0] * t, p.y + d[1] * t, p.z + d[2] * t); if (v < m) m = v;
  }
  return m;
}
function validate(p) { return minSdOf(p) >= reqSdFor(p.d || +$('pinD').value); }
function buildPinsFromPlan() {
  clearGroup(pinGroup); clearGroup(arrowGroup); S.pins = new Map();
  for (const [key, pts] of S.plan.pins) {
    const arr = pts.map(pt => { const p = { ...pt }; addPinVisual(p); return p; });
    S.pins.set(key, arr);
  }
}
function findPin(mesh) { for (const arr of S.pins.values()) { const r = arr.find(p => p.mesh === mesh); if (r) return r; } return null; }
function removePin(ref) {
  for (const arr of S.pins.values()) {
    const i = arr.indexOf(ref);
    if (i < 0) continue;
    arr.splice(i, 1);
    pinGroup.remove(ref.mesh); arrowGroup.remove(ref.arrow); disposeObject(ref.arrow);
    if (S.selected === ref) selectPin(null);
    return;
  }
}

// ----- selection + angle/Ø sliders -----
function selectPin(p) {
  const prev = S.selected; S.selected = p;
  if (prev && prev.mesh) updatePinVisual(prev);                 // previous one returns to 1x size
  $('pinPanel').style.display = p ? 'block' : 'none';
  if (p) { updatePinVisual(p); $('tilt').value = p.tilt; $('az').value = p.az; $('pinSize').value = p.d || +$('pinD').value; readout(); }
}
function readout() { $('angleOut').textContent = S.selected ? `Ø ${(S.selected.d || +$('pinD').value).toFixed(1)} mm · tilt ${(+$('tilt').value).toFixed(0)}° · rot ${(+$('az').value).toFixed(0)}°` : ''; }
$('tilt').oninput = () => { if (!S.selected) return; S.selected.tilt = +$('tilt').value; updatePinVisual(S.selected); readout(); };
$('az').oninput   = () => { if (!S.selected) return; S.selected.az   = +$('az').value;   updatePinVisual(S.selected); readout(); };
$('pinSize').oninput = () => { if (!S.selected) return; S.selected.d = clampD(+$('pinSize').value); updatePinVisual(S.selected); readout(); };

// ----- circle preview under the cursor (ghost) — "as if you were holding it with the mouse" -----
const ghost = (() => {
  const Z = new THREE.Vector3(0, 0, 1), tip = $('ghostTip');
  // A translucent dowel at its real Ø and length, so you see what you are about to place and
  // how far it reaches into both pieces — a flat circle told you neither.
  const body = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 32).rotateX(Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x37d67a, transparent: true, opacity: 0.45,
                                     flatShading: false, depthTest: false }));
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.88, 1, 48),          // footprint on the section
    new THREE.MeshBasicMaterial({ color: 0x37d67a, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthTest: false }));
  const group = new THREE.Group(); group.add(body, ring); group.visible = false; group.renderOrder = 998;
  scene.add(group);
  return {
    visible() { return group.visible; },
    show(hit, axis, ox, oy) {
      const { d, tilt, az, minSd } = pinSpecAt(hit, axis);
      const ok = validate({ x: hit.x, y: hit.y, z: hit.z, _axis: axis, tilt, az, d });
      const col = ok ? 0x37d67a : 0xff4d4d, r = d / 2, L = +$('pinLen').value;
      const dir = new THREE.Vector3(...dirFromTiltAz(axis, tilt, az)).normalize();
      group.visible = true; group.position.copy(hit); group.quaternion.setFromUnitVectors(Z, dir);
      body.scale.set(r, r, L); ring.scale.set(r, r, 1);
      body.material.color.setHex(col); ring.material.color.setHex(col);
      tip.style.display = 'block'; tip.classList.toggle('bad', !ok);
      tip.style.left = (ox + 16) + 'px'; tip.style.top = oy + 'px';
      tip.textContent = `Ø ${d.toFixed(1)} × ${L} mm · min wall ${Math.max(0, minSd * 2).toFixed(1)} mm`
        + ($('manualD').checked ? ' · manual' : '') + (ok ? '' : ' · too thin');
    },
    hide() { group.visible = false; tip.style.display = 'none'; }
  };
})();
function refreshGhost() { if (S.mode === 'edit' && !S.dragging && ghost.visible() && S.lastHover) ghost.show(S.lastHover.hit, S.lastHover.axis, S.lastHover.ox, S.lastHover.oy); }

// ----- manual Ø selection (several sizes at once) -----
function setPinD(v) { $('pinD').value = clampD(v); paintSizes(); refreshGhost(); }
const QUICK = [3, 4, 5, 6, 8, 10, 12];
QUICK.forEach(v => { const b = document.createElement('button'); b.textContent = v; b.onclick = () => { $('manualD').checked = true; toggleManual(); setPinD(v); }; $('quickSizes').appendChild(b); });
function paintSizes() { [...$('quickSizes').children].forEach(b => b.classList.toggle('on', +b.textContent === clampD(+$('pinD').value))); }
function toggleManual() { $('manualBox').style.display = $('manualD').checked ? 'block' : 'none'; paintSizes(); refreshGhost(); }
$('manualD').onchange = toggleManual;
$('pinD').addEventListener('input', () => { paintSizes(); refreshGhost(); });

// ----- edit mode + raycasting -----
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), planeMath = new THREE.Plane();
function setMode(mode) {
  S.mode = mode;
  $('editToggle').textContent = t(mode === 'edit' ? 'edit.on' : 'edit.off');
  $('editToggle').classList.toggle('on', mode === 'edit');
  canvas.style.cursor = mode === 'edit' ? 'crosshair' : 'default';
  if (mode !== 'edit') { selectPin(null); ghost.hide(); }
  highlightActive();
}
$('editToggle').onclick = () => setMode(S.mode === 'edit' ? 'view' : 'edit');
function pickNDC(e) { ndc.set(e.offsetX / canvas.clientWidth * 2 - 1, -(e.offsetY / canvas.clientHeight) * 2 + 1); ray.setFromCamera(ndc, camera); }
function activePlaneObj() { return planeGroup.children.find(m => m.userData.key === S.activeKey); }
function projectToActivePlane() {
  const pl = activePlaneObj(); if (!pl) return null;
  planeMath.setFromNormalAndCoplanarPoint(new THREE.Vector3().setComponent(pl.userData.axis, 1), pl.position);
  const hit = new THREE.Vector3();
  if (!ray.ray.intersectPlane(planeMath, hit)) return null;
  hit.setComponent(pl.userData.axis, pl.userData.coord);
  return { hit, axis: pl.userData.axis, key: pl.userData.key };
}
// ----- undo / redo -----
// Snapshots of the pin map. Deleting used to be a one-way trip.
const history = { past: [], future: [] };
// Seam positions belong in the snapshot too. Dragging a plane re-plans the pins on it, so
// without the cuts an undo would restore pins keyed to a seam that no longer exists — they
// would vanish from the view and be dropped from the export without a word.
const snapshot = () => JSON.stringify({
  cuts: S.plan ? S.plan.cuts.map(a => a.slice()) : null,
  pins: [...S.pins].map(([k, a]) =>
    [k, a.map(p => ({ x: p.x, y: p.y, z: p.z, _axis: p._axis, tilt: p.tilt, az: p.az, d: p.d }))]),
});
function mark() { history.past.push(snapshot()); if (history.past.length > 50) history.past.shift(); history.future.length = 0; }
function applySnapshot(str) {
  const snap = JSON.parse(str);
  if (snap.cuts && S.plan) {
    S.plan.cuts = snap.cuts;
    S.plan.planes = [];
    for (let ax = 0; ax < 3; ax++) for (const c of snap.cuts[ax]) S.plan.planes.push({ axis: ax, coord: c });
    buildPlanes();                                         // plane meshes and the picker quote the coords
  }
  clearGroup(pinGroup); clearGroup(arrowGroup); selectPin(null); S.pins = new Map();
  for (const [k, arr] of snap.pins) S.pins.set(k, arr.map(pt => { const p = { ...pt }; addPinVisual(p); return p; }));
  highlightActive();
}
function undo() { if (!history.past.length) return; history.future.push(snapshot()); applySnapshot(history.past.pop()); }
function redo() { if (!history.future.length) return; history.past.push(snapshot()); applySnapshot(history.future.pop()); }

// ----- pointer -----
// A click adds a pin, a drag orbits the camera. Previously every left-press in edit mode
// projected onto the (infinite) active plane, dropped a pin there and switched the camera off,
// so there was no way to look around while editing.
const DRAG_PX = 4;
let press = null;
canvas.addEventListener('pointerdown', e => {
  if (!S.plan || e.button !== 0) return;
  pickNDC(e);
  press = { x: e.offsetX, y: e.offsetY, moved: false, kind: null };
  if (S.mode === 'edit') {
    const hm = ray.intersectObjects(pinGroup.children, false).find(h => h.object.visible);
    if (hm) {                                            // grab a pin -> move it, camera stays put
      const ref = findPin(hm.object); if (!ref) return;
      mark(); selectPin(ref); S.dragging = ref; controls.enabled = false; press.kind = 'pin';
    }
    return;                                              // empty space: decide on pointerup
  }
  const hp = ray.intersectObjects(planeGroup.children, false)[0];
  if (hp) { S.dragPlane = hp.object; S.planeMarked = false; controls.enabled = false; press.kind = 'plane'; }
});

canvas.addEventListener('pointermove', e => {
  if (press && (Math.abs(e.offsetX - press.x) > DRAG_PX || Math.abs(e.offsetY - press.y) > DRAG_PX)) press.moved = true;
  pickNDC(e);
  if (S.dragging) {                                      // moving an existing pin
    const proj = projectToActivePlane(); if (!proj) return;
    const p = S.dragging; p.x = proj.hit.x; p.y = proj.hit.y; p.z = proj.hit.z; updatePinVisual(p); ghost.hide(); return;
  }
  if (S.dragPlane) { movePlaneTo(S.dragPlane, e); return; }
  if (S.mode !== 'edit') return;
  if (press && press.moved) { ghost.hide(); return; }    // orbiting — no preview in the way
  const overPin = ray.intersectObjects(pinGroup.children, false).some(h => h.object.visible);
  const proj = overPin ? null : projectToActivePlane();
  if (proj) { S.lastHover = { hit: proj.hit.clone(), axis: proj.axis, ox: e.offsetX, oy: e.offsetY }; ghost.show(proj.hit, proj.axis, e.offsetX, e.offsetY); }
  else ghost.hide();
});

addEventListener('pointerup', e => {
  const p = press; press = null; S.dragging = null; S.dragPlane = null; controls.enabled = true;
  if (!p || !S.plan) return;
  if (p.moved || p.kind) return;                         // a drag, or it started on a pin/plane
  pickNDC(e);
  if (S.mode !== 'edit') {                               // view mode: a click picks the plane to work on
    const hp = ray.intersectObjects(planeGroup.children, false)[0];
    if (hp) { S.activeKey = hp.object.userData.key; $('activePlane').value = S.activeKey; highlightActive(); }
    return;
  }
  const hm = ray.intersectObjects(pinGroup.children, false).find(h => h.object.visible);
  if (hm) { selectPin(findPin(hm.object)); return; }     // a plain click on a pin just selects it
  const proj = projectToActivePlane(); if (!proj) return;
  mark(); ghost.hide();
  const { d, tilt, az } = pinSpecAt(proj.hit, proj.axis);
  const pin = { x: proj.hit.x, y: proj.hit.y, z: proj.hit.z, _axis: proj.axis, tilt, az, d };
  addPinVisual(pin);
  (S.pins.get(proj.key) ?? S.pins.set(proj.key, []).get(proj.key)).push(pin);
  selectPin(pin);
});

canvas.addEventListener('pointerleave', () => { ghost.hide(); S.lastHover = null; });
canvas.addEventListener('contextmenu', e => {
  if (S.mode !== 'edit' || !S.plan) return;
  e.preventDefault(); pickNDC(e);
  const hm = ray.intersectObjects(pinGroup.children, false).find(h => h.object.visible);
  if (hm) { const ref = findPin(hm.object); if (ref) { mark(); removePin(ref); } }
});

addEventListener('keydown', e => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '');
  if ((e.key === 'z' || e.key === 'Z') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if ((e.key === 'y' || e.key === 'Y') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); redo(); return; }
  if (typing) return;
  if (e.key === 'Escape') { selectPin(null); ghost.hide(); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && S.selected) { e.preventDefault(); mark(); removePin(S.selected); }
});

// ----- dragging a cut plane -----
// The even split is rarely where you want the seam; drag it into a crease or off a detail.
// The pins on that seam are re-placed, because their old positions no longer sit on it.
const _planeMath = new THREE.Plane(), _hit = new THREE.Vector3();
function movePlaneTo(mesh, e) {
  const ax = mesh.userData.axis, { lo, hi, cuts, usable } = S.plan;
  const list = cuts[ax], i = list.indexOf(mesh.userData.coord);
  if (i < 0) return;
  // slide along `ax`: intersect the ray with a plane facing the camera that contains the cut
  const n = camera.getWorldDirection(new THREE.Vector3()).negate(); n.setComponent(ax, 0);
  if (n.lengthSq() < 1e-6) return;
  _planeMath.setFromNormalAndCoplanarPoint(n.normalize(), mesh.position);
  if (!ray.ray.intersectPlane(_planeMath, _hit)) return;
  const prev = i === 0 ? lo[ax] : list[i - 1], next = i === list.length - 1 ? hi[ax] : list[i + 1];
  let c = _hit.getComponent(ax);
  if (e.shiftKey) c = mesh.userData.coord + (c - mesh.userData.coord) * 0.25;      // fine drag
  c = Math.min(Math.max(c, Math.max(prev + 1, next - usable[ax])), Math.min(next - 1, prev + usable[ax]));
  if (Math.abs(c - mesh.userData.coord) < 1e-4) return;
  if (!S.planeMarked) { mark(); S.planeMarked = true; }      // once per drag, not once per mouse move
  const oldKey = mesh.userData.key;
  list[i] = c; mesh.position.setComponent(ax, c);
  mesh.userData.coord = c; mesh.userData.key = planeKey(ax, c);
  S.pins.delete(oldKey);
  S.pins.set(mesh.userData.key, planPlane(S.plan, ax, c, S.planOpts).map(pt => ({ ...pt })));
  clearGroup(pinGroup); clearGroup(arrowGroup); selectPin(null);

  for (const arr of S.pins.values()) for (const p of arr) addPinVisual(p);
  S.plan.planes = S.plan.planes.map(pl => (pl.axis === ax && planeKey(ax, pl.coord) === oldKey) ? { axis: ax, coord: c } : pl);
  const opt = [...$('activePlane').options].find(o => o.value === oldKey);
  if (opt) { opt.value = mesh.userData.key; opt.textContent = `${['X','Y','Z'][ax]} @ ${c.toFixed(1)}`; }
  if (S.activeKey === oldKey) S.activeKey = mesh.userData.key;
  $('activePlane').value = S.activeKey;
  highlightActive();
}

// Alt+scroll changes Ø live (the selected pin, or the next one to be added); scroll alone -> normal zoom.
canvas.addEventListener('wheel', e => {
  if (S.mode !== 'edit' || !e.altKey) return;     // no Alt -> leave zoom alone
  if (!S.selected && !ghost.visible()) return;
  e.preventDefault(); e.stopPropagation();
  const step = e.deltaY < 0 ? 0.5 : -0.5;
  if (S.selected) { mark(); S.selected.d = clampD(S.selected.d + step); $('pinSize').value = S.selected.d; updatePinVisual(S.selected); readout(); }
  else { if (!$('manualD').checked) { $('manualD').checked = true; toggleManual(); } setPinD(+$('pinD').value + step); }
}, { capture: true, passive: false });

// ----- cutting + export -----
$('cut').onclick = async () => {
  if (!S.plan) return;
  $('cut').disabled = true; setMode('view');
  const pins = new Map();
  for (const [k, arr] of S.pins) pins.set(k, arr.map(p => ({ x: p.x, y: p.y, z: p.z, dir: dirOf(p), d: p.d, cost: minSdOf(p) })));
  try {
    // geometry-critical settings come from the plan — changing the printer or the margin
    // afterwards would move the cut planes and silently drop every pin. Numbering is cosmetic.
    const o = { ...(S.planOpts || opts()), number: $('number').checked, orient: $('orient').checked };
    o.cuts = S.plan.cuts;                                  // the plan owns the seam positions:
                                                           // searched, dragged, or the even split
    S.pieces = await cutAndConnect(S.geometry.clone(), o, pins, log);
    showPieces(); $('download').disabled = S.pieces.length === 0;
  } catch (err) { log('log.error', { msg: errText(err) }); console.error(err); }
  $('cut').disabled = false;
};
function makeLabelSprite(text) {
  const fs = 96, pad = Math.round(fs * 0.28), font = `600 ${fs}px system-ui, -apple-system, sans-serif`;
  const cv = document.createElement('canvas'), ctx = cv.getContext('2d');
  ctx.font = font;
  cv.width = Math.ceil(ctx.measureText(text).width) + pad * 2; cv.height = fs + pad * 2;
  ctx.font = font; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';        // resizing cleared the context
  const x = cv.width / 2, y = cv.height / 2;
  ctx.lineJoin = 'round'; ctx.lineWidth = fs * 0.16; ctx.strokeStyle = 'rgba(8,10,14,0.85)';
  ctx.strokeText(text, x, y);                                                     // outline -> readable on any color
  ctx.fillStyle = '#fff'; ctx.fillText(text, x, y);
  const tex = new THREE.CanvasTexture(cv); tex.anisotropy = 4;
  const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
  const mmH = 11; spr.scale.set(mmH * cv.width / cv.height, mmH, 1); spr.renderOrder = 999;
  KEEP.add(spr.geometry);                                   // three shares one quad across all sprites
  return spr;
}
function pieceLabel(name) { return name.replace(/^piece_/, '').replace(/\.stl$/, ''); }
function statBox(val, label, cls) { return `<div class="stat ${cls || ''}"><b>${val}</b><span>${label}</span></div>`; }
function showStats() {
  const st = S.pieces.stats; if (!st) { $('stats').innerHTML = ''; return; }
  const bad = S.pieces.filter(p => !p.fits).length;
  const num = !st.numbered ? statBox('—', t('stat.number.off'), 'off')
            : st.engraved === st.pieces ? statBox('✓', t('stat.number.ok', { n: st.engraved, total: st.pieces }), 'ok')
            : statBox(`${st.engraved}/${st.pieces}`, t('stat.number.partial'), 'warn');
  const pinLbl = st.pins ? (st.pinSizes || []).map(x => `${x.count}× Ø${x.d.toFixed(1)}`).join(' · ') : t('stat.pins.none');
  $('stats').innerHTML =
    statBox(st.pieces, t('stat.pieces'), bad ? 'warn' : 'ok') +
    statBox(st.joints, t('stat.joints')) +
    statBox(st.pins || '—', t('stat.pins', { list: pinLbl }), st.pins ? 'ok' : 'off') +
    num;
}
function showPieces() {
  modelGroup.visible = planeGroup.visible = pinGroup.visible = arrowGroup.visible = false;
  clearGroup(pieceGroup); S.pieceMeshes = []; S.pieceLabels = []; const list = $('pieceList'); list.innerHTML = ''; showStats();
  S.pieces.forEach((p, i) => {
    const mesh = new THREE.Mesh(p.geometry, new THREE.MeshStandardMaterial({ color: PALETTE[i % PALETTE.length], flatShading: true }));
    p.geometry.computeBoundingBox();
    const center = p.geometry.boundingBox.getCenter(new THREE.Vector3());
    mesh.userData.center = center;
    pieceGroup.add(mesh); S.pieceMeshes.push(mesh);
    const spr = makeLabelSprite(pieceLabel(p.name)); spr.userData.center = center; spr.userData.base = spr.scale.clone(); spr.position.copy(center);
    pieceGroup.add(spr); S.pieceLabels.push(spr);
    const li = document.createElement('div'); li.className = 'piece' + (p.fits ? '' : ' bad');
    li.textContent = (p.fits ? '✓ ' : '⚠ ') + (p.kind === 'pins'
      ? t('piece.stock', { count: p.count, d: p.d.toFixed(1), len: S.planOpts?.pinLen ?? '' })
      : `${pieceLabel(p.name)}  ${p.size.map(s => s.toFixed(0)).join('×')} mm`);
    li.title = t('piece.tip');
    li.onmouseenter = () => highlightPiece(i, true);
    li.onmouseleave = () => highlightPiece(i, false);
    li.onclick = () => frame(S.pieceMeshes[i]);
    list.appendChild(li);
  });
  frame(pieceGroup); $('explode').value = 0;
}
// Highlight the number (label) and piece — to find it after exploding.
function highlightPiece(i, on) {
  const spr = S.pieceLabels[i], mesh = S.pieceMeshes[i];
  if (spr) { spr.scale.copy(spr.userData.base).multiplyScalar(on ? 1.8 : 1); spr.material.color.setHex(on ? 0xffe066 : 0xffffff); }
  if (mesh) mesh.material.emissive.setHex(on ? 0x2a6b3a : 0x000000);
}
$('explode').oninput = () => {
  const s = +$('explode').value;
  S.pieceMeshes.forEach(m => m.position.copy(m.userData.center).multiplyScalar(s));
  S.pieceLabels.forEach(l => l.position.copy(l.userData.center).multiplyScalar(1 + s));   // label sits by the piece center
};
$('download').onclick = () => {
  const exp = new STLExporter(), files = {};
  for (const p of S.pieces) {
    // the view keeps every piece where it belongs in the model; the print rotation is applied here
    let g = p.geometry;
    if (p.orient) { g = g.clone(); g.applyMatrix4(new THREE.Matrix4().fromArray(p.orient)); }
    const dv = exp.parse(new THREE.Mesh(g), { binary: true }); files[p.name] = new Uint8Array(dv.buffer ?? dv);
    if (g !== p.geometry) g.dispose();
  }
  const blob = new Blob([zipSync(files)], { type: 'application/zip' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'pieces.zip'; a.click();
};
setMode('view');
