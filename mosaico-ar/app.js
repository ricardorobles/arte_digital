import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ARButton } from 'three/addons/webxr/ARButton.js';

const FALLBACK_FILES = ['pieza-01.jpg','pieza-02.jpg','pieza-03.jpg','pieza-04.jpg','pieza-05.jpg','pieza-06.jpg'];
const IMAGE_RE = /\.(png|jpe?g|webp)$/i;

function prettyPieceName(filename) {
  const stem = filename.replace(/\.[^.]+$/, '');
  return stem.replace(/[-_]+/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

function decodeXmlEntities(value) {
  const el = document.createElement('textarea');
  el.innerHTML = value;
  return el.value;
}

function extractXmpDescription(buffer) {
  try {
    const bytes = new Uint8Array(buffer);
    const decoder = new TextDecoder('utf-8', { fatal: false });

    // Photoshop y otros editores suelen guardar "Description" como
    // Dublin Core dc:description dentro de un paquete XMP del JPEG.
    const startMarker = new TextEncoder().encode('<?xpacket');
    const endMarker = new TextEncoder().encode('<?xpacket end=');

    function findSequence(haystack, needle, from = 0) {
      outer: for (let i = from; i <= haystack.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) {
          if (haystack[i + j] !== needle[j]) continue outer;
        }
        return i;
      }
      return -1;
    }

    const start = findSequence(bytes, startMarker);
    if (start < 0) return '';
    const endStart = findSequence(bytes, endMarker, start);
    const end = endStart >= 0 ? Math.min(bytes.length, endStart + 96) : Math.min(bytes.length, start + 256000);
    const xmlChunk = decoder.decode(bytes.slice(start, end));

    // Primera opción: parsear el XML correctamente por namespace.
    const xmlEnd = xmlChunk.lastIndexOf('</x:xmpmeta>');
    const xmlText = xmlEnd >= 0 ? xmlChunk.slice(0, xmlEnd + '</x:xmpmeta>'.length) : xmlChunk;
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    const dc = doc.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'description')[0];
    if (dc) {
      const lis = dc.getElementsByTagNameNS('http://www.w3.org/1999/02/22-rdf-syntax-ns#', 'li');
      const text = (lis[0]?.textContent || dc.textContent || '').trim();
      if (text) return text;
    }

    // Fallback tolerante para XMP ligeramente distinto.
    const match = xmlText.match(/<dc:description[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>[\s\S]*?<\/dc:description>/i);
    return match ? decodeXmlEntities(match[1].replace(/<[^>]+>/g, '')).trim() : '';
  } catch (err) {
    console.warn('No se pudo leer XMP:', err);
    return '';
  }
}

async function readImageMetadataDescription(src) {
  try {
    const response = await fetch(src, { cache: 'no-store' });
    if (!response.ok) return '';
    const buffer = await response.arrayBuffer();
    return extractXmpDescription(buffer);
  } catch (err) {
    console.warn('No se pudo leer la descripción embebida:', src, err);
    return '';
  }
}

async function loadPieceCatalog() {
  let imageNames = [...FALLBACK_FILES];
  try {
    const host = location.hostname.toLowerCase();
    if (host.endsWith('.github.io')) {
      const owner = host.split('.')[0];
      const parts = location.pathname.split('/').filter(Boolean);
      const repo = parts[0] || `${owner}.github.io`;
      const appIndex = parts.indexOf('mosaico-ar');
      const relativeBase = appIndex >= 0 ? parts.slice(1, appIndex + 1).join('/') : 'mosaico-ar';
      const apiPath = `${relativeBase ? relativeBase + '/' : ''}assets/piezas`;
      const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${apiPath}`, {
        headers: { Accept: 'application/vnd.github+json' },
        cache: 'no-store'
      });
      if (response.ok) {
        const items = await response.json();
        const images = items.filter((item) => item.type === 'file' && IMAGE_RE.test(item.name));
        if (images.length) {
          imageNames = images
            .map((item) => item.name)
            .sort((a,b) => a.localeCompare(b, undefined, { numeric:true, sensitivity:'base' }));
        }
      }
    }
  } catch (err) {
    console.warn('No se pudo leer automáticamente la carpeta de piezas:', err);
  }

  const catalog = imageNames.map((name) => ({
    src: `./assets/piezas/${encodeURIComponent(name)}`,
    filename: name,
    name: prettyPieceName(name),
    description: '',
    ratio: 1
  }));

  // La descripción se toma directamente del metadato XMP de cada imagen.
  // Así, subir una imagen nueva a GitHub es suficiente: no hace falta
  // editar index.html, app.js ni crear un archivo .txt paralelo.
  await Promise.all(catalog.map(async (piece) => {
    piece.description = await readImageMetadataDescription(piece.src);
  }));

  return catalog;
}

const PIECES = await loadPieceCatalog();

const BASE_SIZE = 0.72;
const EPS = 0.004;
const $ = (s) => document.querySelector(s);
const stage = $('#stage');
const intro = $('#intro');
const toolbox = $('#pieceDrawer');
const showTools = $('#drawerToggle');
const pieceStrip = $('#pieceStrip');
const startDesktop = $('#startDesktop');
const closeTools = $('#drawerClose');
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
const deleteBtn = $('#deleteBtn');
const deselectBtn = $('#deselectBtn');
const nonePieceBtn = $('#nonePieceBtn');
const transformPad = $('#transformPad');
const moveHandle = $('#moveHandle');
const rotateHandle = $('#rotateHandle');
const scaleHandle = $('#scaleHandle');
const depthHandle = $('#depthHandle');
const padDeselect = $('#padDeselect');
const padDelete = $('#padDelete');
const infoToggle = $('#infoToggle');
const descriptionCard = $('#descriptionCard');
const descriptionTitle = $('#descriptionTitle');
const descriptionText = $('#descriptionText');

const mosaicId = String(Math.floor(1000 + Math.random() * 9000));
mosaicCode.textContent = `#${mosaicId}`;

let selectedIndex = null;
let currentDepth = Number(depthRange.value);
let currentScale = Number(scaleRange.value);
let placed = [];
let selectedPiece = null;
let desktopMode = false;
let isAR = false;
let hitTestSource = null;
let hitTestSourceRequested = false;
let reticleVisibleLast = false;
let pointerDown = null;
let draggingPiece = false;
let dragMoved = false;
let uiGuardUntil = 0;
let padGesture = null;
let captureHoldTimer = null;
let capturePointerId = null;
let captureLongPress = false;
let capturePointerDown = false;
let displayStreamPromise = null;
let displayStream = null;
let mediaRecorder = null;
let recordedChunks = [];
let recordingStream = null;
let recordingStartedAt = 0;
let recordingClock = null;
let infoMode = false;
let pendingDescriptionIndex = null;
const recordTime = $('#recordTime');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf4f3ef);
const camera = new THREE.PerspectiveCamera(48, innerWidth / innerHeight, 0.01, 100);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: true });
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

const selectionBounds = new THREE.Box3();
const selectionBox = new THREE.Box3Helper(selectionBounds, 0x111111);
selectionBox.visible = false;
selectionBox.material.transparent = true;
selectionBox.material.opacity = 0.75;
selectionBox.material.depthTest = false;
selectionBox.renderOrder = 999;
scene.add(selectionBox);

function updateSelectionBox() {
  if (!selectedPiece) {
    selectionBox.visible = false;
    return;
  }
  selectionBounds.setFromObject(selectedPiece);
  selectionBox.visible = true;
}

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
    surfaceQuaternion: new THREE.Quaternion(),
    userRotation: 0,
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
  if (piece === selectedPiece) updateSelectionBox();
}

function updatePieceOrientation(piece) {
  const base = piece.userData.surfaceQuaternion || new THREE.Quaternion();
  const spin = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), piece.userData.userRotation || 0);
  piece.quaternion.copy(base).multiply(spin);
}

function updatePiecePosition(piece) {
  if (!piece.userData.anchor) return;
  updatePieceOrientation(piece);
  const normal = new THREE.Vector3(0, 1, 0).applyQuaternion(piece.userData.surfaceQuaternion).normalize();
  piece.position.copy(piece.userData.anchor).addScaledVector(normal, piece.userData.depth / 2 + EPS);
}

function showDescription(index) {
  if (!infoMode || index == null || !PIECES[index]) {
    descriptionCard.classList.add('hidden');
    pendingDescriptionIndex = null;
    return;
  }
  const item = PIECES[index];
  pendingDescriptionIndex = index;
  descriptionTitle.textContent = item.name;
  descriptionText.textContent = item.description || 'Sin descripción adicional.';
  descriptionCard.classList.remove('hidden');
}

function refreshDescription() {
  if (!infoMode) return descriptionCard.classList.add('hidden');
  if (selectedPiece) return showDescription(selectedPiece.userData.pieceIndex);
  if (selectedIndex !== null) return showDescription(selectedIndex);
  descriptionCard.classList.add('hidden');
}

infoToggle.addEventListener('click', (e) => {
  guardUIEvent(e);
  infoMode = !infoMode;
  infoToggle.classList.toggle('active', infoMode);
  infoToggle.setAttribute('aria-label', infoMode ? 'Desactivar descripciones' : 'Activar descripciones');
  infoToggle.title = infoMode ? 'Ocultar descripciones' : 'Mostrar descripciones';
  refreshDescription();
  flash(infoMode ? 'Descripciones activadas' : 'Descripciones ocultas');
});

function selectPiece(piece, announce = true) {
  selectedPiece = piece;
  setPlacementSelection(null, false);
  updateSelectionBox();
  depthRange.value = String(piece.userData.depth);
  scaleRange.value = String(piece.userData.scale);
  currentDepth = piece.userData.depth;
  currentScale = piece.userData.scale;
  updateOutputs();
  editRow.classList.remove('hidden');
  transformPad.classList.remove('hidden');
  toolbox.classList.add('has-selection');
  toolboxTitle.textContent = 'EDITAR PIEZA';
  selectionLabel.textContent = `· ${PIECES[piece.userData.pieceIndex].name}`;
  showDescription(piece.userData.pieceIndex);
  if (announce) flash(`${PIECES[piece.userData.pieceIndex].name} seleccionada`);
}

function deselectPiece(announce = false) {
  selectedPiece = null;
  selectionBox.visible = false;
  editRow.classList.add('hidden');
  transformPad.classList.add('hidden');
  toolbox.classList.remove('has-selection');
  toolboxTitle.textContent = 'NUEVA PIEZA';
  selectionLabel.textContent = '· ninguna seleccionada';
  depthRange.value = String(currentDepth);
  scaleRange.value = String(currentScale);
  refreshDescription();
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
  piece.userData.surfaceQuaternion.copy(quaternion);
  piece.userData.surfaceType = surfaceType;
  updatePiecePosition(piece);
  if (piece === selectedPiece) updateSelectionBox();
}

function placeFromMatrix(matrix) {
  if (selectedIndex === null) return flash('Elegí una obra para colocar');
  const anchor = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const ignoredScale = new THREE.Vector3();
  matrix.decompose(anchor, quaternion, ignoredScale);
  const piece = createPiece(selectedIndex, currentDepth, currentScale);
  setPieceAnchorAndOrientation(piece, anchor, quaternion, 'ar');
  scene.add(piece);
  placed.push(piece);
  const placedName = PIECES[piece.userData.pieceIndex].name;
  selectPiece(piece, false);
  closePieceDrawer();
  flash(`${placedName} colocada`);
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
  if (selectedIndex === null) return;
  const hit = surfaceHitFromClient(clientX, clientY);
  if (!hit) return;
  const piece = createPiece(selectedIndex, currentDepth, currentScale);
  setPieceAnchorAndOrientation(piece, hit.point, surfaceOrientation(hit), hit.object.userData.surfaceType);
  scene.add(piece);
  placed.push(piece);
  const placedName = PIECES[piece.userData.pieceIndex].name;
  selectPiece(piece, false);
  closePieceDrawer();
  flash(`${placedName} · ${hit.object.userData.surfaceType === 'floor' ? 'piso' : 'pared'}`);
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

  placeOnDesktop(event.clientX, event.clientY);
});

function setPlacementSelection(index, announce = true) {
  selectedIndex = index;
  document.querySelectorAll('.piece-button').forEach((el, idx) => el.classList.toggle('selected', index === idx));
  nonePieceBtn.classList.toggle('selected', index === null);
  refreshDescription();
  if (announce) flash(index === null ? 'Ninguna obra seleccionada' : `${PIECES[index].name} lista para colocar`);
}

function buildPieceButtons() {
  PIECES.forEach((piece, i) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'piece-button';
    button.dataset.index = String(i + 1).padStart(2, '0');
    button.setAttribute('aria-label', `Seleccionar ${piece.name}`);
    button.innerHTML = `<img src="${piece.src}" alt="${piece.name}">`;
    button.addEventListener('click', (e) => {
      e.stopPropagation();
      deselectPiece(false);
      setPlacementSelection(selectedIndex === i ? null : i, true);
    });
    pieceStrip.appendChild(button);
  });
}
nonePieceBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  deselectPiece(false);
  setPlacementSelection(null, true);
});
buildPieceButtons();

function updateOutputs() {
  depthOutput.textContent = `${Math.round(currentDepth * 100)} cm`;
  scaleOutput.textContent = `${Math.round(currentScale * 100)}%`;
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
  toolbox.classList.add('hidden');
  showTools.classList.remove('hidden');
  saveBtn.classList.remove('hidden');
  infoToggle.classList.remove('hidden');
  resetView.classList.add('hidden');
  surfaceLabel.classList.remove('hidden');
  room.visible = true;
  modeHelp.textContent = 'Elegí una obra para colocarla. Tocá una pieza colocada para editarla con el control circular.';
  flash('Entorno 3D listo');
}
startDesktop.addEventListener('click', enterDesktop);
resetView.addEventListener('click', resetCamera);

function closePieceDrawer() {
  toolbox.classList.add('hidden');
  showTools.classList.remove('hidden');
}

closeTools.addEventListener('click', closePieceDrawer);
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

deleteBtn.addEventListener('click', deleteSelected);
deselectBtn.addEventListener('click', () => deselectPiece(true));

function deleteSelected() {
  if (!selectedPiece) return;
  setPlacementSelection(null, false);
  const idx = placed.indexOf(selectedPiece);
  if (idx >= 0) placed.splice(idx, 1);
  scene.remove(selectedPiece);
  disposeObject(selectedPiece);
  selectedPiece = null;
  deselectPiece(false);
  flash('Pieza eliminada');
}
function undoLast() {
  setPlacementSelection(null, false);
  const last = placed.pop();
  if (!last) return flash('No hay piezas para deshacer');
  if (last === selectedPiece) selectedPiece = null;
  scene.remove(last);
  disposeObject(last);
  deselectPiece(false);
  flash('Última pieza eliminada');
}
function clearAll() {
  setPlacementSelection(null, false);
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
function renderCleanFrame() {
  const previousSelection = selectionBox.visible;
  selectionBox.visible = false;
  renderer.render(scene, camera);
  selectionBox.visible = previousSelection && !!selectedPiece;
  if (selectedPiece) updateSelectionBox();
}

function dataURLToBlob(dataURL) {
  const [head, data] = dataURL.split(',');
  const mime = (head.match(/data:([^;]+)/) || [,'image/png'])[1];
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2500);
}

async function shareOrDownload(blob, filename, kind = 'archivo') {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
  try {
    if (navigator.share && navigator.canShare?.({ files: [file] })) {
      await navigator.share({ files: [file], title: 'Mosaico AR', text: 'Mosaico AR · Arte Digital' });
      flash(kind === 'foto' ? 'Elegí WhatsApp, Instagram u otra app para compartir' : 'Video listo para compartir');
      return;
    }
  } catch (err) {
    if (err?.name === 'AbortError') return;
    console.warn('No se pudo abrir compartir:', err);
  }
  downloadBlob(blob, filename);
  flash(`${kind === 'foto' ? 'Foto' : 'Video'} descargado`);
}

async function requestScreenStream() {
  if (!navigator.mediaDevices?.getDisplayMedia) return null;
  if (displayStream?.active) return displayStream;
  try {
    displayStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 60 } },
      audio: false
    });
    displayStream.getVideoTracks()[0]?.addEventListener('ended', () => {
      displayStream = null;
      displayStreamPromise = null;
      if (mediaRecorder?.state === 'recording') mediaRecorder.stop();
    }, { once: true });
    return displayStream;
  } catch (err) {
    if (err?.name !== 'AbortError' && err?.name !== 'NotAllowedError') console.warn('Captura de pantalla:', err);
    displayStream = null;
    displayStreamPromise = null;
    return null;
  }
}

function getScreenStreamFromGesture() {
  if (displayStream?.active) return Promise.resolve(displayStream);
  if (!displayStreamPromise) displayStreamPromise = requestScreenStream();
  return displayStreamPromise;
}

function stopDisplayStream(stream = displayStream) {
  stream?.getTracks?.().forEach((t) => t.stop());
  if (stream === displayStream) {
    displayStream = null;
    displayStreamPromise = null;
  }
}

async function captureFrameFromStream(stream) {
  const track = stream?.getVideoTracks?.()[0];
  if (!track) throw new Error('No hay pista de pantalla');

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  await video.play();
  if (!video.videoWidth || !video.videoHeight) {
    await new Promise((resolve) => {
      const done = () => resolve();
      video.addEventListener('loadedmetadata', done, { once: true });
      setTimeout(done, 500);
    });
  }
  // Un pequeño margen permite que el sistema entregue un fotograma completo de la pantalla elegida.
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, video.videoWidth || innerWidth);
  canvas.height = Math.max(1, video.videoHeight || innerHeight);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  video.pause();
  video.srcObject = null;
  return await new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('No se generó la imagen')), 'image/png'));
}

async function capturePhoto(screenStream = null) {
  if (mediaRecorder?.state === 'recording') return;
  let stream = screenStream;
  try {
    if (!stream && navigator.mediaDevices?.getDisplayMedia) stream = await getScreenStreamFromGesture();
    if (stream) {
      const blob = await captureFrameFromStream(stream);
      stopDisplayStream(stream);
      await shareOrDownload(blob, `mosaico-pantalla-${mosaicId}.png`, 'foto');
      return;
    }

    // Fallback para navegadores móviles sin Screen Capture API (especialmente algunos Safari/iOS).
    renderCleanFrame();
    const dataURL = renderer.domElement.toDataURL('image/png');
    const blob = dataURLToBlob(dataURL);
    await shareOrDownload(blob, `mosaico-${mosaicId}.png`, 'foto');
    flash('Tu navegador no permite capturar toda la pantalla; se guardó la escena 3D');
  } catch (err) {
    console.warn(err);
    stopDisplayStream(stream);
    flash('No se pudo capturar la pantalla');
  }
}

function chooseRecordingMime() {
  const options = [
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4',
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm'
  ];
  return options.find((type) => window.MediaRecorder?.isTypeSupported?.(type)) || '';
}

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const min = String(Math.floor(total / 60)).padStart(2, '0');
  const sec = String(total % 60).padStart(2, '0');
  return `${min}:${sec}`;
}

function setRecordingUI(active) {
  saveBtn.classList.toggle('recording', active);
  recordTime.setAttribute('aria-hidden', active ? 'false' : 'true');
  if (!active) recordTime.textContent = '00:00';
}

async function startVideoCapture(screenStream = null) {
  if (mediaRecorder?.state === 'recording') return;
  let stream = screenStream;
  if (!stream) stream = await getScreenStreamFromGesture();
  if (!stream) {
    if (!renderer.domElement.captureStream || !window.MediaRecorder) {
      flash('Este navegador no permite grabar la pantalla');
      return;
    }
    stream = renderer.domElement.captureStream(30);
    flash('La grabación de pantalla no está disponible; se graba la escena 3D');
  }
  if (!window.MediaRecorder) return flash('Este navegador no permite grabar video');

  try {
    recordingStream = stream;
    const mimeType = chooseRecordingMime();
    mediaRecorder = mimeType ? new MediaRecorder(recordingStream, { mimeType }) : new MediaRecorder(recordingStream);
    recordedChunks = [];
    mediaRecorder.ondataavailable = (e) => { if (e.data?.size) recordedChunks.push(e.data); };
    mediaRecorder.onerror = (e) => {
      console.warn('MediaRecorder:', e.error || e);
      flash('Se interrumpió la grabación');
      stopRecordingClock();
      setRecordingUI(false);
    };
    mediaRecorder.onstop = async () => {
      stopRecordingClock();
      setRecordingUI(false);
      const wasDisplay = recordingStream === displayStream;
      recordingStream?.getTracks().forEach((t) => t.stop());
      if (wasDisplay) {
        displayStream = null;
        displayStreamPromise = null;
      }
      recordingStream = null;
      const type = mediaRecorder?.mimeType || mimeType || 'video/webm';
      const blob = new Blob(recordedChunks, { type });
      recordedChunks = [];
      if (!blob.size) return flash('No se pudo generar el video');
      const ext = type.includes('mp4') ? 'mp4' : 'webm';
      await shareOrDownload(blob, `mosaico-pantalla-${mosaicId}.${ext}`, 'video');
    };
    mediaRecorder.start(250);
    recordingStartedAt = performance.now();
    setRecordingUI(true);
    recordingClock = setInterval(() => {
      recordTime.textContent = formatElapsed(performance.now() - recordingStartedAt);
    }, 250);
    navigator.vibrate?.(35);
    flash('Grabando pantalla · tocá el botón rojo para detener');
  } catch (err) {
    console.warn(err);
    stopDisplayStream(stream);
    setRecordingUI(false);
    flash('No se pudo iniciar la grabación');
  }
}

function stopRecordingClock() {
  if (recordingClock) clearInterval(recordingClock);
  recordingClock = null;
}

function stopVideoCapture() {
  if (mediaRecorder?.state === 'recording') {
    mediaRecorder.stop();
    navigator.vibrate?.(20);
  } else if (displayStream && !capturePointerDown) {
    stopDisplayStream(displayStream);
  }
}

function cancelCaptureHold() {
  if (captureHoldTimer) clearTimeout(captureHoldTimer);
  captureHoldTimer = null;
}

saveBtn.addEventListener('contextmenu', (e) => e.preventDefault());
saveBtn.addEventListener('pointerdown', (e) => {
  guardUIEvent(e);
  e.preventDefault();
  capturePointerId = e.pointerId;
  capturePointerDown = true;
  captureLongPress = false;
  saveBtn.setPointerCapture?.(e.pointerId);
  cancelCaptureHold();

  // Si ya estamos grabando, el siguiente toque funciona como STOP.
  if (mediaRecorder?.state === 'recording') return;

  // La captura de pantalla debe solicitarse desde un gesto real del usuario.
  displayStreamPromise = navigator.mediaDevices?.getDisplayMedia ? getScreenStreamFromGesture() : Promise.resolve(null);

  // Pulsación larga: inicia video. Al soltar NO se detiene; se mantiene hasta otro toque.
  captureHoldTimer = setTimeout(async () => {
    captureLongPress = true;
    const stream = await displayStreamPromise;
    if (capturePointerDown && captureLongPress) await startVideoCapture(stream);
  }, 520);
});

saveBtn.addEventListener('pointerup', async (e) => {
  if (capturePointerId !== e.pointerId) return;
  guardUIEvent(e);
  e.preventDefault();
  capturePointerDown = false;
  cancelCaptureHold();

  // Un toque mientras graba = STOP.
  if (mediaRecorder?.state === 'recording') {
    stopVideoCapture();
    capturePointerId = null;
    captureLongPress = false;
    saveBtn.releasePointerCapture?.(e.pointerId);
    return;
  }

  const stream = await displayStreamPromise;
  // Si la pulsación larga inició video, al soltar no hacemos nada: continúa grabando.
  if (!captureLongPress) await capturePhoto(stream);
  capturePointerId = null;
  captureLongPress = false;
  saveBtn.releasePointerCapture?.(e.pointerId);
});

saveBtn.addEventListener('pointercancel', async (e) => {
  if (capturePointerId !== e.pointerId) return;
  capturePointerDown = false;
  cancelCaptureHold();
  // Si la grabación ya empezó, no la detenemos por perder el puntero.
  if (!captureLongPress && mediaRecorder?.state !== 'recording') stopDisplayStream(await displayStreamPromise);
  capturePointerId = null;
  captureLongPress = false;
});

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
  if (performance.now() < uiGuardUntil) return;

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
  if (selectedIndex === null) { flash('Elegí una obra para colocar'); return; }
  placeFromMatrix(reticle.matrix);
});
scene.add(controller);


function guardUIEvent(e) {
  uiGuardUntil = performance.now() + 500;
  e.stopPropagation?.();
}

document.querySelectorAll('button, input, .piece-drawer, .transform-pad').forEach((el) => {
  el.addEventListener('pointerdown', guardUIEvent, { passive: true });
  el.addEventListener('touchstart', guardUIEvent, { passive: true });
});

function adjustSelectedMove(dx, dy) {
  if (!selectedPiece) return;
  const q = selectedPiece.userData.surfaceQuaternion;
  const tangentX = new THREE.Vector3(1, 0, 0).applyQuaternion(q).normalize();
  const tangentY = new THREE.Vector3(0, 0, -1).applyQuaternion(q).normalize();
  const factor = isAR ? 0.0016 : 0.0022;
  selectedPiece.userData.anchor.addScaledVector(tangentX, dx * factor);
  selectedPiece.userData.anchor.addScaledVector(tangentY, dy * factor);
  updatePiecePosition(selectedPiece);
}

function adjustSelectedRotation(delta) {
  if (!selectedPiece) return;
  selectedPiece.userData.userRotation += delta * 0.012;
  updatePiecePosition(selectedPiece);
}

function adjustSelectedScale(delta) {
  if (!selectedPiece) return;
  // Escala multiplicativa sin límites mínimos ni máximos prefijados.
  // Al arrastrar hacia un lado crece y hacia el otro se reduce de forma continua,
  // manteniendo siempre una escala positiva sin imponer topes artificiales.
  const factor = Math.exp(delta * 0.008);
  const next = selectedPiece.userData.scale * factor;
  selectedPiece.userData.scale = next;
  currentScale = next;
  scaleRange.value = String(next);
  updateOutputs();
  updatePieceGeometry(selectedPiece);
}

function adjustSelectedDepth(delta) {
  if (!selectedPiece) return;
  // Espesor multiplicativo: sin mínimos ni máximos prefijados.
  // Permanece positivo y puede acercarse libremente a cero o crecer sin tope fijo.
  const factor = Math.exp(delta * 0.008);
  const next = selectedPiece.userData.depth * factor;
  selectedPiece.userData.depth = next;
  currentDepth = next;
  depthRange.value = String(next);
  updateOutputs();
  updatePieceGeometry(selectedPiece);
}

function bindPadGesture(el, type) {
  el.addEventListener('pointerdown', (e) => {
    guardUIEvent(e);
    if (!selectedPiece) return;
    padGesture = { type, x: e.clientX, y: e.clientY };
    el.setPointerCapture?.(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!padGesture || padGesture.type !== type || !selectedPiece) return;
    guardUIEvent(e);
    const dx = e.clientX - padGesture.x;
    const dy = e.clientY - padGesture.y;
    padGesture.x = e.clientX;
    padGesture.y = e.clientY;
    if (type === 'move') adjustSelectedMove(dx, dy);
    if (type === 'rotate') adjustSelectedRotation(-dy);
    if (type === 'scale') adjustSelectedScale(dx);
    if (type === 'depth') adjustSelectedDepth(-dy);
  });
  const end = (e) => {
    if (!padGesture || padGesture.type !== type) return;
    guardUIEvent(e);
    padGesture = null;
    el.releasePointerCapture?.(e.pointerId);
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

bindPadGesture(moveHandle, 'move');
bindPadGesture(rotateHandle, 'rotate');
bindPadGesture(scaleHandle, 'scale');
bindPadGesture(depthHandle, 'depth');
padDelete.addEventListener('click', (e) => { guardUIEvent(e); deleteSelected(); });
padDeselect.addEventListener('click', (e) => { guardUIEvent(e); deselectPiece(true); setPlacementSelection(null, false); });

document.body.addEventListener('beforexrselect', (event) => {
  if (event.target.closest?.('button, input, .piece-drawer, .drawer-toggle, .capture-floating, .transform-pad, .topbar, .description-card, .info-toggle')) {
    uiGuardUntil = performance.now() + 700;
    event.preventDefault();
  }
});

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
    arButton.addEventListener('pointerdown', guardUIEvent, { passive: true });
    arButton.addEventListener('touchstart', guardUIEvent, { passive: true });
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
  toolbox.classList.add('hidden');
  showTools.classList.remove('hidden');
  saveBtn.classList.remove('hidden');
  infoToggle.classList.remove('hidden');
  resetView.classList.add('hidden');
  surfaceLabel.classList.add('hidden');
  modeHelp.textContent = 'Mové el teléfono lentamente. Elegí una obra y tocá el aro para colocarla. Tocá una pieza colocada para editarla.';
  hitTestSourceRequested = false;
  hitTestSource = null;
  reticleVisibleLast = false;
  deselectPiece(false);
  setPlacementSelection(null, false);
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
  toolbox.classList.add('hidden');
  showTools.classList.add('hidden');
  saveBtn.classList.add('hidden');
  infoToggle.classList.add('hidden');
  descriptionCard.classList.add('hidden');
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
  if (selectedPiece) updateSelectionBox();
  renderer.render(scene, camera);
}
renderer.setAnimationLoop(animate);

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});
