import * as THREE from 'https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js';
import { OrbitControls } from 'https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/controls/OrbitControls.js';
import { ARButton } from 'https://cdn.jsdelivr.net/npm/three@0.169.0/examples/jsm/webxr/ARButton.js';

const PIECES = [
  { src: './assets/piezas/pieza-01.jpg', name: 'Pieza 01', ratio: 1 },
  { src: './assets/piezas/pieza-02.jpg', name: 'Pieza 02', ratio: 1 },
  { src: './assets/piezas/pieza-03.jpg', name: 'Pieza 03', ratio: 1 },
  { src: './assets/piezas/pieza-04.jpg', name: 'Pieza 04', ratio: 1 },
  { src: './assets/piezas/pieza-05.jpg', name: 'Pieza 05', ratio: 1 },
  { src: './assets/piezas/pieza-06.jpg', name: 'Pieza 06', ratio: 1 }
];

const stage = document.querySelector('#stage');
const intro = document.querySelector('#intro');
const toolbox = document.querySelector('#toolbox');
const showTools = document.querySelector('#showTools');
const pieceStrip = document.querySelector('#pieceStrip');
const startDesktop = document.querySelector('#startDesktop');
const closeTools = document.querySelector('#closeTools');
const depthRange = document.querySelector('#depthRange');
const depthOutput = document.querySelector('#depthOutput');
const scaleRange = document.querySelector('#scaleRange');
const scaleOutput = document.querySelector('#scaleOutput');
const undoBtn = document.querySelector('#undoBtn');
const clearBtn = document.querySelector('#clearBtn');
const saveBtn = document.querySelector('#saveBtn');
const finishBtn = document.querySelector('#finishBtn');
const statusEl = document.querySelector('#status');
const mosaicCode = document.querySelector('#mosaicCode');
const modeHelp = document.querySelector('#modeHelp');
const arButtonMount = document.querySelector('#arButtonMount');

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

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf7f6f2);

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.01, 100);
camera.position.set(2.7, 2.4, 3.8);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.xr.enabled = true;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
stage.appendChild(renderer.domElement);

const ambient = new THREE.HemisphereLight(0xffffff, 0x8c8c86, 2.0);
scene.add(ambient);
const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
keyLight.position.set(3, 6, 4);
keyLight.castShadow = true;
scene.add(keyLight);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.target.set(0, 0.9, 0);
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 1.5;
controls.maxDistance = 9;
controls.enabled = false;

// Desktop surfaces: one floor and one wall, intentionally neutral and gallery-like.
const floorMat = new THREE.MeshStandardMaterial({ color: 0xeceae4, roughness: 0.92, metalness: 0 });
const floor = new THREE.Mesh(new THREE.PlaneGeometry(7, 6), floorMat);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
floor.userData.surfaceType = 'floor';
scene.add(floor);

const wallMat = new THREE.MeshStandardMaterial({ color: 0xf8f7f3, roughness: 0.96, metalness: 0 });
const wall = new THREE.Mesh(new THREE.PlaneGeometry(7, 3.6), wallMat);
wall.position.set(0, 1.8, -2.2);
wall.userData.surfaceType = 'wall';
wall.receiveShadow = true;
scene.add(wall);

const grid = new THREE.GridHelper(7, 14, 0xbab8b2, 0xd8d6d0);
grid.position.y = 0.002;
grid.material.opacity = 0.16;
grid.material.transparent = true;
scene.add(grid);

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
  placeFromMatrix(reticle.matrix, 'ar');
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
    new THREE.MeshStandardMaterial({ color: 0xf4f2ed, roughness: 0.86, metalness: 0 })
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

  // Very thin black edge: recalls the drawn outlines without altering the original image.
  const edge = new THREE.LineSegments(
    new THREE.EdgesGeometry(slab.geometry),
    new THREE.LineBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.22 })
  );
  group.add(edge);

  group.userData = {
    pieceIndex,
    depth,
    scale,
    id: `pieza-${Date.now()}-${Math.random().toString(16).slice(2)}`
  };
  return group;
}

function placeFromMatrix(matrix, source = 'ar') {
  const piece = createPiece(selectedIndex, currentDepth, currentScale);
  matrix.decompose(piece.position, piece.quaternion, piece.scale);

  // Slightly lift from detected plane to avoid z-fighting.
  const normal = new THREE.Vector3(0, 1, 0).applyQuaternion(piece.quaternion);
  piece.position.addScaledVector(normal, currentDepth / 2 + 0.004);

  scene.add(piece);
  placed.push(piece);
  flash(`Pieza ${selectedIndex + 1} colocada`);
}

function placeOnDesktop(event) {
  if (!desktopMode || isAR) return;
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);

  const hits = raycaster.intersectObjects([wall, floor], false);
  if (!hits.length) return;

  const hit = hits[0];
  const piece = createPiece(selectedIndex, currentDepth, currentScale);
  piece.position.copy(hit.point);

  if (hit.object.userData.surfaceType === 'floor') {
    // local Y points out of floor; tile face remains upward.
    piece.quaternion.identity();
    piece.position.y += currentDepth / 2 + 0.004;
  } else {
    // local Y must point toward camera from wall; rotate tile from floor orientation to wall orientation.
    piece.quaternion.setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0));
    piece.position.z += currentDepth / 2 + 0.004;
  }

  scene.add(piece);
  placed.push(piece);
  flash(`Pieza ${selectedIndex + 1} colocada`);
}

renderer.domElement.addEventListener('dblclick', placeOnDesktop);
renderer.domElement.addEventListener('click', (event) => {
  if (!desktopMode || isAR) return;
  // Avoid accidental placement while orbiting: single click only if pointer barely moved.
  if (Math.abs(event.movementX || 0) < 2 && Math.abs(event.movementY || 0) < 2) placeOnDesktop(event);
});

function buildPieceButtons() {
  PIECES.forEach((piece, i) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `piece-button${i === selectedIndex ? ' selected' : ''}`;
    button.dataset.index = String(i + 1).padStart(2, '0');
    button.setAttribute('aria-label', `Seleccionar ${piece.name}`);
    button.innerHTML = `<img src="${piece.src}" alt="${piece.name}">`;
    button.addEventListener('click', () => {
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
  intro.classList.add('hidden');
  toolbox.classList.remove('hidden');
  floor.visible = true;
  wall.visible = true;
  grid.visible = true;
  modeHelp.textContent = 'Hacé clic sobre el piso o la pared para colocar una pieza. Arrastrá para orbitar y usá la rueda para acercarte.';
}
startDesktop.addEventListener('click', enterDesktop);

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
  placed.forEach((obj) => {
    scene.remove(obj);
    disposeObject(obj);
  });
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
    obra: 'Mosaico AR',
    codigo: `MOSAICO-${mosaicId}`,
    fecha: new Date().toISOString(),
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

// AR setup. The page remains fully usable in 3D when immersive-ar is unavailable.
const arButton = ARButton.createButton(renderer, {
  requiredFeatures: ['hit-test'],
  optionalFeatures: ['dom-overlay'],
  domOverlay: { root: document.body }
});
arButton.id = 'ARButton';
arButtonMount.appendChild(arButton);

renderer.xr.addEventListener('sessionstart', () => {
  isAR = true;
  desktopMode = false;
  controls.enabled = false;
  scene.background = null;
  floor.visible = false;
  wall.visible = false;
  grid.visible = false;
  intro.classList.add('hidden');
  toolbox.classList.remove('hidden');
  modeHelp.textContent = 'Mové el teléfono lentamente hasta detectar una superficie. Tocá la pantalla para colocar la pieza.';
  hitTestSourceRequested = false;
  hitTestSource = null;
  flash('Buscando superficie…');
});

renderer.xr.addEventListener('sessionend', () => {
  isAR = false;
  scene.background = new THREE.Color(0xf7f6f2);
  reticle.visible = false;
  hitTestSourceRequested = false;
  hitTestSource = null;
  if (!desktopMode) {
    floor.visible = true;
    wall.visible = true;
    grid.visible = true;
  }
});

function updateARHitTest(timestamp, frame) {
  if (!frame || !isAR) return;
  const session = renderer.xr.getSession();

  if (!hitTestSourceRequested) {
    session.requestReferenceSpace('viewer').then((referenceSpace) => {
      session.requestHitTestSource({ space: referenceSpace }).then((source) => {
        hitTestSource = source;
      });
    });
    session.addEventListener('end', () => {
      hitTestSourceRequested = false;
      hitTestSource = null;
    });
    hitTestSourceRequested = true;
  }

  if (hitTestSource) {
    const referenceSpace = renderer.xr.getReferenceSpace();
    const results = frame.getHitTestResults(hitTestSource);
    if (results.length) {
      const hit = results[0];
      const pose = hit.getPose(referenceSpace);
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

function animate(timestamp, frame) {
  controls.update();
  updateARHitTest(timestamp, frame);
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(animate);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
