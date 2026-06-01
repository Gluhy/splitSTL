// app.js — UI, scena three.js, interaktywna edycja pinow 3D, eksport.
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

// ----- scena -----
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x15171b);
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 8000);
camera.position.set(200, 160, 200);
const controls = new OrbitControls(camera, canvas);
scene.add(new THREE.AmbientLight(0xffffff, 0.65));
const dl = new THREE.DirectionalLight(0xffffff, 0.8); dl.position.set(1, 1.4, 0.8); scene.add(dl);
const modelGroup = new THREE.Group(), planeGroup = new THREE.Group(),
      pinGroup = new THREE.Group(), arrowGroup = new THREE.Group(), pieceGroup = new THREE.Group();
scene.add(modelGroup, planeGroup, pinGroup, arrowGroup, pieceGroup);

function resize() {
  const w = canvas.parentElement.clientWidth, h = canvas.parentElement.clientHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
}
addEventListener('resize', resize); resize();
(function loop(){ requestAnimationFrame(loop); controls.update(); renderer.render(scene, camera); })();

function frame(obj) {
  const box = new THREE.Box3().setFromObject(obj); if (box.isEmpty()) return;
  const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
  controls.target.copy(c);
  camera.position.copy(c).add(new THREE.Vector3(1, 0.8, 1).multiplyScalar(s.length()));
}

// ----- stan -----
const S = { geometry: null, plan: null, sd: null, pins: new Map(),
            pieces: null, pieceMeshes: [], mode: 'view', activeKey: null,
            dragging: null, selected: null };

function opts() {
  return { build: [+$('bx').value, +$('by').value, +$('bz').value],
    margin: +$('margin').value, connector: $('connector').value,
    pinD: +$('pinD').value, pinLen: +$('pinLen').value,
    clearance: +$('clearance').value, minWall: +$('minWall').value, spacing: +$('spacing').value };
}
const reqSdFor = d => d / 2 + +$('clearance').value + +$('minWall').value;
const halfLen = () => +$('pinLen').value / 2;
const dirOf   = p => dirFromTiltAz(p._axis, p.tilt, p.az);

// ----- presety -----
PRESETS.forEach(p => $('preset').add(new Option(p.name, p.id)));
$('preset').value = 'p1s';
$('preset').onchange = () => {
  const p = PRESETS.find(x => x.id === $('preset').value);
  if (p && p.id !== 'custom') { $('bx').value = p.build[0]; $('by').value = p.build[1]; $('bz').value = p.build[2]; }
};
$('preset').onchange();

// ----- wczytanie STL -----
async function loadFile(f) {
  try {
    $('log').textContent = ''; log(`Wczytuje: ${f.name} (${(f.size / 1024).toFixed(0)} kB)`);
    const geo = new STLLoader().parse(await f.arrayBuffer());
    if (!geo.attributes.position) throw new Error('Brak geometrii (zly STL?).');
    geo.center();
    S.geometry = geo; S.plan = null; S.pieces = null;
    [modelGroup, planeGroup, pinGroup, arrowGroup, pieceGroup].forEach(g => g.clear());
    S.pins = new Map(); selectPin(null);
    modelGroup.add(new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x6b7785, flatShading: true })));
    frame(modelGroup);
    $('plan').disabled = false; $('cut').disabled = true; $('download').disabled = true;
    setMode('view'); $('editToggle').disabled = true;
    log(`OK — ${(geo.attributes.position.count / 3).toFixed(0)} trojkatow. Kliknij „Zaplanuj ciecia".`);
  } catch (err) { log('BLAD wczytywania: ' + err.message); console.error(err); }
}
$('file').onchange = e => e.target.files[0] && loadFile(e.target.files[0]);
canvas.parentElement.addEventListener('dragover', e => e.preventDefault());
canvas.parentElement.addEventListener('drop', e => {
  e.preventDefault(); const f = [...e.dataTransfer.files].find(x => /\.stl$/i.test(x.name)); if (f) loadFile(f);
});

// ----- planowanie -----
$('plan').onclick = async () => {
  $('plan').disabled = true;
  try {
    S.plan = await planCuts(S.geometry, opts(), log);
    S.sd = S.plan.sd;
    buildPlanes(); buildPinsFromPlan(); selectPin(null);
    pieceGroup.clear();
    modelGroup.visible = planeGroup.visible = pinGroup.visible = arrowGroup.visible = true;
    $('editToggle').disabled = false; $('cut').disabled = false; $('download').disabled = true;
    let n = 0; S.pins.forEach(a => n += a.length);
    const o = opts();
    log(`Plan: ${S.plan.planes.length} plaszczyzn, ${n} pinow (dowel)`);
    if (S.plan.maxWall > 0) {
      const maxD = S.plan.maxWall - 2 * (o.minWall + o.clearance);
      log(`Najgrubsza sciana ~${S.plan.maxWall.toFixed(1)} mm -> max sensowny Ø kolka ~${Math.max(0, maxD).toFixed(1)} mm`);
    }
    const ds = [...new Set([...(S.plan.planeD?.values() || [])])].sort((a, b) => a - b);
    if (ds.length) log(`Uzyte Ø kolkow: ${ds.map(d => d.toFixed(1)).join(', ')} mm (pole "Ø kolka" = maksimum)`);
    if (o.connector === 'auto') log('Cienkie styki: plaski styk na klej; grube — kolki. (pioro-wpust = tryb eksperymentalny)');
    else if ((o.connector === 'dowel' || o.connector === 'plug') && n === 0)
      log('Sciana za cienka na kolki. Przelacz zlacze na "auto" albo "pioro-wpust".');
  } catch (err) { log('BLAD: ' + err.message); console.error(err); }
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
    planeGroup.add(mesh);
    $('activePlane').add(new Option(`${['X', 'Y', 'Z'][pl.axis]} @ ${pl.coord.toFixed(1)}`, mesh.userData.key));
  });
  S.activeKey = planeGroup.children[0]?.userData.key ?? null;
  $('activePlane').value = S.activeKey ?? ''; highlightActive();
}
$('activePlane').onchange = () => { S.activeKey = $('activePlane').value; highlightActive(); };
function highlightActive() { planeGroup.children.forEach(m => m.material.opacity = m.userData.key === S.activeKey ? 0.28 : 0.1); }

// ----- piny: wizualizacja -----
function addPinVisual(p) {
  p.mesh = new THREE.Mesh(new THREE.SphereGeometry(Math.max(1.2, (p.d || +$('pinD').value) / 2), 16, 12),
    new THREE.MeshBasicMaterial({ color: 0x37d67a }));
  p.arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 0, 1), new THREE.Vector3(), 1, 0x37d67a);
  pinGroup.add(p.mesh); arrowGroup.add(p.arrow);
  updatePinVisual(p);
}
function updatePinVisual(p) {
  const ok = validate(p), col = ok ? 0x37d67a : 0xff4d4d, hl = halfLen();
  p.mesh.position.set(p.x, p.y, p.z); p.mesh.material.color.setHex(col);
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

// ----- zaznaczenie + suwaki kata -----
function selectPin(p) {
  if (S.selected && S.selected.mesh) S.selected.mesh.scale.setScalar(1);
  S.selected = p;
  $('pinPanel').style.display = p ? 'block' : 'none';
  if (p) { p.mesh.scale.setScalar(1.6); $('tilt').value = p.tilt; $('az').value = p.az; readout(); }
}
function readout() { $('angleOut').textContent = S.selected ? `kąt ${(+$('tilt').value).toFixed(0)}° · obrót ${(+$('az').value).toFixed(0)}°` : ''; }
$('tilt').oninput = () => { if (!S.selected) return; S.selected.tilt = +$('tilt').value; updatePinVisual(S.selected); readout(); };
$('az').oninput   = () => { if (!S.selected) return; S.selected.az   = +$('az').value;   updatePinVisual(S.selected); readout(); };

// ----- tryb edycji + raycasting -----
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2(), planeMath = new THREE.Plane();
function setMode(mode) {
  S.mode = mode;
  $('editToggle').textContent = mode === 'edit' ? 'Edycja pinow: WL' : 'Edycja pinow: wyl';
  $('editToggle').classList.toggle('on', mode === 'edit');
  canvas.style.cursor = mode === 'edit' ? 'crosshair' : 'default';
  if (mode !== 'edit') selectPin(null);
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
    controls.enabled = false;
    const sdc = S.sd(proj.hit.x, proj.hit.y, proj.hit.z);
    const fitD = 2 * (sdc - +$('minWall').value - +$('clearance').value);
    const d = Math.max(2.5, Math.min(+$('pinD').value, Math.floor(fitD * 2) / 2 || 2.5));
    const a = autoDir(S.sd, proj.hit, proj.axis, halfLen(), reqSdFor(d));
    const p = { x: proj.hit.x, y: proj.hit.y, z: proj.hit.z, _axis: proj.axis, tilt: a.tilt, az: a.az, d };
    addPinVisual(p);
    (S.pins.get(proj.key) ?? S.pins.set(proj.key, []).get(proj.key)).push(p);
    selectPin(p);
  }
});
canvas.addEventListener('pointermove', e => {
  if (S.mode !== 'edit' || !S.dragging) return;
  pickNDC(e); const proj = projectToActivePlane(); if (!proj) return;
  const p = S.dragging; p.x = proj.hit.x; p.y = proj.hit.y; p.z = proj.hit.z; updatePinVisual(p);
});
addEventListener('pointerup', () => { S.dragging = null; controls.enabled = true; });
canvas.addEventListener('contextmenu', e => { if (S.mode === 'edit') e.preventDefault(); });

// ----- ciecie + eksport -----
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
function showPieces() {
  modelGroup.visible = planeGroup.visible = pinGroup.visible = arrowGroup.visible = false;
  pieceGroup.clear(); S.pieceMeshes = []; const list = $('pieceList'); list.innerHTML = '';
  S.pieces.forEach((p, i) => {
    const mesh = new THREE.Mesh(p.geometry, new THREE.MeshStandardMaterial({ color: PALETTE[i % PALETTE.length], flatShading: true }));
    p.geometry.computeBoundingBox();
    mesh.userData.center = p.geometry.boundingBox.getCenter(new THREE.Vector3());
    pieceGroup.add(mesh); S.pieceMeshes.push(mesh);
    const li = document.createElement('div'); li.className = 'piece' + (p.fits ? '' : ' bad');
    li.textContent = `${p.fits ? '✓' : '⚠'} ${p.name}  ${p.size.map(s => s.toFixed(0)).join('×')} mm`; list.appendChild(li);
  });
  frame(pieceGroup); $('explode').value = 0;
}
$('explode').oninput = () => { const s = +$('explode').value; S.pieceMeshes.forEach(m => m.position.copy(m.userData.center).multiplyScalar(s)); };
$('download').onclick = () => {
  const exp = new STLExporter(), files = {};
  for (const p of S.pieces) { const dv = exp.parse(new THREE.Mesh(p.geometry), { binary: true }); files[p.name] = new Uint8Array(dv.buffer ?? dv); }
  const blob = new Blob([zipSync(files)], { type: 'application/zip' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'pieces.zip'; a.click();
};
setMode('view');
