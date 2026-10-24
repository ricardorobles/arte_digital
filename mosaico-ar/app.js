import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { ARButton } from 'three/addons/webxr/ARButton.js';

const PIECES_MANIFEST = './assets/piezas/manifest.json';
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
  let imageNames = [];
  // El manifiesto local permite cargar las piezas aun cuando GitHub limite su API.
  try {
    const response = await fetch(PIECES_MANIFEST, { cache: 'no-store' });
    if (response.ok) {
      const data = await response.json();
      const names = Array.isArray(data) ? data : data.files;
      if (Array.isArray(names)) imageNames = names.filter((x) => typeof x === 'string' && IMAGE_RE.test(x));
    }
  } catch (err) {
    console.warn('No se pudo leer el manifiesto local:', err);
  }

  // Si hay obras nuevas aún no incluidas en el manifiesto, descubrirlas con GitHub.
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
        headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store'
      });
      if (response.ok) {
        const items = await response.json();
        if (Array.isArray(items)) {
          imageNames.push(...items.filter((item) => item.type === 'file' && IMAGE_RE.test(item.name)).map((item) => item.name));
        }
      }
    }
  } catch (err) {
    console.warn('No se pudo consultar GitHub; se usa el catálogo local:', err);
  }

  imageNames = [...new Set(imageNames)]
    .sort((a,b) => a.localeCompare(b, 'es', { numeric:true, sensitivity:'base' }));
  if (!imageNames.length) console.error('No se encontraron piezas en el manifiesto ni en GitHub.');

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

// Firma del artista integrada como textura Base64 sobre la pared del entorno simulado.
// Al pertenecer al grupo room, no aparece en la cámara de realidad aumentada.
const signatureTexture = new THREE.TextureLoader().load('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAggAAADQCAYAAABiDpkIAADf6ElEQVR42uy9Z5Ac53kn/nTu6cl5dmZzBLCLHElEkhAlkZJsWUeoyums85185St/OJ/PV+W6OoL+5Crb9bfPJ9vUnV2WfHeWCctBpCiSAgmAQgYWwOYcJ+fUPZ37/X/gLG+12jC7WIAgMb+qKZCzPTPdb3p+T8agjm3Hq6++ivf29mLxeJzM5XJEOp3G7969i9tsNuzll1/Gvva1r+FNTU0kAFDJZJIRRZGWJIkiCIJkGAYHAKAoCgAAEEKI4zgkCAIAAIiiiKGPYDAMo/r9fpllWRUAtPv376t/+7d/qw8NDemlUgm1tLQYzc3NyGKx6PF4XH/99dd1AEAYhqH6LNVRRx111LEeyPoQbC8QQtjly5dxACBpmqY0TaN4niedTidBkiReKBSwiYkJXBRFUpIkKp1OM5IkUYqi0ABA4DiOAwCQJPkxQSAIAgEAaJoGuq5jCCGEYZhBkqQWDocpv9+vapqmTU9Pq4Ig6AzD6DabDdlsNt1isejBYFANBoPqhQsXsFdeeUUDgDpBqKOOOuqoo04QHjUwDAPDMAgAoKLRqNlms1lKpZJT0zQnwzBuHMcdDofDLAgCPT4+jufzeYxlWUKSJFIQBFIQBErXdRIhhCOEMIQQ6LqOLWn6OI4jAADDMADHcQwAEEEQiKZpjeM4zWq1agRB6IVCQU+n0zoAGB6PR3W5XKLL5So7nc6szWbL2e32/NDQUAkhJACAAgA6ACAcxw2E6pyhjjrqqKOOZbKtPgSr45VXXiFeffVVore3lwAAvPqCFdo3AQBUJBJhs9kspyiKOZfLOQRBcJdKpWA+n2/MZDJNiUQikEqlXNlslisWi7gkSZgsy6CqKq5pGla1CuBLQno9YY1h2Mf/Vq0IiCRJRFEUYhgGcRwHdrsdOZ1O2ePxFNxud9rlckUdDseizWaLut3ulNlsLnAcV6EoSmEYRuE4TnE4HLLValWXSMPAwAD8+Z//Ocrn84jjONTa2moAgAEAxu///u/XCUUdddRRR50gPD1ACGFTU1O0IAimTCZjqwp6f6FQsFcqFUJVVYymaYMgCNB1HQRBoHmep2RZZiRJYnVdN0mSZDMMwyGKol+WZT/P8w2CIHgqlQrL8zxeLpehUqmAYRjbfv8EQYDZbAabzQYmkwlMJpPCsmyR47gETdNxkiQTJpMpxzBMGQBEiqIUkiRVhmFUs9msBgIBxe12qyRJGqlUSg+Hw7qu66rf7xdDoVA5EAiUvF5vyeFwCBRFKU1NTeqFCxfQK6+8YtTjGuqoo4466gThM0cKAIDKZrNsOp22qKpqy+VyzlQqFRoaGuq+d+9e3/T0dLBcLpMAgCiKAoIgQNM0kCQJl2UZNwyDQAiRAEAYhsEAAI0Q4pa9CMMwoOo6eOTPhOM44DgOBEEAhmEIISQCQAUABBzHFQzDFAzDNAAwcBzXSZI0GIYxOI4zrFarYbVakc1m061Wq2q32wWXy5VzuVzJQCAQttvtsaoVokSSpMRxnKppmk7TtM4wjG4ymVSHw6ECgAoAGoZhRn2b1VFHHXXUCcKTSADIW7ducdFo1DwxMWGemZnhdF1nWlpasJ6eHsxisVCCIDCJRMJcLBatiqLYK5WKI5PJhKampnZMTk72FQoF95JJfcnEv8LEjq0xrk/S+KIV/658f8ltAQRBgM1mA4/Hg5xOp2Q2m7McxyWsVmvEZrNFOI5LMQxTxnFcoihKwXFcNwxDpyhK5zhOcblcis1mk61Wq5LL5bQHDx7omUxGoyhKbW9vF5uamkSv1yuEQiGxu7tb/iySzrpFpY466qgThCfxoapCPJFIWARBcC8uLgbT6XRjOBxunJmZaUilUk5RFGlN0zBZlnFBEEhRFClFUVhd11lZlk2SJNnL5bJPkiTP47znJ8m3T5IkmEwmIEnSIAiCJwiiQJJkEcdxniRJCcMwFcfxpdgEVL1O5zhOs1gsusPh0GmaNjAM00wmk+T1eouNjY3pUCgU9fl8EbfbnXI6nYVAIFABgEr1u+DTFN+wNG+GYTDZbJappqsSgiAARVFqc3OzDAAijuOoHrdRRx111AnCY8Drr79OmUwmemZmholEIlRbWxt58uRJvKmpCdd1nUokEuZ4PO4oFouBYrHYUigUOvP5fHsikWiORCLucDjMFAoFUFUVdF0HhBBeHQ+s6nbA4aMgxMcyRkuC5gkXkMayF1ppjViedYHjOCwFTbrdbs3v98t+vz/v8Xhibrd7zuVyzXAcF+M4LmM2m3mr1Voym81iMBiUq+mbxp07d4z5+XnNYrEowWBQ+eY3vyljGPbIfTRvvPEG4fV6qUgkQhuGQc3OzlJzc3PE+Pg4Fo1GobOzE86cOQNnzpwhm5ub6VKpxBUKBbZUKnGyLNOGYVC6rgOO47Ldbq94PB7B4/FUksmk/E//9E/aP/7jP4IoihAKhcDlcoHP50M+n08PBAKa2+3WgsGg2tbWpj148EA7d+6cXj+m6qijjjpBqAFVQW7u7+/3TU1NBRcWFhpisZhPlmUrjuOUpmk4z/NENptlSqWSWRRFp6qqXk3TArquBxRFcZfLZaxcLj/yeIDVrAJrWQpqIQjLr/kUkImPwTAMWCwWYFlWp2m6SFFUgiTJJEVROQzDShRFiSRJSm63W/b5fKrb7dYpikIYhokkSZZ8Pl+qubk51tPTE+vq6krjOC4/iueuEkN2cnLSFYvFvNls1h+LxfyJRMIRiUTM4XCYTCaTAADg8Xgwv9+Pm0wmkud5plKp0JIk0ZqmkQghAiEEGIZpHMfJFotFdjgccqVSUaPRqJFIJBAAgN/vB4/HAx6PR/N4PBW/31/w+XxZu91etFqtBYRQubW1tdDa2irgOK7WLRB11FHHU0kQqgWGiMHBQWJ+fh4fHh7GBwcHwe/3w4kTJ7Bf/dVfxXfu3EmJomifmpryzczMtEWj0Z5UKtUVjUZbY7GYJ5FI0Pl8HpNlGVMUBdd1HUcIUQBAAwBTfT22Z94MQdjob59mgrDylgFAho/qMCgAoC1ZJUiSNFiWRRzHIZ/PhwKBgNDQ0JDy+/1zfr9/IhgMTnV0dMz19fWlzGazAADGhQsX4OLFi0Y+n0eBQMD4hV/4Bf3MmTP6WjEAb7zxBjEyMkKMjo4ShUIB/3f/7t9h+/btw7u6ushEImFbWFhwLy4uhnK5XEs+n29Pp9Nt6XS6IZ1OO7PZLFkoFEAQBBBFEVNVFTMMA9N1HdN1Ha/WwlgiGoBhGMJx3CAIwiBJ0sBxHJEk+XE6qs1mW3ppdru96HQ64z6fL2qz2RIcxyVNJlPGarWm7HZ7zmw2Fw8fPizAR8GfKJFIoP/9v/83TE1NIYZh9L6+PuOb3/ymXg8KraOOOj5TBAEhRE1MTNgnJyc9yWTSvbi46BgdHTXPzMyQoihCY2MjtmPHDtLj8TCSJJmz2aw7k8mESqVSa7lcbsvlcoFCocAUi0XQNG1bhPpaWn4t7632t9WE+2YsCWt9/nGQhIexemwVFEUt1XPgbTZbzGq1zlmt1gWXyxUNBoM5n88nYBimJRIJlMvlFLPZLPT09ORbW1vz7e3t2a6uriKGYcqKcWLu3bsX+PDDDwODg4PebDZrcbvdZFNTE2Eymah8Pm/J5/OOYrHok2U5WKlUmsrlcqMgCE5RFClJkkAUxY9fW3lmDMOAYRhgWRYYhgGGYYCmaaAoSmVZtmixWJImkynNsmyWJMk8wzA5hmEKJpOJd7vdos/nUziO03meR4lEQhcEQfL5fMWWlpZ8S0tLbseOHXmfz1epE4U66qjjYfGJVVKsugpIADClUilPIpFozuVy3YVCobNUKrVomuYhSZIVRREGBwdhaGgIJwgCNwyDUlWV1TSN03XdWn2RmqZti5CqmoZ/RjCufK8WAbrR/awncDciBbWSlK0Qo5X3ttZ3L43L0mvpve2YB1VVIZPJYIVCwUoQRCuO426CIHpIkhSWijvZbDbkcDjA7XZXGIbJ8Dw/XygU5pLJ5AxJkmGEUBoARPio+JMpHo+HUqlUn6qquzVN21EoFAKzs7Pkhx9+iEmShOm6Tmmaxui6btJ13WwYhlnXdc4wDGzpuQzDgKWU1a2uL0mSQFEUwDAMqpW1AcMwCsdxN4ZhFhzHgwRByAAg4zgu4zguEwShkSSpsSxr2O12w263g91ul30+X8EwjKgsy3OlUml2bm5uUVGUJEKosMxCg+pBknXUUccTYUF44403CLvdztI0bUokEpZIJGKZnJw0DQ8PU9lsFnO5XHD06FFi165dtGEY1kwm44vFYs2FQqGT5/nOQqHQWiqVrOVyGc/lclAqlZYXFlqeQrip+9+OmIDV3q9FQK8ngNciA7Ue6LVmQNRKONa7v43u+xELoeWBkWgpHdPn8xler7dot9vn7Xb7rNVqnbVYLGGn05k2mUxlhJBuGIZFEISmTCazKxKJ7InFYjuSyaQ1nU5jkiQtv29sK2vrET3r8n8/BkEQiGVZcLlchs/nE91ud9Rqtc5xHDdnMpnCDocj4XQ6cz6fT2xtbVVwHDeSyaQWjUZFiqJK7e3thZdffrn0OAI+66ijjjpBWBIOWCwWM/E878zn855UKhUsFArBWCzWODU1FZiZmbHEYjFCkiSgaRpjWZbUNI0WBMEiSZJd13WPrutuXdctAB/1HlAU5aHdBmsJsscp3DYyxz/MvWxG8NdKCDZz7580aJoGmqYBx/EyhmE5giByJEkWKYriCYJQquZ2WtM0u6ZpflVVA6qqOiRJAlVVP7WbF8dxoCgKqrUoctVXkSTJEsuyot1uV30+n97Q0IBcLpdotVrTHo9nrre3d/z48eMzHMelVrph6qijjjq2RBAQQuTf/M3fWC5evGiKxWJ0c3MzdubMGdi/f/9SNUJTOBy2l8tlb6lUClQqlZZisdiSzWbbM5lMYyqVsqVSKaJQKIAkSR///rK0QvxhSctWfPgbCcqNAgtrEZqfRYKwHa6NR6R5L0/FXLnel3prbCvB28jKskRIaxnnhxjT5WmoS0GSYLPZIBAIVBobG+PBYHAiFAoN7Ny5c6S1tTVSLpdLAwMD0s2bNw1ZlrVdu3ZJn//858UXX3yxUi/2VEcdTzdqjkFACBGiKIY8Hs8Ou93enslkPNFolH7rrbfg/fffxzRNI/L5PCMIgklVVZuu6w5Zlj2SJHkVRfErisLJsgySJIEsy49dsGwULPioBO92C+u1rt8KAapVID1iofYoSC9RfT0ya9BmnxfH8ccxRsubin1c2jufz0O5XGYSiYTVYrFYzWazx+VydbtcrhzHcaIoioqiKLrD4eA9Hk8Mx/HZZDI5ixBK14Md66ijThCWCwPs29/+Nnnx4kXyww8/xPfs2QNnz57FR0dHA+Vyee/i4uKzPM/vLZfLTalUii2VSktuAEzTNLzalZAEANIwDArDMNowDGrpwNqOILZatO2NAuvWIg7Ltb1a76MWgfGwf98OklBLEOVWBX4tn3vM8QqPjoGskc2yXc/0KCwzmqZBPp8ni8ViA4ZhDhzHd5IkqdI0rbMsi1wuF8JxvJBKpSYmJyfvA4BdUZRphFAGANRYLIYmJyeNyclJ/Td+4zfU+tFZRx1PIUHI5/M2lmW7dF1vNJvN9pmZGUzTNHxoaMir63pXOp3el0wmu3K5nC2fz0OlUnmiDuytBuptlKnwaRB0T2OU+lbnYrOfWxmQulKIPywBXCuDpRZ31Gae2zAMEgCsuq5bVVUFURShWCyCIAhQqVRCsVjMdfv2bafFYgk1NDQsNjc3F1wul8IwjGI2mwt79uyJIITmMAwr14/POup4iggCQoi7d+/ermQy+byiKAcNw2jIZDJUOp2G/v5+1jAMm6ZpTsMwLLqub3slwvU0++XvbSa2YCmNbPlnN0pLXEuD26xQWX79CvKBqqmBqJb6COuMAYYQwlaOy8MQhc18dq2xXMtfv/L6lZ9dS/CtN0ZbtVisZTl6GAvJWhaAWgpfbVdxrK2SB57noVKpEJFIpAEAzBiGdbIsK5jNZsXj8eiNjY3Czp07F0wm0z2Xy8XOzMxMtLe38+fOnYMLFy4sxX3UUUcdnyUFrHqAEJlMxn/16tWd/f39J4aHh09OTU3tj0Qi9lKphK9IAXusmuBmgvtW+/sSQViWJrlt97je4UvTNHAcBwzDAEVRQJKkQpJkhSAIkaIoiaIomaIojSAIHcMwY2WS+vK0Tuz//fDH86VpGq2qqklRFJOqqpyiKKyqqvhSMR9Z/uSaJG62IuRWgkk3Kyi3U0g/joyPWgtrbdfnVvvIsj2EzGaz3tzcHO/r63vQ29t7k2XZ8YWFhXwqldKCwWD6pZdeinz+858X6kdqHXV8hiwIyWTSMjMzw/3kJz859dZbb704MDCwt1gsNgmC4JQkCduqL/phD8jtgmEYjy3YcKn7oclkgmohG3A4HLrH4ynabLasyWRKmUymlMViyZhMpiLHcQJFUQpCSKu2TP4pcoAQwrEqqmOLG4aB67pOVyoVmyiKnlKpFOB53lsul93FYtGez+et6XQaMpkMbEdlyU8N093GdfeosjMeRb2KRzhO2LI9hJXLZXxiYiIUi8XIu3fv+k0m07MYhskej0dsb29/wLLsJYTQcD1tso46PkMEIZ1Od46Pj9suX7586urVq19IpVL+atrhYw3hXy+o8GEPzcdBVEiS1JuamoSenp4iSZKyoiiIoigtEAjw7e3t2UAgkHQ6nVGLxRJ3Op0JmqbzFoulbDabJYSQjhAyjGVmA1VVMQzD8KoGhy8RBE3TcFVV2XK57OB53p/L5UKlUqkhlUr5U6mUO5lMurxer0mSJEIURaxcLuPFYhGTZRmW+gYAAGYYBgYAuGEYBEKI0jSNMQyDNQyDMAxjqcMlbKVC5cP44x9VeeknNCXzU4VqplJDoVDwL6VQhkIhyWQy+SiK0nK5HBuJRDKhUKgCAHkMwz41FoXh4WE6Ho+b5ufn2VwuR2AYZlgsFrm1tbXy8ssvy0/y2kEIYe+99x6XSqVsN27cMPf392PpdBoAPmqU5na79d7eXvnAgQP8N7/5Tb5eIKuOmuXawMDAsxMTE/apqamDpVLJVy2B/CRugjXf367Df6n07VJJ3bV+a7V7MplM8oEDBybOnj17XxCExXv37qmZTMYQRVFUVZVHCBUBIE8QRIHjuIIsyxWLxSL6fD5tZGTESKfTxpkzZz7+wsuXL2NWqxUDALDZbDgAQFdXFwAAduvWLRrDMI4gCDuO406EkBMArDzPW0VRNDudTqa7u5vs7u7GMQyjstksWSwWCUVRSFVVcV3XCV3XSUVRKE3TLKIoOkulkk8QBK8gCB5BEEyVSgUrl8uwVMnyUXe+XG9uN0sOtkomawlgrYX8bGU9bvScq5X/flhCvcUAT2ypW6VhGBCLxSyFQmHfyMgIfPjhhzsOHz5cev7558PHjx+/gRC6/2lIk0QIsdPT042iKLZomhYwDMOMYZjMsmzaYrHMG4ax8CSTnZGREbPH49mRSqX2ybLcRhAEwTAMGIYBJEkCRVEyhmEJlmWn5ufnhwEgURd9ddREEAYHB09UN3mrruvENmy2J4Y8LAHHcSBJEjAMM5a66+E4blS1IESSJOI4DtlsNkzXdTyVSpG5XI6satk1/RZN03JTU9PM8ePH3weAu8lkUuJ5Hsrlsl4qlfR0Oq1LkqQWi0UNx3FtvY6DNUB64403hHg8nnc6nZFEIkEmk0kikUiQuVwOt1qteFdXF/7FL36RZFmWBAAqn89TkiRRkiSRCCFKURTKMAxWEAR7oVDw53K5lkwm05LL5YKJRMKbyWRs+Xye9Xq9WKVSAZ7nQRRFWOpgWA0QxAA+doksvU9U3SC4rusP1begVuFcizDcjjTS7bKGbeU7NmtJWysIc71S2VshNqqqQrFY9BSLxWMLCwt7R0ZGtMHBwanZ2Vny5Zdf5hFCswCgPYlFlxBCRH9/v7O/v795YWFh5+zs7K5YLNZRLpftAFBJpVKLPM8PS5JkSyQSc36/P4dh2BOR4vnGG28Q4XCYjsVi1kuXLnWYTKZnZmdnn0skErvz+TwpCALoug4kSWIYhokLCwtzDofjrtfrpXmev282mzNP6rzU8QQRhEQi0Z1Op82iKLpqCeT7NJlql2r1u1wusNlsot1uz5rN5ozFYikyDCOYTCbRZDLJTqdTdblcOkVR1NzcnPP9999vKRaLLYZh2Gr9LU3TDFVVKw6HI9HU1DT/h3/4h49Uczp37pwOHzUh+ploxCtXrsBf//Vf/8xhODIyQvT29uKJRIKw2+2ELMs0QRBWwzBciqJMi6IYqFQqXhzHHZIkcSRJ0r29vXhXVxfmdDoxURSJXC6H8zxPqqpKGYZB6LpOaJqGa5pGyrLMVioVa7lcdpfLZVexWLQWCgW8WCw+VNDkesGnK6/bbFXLTwvJfVT3tpaVZr0Mk1XuAQcAGwDYstksXLp0ybywsFCZmJigf+EXfuHWjh07RgEg/YSRA/LmzZuN4XB4/9jY2N7JycnOaDTaViqVQpVKxQwAEkVRLXa7PdjY2Nj1zDPPzD7//PP3EUJDGIZJn/C9YyMjI20zMzO7o9Fo08zMTFAUxT25XO5gOp32LcUeLZHzYrEImUzGGY/HzeFw2B6Pxxs/97nP3W9qahoHgHq6ah1rEwRZljlFUUyappGfMh8tWvECqKYPVtvpIp/PhzU0NBh+v78SDAYjwWBwzuPxzNpstojdbs/YbLaS1Wrl3W53xel0apqmsVevXu0aGxs7PTQ05KoeejVBFEUimUxaE4mEt6mpyY0QyjxJ7Lzqd1zpJ8Bef/31Ymtrayqbzc5LksTmcjlTsVikUqkUSRAEfuTIEewLX/gCtmvXLkLTNKpQKFCZTIbheZ41DIPGMIzSNI1QFIWRJMmWyWQC6XS6NZlMNmcymVAymXSmUik6mUzixWLx494aK6wzy2NeanJxGYYBBEFsihis1KhXE3g1fI+xYs3V9LMr/ht/zHP/M4J+I2vM8n9XswKt18FT0zT75OTk0Ww22xCJRHz/+l//axIh1A8AxSdhTyCEqIWFhcZ0On3k6tWrX7h69erh+fl5tyiKnK7rHEKIAAADIeTCcbxxcHDw8OzsbJTneZ/FYikjhKYAwPgknqXqAnZLknQ8m81+aWxsbMfi4qJJlmWHYRiu5cRgaW4qlQqUSiVnKpXqW1xcbIxEIr26rtvPnTuXrROEOtYlCFartVgqlTQcxzWoofTyJ0UiTCYTsCwLNE0DQRAyjuNFgiB4DMMqJEnKOI4rJpNJ9Xg8mtfrNWw2G6oeZBrHcYVQKBTr6OhYCAaDcyaTKW61WrOtra0l+KgdsAYABkVRVCAQECwWSweO4+J6GtVKKIpCpVIp3+LiYldDQ0NUFEUZAEpPOsmqVsVTAWBVH+u1a9fg93//98EwDJyiKNxkMuENDQ0EAJCxWIyhKIpSFIXUdZ3Sdd0aj8cDZrO5iaKoRrPZ3NDU1ORECFkqlQqVz+exdDqN5/N5QhRFQpZlvGqJoA3DYADAYhiGTZIkc7FYxKv9OtYlCUsCbC0tuNYKjxuRDIqiwGKxiE6nM8lxXB4AZIQQbhgGsZwsVDNO0LLfxAzDwAzDIHVdpxBCpmqRIouiKIwoiiCK4iPdVysJEI7jGz7zWoXD1iMWK9Kh3dls1v7ee+8ZpVJJ0TQNnn322QEMwzKfpCJSLRkfLBQKR+7cuXP2gw8+OD45OdmhKMpK0kYAAAcAnKIoMDAwEMJxXPF6vfGvfvWriCCIBEKo/DhjLBBCHAAEp6en91++fPns7du3T87NzflLpY2PmeoatOZyOevdu3ddTqcz3NjYeBshFAcAqe5qqGNVgtDS0jKLYZg5Ho97EomEb6txCI/C9UAQBDAMAw6HA4LBIPh8PsPj8RRdLlfCZrMtcBwXYRgmxXFc3mw28w6HQwgEApLdblcVRUEPHjww7ty5Y2QyGdlisZR1XS9KklQ0m83l1tZWcWU0L0LIUBRFxjBM26SGCABAi6LoD4fD3RaLZVFRlNingCDULGCqB+HKw7C8lPHS399PkCRJA0C8WCzOpNNpW6FQsLS2trJHjx6lgsEghRAi0un0UjwELcsyrWkaV6lUrKIoOgVBCGaz2eZ4PN4yOzvrWVxcJHK53JodF5cLuPU03IclugRBgNvtRvv3788cP378dkdHxyBN0wVVVSlFUchqjAtaSketBrqiqiaHaZpGqqrKiKJorVQq3nK5HMxkMk2JRKIhFotZE4kElsvlYKm75Hbuo0dZN6EGywtZqVR6rl27huu6zkmSBLlcrt/pdBY+weVMl0qlrv7+/hfee++95yYnJ0OrkIOfgSzL9PDwcO8Pf/jDL4RCIfzkyZM/AQD+Md+7b2Fh4cz3v//9F7///e8fHh8f95bLmzcAVCoVdnh4OHTr1q2ulpaWWLFYjFQVpTrq+OkNfPDgwX6v12vhed4Rj8ctiUTCutkvwXH84+j/pYN5SUshCAJIklz6f4MgCJmiKLnahlerCuklc51BEARiGEY3mUzI5XIZVqsVEQSBcBxHVqu1EgwG062treGGhoY5l8s173A4EiaTKdfU1FSqmsvEJUGGEIIrV66g0dFRWFxcRDiOG+fPn0frsGUWIWRCCFErzcA1HJikLMueWCzWIYriTDabHaxqUp9pZl4dy6VKeipCqPLee+9lpqamsFQqhWmahv3n//yfl7RKrKuriwIACgAYAGB4nrcUi0VbMpn0LCwshGZmZjoYhmlvbGxsEATBEg6HuYmJCUc4HLbJskxthrDWYi1YrdrlyvkmCAKcTifq7u7Onzp1auDYsWMXKYpKl8tlRhAEcsUcfzznNE0DAGCappGKorDlctnG87w/kUg0z83NtTAM0+z1et179uwxSZKEpdNpLJvN4jzPY5qmEbquk5IksZqmsYqisFU3zkNllCwvFb1eRdHNxmmsY6mxyLLcd+vWLcJqtQqBQEBHCA2eP3++8Nprr30SGQ5MNBptun379u6xsbG21cjBWsoOz/PeO3fuHOnp6cm1trZO7Nq1a/oxknS8VCo13L59+/Dbb7998sGDBz5VVfFa53vl3KVSKfe9e/f2NTU15Ts6OsRXX3019gnNRx1PMkE4cuTIzcbGRouqqq50Ou2vVCqdpVKp5i6Py3rSf0wGaJoGlmWBZVkwmUzAcRyYTCbFbDbnzGZz2mq1ZliWzRMEwVMUJRIEISOENJIkNZqmNafTKfv9fsVms2kYhukzMzOov78fFQoFmeO4Es/zeVmW05IkZWVZLqiqKgCAupGZ7MqVK/Daa6+tu590XceXm4k3c/aWy2VbOBxuzWQyjel02vo0EIR1CMPHY/7tb3/7p5SxZQcVZrFYSFmWTQBg4Xl+rlQqTWia5m1ra7P39PSwJEn679y5s++9997be+/evYZ8Pk9sVSveTOrfyhRDmqYNlmWLmqZFK5XKtN1uz/f39xOhUIhQFOXji2maxlb+P8uyuCRJVLFYNMmybON5fjKXy3lFUXQ2NDRY9uzZQweDQUySJCIej1OZTIYWBMFULpctuVzOXSqVAqVSqTGbzQbj8bg5kUiAKD6cwrdWVsRG3T632JSKkiSp49q1ay82NDRQwWBQP3/+/J3XXnvtsQf78TzPzM/PW+fn522lUgnfpEUUj8fjwevXr4dOnTpl3bVr12OpFXPp0iVyZmbGlUgkmt9///2WoaGhwFpWtRrXO87zfHBsbOxIc3OzEAwGF8+fP5+oE4Q6foYguFyuMZZlTel02huPx90IIWN2dtaXSqWoakrbx+lsAIBVrQWIpmlE0zToum4oigIYhgHLsmC1WsFms4HNZgOr1WrY7XbVbrdXnE5n3uVyJVwuV8ThcETNZnPCbDbnKYoSKIqSSJJUKIpSaJpWXC6XaLPZZPjIN65xHIcePHgAqVTKAACDYRhVVVXtwIED6u7du/Xt9J9V84a3lEtfKBTohYUFd0NDg8tutzP15VUTmVABQH3jjTcElmUzlUplTlEUAsdxwuPxoH379jXs2bMn0traqrz11lsH7t27549EIgzP80tr86EEWC2FmXAcB5ZlRZIki7lcrnjr1i3585//PIKPYldqLVUpvvrqq/yZM2ey8Xg8Eg6HyXK5THV2duJ79uzBOzo6MPgoBohKp9O0KIrWYrHoTCaTwUQi0ZpKpbozmUxbMplsCIfD9kgkgmezWaxcLmO6rmPVLqrEUifV9Wp5bNIyVrMQ2uC7uHw+v+fKlSvGwYMHp3ft2jUKAI+dIKRSKaZUKuGFQkFf63mW929Zub4QQuTMzAwbDodp+ChO4ZGmPSKEsIsXL9oTiUTP9evXd9y8edNdKBQQ1FDIbp35wAzDcEYikR0TExPJ5557zguPOXD2cePVV18lg8EgfevWLQIAoLe3V/vt3/5tud7OfAN5iGFYHiFUUlV1wOv1YidPnpw5ffq0WxAEJpPJEIVCgVBVlTQMg8BxHLfZbODz+XSaptVEIqHcu3dPm5iYMBRF+diSQNM0mEwmMJvNhtVq1SwWi8RxHG+1WnN2uz3ldDrTJpMpZ7VaeVVVRbvdrlQqFS2bzWo0TWttbW2faK7xknukVtPjEorFIsRiMVNrayt78OBBsrOzcyOLRR1VLEvbXFmqt4AQEl566SXZ4/GIgUDgyLVr15rm5uaYQqEAkiStau5eqwX4VuISKIpSrVZrkWGYfD6fF8rl8pZs/K+99ppR1dI+JhUXLlyA3/md31ntXuixsTGr2+1eEARhvlwuTzudzmBjY6P79OnTFlVViWw2i8fjcTKdTrOiKFplWbZXKhVvpVLxF4tFVzqdxgqFwpZdEus1R9tCkSUMAOhcLhcYHh5umJubsyCEco8zOA4hhI+OjjKiKFKqqhq1PPdqz1UoFIh4PM7CR26yR0py+vv7SQAIDg0NPfOTn/zk6NzcnL/atwWr9Vxa65iTJMkSi8WclUrFBI+5cu7jxOLioimRSDQPDAx0cBznK5VKRqFQiL/zzjtTCKFwvbLkOgShusD0N954Y0ZRlExvb++tEydOsFarlU6n00wmk2EEQaANw6CqWh0EAgGFpmnx+vXrYjKZlKenp3VJklC5XAaHwwGapkGlUgGO41CpVEK6rhvV3vMKjuMSwzCyYRgKjuP6m2++qT8ppq1EIoEt632AraYprbcZDcOAcrkMLMvC4cOH4cSJE3WCsHXGj1++fBnv6enB3nvvvezRo0eHW1pagp2dnc1zc3OBbDbL8Dz/MzEEtfjOay31vASGYSoej2cxEAjMW63WwtjY2CNfr9WeBtnh4eFyuVxOTk5OTpnNZra7u5t+4YUXSIvFggMAkUwmTYlEwpbP572FQiGYy+XawuHwjtnZ2e75+XlnJBIhstks0nUd0zRtKaNiqaDVpos6rVdNtBbIskwkEgnL7Oysu62tLfmYrQgEhmGMYRiUYRj4JrXuj6EoCpPNZu2xWMz+qDMZDh48SL7zzjvNDx48ODo4OHiwWsSp5riJjTiTIAgon89/JskBQgh78803TQsLC23pdPpoIpE4XiwWO2VZNkql0kgul7uSyWQUhFAKAPR6JscaBKGqwYnwUYBfYmlwW1paiJaWFrJqSlv6F5bMwi+++KL6+c9//mP2paoqzM7Owuzs7Kd2QDAMw9ayINQCRVF0hNBSmmV9wW0ByWTScuHChYDH4/FNT0+bv/e976Hh4WEPQRCOiYkJOhaL4TzPg6qqm+7SuV4lwbUOWLvdXmxvbx/r7OwcoSgq6/f7jcdF/Pr6+pSqVaW0xvOQfr+fBQDn5ORkQywWm5UkaTGfz8/gOO7t7u6mSJLEKpUKmcvl6FKpZOF53iEIgqdcLtsKhQJUKpXt3D/rjreu61Aul+3xeLxhaGgo+sYbb6hV69Ejx/z8PGEYBlkNAMVrWSOruawQQlylUglEIpGQJElFhFDpEQoXQlVV1+zsbFMymfQuc/duag2vAV1RFK1cLj/22hyPgRyQIyMjNgDouH379uGJiYkTCwsLh3O5XBNCCOXzea+maTRCiD148OCDQCAQBoBC/fRdgyCssug262P91CMQCKBYLIaqQgetpzmtBU3TgOd5TFVVorrp6uarzW1sezgc7gGAg4Zh7Esmk4HFxUXU399PIoR8PM83FotFShRFUBTlZ1Lt1itJvF68wVoHK47jqLW1Nbp///773d3dDwiCSP7lX/7lE+O3rKbk8gghcWZmpiiKYiybzU5kMhmHx+Phjhw5Quzfvx/XdZ1JpVL2SCTSEI1GO6PR6M5wONy1uLjojEajWKFQgFoC31buhc3GfOi6zkiS5CkUCk3ZbHaBZdkyAFQe43hhBEH8TPDwakJ2nZgUhyiK7YlEortUKmUvXrxYgUcXi8BJkmRJp9OMoijrrt+txJMghECSJOKzRBCqha5cuq73TExMPHvx4sUzIyMju3ieD2iaRleL6bUvLi6a0um0v1wue06dOvUehmGFekO3GgnC0yufkIHjuLGa9l8LSdB1HYrFIpnNZhkAoKGeX7wmLl26xF6+fNmlKIotGAxS3d3dxHvvvdcwOzu7e3Bw8EgymTycyWT8uVxu6QBcCsTDNhuYuMWNr7S2tiZPnTo1tHfv3uFQKLSI47j4JB4iVT9q6dVXX+VHR0fjs7Oz+Je+9CVs7969sHPnTqxq/bPH4/HG0dHRhcnJySTDMAmz2RwMBoNsqVSCYrGIFQoFqlQqmURRtKmqaq0etmuO51qut3XGiNJ13SlJkq9YLLoURQk/rjFqbW1Fk5OTBkEQaKkKZ62WkBV/swmC0Dk7OxvFcXx+cXExut0EoWopoHme9xWLRYcgCJhhGKsGJz5krxOMIAj8M2ZBIIvFYsvo6OjxS5cunbl+/fphnucdyxsRlstlUz6fby0Wi3aWZcudnZ33DcPA60GLdYKwrnwnSVJZr1BSDd38MJ7n6VwuZwUAC0KoXqVs9XGirl692mEymQ4lEomd09PT1nfeeYfged6ay+VC+Xy+TRCEEM/zxEaa7VaIQQ2HKgoGg9Evf/nLt06cOHHdZDLNYBj2xJO9ZfE8en9//0/FwGAYVkkkEmWWZXOyLC9KknTPZrPZd+/eTXV2dgLDMHgikbDOzs42zc7O7lhcXOyJxWINmUwGWyutcjlRqJGo4QghRtd1zjAMFv6f2/KRY2RkBJlMJoMgCGMlQdhkIy1LNpttW1hYiFMU9SCTyVDbfa+XL18mPB6PT1XVjkwm06woCgdrBBJuVEZ7i107P83g5ubm+n784x+fuX79+v5yuexcbex0XcczmYx7dnbWk0qluCpJqhOEOkFYmyCYTCaJJEkZaowfWEVzwjRNYwuFgiMcDtubmpry8BS5aVbD66+/Tvn9ftbn81Gtra0EjuP4/fv3A6Ojo4fn5uZeHBsbOzg7O+vMZDKYoig4QohGCNEPq9U8xEGohkKhxJe+9KXbL7744vtNTU13EULZzwApA7/fz7/yyivirl27opFIhHI6ncSePXuwEydOgN1uxyVJciYSia6xsbHE/Px8KRKJtM3MzDgmJyct0WjUks/n6dUI21ptrlcRWgaGYbLFYhHtdrtkGMZjc8H19vYaU1NTOgAYOI6jjcZqLSuCYRhUKpXyLC4uhgKBgMNisWw7ybl37x7V2toa0nV9VzKZ7NA0zb4RMVvPorYWecBxHDaypnyK1jcGAKSiKI3379/ffefOnb3FYtG33mc0TTMKhQISBOGzZkWpE4TtBoZhejweF2malnEc12u4fjWSgFX9rPZCoWDP5XLM00wQEELM/Px824cfftg5NzfXcPXqVXOxWCQjkYgrGo12JxKJA4lEoiWfz+MPUyFwu8gBQRBKa2vrxJe//OXbzz333E9sNttdWZYXurq6PjOuogsXLiyllEoAAN/5zneWr+lsqVQq79u3T9izZ88iALgikYjj5s2bvR988MHRu3fvhuLx+JpppGtprcug0DSdtVqtMafTmZEkSXlcz33+/Hnjl3/5lxWKotSqG3FLa8gwDEilUkQikbB1dXWxp0+fxr/1rW9t672mUikaAEKGYezK5/NtqqqaYQ33wlYDqj9rGBkZMft8vuDs7Oy+/v7+nclk0l6LpVBVVVRNHa1beusEYUMBITscDpmm6a1KK0zXdVOlUnGVSiU3hmFm+CgI66lYfKdPnyZ9Ph9+4sQJ7Ny5c2S5XG5ZXFx8dmZm5mh/f/+O2dlZV6FQIKq9GMyapjlVVcU/abMnhmG6xWLRe3t7Iy+//PKV559//l2LxfIgl8tl+vr6pKdl/SOEwGKxZGRZFt1u9xQAsKFQyINhmDo/P989NTUVTCaT2FbJHEVRisViSbrd7jmfz5e8fv36YyMIr732mvHNb35TYRhGJQjCeJj+MTzPY9lslrDZbPj+/fu3XULn83nKMAwvQqg1n883VN0xnyq8+uqrOADgwWAQi8ViK8fI6O3tRduZwXL//n2H3W7fPT09fWxkZKRVEIRaXD9YtRFbnSDUCcLG8Hq9qtPp1FiWrXmxrAzOUhTFLAiCn+f5AMMwtldffTX32muvfeatCHfv3rW/+eabTXNzc8GhoSFTNpulWZZtCYfDBwcHB/dPTEy0ZjKZJ6rCJIZhYLVai83NzbFDhw7FXnjhhbFjx4697/f7b9lstvTTuAeWAh4BoIQQcmcymdaBgQH71NQUVSgUNi1Ul19P0zRyuVwlm80WC4VCxceV4riEYDCoMAyjkCT5UL9rGAZUKhXQdR0CgcC232c+nyc1TbMghDw8z5s1TdvymC+tcxzHP24FvZQeTBAEoml6tUZsD0s0zf39/e7R0VFnKpWyAgCtaRpeXQOq1WoVVFXNpdPptNfr3ZaW06qqOicmJnpv3759YHJy0ieK4oYuA4IgcKfTSdpsNqgThDpBqHFtI0RRFNrsJqy+h0mSZCsUCqFEItFMEMQYAETgM+xmqEYHW69du7aLIIhnS6XSoUgk4vvJT34CkiTZKpWKn+d5nyRJTxQ5oGkaNTU1FQ8dOjR2+vTpu6dOnepva2ub4DhuHgCy9Y2AzP39/c+8++67L7/99ttHRkdHfaVSCaul9sRaJMJms6mhUKjIMEyuGgz8uKE5HA6V47hNCcTVrA2yLGPlchnneX7bLQiapmHlcpnWdZ0VBAGWE4RNZIx8jGrHUUAIgaZpHxMEkiSRyWTaNoKwdBakUqm2YrHYXS6XOwRBaJAkyaZpGmkYBiiKUsFxPMHz/NTo6OhEqVSatVqthYdZDwgh7NKlS7aRkZG2oaGh9lQqZV+rGNZy2O12tbm5WWIYRr9w4UJd+tUJwvq4ePEizM7Ogq7rW25hLcuyJZvNhhYXF5tVVXXNzc0Rn6UxQghhP/zhDx1ms9nOcZz57t275oWFBf/Q0NDu4eHhU9PT04fC4bCtXC6DYRhLRVi2FAC0xeZA62kMktPpLDY2Nhabm5vLXV1d0b6+vuHjx4/f7OrqugsAaXiKq6oNDw/TNE3bU6mU7W//9m93Xbp06eevXr36xYWFBe9abZFrLNSj2e320r59+6b6+voWbTab8Ak9omY2m3WO4xCO46uWod6o2dfSMyqKAoVCgYjFYtt+jmYyGTCZTJhhGJgoij9TEGypX0QtZG15V92l+68SDsxkMuEPQxAQQlh/f7+tv7/foygK9w//8A8chmG+xcXFznA4vCORSHTxPB+SZdmmaRqJEAKCIESGYWJWq7VldHQ0ODg42LR79+7YwsJC0mw2Z/7sz/6M30p1XZfLxRSLRUcymbRrmrbRmWuQJCm3trYmOjs7IxiGlV555ZV6BkOdIKyPb33rW5BMJkHTNKAoCpYXJ6lFaCGEQJZlOpPJ+GOxWEiSJEcmk/nMEAQMw4Dnea/H4+nr7+/vnZ+fb41EIo5IJGLNZDLBYrHYWSgU3KIo1iTUNyIA2xmbYLPZlM7OztmjR48OHz16dKK5uTmqqmpWkqR4KpWa6+rqSjzNKakIIWp0dLRlcHBwz9WrV3ddv35998TExL5SqdRQSwdNDMNgjfLNiKKo7IEDB+79/M///KX29vbRRCLxSQV96iRJ6izLIoZhHqqKpKZpOM/zjKIoLEII2861k06nwW63AwBgkiR9TASWxnmzyssSSVhyMyiKAgRBAMdxQJLkwwhGK8Mw+zVNOzQ8PNz8ox/9yJLP5y3lctlbqVT8kiR5VVV1GIZBLivmhADATlGUm6bpNrvdnuno6MgdP3585OTJk7e/9rWvjb722mv5zXJ/iqJYnudpURRrkWuazWaL9vT03Ovq6rqP43iqno5eJwgb4v333wer1QoIITCZTGAYBqzl/1trk4qiiKfTaYvH43FarVZTc3PzpzbM+I033iAAwFQul01NTU3U3r17TXNzczvu379/7OLFi0cGBgZ2pNNplyiKePUQoLYi1B8mYGwdqABQcTqdSigUUnft2hU/evTo/ePHj9/s6+u7bzabF/r7+8XZ2Vnt+PHj6tN4QFRTwzgAsKXT6cD4+PjuN99889lLly4diUajXbqum2oheBtco7W2toZffvnlq88888xlt9s94/V6PymXG0okEgAAGMdxGxKEDWoMELIss/l83lw9S7e1WFKVGCBFUWrqzLkeltIZCYIAhBDoug4mk8lwOByyoigqbNL/Xi2g5UilUjsmJyefGx4efu7q1atdCwsLFlEUseo5QAAAvkp5aAwAbABgxjCsORaL6TMzM/LY2Fj7wsKC6Utf+hJ269atsSNHjuQ3KlxU/W4cAOyFQsEuCAKtaZoBG9TXwDBMcTqdC52dnbd27tx5v6Wl5amMN6oThC2CpmnQNA3WKhCznmATRRESiQTR0tLC7t+/nzp69Cj27W9/+1M5Dl/4whdcly9f3jM5OdkxNjbmePvtt03ZbLZxenp65+TkZE8ul3OvVh/+kwTHcRAIBFSPxzMfCoXGu7u7o62trWW32512uVzTLpdrIpfLzVkslqe+ymU4HHayLLt7bGys7/Llyy3Xrl1rGRgY2JlKpboRQkytxMAwjLVInh4MBlNf+MIXJg8ePDjo9/unnE5n+ZN63m9961uQy+VAVVVwOByQz+cfptsloaoqWyqVLPBR1dRtJQiapkGtbbvXs8ZhGAYkSX7cyp4kSTCbzcjn8xUbGhoyxWKx0t/fv5mgbBwAmu7du3fsnXfeOXrt2rVDIyMju+PxuH01i+t6Wn+1MipIkmSampraV+20yHz5y19mPB7PMEIos163xfPnz2O/9mu/ZmUYpjUejzeVy2VbLW4XHMc1q9WaaG9vHz1w4MAsAAhQR50gbGgvs1rBZrMBhmGwycX+U5u3WCyCJEl4R0cHnDlz5lPz/K+++ioeDAaJ48ePYzabzTI5Obl/cXHxc8PDw4dHR0cDiUSCLJVKJkVRrIZhrFnd7XECwzBEEITBsqxhNptRQ0ODsXPnzuiBAwduPPPMMz/p6uoaxXE8Vy6XxeHhYeHatWv8N77xDflpXN+vvvoqHo/HiYaGBszj8VjHx8f7otHoi++9997zV69eDcbjcVbTNGtV4NW01tcRWsjn86VefPHF4WefffYBTdPzDoej/Ek+/5UrV4AgCMMwDMPlckEymYRyubyp51wuZwzDMIuiaI/H4xxCqPIorFCrjfFm6h/gOA4URYHJZAKSJIEgCHA6ncUdO3ZMdnd3T3Mcl3/zzTdRjfeCA4D32rVrR//u7/7uq++9997hhYUFj6Iolm14VGcymTz49ttvc6qq4iaTCeM4bhAhlF5rXIPBIDE9Pe2jKKo3Go3uEgTBs7yk8jpjortcrpLf708CQLHe8rlOEGpCKBQCkiRBVVVY2U64Fra+nP0LgmBwHPepeXaEEHn58uXWO3futH7ve9+zmc1mR7FY7BsdHT0+MjLSF4lEOFl+eLm6fOxW03Y2YzqlaRoFAoFMW1tbLBgMJmma5hVFUc1mc8LhcNxtbW294/P55qrtk59qIITwkZGRxh/+8IcdDx48cC0sLNgfPHjQPT09fXJ4eHh/tX/IpoXWWvD7/cUXXnhh4vDhw9dMJtPdYrGYhE+4lO3IyAjs3r1btdlsktvtVjmOo2ohCGvtF8MwzLIs25LJpLmhoeGxVE1dThJWs+istocYhgG73b5EFIS2trapw4cPX+/t7b2LYVj6gw8+qKVwFAkArR988MHhb3/722c/+OCDY5lMpnkta8ZmrBzL4CgUCr0XL17UGIZBVqu1EggEigCw6sEzPj5OViqVAMdxfdFodIckSU6oISCaJEnD6XQqPp9PhHp55TpB2Aw4jgNZloGiqC0fkLquQz6fx3mef+I7pS358SRJatZ1/XQqlTp59+7dplQqxfE87yqVSg08z3ObzcVejxzUSiDWumWSJMFut+tdXV2ZY8eOjRw/frw/FAoNRqPRxLVr15RUKlWJRCLpwcHBZGNj49NODjCEED42NuYrlUrHZFl+IRKJdIXDYZMoivZisRjc5hRUFAwGy2fPnp06fPjwTRzHryiKMpxMJsufdJzHiRMnDKvVWrFYLBlN0/IMw3gfwgpG6rpuFUXRJYqi9cKFC9SjIAir7Zm19tFqe4YgCMNisSgNDQ2G3W6XXS5XZOfOnbePHTv2wYEDBwYAoHDq1Cm0XgtzhBAhSVLjBx98cPL111//0gcffHCI5/nAeve7HtnfQBGw5vP5ve+99x5uNpuzjY2NCYTQ/GrxCDMzM6RhGB6TydSRSCTaJUmyYhiGbXQ+VzM6EM/z+kZlt+sEoY6PYbPZgGEY0HUdSJL8OJ1os9oTwEfV1nK5HAkA1JP2nBiGwQcffGCZnZ31/cmf/InNZrNZGIbpGRsbO9vf339icHDQn8/n8aq5DtvKgbZR6d3VDom1xpamaeA4rsxxXMZutxdDoZDa3Nwstbe3hw8fPjx89OjRu3a7fRAAcggh48KFC0uNi2o1nWIXLlygVFU1h8NhK8uy0NLSUvrqV79a+DSu4wcPHpgvXrzo+vGPf2yLRqOmr33ta8y+ffvaSJI8MTg4+OL8/HxjNBrFlqWhbvYQXwtiU1NT6gtf+MLMoUOH+jVNu87z/Oi///f/PvckjEtvb69uNpuLOI5Hy+VyjGEYC3wUpPlTa7CWdtYIIVrTNLsgCJ5iseiwWCwUbHP31pX3sXKf1JJiiuO4ZLfbUx0dHdm2trZ0MBic7uzsvNrT0zMAABtm7iCEKEmSmn/84x8/++d//udnr1y5clwURf9WzoAa05YxALClUqkd77zzzvHGxsbCN7/5TRwhFMMwrLLid4hwOGyjadpfKBRciqLUnDGWyWTwa9eufaZS0OsE4TFhKSXoYeqcq6pK5PN5VpIk0yOK0t8yDMOgZmZmeubm5p6ZmJjoDofDzkwm402n092ZTCZYLpe3rfzxw9YycLlc0NnZWens7Bzr6uq6s2PHjqlgMFgEAJXn+SJFUXGCIMI4jqe2+hsXLlxgGxoavPPz8+0kSbZLkoQhhKbz+fyA0+n8VJEEhBAXi8V67Hb7boZhemRZ9j948ICamJhwYRjWnsvlQplMhqw1h77WMcUwTO7o6Jj86le/en/fvn0PFEUZSKVSM4ODg/knZWxYljX8fn+OoqjZWCzWyjCMF8dxdmVRnVqe2TAMSpIkZ6VS8cuy7BQEgd7Oe11KSdxgrjc8owiCEFwu19yOHTuGjh49OhEIBGa8Xu8ky7KZGi06DRcvXjz9F3/xFy9fuXJlvyiKvo3uqZb3a3E3RCKRw++99x7R2NhIHjt27H0AmF9+QTabxXRdp2ma5hRFIWRZ3nDulopGpdNpePfdd7GnoLtlnSBsJyiKAlVVAcfxVS0ItQpAXdcJQRC4QqFgMQyDwjBM/aSe6dVXX8WbmprMCCHO4/HQt27d8i0uLp4cHBx8sb+/f9/ExIRDEASimqqI1/J8213ECMMwoCgK0TQtsSxbMZvNss1m0wOBgN7V1RU9ePDgjcOHD1/evXv3AADkAUCfmppC0WhUt1gs+lbvo2o9sMfj8Z5yuXwsn8/3SZKEAUCj3W4nisXigM1myz2JaZCXLl0ix8bGrFNTU1woFMJPnDhBTk5ONo6NjR0YHx8/ks1m95dKpcZcLkcahoEjhMilyPHt5Js4jhd27do1f+7cuRsnTpy4oWnavaGhoXlN0+QLFy48MT7eWCymHzp0KGcYxqLT6VxkGKYTAHxQgxtw5Xo3DIOUZdlZLBYbCoWCm6bpbScIS//Wcg6ttbxJkqxYLJbF1tbWex0dHf0ul2sRAPgaUggJAPBfv379yF//9V+/8OGHH54WRdEJ2xSYvHw81yCihK7rzcPDw9y7776bDAQC91cSBLvdDnNzc0AQBA7w/zI/NhpXDMNAFEUjmUzW4w/qBGHzG5OiqIdug1o9QDhJkiyZTIaFbU6D2gz+43/8j/Y7d+70DgwMdE9OTnpLpZIvGo3ump6e3h+JRPw8z2+nBluTRrHSYuN0OsHn80lNTU0TXV1d021tbXGSJMvZbFaTZTkjSdKEKIqDOI4ntlPAnT9/HnM6nT5JkvYXCoXj0Wi0J5fLYVNTUwFBENwmk8n8zDPPXAOA3JO2Vvfu3RsURXHv/Px8V39/v3lsbIzAMMydzWY7FhcXu2OxWGuhUCBWa9G82Xlc8xAhyfT+/ftv/9Iv/dKdF1544X65XB6XZXn+P/2n//TElRd/7bXXjF/6pV/iKYpK2my2JMMw/FaJH0KIFEXRmcvlgolEwl1tUb59hzNJAoZhIEkP1ysMwzCVpumSyWRKuVyuOIZhpRo/6h0ZGTn9ne985/MffvjhUUEQXPAIspY2sIDg+XzeMzQ05A2Hw+bVLlBVFUMI4bWSqKXaNhzHofb2dn1iYqIu9OoEoTa4XC5EEISBEEIEQTxsK1Vc0zRTPp+3UBRFb3e1tRq0Ytzr9WJnzpyxxGKxvkKh8MLo6Oix/v7+1ng8buF53qIoiqXW4MPVxuJhBDWGYYgkSYNhGN3lckEwGFR6enomDh06dOPkyZO3W1tbJ4rFYvbtt9/Wh4eHlYGBAcHr9fLbbRIcHR3FPB6PDyHUWywW9ySTSW84HAZJklzFYrHRZDKRdru9gBC6BQCfSEElhBD+7W9/m/jTP/1TbHR0FI4dO0b89m//dmBycvJgKpX6XDgcPtrf32+v5vXTqqpyqqqaNU0j1pvfGsskr3lbFotFOHr06L1f/uVffvuFF164BgBRWZbLzz777JPce0RmGKZkNptLOI4rUGMU+2rEV5Ikczab9VAU5dB1fdtijbxe78e/JwjCw55DGACQkiTR6XSaruXsAABTNpvd/YMf/OCl999///lcLufbDDlYzfWxXkbYOlYEAAAtlUrRxWLRgRCy4jheXn6d1WpFOI4bS7U4aiEIqqpiLpcLP336NPnWW29B3c1QJwg1w2QyGTiOaxRFPdTGxHGcAABG0zRTuVxmzp8/j8Fj6BiGEMIePHgQFEWxrb+/33P37l1npVLpmZqaOnLnzp19s7Ozzs1olNvdcx7DMLDZbBAKhTJNTU1zFosloWlahSAI2eVyzbe0tDzo6ekZYll20eFw/NSNPoqCU6lUCjMMw2wYRkAQBE82myWz2SzwPG+VJMlKUdRxjuNyhmGQ7e3tkwihxOPMm0YImRYXF9vz+Xwzx3F2n8+HFYtF4nvf+547FAr1JpPJZ4eHh3csLCwQD5OGWmu8AYZhYDabUSAQmD5+/PjQ17/+9csnT568arFYJj5JN1qt6OrqUlOplAwfpc49FJFRFAXP5XIWhJCpXC6TVSG6LXvcZrNhuq5j66Vb17g/aVVVbblczrW4uGgfHh7O9vX1KWt8FwEA7nK53HXx4sWT77777pFwOByspdT2SiJVSyxCjQTVEEXRmslkWsPhcKthGHMYhvEAAB6PB2EYZhiGoQuCULPVFyGEmUwmU2dnp8UwDPITahxWJwifNng8HgQAOgBoNE3rVSG/ZY4AH6VCUYIgkL29vY+sqFCV9S+93LIsH0qlUidu3rzZMzU15c1ms85SqeQXRdGxlXTFh7QULBUzQhRFIY/Hg/bu3Vs4c+bMwN69e38iy/LgzZs308PDw3o8Hi9ns9ksy7LZxyVseJ7HOI4jdV2nRVGkRFEERVFAURTI5XIwMDDQSdP0lwmCYMvlstHQ0JCtrpFtx6uvvoq/9tprGADAK6+8Ar/5m79JRSKRrlQqdVoQhGMEQTRpmkaEw2EsmUyyJEk6NU3zC4KwZXKwmVgSHMcNl8sF+/fvj3/5y1++8sILL/ywvb19kGXZ+KeBHCwtZ6vVqtI0reI4bmzVUrbU8rlQKFAYhtFrNbPaCjiOA5PJZCCEDJZlN4xBWI0kVO8ZMwzDpCiKt1gsBhYWFhy6rq93ppHJZLJ9bGzs+XfffffM4OBg08qCcct7QWzmXFjNAlPj50lVVRuSyeTuwcHBTDqdLr366quV1157zbDZbIbZbBYRQvlUKlWZm5urqfCMqqpkMpl0z8/Pt2Wz2QRCKF4vllQnCLVaEPSq365mgrDKQscAAFuqgc6yLLzyyiuP5H4XFxdN3//+933FYtHhdDo5AGgdHR195saNGyfv37/fmUwmOV3Xt9xNcavkAMMwMJlMYLPZBLvdnvF6vQW32y15PB65ra0tvm/fvgfPPPPMhyaTaeSll14qLR1w3/ve99A3vvGNxzrnuq6DrutIVVWkaRq2dP+6rkM2m+X6+/t3ms3mosvlutvR0bHt+wYhRKZSKc+FCxfcJ06csExMTBBzc3Pwz//8z9YdO3bsKhaLpycmJo4WCgWvLMtEpVJB1bgR7GHmcxPWIcNqtWZ8Pl8mGAxWdu3aNX7gwIGLu3btuoxhWOHTtscRQgaGYcbD5MAjhIDnecjlcuB2u7GOjg64du3athEEi8ViIIQ0lmUfKh4KIcRJkhQoFApBhJATIbReOiY2NzcX+vDDDw/duHGjr1AosKuRg5Vr6RGb6AnDMLy5XG7H1NRULBqNTly+fDkKAEZra6tKkmQaITSL43gjwzAtAMDWsN+p2dnZpsuXLx/p7OwsnzhxQoCPAp/rqBOEdWxxNI1wHDcoitIIgtBrOTzX2BwIABD2kf0Lx7bTRv/Tv00lk8lOADgyNTW1c3Fx0ZtKpbzxeLw5Go22FItFyyflX7NYLNDS0iLv3LlzfP/+/fd37tw5wXFcJpfLiblcji+XyzFZluc4jis+CXNvGAboug6GYfxUV0LDMCCdTlMTExPudDrtAQALAPDbOIcYAARFUTyMENpnNpubWJalFxYWoFQqMdevX/dqmtaez+f9uVwOkyQJ1ut/sZbZdq0CNhv5bnEch+bm5uS+ffvuNDQ0DMiyHMZxPCzL8tinkRxgGIZ4ntcIgtAwDPuZ1t6b2S+KokC5XAaLxQLPP/88fOc739kWd1xTU5OB47is67pQdXniWzyHACHESJLkyWQygUqlYi+VSuvFSpiTyaT3+vXrTfPz847V1tljIgU/NWWGYdgqlUowHo83EARhPXPmDH7lyhVoampS3G53lCCIB5VKxcWyLAcAIdg4K4Uul8utV69exa1Wq+JwOBIIoUK9o2OdIGxMVz+q1a7jOP4wJicMIUQoikIrimKSZZnu7+/H4SFN0wgh7OLFi7bx8XGz3W5nrl+/7ikWi4cGBwefu3nz5v6hoaEGnucJVVVJwzAeugjIZg6BavtYyWQylSiKkqxWq9bc3Jw8cuTIjS9+8Ys3ent7BwEgEQ6H1ffffx8lk0nd4XBoT8icLwVNIoQQtjL/3DAMlEwmmfn5+bZYLLYTIaQAQGGjVLGVgtswDNNf/MVfWP/2b//WFI1GiebmZviDP/gDa19f385CoXBqenr6eLlcbq1UKmShUIBcLodhGEYAAGkYBrZZs+7Kuay1Ah+O44iiKJHjOL67u7v8wgsvDBw8ePBKuVy+OTAwMJ3L5SrPP//8p7ZCpdlsViiKUkmS1B9WKMiyDAzDoJ07d27b/TmdTp2iKEHTtHw8HhcJgthy3xNd1wme523JZNKN47hVFEVilfknMpkMF4/H22dmZlqmpqYc1VTfLZ8HKxQv3uFw8AghnOd5iyRJprVI7houL0rTNHuxWLRpmmbiOA4DADh37pxeKBTiuq4PJBIJr9ls7sQwLFTDfZIA4MlkMvYf/ehHvMvlirhcrgpCaBHDMAnqqBOE1cCyLKIoyjAMQ8cwDG2kDaxngjcMg1IUxSEIggvDMFs+n6fg4VMdXQihfcVicefY2Jj3Jz/5iTOdTrfPzMz0zc3NNfE8j2+kWT4K5k/TNHR0dMDu3bvnfD7f/VwuNx+JRCo4jhcQQlMmk2kcACIrBepv/MZvfOJzfvDgQcjn84aqqoaiKAaO4/gqHf6wYrHoGB8fPzw1NSW1tLQYuq7fA4CaC/kbhkEXCoUes9m82+PxNGWzWVMqlYK3337bfPXq1ZAoirsymUxHOp02CYKw6S6Dy/3CmynFuxIMw0AwGCx0dnZO9/b2Thw6dGju4MGDEwRBjI6Pj0/8f//f/1cBAPjOd77zad7qMsdxMsdx2kPUGACAj3LvNU3DWJbdzpLqmtvtLiCEklarNQcfNc+iNmMxWkYQgOd5LpPJ2AGAy+fzqykOZo7juu/evXv8wYMH+9LptHMbLYnKwYMHB5999tlRQRCs169fPzA6OtpRqVSw1Z5lrTNV0zS2UqmwiqKQpVLp47G22+0lAJhqbW1t93g8JYIgsBrjrHAAYDKZzI6/+7u/e8lqtXK/8iu/chEhNPopiqepE4THDRzHEY7jxkba4UbkQdd1VhRFdz6fDwiC4Jyent50GtQbb7xBhMNh2mKxYKdPn+bGx8f74vH4CzMzMyf6+/ubw+Ewy/O8SdM081pdzFZLN9pCJPFqWjciSVJlWVYLBoPo+PHjybNnz95obm5+9/79+0Pf//73S5VKRUun05Xvfve7YrX08ZOqURq6rquKougEQay6LyRJcoyPj+8bGxsjnn322XAoFBpey8rz3//7f6e/+93vEpFIBDt8+DD6t//23xLhcLg1mUyeSCaTz8myvFOWZWsul4OFhQUCIcQYhmFGCDFrtfjdzFrczDxWO/wZhmGomqbpNputuH///smf+7mfu3Pq1Kkbra2tIwCQnp+fr3zlK1/5rHTBlN1ut2S323WKomCtAM9aSLWu61ixWCQEQaBgm7IYvF6v5na78wAQtdvtCYIg7KsRhJXli1e7X03TgOd5vFgsmjiOo5xO52oHlzUej/cNDAycGh4e7hUEwbpNCpdx6NCh2V/7tV97/0tf+tLVVCrVrOu6b3Fxsb1Sqaz5LGsQWwMhZBiGgVZ8TkMIZRsaGpKdnZ1Zu90uZrPZzXTJ86VSqZP/83/+TwdJkso3vvGNMkJooR60WCcIax0KiCRJA8dxVKs/cTXWaxgGIwiCPZ/PewiCsBUKhU2NN0KIvnz5cvv09HRnPB53RKNRs6qqnZOTk88MDQ3tWVxctNZSRGW1uu1bsYgsh81mg46OjmJbW9uY1WpdNAxD9nq9GZfLdbe1tfXWM888s/gf/sN/QAAAH3zwwRM93xMTE6ivr08HAFmSJJWiqLUaFxGpVMo6NjbWUigUnKFQSF/NVCuKYrCtra2ls7PTVy6XzZFIBPuHf/gH/NatW408zx+YmZk5PD8/H8zn87ggCJsmA9uJapyI6vV6w/l8PhwOh1MkSaZZll0IBoMjra2tDzAMi34Gt7lhtVpVl8ul0zSNtkKslxOEQqFAp9NpU1WIPzSJMpvNmsvlyhIEEbFarUkMw5oBwAqruBkMw1g3y0HXdSiVSmC324lgMIh3d3fDxYsXV5JfUyQSabl///6OhYWFwFruyc0oEwRBSH19fZNf//rXf/zSSy9ddLvd/QzDKH6/n2cYZtNnMkVRFY7jJBzHVVH8mRhLIxAIZA4fPjx/+/bt6M2bN4ObaEePA4A9mUzuef3113MIIf3Xf/3Xf4IQmnjau8DWCcLPMl5EUZQOAEtBTFsWvJqmkaVSySYIgstqtVoYhiE2EOTYuXPn8F27dmHnz5/HS6VSi67rp/P5/Jk7d+60pFIpmud5myAIPp7nrSvTj2olCg+heSKCIAyr1Qq7d++Wn3/++ZHdu3e/g2HYrQcPHpQURZEymUy6oaEh/WkK9jlz5gwYhiFrmlYul8sCRVGWteZUkiSIRCJEOBw29/b2Wi5dusSfP38efD4f+i//5b/gAOAvl8uHS6XSMQzDdgCAOxqNEslkEqNp2qLrurtSqbgrlQquKErN5GCjg3kzFoOq68zAcRyFQiH9mWeemW9ra7sbDofvSpI0lkgk0sVisZzP5wvwGY7sFkVRpygKmUymTVsHV16uKApTKBQs8JErYDsIgmqz2QoEQcQ4jktiGCaut6fXW0cIIRAEAXiex/x+P/a5z30O/vAP/3Dl81KRSMQ2NTXlKhaLD13wCcdxo6urK/4Lv/AL77788sv/4PV6JwBAKpfLJkEQWFVVsVrPqOr9iRaLJR0IBFI8z1dUVTVWrmmEUO7gwYMjp0+fDs3PzxOxWKx5kzLOEo/Hn/nud7/roGma+jf/5t+UqzEJT2055jpBWN3kqiOE1Ic1MWmahhWLRUulUnE0NDRYOjs71yQId+/e5f7oj/7ISxCEd2pqivtv/+2/MYFAoCsej5+5f//+ycHBwUCxWHxk2uZ6AgbDMLBarcjj8SRtNlvCbrdXdu/eXdq3b9+tffv2vU8QxIOvfe1rHx9gv/iLv/ipmu/e3l4Ui8VEURSzhUIhS5KkA8MwZq1xSqVS1NDQUGNra+uxbDYb9/l8WDQaxf7yL/+S2r9/f4umaYdGR0ePRSKRzlKpZM3n85iu6594tTaKosDpdGo2my2p63paURTe7/dXmpubp3fs2HHXbDbfefDgwczExIT4wx/+EH74wx9+pvf5yMgIkmUZrFYrEASx6ZiP5VtE13ValmUOABjYRFzKWvj617+uj42NlUiSzLAsW8BxXIaPXBdbClQ0DAMEQUAcx6EdO3b8zHdUKhUqHA7T8Xic3mgcaiiaJLa0tMz//M///LWvfe1r7zU1Nd2Djyo5tk1MTPTNz897RVFcNQByDSsNwnE853a7Zzo7O2dkWc52dnbqf/Znf7byumJPT8/Qyy+/7BwfH2989913m1a6MTYg3DgAeOfn581//dd/XSIIgv/VX/3V6/F4fLGhoUGoE4Q6gOO4pVLLKkEQCoZhBoZh+HrtVdfaMLquY6VSiatUKk6fz2cJBALEGhvOcv/+/Q7DMA4ihPaFw+HA+Pg4oWmah+f51kwm4y2VSg/9bKv5J2upkOb3++HAgQP5I0eO3DabzdczmUyYIAhBFMWoYRhTbW1t4qd5zs+dO2f83//7f0uVSiUmCEKE4zgPjuMeWCVVCiEEuVyOu3Pnzn7DMGyFQkHIZDJkPB4nUqkUcfPmTbuu68FSqdQsCIK5UqnAVgpTPYyFYC1y0NLSAkeOHEl0d3dfzeVy9wcHB6MURVVkWc7quh4LBoPRmzdvik/DPscwDH77t38blUolw+FwIIvFAsXilrNtsWoTLKZSqTDbcX8IIbDb7aKqqmWWZXmCINTN7PHV1owkScDzPGk2m1d2rsRmZmboZDJJ8TyPPew6dLvdc2fPnv3hL/7iL/64u7v7HoZhWiwW656amjp18eLF46Ojo8HVCMI636/RNJ1wOBzDLS0to2azOf3mm2+upinxADB98OBB61e/+tV94XB4971796jVlKr1ngMhxM3NzR26cOECKYqi/dixYz8EgKeyYUOdIKwCgiAMXddVHMc1+CgwBl/N7LhRAJNhGCCKImUYhrmhoYHYvXu3AQDwz//8z1YAsAYCAcbv97MPHjwI3LlzZ/f09PSz4XD42OLiojeTyYCqqkS1vju+mcNhrQDE5e/V0PFMtdvtRafTKbS0tOgHDhyYfP75599vaGh4//79+ws3btzQL1++rP3iL/7iZyHaF7nd7oTT6ZzQdb3J7XYHSZJ0wEfm4p9BuVxm79+/353NZtsRQigajeLpdBqTJAkMwyCq3RJr3lsPE2C4xtwBy7KGxWKpcBzHEwQhEgRhtLe3KwcPHhw6cuTIxXK5fIPn+fDo6KjW399v7N27Vzt37tzTFJSFFhYWDJPJpDqdTs1utwPP8x9bEdZTCNYQKli11gmGEMKmpqboS5cuWa9fv26ZmJggM5kMAvgoQ8Rut0MgENDOnj0rnj17ttjd3b2qSyKbzaoej0fCMEwhCOKh50aWZTybzdLZbHbluibT6TRbLBaJlab7zYwnACgmk6l4+PDh/q985Stv7969+xaGYWKhUHD29/fvvXTp0tlLly4dnJ+fd22yeRhGkmTBbDZPu1yuqb6+vsKhQ4dWq4CpIoRyLMtOffGLX7w/MzPTlUgkuiORiG2zlhfDMPzDw8MnCYIQSZIcvXv37uyhQ4c0eAyl8usE4QmG2WxGGIbpuq7rOI5rCCFjpQlsMwJX0zRMURSaJEkAAKJQKDhv3LjRNzk5uae/v98vCAKXyWQckUikMR6Pd2cymaZisYhvNr5g+X1tRAA2EkBmsxl1d3dH+/r67phMpmld10sEQcR0XR+UZXnq3Llzn7nAnRdffDFz7969KVmW26xW6571amAoioKFw2E2l8sBQRAgSRJIkvRQloKtlq/9mQ1NkuB2u6GtrS23Z8+eyba2tjHDMBbn5uZkTdNUwzAiJEkOffGLX5x56aWXPp7Hd95556nb61arVa2myJUtFoudIAhspXm9xrnASJLEaJomOI6jAMBGUVSQoqg9LMv2sCxr5TjO0DQNCIIAhBAwDFNSFGVBEIT7CKHJ1dLqent79VKpJGMYpmyHH1zXdaJYLDKLi4tmhBCxzIVK8TzPSpJEGYax1SpPKkmS0d27d4+89NJLH545c2YMwzARIUQ8ePCgZWhoqPfatWu9w8PDDTzPb7bdOO5yuSpmsznOMExqvb4J1ViEtMfj+cm/+lf/CovH42e///3vn9hkVgMAACbLsjkSiTRHIpH2dDo9fv369eSzzz4rPU0koU4QVj9kjermMZZqISx3J2yGJKiqCtlslp6fn3cGAoG2TCaDxWKxU/fu3TszMDDQHg6HOVEUSV3XaU3TWMMw8M0KiFoCKWvZ4BiGKaFQyHjmmWdKL7zwwu2WlpYfxePx/sHBwYwsy5IoipW1mrx8atVIhLCRkRHq4sWLJpIkmXw+j0qlkr6eHxYhBLIsgyzL21pbYivpjQCASJKUKYpSAQCZTCYjEAiUDh06NPXVr3711v79+28oijL65ptvCv39/SgSiSiDg4PCM88889Tnebe3t0t2uz1DkmSS4zgnQRCWrfI7wzDMPM83RCKRNhzHg9PT0z3hcPhMNps9yvO8U5IkQ9d10DQNMAxDmUwmNzs7OxQKhUxer1dFCIUBQFoR3GvQNK0QBKFSFGXUYvnbQDEgeJ435fN5C3yUbbG0yHEAIDVNwx+CIMjBYHD6i1/84gdf+MIXblgsluwbb7xBDAwMNI+MjOy7ffv2jomJCU+pVNps8Tbd4XAU9u7dm/T5fLm1rC0rIALAg76+vtyv/uqv6pVKxf3WW2/tqpaN3tTziaJoLRQKPYVCYdHtdutvvPFG7GmytNUJwuobCVWbuKC1NuFqucerCQtZlmF6etr09ttv9w4ODhrFYpEaHR3dNzQ0dCAcDjs2aWrb8uGwnsbpdDqlQCAw09LSMnP48OHcyZMnC729vQMYhl3/1re+Nfsnf/InGgDAH/zBH3zm5rpUKrl4nm+Nx+NN8Xi8bXR0tG9sbMwrSRK+HhHb7nKzW/keu90Ora2tudbW1hmGYeaj0WgpkUjoJEnyFotlsampaczpdA5iGJas7+qfRUdHh8BxXEyW5UWLxRLAcdwEAFupPkpKkhQcGxs7RJKkr1gsGuPj4y1TU1MHU6lUR6lUWnI/AYZhQJIkpNNpXzgcNk9PTxMjIyOOs2fP3m1ubh4AgNwKbVhhGEaladqo/v/DPDIhSRIriqJ5fn6eBYClHGmdoii9Gm+11R+Quru755577rlbnZ2dYwCAHzhwoP3DDz989vLly8/fuHFjRyKR2GxtBZUkyeSuXbvGT548OdLR0ZGpUWFCACAjhGaOHz/+oaqqZlVVSx988MGaBaDWIPqGruuOXC63PxqNlgzDyCqKkoZH1KitThA+RVjSIGupSLfSqrCc6UuSBDMzM5ZUKnWAIIhORVGIUqnkKpfL9lqjptfTUreqweI4buA4jvx+P9q/f//Cs88+e/n48eM3duzYMe/z+crVgyr92muvfSbaoC6lkF64cAE7ffo0nD9/Hs6cOWNNp9O9qVTq2YGBgT33799vn5qa8qVSKWc19qMmK81W524z5GB5aiKO42C322HPnj2F06dPjxw7duxDHMfvvPXWW/EPPvhAz+fzWiaT4RcWFkpdXV31BjRrDLvFYhFsNlvM7XbPcxzXShCEdysEAcMwmuf5pnv37tnGx8f3JxIJiMfjlkql4tR1HVvq7bFyCyYSieDc3NzJoaGhjtHR0cZz587pCKGbVWve0qKQGYZRWJY1tqHHA6YoCiXLMmsYBlONm0AAoNrt9gqO4+rKIkSbUDQ0v99f7O7uLlS1dN/4+Pix999//3NXrlw5Ho/HvYZhMJscV7G9vX3s85///AdHjhy57XA4Mpv8vIEQmjhz5oxAkmTZarWyP/rRjw7HYjFivV4my+dI13VHNpvtGxwcLEUikSGKooaXEas6QXjakE6nwWazgaIo2HakFFZbBlO5XC5gGEbgSXhGm81WCAQCMYZhClartdzY2Di5c+fOK4cOHbrFcVzss5b3ixBi+/v7fT6fz3Ps2DErAFBvvvkmtrCw4BRFcffQ0NCRW7du9U1NTfnL5TLxsFaB7erLRZIkcBwHLMvqHMcl7HZ73OVylS0Wi26z2fTGxsbsrl27xnbv3n3dZDLdP3v27MdkYHZ2Fv7X//pf9Q29Dtxud8VutyfT6XSM47gcQRAafJSmuFngPM9bJyYmrJqmQblcron0IYQoWZb94XDYWywWcYRQyel0wvPPPz+JEEpWhbfidDoVp9OJSJLE1lIqamxRjVXdCITNZiOqghzhOK5NTU1JJpNJ22rXyGozKVulUmkFANPQ0NDOy5cvP3f16tWj0Wi0ea0qr+vB5/Pxp0+fnjx27Njt1tbWyVAoVNnCXiwDwBhCiLFYLE6bzWb8y7/8S/f8/Ly3FgVN13W6WCzSi4uLoUQiYaco6qmSmXWCsPpiX9pI+MMKi4cNOtuKdWBN+yJBQFNTk3T06NGRjo6Om7lcbnxubi5dKpUy6XR64TNKDigAaAWAAxzH9ZEk2RyLxSyFQgFu3bplUhTFm06nQ6lUylOpVPBHdA9bIhlWqxUaGxtRS0tLvKOj4+aOHTvudHZ2LlgsFjEWi0E4HBYlSUrn8/lwQ0ND3VKwSTgcDplhmLzJZMrQNM0/THO2pUDVLSoVeKlU6rhy5cqX/X6/xefz/aCvry8LH/Vt0RmGUV0ul24ymdBaJaE3Y0lbwvL1abFYFI/Ho65VVXIjGIbBJJPJjnv37j0Xi8W0Dz74oOe9997bE41Gm7ZCDqxWq7x///7I3r17Zzwez0woFMo/5Nk0tW/fvh9wHJfhOO4r//AP/3B8enratBRYvE4nTJAkCYrFIkWSJEkQBPY07ZE6QViBjo4ORJIk0jQNGYaBljroLT+4t6OPwUbaZ63fVcN1GkEQJbvdzvf09Chnz56NnThx4ipJkldu3LgxdOfOnaLNZtOi0aj2aScHCCH8r/7qr8w//OEP7YqimE6dOgWXL192G4axe2Rk5JlYLHagWCy2plIpWhRFqLbiJnRdJzcKztoodfRhiAGGYcBxHFgsFp4kyaIoimKlUjEYhgG/31/Zu3fv+LPPPnvl2LFjV10u1wIAaAAAP/rRj4xwOGzs2rVLq+/czaO3t1dbWFgQWJblAUBECOlbXHfbsffN6XS698qVK/L+/fsH+/r67lQJAspkMrrJZDKcTieUSqWfISFrrcd1ig6hSqUCbrf74w+azWbU1NQEDocDT6VSWyEI7MLCQue//Mu/OEmSpO/fvx+amJiwa5q2aRlD07TS0dEx1dXVdZdl2clkMvmw5AAwDBMQQoPd3d3Fc+fOOXie9/zgBz9oW1hY4Fa6E1c811IbeJ2iKEMQhHqa49OMpqYmzG63Y+VyGamqWnN1tU8yWG09i0EoFEru2LGjf9++fROHDx/OHj16NBMIBCZHR0cn/ut//a8pAID+/v7PxNzxPO8hSbLXarXum52dDf7gBz8g3n//fTNCKFQsFjtzuVxzNps1Lc933wqB24jEbWYOq50TYceOHUJ3d/cAQRAD4+Pj4Xv37smKooCiKDJN00mbzTYuCMKs2+0W67t0e4BhmLG4uChTFCWSJKmsF6C3VcWg1t4mUC22ND8/7xkeHvYkk0kzAPA3btxAs7OzCkmSktfr1bPZLLHShbGJ9YYRBIGRJImtbOVMUZS+Y8cOtbOzU5ufn4fNplkbhkFFo1H/pUuX3Jqm0YVCgd3sdwAAmEwmaG9vX+zu7r7MsuyP8/n8aDgcrmzTfKsIoXBXV9eNM2fOuCKRiFQsFndms1n7uuYdHAeapoGiKFilB0SdIDxNOHPmjJbL5WB4eJiWJIlevpGWZytstEFXy3J4VERg+W8SBCETBCE5nU6jo6NDOHbsWP/p06ffO3To0J2GhoYIfBRgI+3du/czEWiDEGIBgEsmk467d+92z83NPZtKpZ5fXFzsSqfTpKZpGADQ1aAsci1tb7stQWsRNo7jVIqiJF3XFVEUgeM4aG1t1c+cOTP7/PPPX2EY5tK//Mu/TMzOzlbGx8chn88bPM9ro6Oj0smTJ+staLdfIVAjkYiC47hWS2v3Rw1RFLHFxUXP0NBQECGUPn/+PFYul0WGYXI+n4+PxWJOQRCwrRJckiSxaiyDcf78ebSMqEo7duxIHDx4cPHBgwfWWCzGwOZSAolKpWISRRFqDAD8GdhsNnnv3r3J/fv33/L5fB/gOH7t9u3bhQsXLmxn1oDOsmyyqalpprW1td1ut3fmcrk193yVHCCLxaKwLKuSJFm3IDzlUM1mMyWKooPneauqqvh6msHKhbVWtcWH0CxqAkVR4HK5pGAwONHS0jK9c+fOfF9fX7GpqWmisbHxdkNDwziGYfJnaaIQQqwgCLvGx8f33Lx5M3D37t3mqampvsXFxd2pVMpWq7+2lq59D0sgaJqG1tZWraenZ97hcIxHo9HEyMiIKkkSYBimO53OcENDw/1QKNS/Z8+ej+MJhoaGYGhoqL4rHx2UJQsCrFMAZy2iv9Fe3sJaMaXT6Y7Z2dk93/ve9zImk6kEAEWSJCOVSiVhNptZDMO4hzknqn0njBXt18tNTU0DJ0+eDNy8eRNLpVI7NU0zbVZH2eq+cTgcwokTJ6ZffPHFO729vZdomu4/efJk9hHMNydJkiefz/tLpZJTURRqA+uBbrFYyn6/P2O32wVBEJ6qxk11gvDRwsWqbBnjed4zNzfXMD097U+lUnZN0/BtMB8+Em21mvqGGIZBTU1N0NfXN3PkyJHLzz777NWdO3cuMAwjFIvFUjKZzLW3tyufwflqvHbt2gt///d///KNGzd8qVSKq1QqDkVRrA/ReGdDArGesFj2GaPqjkAmkwlCoRA6depU5Lnnnrvm9XovXb9+fSISiYi5XA7S6TQqFAqVXC6XC4VCxfqOfKzQHA6HaDKZ1Grtky2vke0g/IZh2LPZ7I65ublYd3d32Ol0DgaDwQxJktOVSmXOYrE4cBxnYUX59bVI7Yr3MIQQq2kaJ8uy5e7du9ShQ4eWrFIlALh/5MgRdPbsWWp8fNwdDodbHsd2ttvtlaNHj0793M/93E+ef/75d/1+/z2z2Zx9RL9nSSQSO4eGho4NDw/35HI503rzhuN4xe12z/f29k76/f5ULBZ7quJ9nnqCsLi4aHrnnXeaFxYW/CaTyUSSpGdkZOTghx9+2JDJZKjVXAmbNTVuJcBtA1YLDodDDwQCMavVGsUwrOhyudSenp7JvXv3fnjgwIHbFosl/hkmc3YAaLxy5cqz/+f//J/n33777SOZTMa0le/byP1TSx2M5deaTCZkNptzdrs96nQ6c3a7XWIYBtntdqOnpyfS19d31efzXc/n8wuTk5P6kpXgd3/3d+F3f/d3P4ukGz3hrb8Ns9kscRynbGQ+XlkgbaN1tFWrWKlUCiWTyZ7m5uamnTt3jjocjoyiKHPJZHKB47g2APBv8etpVVWdxWKxURTFJgCovP766+nf+I3fUDEMUwAgjRB68OKLLzaOjIzs/MEPfmBd1sJ6SwrOBsJX8/l8mR07dkwdOXLk7u7duz9sb2+/jWFY+hHON55MJoP379/vmZqa8q3V7XHZPWb9fv/AgQMH7nR2dsYHBwfrBOFpAIZhS6k5nbIsn5qdnT0wPT3ti8fj5kQiEUwmk961AlKWE4W14hFqCWbb0g6naWhsbDQOHjyYPHbs2A2n03l9YmJifm5uTspms4VMJrNoNps/y5Xz8HK5HBwfHz/793//91/48Y9/fCCTybBbXQMrD7uV5GBlme315sXtdkNzc3Oxp6fnwb59+2709fVNms3m/PT0tDE1NQWGYRTL5XJk9+7dn7lyrdX9RMBHhYbMi4uLJovFQrhcLhkhJACADAD6k0YWcBxH+XxesVqtBkVR6GHHoMaiV2sKUIQQJsuyrVgseiVJclAUhe/bt6+0sLAQdrlcYYZhitV0zK0ULGBEUQxks9mdpVJJpmma9Pl8U2+//Xb8pZdeWvLHZXt6esbPnTt3p1QqmS5fvtxTKBTcVbK36p7Z5FggAMBYllU7Ojri+/btG2hubr5us9luyrI8AQDZRzzlTDwet0xOTnLZ7IY/pXMcF29sbLy7d+/eW42Njcmenp46Qfisap7f+ta3zO+//74DIWTt7u7GL1y44ASAff39/Z+7fv364YmJCVc+n8erbgV85YbeTkG/ie9CLMtKTqezaLfbyy6XS2lpaZGfeeaZyTNnzlwKBAKXLRZLOJ/PaxMTE+jb3/62/iu/8iuf5UAaPJFIeN95551DP/7xj4/G43HHWgdwjcVqHqbaoWEymSoul6vo8XgqbrdbamxsDB86dOjayy+//GF7e/sYAPDPPvssOn/+PAiCYBw/flyHz1izl1wuZ8dx3Ds+Pu6Ynp62xGIxmyzLJoZhCLfbLeM4Xh4fHy/euXNH+vVf/3Xh85//fPrcuXPFJ+RcALvdbrhcLmQ2m3Ecx38qjXCza2ktArpecOzK9zVNw0RRZHVdZ0ulEo5hmMHzfI7juCzDMJXVXCGrffcq79GyLPvS6XRPNBqlbTabHSHkyOfz46+//vriN7/5zdJS9cEXXnjBous6oyiK88qVK05BEIjV9thmXSskSfIul6uwe/fu+MmTJ0dbWlruVSqVm7Ozs6OnTp2qPCoCiRBiAMAuSVLnzMyMNxKJkBvVrMAwTPX5fImdO3dONjY2zgOA9oRbw+oE4SHgaGpq6vH5fHsXFha67927x46MjJh0XW+MRCK7FhcXA6VSCdsM41/pclh53Vp9yGvdUDiOg8fjEfr6+qYPHz480tLSMqXreiabzWoAkFRVdcLr9c5/Frsrroe5uTnu2rVr3nA4bFlvvtY7sA3DWNcysPy6ddaAHgwGw2fPnr3r8/kmU6lUThTFPM/z06VSaQrDsMJTMBeOxcXFA3fv3n329u3bzZOTk0y5XGYMw6BJksRNJpNGkqQkCIKo67rucrmiVqv1JwihWxiGPSk5Y4bD4QCn0wkEQfzUvl25x9dyM662hgiCAIr6KAZOUZSfaSW9HtEwDAPTNI1wuVwAAGA2myssy5ZJknyYboK4pmmWbDbbND8/b7NarX6O45pwHG8sl8sDv/d7vzcEAGkMw3IIoXsvvPBCaGZm5tDMzEzX5OQksXR2rVZafq2zccWeMjweT/LUqVP3vvjFL97fv3//SLlcnh0YGFj44z/+Y+GP//iPH+Uce2VZ3nfz5s2Tt27d2pHP5zeyOiKr1VrYvXt3eseOHbnVum3WCcKnFG+88Qadz+dNTU1N9M6dOwmn02memJhoSSQShwRBOBWNRvdHIhGLqqqYYRikoihMNR1u9dOj2mRlLcZcS9BarUQXACSSJEWHw6EFg0Fl9+7di88999y9U6dO3Whubn4QjUajb731Fspms1qpVFLWa336GQUVDoeZWCyGrdW7fvkhvprLZxstPFpDQ0P0hRdeuNbR0fHhj3/849jw8LB2//599fd+7/c+0wcKQggfGhqyZ7PZvg8//PC5f/zHf/zSyMhIhyAIWLXoFLYUpFltMoRsNhu43e75hYUF8ubNm+Jbb721cOfOHQMAKr29veIn5XaRJAlomtY9Ho9uMplgrQZqtRJ7kiSBZVlgWfbjSnybBUEQGsMwGsMwSz+q0TQt15KOuZ5SjBCiC4WCMxKJ2BmG8VoslkaO40KlUsk1NzdHHzt2bGjfvn3q6OioyePxYE6nE3m9Xpidnf2pcdlKXBWO4+B0OoXu7u7YkSNHxnbt2jUMALGTJ08+juwqVzweP3z16tUzt27d6qxUKvQGc1jq7e2dOHv27Gx7e7sATynIz+DBRY6Ojrbcvn27e2hoqGF4eNhSqVTMiUTCv7Cw0LO4uLg7Go02FAoF2Iy1oBYNdcu7FsPAZrOBx+MpeTyeicbGxrn29vacz+cT/H5/bMeOHdM+n2+MYZj5jo6OjwnBa6+99lQt1mrgG5fNZs3rlUVercPmo7oliqJ4l8sVO3DgwPzBgwefmioqt27dssiyvPv69esv/tM//dPpBw8edCuKsm76XS6Xg4GBgS5Zlp+7du0ax3FczG63V9rb26cbGxvvw7JOho8Td+/eNYrFouzxeASv14t4nt9yHxaapg2/32/4fD5QVRVPJpP4ZgquVcmBajabKzabTWYYZulGNJZlFZIk13VRbWTZMAyDFASByOVyuGEYHEVRdpZlLTzPmyKRiEcQhL7p6Wnpu9/9LuHz+XbMzs56S6XStpQgNwwDBEGwhMPhxrGxsQ6O45KGYeTgo/iURwpVVU1jY2Ot165d64xEIrYNzm7d5/PNv/zyy1defPHF/oaGhhw8pfisEAQMIQRTU1N0KpVqyufzR2Ox2Om7d+/umJubc2YyGbpUKjGyLFt0XXes1/BkLeFfi5Vgs4SBoihEkiQym81Ye3t7Zf/+/WPHjh27cujQodt2uz2s6zo/Pz8vCoLARyKRksPheNpL6mLxeNwsCAKnaRq1BYKxnsZn0DRtaJoGoijia9W/WIlKpQKCIPxUzMrTAK/X63jzzTcP/uAHP/jc/fv3d6mqumFuvmEYkEwm2XQ6vZfjuEav1yv19fUVHQ7HDYqi9E/K7XDlyhWV47i82+1OBINBf7UT47prZ621ZLFYpD179vDt7e3G3NycKRaLWRRF2UxAoU5RVN5qtSYdDkdx2Z7XaJpWzGaz/lFfpK3tn+r6xiiKAkmSMEVRKFVVfZqmmSuVSrumacLCwoKWzWYBwzBzsVh0ZzIZfD2Cs4my8HgymQxcv379GI7jrnK5bAmFQuY/+7M/G/ubv/mbdH9//9KPINjGOB2EEJXP5z137tzxDA0NWTYifxzHFU+cONH/la985YNQKDQEAHydIHxKrQV/9Vd/Fbp+/XrLr/zKr9jb2tpop9MZjMfjhx48eHBkdHS0LZlMMksNOTbS4lfLSliPJNQa4b4SZrPZaGxszDQ0NEQ5jkvLsiyzLFtxuVzjHR0dN/v6+h4AQPJpC4ipBYqi4NUDd8PeCbVUsGRZFkKhkNrX1xcJBALhQqGgDwwMNM3OzjYrikJvdD+yLOOCIFDwURfAJ94UWc02wB5mbSGEsHv37jkmJyfbpqamOlRVtWyGpOm6biuXyzae50EQBF0QBIogCBnHcVYQhEGO4xKPsy+IqqoyQRDxUCg03dTU5BscHGwCgC1lxjidzvK+ffumOzs7ZUEQggDQAgCbScEVKYoKezye6UAgEGtoaJCq82aMjY2pHMetSxA2SsVe2heGYYAsy1AsFqFSqRCaptkAwAYAwPM8xGIxUFUVNE2D7ehqu2y/mGdnZ826rjsEQaA7Ojqcqqp2dnZ2pn0+n+J0OqXW1taSy+UqNDc35/ft21fq7u7ekoXh7t271MGDB72iKLYNDAwcuX//fjCbza4n8xSapmNHjhwZ/PrXv35l9+7dQxiG5Z7m8/ZTSxAQQsSDBw8aAeCYqqpnZmZmWgYHBykAMAuC4M/n8w2lUmlNcrAyYK0WVrzapttMFC+O48hutxsHDhxInz59eqivr++mpmkj9+7dy09MTGjFYjHH83z0/Pnz2ddee61ODlaZdovFotA0LSOENLRJk81ql1ssFujt7VVfeuml2b6+vmvxeFw1DOPZaDTqr4UgGIaxVLf+k54vbC1hXv0bAQAsz/OmdDqNI4TkqmakA4CxScLAFgoFRzabtUiSRK+1vzbSMBFCkEwmiVKp1JNKpdhoNBr40pe+xH3uc5+7hBAqPEaCLLW0tIQRQqOTk5MNOI67tkIQKIpCra2t2V27dk07HI4KSZIEAARXIwjruCnLDMPMhEKh4VAotAjLzO8mk0l1Op0Gy7JQLBa3ZC2jKAqZzWYwmUxYpVIBRVFAFEXQdf3jwF1VVUFRlEdWclzXdVhcXDRLktQ7MzPjsVqtR0iSrJhMJplhmJxhGHEMw6ZxHJ9ACM0ghFJbCRIMhUL09PR0TzabffH9999/bmRkpEVRlDXZFUmS+d27d9985ZVX3nvhhReuAcBTX7TsU0kQ3n77beby5ctN4XD40NDQ0AvT09MvTExMNBYKBbwq7HGooY74aoGHG8Ud1PJ9q2xSg6bpSkNDQ7mvry994sSJyTNnzvQfPHjwKkVRI6+88krp3Llz4PV60UsvvWRAHWuNL0IIVRiGEZe35q0lonw9IaXrOui6rgKAyDCMSlGUWqsZFyGE4TiOwSfgYkAIYeFwmL1z5441Go2aU6kUOzAwQA0NDWGCIEAoFILz588TZ86coa1WqymZTJojkYgJIYQ7HA7Z6/WWcBwvFYvF8t/8zd/wLS0txTNnzgjrCWaEEJZOpx35fN4rCAJrGIa2GmHeTD0QURQtQ0NDu5LJpKVUKolWq1Xas2fPA4RQplrA55Git7dX7ujoiGmaNmm1WrsAoAcA3DUKdAAAA8dxpaWlRThw4EDe5XLJmUwGy2azmKqq2FrKyRpKiOByuRY6OzsnWltb4/BRR0cAALBarcjtdmM2mw1PJrdU6kTlOE7y+Xw6y7JMpVIxLQnsJWvB0n7YDHAcB5ZlgaZp0DQNKpXKhlYHTdOweDzuzOfzDrvdjtxuN3K5XBqO4yXDMGKqqraYTCZbKpVSbDZbYfk4bIKwEYIgNN64ceOZixcv7g2Hw+xa90UQhN7S0pI8c+bMvWPHjv3EbrfPYximP+1n7qeOICwuLpoSiUTzpUuXjl+9evX5sbGxQ8lkspHneWqzjHclKailOlqtaU/LwTCM2tPTEz18+PBoT0/PSCgUGqFpeoqiqFkMw/J10b85K6XFYhEoilLX0to3Y9UplUowPDxM4jjePDMz84wsy/rc3FzbRjXal/0WTn2Uy0Y9rgGomohpnucd2Ww2aDabW1mWbdV1PWAymWxOp5NUFAWKxSK899572L179wiEEFUoFBie5ynDMDCO4zSn0yl5PB7B5/OlW1papgFgOJPJTABAea3fvnz5MuNwOFzlctmrqqp1NSK+vJbAJjJ8sFQqFXz33XfP+P1+muM4bs+ePT8BgEde9OvcuXM6QigXiUTiVqs1jRDabNqBZrVak4cOHUr29fWVS6VS8MGDB87Z2dnAautovVRnHMclv9+fbG1tjQBAeTlZY1nWcDqdyOFwwMp6DTVCMZvNiaampjLHcQ5JkkLZbJapVCofuxJ0Xd+U5YBlWWhsbJSamppkmqbZdDrNzM/PQ6FQ2PD+EEIgiiKm6zqm6zrIskwUCgUvy7JWt9tt1XUdNTQ0RNrb26dhC+47t9tNTk9P28fHx/2Tk5PsWtkkGIZpXq83e+DAgfm9e/fONjY2Jurk4FNIEBBCplgs1jIwMHD03XfffeH27dunK5WK3zAMcj2NfuUhtTyft1ZrwXpBShsdgFarVT169Gj085///A2O436STCbHZ2ZmKgcOHKh359s8NL/fr1itVoTjOLbyQFuPHKymBaqqCpFIhMrn8x0DAwNNAADFYpGSZZmpRXliGIZiWZZ+yL2EvfrqqxgA4GfOnCGLxSJ1//59anBwkFxcXCS6urqwr3zlK/C5z30OzGYzwfO86d69e7ZEIhHIZrOt2Wx2Zzwe3xGPx1tzuZxTVVXcMAzIZDKQSCQAADDDMDBd17HqusdwHEckSSKO47TGxsbkkSNHBhobG1mapssIoTkAUFezJCiKQpRKJYbneVZVVQohhK/UjGu1yq2m9CUSic4333yTaWlpSQWDweHHQRCqkLxeb8Fms5Wr5LNmKxSGYWowGIwfPHhwuqGhgRwYGOi5e/du98zMDLUaQVhvjVqtVrmnp6cUCoVKK+MwisWiDgCSx+ORLBYLs1bdlvXINUVR8VAoFG5qamJYli0ZhtFEkqQ1mUzS2WwW1ovXwnEcKIrSKYqqMAwj2+12ta2trbJr166Uy+WqlMtly+zsrA8hZLLZbIQsyyZJkrhKpYKv1zhN0zTgeR5kWQaEEOA4ztrt9maKooo7d+4MappGb+YhX331Vfw3f/M3uWKx2B4Oh0PT09MMz/PrkRyxqalpqqur64HD4YhVKhWtfsx+yghC9eBxjY2NHfrRj370+du3bx/ieT4Im2tJ+onAZDJpoVCo0NbWtmgymaZeeumlQn3pbRlGe3u73tHRgcbHx7GNos1r+Zuu61ipVGLK5TKzSYGGmc1mmmEYTpIkZjMPgRAiE4kEU6lUSFEUCZZlyUKhwCqKYqdp2uf3+71+v98pCIK5UCgQH3zwAUxOTgKGYVShUKCz2SxXqVSckiT5BEFo4Xm+sVKpOCqVClapVGDptZa52DAM0DQNJEmCcrlsU1WVtlgsgsvlSh45ckQymUxJ+Kg1+E+BpmndZDIJJEmWEUIiABgbacibrEZIzczMBG7cuOE7fvw4hxDCHkcsAoZhOkKIN5vNFYZh9FrXztJnPR5PvrW1NYzjuH1hYYGanZ01l0qldc+zld+J47jU2dlZ2L9/f8lut/+MRB0cHFREUcwFAoG0x+Mx8TxPV2tO1EyudV0vOByOiT179mRCodCgx+PZ5XQ69w8PD3dqmkak0+lVn5VhGHC5XBAIBBKhUGispaVlsaOjIx8MBss0TRcSiYSSzWZZhJCjqanJvG/fPifDMO3xeHzP2NiYa35+filWZ1WoqgpL6aDVtvVkuVx2VioVzmw2b+qMP3PmDJfP5/fG4/Hnbt++fXBhYcG2Xiyaw+HI+Hy+O2az+aqu65HW1ta64vZpIwiGYWCpVMpz6dKlgzdv3jzF87yvVnKwkcl5tX4KawVZrfb+RmZUXddxnudpnuetBEG4h4eHy319fQpCCDt//vzHH1zen33F/dUDFpeho6NDPHXqVHJwcDA/MTHhr9UKVINw2tTfcBzHDcOwZDKZ4KVLl1p/53d+R/ijP/qjn3EZ/dZv/Rb81m/9FnR1dRHwUeMbLhaL2bLZrKWqHVGKolCKolhLpVKgUCi0CYLQDgBBhJAzkUhQc3NzoGkaaJqGKYqCq6pKaJpGIYRoXdc5wzCYJQuBYRgfv2qBqqrE9PR0iKbp3RaLJWUymcT29nYVIRRfufbOnDkjR6PRzMLCQtJsNv+UlruVjJ41NEotGo3i4XCY3bNnDwlb8D9vEYrdbleXFSeqCQRBoGq9Ar1SqajpdFotl8ubXZOy2+1ePH78+ExfX19+NeKVSqUEgiAiTU1Nc6FQyBqLxTySJG3mDEeqqkoIoWgwGLzX1dWlOJ3OSYSQqGkaaRhGA8uyhCAIHxdFwjAMGIYBu92ONTQ0ZLu6uvoPHjz44YkTJwZaW1tjFEVVwuGwFo1GjWg0iicSCbKvr8906tSpkMvlOjw+Po50XT8oiiJbJUy4YRjEklthaZ1WLQfAcRxYLBbweDyKz+dLWSyWYrFY3JRGHwwG7ZFI5Mjt27dfvnPnzo5kMmldbS8QBIHcbnelra1tPBAI3MBx/K6qqkLdvfApJAgAgI2Ojlrv3bsXymQyXqjB57vVCocrP7NEINb7rvX+LggCOT09HRgYGDjo8/loURRn//RP/7T0P/7H/5BaWlpUk8mkMQyj/+hHP9IZhtEMw0Bms1knCEInCEIbGxuTd+zYIT6FVRNX5Youlyvzla985XYikXD81V/91bOJRCLwCd0LnslkPJcuXdoNAPi9e/faKYoqqqqKCIJYsh7BrVu3wGazwd69ewmTyUTH43Euk8lYZFnmDMOgAYA0DINUVdUsiqK3XC6HSqVScy6X82UyGTKRSEChUNi0f3gzUFWVnpycbL19+/ahlpaWosvlSnk8nvRK4VwNFC13d3dnQqGQUg12W5dILe2NTcSGqKIoEplMxpLP5zmEUOkxkWSDYRiwWq2bPRcJTdNs2WzWj+O4ied5WtM0A9YJXF05DgRBFPv6+u59+ctfvrF79+7oagQBAEqBQGCGYZjhsbExD8Mw9vUIwhp9HgzDMCpmszlOEEQyk8nwPp+PCIVCBY7jGjAMIwzDwKraPIbjONI0DVWzGnI+n2+oqanpzu7du8dwHC+vNp+3bt2C3/md34kIgiBlMhnd6/XGdu3axbAsyzIM4+V5vjmVSnkLhQJZKpU+zqKgKApcLhdqamoqtrW1Te3atetqY2PjlK7rm6qNIcuyNRqNtt2/f79nZGTEsRZZ8/l8ySNHjjw4cuTIj4PB4NA3vvGNejzYp5gg4LFYjEilUriu69jKyV6rKcryw6mWzbrWdbWmba32+UqlQg8PD7fSNG3p7OzscjqdYYIgsgihoiT9/+39aZBdx3nfjz/dffa7r7NhFgx2gABBDMFd3CVbe2QZdFmVn6PYLqVSSVxy5WVeEHzrqiRVzpt/VJWqWE5FLtGSZUWmSZEWIZAiQRIEIAADEBhgFsw+d+5+79m7+/8C54wuLu8MZkCAHID9qbo1213OnNOnn28//Sy2yTm3GWOO7/supdRljFHXdT2MsWcYhsUYq58/f740MzNT6evrq8H11DSAzd9K907AAWB+YGDgzT/5kz+xlpeX1R/96EfP1Wo1bT3egPW6u9djzDjnaGpqKler1Q4hhIZrtVodIeTqus7DMruMMZiYmIAf//jH8Itf/AIBAKnX67JlWZLrujLnHDPGMEIIB6JXA4AopTQG12vng+M4G44sv5n47fC/Idd10zMzM3uvXr26sHfv3nPbt2+/2Gn1jhByi8VifWRkpP7hhx9a1WrVaL8nN+Kd6XSvu66rVSqVWK1WM1KpVB0+nTRSRin1k8mkTwjZyDmXbdvunpub4xhjpVarJTu5/tc4B7Svr+/qF7/4xV8/99xzbwHAEgB8bDEQj8et7u7uBVmWp2OxWEGW5W2wsRoL0HIeEWMM5ubmFsrl8lsY48t79uyJHDhwAPX392MACGNW2MzMDH/33Xf55cuXrWq1WlxcXFxECNXX+pDdu3c3zpw5c940zaIsy+9s375dGhkZSff09OyemZl5+MMPPzx45cqV7uXlZcm2beCcg6qqkMlkGtu2bTt/4MCBX+/bt+94Op0erdVq6xYIhUIhNj4+3jczM5MZHx+XyuXONj8ajTb27dv34de+9rWfPPnkkyd27tx57d/+238rFMFdLBBIsVgktm27nPMNhe/exl4Jt7SC8zxPmp6ezjiOk5mbm9vS29u7I5lMFjVNqyqKYkqSZMmy7CCEXEmSXEopRQh5jDEXIWRJklTTNK2cy+VKW7durQ4MDFiJRKJZq9UKJ0+eXH7wwQc/N3tmgSCqAUCNc+5/97vfzTWbzcQ//MM/7Go2m7nbZUTX2eERN5vNSLPZjADAlqA5D5dl+YYaG+VyGZaXl1vfa1PGzTDGSL1e71pcXBysVqspWKOlcDqdrj344INXJicnT3HOt1+9ejVVrVYTrUGL6/HOreJxQIwxTCmV6/X6pzlHUcdxGt3d3cVUKtUoFos655ysY06QGo1GbnZ21oDr7chjGxAXzWQyOfHcc8/95mtf+9oHADC+muhXFAWpqkoAQKKU4qDGxbrOc4unAhFCSLVaNTjnUpBGOg0AM8G1QC3jEwEA37ZtG3/qqac2tBgJnlsJHohzDpOTk4m+vr7Zc+fOWUtLS5XFxcV+xlg0Ho+jZDIJqqpShNBSLpc709/f/+tdu3ad6evrK633cy9evBhbWFjYPTc398Dk5GR3oVAgHbYWuKZptV27dl380pe+dOz5559/c3h4ePJOeeaEQPgUbQNjDAXRsHy1SWa9BY4+LXHQ4vZCs7OzUKlUopOTk0Y8Hs+oqmpjjF2EkIcQ8hljFAAo55wxxmjws4cQsjHGpq7rVjabtQYGBvw9e/Ys79q16/1t27ad4JxPf073zWYPHTr0+l/8xV9YGOMv/exnP3u2VqvF1iMW1xIAtzpeKKWAMUau64LnecA5D+MGPm0RdctjllJKHMfRKKUKrF3bobxz5853v/nNb5pdXV0H3n333QMnTpzYPzs7m+uU+7/RWw0h5BNCvKBAzqcye/+///f/fErp4t69ez+amprKNZvNQcuyEuuYF3Cj0Yhdu3bNAACoVqtkLePdgm8YxoVnnnnmjX/zb/7N6/v37x9byxjOzc1FCSH9s7Oz26rVarfv++pGrz3GmMqy7FuWxRKJRPs5hzt0rsP3rnDOL0YiEcu27Y+azWZK0zTlvvvuw/fffz8ghNjc3FytVqvNeZ53dSPiAABAVdXe6enpx8+fP//82NjYjkaj8bHsB1mWze3bt3/4e7/3e69/7Wtf+9XQ0NC0EAf3hkDgGGNOCMGdVim3krLYKdZgtb9voN74Wis0qNfr0Gg08MLCQgRjbMDv6o6HhQF5y/vwlgcL/n+maRofGhqqfvGLX0x95StfYclkEjjnc59GUZlN5k1wOOcXDx8+XP3Lv/xLpGla8ic/+cn9xWIxutbYXk/Q6a3SLgg+7cnnZp6Pmx0PIcTRdb2mqmrHDIUWzEgkcuGhhx6ayWQy1/L5fDmXyzXfe++9HVeuXMnVarVYJwO2zvMhGYbBUqlUQ9d169PaRpufn/d27tw5m06nTy4tLSWnp6fTMzMzifWcdtu2yfz8PKGUQr1eX8/2hK0oyvzjjz/+m+9973v//NRTT51GCK1Z8396ejreaDR2Li0t3V8sFgc9z1M2+C8yQoirKIqFMbZvcn3vFPWzZ89+tLi4eGVqaoocOHAAHzhwAP7wD/8QyuUyvPHGG7RYLPqjo6PuCy+8sO7rHhQN656fn3/g/PnzD05OTiYty8JtHpjm0NDQ2PPPP3/sG9/4xqt79uz5qLXgmuDuFggskUhQVVURxnhd+4Praa7UHp+wnsJHt8MTERiRVnfeurEsC2q1WqzZbD7m+z7inKsPPPDAO5zzqc9bICNCyOOcTx88ePCtf//v/z3Sdb3w93//9w/Nzs4OrPdarKd2wnqN22ZZjdyCuOUIITeRSCz29vbOJpPJCqyRPRBkLzgAUKhUKqe7urqcRx999NqOHTt6Ll68uOP8+fMPX7x4cd/y8vKGj50QImezWTo0NFQfHh7+1Jo3fe9736PVanXRtu0PFxcX8ydPnrx/bm5uy1rZIGHkPcYYarUamKYJ9Xr9ZhkklqIoY48++ugH3/3ud3/9+7//++dvJg4AAKampoxGo9FdqVS21Ov1+C14pnxCiKkoSj2fz5ufZr+LlnHDAcANHnDp0iV4+eWXb8tbS5JkVKvV/NzcXLpUKiHf9wEhBBhj0HW9MTw8fO7JJ598+9lnnz0+MDAwhhCyQXDPCAQ6MDDg5HI5Zz3u9LUMfHsRl0+66vpMTgal6MqVK9t+9rOf6YwxwhhzDh486HLO5wGAfp6CFxFCjHN+6eDBg8Xvf//7xWw2i/7u7/5Ov3z5cjLoykg2YtRXi1m5E22+b/f46iRw15s9oKpqbevWrR8dOHDgQl9f3yL8Lhh2TZLJZPnnP//56WQyefmJJ55QvvjFL953/Phx/x//8R8TJ06cSFerVcQ5lznnN3W9I4TYli1blvfu3VsYGhqqwqeX4hiOo2oikbBGRkb6R0ZGLl+5cmVgeXm5Y8VIXdd5V1cXzWazlFKKC4WCHBb8WQtZlguPPPLIB3/2Z3/22lNPPfUhXI+puSme54FpmtiyLCncwtrotCFJkhWPx2sAcK+1JkfBOfJd16UAICmKArIsc8MwvL6+vsuPPvrom88888ybhw4dOt/T09MEwT0lEPjg4KC1d+/e8qlTp8rlclmFddS/v9UAxbthX4oxRqampra88cYbD2ez2XI+nzcZYzSbzS7AZ9886NMWCQ4AzHLO3/nTP/3TSDabbbzyyitb33///Z6lpaUtnHN9IyvtjVTK/KQGv5MBX8sDsM4Ayg0dO8YYBgcHS4899tjpQ4cOnUomkwvrFQgAAN/4xjdMADCDz3amp6cT27dv9zzPS1uWFbcsa2BpaWn74uKivlrBHMMw6JYtW6aefPLJ95944olTmUym9GkL3WBVbXPOL3/1q189trS0pL3zzjsPlMvlbsuyUHheJUmCgYEB/6GHHhrr6ekpzs7Oxk6ePLl1aWlprS0JKstybWRk5Oof//Efn3rkkUdO9fX1za83figWi7mGYVR93y/JspzEGGvtwuUmY4/HYjErGo02MMb3WmAzYox5hBDTMAwnkUhIhBBIp9Ol3t7eib179x4/fPjw8d27d5/p6+v7XHdovCcFQph//dhjj01duHDho+PHj0ue5+Vg9S52q4qEWzH+d2K1t15jcTNPwrVr1/pPnjz5+N69e+s9PT0FACjAZ7O/uBmY6+3tfeMP//APx7du3bq3v7//0GuvvfbgxMTELsaYvJ7xsh5P1EZ6cdyqJ+CTpNxuYKxzjDH09vZaTz311OUvfOELHwwPD58DgE/STbG0vLz8tizLVw8dOqT39/f3NpvNR0+ePCm//fbbOxYWFnD7OVQUBQYHB5effvrpt37/93//lQceeOD9SCTyWealzz7++OO/dF23kUql/BMnTjw9Pj4eM02Ta5oGXV1dcODAgWvPPvvsr7Zt2zb+wQcfbJuYmIhPTk7GVxtjhJD6vn37Ln/9618/vXPnzo9c113cyJbg4OBgI5vNTs3NzY199NFHUYRQD1wvvLVeEUiz2aybzWbtezQwz8xms/P9/f3zjuMMS5JUGxoaOnffffcd37t371uZTObcj370o5LolHtvehAAAOqPPPLIheXl5UxQr16hlCY/TeO8UQN+KyKk/TNu9pmmaWrT09PbxsfHd91///25TCZzW6rP/fjHPyZ79+4ltm3zkZER/27Ytgii3ic55/MHDhxYYIxVDMOoHTt2rDA+Pj7caDR6PM9T1xOQeCsdPG91zHW6xndyEscYA8bYNAxjedu2bbXHHnts8Utf+tK7Bw4cGAWApU+yPx28di54wKlTp3K2bVvNZlMZHx9fAgA1Ho9DMplEnudBuVxmnHPo7++f3L59+68GBgZ+09PTM/sZjyOLc3756aef9hYXF+PLy8syISQtyzKNxWIQiUTY8PDwxe3bt//q4YcfnnZdl73zzjvPyrKMOm0xyLLMd+zYsfTss8+e3rNnzwkAmCoUChvaA3/wwQfr+Xz+o/Hx8ezZs2dTsixnV2u33Yl4PI4GBgb8eDx+L8YpcYRQaceOHeeXl5djhJAJ0zQb3d3dp/v7+9/K5XLnHn744aIw+fe4QBgaGjr/la98hXqeRzjn2rlz5/a6rhu5Xau1OykA7pSh8X0fSqVSfGFhIV2v1yNwkz33mx0HY0xaXl7WS6VSvFgs6rFYjDcajQbnvIIxdu6G1QdCyJmYmBiPxWL2008/fW3Hjh2nL1++/Njp06efP3fu3HBbXYJbvh7rWc3f7DmfdiBk4Hr1BgYGruzfv//UQw89dOnw4cNT27dvvxSLxaZvd/DaAw88sPzhhx+epJTW4/H4b4aGhuQnnniC7N27F1UqFf7WW2+xc+fOUYxx0XXdjw4ePDi/ibyW05Zl/YumadMPPPBA5P7772e6rsO1a9e4ruuLlUrlI1mWvW3btu3fsWOHeebMGR50KFy5tpqmwfDwcPmRRx65uGPHjncJIScTicTigw8+uCFD/fzzz9cB4HI0GlV37Nix7e23394X3O/rEYRsYGCguXv3bltV1XtRILDe3t7FeDz+LiHkmuu6iUuXLtm2bS+oqjouxMHnQyA4ADA/PDzsfvvb39YkSVJ/9rOfWefOnRuq1WoJ13WjqxU2uZtdaus5dtu2UbValUzTJHALmRGcc3Ts2DF1eHg4ffny5fzS0lJ2cXExUa1WI4qisGq1WkskEsvvvfde8fz58+aVK1f83t7e+n/4D/+huVk9C1u3brWPHDky9Vd/9VdzTz755MWpqal6Op2OuK5LZVmOWpal2rYd9TxPWU9E+FrbVptpPGCMgRAChBCfEGIpimJrmuYjhKhpmpwxhnK53PxDDz30/je+8Y3fPP7442disdgcXA9cu+170wgh/uKLLy7OzMyUHceRn3jiCfL9739/JYMnn8+zcrnMPvroI//UqVPOZxFdv5ZH6nvf+96lQqEw8Ud/9Ef4z/7szwAA4H/9r/8Fo6Oj/te//nWbcx7N5/OVgwcPXrly5UoWAGLVahVzzpmmaX5vb29z7969VwYHB9/zPO+3juNcO3z48K2k13kAUBgeHr5y4MCB2b6+PntpaWk98wPLZrPzDz300IUDBw7MM8buOYEQiLlqNBptjoyMjI+Pj5MrV66w+fl5/w/+4A9E86XPg0AIDBHlnC8PDAyc/fa3v+329vZefvPNN4fOnz+/59q1awcLhUL/Wq09P8lK8RZb2G7Ii3Gr70spBc/zsOM4BNYRvNn22fjMmTNxSZIG33vvvQcmJyd3T01NpQuFQsSyLBVjzJLJpBWNRmuc86bneXYqlaps2bLlPAB8AADVzTpmXn75Zfryyy9TALDHxsY+iEQiZGhoaLSvry+JMe5fXFw8ODk5uWdubg5a+8WvJ7tlvR6B1TxUd2JLIey6l0wm3WQyOZdKpa7m8/lr+Xy+xDm3x8bGvPPnzwPnvEIpvRKLxT6KxWLXgq2ZO8ZLL73E4Hp3SPudd96Bv/zLv+z4vA8//HDTjaEf/OAHHgB4r7/+Ovz5n/95p6e4hmFcPXDgwBuVSmUhl8vlK5WKijF2o9FoLR6PFw3DmKSUXpidnZ38i7/4C/oJ57/atm3bKvv27WtcvXoVqtW1b79IJFJ56KGH3v3Sl770yx07dnzUaDTutQyG8PwwCNInBZ9PD8LKQAg6kpW+/e1vn9m/f3/P22+//dD777/vnjlzBsbHxxP1eh3Zth2muMmwitt9owWQWoPS7oRIuJmIWe05sixzTdOoLMsMNpjB8NFHH0XK5fK2ubm5R959991n33nnnQemp6djnueR61WfEWCMw+ZRNBaL0ZGRkYW9e/e+WSqVTM75WQBobvYYhf/zf/7PPAC8nkgkfnPo0KFkLpfbf/XqVfOtt97SbNvuXlhYUBhjZD3Xo73nx61e21tJVYPrdfpZ8D0PcvG5YRgQi8Wgt7fXHRwcnNu6detHO3bs+HDXrl0XduzYMV2v1+uvvfaau7CwwOfn5+m1a9fM119/3XziiSdEE7BPhgsAV4eGhqqe513K5/M9rutGIpGIRQgplEqlpcnJyeVyuVz7r//1v5q34fNYOp0u7Nq168quXbsSly5dSjSbTcn3/dB7yAGAIYT8ZDLpjYyMnP/Wt771+nPPPfdGOp1ehuueWIHg3hQIwSTtA0AdAOqc81K5XHZLpRL1PG92YGAg7rqu2mg0ouVyOVOr1XprtVpPvV5XLcu6lc+6flcGxU82m2sZIQSxWMxOp9MNRVEs2EB62osvvojPnDmTr9VqD165cuW5999///CFCxe2rJXLXSqVwHXdLGOMIYTYU089lRocHDwTVHPctCLhpZde8iGoD885n5+dna0DAExMTFQzmcwhy7J2WZbV47ruqoVuMMZ3xIPU6ZpqmgayLIMsyyBJEpckqaooSokQsizLcsUwjGY8HncymYxvGAat1Wq8Wq2CYRhOPp9fHBoamty7d+/FkZGRqwBQzGQyrPW4p6am4NVXXxWz4O3xbDY552Y+n1/2PC8jSZKWSCTcYrFY/vKXv1y/zdsmnu/7V9Pp9Ot79+6dSyaTWyqVSr5Wq2WbzaZOKXUURSmm0+nlPXv2FJ9//vlTzz///Il0Oj27mbZvBEIgfFo3qPfmm2+OVyqVZjKZPPXkk0/K27dvj1BK82NjY9suXbq0/+rVq/dPTEwMzszMGMViccNbBTfr93A7DUO7p+JmaJrm9vf3zw4ODl4zDKMyOjq6bnfxsWPH8OLiYq/v+w9eu3btkfn5+VzYC37VJSylMDc3p7322mt75ubmUuVyuedb3/oWHhgYKEOQC383TOqc8/mTJ0++RSkdi0ajS1u2bInWarWu5eVlbJrmLdVC+KTXPRQhhmFANpuFTCbDU6mUm06nC6lUajqVSo3HYrGryWRyOp1OL/f399czmYxt27Z//Phx/tprr4FpmrRcLlv1er3h+34FAOqfw66fn5lQePPNN52+vj5SLBbZHWqkZs/MzFxyXbfQ399/es+ePUOyLO+q1Wo7FhYWkr7v19Pp9PiOHTsu79mz59quXbumstnstBAHgs+lQAAAeOaZZ2wAmAoeEAQrZnt7e68RQgoAsByPxweGh4cT9Xod1+t1ZJqmbJqmYlmWbtt2zDTNlOu6xqfdXOdmBuNmpFKp2oEDB87t37//t+l0eqGnp2fdHoTZ2VnCGEtTSndUKpWuZrO5rvgFxhg0Go3Y+++/H+OcK9FotPD1r3+9xDm/CgClu6EvROCFmgOAuWeeeWaLoih1TdOwZVlgWdbHhOBq3gNJksAwDC8ajRZ1Xa9IkuRwzjHnHCOEEGMM8QCMcdh0g8P17QFKCKGGYbiRSIRxzlmtVoNGowGapkEymaRDQ0PWwMDAUm9v70x3d/d4Op2e6Ovrm+nv7y8CQONOxw8INjwX+dChXfNtHrdFACi++eabE5VKZbK3t3euXq9PX7t2LckYqw8NDU3s37//cj6fnxUlhQWfe4HQ4SainPOlRqPhLC0tlZrN5qVcLpd84okn1L6+Psn3fXlhYSEyPz8fX15ezpTL5aH5+fk9MzMzg/Pz89F6vY5CN/NmzoBQVZXef//9E48//vjbu3fvfgchNAcbLJLkeR5mjEmMMcwY22ihJjh79mzvz3/+8ye7urrsRx999NeZTOYk3GXBQoZhmJRShzFGFUUhG6lAmM/n2e7du+e2bdt2tqur65Ku61UAwL7vK5xzggJ3RVAxj7FgYAU/u7FYzOru7ja7urrser3uvfvuu/z48eMwOzsL5XKZ9/T0uIwxkzFWtSyr3Gg0Sv39/TUhDATPPPOMzzmfu3jxotloNGY455qqqrau6+V8Pl8WY0QgBMLqIoEDQOXIkSP1er0+uWfPHnzw4EE0MjJCAEBqNpva+fPnU8HKeWepVCqMjo7uO3ny5PbR0dFcuVxWPu1jXi19rpPRVhTFHRkZufbVr371xIEDB95LpVKXAcDZiDv52WefZaZpVjnnU9PT0/cVi8XIRseFaZryhx9+uHd4eNjJZDKL999//0UAKN9NQyWVSiHGWI1SWiOEJKFDqmh4DVrjExRFcXbs2LHw/PPPn961a9fx7u7u38qyXCaEYN/3Fc/zJIwxZowxXdd9zjnDGLPAS+VLkuQMDQ01UqmUCdfT2HxCCL9w4QKcOHECfN8HWZY5xpgzxlgikaBf/OIXRQc6wQ2LodCjAL8LUhQIhEBYD0GaG3311Vfhv//3/94+6S+Pjo4uIISWFEWZ2r179+VYLPZktVp9rF6vd7duN7Qb7jvlWVjP+2qaRg8fPnzhhRdeOP7kk0/+MpfLfXQrrsSenh46NDQ012g0PtA0LTU7O7u/WCz2rbOf/QpLS0uRkydPDh46dCj3wAMPKHfT+Dhy5AjeunVrw/f9a5TSa5IkEQCIQlu6aIfART8Wi83t2bPnw5GRkbcGBgbe4ZxPVCoVE2OMUqmUJMsyxhgjxhj3PI8tLS3xZDLJe3p6+MTEBDt8+LCPMfZWu+bz8/MwPz8PJ06cELOVYF3ThzgFAiEQbp/69jjn5dHR0UY8Hp/q7++fKhQKsQ8++GDvlStXbhAIt7M4TlhX4SZtYduhAOAmk0nv8OHDi0eOHPn1448//ou+vr4P4/H4LdUieOmll9ibb765IMvyexhjZXJyUpudnU3Ztr2h6pSe58Hi4qJeKBRU13XJ3TQGfvzjH7Of//znhUajccFxnN4LFy4kEULRdYg2lM1mF/fs2fPe8PDw2/F4/HI+n29N90QdAh3FBC64XQsJBAD46NGjZGhoCE9OTuJGo4HK5TKORCKoVqthz/MQAKzUSmitmeD7PorH4wAAUKvVNvz58XgcZFnuOJ4TicTK31RVXXmOqqpc0zRuGAaPRqO80WjwoaEhFolEWC6XY8eOHWNBzQyBEAibRiSs9CjnnM+rqrosy7K9Xlf/RrwLiqJAJBIBVVUBAMB1XTBNExzHWfU1GGNQFMWKxWLz3d3d84cOHVp89tlnxw8fPnwsHo+fTiaTn8id//TTT9dGR0cv7du3T5ufn++bnp7eMjY2NsQ5lzekXiiVPc9btSHSZr7+U1NTRdM0z1YqldwHH3ywhxDSf7NgVVmWSV9fX2N4ePjq9u3bxxBC7RW6+GeVEiu4Z0UBBgAyNzcnX7x4UV9cXIw99NBDsaWlpXg2mzU0TdOi0ahaqVRkAJB835copSgSiWCMMTIMY0XQc85xmLGUTqfDe/imx0AIWZmXJElibT9zQgiXJImrqsoURaGyLDNCCAtSdT1VVX1d1z1FUbxoNOoRQixCSNN13eY3v/nNxre+9S3T9333DmWACIRA+EQo1WpVbjQaeD03SyeRsIY44D09Pd7WrVvdSCTiU0qhXq/L1WpVrlQqkmmaODRKwc0GmqaxRCJR7+npuTY8PDy6Z8+e8yMjI5cGBwcnHceZ6uvr+8R7/UHhqcqJEycmRkZGzlar1R7f96WJiYkt6xUJhBBIpVJ2IpFwOed33QpgYGCgBgDjS0tL3Tt37py8fPnyrsXFRWOtaz0wMGAeOnSosHPnziJCqC5uHcFNVvsErndfVBuNhowQwgCAIpEIBwBoNpsIACD4uX0SQQBALMuSSqWS6nmeQSlNIoRyvu93Y4zzhJA0QijBGIsghHRJkhRCiMI5l8KMGrjeFhkxxsD3fdTuFQ0zddo9mxjjFa8nQggIIWHDL04I4UExtfB7TgihCCGKMfYIIRRj7AMAlSTJkSTJRgjZGGOLEGJhjKuSJBUlSSoyxpY1TasMDQ1Vm82mZRiGA9czQjj8rr4Lb/salu0OzxsLXyNSO4VAuK0sLi5Gq9Wq3mg0pI0KhJuhaRofHh4uP/bYY1O6ri8tLS3Z1WqVMMYUWZYV3/dl27YRpRRhjEHXdZ5MJr1sNlvN5XJTfX19F/v7+y9u3759LBqNFtfbR369IuFnP/tZ0TCM84899piOEGr+8pe/vO/q1auDnudlYI3yzQghyGaz1s6dO2e7u7sLiqLcdeVOg6yX6rZt2648/PDD7y0vL2dOnTq1o1wu523bJqFwI4SArut2X1/f3FNPPTX+hS984UxPT8+yuHPuGSOOx8bGpKWlJYUxpi0tLRnNZtMoFot6uVxWK5WKUq1WsWVZyLIsZNs22LYNjuNAo9EAx3HAtm1oNptQrVYhkUjAF77wBfjhD3+I9u/fLwOAMjc3p9ZqNQVjjAkhSNO0VkMHGGOOMebh/MMYA4QQcl2XMMYky7IU13V10zST9Xo902g0ukzTzJmmmTJNM+55nuE4jmbbtuq6LvF9H8LsJM45MMaAUrquJnWhIGgXCIE4uOFv4fsFfUBAkiSQJIlKkuSHgkGWZUeSJCf4amOMTVmW65qmlSKRSElV1aKu65VIJFI3DMPSNM3VNM1TFIVijFnw3jy4XjzwwiLP81ZSidPpNE0kEpRzTl9++WX2d3/3d/DBBx+A7/uQyWQgk8lANBoFXde5YRhMVVVmGAY1DMOLxWKeJElOIpGwMplMMxqNNqvVqv3CCy98LgODhUBow3EccF0Xua6LVrth2n/f7jlYzYNACGH5fH5h37597xJCTjcajYLjONDf308OHTokpVIpJWi4hAghkEgkWDQa9QHANE2zbNv2EgAUYrFY5U7876dPn27u27dvjBBSf+qpp64lEomJf/mXf3n0zJkzD5ummer0GowxpNNpd8+ePZO7du0609XVNa7revNuvPaBJ2X60Ucf/RVjzMvn849fvHjx0bm5ue5arYYwxjyVSrkDAwPjIyMj73zhC1945/Dhw7+NxWKz4s7ZlNcTGGPh6hIDgFKpVBRCiBQamHg8zgEA6vU6bjabkm3bkiRJkUwmEyuVShlN0/K2becRQlmEUJIQEiWEqJxzEtS3WPksSZJW7n9KKYSGeXR0FBqNBiQSCeK6LqnX65Lruvh65itaV1xTYNwxAGDGGKGUSr7va77vG57nRRhjEd/3dcaYEjwPKKUrnoB2j0CnQmydyoe3CojWR/i70OPQ+hmtogFjLGGMpTYvBAcAH2PsBzFgDgA4siybgVfBliTJlSTJwxhTjDFFCDGMMW/9zE5zsSRJoOs6TyQSTFVVVqvV+NzcHGiaBgDXe5UQQsL/gTHGKCHECTwbJkLINAyjrGlaQVXV+Wg0urh9+/ZiuVyuJZNJM/BidPLwdJobefv5FgLhLkdV1RWFvZ4Awo206vV9nyGESn19fedVVT1+4cKF+e7ubvav/tW/gn379pHgepBqtYqq1SoMDAywFneZf/ToUXonA3iC9y6/+OKLtSeeeGLxa1/7WqG7u9tMJpPszJkze5rNZsT3fQ0AZIQQl2XZz2Qy7tDQ0Nzu3bs/HBwcfCcajV6Fu6Sa4irX0+Scn7Msy3IcxwlE3W5KqSLLMo3FYqXBwcFzDz744K8efvjhdzKZzCJsoLS1YOO8+OKL+Omnn8YAIFmWpczPz6uFQkEtFAqyZVmkXC6jpaUlNDs7C+Pj46CqKjz33HPw7/7dv0Pz8/PYcRy1VCrpxWLR4JwrlFKJEAKccx6uRhlj4furvu9HLMtK1Ov1fL1e7240Gj2VSqW7VqulTdOMNBoNpdlsSq7rguu64Ps+uK4Ltm2He/vAOQdJksB1XZidnYWZmRngnIPv+580KKX19bjFvY5ucbx/FgYMwfX+ODIA6HDjlkGr8d3wXBdsfXBJkkBRFFAUZaVcuaIoYNs2cM7BcRxQVZWpqkqbzaZnGIajaVpT1/WGruslwzDmi8XiTCwWm5uZmVlKJpOVSCTS0DTNlWXZi8VilIcKL8DzPJAkicuyzA3DoJVKhS4vL/NXXnkFfvjDH8Ls7CzE43HIZrMQi8VW7A3GmBuGwQEAZFlmmqaBYRhU0zTGOWeGYTCEEIvH4z4hhHmeR7du3erbts2j0ShrNBp8dHQUent7+fe+9z129OhRfvToUX47qqcKgdABxtjKQFpNDKzHq9D+O9d1uWmatizL1Ycffrj4yCOP2IFh3lSe1qBnQfHq1asXnnjiCSebzRYOHTq0e3JycqBcLm+xbTuhqipNJBLVXC5XSKVSV5PJ5G+j0eh5jPE83OUd1RBC9sTExBWMMYrFYkvZbLa3r69P1nWdlkqlpiRJ07quX8hkMnOihPFtce1jAJCXlpbkRqNBEokELxQKPJvNgiRJpFQqqa7r6s1mM8Y5T8fj8S7LsvKWZSVd141IkiTJsoxlWYZEIgEAAJOTk/C3f/u38Prrr2NKqVytVuV6va5QSgljjGCMQ9d9eP0wQggzxiRKqer7vu55XtzzvITjOEnXdeOe52me54HjOEApXVlEBIZ/5XchlFJwXRdu91blbT73m+KW6yB+bonwGnieB2HfHVVVQdd1kGV5ZWtEluWVrZBQQGCMmSRJrizLDULIgKqqO1VVLcuyXFdVtSlJkqMoih94NTghhLengyOEuKqqPB6Ps2g0yk3T5OPj4xB4hEHX9RUPRiBmmCRJHCHEdF33FUWhkiT5gffEjUajtizLrqqqtqqqlqZppqZpTUmSrHg87kqS5GUyGfrMM88wz/Po22+/7R85csS9ePGid+LECa+3t9dbWlryR0ZGWAfPR6u45J22rIVAaEPTNPB9HzpFsHdKc2zfx1sL13WhVCrher1OarWavNnPxbZt22oTExMXXnjhhWsPPfTQ2QsXLuy5cuXKzmq1mtV13c/n84VoNDotSdLVcrk8GYlElvft2+fdC4FBW7dutf/Tf/pPlw3DuHbgwAFl9+7dOJfL8fPnz9NTp065x48ft5577rnPuzgIXez45ZdfJgBAJiYmpFKphGu1Gp6fn8f1eh1mZ2dhdnYW6vU6HD58GP7jf/yP8Cd/8ifhClhxHCdaq9Ui9XpdZ4xJtVqNG4bBg1U5sW3bcF03appmplqtdler1cFKpTJQrVa76/V6vF6vS6ZpIs45aJoGlmXB1NQUTE9PAyEEAQDyPA/5vo9athygZdW6YpyCqpcYrgfzSQBAOOckKJ0NrY+bGdqNdvwU3BlCQdc6R6/yFSOENISQCgBJAOgLtkEoxpghhMJVOV9rvscYg6ZpXFVVCIz/DXEbvu+DZVkgyzIwxnggVCkhxEcIeYwxD2NsE0JM13UthJBFCGlijJuKotQ451Xf9xuqqlqEECc8RsMwPFmWPd/3HUVRnFQq5SCEnN27d9uO43gAQFVVpS1jntTrdcn3fSJJks85NwHAXFpasj788ENvbGxMCIRVVDWnlK77zg4u8LrUerPZBMuyiGVZd8O551u3brUBwOacVzHGVUrp7NLSUiIej9NcLldVVXWBMbZ46tSp5ne/+917KmL4f/yP/+HA57w1LuccjY6OyrVajQAAbNmyBWRZxsViEem6Ti5duiQ3Gg0jl8vFy+VyMp1OpzjnMcdxjEgkovi+j6LRKCQSCWCMwfLyMrz22mtQqVQglUqRarWqFAoF3TRNnTGmEEJIEAXPEULg+z7xPE/1PE/3PC9hWVam0Wh0BY+Y4zjYcRwwTXMlWNC2bWhvtnUXerE20wr/rmeD/XVQsHj+xHM0xhhUVQXDMCASiYDruisZIJIkrXg1wu+Dzq0seHiyLNuEEJcQYimKYqmq2pRluakoihXETXhBCikNenT4GGMfY+xijF1Zlj1FUVxCiK+qKpMkiYXng1KKgiBWHPaDiUajRULINd/3F7q6uqgQCG2oqsrXG39wM+/CahNuyF02YXknT56cliRpmVKqWJbFLcvyCoWC/cILL7hi5GxuI3/06FF04cIFBACwtLS0MvZ+/etfrzzvxRdfhKNHj4YrexkAtImJiagkSbqqqoqiKMiyLGg0GsQ0TeK6rux5nl6r1ZK2becbjUafaZpbGo1G3jTNtGVZummahDEWBo9BtVqFY8eOwYkTJ4BzDrZtY9M0JUopBgAS3Be8zUtBgpW8zDlXOOca51xpvUdb+6aIlbtgs8AYA8uywHVdsCxrJVAzFA+t9iP0MGCMMUIIc84lhJAeJGdQAPARQlSSJAoAFGNMAYAFWS8QlHHnQZo545wzQggLvB5MkqSVwMmW+wQhhECWZYhEIrS3t3d5586d54aHh8/H43FXCIRVLmongdDulurkZlyP8r8bBQIAQFC4RBQv2QQG/9ixYySXy+Fr164hAICBgYEbBlw8HidXr15VMcb6P/zDP8Sy2Wz0vvvu02u1mhqPx5VisYgKhQIMDw/DzMwMSJIE77zzDvzN3/wNHDx4kFiWpc7Pz+uVSiXiuq4OADIhBAV798T3fcwYk13X1V3XjZmmma/X693VarWnWq3myuVypFaroWazCaZpgmma4Hke2LYN5XK5/f4IRYGoKiW4J6GUgmnecuz2bfNotMZMtS1qEcaYz8zMDFNKU4qiJPL5vCMEQof5N8xiWMfJ/pgYuNnKJdgDFQjWNQ7axhMBAKPZbBq7d+/WPM+T9u/fj4Ln8VYByhhTurq64uVyuYsQ0qPreo+madlms5lECEUQQlLo2oxGo+D7PoyNjcH//t//G+XzecQ5x7VaTWo0GrLneQrnHGGMUcuqHgMA5pxLlFKFcx5xHCfium7EdV25NcI/DOBrzb+/1fPxORKB4iQI7sjiYrVxRilFtVpNWV5e7isWiw2MsRAI7di2Dau1PG7fRriVfcIgwvau9CCIVfuxlR4TTz/9dMc9qGPHjuFYLIbq9ToBAKlQKCjNZlOpVqvKwsKC0mg0pGaziWu1GiqVShAa0kajEQaxQrl8vTjm448/Dn//938Pzz33HMYYKwsLC/rMzEzMsqwIQkhjjMmSJKGwol2YdsUYQ57nqY1GI9FoNLorlcqWUqm0pVwud1Wr1WS9Xter1apUq9VW9kRd14W5uTmYmZkJx3Vru/P2sco7GHXUei+05tl/2sZuvanHG0lRvpXnbxolGgTJrVbX5VZ+7jQP3glB1Fp7oX3rqHX+bR13rV1XN7pV/LlftVw/z8T3fez7PhYCoQNhgZM7wXq9E4LNcbMEkezGuXPn9EgkomCMkaqq/PLly4xSytLp9MpAKZfLZMuWLYRSKmGM9UajETMMI8U5T9m2nYlGo4kgx14lhEiqqoLv+yv7jwAQltcGz/NgZmYGfvjDH8Lx48cxQogsLS0p1WpVpZSqjDEFru/ZgyzLrY2gUDBJSp7nGa7rxh3HSdu2nbRtO+r7PvY8D9pX+OH3t9P7sRkM6WoifjWjc7P/5bMQPJ+UsAZA2DMhTLPDGK+k+rWWT27/XVtp5fbKiisBpUGUf2uBoBui/lvOfZglAkHZZ8Q5X/m51bi3Vn4Mf9f+aE83DV8TBq+K+fY6QZzCqmMZYwyxWIynUqlCOp2eSaVSwoPQaU7xPG/VyXK9cQarvXfgYhXeg40banT06FEUFABZ1RAdPXoU7du3D+VyOXT27FmiaRqpVCpkbm6ONBoN7LouClPvAADC7+v1660UDh8+DN///vfRd77zHQIAkdnZ2fjc3FxiaWkpyhjTJElCkiSxIH+Zlctl2iIsJc45sSxL9Twv4jhOslardVUqlZ5gfz4TrOC1Wq1GGo0GCht12bYNrusC5xxkWQbOOSwuLsKxY8fC0rLYcZxwMsXBGEKtxg7a9vFb0vOk4Hu02nkTLu1PX/B0WoW3BbBRhJCPEKLBg92k7gYPDTkA8MBY8jA6XtO0lRLIhJAV0RCURF55BOl5YYoeD6PqZVlmCCFGCOEYY4YxpuHfgmqHPKh4uBIYRwhpDZQDzjkKtqUQ5xwzxjCllPi+T1piW0ggZAmlFPm+T1zXxZ7nAWMMhQu4VmEbigTf9yGcvzVNA13XwfO8Fa9Ya62KtTwf7TEyYTpvcD/hsGlWGEDbfi/dbJx08kaHi4TwGG/nWAsa/q18RuvnB8KPxmIxZ3BwcGl4ePiD/v7+04lEQgQptmPbdigO0B2aJFDQOCUstSpm5jXO1eXLlxUAUN9//33561//Onr//ff5q6+++rFz9u677wIhBH3zm9/EnHO5Uqno27Zti1mWlfR9P5lKpWKyLBvlclkGABKJRKDRaABCCOLxeLga4eVyGf3iF7+A2dlZol9vmBGpVCoRy7I03/cVjDHinPOgLjwL3PrhDUc459j3fZlSqjHGoo7jpEzTTDuOk3YcJ2bbthxW3Qsr74WTWvtKKQzqE9xeI/5ZbxWExXnClXpopFsq/jFN05qKolRUVS2pqlqRZbmqKIpJCHEIIazt/8XhmIxGo9QwDMYYo9euXWNjY2O0UCiA67qgKAoYhrEiBFrS6m4QDKqqgqIoXJIkHhh7CFPkQtEQFAliiqKsCIawTkAgHsLc/vB3YcVKBAA4EAI48BzgoJdCKBBQIBCw53mIUoplWUau6yLGGArEBTiOA4QQcBznYwWrfN8HjDEMDw/Djh07UFdXF6aUomaziSzLQi0rat7J0xSK6WCOxp7nEd/3Vc/zDM/zImERLUppwvf9CKVUo5TKgdhZ8UK3ejdae2GE34dCIDTYQWovWJb1SYIaP4aiKBCLxUBRlBv6ZciyDLqu03g8Pt/T0zM+ODh4YWBg4IPu7u5LkiT5QiB8XGlh3/fxRiaOjXgUwufqug6bVBwgzjmEaXF79+5F8/PzKHChr8ys9XodXblyBbZv397xTa5cubLmh7T+ffv27fDXf/3X8OUvfzlcFUsAoFiWFSkUCrFmsxlTFEWnlCJFUXg+n2dh3fsQSZIAIYRd18WMMU3X9YTjOHnf93s8z+ujlOZs2065rqsHufXhTcwJIVjXdTBNky0uLqJjx47BqVOnECGE2LZNXNclQQU+3HIdV4q5BxNjWO8/PIcSXG+3KwfbAVIwud3gOm2Nd2kdP3fj3undkrsfTsa3eI7bK9Ld7J/lrav7sASwpmkr+fEt39NoNOokEolKKpVajMVi8/F4fCYajc6lUqn5WCxWVhSlKcsyDUtEU0pRYGh5UArcz2QyPqXUO378uPfDH/6QTk9PM9d1V7YaQgPhuu7KypUxtrKF0FaOOFzVMlVVwXGcUORwQgi3bTvsb8B93185F8HrWNgDoR3f91FYdppSiiilCOB6USNJkpBpmqjl/0Oh0Q/HWeg58DxvpfhQeGyu60K1WgVFUaC3txf98R//MT506BBBCOGw0VbLWOCrjOWVwlmu68rNZlNxXdewLCtRrVYzpmnmq9Vqj2VZ3ZZlpW3bTniep5umaTiOozqOI7uuiymlONjPB9/3VzwYrRUfQ89HKBgopaFIC/9+w7zR6qXo5IVq3SYKm1uF3pSw9LSiKKCqKjcMw8tms4uDg4Pnh4eH3x8YGDiFMb5MKS02Gg0mBEIbjuOgwA12p1YPXFVV3zAM7zZOeGRsbEwKi9lIkoTK5TKSZRklk0lu2zabm5sDAIDe3t6V1xWLRaQoCpJlGWmahpeXl4kkSfLx48eV+++/X9+6datWq9U0RVFU27aVaDQqmaaJm80moZSiPXv24HBAhzdvWF42kUgApfSGsrQtf2fJZBLX6/WV5/ziF78AWZYhm83iWq2mLC0tabVazWCMGYyxCACoCCEcFAThYYW84B7nvu8ThBCilBLbttVmsxk1TTNdq9XylUqlp1arZZvNph649VGz2QxX8DxwY64Usmo0GrC4uLimGz6cQFpWIB3r4X9eXPftE9XdIBI6/Q+teeqt7lkAcBFCNUJIFWPcwBhbCCEvKE/LWpsYhS5+QggzDIPGYjEajUYZpZSVSiWoVCoQdGuFRCIB0WgUNE2DaDRKU6mUlcvlyplMZjmTySzG4/GFZDK5kMlklgYHB6vxeNyC3zUMuqFULtzYSIjv2LGD//mf/zlvud+hWCx+rubzn/70p/CTn/xkJfsmn89veGi3PPSZmZl4sVhMlsvlbK1WyxWLxa5ms5mwLCtm27Zu27bebDaVoOOm5HkecRwHU0qR53krc2U4T4a/C8VCKM5SqRTs3LkTJZNJRAiBRqOBGo0GBEKKh+OsbayGNQ24rusQiUSAEAK1Wo0vLy/zarXKwx4hkUgENE2DSCRi53K5hf7+/ku7du06k8/nL+/Zs6ccVsMVAuHGSQNNTEyEK8VPHIjVaaJUFEUCAKVUKimfdEIOVqbRiYmJWLFYNBBCSqi64/E4CfbcGMaYDg4OsuBvK6vgfD6PKKU4UMmSruuqbdsR0zTjvu8nGGMpxliCEBKnlEY55xpCSEEIyQghiRCCwpVwsCr4mBhoOV7eWswmrIeOMYZ6vQ6vv/46P3v2LCiKgkzTJNVqlTiOIzPGZN/3JYyxxDlHwcqJt6xEVsqGBjcIZowRzrnMGNM45zpjLOr7vtwW8MTbjm9FxbftIfJVDD/v8DOH9eX037YYlM24ar8bRVHgRodoNLqyqg8mWR6NRmuxWGwhHo/PxOPxa5qmLSQSiZIkSU1VVR1ZlinnnIfBdoHbmGKMva6uLrerq8tRVdW/cOEC+/nPfw6/+c1vwDRNMAyjvXAOu65xqYMQsiilTcZYo1KpWE8//XQTISRqkNzatV2vt+dmeJzzxvT0dNH3/Xnf93Xf9w1KqYYxloNYHykIbMaBhwRhjBGlFIUdP8N5p90b4Ps+NJtNcBwHstksPPXUU+jZZ59FXV1dqFwu43K5DIwxpCgKD7cNQoI5baVduKqqkEqlwHEcfvLkSfbaa6/xQqHAbdsGWZZXtrquv5Q2CSElznlhz5491VbPtgiWa2Nqamr4r/7qr/7ohz/84f9Xr9f3fJKVVIcJ07v//vvP/Jf/8l/+6aGHHnprZmZmanR01JuYmFDK5bISNKtBrutCpVIBz/Og2WxCoVBY2Y967LHH4E//9E/RY489puq6ri8sLMSmp6cTjuMYhBAlMJIoKFmLgyAhL7w5WuswUEoxY4wELizJdV3VcZyIZVlx27aTpmmm6/V6yrKslGVZ0dB15jiObFmW3Lpf3raPzkOXWku0MQ+f5/s+C1btiFLKKaUs2HsMXbgYOqfS8TXcuKjD6/gqz+s49tsEHVrlGFbeZ5XAwPXcW6v2ArhTAuHTEBKftuegvfVv6FpFCLkYYxNjbEqS5AYlaFcC5cI9cU3TqK7rDCHEG40GdxwHZFmGZDIJ6XQaUqkUy2azVj6fr+Tz+blsNnstn89PJJPJ+VQqVUwmkw1CiK1pGm29hqZpgq7rLBqNenC9cZkLAF6QiiomWcGGFq0tc1urt4h3mE9Q+7ZW8GC3up0tPAgdthgCQ8VvZcK6yWoK+76fXVpaun9ubk6yLGtekiSeSCSivu+nXNeNeZ6n2LZ9wx6ppmkrrvqJiQn4yU9+AufOnSOEEKVUKum1Wk3zPG8l7S0o1IgZYygIDqKweu76SkQ8pVSilGq+72tB/fuI7/uG4ziG7/sk8A7wMACnNc+41XMQrNRZmLERrq6DqGUU7KW11gRf+TmAtRlQDr/b3w//jtpuDNryutYbCcPa+8UrN1xrZgB07vnO4SatdVuM5FpeBH4bJ5BN43H4tMWBqqqgadrKnr6u69wwDDMSiSxEo9FpXdfndF0vKYpiBlH2FAAoIYQGzcbcTCbjmqbpnTx5kr333ntQKpVAlmVIpVIgyzKXZdkjhFiEkCohpAQAJUVRqrquN/L5vNupA55AcJu9HxxuofX17UAIhBuVmnH58uUsYyzBOZfXuzraQKEQVK/Xs2fPnj0AAHlZlivVahWq1WqqUql0VavVmGmaUrg/7jjOSopOmPpWKBTgrbfegg8++CCMrkUtgUqr7YF3UpudSkfzIBI/jMPAABCu7HlLxD763duvnJSV7fjQiAfPa3W9syCwhrdmcHQ47k43A2sx5qxFVcMqhpy3vQ5W+QzU4T34Gp6LTp3c+E28A+1iBK0hGj43ZYeDcxim8fmBsb1hTEGQSx8EW7HAQ8ABruf3R6NRSKfTkE6naSaTaebz+YWurq7JXC53JZvNjhuGsRiPx+uKovie5/mqqvq+79NsNuv19PRYhmG4AED/23/7b/zMmTNQLpeBUgqGYYDv+6CqKlcUhSaTSeq6LlVV1f/Hf/xH9tJLL4kKPIJ7ns+tQAiMnwQAeGFhgTQajQhCaEuhUDjQbDa3cs6jd+BjcbFYjPzmN7/pm5iYSOm67lBKkWmakWazGWs0GmBZFjiOs9JHPtwzb02BaTQa0Gg0bvspWcPIQpuK7WRU2Rq/b3fDs8BzET4Pw8cjw9Eax9fps1YTC6zNm9DJGHcSJmiVY8AdREerUecdjg2t8v531LvQLhQ/7eKd4Z5rSxOalfQ+RVFAUZSGrusFRVEKsiyXZFluAoDLGKPBGKGcc19VVS+bzfqZTMZjjLHZ2Vl2+fJlqNfrgDGGSCQC6XSa5/N5u6enp7Jly5aFvr6+uXQ6vdDV1VXu7e1tDexj4WM1t2utVoMLFy4AAMCJEyeElRAIgbAZVvBBIRx44YUX0JEjR2B0dHRlRuvt7UUAAHNzcwgAoFQqoeBmDvf9EABAmMIyPz8PwfNXvh8ZGYHvf//70r/+1/9aAYBYo9GITE1NSYwxqVKpZBqNxs6zZ88empub20Upja3mKVhv+da2VTwEx4nHxsa0yclJFWPM4HpFMdxap36tkqJ3SBDwNVbYnX7mHYQEbxME6xEbvMPfV7wNqwgO1P45LbEAofBjHd4Ptf4PYf/3Fs8Gart+vINXpPVz2kUGX2MM8I2Mmw5bFJ8oTqHTOLwFWNt146v8D2Hee5ixA6qqgq7roGkaxGIxiMViNJlMNnO53Ew+nx9Pp9OTsVhsJhKJlGRZNhljviRJ1PM8nxDiJJNJZ3Bw0M5kMs7i4qL/xhtvsB/84AcwNTUFvu9DOp0GSin3PI81m03Ptm2HEGJfuXLFfeCBBzxRa0QguEWR/1mu4EdHR6VCoaA4jqM0m02JECJZlkU0TSP1el0KotiloKIWwRgj13UlSinxPE8yTVN2HEeyLEtyHIfYto1M0ySmaaKwvn2pVIKFhQVwXRe2bt0Kzz//vPLII49ohmFEyuWyUSgUwvdOFYvFoatXr24/d+5c78zMTMJxfldpcq3iKqvVJf80286uVVK2wzF0NGhtkfsM1naXc1h9n77Tz50M3g2GL0it4YGR52uspkmrZyIo3doaR9BebRG3GPWVY0AI4ZZ0xY73Q9vv0XruobY+G6vdY2idAY2fyn3butoPv7bkTNcVRanJslyXJKmJEHIwxn7rGJckiUUiEU9RFM/zPG9xcZEuLi4y13UhFotBKpWCWCwG6XQastmsn8/na319fQtDQ0PXMpnMbDKZXOju7q5gjO18Pu8DACsWi34mk3Hhd/ElTAT6CQT3oAchmLgVAFDq9bpWKpU0xlgkFosZiqJEdV3XHMfRFEVRKKVqNBpVJUnSfd/XVVWVKaVy0JxG9n1fAQBdURSdc65TShXf91WMsUQIIZIkobCAhiRJYBgGyLIM5XIZHTt2jJw+fZpgjCXHcSTbtsN9dtWyrFitVos3m009yKv/WO3qTgZ1Pe7b1hKXn9EE12nPNDSkqEVM0Jt4Fm4QBsHqLFyd47bP4p3SBQMhgAI3MofrwZU8iE2AMPCrxaCHQYjh937LMaC2AMcV4xsY6jBIc6W2EVzf3gC47sIOBcfHBEuHY+/kyWjf4gBYe5sAdYgL2ajhv60xCmHAn67rYBgGGIYBkUgEksmkm0gkiqlUajaZTE7HYrE5wzCWZVmuybLsBIGomDEG0WjU6+npsaLRqFkul5v/9E//5L366qusUqkAQgii0SgghCDoA8EAwGGMmdVqtRGLxRoIoWZ3d7cD1/vcCxEgENzLAuF//s//aYyOjmYZY6n9+/drJ0+elGKxmOa6rlYsFnXP83TbtiOU0ghjzPA8z+Cca5xzxfd9zfd91XEc3XVdnTGmhvnwvu/LjuOotm3rlmXptm0bQdqdalkWaa1tb1kW2La9UimsWq2ubE10MtbtBZJai5+0PrdVKKzV/GItT8PtngBXe781jFForMKGKuxmnoYA2vL/tBvOlZVeaDDb6gmxDs1bEAD4YQAkdM4mYB0MKIKPR/e2pjqyNqP9MQPbcj39Vs8WfDzFEd3EWLd+fnuRrY1sD3zsuevswucAgIUQciBIqYMbM1daRSIDAKqqKo3FYlTTNM455+F9Eo/HIZPJQCaTYdls1uzp6Vno6uqayWaz15LJ5FwymVwyDKOqKIrLGGO+72PHcSCRSHg7d+60AMAEgObo6CgLi001m024evUqXL16dbXzJtSAQPB5EAhBep7xq1/9asfS0tKDs7Oze0+ePJk+e/Ys8TyPlEoluVqtKpRSOShmo3LOFcaYzBiTMMYSAEhBQw+ZMSa3NJsJ8/aloN69FObWh7XrW8tWtjbxCEtz3umVyaeZj77O9+Kw/nKw7b9rNcyhcVkt15au4rEII9E7ZRO07mcTxljoXWg/ptDot6csorbjQy3HsZph71SBDq/xerTKOURtxwewdm7yqpex0/ehi19RFBTm+IdleoOOj1xVVa6qalXX9YKqqkuapi0TQiqKojQIIbaiKLS1QJXneT4AuLquW319fXZvb6/TbDbpyZMn4b333oPl5eWV4j2qqnJd121N0xqqqlYIIRXDMCqRSKSxf/9+a3R0lNm2zTVNQ4ZhwM6dO/2WaycQCIRAuMEw6gAQA4DI+fPneycnJw8uLi4+PTk5+eDMzEy6WCzyRqOBbNtGnufhtkkYt020qMMEizdqPO9Ue9abrNZXPZZP2W3KV1lBtu7v8zYvA+pk3OHGAL+VrIDQK9BhhU9bhMHHBEh7GlurcW37W/vxUOhc7Ii3eRBYy3vxtjHE2ww/C/omfEyUBMdOg5TMG8ZlS0AewHW3uNdWkIe3eRNQuIUSvk/4PIwxUxSFhxXSbNsGSmkoBJBhGCuNdoIgP5ZKpZxUKlVJp9PFXC43l0gkZuPx+Hw8Hl+ORCJVTdNMVVVpsA2AgtW+bxiGk0qlml1dXVbgbfB/8IMfwNjYGExMTEC9Xod0Og2lUgmi0Sgrl8usr6+PlstleuTIEdqpfa9AILg3uS37mIuLi1FCyH0zMzMHz58/3/Pb3/42PTY2tnV2dnb//Pz8QLFYBMuy7t6T9AlW/WHsQWtjmPZ4hVsVDmtsWdystGin4i6szTCzwADytm2KdqHQacXvt/8uNCztbVQ7GP5wRd+6cmdrrMrRGq9tFRC4zVPQ7kG44f0xxkiSpKDmFOL4OiBJEg4NtyRJvqqqtqqqZVVVy7IsV2RZrmOM3ZZYjpW4C4zxSjneUMAoiuLquu5kMhk7k8m4juOwixcvwujoKJRKJdA0DdLpNMRiMYhGoxCNRsNgPy+dTjdzuVw1m81WMpnMsmEY5UwmU8MYm7FYzIlGo5QxxjHGiDHGHceh/f39vijZKxAI7rgH4cUXX8RHjhwxSqXS7rNnzz77y1/+8sunT58eXFxclBuNhu55nhFWANxsBn+9Rrk9DuFWDfidECCrBEeutcLrlG64mlBofz5rEwOd0iBbDfoNMQQ3iW9Yrd5Cp+e0Zzi0l1dGbcfSqegRgo9vQYQNUFZc+kETKyRJEpdlGWuaBoZhkHg8zmOxmJ9IJGqJRGI5Ho/PB9325qLRaAkhZLbGNWCMOUKIBZ0fEUIIeZ6HMMa+LMtOOp1uDg4O1nt6eqxSqeT9/Oc/52F6ruM4K419EEJQr9dRNBoFz/OY67qsXq97iUTCX1xc9Agh3pUrV+j3vvc9sdIXCASfnQfh/PnzSqVSyTqOs/vs2bOPvvLKK898+OGHD5fL5ehmKv+63hX7Wsa8PRhxPcfenvFwO9r33uQ88Q5f28sGr1W/oNXIQwcD21pohq9izFv38Ferj7Ba8GGnbYewbHSrF+IG4Rak5yGMMSKEMEmSHFmW64SQBsbYliTJQwjRYPUe9qMgYYZEEMFPVVX1NE1zbdv2CoUCK5fLgDGGWCyGguY9KFi9o0wmw7PZrJtOp+tdXV2VeDxeyOVyhVgsVshms2XGmK0oCtM0jVuWBZqmccYY0zSNmaaJotEoKhaLKJVKUVmW7UwmY8P1ioJiD18gENzdHgTOuXzhwoWeZrN54M0333zqlVde+cJHH320w3XdyCc13mv9/VYFROtKe634gdWOpT2zoT2bYa3f387YgzXeZzXPwGrGma3xPNRm3HmHFTlfxcOwmscB4OPxDBw6VzS8YdUfrOS5JEkgSRIQQlDQiz6sv4+i0Sg3DMOOx+P1WCxWjMfjC5FIpBCJRMq6rjcJITbGmIbu/aCJFPJ9H0mSxOPxuNPX12dHo9HmpUuXmj/72c+8d999l5mmiXRdXxEqLcF+QClljDHXdV3X933Ltm0LIWRTSl0A8J9++mm+xvUJ285yUcRHIBDcUwJhfHw8XSgUDhw7duzZn/70p1+4cuXKfYwx9U6Kg/W+33qM8UY9Fu3iYbXj+rRL2a5ifCA0rG1u5pW98MCFzoLaAyvd7WRZtjDGTlAIx8EYu8F+9Uq8QeA65y3nhrUZ/PB5YZXIld7lnHO/JVOBt6RJAgDwYCXvAgC3LItVKhXWbDY5YwwURVlpzhPEAOBIJMITiQRKJpM0l8uZ+Xy+ksvlitlstpDNZhcNw6jqut6MRCI2Y4yFQYCe52HTNEnQ9ZImk0mnp6fHAoDml770JbtYLPJf/epXAABQLBahWCzecG5ffPHFle//83/+zx0DMddxzQQCgWBTs2GLxjmXT58+ffCVV175g//7f//vly9evLiVcx6/pQ+/iXdgI8F8gQFad5rhej+z9Xm3KgDucPbCx/bpZVkGWZZ5uNKWJIkTQlbK34Z/DyLnmaZppmEYtUgkUjMMo6goSlVRlLKu61WMsc0DgqY6YeAiC847C/7cWh8hFCNhTQMclJVmgUgIX4s554gxxgghNJ1OO11dXTbG2D537pzzxhtvsIsXL3JKKcRiMYhEImAYBgTeA24YBkqlUpBOp3k2m3VzuZyTz+fNVCrVTCaT9Wg0ajPGPIyxn81mb3DfLy8vY8dxeF9fH9+xYwdtjRkQCAQCwQY9CMFkn/zoo4+2//KXv3xgbGxsT3vXw9thQNfRNvn2qKMOnoSbbTV0Ei3r2ZpYBz5cL3DjAwANV9ntn9NSUIgGkfEUY8xkWV4RCqFbXtM0HrTD5YqisHAVHqTM+bquu9Fo1IrH47VEIlGMRqPFWCxWikajhWg0WtQ0rSpJUpNSygAAGGNMlmXq+z4QQlbSEgkhXJKk9jRFoJTiwDWPMcaMEMIAwA++AsYYW5aFGGM8Go36+Xze7u3ttQzDsEZHR90TJ05QSikHAEin0+F7AqUUXNeFWq0GmqaBLMtQrVaBc8593+dzc3MMANjRo0eFC18gEAjutAchEAexixcvbv+bv/mbr/zt3/7tC3Nzc/tvZZW+loHeyOvX8143O75b8V50+qyNHjNCCCKRCMRiMVBV1ZQkaZkQsowxrhBCGpIk2RhjGpYMDjJBeLD6poQQJ4iAt7u7u23DMLylpSV+7tw5mJubAwCAZDLJE4kE1zRtRRhIksSDlTiLRqN+NBp1E4mEFay467quN1KpVE2SpEYmk2lyzt3QSOu6zmKx2EqwHwBAuVwG3/d5aMBDwiZaAACWZWFd15nv+3zr1q2MMcYZY7xcLmNCCAIAiMfjtFwu+/v27RPNdQQCgeBu8iC8/PLLeHh4OFkoFIYWFhb6TdOM3MwjEEaZ3ywwsFOJ4tX6HqzXC/FJn7ua8V/t9RsQMlRVVT+dTvu9vb20v7+/sWXLlrl8Pj+VSqWmo9HogmEYZV3Xm5IkecF743AFzzlnkiS5AOBomtYcHBysb9261bQsy33jjTf4X//1X8Ply5cBAECWZZ5KpTghBGRZBs45eJ4HjuOAoiicUso559xxHGaapq/rul8ul6ksyxQAqCzL7NixYyuu+aNHj/LVPDzQoYpgWzOiTnv1azWDEggEAsHdIBDK5TKempqK12q1HtM0c5RSFVZpGtNuQNYy8hutSrgRo327WKtC4gY/myWTyeXdu3dP9fT0zKuqWolEItVcLrc8PDw839vbuxCLxZbj8XiNMWblcjnfsixwXRcDAFBKGeecy7LsDw0N2XC9Br8bNjfqcM2gXC7ftvPw0ksvrfuUtV2jteoyCAQCgeBuFghzc3NI0zTZdV3ddV0teO1t7Sh3pw397TjG9WyZrPF/sL6+vrmvfe1rv87lcifHx8enFxcXzaWlJaerq8ssFAqWLMt2vV73AMCfn5+HQqHAc7kcAgAoFAocAGB0dJS/9NJLImdeIBAIBJ+9QOjt7eXJZNJdXl62ZFm24HfldD8T7mTQ4s28Bp/gs1kikagcPHhw7IEHHnjv7bffngmMvehsJxAIBIK7UyCkUimWTqfrvu8vappWIIQ0YZUthtYYhPWmCH6WnoOwc17YFjrsAnmrqZdr/S+e5/myLNs9PT3mCy+8QMUQFAgEAsFdLRCOHDnCyuVylXM+nclk5jRNczayyv8sBEBQEMhFCDkIIRch5COEfIwxwxgzSZJoNBrluVwONE1Tq9VqvFAoRGu1Gm7vH9Hak+FWhEGIbdvYNE3ZNE1VDD+BQCAQ3PUCISh609y2bdv8li1bljKZjLu4uIg2W8wAQgg0TYN4PM4jkUg9FovNG4axpKrqsqqqdVVVm4ZhWLFYzM5kMnY2m/WSySSen5/vO3ny5EitVjtAKdXXEgCf4H/mvu/zIKiQBW2ExZaCQCAQCO5egRAYX59zXt6xY8fcfffdd21xcXFPqVRSGWPkEx5He73/9oZA4VfU9juAoGRvUH6Xp1IpyOfztKurq9zb2zvT1dU1nsvlJuPx+KyiKKVYLFaJxWLNZDJZ7+7ubnZ3d3sAQN5+++198/PzkZMnT+5ijOm34h1YJxRj7DPGfCEOBAKBQHBPCIQAa9euXRPPPvvsW57n6adOnbpvdnZ2i+etr8U8ISQs2AMYY8AYexjjOsa4CQBNjLGNMbaDLQEPY+wHq+32FsCMEOLLsuzF43E/l8vRrq4uGo/HQVEUT1XVWi6XWxoYGJjr6uqai0ajhUwmU4lGo41UKuUAgNNqoK9du6aoqlr0PM+/k16RoPwxbfl/BAKBQCC4JwQC3b179wTG+FVN0xq6rjvvvPNOdGZmJu553g2NgcJVf9gUSJZlnk6nIZfLQSaT8eLxuBWLxZYNw1iMRCIFVVWLsizXNE2rKYrSlGXZIoS4kiT5QZGg0LvAZFn2CSGOoihuMpm0urq63Ewm41UqFXbq1Cl25coVr9ls2pZlmb7vW5VKxT548KC7WktdhBDyPA88z/tYNCXG+AYvwicRELIsc1VVaSwWEwGKAoFAILh3BEKw6m5wzi83m01/fHxcnp+fd2RZ7qKUIsaYxBiTfN8HhBDXNM03DIMSQhhCiGKMIZlM8t7eXqe/v7/a3d1disfjS8lkcjkSiZQ1TatFo9FaJBIxI5GIbRiGyzn3VVWllmWBpmkMALhhGB4AuMGDBg8OAHxkZAQ20mGPc47OnDkTaTabsuu6N3vuJzrhQeAkr1arYvQJBAKB4J7yIISGjr7yyivXXNf9VTKZvNrX1xcfGBhQ4vG43mw21Xq9TiRJ8rPZrJ3P5x0AcC9evEjPnj3Lm80mazab1HEcFyFkAkDT8zzLtm0rEonYpml6kiS5hUKBKorij4yM8KNHj7Kw1G+wque3cSsAMcYIpZQwxj7mQQhaFN+WOISgqyJPJBIi/kAgEAgE955AAAD4yle+4gDApSNHjow9+OCD0uOPP67t3r3bqNfr2uzsLE6n034ul7Oj0agNAO6xY8e8iYkJ/uqrr8KRI0cgEonwQqEAhUKhtc7/qoZzA6V+NwoOBAL6pJ6Dm6VCyrIMhBCoVCpi9AkEAoHg8wXnHAXdH++W45VPnDjxyHe+853/n6ZpRfhdIOQNjyCWYuVxs+d0+Lv91FNP/eLdd9/9A855QowUgUAgENyTHoQ1VtF3m/scWZYlUUrxejwDrb/byLYDQggURQFCCIAoqSwQCASCTQwWp+D6eSCEEN/3MdzGBlTtEEJAVVXAGHMhEAQCgUAgBMJd4EHwfV/inONbbT+9XoGgaRqXZVnUQBAIBALBpkYSp+C6UMIYY0opbo2daA84bG881S4abtaQSpIkkKSVUy48CAKBQCAQAmEzUywWCWMMt6c43m5vgizLoKoqJ4TwpaUlceIFAoFAsHlXzuIUAGQyGew4jkQpJXfycxRFAVVVOeecM8aEB0EgEAgEQiBsVjjnaH5+XqaUSpzzOxakiDEGRVFA0zSu6zrt7u4WpZYFAoFAIATCZoYQQjzPkyil5E7Vb8AYg67rTNd1qihKWBZaIBAIBAIhEDYpiFwvTCBhjG+bOGiPU8AYgyzLTNM0yjkPe0cIBAKBQCAEwmalWq0S3/fx7dpi6BTEGGwx+Lqu+4Zh+HC9K6VAIBAIBJsSkcUQpDgyxkggEH7nWmhLW9xoP4bW5wc1EPxYLOZGIhF/tbbTAoFAIBAID8LmAOHrkOB8oJsZ/ltUIRCJROx4PG5JkuSL0y4QCAQCIRA2Mf/8z/+MPc8jgQdhzTTH9XoQWosqhciyTJPJZFNVVbNarXpi6AkEAoFACIRNjmmapCWD4bZnMSCEIBKJuKlUqs4Ya46OjrrirAsEAoFgM/O5j0HQdR2pqoowxrg9xbG1tPJ6vAerPQdjzKPRqBWPx+uWZTXGxsbEFoNAIBAIhAdhMzM0NASmaWLGGEII4Y0Y/nWfZIxZJBKxIpFIzXXdRq1WE1sMAoFAIBACYTMzOTkJhmGwQAjckeJFhBCqaZoZiUSq0Wi0oaqqEAgCgUAg2NSINEcACNov0zuVeogQYqqqmpqmVWKxWI0xJmIQBAKBQCAEwmamr6+Ps+v7CwxjzOAOFDDCGDNd1xuRSKRkGEbV930hEAQCgUCwqfncbzHUajUmSZJPCPEQQnek/DHGeMWDoKpqbefOnY4YegKBQCAQAmETMz4+ziilFCHkwfX+CLc9DkGWZV/XdTMajdZ1XW9GIhGRxSAQCAQCIRA2M0eOHOGyLFPOOWOM3anyx1ySJFeSpKau69bk5KQQCAKBQCAQAmGzwznnCCFG6Z1psIgQ4pIkebqu25xz5+mnnxZ9GAQCgUCwqRFZDADc931KCKFBkCJvMeytImItAbDmc8JOjpqmuclk0hONmgQCgUAgPAh3AZlMxgMAF2PstXkW4DaVRmAIIYYQop7nUXHGBQKBQCA8CJschBDnnLuSJFmBQPjY6v5mIoFzfrNOjygQCdTzPOE9EAgEAoEQCHcJrqqqtqIo3npaOnfaeugkElqEBQ/rLCQSCSEQBAKBQLDpEVsM16GGYdiapt00PgAhtPLYACtKIZ/Pc3G6BQKBQCAEwt1wEjCmhmF4kUiES5KEbyYOVvt5VXXAOfI8D2OMMQB8rGukQCAQCARCIGxCOOeQzWZpJpMBQghZRUTckK3Q+mh9n06/p5Qi13Vly7LUubk5Fa7HJAgEAoFAsGkRMQgBhmH4+Xzei8fjbq1WW9Vz0BpzsAEBgjzPkxqNhlar1ZTf/OY3QiAIBAKBQHgQ7gay2azb399f6+3tLWGMHbiFkssIoRVPQ3sgo+u62HVdyfd9Is62QCAQCIRAuHuw+vv7Z7dv3z4WjUaLcL0vww1GvtVrsFqw4mpxCZxzLkkS9X2fHTlyRAQqCgQCgUAIhLsEs7e39/LevXtPp9PpSQBwW8UBY2zl0S4cAG6MUWj9MwAAYwwwxr6maVYul7NFJUWBQCAQCIFwF3kQYrHY2N69e98bHBy8iDGurfbE9kDE1vgExljr3xAAgCRJzDAM2zCMel9fnylOtUAgEAiEQLhLQAh52Wx2Yf/+/R+NjIxcTiaTiwCw7q6Lq2UwAACoqkqz2ayZzWZrAOCIsy0QCAQCIRDuLpHAtm/fvvTYY49d3bNnzxjGeAnaYhHWEggdTzDGvK+vr7F169ZKMplsBA2hBAKBQCDY1Ig0x4/jPPbYY9fGxsZOLy0txa5cuYI5512wRu2CNVIeeU9Pz/LIyMilXbt2zSCEmrep+ZNAIBAIBEIgfMr4PT09c9/4xjfer9Vq+Ec/+pEyNTWlcM7TG32jXC5XfPzxxz/8vd/7vTcHBwcvIIQa4vQKBAKBQAiEuxMGAIW9e/faL7zwgu95nvrTn/6UTE1N7aOUJuD6tgxaxaPA4XrXRp7JZBpPPvnkuW984xv/8vDDD78RiUQmk8mkCFAUCAQCgRAIdyMIIQ7XUxyLnPMLCCFN0zT3n/7pnxbHx8cHm81milKa4JzHAECF38VxOISQiqqqpe7u7vojjzxy7atf/erpJ5988u2+vr6LCCERnCgQCAQCIRDuEYr333//6UgkstTT03Pu/fffH5qdnd1aq9V21Ov1ftd104wxnRDCDMMoJBKJK11dXR/t3bt38tFHH53Zv3//tb6+vgkhDgQCgUBw1y2YxSlYm6DzogQA2unTp7svX768Y2ZmZm+lUtnqOE7OcRyDMcZisdhid3f3xR07dvx2z549V4eGhgqBJ8IPvBICgUAgEAgPwj2joK4bdw8APM65ubi42FBVdRFjfF5RlLjjOHKhUOD1er2ay+XmhoeHp4eGhopCFAgEAoFACITPj1igL7744uLDDz9cGhgYkPft2ydVq1X05ptvcsdx/Hfffdf7zne+48ItNHoSCAQCgWAz8f8Hq41COlMIorcAAAAASUVORK5CYII=');
signatureTexture.colorSpace = THREE.SRGBColorSpace;
const signature = new THREE.Mesh(
  new THREE.PlaneGeometry(1.32, 1.32 * 0.4),
  new THREE.MeshBasicMaterial({ map: signatureTexture, transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false })
);
signature.position.set(2.65, 0.52, -2.618);
signature.renderOrder = 2;
room.add(signature);


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

function wrapCanvasText(ctx, text, maxWidth) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawDescriptionOnCanvas(ctx, width, height) {
  if (!infoMode || descriptionCard.classList.contains('hidden')) return;
  const title = descriptionTitle.textContent.trim();
  const body = descriptionText.textContent.trim();
  if (!title && !body) return;

  const dpr = Math.max(1, Math.min(devicePixelRatio || 1, 2));
  const pad = 16 * dpr;
  const cardW = Math.min(300 * dpr, width * 0.34);
  const maxH = Math.min(280 * dpr, height * 0.34);
  const x = width - cardW - 16 * dpr;
  const y = 116 * dpr;

  ctx.save();
  ctx.font = `${700 * dpr / dpr}px Montserrat, Arial, sans-serif`;
  ctx.font = `${9 * dpr}px Montserrat, Arial, sans-serif`;
  const titleLines = wrapCanvasText(ctx, title.toUpperCase(), cardW - pad * 2);
  ctx.font = `${12 * dpr}px Montserrat, Arial, sans-serif`;
  const bodyLines = wrapCanvasText(ctx, body, cardW - pad * 2);
  const titleLineH = 14 * dpr;
  const bodyLineH = 18 * dpr;
  const desiredH = pad * 2 + titleLines.length * titleLineH + (titleLines.length ? 7*dpr : 0) + bodyLines.length * bodyLineH;
  const cardH = Math.min(maxH, Math.max(64*dpr, desiredH));

  ctx.fillStyle = 'rgba(247,246,242,0.94)';
  ctx.strokeStyle = 'rgba(17,17,17,0.20)';
  ctx.lineWidth = 1 * dpr;
  ctx.fillRect(x, y, cardW, cardH);
  ctx.strokeRect(x, y, cardW, cardH);

  let ty = y + pad + 9*dpr;
  ctx.fillStyle = '#111';
  ctx.font = `700 ${9*dpr}px Montserrat, Arial, sans-serif`;
  for (const line of titleLines) {
    ctx.fillText(line, x + pad, ty);
    ty += titleLineH;
  }
  if (titleLines.length) ty += 5*dpr;

  ctx.fillStyle = 'rgba(17,17,17,0.78)';
  ctx.font = `400 ${12*dpr}px Montserrat, Arial, sans-serif`;
  const maxLines = Math.max(0, Math.floor((y + cardH - pad - ty) / bodyLineH));
  bodyLines.slice(0, maxLines).forEach((line) => {
    ctx.fillText(line, x + pad, ty);
    ty += bodyLineH;
  });
  ctx.restore();
}

function makeCompositeCanvas() {
  renderCleanFrame();
  const source = renderer.domElement;
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  drawDescriptionOnCanvas(ctx, canvas.width, canvas.height);
  return canvas;
}

async function capturePhoto() {
  if (mediaRecorder?.state === 'recording' || isAR) return;
  try {
    const canvas = makeCompositeCanvas();
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob((b) => b ? resolve(b) : reject(new Error('No se generó la imagen')), 'image/png');
    });
    downloadBlob(blob, `mosaico-${mosaicId}.png`);
    flash('Imagen guardada en la computadora');
  } catch (err) {
    console.warn(err);
    flash('No se pudo guardar la imagen');
  }
}

function chooseRecordingMime() {
  // Priorizamos MP4 para que el archivo sea compatible con reproductores,
  // editores y redes sociales sin conversiones posteriores.
  const mp4Options = [
    'video/mp4;codecs=avc1.42E01E',
    'video/mp4;codecs=avc1.4D401E',
    'video/mp4;codecs=h264',
    'video/mp4'
  ];
  return mp4Options.find((type) => window.MediaRecorder?.isTypeSupported?.(type)) || '';
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
  saveBtn.setAttribute('aria-label', active ? 'Detener grabación' : 'Tocar para guardar imagen; mantener presionado para grabar video');
  saveBtn.title = active ? 'STOP' : 'Tocar: guardar imagen · Mantener: grabar video';
  if (!active) recordTime.textContent = '00:00';
}

let captureCanvas = null;
let captureCtx = null;
let captureRaf = null;

function paintCaptureFrame() {
  if (!captureCanvas || !captureCtx) return;
  renderCleanFrame();
  captureCtx.clearRect(0, 0, captureCanvas.width, captureCanvas.height);
  captureCtx.drawImage(renderer.domElement, 0, 0, captureCanvas.width, captureCanvas.height);
  drawDescriptionOnCanvas(captureCtx, captureCanvas.width, captureCanvas.height);
  captureRaf = requestAnimationFrame(paintCaptureFrame);
}

async function startVideoCapture() {
  if (mediaRecorder?.state === 'recording' || isAR) return;
  if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) {
    flash('Este navegador no permite grabar video');
    return;
  }

  try {
    renderCleanFrame();
    captureCanvas = document.createElement('canvas');
    captureCanvas.width = renderer.domElement.width;
    captureCanvas.height = renderer.domElement.height;
    captureCtx = captureCanvas.getContext('2d');
    paintCaptureFrame();

    recordingStream = captureCanvas.captureStream(30);
    const mimeType = chooseRecordingMime();
    if (!mimeType) {
      recordingStream?.getTracks().forEach((t) => t.stop());
      recordingStream = null;
      if (captureRaf) cancelAnimationFrame(captureRaf);
      captureRaf = null;
      captureCanvas = null;
      captureCtx = null;
      flash('Este navegador no permite grabar directamente en MP4');
      return;
    }
    mediaRecorder = new MediaRecorder(recordingStream, { mimeType });
    recordedChunks = [];
    mediaRecorder.ondataavailable = (e) => { if (e.data?.size) recordedChunks.push(e.data); };
    mediaRecorder.onerror = (e) => {
      console.warn('MediaRecorder:', e.error || e);
      flash('Se interrumpió la grabación');
      stopRecordingClock();
      setRecordingUI(false);
    };
    mediaRecorder.onstop = () => {
      stopRecordingClock();
      setRecordingUI(false);
      if (captureRaf) cancelAnimationFrame(captureRaf);
      captureRaf = null;
      captureCanvas = null;
      captureCtx = null;
      recordingStream?.getTracks().forEach((t) => t.stop());
      recordingStream = null;
      const type = mediaRecorder?.mimeType || mimeType || 'video/mp4';
      const blob = new Blob(recordedChunks, { type });
      recordedChunks = [];
      if (!blob.size) return flash('No se pudo generar el video');
      downloadBlob(blob, `mosaico-${mosaicId}.mp4`);
      flash('Video MP4 guardado en la computadora');
    };
    mediaRecorder.start(250);
    recordingStartedAt = performance.now();
    setRecordingUI(true);
    recordingClock = setInterval(() => {
      recordTime.textContent = formatElapsed(performance.now() - recordingStartedAt);
    }, 250);
    flash('Grabando · tocá el botón rojo para STOP');
  } catch (err) {
    console.warn(err);
    if (captureRaf) cancelAnimationFrame(captureRaf);
    captureRaf = null;
    captureCanvas = null;
    captureCtx = null;
    setRecordingUI(false);
    flash('No se pudo iniciar la grabación');
  }
}

function stopRecordingClock() {
  if (recordingClock) clearInterval(recordingClock);
  recordingClock = null;
}

function stopVideoCapture() {
  if (mediaRecorder?.state === 'recording') mediaRecorder.stop();
}

function cancelCaptureHold() {
  if (captureHoldTimer) clearTimeout(captureHoldTimer);
  captureHoldTimer = null;
}

saveBtn.addEventListener('contextmenu', (e) => e.preventDefault());
let captureStopClick = false;

saveBtn.addEventListener('pointerdown', (e) => {
  guardUIEvent(e);
  e.preventDefault();
  if (isAR) return;
  capturePointerId = e.pointerId;
  capturePointerDown = true;
  captureLongPress = false;
  captureStopClick = false;
  saveBtn.setPointerCapture?.(e.pointerId);
  cancelCaptureHold();

  // Si ya estamos grabando, este NUEVO toque funciona como STOP.
  // Soltar el botón después de iniciar una grabación por pulsación larga
  // ya no la detiene.
  if (mediaRecorder?.state === 'recording') {
    captureStopClick = true;
    stopVideoCapture();
    return;
  }

  captureHoldTimer = setTimeout(async () => {
    captureLongPress = true;
    if (capturePointerDown) await startVideoCapture();
  }, 520);
});

saveBtn.addEventListener('pointerup', async (e) => {
  if (capturePointerId !== e.pointerId) return;
  guardUIEvent(e);
  e.preventDefault();
  capturePointerDown = false;
  cancelCaptureHold();

  // El toque usado para STOP termina aquí.
  if (captureStopClick) {
    capturePointerId = null;
    captureLongPress = false;
    captureStopClick = false;
    saveBtn.releasePointerCapture?.(e.pointerId);
    return;
  }

  // Si la grabación arrancó por mantener presionado, soltar NO la detiene.
  // Queda activa hasta volver a tocar el botón rojo.
  if (captureLongPress) {
    capturePointerId = null;
    captureLongPress = false;
    saveBtn.releasePointerCapture?.(e.pointerId);
    return;
  }

  await capturePhoto();
  capturePointerId = null;
  saveBtn.releasePointerCapture?.(e.pointerId);
});

saveBtn.addEventListener('pointercancel', (e) => {
  if (capturePointerId !== e.pointerId) return;
  capturePointerDown = false;
  cancelCaptureHold();
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
  saveBtn.classList.add('hidden');
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
