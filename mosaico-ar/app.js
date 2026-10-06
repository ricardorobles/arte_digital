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

const BASE_SIZE = 0.72;
const EPS = 0.004;
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
const selectionLabel = $('#selectionLabel');
const toolboxTitle = $('#toolboxTitle');
const editRow = $('#editRow');
const relocateBtn = $('#relocateBtn');
const deleteBtn = $('#deleteBtn');
const deselectBtn = $('#deselectBtn');

const mosaicId = String(Math.floor(1000 + Math.random() * 9000));
mosaicCode.textContent = `#${mosaicId}`;

let selectedIndex = 0;
let currentDepth = Number(depthRange.value);
let currentScale = Number(scaleRange.value);
let placed = [];
let selectedPiece = null;
let desktopMode = false;
let isAR = false;
let relocating = false;
let hitTestSource = null;
let hitTestSourceRequested = false;
let reticleVisibleLast = false;
let pointerDown = null;
let draggingPiece = false;
let dragMoved = false;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf4f3ef);
const camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 0.01, 100);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, premultipliedAlpha: true });
renderer.setClearColor(0x000000, 0);
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

const room = new THREE.Group();
scene.add(room);
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(8, 7),
  new THREE.MeshStandardMaterial({ color: 0xeeede8, roughness: 0.96, metalness: 0 })
);
floor.rotation.x = -Math.PI / 2;
floor.position.set(0, 0, 0.55);
floor.receiveShadow = true;
floor.userData.surfaceType = 'floor';
room.add(floor);

const wall = new THREE.Mesh(
  new THREE.PlaneGeometry(8, 4.2),
  new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.97, metalness: 0 })
);
wall.position.set(0, 2.1, -2.65);
wall.receiveShadow = true;
wall.userData.surfaceType = 'wall';
room.add(wall);

const skirting = new THREE.Mesh(
  new THREE.BoxGeometry(8, 0.055, 0.045),
  new THREE.MeshStandardMaterial({ color: 0xd7d5cf, roughness: 1 })
);
skirting.position.set(0, 0.035, -2.61);
room.add(skirting);

const reticle = new THREE.Mesh(
  new THREE.RingGeometry(0.07, 0.09, 36).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0x111111, transparent: true, opacity: 0.72 })
);
reticle.matrixAutoUpdate = false;
reticle.visible = false;
scene.add(reticle);

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const textureLoader = new THREE.TextureLoader();
const textures = PIECES.map((piece) => {
  const texture = textureLoader.load(piece.src);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  return texture;
});

const selectionBox = new THREE.BoxHelper(undefined, 0x111111);
selectionBox.visible = false;
selectionBox.material.transparent = true;
selectionBox.material.opacity = 0.75;
selectionBox.material.depthTest = false;
selectionBox.renderOrder = 999;
scene.add(selectionBox);

function createPiece(pieceIndex, depth, scale = 1) {
  const group = new THREE.Group();
  const baseHeight = BASE_SIZE / PIECES[pieceIndex].ratio;

  const slab = new THREE.Mesh(
    new THREE.BoxGeometry(BASE_SIZE, 1, baseHeight),
    new THREE.MeshStandardMaterial({ color: 0xf3f1eb, roughness: 0.88, metalness: 0 })
  );
  slab.name = 'slab';
  slab.castShadow = true;
  slab.receiveShadow = true;
  group.add(slab);

  const image = new THREE.Mesh(
    new THREE.PlaneGeometry(BASE_SIZE * 0.992, baseHeight * 0.992),
    new THREE.MeshBasicMaterial({ map: textures[pieceIndex], toneMapped: false, side: THREE.DoubleSide })
  );
  image.name = 'image';
  image.rotation.x = -Math.PI / 2;
  group.add(image);

  group.userData = {
    isMosaicPiece: true,
    pieceIndex,
    depth,
    scale,
    surfaceType: null,
    anchor: new THREE.Vector3(),
    id: `pieza-${Date.now()}-${Math.random().toString(16).slice(2)}`
  };
  updatePieceGeometry(group);
  return group;
}

function updatePieceGeometry(piece) {
  const { depth, scale } = piece.userData;
  const slab = piece.getObjectByName('slab');
  const image = piece.getObjectByName('image');
  slab.scale.set(scale, depth, scale);
  image.scale.set(scale, scale, 1);
  image.position.y = depth / 2 + 0.0015;
  updatePiecePosition(piece);
  if (piece === selectedPiece) selectionBox.update();
}

function updatePiecePosition(piece) {
  if (!piece.userData.anchor) return;
  const normal = new THREE.Vector3(0, 1, 0).applyQuaternion(piece.quaternion).normalize();
  piece.position.copy(piece.userData.anchor).addScaledVector(normal, piece.userData.depth / 2 + EPS);
}

function selectPiece(piece, announce = true) {
  selectedPiece = piece;
  relocating = false;
  selectionBox.setFromObject(piece);
  selectionBox.visible = true;
  depthRange.value = String(piece.userData.depth);
  scaleRange.value = String(piece.userData.scale);
  currentDepth = piece.userData.depth;
  currentScale = piece.userData.scale;
  updateOutputs();
  editRow.classList.remove('hidden');
  toolboxTitle.textContent = 'EDITAR PIEZA';
  selectionLabel.textContent = `· ${PIECES[piece.userData.pieceIndex].name}`;
  if (announce) flash(`${PIECES[piece.userData.pieceIndex].name} seleccionada`);
}

function deselectPiece(announce = false) {
  selectedPiece = null;
  relocating = false;
  selectionBox.visible = false;
  editRow.classList.add('hidden');
  toolboxTitle.textContent = 'NUEVA PIEZA';
  selectionLabel.textContent = '· ninguna seleccionada';
  depthRange.value = String(currentDepth);
  scaleRange.value = String(currentScale);
  relocateBtn.classList.remove('active');
  if (announce) flash('Modo nueva pieza');
}

function rootPieceFromObject(obj) {
  let cur = obj;
  while (cur && cur !== scene) {
    if (cur.userData?.isMosaicPiece) return cur;
    cur = cur.parent;
  }
  return null;
}

function setPieceAnchorAndOrientation(piece, anchor, quaternion, surfaceType = 'ar') {
  piece.userData.anchor.copy(anchor);
  piece.quaternion.copy(quaternion);
  piece.userData.surfaceType = surfaceType;
  updatePiecePosition(piece);
  if (piece === selectedPiece) selectionBox.update();
}

function placeFromMatrix(matrix) {
  const anchor = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const ignoredScale = new THREE.Vector3();
  matrix.decompose(anchor, quaternion, ignoredScale);
  const piece = createPiece(selectedIndex, currentDepth, currentScale);
  setPieceAnchorAndOrientation(piece, anchor, quaternion, 'ar');
  scene.add(piece);
  placed.push(piece);
  selectPiece(piece, false);
  flash(`${PIECES[selectedIndex].name} colocada`);
}

function moveSelectedFromMatrix(matrix) {
  if (!selectedPiece) return;
  const anchor = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const ignoredScale = new THREE.Vector3();
  matrix.decompose(anchor, quaternion, ignoredScale);
  setPieceAnchorAndOrientation(selectedPiece, anchor, quaternion, 'ar');
  relocating = false;
  relocateBtn.classList.remove('active');
  flash('Pieza reubicada');
}

function rayFromClient(clientX, clientY, objects, recursive = false) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  return raycaster.intersectObjects(objects, recursive);
}

function pieceHitFromClient(clientX, clientY) {
  const hits = rayFromClient(clientX, clientY, placed, true);
  return hits.length ? rootPieceFromObject(hits[0].object) : null;
}

function surfaceHitFromClient(clientX, clientY) {
  const hits = rayFromClient(clientX, clientY, [wall, floor], false);
  return hits.length ? hits[0] : null;
}

function surfaceOrientation(hit) {
  const q = new THREE.Quaternion();
  if (hit.object.userData.surfaceType === 'wall') q.setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0));
  return q;
}

function placeOnDesktop(clientX, clientY) {
  const hit = surfaceHitFromClient(clientX, clientY);
  if (!hit) return;
  const piece = createPiece(selectedIndex, currentDepth, currentScale);
  setPieceAnchorAndOrientation(piece, hit.point, surfaceOrientation(hit), hit.object.userData.surfaceType);
  scene.add(piece);
  placed.push(piece);
  selectPiece(piece, false);
  flash(`${PIECES[selectedIndex].name} · ${hit.object.userData.surfaceType === 'floor' ? 'piso' : 'pared'}`);
}

function moveSelectedOnDesktop(clientX, clientY) {
  if (!selectedPiece) return false;
  const hit = surfaceHitFromClient(clientX, clientY);
  if (!hit) return false;
  // Para arrastre directo conservamos la superficie actual para evitar saltos involuntarios pared↔piso.
  if (selectedPiece.userData.surfaceType && hit.object.userData.surfaceType !== selectedPiece.userData.surfaceType) return false;
  setPieceAnchorAndOrientation(selectedPiece, hit.point, surfaceOrientation(hit), hit.object.userData.surfaceType);
  return true;
}

renderer.domElement.addEventListener('pointerdown', (event) => {
  if (!desktopMode || isAR) return;
  const hitPiece = pieceHitFromClient(event.clientX, event.clientY);
  pointerDown = { x: event.clientX, y: event.clientY, t: performance.now(), hitPiece };
  dragMoved = false;
  if (hitPiece) {
    selectPiece(hitPiece);
    draggingPiece = true;
    controls.enabled = false;
    renderer.domElement.setPointerCapture?.(event.pointerId);
  }
});

renderer.domElement.addEventListener('pointermove', (event) => {
  if (!desktopMode || isAR || !draggingPiece || !selectedPiece || !pointerDown) return;
  const dist = Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y);
  if (dist > 5) {
    dragMoved = true;
    moveSelectedOnDesktop(event.clientX, event.clientY);
  }
});

renderer.domElement.addEventListener('pointerup', (event) => {
  if (!desktopMode || isAR || !pointerDown) return;
  const down = pointerDown;
  pointerDown = null;
  if (draggingPiece) {
    draggingPiece = false;
    controls.enabled = true;
    renderer.domElement.releasePointerCapture?.(event.pointerId);
    if (dragMoved) flash('Pieza movida');
    dragMoved = false;
    return;
  }
  const dist = Math.hypot(event.clientX - down.x, event.clientY - down.y);
  const elapsed = performance.now() - down.t;
  if (dist >= 7 || elapsed >= 450) return;

  if (relocating && selectedPiece) {
    const hit = surfaceHitFromClient(event.clientX, event.clientY);
    if (hit) {
      setPieceAnchorAndOrientation(selectedPiece, hit.point, surfaceOrientation(hit), hit.object.userData.surfaceType);
      relocating = false;
      relocateBtn.classList.remove('active');
      flash('Pieza reubicada');
    }
    return;
  }
  placeOnDesktop(event.clientX, event.clientY);
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
      deselectPiece(false);
      flash(`${piece.name} lista para colocar`);
    });
    pieceStrip.appendChild(button);
  });
}
buildPieceButtons();

function updateOutputs() {
  depthOutput.textContent = `${Math.round(Number(depthRange.value) * 100)} cm`;
  scaleOutput.textContent = `${Math.round(Number(scaleRange.value) * 100)}%`;
}

depthRange.addEventListener('input', () => {
  const value = Number(depthRange.value);
  currentDepth = value;
  depthOutput.textContent = `${Math.round(value * 100)} cm`;
  if (selectedPiece) {
    selectedPiece.userData.depth = value;
    updatePieceGeometry(selectedPiece);
  }
});
scaleRange.addEventListener('input', () => {
  const value = Number(scaleRange.value);
  currentScale = value;
  scaleOutput.textContent = `${Math.round(value * 100)}%`;
  if (selectedPiece) {
    selectedPiece.userData.scale = value;
    updatePieceGeometry(selectedPiece);
  }
});

function enterDesktop() {
  document.body.classList.remove('ar-active');
  desktopMode = true;
  controls.enabled = true;
  resetCamera();
  intro.classList.add('hidden');
  toolbox.classList.remove('hidden');
  resetView.classList.remove('hidden');
  surfaceLabel.classList.remove('hidden');
  room.visible = true;
  modeHelp.textContent = 'Tocá una pieza para editarla. Arrastrala sobre su superficie para moverla. Tocá pared o piso para agregar otra.';
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
  deselectPiece(false);
  toolbox.classList.add('hidden');
  showTools.classList.remove('hidden');
  flash(`Mosaico #${mosaicId} listo`);
});
undoBtn.addEventListener('click', undoLast);
clearBtn.addEventListener('click', clearAll);
saveBtn.addEventListener('click', saveComposition);
deleteBtn.addEventListener('click', deleteSelected);
deselectBtn.addEventListener('click', () => deselectPiece(true));
relocateBtn.addEventListener('click', () => {
  if (!selectedPiece) return;
  relocating = !relocating;
  relocateBtn.classList.toggle('active', relocating);
  if (relocating) {
    flash(isAR ? 'Apuntá a otra superficie y tocá' : 'Tocá otra posición en pared o piso');
    modeHelp.textContent = isAR
      ? 'REUBICAR activo: apuntá a la nueva superficie y tocá. La pieza seleccionada se moverá allí.'
      : 'REUBICAR activo: tocá una nueva posición en la pared o el piso.';
  } else {
    flash('Reubicación cancelada');
  }
});

function deleteSelected() {
  if (!selectedPiece) return;
  const idx = placed.indexOf(selectedPiece);
  if (idx >= 0) placed.splice(idx, 1);
  scene.remove(selectedPiece);
  disposeObject(selectedPiece);
  selectedPiece = null;
  deselectPiece(false);
  flash('Pieza eliminada');
}
function undoLast() {
  const last = placed.pop();
  if (!last) return flash('No hay piezas para deshacer');
  if (last === selectedPiece) selectedPiece = null;
  scene.remove(last);
  disposeObject(last);
  deselectPiece(false);
  flash('Última pieza eliminada');
}
function clearAll() {
  if (!placed.length) return flash('El mosaico ya está vacío');
  placed.forEach((obj) => { scene.remove(obj); disposeObject(obj); });
  placed = [];
  selectedPiece = null;
  deselectPiece(false);
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
      superficie: piece.userData.surfaceType,
      anclaje: piece.userData.anchor.toArray(),
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
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  flash(`Composición #${mosaicId} guardada`);
}

let flashTimer;
function flash(message) {
  clearTimeout(flashTimer);
  statusEl.textContent = message;
  statusEl.classList.add('visible');
  flashTimer = setTimeout(() => statusEl.classList.remove('visible'), 1900);
}

const controller = renderer.xr.getController(0);
const controllerRayMatrix = new THREE.Matrix4();
const controllerRayOrigin = new THREE.Vector3();
const controllerRayDirection = new THREE.Vector3();
controller.addEventListener('select', () => {
  if (!isAR) return;

  controllerRayMatrix.identity().extractRotation(controller.matrixWorld);
  controllerRayOrigin.setFromMatrixPosition(controller.matrixWorld);
  controllerRayDirection.set(0, 0, -1).applyMatrix4(controllerRayMatrix).normalize();
  raycaster.set(controllerRayOrigin, controllerRayDirection);
  const pieceHits = raycaster.intersectObjects(placed, true);
  if (pieceHits.length) {
    const piece = rootPieceFromObject(pieceHits[0].object);
    if (piece) {
      selectPiece(piece);
      return;
    }
  }

  if (!reticle.visible) {
    flash('Todavía no hay una superficie detectada');
    return;
  }
  if (relocating && selectedPiece) moveSelectedFromMatrix(reticle.matrix);
  else placeFromMatrix(reticle.matrix);
});
scene.add(controller);

async function setupARButton() {
  try {
    const supported = navigator.xr && await navigator.xr.isSessionSupported('immersive-ar');
    if (!supported) {
      const msg = document.createElement('button');
      msg.type = 'button';
      msg.className = 'button disabled-ar';
      msg.textContent = 'AR NO DISPONIBLE EN ESTE NAVEGADOR';
      msg.disabled = true;
      arButtonMount.appendChild(msg);
      return;
    }
    const arButton = ARButton.createButton(renderer, {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['dom-overlay', 'local-floor'],
      domOverlay: { root: document.body }
    });
    arButton.id = 'ARButton';
    arButtonMount.appendChild(arButton);
  } catch (err) {
    console.warn('AR no disponible:', err);
  }
}
setupARButton();

renderer.xr.addEventListener('sessionstart', () => {
  isAR = true;
  desktopMode = false;
  controls.enabled = false;
  document.body.classList.add('ar-active');
  scene.background = null;
  renderer.setClearColor(0x000000, 0);
  room.visible = false;
  intro.classList.add('hidden');
  toolbox.classList.remove('hidden');
  resetView.classList.add('hidden');
  surfaceLabel.classList.add('hidden');
  modeHelp.textContent = 'Mové el teléfono lentamente. Cuando aparezca el aro, tocá para colocar. Tocá una pieza para editarla.';
  hitTestSourceRequested = false;
  hitTestSource = null;
  reticleVisibleLast = false;
  deselectPiece(false);
  flash('Cámara activa · buscando superficie…');
});

renderer.xr.addEventListener('sessionend', () => {
  isAR = false;
  document.body.classList.remove('ar-active');
  scene.background = new THREE.Color(0xf4f3ef);
  reticle.visible = false;
  hitTestSourceRequested = false;
  hitTestSource = null;
  room.visible = true;
  deselectPiece(false);
});

function updateARHitTest(frame) {
  if (!frame || !isAR) return;
  const session = renderer.xr.getSession();
  if (!hitTestSourceRequested) {
    session.requestReferenceSpace('viewer').then((referenceSpace) => {
      session.requestHitTestSource({ space: referenceSpace }).then((source) => { hitTestSource = source; });
    }).catch(() => flash('No se pudo iniciar la detección de superficies'));
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
      if (!reticleVisibleLast) flash('Superficie detectada · tocá para colocar');
      reticleVisibleLast = true;
    } else {
      reticle.visible = false;
      reticleVisibleLast = false;
    }
  }
}

function animate(_timestamp, frame) {
  if (!isAR) controls.update();
  updateARHitTest(frame);
  if (selectedPiece) selectionBox.update();
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(animate);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
