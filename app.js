// app.js — UI, three.js scene, interactive 3D pin editing, export.
import * as THREE from 'three';
import { STLLoader }    from 'three/addons/loaders/STLLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLExporter }  from 'three/addons/exporters/STLExporter.js';
import { zipSync } from 'fflate';
import { PRESETS } from './presets.js';
import { planCuts, cutAndConnect, planeKey, dirFromTiltAz, autoDir } from './cutter.js';

const $ = id => document.getElementById(id);
const log = m => { const el = $('log'); if (!el) return; el.textContent += m + '\n'; el.scrollTop = 1e9; };
addEventListener('error', e => log('JS ERROR: ' + (e.message || e.error)));
addEventListener('unhandledrejection', e => log('PROMISE ERROR: ' + (e.reason?.message || e.reason)));
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

// ----- state ----- (before the render loop — updateClip() reaches into S on frame 1)
const S = { geometry: null, plan: null, sd: null, pins: new Map(),
            pieces: null, pieceMeshes: [], pieceLabels: [], mode: 'view', activeKey: null,
            dragging: null, selected: null, modelMat: null, clip: new THREE.Plane(), lastHover: null };

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
    number: $('number').checked };
}
const reqSdFor = d => d / 2 + +$('clearance').value + +$('minWall').value;
const halfLen = () => +$('pinLen').value / 2;
const dirOf   = p => dirFromTiltAz(p._axis, p.tilt, p.az);
const clampD = v => Math.min(20, Math.max(2.5, Math.round(v * 2) / 2));
// Picks pin Ø and 3D angle for a point on the plane (used both when adding and in the preview).
function pinSpecAt(hit, axis) {
  const sdc = S.sd(hit.x, hit.y, hit.z);
  let d;
  if ($('manualD').checked) {                          // manual mode: exactly the chosen Ø (you can add different sizes)
    d = clampD(+$('pinD').value);
  } else {                                             // auto: the largest Ø that fits the wall
    const fitD = 2 * (sdc - +$('minWall').value - +$('clearance').value);
    d = Math.max(2.5, Math.min(+$('pinD').value, Math.floor(fitD * 2) / 2 || 2.5));
  }
  const a = autoDir(S.sd, hit, axis, halfLen(), reqSdFor(d));
  return { d, tilt: a.tilt, az: a.az, sdc };
}

// ----- presets -----
PRESETS.forEach(p => $('preset').add(new Option(p.name, p.id)));
$('preset').value = 'p1s';
$('preset').onchange = () => {
  const p = PRESETS.find(x => x.id === $('preset').value);
  if (p && p.id !== 'custom') { $('bx').value = p.build[0]; $('by').value = p.build[1]; $('bz').value = p.build[2]; }
};
$('preset').onchange();

// ----- load STL -----
async function loadFile(f) {
  try {
    $('log').textContent = ''; log(`Loading: ${f.name} (${(f.size / 1024).toFixed(0)} kB)`);
    const geo = new STLLoader().parse(await f.arrayBuffer());
    if (!geo.attributes.position) throw new Error('No geometry (bad STL?).');
    geo.center();
    S.geometry = geo; S.plan = null; S.pieces = null; $('stats').innerHTML = ''; $('pieceList').innerHTML = '';
    [modelGroup, planeGroup, pinGroup, arrowGroup, pieceGroup].forEach(g => g.clear());
    S.pins = new Map(); selectPin(null);
    S.modelMat = new THREE.MeshStandardMaterial({ color: 0x6b7785, flatShading: true, side: THREE.DoubleSide });   // DoubleSide -> interior walls visible after sectioning
    modelGroup.add(new THREE.Mesh(geo, S.modelMat));
    frame(modelGroup);
    $('plan').disabled = false; $('cut').disabled = true; $('download').disabled = true;
    setMode('view'); $('editToggle').disabled = true;
    log(`OK — ${(geo.attributes.position.count / 3).toFixed(0)} triangles. Click "Plan cuts".`);
  } catch (err) { log('Load error: ' + err.message); console.error(err); }
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
    S.plan = await planCuts(S.geometry, opts(), log);
    S.sd = S.plan.sd;
    buildPlanes(); buildPinsFromPlan(); selectPin(null);
    pieceGroup.clear(); $('stats').innerHTML = '';
    modelGroup.visible = planeGroup.visible = pinGroup.visible = arrowGroup.visible = true;
    $('editToggle').disabled = false; $('cut').disabled = false; $('download').disabled = true;
    let n = 0; S.pins.forEach(a => n += a.length);
    const o = opts();
    log(`Plan: ${S.plan.planes.length} planes, ${n} pins (dowel)`);
    if (S.plan.maxWall > 0) {
      const maxD = S.plan.maxWall - 2 * (o.minWall + o.clearance);
      log(`Thickest wall ~${S.plan.maxWall.toFixed(1)} mm -> max sensible pin Ø ~${Math.max(0, maxD).toFixed(1)} mm`);
    }
    const ds = [...new Set([...(S.plan.planeD?.values() || [])])].sort((a, b) => a - b);
    if (ds.length) log(`Pin Ø used: ${ds.map(d => d.toFixed(1)).join(', ')} mm (the "Pin Ø" field = maximum)`);
    if (o.connector === 'auto') log('Thin joints: flat butt (glue); thick ones — dowels.');
    else if ((o.connector === 'dowel' || o.connector === 'plug') && n === 0)
      log('Wall too thin for dowels. Switch connector to "auto".');
  } catch (err) { log('ERROR: ' + err.message); console.error(err); }
  $('plan').disabled = false;
};

function buildPlanes() {
  planeGroup.clear(); $('activePlane').innerHTML = '';
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
    m.material.opacity = active ? (edit ? 0.34 : 0.26) : (edit ? 0.04 : 0.1);   // in edit mode dim the rest, highlight the active one
    if (m.userData.edge) m.userData.edge.material.opacity = active ? 0.9 : (edit ? 0.15 : 0.35);
  });
  buildSection();
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
  p.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 12),   // unit sphere scaled by Ø -> size changeable live
    new THREE.MeshBasicMaterial({ color: 0x37d67a }));
  p.arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 1, 0x37d67a);
  pinGroup.add(p.mesh); arrowGroup.add(p.arrow);
  updatePinVisual(p);
}
function updatePinVisual(p) {
  const ok = validate(p), col = ok ? 0x37d67a : 0xff4d4d, hl = halfLen();
  const r = Math.max(1.2, (p.d || +$('pinD').value) / 2) * (S.selected === p ? 1.6 : 1);
  p.mesh.position.set(p.x, p.y, p.z); p.mesh.scale.setScalar(r); p.mesh.material.color.setHex(col);
  const d = new THREE.Vector3(...dirOf(p)).normalize();
  p.arrow.position.set(p.x, p.y, p.z).addScaledVector(d, -hl);
  p.arrow.setDirection(d); p.arrow.setLength(hl * 2, Math.min(5, hl), Math.min(3.5, hl * 0.7)); p.arrow.setColor(col);
}
function validate(p) {
  const d = dirOf(p), hl = halfLen(); let m = Infinity;
  for (const t of [-hl, -hl / 2, 0, hl / 2, hl]) {
    const v = S.sd(p.x + d[0] * t, p.y + d[1] * t, p.z + d[2] * t); if (v < m) m = v;
  }
  return m >= reqSdFor(p.d || +$('pinD').value);
}
function buildPinsFromPlan() {
  pinGroup.clear(); arrowGroup.clear(); S.pins = new Map();
  for (const [key, pts] of S.plan.pins) {
    const arr = pts.map(pt => { const p = { ...pt }; addPinVisual(p); return p; });
    S.pins.set(key, arr);
  }
}
function findPin(mesh) { for (const arr of S.pins.values()) { const r = arr.find(p => p.mesh === mesh); if (r) return r; } return null; }
function removePin(ref) {
  for (const arr of S.pins.values()) { const i = arr.indexOf(ref); if (i >= 0) { arr.splice(i, 1); pinGroup.remove(ref.mesh); arrowGroup.remove(ref.arrow); if (S.selected === ref) selectPin(null); return; } }
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
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.84, 1, 48),
    new THREE.MeshBasicMaterial({ color: 0x37d67a, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthTest: false }));
  const disc = new THREE.Mesh(new THREE.CircleGeometry(1, 48),
    new THREE.MeshBasicMaterial({ color: 0x37d67a, transparent: true, opacity: 0.15, side: THREE.DoubleSide, depthTest: false }));
  const arrow = new THREE.ArrowHelper(Z, new THREE.Vector3(), 1, 0x37d67a);
  const group = new THREE.Group(); group.add(disc, ring, arrow); group.visible = false; group.renderOrder = 998;
  scene.add(group);
  return {
    visible() { return group.visible; },
    show(hit, axis, ox, oy) {
      const { d, tilt, az, sdc } = pinSpecAt(hit, axis);
      const ok = validate({ x: hit.x, y: hit.y, z: hit.z, _axis: axis, tilt, az, d });
      const col = ok ? 0x37d67a : 0xff4d4d, r = d / 2, dir = new THREE.Vector3(...dirFromTiltAz(axis, tilt, az)).normalize();
      group.visible = true; group.position.copy(hit); group.quaternion.setFromUnitVectors(Z, dir);
      ring.scale.set(r, r, 1); disc.scale.set(r, r, 1);
      ring.material.color.setHex(col); disc.material.color.setHex(col);
      arrow.setDirection(Z);   // arrow in the group's local frame = along the pin axis
      arrow.setLength(halfLen() * 2, Math.min(5, halfLen()), Math.min(3.5, halfLen() * 0.7)); arrow.setColor(col);
      arrow.position.set(0, 0, -halfLen());
      tip.style.display = 'block'; tip.classList.toggle('bad', !ok);
      tip.style.left = (ox + 16) + 'px'; tip.style.top = oy + 'px';
      tip.textContent = `Ø ${d.toFixed(1)} mm · wall ${(sdc * 2).toFixed(1)} mm` + ($('manualD').checked ? ' · manual' : '') + (ok ? '' : ' · too thin');
    },
    hide() { group.visible = false; tip.style.display = 'none'; }
  };
})();
// Refresh the ghost at the last cursor spot (after an Ø / mode change) — without moving the mouse.
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
  $('editToggle').textContent = mode === 'edit' ? 'Edit pins: ON' : 'Edit pins: off';
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
canvas.addEventListener('pointerdown', e => {
  if (S.mode !== 'edit' || !S.plan) return;
  pickNDC(e);
  const hm = ray.intersectObjects(pinGroup.children, false)[0];
  if (hm) { const ref = findPin(hm.object); if (!ref) return;
    if (e.button === 2) removePin(ref); else { selectPin(ref); S.dragging = ref; controls.enabled = false; } return; }
  const proj = projectToActivePlane();
  if (proj && e.button === 0) {
    controls.enabled = false; ghost.hide();
    const { d, tilt, az } = pinSpecAt(proj.hit, proj.axis);
    const p = { x: proj.hit.x, y: proj.hit.y, z: proj.hit.z, _axis: proj.axis, tilt, az, d };
    addPinVisual(p);
    (S.pins.get(proj.key) ?? S.pins.set(proj.key, []).get(proj.key)).push(p);
    selectPin(p);
  }
});
canvas.addEventListener('pointermove', e => {
  if (S.mode !== 'edit') return;
  pickNDC(e);
  if (S.dragging) {   // dragging an existing pin
    const proj = projectToActivePlane(); if (!proj) return;
    const p = S.dragging; p.x = proj.hit.x; p.y = proj.hit.y; p.z = proj.hit.z; updatePinVisual(p); ghost.hide(); return;
  }
  if (!S.plan) return;
  const overPin = ray.intersectObjects(pinGroup.children, false).length > 0;   // over an existing pin -> no preview
  const proj = overPin ? null : projectToActivePlane();
  if (proj) { S.lastHover = { hit: proj.hit.clone(), axis: proj.axis, ox: e.offsetX, oy: e.offsetY }; ghost.show(proj.hit, proj.axis, e.offsetX, e.offsetY); }
  else ghost.hide();
});
canvas.addEventListener('pointerleave', () => { ghost.hide(); S.lastHover = null; });
addEventListener('pointerup', () => { S.dragging = null; controls.enabled = true; });
canvas.addEventListener('contextmenu', e => { if (S.mode === 'edit') e.preventDefault(); });
// Alt+scroll changes Ø live (the selected pin, or the next one to be added); scroll alone -> normal zoom.
canvas.addEventListener('wheel', e => {
  if (S.mode !== 'edit' || !e.altKey) return;     // no Alt -> leave zoom alone
  if (!S.selected && !ghost.visible()) return;
  e.preventDefault(); e.stopPropagation();
  const step = e.deltaY < 0 ? 0.5 : -0.5;
  if (S.selected) { S.selected.d = clampD(S.selected.d + step); $('pinSize').value = S.selected.d; updatePinVisual(S.selected); readout(); }
  else { if (!$('manualD').checked) { $('manualD').checked = true; toggleManual(); } setPinD(+$('pinD').value + step); }
}, { capture: true, passive: false });

// ----- cutting + export -----
$('cut').onclick = async () => {
  if (!S.plan) return;
  $('cut').disabled = true; setMode('view');
  const pins = new Map();
  for (const [k, arr] of S.pins) pins.set(k, arr.map(p => ({ x: p.x, y: p.y, z: p.z, dir: dirOf(p), d: p.d })));
  try {
    S.pieces = await cutAndConnect(S.geometry.clone(), opts(), pins, log);
    showPieces(); $('download').disabled = S.pieces.length === 0;
  } catch (err) { log('BLAD: ' + err.message); console.error(err); }
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
  return spr;
}
function pieceLabel(name) { return name.replace(/^piece_/, '').replace(/\.stl$/, ''); }
function statBox(val, label, cls) { return `<div class="stat ${cls || ''}"><b>${val}</b><span>${label}</span></div>`; }
function showStats() {
  const st = S.pieces.stats; if (!st) { $('stats').innerHTML = ''; return; }
  const bad = S.pieces.filter(p => !p.fits).length;
  const num = !st.numbered ? statBox('—', 'numbering: off', 'off')
            : st.engraved === st.pieces ? statBox('✓', `numbered ${st.engraved}/${st.pieces}`, 'ok')
            : statBox(`${st.engraved}/${st.pieces}`, 'numbering partial', 'warn');
  $('stats').innerHTML =
    statBox(st.pieces, 'pieces', bad ? 'warn' : 'ok') +
    statBox(st.joints, 'joints (dowels)') +
    num;
}
function showPieces() {
  modelGroup.visible = planeGroup.visible = pinGroup.visible = arrowGroup.visible = false;
  pieceGroup.clear(); S.pieceMeshes = []; S.pieceLabels = []; const list = $('pieceList'); list.innerHTML = ''; showStats();
  S.pieces.forEach((p, i) => {
    const mesh = new THREE.Mesh(p.geometry, new THREE.MeshStandardMaterial({ color: PALETTE[i % PALETTE.length], flatShading: true }));
    p.geometry.computeBoundingBox();
    const center = p.geometry.boundingBox.getCenter(new THREE.Vector3());
    mesh.userData.center = center;
    pieceGroup.add(mesh); S.pieceMeshes.push(mesh);
    const spr = makeLabelSprite(pieceLabel(p.name)); spr.userData.center = center; spr.userData.base = spr.scale.clone(); spr.position.copy(center);
    pieceGroup.add(spr); S.pieceLabels.push(spr);
    const li = document.createElement('div'); li.className = 'piece' + (p.fits ? '' : ' bad');
    li.textContent = `${p.fits ? '✓' : '⚠'} ${pieceLabel(p.name)}  ${p.size.map(s => s.toFixed(0)).join('×')} mm`;
    li.title = 'Hover to highlight its number · click to center it';
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
  for (const p of S.pieces) { const dv = exp.parse(new THREE.Mesh(p.geometry), { binary: true }); files[p.name] = new Uint8Array(dv.buffer ?? dv); }
  const blob = new Blob([zipSync(files)], { type: 'application/zip' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'pieces.zip'; a.click();
};
setMode('view');
