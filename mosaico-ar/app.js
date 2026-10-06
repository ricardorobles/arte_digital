import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ARButton } from 'three/addons/webxr/ARButton.js';

const PIECES = [
  { src: './assets/piezas/pieza-01.jpg', name: 'Pieza 01', ratio: 1 },
  { src: './assets/piezas/pieza-02.jpg', name: 'Pieza 02', ratio: 1 },
  { src: './assets/piezas/pieza-03.jpg', name: 'Pieza 03', ratio: 1 },
  { src: './assets/piezas/pieza-04.jpg', name: 'Pieza 04', ratio: 1 },
  { src: './assets/piezas/pieza-05.jpg', name: 'Pieza 05', ratio: 1 },
  { src: './assets/piezas/pieza-06.jpg', name: 'Pieza 06', ratio: 1 }
];

const $ = (s) => document.querySelector(s);
const stage = $('#stage');
const intro = $('#intro');
const toolbox = $('#toolbox');
const showTools = $('#showTools');
const pieceStrip = $('#pieceStrip');
const startDesktop = $('#startDesktop');
const closeTools = $('#closeTools');
const depthRange = $('#depthRange');
const depthOutput = $('#depthOutput');
const scaleRange = $('#scaleRange');
const scaleOutput = $('#scaleOutput');
const undoBtn = $('#undoBtn');
const clearBtn = $('#clearBtn');
const saveBtn = $('#saveBtn');
const finishBtn = $('#finishBtn');
const resetView = $('#resetView');
const statusEl = $('#status');
const surfaceLabel = $('#surfaceLabel');
const mosaicCode = $('#mosaicCode');
const modeHelp = $('#modeHelp');
const arButtonMount = $('#arButtonMount');

const mosaicId = String(Math.floor(1000 + Math.random() * 9000));
mosaicCode.textContent = `#${mosaicId}`;

let selectedIndex = 0;
let currentDepth = Number(depthRange.value);
let currentScale = Number(scaleRange.value);
let placed = [];
let desktopMode = false;
let isAR = false;
let hitTestSource = null;
let hitTestSourceRequested = false;
let reticleVisibleLast = false;
let pointerDown = null;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf4f3ef);

const camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 0.01, 100);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.domElement.style.touchAction = 'none';
stage.appendChild(renderer.domElement);

const ambient = new THREE.HemisphereLight(0xffffff, 0xb7b4aa, 2.25);
scene.add(ambient);
const keyLight = new THREE.DirectionalLight(0xffffff, 2.6);
keyLight.position.set(3.5, 6.5, 4.5);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
keyLight.shadow.camera.left = -5;
keyLight.shadow.camera.right = 5;
keyLight.shadow.camera.top = 5;
keyLight.shadow.camera.bottom = -5;
scene.add(keyLight);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.07;
controls.enablePan = false;
controls.rotateSpeed = 0.72;
controls.zoomSpeed = 0.8;
controls.target.set(0, 1.25, -1.3);
controls.maxPolarAngle = Math.PI * 0.495;
controls.minPolarAngle = 0.16;
controls.minDistance = 1.5;
controls.maxDistance = 8;
controls.enabled = false;

function resetCamera() {
  camera.position.set(3.05, 2.45, 4.65);
  controls.target.set(0, 1.2, -1.45);
  controls.update();
}
resetCamera();

// Sala virtual mínima: piso + pared blanca. Es deliberadamente neutra para que la obra sea protagonista.
const room = new THREE.Group();
scene.add(room);

const floorMat = new THREE.MeshStandardMaterial({ color: 0xeeeDE8, roughness: 0.96, metalness: 0 });
const floor = new THREE.Mesh(new THREE.PlaneGeometry(8, 7), floorMat);
floor.rotation.x = -Math.PI / 2;
floor.position.set(0, 0, 0.55);
floor.receiveShadow = true;
floor.userData.surfaceType = 'floor';
room.add(floor);

const wallMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.97, metalness: 0 });
const wall = new THREE.Mesh(new THREE.PlaneGeometry(8, 4.2), wallMat);
wall.position.set(0, 2.1, -2.65);
wall.receiveShadow = true;
wall.userData.surfaceType = 'wall';
room.add(wall);

// Zócalo fino que ayuda a leer el encuentro espacial sin competir con las piezas.
const skirting = new THREE.Mesh(
  new THREE.BoxGeometry(8, 0.055, 0.045),
  new THREE.MeshStandardMaterial({ color: 0xd7d5cf, roughness: 1 })
);
skirting.position.set(0, 0.035, -2.61);
skirting.receiveShadow = true;
room.add(skirting);

const softShadow = new THREE.Mesh(
  new THREE.PlaneGeometry(7.5, 6.5),
  new THREE.ShadowMaterial({ opacity: 0.12 })
);
softShadow.rotation.x = -Math.PI / 2;
softShadow.position.y = 0.004;
softShadow.position.z = 0.5;
softShadow.receiveShadow = true;
room.add(softShadow);

const reticle = new THREE.Mesh(
  new THREE.RingGeometry(0.07, 0.09, 36).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.72 })
);
reticle.matrixAutoUpdate = false;
reticle.visible = false;
scene.add(reticle);

const controller = renderer.xr.getController(0);
controller.addEventListener('select', () => {
  if (!isAR || !reticle.visible) return;
  placeFromMatrix(reticle.matrix);
});
scene.add(controller);

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const textureLoader = new THREE.TextureLoader();
const textures = PIECES.map((piece) => {
  const texture = textureLoader.load(piece.src);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return texture;
});

function createPiece(pieceIndex, depth, scale = 1) {
  const group = new THREE.Group();
  const width = 0.72 * scale;
  const height = 0.72 * scale / PIECES[pieceIndex].ratio;
  const thickness = depth;

  const slab = new THREE.Mesh(
    new THREE.BoxGeometry(width, thickness, height),
    new THREE.MeshStandardMaterial({ color: 0xf3f1eb, roughness: 0.88, metalness: 0 })
  );
  slab.castShadow = true;
  slab.receiveShadow = true;
  group.add(slab);

  const image = new THREE.Mesh(
    new THREE.PlaneGeometry(width * 0.992, height * 0.992),
    new THREE.MeshBasicMaterial({ map: textures[pieceIndex], toneMapped: false })
  );
  image.rotation.x = -Math.PI / 2;
  image.position.y = thickness / 2 + 0.0015;
  group.add(image);

  const edge = new THREE.LineSegments(
    new THREE.EdgesGeometry(slab.geometry),
    new THREE.LineBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.18 })
  );
  group.add(edge);

  group.userData = {
    pieceIndex, depth, scale,
    id: `pieza-${Date.now()}-${Math.random().toString(16).slice(2)}`
  };
  return group;
}

function placeFromMatrix(matrix) {
  const piece = createPiece(selectedIndex, currentDepth, currentScale);
  matrix.decompose(piece.position, piece.quaternion, piece.scale);
  const normal = new THREE.Vector3(0, 1, 0).applyQuaternion(piece.quaternion);
  piece.position.addScaledVector(normal, currentDepth / 2 + 0.004);
  scene.add(piece);
  placed.push(piece);
  flash(`Pieza ${selectedIndex + 1} colocada`);
}

function rayFromClient(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  return raycaster.intersectObjects([wall, floor], false);
}

function placeOnDesktop(clientX, clientY) {
  if (!desktopMode || isAR) return;
  const hits = rayFromClient(clientX, clientY);
  if (!hits.length) return;

  const hit = hits[0];
  const piece = createPiece(selectedIndex, currentDepth, currentScale);
  piece.position.copy(hit.point);

  if (hit.object.userData.surfaceType === 'floor') {
    piece.quaternion.identity();
    piece.position.y += currentDepth / 2 + 0.004;
  } else {
    piece.quaternion.setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0));
    piece.position.z += currentDepth / 2 + 0.006;
  }

  scene.add(piece);
  placed.push(piece);
  flash(`${PIECES[selectedIndex].name} · ${hit.object.userData.surfaceType === 'floor' ? 'piso' : 'pared'}`);
}

// En móvil distinguimos un toque de un gesto de órbita. Así se puede componer con un dedo.
renderer.domElement.addEventListener('pointerdown', (event) => {
  if (!desktopMode || isAR) return;
  pointerDown = { x: event.clientX, y: event.clientY, t: performance.now() };
});
renderer.domElement.addEventListener('pointerup', (event) => {
  if (!desktopMode || isAR || !pointerDown) return;
  const dx = event.clientX - pointerDown.x;
  const dy = event.clientY - pointerDown.y;
  const dist = Math.hypot(dx, dy);
  const elapsed = performance.now() - pointerDown.t;
  pointerDown = null;
  if (dist < 7 && elapsed < 450) placeOnDesktop(event.clientX, event.clientY);
});

function buildPieceButtons() {
  PIECES.forEach((piece, i) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `piece-button${i === selectedIndex ? ' selected' : ''}`;
    button.dataset.index = String(i + 1).padStart(2, '0');
    button.setAttribute('aria-label', `Seleccionar ${piece.name}`);
    button.innerHTML = `<img src="${piece.src}" alt="${piece.name}">`;
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      selectedIndex = i;
      document.querySelectorAll('.piece-button').forEach((el, idx) => el.classList.toggle('selected', idx === i));
      flash(`${piece.name} seleccionada`);
    });
    pieceStrip.appendChild(button);
  });
}
buildPieceButtons();

depthRange.addEventListener('input', () => {
  currentDepth = Number(depthRange.value);
  depthOutput.textContent = `${Math.round(currentDepth * 100)} cm`;
});
scaleRange.addEventListener('input', () => {
  currentScale = Number(scaleRange.value);
  scaleOutput.textContent = `${Math.round(currentScale * 100)}%`;
});

function enterDesktop() {
  desktopMode = true;
  controls.enabled = true;
  resetCamera();
  intro.classList.add('hidden');
  toolbox.classList.remove('hidden');
  resetView.classList.remove('hidden');
  surfaceLabel.classList.remove('hidden');
  room.visible = true;
  modeHelp.textContent = 'Tocá la pared o el piso para colocar. Arrastrá para mirar alrededor y pellizcá para acercarte.';
  flash('Entorno 3D listo');
}
startDesktop.addEventListener('click', enterDesktop);
resetView.addEventListener('click', resetCamera);

closeTools.addEventListener('click', () => {
  toolbox.classList.add('hidden');
  showTools.classList.remove('hidden');
});
showTools.addEventListener('click', () => {
  showTools.classList.add('hidden');
  toolbox.classList.remove('hidden');
});
finishBtn.addEventListener('click', () => {
  toolbox.classList.add('hidden');
  showTools.classList.remove('hidden');
  flash(`Mosaico #${mosaicId} listo`);
});
undoBtn.addEventListener('click', undoLast);
clearBtn.addEventListener('click', clearAll);
saveBtn.addEventListener('click', saveComposition);

function undoLast() {
  const last = placed.pop();
  if (!last) return flash('No hay piezas para deshacer');
  scene.remove(last);
  disposeObject(last);
  flash('Última pieza eliminada');
}
function clearAll() {
  if (!placed.length) return flash('El mosaico ya está vacío');
  placed.forEach((obj) => { scene.remove(obj); disposeObject(obj); });
  placed = [];
  flash('Mosaico vacío');
}
function disposeObject(root) {
  root.traverse((obj) => {
    if (obj.geometry) obj.geometry.dispose();
    if (obj.material) {
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      mats.forEach((m) => m.dispose?.());
    }
  });
}
function saveComposition() {
  const data = {
    obra: 'Mosaico AR', codigo: `MOSAICO-${mosaicId}`, fecha: new Date().toISOString(),
    piezas: placed.map((piece) => ({
      pieza: piece.userData.pieceIndex + 1,
      profundidad_m: piece.userData.depth,
      escala: piece.userData.scale,
      posicion: piece.position.toArray(),
      quaternion: piece.quaternion.toArray()
    }))
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `mosaico-${mosaicId}.json`;
  a.click();
  URL.revokeObjectURL(url);
  flash(`Composición #${mosaicId} guardada`);
}

let flashTimer;
function flash(message) {
  clearTimeout(flashTimer);
  statusEl.textContent = message;
  statusEl.classList.add('visible');
  flashTimer = setTimeout(() => statusEl.classList.remove('visible'), 1800);
}

// AR real: se conserva como segunda opción. El entorno 3D funciona aunque WebXR no esté disponible.
try {
  const arButton = ARButton.createButton(renderer, {
    requiredFeatures: ['hit-test'],
    optionalFeatures: ['dom-overlay'],
    domOverlay: { root: document.body }
  });
  arButton.id = 'ARButton';
  arButtonMount.appendChild(arButton);
} catch (err) {
  console.warn('AR no disponible:', err);
}

renderer.xr.addEventListener('sessionstart', () => {
  isAR = true;
  desktopMode = false;
  controls.enabled = false;
  scene.background = null;
  room.visible = false;
  intro.classList.add('hidden');
  toolbox.classList.remove('hidden');
  resetView.classList.add('hidden');
  surfaceLabel.classList.add('hidden');
  modeHelp.textContent = 'Mové el teléfono lentamente hasta detectar una superficie. Tocá para colocar la pieza.';
  hitTestSourceRequested = false;
  hitTestSource = null;
  flash('Buscando superficie…');
});

renderer.xr.addEventListener('sessionend', () => {
  isAR = false;
  scene.background = new THREE.Color(0xf4f3ef);
  reticle.visible = false;
  hitTestSourceRequested = false;
  hitTestSource = null;
  room.visible = true;
});

function updateARHitTest(frame) {
  if (!frame || !isAR) return;
  const session = renderer.xr.getSession();
  if (!hitTestSourceRequested) {
    session.requestReferenceSpace('viewer').then((referenceSpace) => {
      session.requestHitTestSource({ space: referenceSpace }).then((source) => { hitTestSource = source; });
    });
    session.addEventListener('end', () => { hitTestSourceRequested = false; hitTestSource = null; });
    hitTestSourceRequested = true;
  }
  if (hitTestSource) {
    const referenceSpace = renderer.xr.getReferenceSpace();
    const results = frame.getHitTestResults(hitTestSource);
    if (results.length) {
      const pose = results[0].getPose(referenceSpace);
      reticle.visible = true;
      reticle.matrix.fromArray(pose.transform.matrix);
      if (!reticleVisibleLast) flash('Superficie detectada');
      reticleVisibleLast = true;
    } else {
      reticle.visible = false;
      reticleVisibleLast = false;
    }
  }
}

function animate(_timestamp, frame) {
  controls.update();
  updateARHitTest(frame);
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(animate);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
