import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import {
  isPublishedRuntime,
  normalizeAccessCode,
  hashAccessCode,
  findUniqueAccessCodeConflict,
  loadCloudConfig,
  saveCloudConfig,
  getActiveDriveProfile,
  generateRandomSecret,
  buildAppsScriptTemplate,
  WORKER_SCRIPT_TEMPLATE,
  testGitHubConnection,
  testDriveProfile,
  detectBigMediaWarnings,
  publishShowroomOrchestrator,
  fetchPublishedPortal,
  fetchPublishedProject,
  trackPublicVisitOnce
} from './cloud.mjs';

const PORTAL_STORAGE_KEY = 'salo_showroom_portal_v7';
const PROJECT_KEY_PREFIX = 'salo_showroom_project_v7_';
const SALO_FIXED_WA_URL = 'https://wa.me/59173080076';
const MEDIA_DB_NAME = 'SaloShowroomMediaDB_v1';
const MEDIA_STORE = 'blobs';

function normalizeRelativeAssetPath(val) {
  if (typeof val !== 'string') return val;
  if (val.startsWith('/sample-assets/')) return `.${val}`;
  return val;
}

function normalizeSampleAssetPathsDeep(node) {
  if (typeof node === 'string') return normalizeRelativeAssetPath(node);
  if (Array.isArray(node)) return node.map((v) => normalizeSampleAssetPathsDeep(v));
  if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) {
      node[k] = normalizeSampleAssetPathsDeep(node[k]);
    }
  }
  return node;
}

function getProjectStorageKey(code) {
  return `${PROJECT_KEY_PREFIX}${String(code || 'SALO-001').toUpperCase().replace(/[^A-Z0-9_-]/g, '')}`;
}

/* ==========================================================================
   0. LOSSLESS INDEXEDDB MEDIA ENGINE (ZERO COMPRESSION, FULL ORIGINAL QUALITY)
   ========================================================================== */
const mediaUrlCache = new Map();
let mediaDbPromise = null;

function openMediaDB() {
  if (mediaDbPromise) return mediaDbPromise;
  mediaDbPromise = new Promise((resolve) => {
    if (!window.indexedDB) { resolve(null); return; }
    const req = indexedDB.open(MEDIA_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(MEDIA_STORE)) db.createObjectStore(MEDIA_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
  return mediaDbPromise;
}

async function saveMediaBlob(key, blob) {
  const objUrl = URL.createObjectURL(blob);
  mediaUrlCache.set(key, objUrl);
  try {
    const db = await openMediaDB();
    if (!db) return objUrl;
    await new Promise((resolve, reject) => {
      const tx = db.transaction(MEDIA_STORE, 'readwrite');
      tx.objectStore(MEDIA_STORE).put(blob, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (_) {}
  return objUrl;
}

async function getMediaBlob(key) {
  if (!key) return null;
  try {
    const db = await openMediaDB();
    if (!db) return null;
    return await new Promise((resolve) => {
      const tx = db.transaction(MEDIA_STORE, 'readonly');
      const req = tx.objectStore(MEDIA_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (_) { return null; }
}

async function getMediaUrl(key) {
  if (!key) return null;
  if (mediaUrlCache.has(key)) return mediaUrlCache.get(key);
  const blob = await getMediaBlob(key);
  if (!blob) return null;
  const url = URL.createObjectURL(blob);
  mediaUrlCache.set(key, url);
  return url;
}

async function clearMediaDB() {
  mediaUrlCache.clear();
  try {
    const db = await openMediaDB();
    if (!db) return;
    await new Promise((resolve) => {
      const tx = db.transaction(MEDIA_STORE, 'readwrite');
      tx.objectStore(MEDIA_STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch (_) {}
}

function showToast(msg) {
  const el = document.getElementById('toast-banner');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.remove('show'), 2800);
}

/* ==========================================================================
   MULTI-PROJECT PORTAL STATE (SALO CÁLCULO Y DISEÑO)
   ========================================================================== */
const defaultPortalState = {
  activeScreen: 'portal',
  activePortalTab: 'projects',
  activeProjectCode: 'SALO-001',
  auth: {
    mode: 'public',
    currentUser: 'admin',
    editors: [{ username: 'admin', pin: '1234', role: 'Propietario' }]
  },
  projects: [
    {
      code: 'SALO-001',
      accessCode: '',
      accessCodeHash: null,
      requiresCode: false,
      buildingName: 'Torre Pocito 3D',
      subtitle: 'Santa Cruz · Showroom Interactivo 3D · Panorámica · Plantas',
      coverUrl: './sample-assets/exterior-tower.webp',
      coverMediaKey: null,
      published: true,
      createdAt: '2026-11-18'
    }
  ],
  examplePhotos: [
    { id: 'ex-1', title: 'Torre Residencial Moderna', url: './sample-assets/exterior-tower.webp', mediaKey: null },
    { id: 'ex-2', title: 'Masterplan Urbano 3 Torres', url: './sample-assets/masterplan-render.jpg', mediaKey: null },
    { id: 'ex-3', title: 'Sky Deck & Piscina Climatizada', url: './sample-assets/render-amenities.jpg', mediaKey: null },
    { id: 'ex-4', title: 'Fachada Nocturna Iluminada', url: './sample-assets/render-nocturno.jpg', mediaKey: null }
  ]
};

let portalState = structuredClone(defaultPortalState);

const defaultCameras3D = [
  { id: 'cam-aerial', name: 'Vista Torre', floorNum: 0, camPos: [19, 15, 21], lookAt: [0, 5.5, 0] },
  { id: 'cam-living', name: 'Living PB', floorNum: 1, camPos: [-3.2, 2.2, 2.2], lookAt: [-3.2, 1.2, -2.5] },
  { id: 'cam-kitchen', name: 'Cocina', floorNum: 1, camPos: [2.8, 2.2, 2.2], lookAt: [2.4, 1.2, -2.0] },
  { id: 'cam-floor2', name: 'Piso 2°', floorNum: 2, camPos: [10, 9.8, 11], lookAt: [0, 3.4, -1] },
  { id: 'cam-floor3', name: 'Piso 3°', floorNum: 3, camPos: [10, 13.0, 11], lookAt: [0, 6.8, -1] },
  { id: 'cam-penthouse', name: 'Penthouse', floorNum: 4, camPos: [10, 16.5, 11], lookAt: [0, 10.2, -1] }
];

const defaultFloors3DConfig = [
  { id: 'f3d-0', num: 0, name: 'Edificio Completo', badge: 'Todos', heightCut: 16.5, camPos: [19, 15, 21], lookAt: [0, 5.5, 0] },
  { id: 'f3d-4', num: 4, name: 'Piso 4° · Penthouse', badge: 'Nivel 4', heightCut: 13.8, camPos: [10, 16.5, 11], lookAt: [0, 10.2, -1] },
  { id: 'f3d-3', num: 3, name: 'Piso 3° · Suites', badge: 'Nivel 3', heightCut: 10.1, camPos: [10, 13.0, 11], lookAt: [0, 6.8, -1] },
  { id: 'f3d-2', num: 2, name: 'Piso 2° · Tipo', badge: 'Nivel 2', heightCut: 6.7, camPos: [10, 9.8, 11], lookAt: [0, 3.4, -1] },
  { id: 'f3d-1', num: 1, name: 'Piso 1° · Planta Baja', badge: 'Nivel 1', heightCut: 3.3, camPos: [11, 7.2, 13], lookAt: [0, 0.8, 0] }
];

/* ==========================================================================
   DEFAULT PROJECT STATE (SALO SHOWROOM v7)
   ========================================================================== */
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const defaultState = {
  project: {
    code: 'SALO-001',
    accessCode: '',
    accessCodeHash: null,
    requiresCode: false,
    shortName: 'SALO SHOWROOM',
    buildingName: 'Torre Pocito 3D',
    fullTitle: 'SALO SHOWROOM · Torre Pocito 3D',
    subtitle: 'Showroom Interactivo 3D · Panorámica · Plantas',
    logoUrl: null,
    logoMediaKey: null,
    showLogo: false,
    logoSizePx: 48,
    logoOpacity: 100,
    logoPosition: 'pos-above-exterior',
    whatsappPhone: '59173080076',
    whatsappCustomUrl: '',
    whatsappMessage: 'Hola, deseo recibir información sobre el proyecto.'
  },
  intro: {
    enabled: false,
    defaultVideo: './sample-assets/transition-fly.mp4',
    mediaKey: null,
    customName: null
  },
  unitsConfig: {
    showTab: true,
    displayMode: 'departments'
  },
  model3dConfig: {
    showTab: true
  },
  avance: {
    percent: 68,
    delivery: 'Diciembre 2026',
    stage: 'Terminaciones & Fachada'
  },
  auth: {
    mode: 'public',
    currentUser: 'admin',
    editors: [{ username: 'admin', pin: '1234', role: 'Propietario' }]
  },
  activeView: 'masterplan',
  isNightMode: false,
  is2DPlanMode: false,
  showAvailability: true,
  exteriorAngleIndex: 0,
  exteriorAngles: [
    { id: 'angle-0', angleDeg: 0, label: 'Fachada Principal', photo: './sample-assets/exterior-tower.webp', nightPhoto: './sample-assets/render-nocturno.jpg', mediaKey: null },
    { id: 'angle-90', angleDeg: 90, label: 'Vista Complejo', photo: './sample-assets/masterplan-render.jpg', nightPhoto: './sample-assets/render-nocturno.jpg', mediaKey: null },
    { id: 'angle-180', angleDeg: 180, label: 'Amenities & Sky Deck', photo: './sample-assets/render-amenities.jpg', nightPhoto: './sample-assets/render-nocturno.jpg', mediaKey: null },
    { id: 'angle-270', angleDeg: 270, label: 'Perspectiva Nocturna', photo: './sample-assets/render-nocturno.jpg', nightPhoto: './sample-assets/render-nocturno.jpg', mediaKey: null }
  ],
  activeLevelId: 'facade',
  activeTour360LevelId: null,
  selectedUnitId: 'u-ext-p9',
  zoom: 1,
  pan: { x: 0, y: 0 },
  isDrawingPolygon: false,
  isPlacingPlanPoint: false,
  editingPolygonUnitId: null,
  editingShapeUnitId: null,
  editingFloorId: null,
  editingHotspotIndex: null,
  draftPolygonPoints: [],
  visibleFields: {
    availability: true, name: true, area: true, rooms: true, baths: true, kitchen: true, price: true, pinButton: true
  },
  imageAdjustments: {
    facade: { fit: 'cover', scale: 100, x: 0, y: 0 },
    masterplan: { fit: 'cover', scale: 100, x: 0, y: 0 },
    'floor-9': { fit: 'contain', scale: 100, x: 0, y: 0 },
    'floor-20': { fit: 'contain', scale: 100, x: 0, y: 0 },
    'floor-35': { fit: 'contain', scale: 100, x: 0, y: 0 },
    'floor-azotea': { fit: 'contain', scale: 100, x: 0, y: 0 }
  },
  transitions: {
    globalEnabled: true,
    slots: [
      { id: 'ext_to_floor9', fromLevelId: 'facade', toLevelId: 'floor-9', label: 'Exterior Principal → Piso 9° · Render 3D', enabled: true, transitionType: 'video', defaultVideo: './sample-assets/transition-floors.mp4', mediaKey: null, customName: null, img1Url: null, img1Key: null, img2Url: null, img2Key: null },
      { id: 'ext_to_floor20', fromLevelId: 'facade', toLevelId: 'floor-20', label: 'Exterior Principal → Piso 20° · Render 3D', enabled: true, transitionType: 'video', defaultVideo: './sample-assets/transition-planta3d.mp4', mediaKey: null, customName: null, img1Url: null, img1Key: null, img2Url: null, img2Key: null },
      { id: 'ext_to_floor35', fromLevelId: 'facade', toLevelId: 'floor-35', label: 'Exterior Principal → Piso 35° · Penthouse', enabled: true, transitionType: 'video', defaultVideo: './sample-assets/transition-fly.mp4', mediaKey: null, customName: null, img1Url: null, img1Key: null, img2Url: null, img2Key: null },
      { id: 'ext_to_azotea', fromLevelId: 'facade', toLevelId: 'floor-azotea', label: 'Exterior Principal → Piso 36° · Azotea', enabled: true, transitionType: 'video', defaultVideo: './sample-assets/transition-fly.mp4', mediaKey: null, customName: null, img1Url: null, img1Key: null, img2Url: null, img2Key: null },
      { id: 'floor_to_floor', fromLevelId: 'any_floor', toLevelId: 'any_floor', label: 'Cambio entre Pisos (General)', enabled: false, transitionType: 'video', defaultVideo: './sample-assets/transition-floors.mp4', mediaKey: null, customName: null, img1Url: null, img1Key: null, img2Url: null, img2Key: null },
      { id: 'to_tour360', fromLevelId: 'any', toLevelId: 'tour360', label: 'Ingreso a Recorrido 360°', enabled: false, transitionType: 'video', defaultVideo: './sample-assets/transition-planta3d.mp4', mediaKey: null, customName: null, img1Url: null, img1Key: null, img2Url: null, img2Key: null },
      { id: 'to_model3d', fromLevelId: 'any', toLevelId: 'model3d', label: 'Ingreso a Maqueta 3D', enabled: false, transitionType: 'video', defaultVideo: './sample-assets/transition-fly.mp4', mediaKey: null, customName: null, img1Url: null, img1Key: null, img2Url: null, img2Key: null }
    ]
  },
  cameras3D: structuredClone(defaultCameras3D),
  floors3D: structuredClone(defaultFloors3DConfig),
  levels: [
    { id: 'facade', name: 'Exterior Principal', badge: 'Exterior', floorNum: 0, dayPhoto: './sample-assets/exterior-tower.webp', nightPhoto: './sample-assets/render-nocturno.jpg', plan2DPhoto: './sample-assets/masterplan-render.jpg', dayMediaKey: null, nightMediaKey: null, hasTour360: true, transitionType: 'none', transitionVideo: null, transitionMediaKey: null, transImg1: null, transImg1Key: null, transImg2: null, transImg2Key: null },
    { id: 'masterplan', name: 'Masterplan', badge: '3 Torres', floorNum: 0, dayPhoto: './sample-assets/masterplan-render.jpg', nightPhoto: './sample-assets/render-nocturno.jpg', plan2DPhoto: './sample-assets/masterplan-render.jpg', dayMediaKey: null, nightMediaKey: null, hasTour360: true, transitionType: 'video', transitionVideo: null, transitionMediaKey: null, transImg1: null, transImg1Key: null, transImg2: null, transImg2Key: null },
    { id: 'floor-azotea', name: 'Piso 36° · Azotea', badge: 'Planta', floorNum: 4, dayPhoto: './sample-assets/floor-azotea-3d.jpg', nightPhoto: './sample-assets/floor-azotea-3d.jpg', plan2DPhoto: './sample-assets/floor-piso20-plan.webp', dayMediaKey: null, nightMediaKey: null, hasTour360: true, transitionType: 'video', transitionVideo: null, transitionMediaKey: null, transImg1: null, transImg1Key: null, transImg2: null, transImg2Key: null },
    { id: 'floor-35', name: 'Piso 35° · Penthouse', badge: 'Planta', floorNum: 3, dayPhoto: './sample-assets/floor-piso35-3d.jpg', nightPhoto: './sample-assets/floor-piso35-3d.jpg', plan2DPhoto: './sample-assets/floor-piso20-plan.webp', dayMediaKey: null, nightMediaKey: null, hasTour360: true, transitionType: 'video', transitionVideo: null, transitionMediaKey: null, transImg1: null, transImg1Key: null, transImg2: null, transImg2Key: null },
    { id: 'floor-20', name: 'Piso 20° · Render 3D', badge: 'Planta', floorNum: 2, dayPhoto: './sample-assets/floor-piso20-3d.jpg', nightPhoto: './sample-assets/floor-piso20-3d.jpg', plan2DPhoto: './sample-assets/floor-piso20-plan.webp', dayMediaKey: null, nightMediaKey: null, hasTour360: true, transitionType: 'video', transitionVideo: null, transitionMediaKey: null, transImg1: null, transImg1Key: null, transImg2: null, transImg2Key: null },
    { id: 'floor-9', name: 'Piso 9° · Render 3D', badge: 'Planta', floorNum: 1, dayPhoto: './sample-assets/floor-piso9-3d.jpg', nightPhoto: './sample-assets/floor-piso9-3d.jpg', plan2DPhoto: './sample-assets/floor-piso9-plan.webp', dayMediaKey: null, nightMediaKey: null, hasTour360: true, transitionType: 'video', transitionVideo: null, transitionMediaKey: null, transImg1: null, transImg1Key: null, transImg2: null, transImg2Key: null }
  ],
  units: [
    {
      id: 'u-ext-p9', code: 'Residencia Piso 9°', buttonText: 'Piso 9° · 150 m²', type: 'Piso Completo',
      levelId: 'facade', targetLevelId: 'floor-9', transitionVideo: 'auto', floorNum: 1, floorLabel: 'Torre Principal · Piso 9°',
      area: 150, beds: 3, baths: 2, kitchens: 1, price: 168000, orientation: 'Norte · Panorámica', status: 'available', showAvailability: true, defaultRoom360: 'living',
      customLines: [
        { type: 'metric', label: 'Living Comedor', number: '42', unit: 'm²' },
        { type: 'metric', label: 'Balcón Terraza', number: '18', unit: 'm²' }
      ],
      customButtons: [],
      center: { x: 48, y: 63 },
      polygon: [{ x: 31, y: 58 }, { x: 65, y: 58 }, { x: 65, y: 68 }, { x: 31, y: 68 }]
    },
    {
      id: 'u-ext-p20', code: 'Residencia Piso 20°', buttonText: 'Piso 20° · 165 m²', type: 'Piso Tipo',
      levelId: 'facade', targetLevelId: 'floor-20', transitionVideo: 'auto', floorNum: 2, floorLabel: 'Torre Principal · Piso 20°',
      area: 165, beds: 3, baths: 3, kitchens: 1, price: 192000, orientation: 'Nor-Este', status: 'reserved', showAvailability: true, defaultRoom360: 'kitchen',
      customLines: [], customButtons: [],
      center: { x: 48, y: 45 },
      polygon: [{ x: 31, y: 40 }, { x: 65, y: 40 }, { x: 65, y: 50 }, { x: 31, y: 50 }]
    },
    {
      id: 'u-ext-p35', code: 'Penthouse Piso 35° Sky', buttonText: 'Piso 35° · Penthouse', type: 'Penthouse Sky',
      levelId: 'facade', targetLevelId: 'floor-35', transitionVideo: 'auto', floorNum: 4, floorLabel: 'Torre Principal · Piso 35°',
      area: 280, beds: 4, baths: 4, kitchens: 2, price: 340000, orientation: '360° Horizon', status: 'available', showAvailability: true, defaultRoom360: 'pool',
      customLines: [], customButtons: [],
      center: { x: 48, y: 25 },
      polygon: [{ x: 31, y: 20 }, { x: 65, y: 20 }, { x: 65, y: 30 }, { x: 31, y: 30 }]
    },
    {
      id: 'u-901', code: 'Departamento 9-01 (Esquinero)', buttonText: 'Dpto 9-01 · 150 m²', type: 'Departamento 3D',
      levelId: 'floor-9', targetLevelId: 'floor-9', transitionVideo: 'auto', floorNum: 1, floorLabel: 'Piso 9° · Ala Norte',
      area: 150, beds: 3, baths: 2, kitchens: 1, price: 168000, orientation: 'Norte · Sol Mañana', status: 'available', showAvailability: true, defaultRoom360: 'living',
      customLines: [
        { type: 'metric', label: 'Suite Principal', number: '28', unit: 'm²' },
        { type: 'text', label: 'Doble orientación con vista panorámica y parrilla privada.' }
      ],
      customButtons: [
        { id: 'cb-demo-1', label: 'Ver Render Interior Living', actionType: 'photo', photoUrl: './sample-assets/render-interior-1.jpg', photoMediaKey: null, targetRoom360Id: null }
      ],
      center: { x: 35, y: 34 },
      polygon: [{ x: 22, y: 22 }, { x: 48, y: 22 }, { x: 48, y: 46 }, { x: 22, y: 46 }]
    },
    {
      id: 'u-902', code: 'Departamento 9-02 (Central)', buttonText: 'Dpto 9-02 · 125 m²', type: 'Departamento 2D',
      levelId: 'floor-9', targetLevelId: 'floor-9', transitionVideo: 'auto', floorNum: 1, floorLabel: 'Piso 9° · Ala Este',
      area: 125, beds: 2, baths: 2, kitchens: 1, price: 142000, orientation: 'Este · Boulevard', status: 'reserved', showAvailability: true, defaultRoom360: 'kitchen',
      customLines: [], customButtons: [],
      center: { x: 65, y: 34 },
      polygon: [{ x: 52, y: 22 }, { x: 78, y: 22 }, { x: 78, y: 46 }, { x: 52, y: 46 }]
    },
    {
      id: 'u-903', code: 'Departamento 9-03 (Sur)', buttonText: 'Dpto 9-03 · Vendido', type: 'Departamento 2D',
      levelId: 'floor-9', targetLevelId: 'floor-9', transitionVideo: 'auto', floorNum: 1, floorLabel: 'Piso 9° · Ala Sur',
      area: 118, beds: 2, baths: 2, kitchens: 1, price: 135000, orientation: 'Sur', status: 'sold', showAvailability: true, defaultRoom360: 'master',
      customLines: [], customButtons: [],
      center: { x: 50, y: 68 },
      polygon: [{ x: 30, y: 54 }, { x: 70, y: 54 }, { x: 70, y: 78 }, { x: 30, y: 78 }]
    }
  ],
  renderedViewsGallery: [
    { id: 'rv-1', title: 'Rooftop & Piscina Climatizada', url: './sample-assets/render-amenities.jpg', mediaKey: null },
    { id: 'rv-2', title: 'Planta 3D Amoblada Piso 9°', url: './sample-assets/floor-piso9-3d.jpg', mediaKey: null },
    { id: 'rv-3', title: 'Interior Living & Comedor Integrado', url: './sample-assets/render-interior-1.jpg', mediaKey: null },
    { id: 'rv-4', title: 'Fachada Nocturna Iluminada', url: './sample-assets/render-nocturno.jpg', mediaKey: null },
    { id: 'rv-5', title: 'Planta 3D Piso 35° Penthouse', url: './sample-assets/floor-piso35-3d.jpg', mediaKey: null },
    { id: 'rv-6', title: 'Azotea & Sky Deck Piso 36°', url: './sample-assets/floor-azotea-3d.jpg', mediaKey: null }
  ],
  rooms360: [
    {
      id: 'living', levelId: 'floor-9', name: 'Grand Living Obsidiana & Oro', subtitle: 'Doble altura · Ventanal Panorámico', themeColor: '#161410', customImageUrl: null, mediaKey: null,
      hotspots: [
        { arrow: 'floor-ring', lon: 35, lat: -14, targetRoomId: 'kitchen', label: 'Cocina Isla Gourmet' },
        { arrow: 'floor-ring', lon: -55, lat: -12, targetRoomId: 'master', label: 'Master Suite' },
        { arrow: 'floor-ring', lon: 145, lat: -15, targetRoomId: 'terrace', label: 'Galería & Terraza' }
      ]
    },
    {
      id: 'kitchen', levelId: 'floor-9', name: 'Cocina Isla Sahara Noir', subtitle: 'Cuarzo & Latón Cepillado', themeColor: '#1a1712', customImageUrl: null, mediaKey: null,
      hotspots: [
        { arrow: 'floor-ring', lon: -140, lat: -14, targetRoomId: 'living', label: 'Volver al Living' },
        { arrow: 'floor-ring', lon: 65, lat: -14, targetRoomId: 'terrace', label: 'Salir a Terraza' }
      ]
    },
    {
      id: 'master', levelId: 'floor-20', name: 'Dormitorio Master Suite', subtitle: 'Vestidor Walk-in & Balcón', themeColor: '#1c1614', customImageUrl: null, mediaKey: null,
      hotspots: [
        { arrow: 'floor-ring', lon: 120, lat: -14, targetRoomId: 'living', label: 'Volver al Living' },
        { arrow: 'floor-ring', lon: -20, lat: -12, targetRoomId: 'pool', label: 'Ir al Sky Pool' }
      ]
    },
    {
      id: 'terrace', levelId: 'floor-9', name: 'Galería & Wine Lounge', subtitle: 'Deck Cumarú & Parrillero', themeColor: '#151814', customImageUrl: null, mediaKey: null,
      hotspots: [
        { arrow: 'floor-ring', lon: -35, lat: -14, targetRoomId: 'living', label: 'Entrar al Living' },
        { arrow: 'floor-ring', lon: 25, lat: -12, targetRoomId: 'pool', label: 'Avanzar a Piscina' }
      ]
    },
    {
      id: 'pool', levelId: 'floor-35', name: 'Sky Pool & Rooftop', subtitle: 'Vista 360° de la Ciudad', themeColor: '#0e1920', customImageUrl: null, mediaKey: null,
      hotspots: [
        { arrow: 'floor-ring', lon: 180, lat: -12, targetRoomId: 'terrace', label: 'Volver a Galería' },
        { arrow: 'floor-ring', lon: 145, lat: -12, targetRoomId: 'master', label: 'Master Suite' }
      ]
    }
  ],
  activeRoom360Id: 'living',
  isPlacingHotspot360: false,
  pendingHotspotCoords: { lon: 0, lat: 0 },
  finishes: {
    activeTabId: 'tab-living',
    tabs: [
      {
        id: 'tab-living', name: '🛋️ Living & Comedor', leftId: 'f-liv-1', rightId: 'f-liv-2',
        items: [
          { id: 'f-liv-1', name: 'Obsidian Gold · Mármol Sahara Noir', url: './sample-assets/render-interior-1.jpg', mediaKey: null, palette: 'obsidian_gold' },
          { id: 'f-liv-2', name: 'Roble Natural & Cuarzo Calacatta', url: './sample-assets/render-amenities.jpg', mediaKey: null, palette: 'nordic' },
          { id: 'f-liv-3', name: 'Porcelanato Gris & Hormigón', url: './sample-assets/render-nocturno.jpg', mediaKey: null, palette: 'minimal' }
        ]
      },
      {
        id: 'tab-kitchen', name: '🍳 Cocina', leftId: 'f-kit-1', rightId: 'f-kit-2',
        items: [
          { id: 'f-kit-1', name: 'Isla Mármol Negro & Latón', url: null, mediaKey: null, palette: 'obsidian_gold' },
          { id: 'f-kit-2', name: 'Cuarzo Blanco & Madera Clara', url: null, mediaKey: null, palette: 'nordic' }
        ]
      },
      {
        id: 'tab-bath', name: '🛁 Baños', leftId: 'f-bth-1', rightId: 'f-bth-2',
        items: [
          { id: 'f-bth-1', name: 'Piedra Sinterizada & Grifería Dorada', url: null, mediaKey: null, palette: 'obsidian_gold' },
          { id: 'f-bth-2', name: 'Travertino Mate & Negro Mate', url: null, mediaKey: null, palette: 'minimal' }
        ]
      },
      {
        id: 'tab-bedroom', name: '🛏️ Dormitorios', leftId: 'f-bed-1', rightId: 'f-bed-2',
        items: [
          { id: 'f-bed-1', name: 'Nogal Americano & Lino Arena', url: null, mediaKey: null, palette: 'nordic' },
          { id: 'f-bed-2', name: 'Suite Obsidiana & Iluminación LED', url: null, mediaKey: null, palette: 'obsidian_gold' }
        ]
      }
    ]
  },
  location: {
    lat: -17.783327,
    lng: -63.182140,
    zoom: 15,
    placeName: 'Equipetrol · Santa Cruz',
    pois: [
      { id: 'poi-1', name: 'Ventura Mall', icon: '🛍️', color: '#d4af37', note: '3 min · 850 m', lat: -17.7544, lng: -63.1996 },
      { id: 'poi-2', name: 'Parque Urbano Central', icon: '🌳', color: '#22c55e', note: '5 min · 1.4 km', lat: -17.7918, lng: -63.1730 },
      { id: 'poi-3', name: 'Clínica Foianini', icon: '🏥', color: '#38bdf8', note: '4 min · 1.1 km', lat: -17.7785, lng: -63.1892 }
    ]
  },
  customModel3D: { name: null, ext: null, mediaKey: null, mtlMediaKey: null }
};

let state = structuredClone(defaultState);

function isEditor() {
  return !isPublishedRuntime() && portalState.auth?.mode === 'editor';
}

function createFreshProjectState(meta) {
  const s = structuredClone(defaultState);
  s.project.code = meta.code;
  s.project.accessCode = meta.accessCode || '';
  s.project.accessCodeHash = meta.accessCodeHash || null;
  s.project.requiresCode = Boolean(meta.requiresCode);
  s.project.shortName = 'SALO SHOWROOM';
  s.project.buildingName = meta.buildingName || 'Nuevo Edificio';
  s.project.fullTitle = `SALO SHOWROOM · ${s.project.buildingName}`;
  s.project.subtitle = meta.subtitle || 'Showroom Interactivo 3D · Panorámica · Plantas';
  s.project.whatsappPhone = meta.whatsappPhone || '59173080076';
  if (meta.coverUrl) {
    s.exteriorAngles[0].photo = meta.coverUrl;
    s.exteriorAngles[0].mediaKey = meta.coverMediaKey || null;
    if (meta.coverMediaKey || !String(meta.coverUrl).startsWith('./sample-assets/')) {
      s.exteriorAngles[0].nightPhoto = null;
      s.exteriorAngles[0].nightMediaKey = null;
    }
    const fac = s.levels.find((l) => l.id === 'facade');
    if (fac) {
      fac.dayPhoto = meta.coverUrl;
      fac.dayMediaKey = meta.coverMediaKey || null;
      if (meta.coverMediaKey || !String(meta.coverUrl).startsWith('./sample-assets/')) {
        fac.nightPhoto = null;
        fac.nightMediaKey = null;
      }
    }
  }
  s.auth = portalState.auth;
  return s;
}

function loadPortalState() {
  try {
    const raw = localStorage.getItem(PORTAL_STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      if (saved.auth) {
        portalState.auth = { ...portalState.auth, ...saved.auth };
        if (!Array.isArray(portalState.auth.editors) || portalState.auth.editors.length === 0) {
          portalState.auth.editors = structuredClone(defaultPortalState.auth.editors);
        }
      }
      if (Array.isArray(saved.projects) && saved.projects.length > 0) {
        portalState.projects = normalizeSampleAssetPathsDeep(saved.projects).map((p) => {
          const ac = normalizeAccessCode(p.accessCode || '');
          return {
            ...p,
            accessCode: ac,
            accessCodeHash: p.accessCodeHash || null,
            requiresCode: p.requiresCode !== undefined ? Boolean(p.requiresCode && (p.accessCodeHash || ac)) : Boolean(ac)
          };
        });
      }
      if (Array.isArray(saved.examplePhotos) && saved.examplePhotos.length > 0) portalState.examplePhotos = normalizeSampleAssetPathsDeep(saved.examplePhotos);
      if (saved.activeProjectCode) portalState.activeProjectCode = saved.activeProjectCode;
    }
  } catch (_) {}

  const params = new URLSearchParams(window.location.search);
  if (params.get('mode') === 'public' || params.get('view') === 'public') portalState.auth.mode = 'public';
  state.auth = portalState.auth;
}

function savePortalState() {
  if (isPublishedRuntime()) return;
  try {
    const cleanProjects = portalState.projects.map((p) => ({
      ...p,
      coverUrl: (p.coverUrl && p.coverUrl.startsWith('blob:')) ? './sample-assets/exterior-tower.webp' : p.coverUrl
    }));
    const cleanExamples = portalState.examplePhotos.map((ex) => {
      if (ex && ex.type === 'folder') {
        return {
          ...ex,
          coverUrl: (ex.coverUrl && ex.coverUrl.startsWith('blob:')) ? './sample-assets/exterior-tower.webp' : ex.coverUrl,
          items: (ex.items || []).map((it) => ({
            ...it,
            url: (it.url && it.url.startsWith('blob:')) ? './sample-assets/exterior-tower.webp' : it.url
          }))
        };
      }
      return {
        ...ex,
        url: (ex.url && ex.url.startsWith('blob:')) ? './sample-assets/exterior-tower.webp' : ex.url
      };
    });
    localStorage.setItem(PORTAL_STORAGE_KEY, JSON.stringify({
      activeProjectCode: portalState.activeProjectCode,
      auth: portalState.auth,
      projects: cleanProjects,
      examplePhotos: cleanExamples
    }));
  } catch (_) {}
}

function applyLoadedProjectData(rawSaved, code, meta) {
  if (!rawSaved) return;
  const saved = normalizeSampleAssetPathsDeep(rawSaved);
  if (saved.project) state.project = { ...state.project, ...saved.project };
  if (!state.project.buildingName) state.project.buildingName = meta?.buildingName || 'Torre Pocito 3D';
  state.project.code = code;
  state.project.shortName = 'SALO SHOWROOM';
  if (!['pos-above-exterior', 'pos-bottom-right'].includes(state.project.logoPosition)) {
    state.project.logoPosition = 'pos-above-exterior';
  }
  if (saved.intro) state.intro = { ...state.intro, ...saved.intro };
  if (saved.unitsConfig) state.unitsConfig = { ...state.unitsConfig, ...saved.unitsConfig };
  if (saved.model3dConfig) state.model3dConfig = { ...state.model3dConfig, ...saved.model3dConfig };
  if (saved.avance) state.avance = { ...state.avance, ...saved.avance };
  if (Array.isArray(saved.exteriorAngles) && saved.exteriorAngles.length > 0) state.exteriorAngles = saved.exteriorAngles;
  if (Array.isArray(saved.levels) && saved.levels.length > 0) state.levels = saved.levels;
  if (Array.isArray(saved.units) && saved.units.length > 0) state.units = saved.units;
  if (saved.visibleFields) state.visibleFields = { ...state.visibleFields, ...saved.visibleFields };
  if (saved.imageAdjustments) state.imageAdjustments = { ...state.imageAdjustments, ...saved.imageAdjustments };
  if (saved.transitions && Array.isArray(saved.transitions.slots)) state.transitions = saved.transitions;
  if (Array.isArray(saved.renderedViewsGallery) && saved.renderedViewsGallery.length > 0) state.renderedViewsGallery = saved.renderedViewsGallery;
  if (Array.isArray(saved.rooms360) && saved.rooms360.length > 0) state.rooms360 = saved.rooms360;
  if (saved.finishes && Array.isArray(saved.finishes.tabs) && saved.finishes.tabs.length > 0) state.finishes = saved.finishes;
  if (saved.location) state.location = { ...state.location, ...saved.location };
  if (saved.customModel3D) state.customModel3D = { ...state.customModel3D, ...saved.customModel3D };
  if (Array.isArray(saved.cameras3D) && saved.cameras3D.length > 0) state.cameras3D = saved.cameras3D;
  if (Array.isArray(saved.floors3D) && saved.floors3D.length > 0) state.floors3D = saved.floors3D;
}

function getRawProjectStateForPublish(projectCode) {
  const code = String(projectCode || 'SALO-001').toUpperCase();
  if ((state.project?.code || '').toUpperCase() === code && portalState.activeScreen === 'showroom') {
    savePersistedState();
  }
  const meta = portalState.projects.find((p) => p.code.toUpperCase() === code);
  const fresh = createFreshProjectState(meta || { code, buildingName: 'Proyecto SALO' });
  try {
    const raw = localStorage.getItem(getProjectStorageKey(code));
    if (!raw) return fresh;
    const saved = JSON.parse(raw);
    return { ...fresh, ...saved, project: { ...fresh.project, ...(saved.project || {}), code } };
  } catch (_) {
    return fresh;
  }
}

function loadPersistedState(projectCode = null) {
  const code = (projectCode || portalState.activeProjectCode || 'SALO-001').toUpperCase();
  portalState.activeProjectCode = code;
  const meta = portalState.projects.find((p) => p.code.toUpperCase() === code) || portalState.projects[0];
  state = createFreshProjectState(meta || { code, buildingName: 'Torre Pocito 3D' });

  try {
    const raw = localStorage.getItem(getProjectStorageKey(code));
    if (raw) applyLoadedProjectData(JSON.parse(raw), code, meta);
  } catch (_) {}

  state.auth = portalState.auth;
}

function savePersistedState() {
  if (isPublishedRuntime()) return;
  try {
    const code = (state.project.code || portalState.activeProjectCode || 'SALO-001').toUpperCase();
    // Keep portal metadata in sync with current project edits
    const meta = portalState.projects.find((p) => p.code.toUpperCase() === code);
    if (meta) {
      meta.buildingName = state.project.buildingName || meta.buildingName;
      meta.subtitle = state.project.subtitle || meta.subtitle;
      const mainExt = state.exteriorAngles[0];
      if (mainExt?.photo) {
        meta.coverUrl = mainExt.photo;
        meta.coverMediaKey = mainExt.mediaKey || null;
      }
    }
    savePortalState();

    const cleanProject = {
      ...state.project,
      shortName: 'SALO SHOWROOM',
      logoUrl: (state.project.logoUrl && state.project.logoUrl.startsWith('blob:')) ? null : state.project.logoUrl
    };
    const cleanAngles = state.exteriorAngles.map((a) => ({
      ...a,
      photo: (a.photo && a.photo.startsWith('blob:')) ? './sample-assets/exterior-tower.webp' : a.photo,
      nightPhoto: (a.nightPhoto && a.nightPhoto.startsWith('blob:')) ? null : (a.nightPhoto ?? null)
    }));
    const cleanLevels = state.levels.map((l) => ({
      ...l,
      dayPhoto: (l.dayPhoto && l.dayPhoto.startsWith('blob:')) ? './sample-assets/floor-piso9-3d.jpg' : l.dayPhoto,
      nightPhoto: (l.nightPhoto && l.nightPhoto.startsWith('blob:')) ? null : (l.nightPhoto ?? null),
      plan2DPhoto: (l.plan2DPhoto && l.plan2DPhoto.startsWith('blob:')) ? './sample-assets/floor-piso9-plan.webp' : l.plan2DPhoto,
      transImg1: (l.transImg1 && l.transImg1.startsWith('blob:')) ? null : l.transImg1,
      transImg2: (l.transImg2 && l.transImg2.startsWith('blob:')) ? null : l.transImg2
    }));
    const cleanUnits = state.units.map((u) => ({
      ...u,
      customButtons: (u.customButtons || []).map((cb) => ({
        ...cb,
        photoUrl: (cb.photoUrl && cb.photoUrl.startsWith('blob:')) ? null : cb.photoUrl,
        nightPhotoUrl: (cb.nightPhotoUrl && cb.nightPhotoUrl.startsWith('blob:')) ? null : (cb.nightPhotoUrl ?? null)
      }))
    }));
    const cleanTransitions = {
      globalEnabled: state.transitions.globalEnabled,
      slots: (state.transitions.slots || []).map((sl) => ({
        ...sl,
        img1Url: (sl.img1Url && sl.img1Url.startsWith('blob:')) ? null : sl.img1Url,
        img2Url: (sl.img2Url && sl.img2Url.startsWith('blob:')) ? null : sl.img2Url
      }))
    };
    const cleanGallery = state.renderedViewsGallery.map((g) => ({
      ...g,
      url: (g.url && g.url.startsWith('blob:')) ? '' : g.url,
      nightUrl: (g.nightUrl && g.nightUrl.startsWith('blob:')) ? null : (g.nightUrl ?? null)
    }));
    const cleanRooms = state.rooms360.map((r) => ({
      ...r,
      customImageUrl: (r.customImageUrl && r.customImageUrl.startsWith('blob:')) ? null : r.customImageUrl,
      customNightImageUrl: (r.customNightImageUrl && r.customNightImageUrl.startsWith('blob:')) ? null : (r.customNightImageUrl ?? null)
    }));
    const cleanFinishes = {
      activeTabId: state.finishes.activeTabId,
      tabs: state.finishes.tabs.map((t) => ({
        ...t,
        items: t.items.map((it) => ({ ...it, url: (it.url && it.url.startsWith('blob:')) ? null : it.url }))
      }))
    };

    localStorage.setItem(getProjectStorageKey(code), JSON.stringify({
      project: cleanProject,
      intro: state.intro,
      unitsConfig: state.unitsConfig,
      model3dConfig: state.model3dConfig,
      avance: state.avance,
      exteriorAngles: cleanAngles,
      levels: cleanLevels,
      units: cleanUnits,
      visibleFields: state.visibleFields,
      imageAdjustments: state.imageAdjustments,
      transitions: cleanTransitions,
      renderedViewsGallery: cleanGallery,
      rooms360: cleanRooms,
      finishes: cleanFinishes,
      location: state.location,
      customModel3D: state.customModel3D,
      cameras3D: state.cameras3D,
      floors3D: state.floors3D
    }));
  } catch (_) {}
}

async function hydratePortalMediaFromIndexedDB() {
  for (const proj of portalState.projects) {
    if (proj.coverMediaKey) {
      const u = await getMediaUrl(proj.coverMediaKey);
      if (u) proj.coverUrl = u;
    }
  }
  for (const ex of portalState.examplePhotos) {
    if (ex && ex.type === 'folder') {
      if (ex.coverMediaKey) {
        const cu = await getMediaUrl(ex.coverMediaKey);
        if (cu) ex.coverUrl = cu;
      }
      for (const it of (ex.items || [])) {
        if (it?.mediaKey) {
          const iu = await getMediaUrl(it.mediaKey);
          if (iu) it.url = iu;
        }
      }
    } else if (ex?.mediaKey) {
      const u = await getMediaUrl(ex.mediaKey);
      if (u) ex.url = u;
    }
  }
}

async function hydrateMediaFromIndexedDB() {
  if (state.project.logoMediaKey) {
    const u = await getMediaUrl(state.project.logoMediaKey);
    if (u) state.project.logoUrl = u;
  }
  if (state.intro.mediaKey) await getMediaUrl(state.intro.mediaKey);
  for (const ang of state.exteriorAngles) {
    if (ang.mediaKey) { const u = await getMediaUrl(ang.mediaKey); if (u) ang.photo = u; }
    if (ang.nightMediaKey) { const u = await getMediaUrl(ang.nightMediaKey); if (u) ang.nightPhoto = u; }
  }
  for (const lvl of state.levels) {
    if (lvl.dayMediaKey) { const u = await getMediaUrl(lvl.dayMediaKey); if (u) lvl.dayPhoto = u; }
    if (lvl.nightMediaKey) { const u = await getMediaUrl(lvl.nightMediaKey); if (u) lvl.nightPhoto = u; }
    if (lvl.plan2DMediaKey) { const u = await getMediaUrl(lvl.plan2DMediaKey); if (u) lvl.plan2DPhoto = u; }
    if (lvl.transitionMediaKey) await getMediaUrl(lvl.transitionMediaKey);
    if (lvl.transImg1Key) { const u = await getMediaUrl(lvl.transImg1Key); if (u) lvl.transImg1 = u; }
    if (lvl.transImg2Key) { const u = await getMediaUrl(lvl.transImg2Key); if (u) lvl.transImg2 = u; }
  }
  for (const u of state.units) {
    for (const cb of (u.customButtons || [])) {
      if (cb.photoMediaKey) { const url = await getMediaUrl(cb.photoMediaKey); if (url) cb.photoUrl = url; }
      if (cb.nightPhotoMediaKey) { const nu = await getMediaUrl(cb.nightPhotoMediaKey); if (nu) cb.nightPhotoUrl = nu; }
    }
  }
  for (const rv of state.renderedViewsGallery) {
    if (rv.mediaKey) { const u = await getMediaUrl(rv.mediaKey); if (u) rv.url = u; }
    if (rv.nightMediaKey) { const nu = await getMediaUrl(rv.nightMediaKey); if (nu) rv.nightUrl = nu; }
  }
  for (const room of state.rooms360) {
    if (room.mediaKey) { const u = await getMediaUrl(room.mediaKey); if (u) room.customImageUrl = u; }
    if (room.nightMediaKey) { const nu = await getMediaUrl(room.nightMediaKey); if (nu) room.customNightImageUrl = nu; }
  }
  for (const tab of state.finishes.tabs) {
    for (const item of tab.items) {
      if (item.mediaKey) { const u = await getMediaUrl(item.mediaKey); if (u) item.url = u; }
    }
  }
  for (const slot of (state.transitions.slots || [])) {
    if (slot.mediaKey) await getMediaUrl(slot.mediaKey);
    if (slot.img1Key) { const u = await getMediaUrl(slot.img1Key); if (u) slot.img1Url = u; }
    if (slot.img2Key) { const u = await getMediaUrl(slot.img2Key); if (u) slot.img2Url = u; }
  }
  if (state.customModel3D?.mediaKey && state.customModel3D?.ext) {
    const blob = await getMediaBlob(state.customModel3D.mediaKey);
    const mtlBlob = state.customModel3D.mtlMediaKey ? await getMediaBlob(state.customModel3D.mtlMediaKey) : null;
    if (blob) {
      const files = [new File([blob], state.customModel3D.name || `modelo.${state.customModel3D.ext}`)];
      if (mtlBlob) files.push(new File([mtlBlob], 'materials.mtl'));
      await loadCustom3DModelFiles(files, false);
    } else if (state.customModel3D.url) {
      await mountModel3DFromUrl(state.customModel3D.url, state.customModel3D.name || `modelo.${state.customModel3D.ext}`, false, state.customModel3D.mtlUrl || null);
    }
  } else if (state.customModel3D?.url && state.customModel3D?.ext) {
    await mountModel3DFromUrl(state.customModel3D.url, state.customModel3D.name || `modelo.${state.customModel3D.ext}`, false, state.customModel3D.mtlUrl || null);
  }
}

/* ==========================================================================
   0B. SALO MULTI-PROJECT PORTAL HUB ENGINE
   ========================================================================== */
function showScreen(screenName) {
  portalState.activeScreen = screenName === 'showroom' ? 'showroom' : 'portal';
  document.body.dataset.screen = portalState.activeScreen;
  if (portalState.activeScreen === 'portal') {
    renderPortalProjects();
    renderPortalExamples();
    syncPortalEditorTabUI();
    document.title = 'SALO SHOWROOM · Cálculo y Diseño · Portal Interactivo 3D / 360°';
  } else {
    syncProjectBrandingUI();
    if (state.activeView === 'tour360' && tour360.renderer) {
      const c = document.getElementById('tour360-container');
      tour360.camera.aspect = (c.clientWidth || window.innerWidth) / (c.clientHeight || window.innerHeight);
      tour360.camera.updateProjectionMatrix();
      tour360.renderer.setSize(c.clientWidth || window.innerWidth, c.clientHeight || window.innerHeight);
    }
    if (state.activeView === 'model3d' && model3d.renderer) {
      const c = document.getElementById('model3d-canvas-container');
      model3d.camera.aspect = (c.clientWidth || window.innerWidth) / (c.clientHeight || window.innerHeight);
      model3d.camera.updateProjectionMatrix();
      model3d.renderer.setSize(c.clientWidth || window.innerWidth, c.clientHeight || window.innerHeight);
    }
  }
}

function switchPortalTab(tabName) {
  portalState.activePortalTab = tabName;
  document.querySelectorAll('[data-portal-tab]').forEach((b) => b.classList.toggle('active', b.dataset.portalTab === tabName));
  ['projects', 'examples', 'about', 'editors'].forEach((t) => {
    const sec = document.getElementById(`portal-sec-${t}`);
    if (sec) sec.style.display = t === tabName ? 'flex' : 'none';
  });
  if (tabName === 'editors') syncPortalEditorTabUI();
  if (tabName === 'examples') renderPortalExamples();
}

function syncPortalEditorTabUI() {
  const loginBox = document.getElementById('portal-editor-login-box');
  const signedBox = document.getElementById('portal-editor-signed-in');
  const nameEl = document.getElementById('portal-active-editor-name');
  if (!loginBox || !signedBox) return;
  if (isEditor()) {
    loginBox.style.display = 'none';
    signedBox.style.display = 'flex';
    if (nameEl) nameEl.textContent = portalState.auth.currentUser || 'admin';
  } else {
    loginBox.style.display = 'flex';
    signedBox.style.display = 'none';
  }
}

let pendingGateProject = null;

function openProjectCodeGate(projMeta, forceRole = null) {
  const modal = document.getElementById('modal-project-code-gate');
  if (!modal || !projMeta) return;
  pendingGateProject = { projMeta, forceRole };
  const bEl = document.getElementById('gate-code-building');
  const inp = document.getElementById('gate-code-input');
  const errEl = document.getElementById('gate-code-error');
  if (bEl) bEl.textContent = projMeta.buildingName || 'este proyecto';
  if (errEl) errEl.style.display = 'none';
  if (inp) {
    inp.value = '';
    setTimeout(() => inp.focus(), 60);
  }
  modal.classList.add('open');
}

async function verifyAndSubmitCodeGate() {
  if (!pendingGateProject?.projMeta) return;
  const { projMeta, forceRole } = pendingGateProject;
  const inp = document.getElementById('gate-code-input');
  const errEl = document.getElementById('gate-code-error');
  const raw = inp?.value || '';
  const norm = normalizeAccessCode(raw);
  const typedHash = await hashAccessCode(norm);

  const matchesHash = Boolean(typedHash && projMeta.accessCodeHash && typedHash === String(projMeta.accessCodeHash).toLowerCase());
  const matchesPlainLocal = Boolean(!isPublishedRuntime() && norm && projMeta.accessCode && normalizeAccessCode(projMeta.accessCode) === norm);

  if (!matchesHash && !matchesPlainLocal) {
    if (errEl) errEl.style.display = 'block';
    return;
  }

  if (errEl) errEl.style.display = 'none';
  document.getElementById('modal-project-code-gate')?.classList.remove('open');
  pendingGateProject = null;
  await openProjectByCode(projMeta.code, forceRole);
}

async function requestProjectAccessAndOpen(projMeta, forceRole = null) {
  if (!projMeta) return false;
  const effectivePublic = isPublishedRuntime() || forceRole === 'public' || !isEditor();
  const mustGate = Boolean(projMeta.requiresCode) && effectivePublic;
  if (!mustGate) {
    return openProjectByCode(projMeta.code, forceRole);
  }
  openProjectCodeGate(projMeta, forceRole);
  return false;
}

async function openProjectBySecretPortalInput(rawInput) {
  const errEl = document.getElementById('portal-code-error');
  const norm = normalizeAccessCode(rawInput);
  if (!norm) {
    if (errEl) errEl.style.display = 'block';
    return false;
  }
  const inputHash = await hashAccessCode(norm);
  let match = portalState.projects.find((p) => {
    if (!p.requiresCode) return false;
    if (inputHash && p.accessCodeHash && String(p.accessCodeHash).toLowerCase() === inputHash) return true;
    return !isPublishedRuntime() && p.accessCode && normalizeAccessCode(p.accessCode) === norm;
  });
  if (!match && isEditor()) {
    match = portalState.projects.find((p) => String(p.code || '').toUpperCase() === norm);
  }
  if (!match) {
    if (errEl) errEl.style.display = 'block';
    showToast('Código incorrecto o proyecto no encontrado');
    return false;
  }
  if (errEl) errEl.style.display = 'none';
  return openProjectByCode(match.code);
}

function renderPortalProjects() {
  const grid = document.getElementById('portal-projects-grid');
  const countBadge = document.getElementById('portal-projects-count');
  if (!grid) return;
  const query = (document.getElementById('portal-search-input')?.value || '').trim().toLowerCase();
  const editorMode = isEditor();

  const filtered = portalState.projects.filter((p) => {
    if (!query) return true;
    const baseMatch = (p.buildingName || '').toLowerCase().includes(query)
      || (p.subtitle || '').toLowerCase().includes(query);
    if (!editorMode) return baseMatch;
    return baseMatch
      || (p.code || '').toLowerCase().includes(query)
      || (p.accessCode || '').toLowerCase().includes(query);
  });

  if (countBadge) countBadge.textContent = `${filtered.length} ${filtered.length === 1 ? 'Proyecto' : 'Proyectos'}`;
  grid.innerHTML = '';

  if (filtered.length === 0) {
    grid.innerHTML = `<div style="grid-column:1/-1;text-align:center;padding:30px;color:var(--ink-silver);border:1px dashed var(--gold-border);border-radius:14px;">No se encontraron proyectos con "${escapeHtml(query)}".</div>`;
    return;
  }

  filtered.forEach((proj) => {
    const isPublished = proj.published !== false;
    const isLocked = Boolean(proj.requiresCode);
    const pillText = editorMode
      ? (isLocked ? `🔑 ${proj.accessCode || 'Protegido'} (${proj.code})` : `🔓 Demo abierto (${proj.code})`)
      : (isLocked ? '🔒 Con código' : '🔓 Demo abierto');
    const safeCode = escapeHtml(proj.code);
    const safeName = escapeHtml(proj.buildingName);
    const safeSub = escapeHtml(proj.subtitle || 'Showroom Interactivo 3D · Panorámica · Plantas');
    const safeCover = escapeHtml(proj.coverUrl || './sample-assets/exterior-tower.webp');

    const card = document.createElement('article');
    card.className = 'portal-project-card';
    card.innerHTML = `
      <div class="portal-project-cover">
        <img src="${safeCover}" alt="${safeName}" />
        <span class="portal-project-code-pill">${escapeHtml(pillText)}</span>
        ${editorMode ? `<span class="portal-pub-badge ${isPublished ? 'pub' : 'draft'}">${isPublished ? '🟢 PUBLICADO' : '📝 BORRADOR (PC)'}</span>` : ''}
      </div>
      <div class="portal-project-body">
        <div>
          <span style="font-size:9.5px;color:var(--gold-bright);letter-spacing:1.2px;font-weight:700;">SALO SHOWROOM</span>
          <h4 style="font-family:var(--font-display);font-size:17px;color:var(--ink-white);margin-top:2px;">${safeName}</h4>
          <p style="font-size:11px;color:var(--ink-silver);margin-top:3px;">${safeSub}</p>
        </div>
        <div style="margin-top:auto;display:flex;gap:6px;flex-wrap:wrap;">
          <button class="action-btn gold-cta" data-open-proj="${safeCode}" style="flex:1;grid-column:auto;padding:8px 10px;">
            ${editorMode ? '✏️ Abrir / Editar' : (isLocked ? '🔒 Ver Showroom' : '👁️ Ver Showroom')}
          </button>
          ${editorMode ? `<button class="action-btn" data-toggle-pub="${safeCode}" title="${isPublished ? 'Pasar a Borrador (no sale en la web pública)' : 'Marcar listo para publicar'}" style="padding:8px 9px;font-size:10.5px;">${isPublished ? '🟢' : '📝'}</button>` : ''}
          <button class="action-btn" data-copy-proj="${safeCode}" title="Copiar enlace del proyecto" style="padding:8px 10px;">🔗</button>
          ${(editorMode && portalState.projects.length > 1) ? `<button class="action-btn" data-del-proj="${safeCode}" title="Eliminar proyecto" style="padding:8px 10px;color:#f87171;border-color:rgba(239,68,68,0.4);">🗑️</button>` : ''}
        </div>
      </div>
    `;
    card.querySelector('[data-open-proj]').addEventListener('click', () => requestProjectAccessAndOpen(proj));
    const pubBtn = card.querySelector('[data-toggle-pub]');
    if (pubBtn) {
      pubBtn.addEventListener('click', () => {
        proj.published = !(proj.published !== false);
        savePortalState();
        renderPortalProjects();
        showToast(proj.published ? `🟢 "${proj.buildingName}" se incluirá al publicar` : `📝 "${proj.buildingName}" quedó en Borrador (solo PC)`);
      });
    }
    card.querySelector('[data-copy-proj]').addEventListener('click', () => {
      const link = `${window.location.origin}${window.location.pathname}?project=${encodeURIComponent(proj.code)}&mode=public`;
      navigator.clipboard?.writeText(link).catch(() => {});
      showToast('🔗 Enlace público del proyecto copiado');
    });
    const delBtn = card.querySelector('[data-del-proj]');
    if (delBtn) {
      delBtn.addEventListener('click', () => deleteProjectFromPortal(proj.code));
    }
    grid.appendChild(card);
  });
}

let activePortfolioFolderId = null;

function renderPortalExamplesDemos() {
  const sec = document.getElementById('portal-examples-demos-section');
  const grid = document.getElementById('portal-examples-demos-grid');
  if (!sec || !grid) return;

  const editorMode = isEditor();
  const demos = (portalState.projects || []).filter((p) => {
    if (!p) return false;
    if (!editorMode && p.published === false) return false;
    return !p.requiresCode;
  });

  if (demos.length === 0) {
    sec.style.display = 'none';
    grid.innerHTML = '';
    return;
  }

  sec.style.display = 'flex';
  grid.innerHTML = '';
  demos.forEach((proj) => {
    const card = document.createElement('div');
    card.className = 'portal-project-card';
    card.innerHTML = `
      <div class="portal-project-cover">
        <img src="${proj.coverUrl || './sample-assets/exterior-tower.webp'}" alt="${escapeHtml(proj.buildingName)}" />
        <span class="portal-code-badge" style="color:#4ade80;border-color:rgba(74,222,128,0.5);">✨ DEMO ABIERTO</span>
      </div>
      <div class="portal-project-body">
        <h4 class="portal-project-title">${escapeHtml(proj.buildingName || 'Proyecto Demo')}</h4>
        <p class="portal-project-sub">${escapeHtml(proj.subtitle || 'Showroom Interactivo SALO')}</p>
        <div class="portal-project-actions">
          <button type="button" class="action-btn gold-cta" data-open-demo-proj="${escapeHtml(proj.code)}" style="flex:1;grid-column:auto;">🚀 Abrir Demo</button>
        </div>
      </div>
    `;
    card.querySelector('[data-open-demo-proj]')?.addEventListener('click', () => {
      requestProjectAccessAndOpen(proj);
    });
    card.querySelector('.portal-project-cover')?.addEventListener('click', () => {
      requestProjectAccessAndOpen(proj);
    });
    grid.appendChild(card);
  });
}

function openPortfolioFolderCreateModal() {
  if (!isEditor()) { showToast('Solo cuentas de Editor pueden crear carpetas'); return; }
  const titleEl = document.getElementById('pf-create-title');
  const coverEl = document.getElementById('pf-create-cover');
  const photosEl = document.getElementById('pf-create-photos');
  if (titleEl) titleEl.value = '';
  if (coverEl) coverEl.value = '';
  if (photosEl) photosEl.value = '';
  document.getElementById('modal-portfolio-folder-create')?.classList.add('open');
}

async function confirmCreatePortfolioFolder() {
  if (!isEditor()) return;
  const title = (document.getElementById('pf-create-title')?.value || '').trim();
  if (!title) { showToast('Escribe un nombre para la carpeta'); return; }
  const coverFile = document.getElementById('pf-create-cover')?.files?.[0] || null;
  const photoFiles = Array.from(document.getElementById('pf-create-photos')?.files || []);

  const folderId = `fld-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  let coverUrl = './sample-assets/exterior-tower.webp';
  let coverMediaKey = null;
  if (coverFile) {
    coverMediaKey = `portal-folder-cover-${folderId}`;
    coverUrl = await saveMediaBlob(coverMediaKey, coverFile);
  }

  const items = [];
  for (const file of photoFiles) {
    const itemId = `it-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const mediaKey = `portal-folder-item-${folderId}-${itemId}`;
    const url = await saveMediaBlob(mediaKey, file);
    items.push({ id: itemId, title: file.name.replace(/\.[^.]+$/, ''), url, mediaKey });
  }
  if (!coverFile && items[0]) {
    coverUrl = items[0].url;
    coverMediaKey = items[0].mediaKey;
  }

  portalState.examplePhotos.unshift({
    id: folderId,
    type: 'folder',
    title,
    coverUrl,
    coverMediaKey,
    items
  });
  savePortalState();
  renderPortalExamples();
  document.getElementById('modal-portfolio-folder-create')?.classList.remove('open');
  showToast(`Carpeta "${title}" creada (${items.length} fotos)`);
}

function openPortfolioFolderViewer(folderId) {
  const folder = portalState.examplePhotos.find((x) => x && x.id === folderId && x.type === 'folder');
  if (!folder) return;
  activePortfolioFolderId = folder.id;
  const titleEl = document.getElementById('pf-viewer-title');
  const grid = document.getElementById('pf-viewer-grid');
  if (titleEl) titleEl.textContent = folder.title || 'Carpeta de Proyecto';
  if (!grid) return;

  grid.innerHTML = '';
  const items = folder.items || [];
  if (items.length === 0) {
    grid.innerHTML = `<div style="grid-column:1/-1;padding:24px;text-align:center;color:var(--ink-silver);font-size:12px;">Esta carpeta aún no tiene fotos. ${isEditor() ? 'Usa "➕ Añadir Fotos" arriba.' : ''}</div>`;
  } else {
    items.forEach((it, iIdx) => {
      const card = document.createElement('div');
      card.className = 'portfolio-folder-item';
      card.innerHTML = `
        <img src="${it.url}" alt="${escapeHtml(it.title || 'Foto')}" />
        <div class="portfolio-folder-item-cap">
          <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(it.title || 'Vista')}</span>
          ${isEditor() ? `
            <div class="portal-example-actions">
              <button class="icon-btn" data-pf-rename-item="${iIdx}" title="Renombrar foto" style="width:22px;height:22px;">✏️</button>
              <button class="icon-btn" data-pf-del-item="${iIdx}" title="Eliminar foto" style="width:22px;height:22px;color:#f87171;">✕</button>
            </div>
          ` : ''}
        </div>
      `;
      card.addEventListener('click', (e) => {
        if (e.target.closest('[data-pf-rename-item], [data-pf-del-item]')) return;
        openPhotoLightbox(it.url, `${folder.title} · ${it.title || 'Vista'}`);
      });
      card.querySelector('[data-pf-rename-item]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        const nextName = window.prompt('Nuevo nombre para esta foto:', it.title || '');
        if (!nextName || !nextName.trim()) return;
        it.title = nextName.trim();
        savePortalState();
        openPortfolioFolderViewer(folder.id);
        showToast('Nombre de foto actualizado');
      });
      card.querySelector('[data-pf-del-item]')?.addEventListener('click', (e) => {
        e.stopPropagation();
        folder.items.splice(iIdx, 1);
        savePortalState();
        renderPortalExamples();
        openPortfolioFolderViewer(folder.id);
        showToast('Foto eliminada de la carpeta');
      });
      grid.appendChild(card);
    });
  }
  document.getElementById('modal-portfolio-folder-viewer')?.classList.add('open');
}

function renderPortalExamples() {
  renderPortalExamplesDemos();
  const grids = [document.getElementById('portal-examples-grid'), document.getElementById('portal-examples-full-grid')].filter(Boolean);
  grids.forEach((grid) => {
    grid.innerHTML = '';
    portalState.examplePhotos.forEach((ex, idx) => {
      const isFolder = ex && ex.type === 'folder';
      const thumbUrl = isFolder ? (ex.coverUrl || ex.items?.[0]?.url || './sample-assets/exterior-tower.webp') : ex.url;
      const card = document.createElement('div');
      card.className = `portal-example-card ${isFolder ? 'is-folder' : ''}`;
      card.innerHTML = `
        ${isFolder ? `<span class="portal-folder-badge">📁 ${(ex.items || []).length} fotos</span>` : ''}
        <img src="${thumbUrl}" alt="${escapeHtml(ex.title || '')}" />
        <div class="portal-example-caption">
          <span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${isFolder ? '📁 ' : ''}${escapeHtml(ex.title || 'Sin título')}</span>
          ${isEditor() ? `
            <div class="portal-example-actions">
              <button class="icon-btn" data-rename-ex="${idx}" title="Renombrar" style="width:22px;height:22px;">✏️</button>
              <button class="icon-btn" data-del-ex="${idx}" title="${isFolder ? 'Eliminar carpeta' : 'Eliminar foto'}" style="width:22px;height:22px;color:#f87171;">✕</button>
            </div>
          ` : ''}
        </div>
      `;
      card.addEventListener('click', (e) => {
        if (e.target.closest('[data-del-ex], [data-rename-ex]')) return;
        if (isFolder) openPortfolioFolderViewer(ex.id);
        else openPhotoLightbox(ex.url, ex.title);
      });
      const ren = card.querySelector('[data-rename-ex]');
      if (ren) {
        ren.addEventListener('click', (e) => {
          e.stopPropagation();
          const nextTitle = window.prompt(isFolder ? 'Nuevo nombre para la carpeta:' : 'Nuevo nombre para la foto:', ex.title || '');
          if (!nextTitle || !nextTitle.trim()) return;
          ex.title = nextTitle.trim();
          savePortalState();
          renderPortalExamples();
          showToast('Nombre actualizado');
        });
      }
      const del = card.querySelector('[data-del-ex]');
      if (del) {
        del.addEventListener('click', (e) => {
          e.stopPropagation();
          portalState.examplePhotos.splice(idx, 1);
          savePortalState();
          renderPortalExamples();
          showToast(isFolder ? 'Carpeta eliminada' : 'Foto de ejemplo eliminada');
        });
      }
      grid.appendChild(card);
    });
  });
}

async function openProjectByCode(rawCode, forceRole = null) {
  const cleanCode = String(rawCode || '').trim().toUpperCase();
  const match = portalState.projects.find((p) => p.code.toUpperCase() === cleanCode);
  if (!match) {
    const errEl = document.getElementById('portal-code-error');
    if (errEl) errEl.style.display = 'block';
    showToast(`Código "${cleanCode}" no encontrado`);
    return false;
  }
  const errEl = document.getElementById('portal-code-error');
  if (errEl) errEl.style.display = 'none';

  if (forceRole === 'public' || forceRole === 'editor') portalState.auth.mode = forceRole;

  // Synchronous pre-warm of Intro video element while user gesture is fresh (tablets/iPadOS/Android)
  const prewarmIntroVid = document.getElementById('intro-video-player');
  if (prewarmIntroVid) {
    prewarmIntroVid.muted = true;
    prewarmIntroVid.playsInline = true;
    prewarmIntroVid.setAttribute('webkit-playsinline', '');
  }

  navHistory.length = 0;
  if (isPublishedRuntime()) {
    portalState.auth.mode = 'public';
    state = createFreshProjectState(match);
    try {
      const pubData = await fetchPublishedProject(match.code, portalState.publishVersion || '', './');
      applyLoadedProjectData(pubData, match.code, match);
    } catch (err) {
      showToast(`No se pudo cargar ${match.code}: ${err?.message || err}`);
      return false;
    }
    state.auth = portalState.auth;
    await hydrateMediaFromIndexedDB();
  } else {
    loadPersistedState(match.code);
    await hydrateMediaFromIndexedDB();
  }

  // Sync 3D model floors & cameras for this project (preserve remote .url models!)
  if (!state.customModel3D?.mediaKey && !state.customModel3D?.url) {
    build4FloorLuxuryTower3D(false);
  }
  render3DCamerasList();
  render3DFloorSelectorButtons();

  syncProjectBrandingUI();
  syncAvanceUI();
  applyRoleUI();
  renderLevelsSidebar();
  drawMasterplanRender();
  selectUnit(state.selectedUnitId, false);
  loadRoom360(state.activeRoom360Id);
  renderFinishesTabs();
  initLocationMap();
  renderUnitsCatalog();
  updateBackButtonUI();

  showScreen('showroom');
  setNavDockExpanded(false);
  switchView('masterplan', false, true);
  requestAnimationFrame(() => syncSceneMediaBox());

  if (state.intro?.enabled) {
    playIntroVideo(false);
  }
  return true;
}

let newProjectCoverDraft = { url: null, mediaKey: null };

function nextInternalProjectCode() {
  let n = portalState.projects.length + 1;
  let candidate = `SALO-${String(n).padStart(3, '0')}`;
  while (portalState.projects.some((p) => String(p.code || '').toUpperCase() === candidate)) {
    n += 1;
    candidate = `SALO-${String(n).padStart(3, '0')}`;
  }
  return candidate;
}

function openNewProjectModal() {
  if (!isEditor()) { showToast('Inicia sesión como Editor para crear proyectos'); return; }
  newProjectCoverDraft = { url: null, mediaKey: null };
  document.getElementById('np-input-building').value = '';
  document.getElementById('np-input-code').value = '';
  document.getElementById('np-input-subtitle').value = 'Showroom Interactivo 3D · Panorámica · Plantas';
  document.getElementById('np-input-wa').value = '59173080076';
  const pubCb = document.getElementById('np-input-published');
  if (pubCb) pubCb.checked = false;
  document.getElementById('np-cover-lbl').textContent = 'Portada: Render predeterminado o sube tu foto';
  document.getElementById('modal-new-project')?.classList.add('open');
}

async function createNewProjectFromModal() {
  if (!isEditor()) return;
  const buildingName = document.getElementById('np-input-building').value.trim() || `Edificio SALO ${portalState.projects.length + 1}`;
  const accessCode = normalizeAccessCode(document.getElementById('np-input-code').value);
  const accessCodeHash = await hashAccessCode(accessCode);

  const conflict = findUniqueAccessCodeConflict(portalState.projects, accessCode, accessCodeHash, null);
  if (conflict) {
    showToast(`❌ El código "${accessCode}" ya lo usa "${conflict.buildingName}". Elige otro código único.`);
    return;
  }

  const code = nextInternalProjectCode();
  const subtitle = document.getElementById('np-input-subtitle').value.trim() || 'Showroom Interactivo 3D · Panorámica · Plantas';
  const whatsappPhone = document.getElementById('np-input-wa').value.trim() || '59173080076';
  const published = !!document.getElementById('np-input-published')?.checked;
  const requiresCode = Boolean(accessCodeHash);

  const newMeta = {
    code,
    accessCode,
    accessCodeHash,
    requiresCode,
    buildingName,
    subtitle,
    whatsappPhone,
    published,
    coverUrl: newProjectCoverDraft.url || './sample-assets/exterior-tower.webp',
    coverMediaKey: newProjectCoverDraft.mediaKey || null,
    createdAt: new Date().toISOString().slice(0, 10)
  };
  portalState.projects.unshift(newMeta);
  const fresh = createFreshProjectState(newMeta);
  state = fresh;
  savePersistedState();
  savePortalState();
  renderPortalProjects();
  document.getElementById('modal-new-project')?.classList.remove('open');
  showToast(requiresCode ? `Proyecto "${buildingName}" creado (código privado activo)` : `Proyecto "${buildingName}" creado (demo abierto)`);
  await openProjectByCode(code, 'editor');
}

function deleteProjectFromPortal(code) {
  if (!isEditor() || portalState.projects.length <= 1) return;
  portalState.projects = portalState.projects.filter((p) => p.code.toUpperCase() !== String(code).toUpperCase());
  try { localStorage.removeItem(getProjectStorageKey(code)); } catch (_) {}
  savePortalState();
  renderPortalProjects();
  showToast(`Proyecto ${code} eliminado`);
}

/* ==========================================================================
   1. PROJECT BRANDING (SALO SHOWROOM + EDIFICIO), LOGO (2 POS + OPACITY), BACK HISTORY & ROLES
   ========================================================================== */
const navHistory = [];

function pushNavHistory() {
  const snap = {
    view: state.activeView,
    levelId: state.activeLevelId,
    exteriorAngleIndex: state.exteriorAngleIndex,
    tour360LevelId: state.activeTour360LevelId,
    room360Id: state.activeRoom360Id
  };
  const last = navHistory[navHistory.length - 1];
  if (last && last.view === snap.view && last.levelId === snap.levelId && last.room360Id === snap.room360Id && last.tour360LevelId === snap.tour360LevelId) {
    return;
  }
  navHistory.push(snap);
  if (navHistory.length > 25) navHistory.shift();
  updateBackButtonUI();
}

function updateBackButtonUI() {
  const btn = document.getElementById('btn-global-back');
  if (!btn) return;
  const shouldShow = navHistory.length > 0 || state.activeView !== 'masterplan' || state.activeLevelId !== 'facade';
  btn.classList.toggle('visible', shouldShow);
  document.body.classList.toggle('has-back-btn', shouldShow);
}

function goBackHistory() {
  const photoViewer = document.getElementById('modal-photo-viewer');
  if (photoViewer && photoViewer.classList.contains('open')) {
    photoViewer.classList.remove('open');
    return;
  }
  if (navHistory.length > 0) {
    const prev = navHistory.pop();
    state.activeLevelId = prev.levelId || 'facade';
    state.exteriorAngleIndex = prev.exteriorAngleIndex || 0;
    state.activeTour360LevelId = prev.tour360LevelId ?? null;
    switchView(prev.view || 'masterplan', false, true);
    renderLevelsSidebar();
    drawMasterplanRender();
    renderMasterplanOverlays();
    if (prev.view === 'tour360' && prev.room360Id) loadRoom360(prev.room360Id);
    updateBackButtonUI();
    return;
  }
  if (state.activeView !== 'masterplan') {
    switchView('masterplan', false, true);
  } else if (state.activeLevelId !== 'facade') {
    state.activeLevelId = 'facade';
    renderLevelsSidebar();
    drawMasterplanRender();
    renderMasterplanOverlays();
  }
  updateBackButtonUI();
}

function buildWhatsAppUrl(customMsg = null) {
  const customUrl = (state.project.whatsappCustomUrl || '').trim();
  const msgText = customMsg || state.project.whatsappMessage || `Hola, me gustaría recibir información sobre ${state.project.buildingName}.`;
  if (customUrl && /^https?:\/\//i.test(customUrl)) {
    const sep = customUrl.includes('?') ? '&' : '?';
    return customUrl.includes('text=') ? customUrl : `${customUrl}${sep}text=${encodeURIComponent(msgText)}`;
  }
  const cleanPhone = String(state.project.whatsappPhone || '').replace(/[^\d]/g, '');
  return cleanPhone
    ? `https://wa.me/${cleanPhone}?text=${encodeURIComponent(msgText)}`
    : `https://wa.me/?text=${encodeURIComponent(msgText)}`;
}

function syncProjectLogoUI() {
  const wrap = document.getElementById('main-project-logo-wrap');
  const img = document.getElementById('main-project-logo-img');
  if (!wrap || !img) return;
  const pos = (state.project.logoPosition === 'pos-bottom-right') ? 'pos-bottom-right' : 'pos-above-exterior';
  const visible = Boolean(state.project.showLogo && state.project.logoUrl && state.activeView === 'masterplan');
  wrap.className = `main-project-logo-wrap ${pos} ${visible ? 'visible' : ''}`;
  if (state.project.logoUrl) img.src = state.project.logoUrl;
  img.style.height = `${Math.max(24, Math.min(140, Number(state.project.logoSizePx) || 48))}px`;
  const opacityPct = Math.max(10, Math.min(100, Number(state.project.logoOpacity ?? 100)));
  img.style.opacity = String(opacityPct / 100);
}

function syncUnitsTabVisibilityUI() {
  const showTab = state.unitsConfig?.showTab !== false;
  const navBtn = document.getElementById('nav-units');
  const lupaBtn = document.getElementById('btn-finder-lupa');
  const drawerLink = document.getElementById('drawer-link-units');
  const editorToggle = document.getElementById('toggle-show-units-tab');

  const visibleInNav = showTab || isEditor();
  if (navBtn) {
    navBtn.style.display = visibleInNav ? '' : 'none';
    navBtn.style.opacity = (!showTab && isEditor()) ? '0.45' : '1';
    navBtn.title = (!showTab && isEditor()) ? 'Oculta al público (Visible solo para Editor)' : 'Áreas disponibles ($)';
  }
  if (lupaBtn) lupaBtn.style.display = showTab ? '' : 'none';
  if (drawerLink) drawerLink.style.display = visibleInNav ? '' : 'none';
  if (editorToggle) editorToggle.checked = showTab;

  if (!showTab && !isEditor() && state.activeView === 'units') {
    switchView('masterplan', false, true);
  }
}

function syncModel3DTabVisibilityUI() {
  const showTab = state.model3dConfig?.showTab !== false;
  const navBtn = document.getElementById('nav-model3d');
  const drawerLink = document.querySelector('[data-drawer-nav="model3d"]');
  const unitBtn = document.getElementById('btn-drawer-go-3d-floor');
  const visibleInNav = showTab || isEditor();

  if (navBtn) {
    navBtn.style.display = visibleInNav ? '' : 'none';
    navBtn.style.opacity = (!showTab && isEditor()) ? '0.45' : '1';
    navBtn.title = (!showTab && isEditor()) ? 'Oculta al público (Visible solo para Editor)' : 'Maqueta 3D';
  }
  if (drawerLink) drawerLink.style.display = visibleInNav ? '' : 'none';
  if (unitBtn) unitBtn.style.display = visibleInNav ? '' : 'none';

  if (!showTab && !isEditor() && state.activeView === 'model3d') {
    switchView('masterplan', false, true);
  }
}

function syncProjectBrandingUI() {
  const buildingName = state.project.buildingName || 'Torre Pocito 3D';
  state.project.shortName = 'SALO SHOWROOM';
  state.project.fullTitle = `SALO SHOWROOM · ${buildingName}`;
  const tabNameEl = document.getElementById('project-tab-name');
  const bldgSubEl = document.getElementById('project-building-name');
  const titleEl = document.getElementById('project-title');
  const subEl = document.getElementById('project-subtitle');
  const codeEl = document.getElementById('dropdown-project-code');
  const menuTitle = document.getElementById('drawer-menu-proj-title');
  const introTitle = document.getElementById('intro-brand-title');
  const introSub = document.getElementById('intro-brand-sub');

  if (tabNameEl) tabNameEl.textContent = 'SALO SHOWROOM';
  if (bldgSubEl) bldgSubEl.textContent = buildingName;
  if (titleEl) titleEl.textContent = `SALO SHOWROOM · ${buildingName}`;
  if (subEl) subEl.textContent = state.project.subtitle || 'Showroom Interactivo 3D · Panorámica · Plantas';
  if (codeEl) codeEl.textContent = `Código: ${state.project.code || 'SALO-001'}`;
  if (menuTitle) menuTitle.textContent = buildingName;
  if (introTitle) introTitle.textContent = buildingName;
  if (introSub) introSub.textContent = 'SALO SHOWROOM · Cálculo y Diseño';

  if (portalState.activeScreen === 'showroom') {
    document.title = `SALO SHOWROOM · ${buildingName}`;
  }
  syncProjectLogoUI();
  syncUnitsTabVisibilityUI();
  syncModel3DTabVisibilityUI();
}

function syncAvanceUI() {
  const pct = Math.max(0, Math.min(100, Number(state.avance.percent) || 0));
  document.getElementById('avance-pill-pct').textContent = `${pct}%`;
  document.getElementById('dropdown-avance-pct').textContent = `${pct}%`;
  document.getElementById('drawer-avance-val').textContent = `${pct}%`;
  document.getElementById('avance-modal-pct').textContent = String(pct);
  document.getElementById('avance-modal-bar').style.width = `${pct}%`;
  document.getElementById('avance-modal-delivery').textContent = state.avance.delivery || 'Diciembre 2026';
  document.getElementById('avance-modal-stage').textContent = state.avance.stage || 'En ejecución';

  document.getElementById('avance-input-pct').value = String(pct);
  document.getElementById('avance-edit-lbl').textContent = `${pct}%`;
  document.getElementById('avance-input-delivery').value = state.avance.delivery || '';
  document.getElementById('avance-input-stage').value = state.avance.stage || '';
}

function applyRoleUI() {
  const mode = (isPublishedRuntime() || portalState.auth.mode !== 'editor') ? 'public' : 'editor';
  if (isPublishedRuntime()) portalState.auth.mode = 'public';
  state.auth = portalState.auth;
  document.body.dataset.role = mode;
  document.body.dataset.runtime = isPublishedRuntime() ? 'published' : 'local';
  const badge = document.getElementById('dropdown-role-badge');
  const toggleLbl = document.getElementById('role-toggle-label');
  if (badge) badge.textContent = mode === 'editor' ? 'Editor' : 'Público';
  if (toggleLbl) toggleLbl.textContent = mode === 'editor' ? '🛡️ Editor' : '👁️ Público';

  if (mode === 'public') {
    state.isDrawingPolygon = false;
    state.isPlacingPlanPoint = false;
    if (state.editingShapeUnitId) exitPolygonShapeEdit(false);
    state.draftPolygonPoints = [];
    state.isPlacingHotspot360 = false;
    locationMap.isPlacingPoi = false;
    document.body.classList.remove('placing-plan-point');
    document.getElementById('plan-point-place-banner')?.classList.remove('active');
    document.getElementById('btn-draw-polygon')?.classList.remove('active');
    document.getElementById('polygon-draw-toolbar')?.classList.remove('active');
    document.getElementById('image-adjust-popover')?.classList.remove('open');
    document.getElementById('info-config-panel')?.classList.remove('open');
    document.getElementById('hotspot-place-hint').style.display = 'none';
    document.getElementById('poi-place-hint').style.display = 'none';
    document.getElementById('location-map-stage')?.classList.remove('placing-poi');
    if (state.activeView === 'studio') switchView('masterplan', false, true);
  }

  syncUnitsTabVisibilityUI();
  syncModel3DTabVisibilityUI();
  syncPortalEditorTabUI();
  renderPortalProjects();
  renderPortalExamples();
  const strip = document.getElementById('editor-quick-strip');
  if (strip) strip.style.visibility = (state.activeView === 'masterplan' && isEditor()) ? 'visible' : 'hidden';
  render3DCamerasList();
  render3DFloorSelectorButtons();
  renderFinishesTabs();
  renderLocationPoiList();
  renderMasterplanOverlays();
  syncHotspots360DOM();
  renderTour360FloorsPanel();
}

function openAuthModal() {
  if (isPublishedRuntime()) return;
  const modal = document.getElementById('modal-editor-auth');
  const loginSec = document.getElementById('auth-login-section');
  const manageSec = document.getElementById('auth-manage-section');
  document.getElementById('auth-error-msg').style.display = 'none';

  if (isEditor()) {
    loginSec.style.display = 'none';
    manageSec.style.display = 'flex';
    document.getElementById('auth-active-user').textContent = portalState.auth.currentUser || 'admin';
    document.getElementById('public-url-preview').textContent = `${window.location.origin}${window.location.pathname}?project=${encodeURIComponent(state.project.code || 'SALO-001')}&mode=public`;
    renderAuthorizedEditorsList();
  } else {
    loginSec.style.display = 'flex';
    manageSec.style.display = 'none';
    document.getElementById('auth-input-pin').value = '';
  }
  modal.classList.add('open');
}

function renderAuthorizedEditorsList() {
  const list = document.getElementById('authorized-editors-list');
  if (!list) return;
  list.innerHTML = '';
  state.auth.editors.forEach((ed, idx) => {
    const row = document.createElement('div');
    row.className = 'poi-list-item';
    row.innerHTML = `
      <div>
        <strong style="font-size:11.5px;color:var(--gold-bright);">👤 ${ed.username}</strong>
        <span style="font-size:10px;color:var(--ink-silver);margin-left:6px;">PIN: ${ed.pin} · ${ed.role || 'Editor'}</span>
      </div>
      ${idx > 0 ? `<button class="icon-btn" data-del-ed="${idx}" title="Quitar acceso" style="color:#f87171;">🗑️</button>` : '<span class="code-tag">Admin</span>'}
    `;
    const delBtn = row.querySelector('[data-del-ed]');
    if (delBtn) {
      delBtn.addEventListener('click', () => {
        portalState.auth.editors.splice(idx, 1);
        savePortalState();
        savePersistedState();
        renderAuthorizedEditorsList();
        showToast('Acceso de editor revocado');
      });
    }
    list.appendChild(row);
  });
}

function setupPanelMinimize(panelId, minBtnId, restoreBtnId, mode = 'minimized') {
  const panel = document.getElementById(panelId);
  const minBtn = document.getElementById(minBtnId);
  const restoreBtn = document.getElementById(restoreBtnId);
  if (!panel || !minBtn || !restoreBtn) return;

  minBtn.addEventListener('click', () => {
    if (mode === 'drawer') panel.classList.remove('open');
    else panel.classList.add('minimized');
    restoreBtn.classList.add('visible');
    if (panelId === 'unit-drawer') renderMasterplanOverlays();
  });
  restoreBtn.addEventListener('click', () => {
    if (mode === 'drawer') panel.classList.add('open');
    else panel.classList.remove('minimized');
    restoreBtn.classList.remove('visible');
    if (panelId === 'unit-drawer') renderMasterplanOverlays();
  });
}

/* ==========================================================================
   2. EXTERIOR 360° FLYBY ROTATION (< GIRAR >) + POLYGONS + HOVER TOOLTIP
   ========================================================================== */
const crossfadeSeqMap = {};

function crossfadeImageElement(baseImg, overlayImg, nextUrl, seqKey, shouldCrossfade = false) {
  if (!baseImg) return;
  const seq = (crossfadeSeqMap[seqKey] = (crossfadeSeqMap[seqKey] || 0) + 1);
  const prevSrc = baseImg.getAttribute('src') || '';
  const prevResolved = baseImg.currentSrc || baseImg.src || '';

  const resetOverlay = () => {
    if (!overlayImg) return;
    overlayImg.style.transition = 'none';
    overlayImg.style.opacity = '0';
    overlayImg.removeAttribute('src');
  };

  if (!shouldCrossfade || !overlayImg || !prevSrc || prevSrc === nextUrl || prevResolved === nextUrl) {
    resetOverlay();
    baseImg.src = nextUrl;
    return;
  }

  overlayImg.style.transition = 'none';
  overlayImg.src = prevResolved || prevSrc;
  overlayImg.style.opacity = '1';
  void overlayImg.offsetWidth; // force reflow

  let started = false;
  const runFade = () => {
    if (started || crossfadeSeqMap[seqKey] !== seq) return;
    started = true;
    requestAnimationFrame(() => {
      if (crossfadeSeqMap[seqKey] !== seq) return;
      overlayImg.style.transition = 'opacity 1s ease-in-out';
      overlayImg.style.opacity = '0';
      setTimeout(() => {
        if (crossfadeSeqMap[seqKey] === seq) resetOverlay();
      }, 1050);
    });
  };

  baseImg.addEventListener('load', runFade, { once: true });
  baseImg.addEventListener('error', runFade, { once: true });
  baseImg.src = nextUrl;
  if (baseImg.complete && baseImg.naturalWidth > 0) runFade();
  setTimeout(runFade, 2500);
}

function drawMasterplanRender(animateCrossfade = false) {
  const customImg = document.getElementById('masterplan-custom-img');
  const crossfadeImg = document.getElementById('masterplan-crossfade-img');
  if (!customImg) return;

  const isExterior = state.activeLevelId === 'facade';
  const portalEl = document.getElementById('exterior-portal-360');
  const angleBadge = document.getElementById('flyby-angle-badge');
  const activeLevel = state.levels.find((l) => l.id === state.activeLevelId) || state.levels[0];

  let photoUrl = '';

  if (isExterior) {
    const ang = state.exteriorAngles[state.exteriorAngleIndex] || state.exteriorAngles[0];
    photoUrl = (state.isNightMode && ang.nightPhoto) ? ang.nightPhoto : ang.photo;
    const showPortal = state.exteriorAngleIndex === 0 && activeLevel.hasTour360 !== false;
    if (portalEl) {
      portalEl.style.display = showPortal ? 'block' : 'none';
      const pt = document.getElementById('portal-360-title');
      const ps = document.getElementById('portal-360-sub');
      if (pt) pt.textContent = 'Recorrido Virtual 360°';
      if (ps) ps.textContent = 'Hall, Living & Amenities en HD';
    }
    if (angleBadge) {
      const tot = state.exteriorAngles.length;
      angleBadge.textContent = `Vista Exterior ${state.exteriorAngleIndex + 1} / ${tot}`;
    }
  } else {
    photoUrl = activeLevel.dayPhoto;
    if (state.is2DPlanMode && activeLevel.plan2DPhoto) photoUrl = activeLevel.plan2DPhoto;
    else if (state.isNightMode && activeLevel.nightPhoto) photoUrl = activeLevel.nightPhoto;
    if (portalEl) {
      // Show 360 portal on floor only if floor has 360 enabled AND has rooms or user enabled it
      if (activeLevel.hasTour360 !== false) {
        portalEl.style.display = 'block';
        const pt = document.getElementById('portal-360-title');
        const ps = document.getElementById('portal-360-sub');
        if (pt) pt.textContent = `Recorrido 360° · ${activeLevel.badge || activeLevel.name}`;
        if (ps) ps.textContent = 'Ingresar a vistas 360° de este nivel';
      } else {
        portalEl.style.display = 'none';
      }
    }
    if (angleBadge) angleBadge.textContent = activeLevel.name || activeLevel.badge || 'Planta';
  }

  crossfadeImageElement(customImg, crossfadeImg, photoUrl, 'masterplan', animateCrossfade);
  customImg.style.display = 'block';
  customImg.style.filter = 'none';
  const isPortalVisible = Boolean(portalEl && portalEl.style.display !== 'none');
  document.body.classList.toggle('has-exterior-360-btn', isPortalVisible);
  const nav360Btn = document.getElementById('nav-tour360');
  if (nav360Btn) {
    const show360Nav = isExterior ? true : (activeLevel.hasTour360 !== false);
    nav360Btn.style.display = show360Nav ? '' : 'none';
  }
  applyActiveImageAdjustment();
  syncSceneMediaBox();
  updateBackButtonUI();
  syncProjectLogoUI();
}

function rotateExteriorFlyby(stepDir) {
  if (state.activeLevelId !== 'facade') {
    stepMasterplanLevel(stepDir);
    return;
  }
  const n = state.exteriorAngles.length;
  if (n <= 0) return;
  state.exteriorAngleIndex = (state.exteriorAngleIndex + stepDir + n) % n;
  const img = document.getElementById('masterplan-custom-img');
  if (img) {
    img.style.opacity = '0.35';
    setTimeout(() => {
      drawMasterplanRender();
      renderMasterplanOverlays();
      img.style.opacity = '1';
    }, 110);
  } else {
    drawMasterplanRender();
    renderMasterplanOverlays();
  }
}

/* --- INTRO VIDEO PLAYER (Plays on entry until main panel, tablet/mobile autoplay-safe) --- */
async function playIntroVideo(forcePlay = false) {
  if (!forcePlay && !state.intro?.enabled) return;
  const overlay = document.getElementById('intro-video-overlay');
  const video = document.getElementById('intro-video-player');
  const skipBtn = document.getElementById('btn-skip-intro');
  const tapPlayBtn = document.getElementById('btn-intro-tap-play');
  if (!overlay || !video) return;

  const url = state.intro.mediaKey ? (await getMediaUrl(state.intro.mediaKey)) : (state.intro.defaultVideo || './sample-assets/transition-fly.mp4');
  if (!url) return;

  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    video.pause();
    video.onended = null;
    video.onerror = null;
    if (tapPlayBtn) {
      tapPlayBtn.style.display = 'none';
      tapPlayBtn.onclick = null;
    }
    overlay.classList.remove('playing');
  };

  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', '');
  video.src = url;
  if (tapPlayBtn) tapPlayBtn.style.display = 'none';
  overlay.classList.add('playing');
  video.currentTime = 0;
  video.load();
  video.onended = done;
  video.onerror = () => {
    if (finished) return;
    showToast('No se pudo cargar el video de intro');
    done();
  };
  if (skipBtn) skipBtn.onclick = done;

  const attemptPlay = () => {
    const p = video.play();
    if (p && typeof p.then === 'function') {
      p.then(() => {
        if (tapPlayBtn) tapPlayBtn.style.display = 'none';
      }).catch((err) => {
        if (finished) return;
        const name = err?.name || '';
        // Tablet/iPadOS/Android autoplay policy rejection: keep overlay open with direct tap-to-play button
        if (name === 'NotAllowedError' || name === 'AbortError' || !name) {
          if (tapPlayBtn) {
            tapPlayBtn.style.display = 'inline-flex';
            tapPlayBtn.onclick = () => {
              tapPlayBtn.style.display = 'none';
              video.muted = true;
              attemptPlay();
            };
          }
        } else {
          done();
        }
      });
    }
  };
  attemptPlay();
}

/* --- EXTERIOR VIEWS & INTRO MANAGER MODAL (Solo Editor) --- */
function openExteriorManagerModal() {
  if (!isEditor()) { showToast('Solo cuentas de Editor pueden gestionar vistas exteriores'); return; }
  const cb = document.getElementById('toggle-intro-video-enabled');
  const lbl = document.getElementById('lbl-intro-enabled');
  const statusLbl = document.getElementById('intro-video-status-lbl');
  if (cb) cb.checked = !!state.intro.enabled;
  if (lbl) {
    lbl.textContent = state.intro.enabled ? 'ACTIVADO' : 'DESACTIVADO';
    lbl.style.color = state.intro.enabled ? '#4ade80' : 'var(--ink-silver)';
  }
  if (statusLbl) {
    statusLbl.textContent = state.intro.customName ? `🎬 Personalizado: ${state.intro.customName}` : 'Video Demo: transition-fly.mp4';
  }
  renderExteriorViewsManagerList();
  document.getElementById('modal-exterior-manager')?.classList.add('open');
}

function renderExteriorViewsManagerList() {
  const list = document.getElementById('exterior-views-list');
  if (!list) return;
  list.innerHTML = '';
  state.exteriorAngles.forEach((ang, idx) => {
    const hasNight = Boolean(ang.nightMediaKey || (ang.nightPhoto && ang.nightPhoto !== ang.photo));
    const row = document.createElement('div');
    row.className = 'builder-item-row';
    row.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;min-width:0;flex:1;">
        <img src="${ang.photo}" alt="" style="width:46px;height:30px;object-fit:cover;border-radius:6px;border:1px solid var(--gold-border);flex-shrink:0;" />
        <div style="min-width:0;flex:1;">
          <strong style="font-size:11.5px;color:${idx === 0 ? 'var(--gold-bright)' : 'var(--ink-white)'};display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
            ${idx === 0 ? '⭐ Vista Principal · ' : `Vista #${idx + 1} · `}${ang.label}
          </strong>
          <span style="font-size:9.5px;color:var(--ink-silver);">${ang.mediaKey ? 'Calidad nativa (IndexedDB)' : 'Imagen ejemplo'}${hasNight ? ' · 🌙 Con nocturna' : ''}</span>
        </div>
      </div>
      <div style="display:flex;gap:4px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end;">
        <button class="glass-pill-btn" data-ext-view="${idx}" style="height:24px;padding:0 8px;font-size:10px;">👁️ Ver</button>
        <label class="glass-pill-btn" style="height:24px;padding:0 8px;font-size:10px;cursor:pointer;" title="Subir vista nocturna opcional">🌙 ${hasNight ? 'Cambiar' : 'Nocturna'}<input type="file" accept="image/*" style="display:none;" data-ext-night-input="${idx}" /></label>
        ${hasNight ? `<button class="glass-pill-btn" data-ext-del-night="${idx}" style="height:24px;padding:0 7px;font-size:10px;color:#fdba74;" title="Quitar vista nocturna">✕🌙</button>` : ''}
        ${idx > 0 ? `<button class="glass-pill-btn" data-ext-make-main="${idx}" style="height:24px;padding:0 8px;font-size:10px;" title="Hacer vista principal">⭐</button>` : ''}
        ${state.exteriorAngles.length > 1 ? `<button class="glass-pill-btn" data-ext-del="${idx}" style="height:24px;padding:0 7px;font-size:10px;color:#f87171;">🗑️</button>` : ''}
      </div>
    `;
    row.querySelector('[data-ext-view]').addEventListener('click', () => {
      state.activeLevelId = 'facade';
      state.exteriorAngleIndex = idx;
      drawMasterplanRender();
      renderMasterplanOverlays();
      document.getElementById('modal-exterior-manager').classList.remove('open');
    });
    const nightInput = row.querySelector('[data-ext-night-input]');
    if (nightInput) {
      nightInput.addEventListener('change', async (e) => {
        if (!isEditor()) return;
        const file = e.target.files?.[0];
        if (!file) return;
        const key = `ext-night-${idx}-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`;
        const url = await saveMediaBlob(key, file);
        ang.nightPhoto = url;
        ang.nightMediaKey = key;
        if (idx === 0) {
          const facadeLvl = state.levels.find((l) => l.id === 'facade');
          if (facadeLvl) { facadeLvl.nightPhoto = url; facadeLvl.nightMediaKey = key; }
        }
        state.activeLevelId = 'facade';
        state.exteriorAngleIndex = idx;
        savePersistedState();
        renderExteriorViewsManagerList();
        drawMasterplanRender();
        showToast(`Vista nocturna cargada en ${ang.label}`);
        e.target.value = '';
      });
    }
    const delNightBtn = row.querySelector('[data-ext-del-night]');
    if (delNightBtn) {
      delNightBtn.addEventListener('click', () => {
        if (!isEditor()) return;
        ang.nightPhoto = null;
        ang.nightMediaKey = null;
        if (idx === 0) {
          const facadeLvl = state.levels.find((l) => l.id === 'facade');
          if (facadeLvl) { facadeLvl.nightPhoto = null; facadeLvl.nightMediaKey = null; }
        }
        savePersistedState();
        renderExteriorViewsManagerList();
        drawMasterplanRender();
        showToast('Vista nocturna eliminada');
      });
    }
    const mkMain = row.querySelector('[data-ext-make-main]');
    if (mkMain) {
      mkMain.addEventListener('click', () => {
        const [moved] = state.exteriorAngles.splice(idx, 1);
        state.exteriorAngles.unshift(moved);
        const facadeLvl = state.levels.find((l) => l.id === 'facade');
        if (facadeLvl) {
          facadeLvl.dayPhoto = moved.photo;
          facadeLvl.dayMediaKey = moved.mediaKey || null;
          facadeLvl.nightPhoto = moved.nightPhoto || null;
          facadeLvl.nightMediaKey = moved.nightMediaKey || null;
        }
        state.exteriorAngleIndex = 0;
        savePersistedState();
        renderExteriorViewsManagerList();
        drawMasterplanRender();
        showToast('Vista principal actualizada');
      });
    }
    const delBtn = row.querySelector('[data-ext-del]');
    if (delBtn) {
      delBtn.addEventListener('click', () => {
        state.exteriorAngles.splice(idx, 1);
        state.exteriorAngleIndex = Math.min(state.exteriorAngleIndex, state.exteriorAngles.length - 1);
        if (idx === 0 && state.exteriorAngles[0]) {
          const facadeLvl = state.levels.find((l) => l.id === 'facade');
          const nextMain = state.exteriorAngles[0];
          if (facadeLvl) {
            facadeLvl.dayPhoto = nextMain.photo;
            facadeLvl.dayMediaKey = nextMain.mediaKey || null;
            facadeLvl.nightPhoto = nextMain.nightPhoto || null;
            facadeLvl.nightMediaKey = nextMain.nightMediaKey || null;
          }
        }
        savePersistedState();
        renderExteriorViewsManagerList();
        drawMasterplanRender();
        showToast('Vista exterior eliminada');
      });
    }
    list.appendChild(row);
  });
}

let sceneMediaBoxMetrics = { cw: 0, ch: 0, bw: 0, bh: 0, scale: 1, overflowsX: false, overflowsY: false };

function setNavDockExpanded(expanded) {
  const shell = document.getElementById('showroom-shell');
  const btn = document.getElementById('btn-toggle-nav-dock');
  const arrow = document.getElementById('nav-dock-toggle-arrow');
  const isOpen = Boolean(expanded);
  if (shell) shell.classList.toggle('nav-dock-collapsed', !isOpen);
  if (btn) btn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  if (arrow) arrow.textContent = isOpen ? '▴' : '▾';
}

function getScenePanBounds() {
  const { cw, ch, bw, bh, scale } = sceneMediaBoxMetrics;
  const effW = bw * scale * (state.zoom || 1);
  const effH = bh * scale * (state.zoom || 1);
  const maxX = Math.max(0, (effW - cw) / 2);
  const maxY = Math.max(0, (effH - ch) / 2);
  return { maxX, maxY, overflowsX: effW > cw + 2, overflowsY: effH > ch + 2 };
}

function syncSceneMediaBox() {
  const frame = document.getElementById('scene-frame');
  const box = document.getElementById('scene-media-box');
  const customImg = document.getElementById('masterplan-custom-img');
  if (!frame || !box || !customImg) return;

  const cw = frame.clientWidth || window.innerWidth;
  const ch = frame.clientHeight || window.innerHeight;
  if (!cw || !ch) return;

  const nw = customImg.naturalWidth || 1600;
  const nh = customImg.naturalHeight || 900;
  const adj = state.imageAdjustments[state.activeLevelId] || { fit: 'cover', scale: 100, x: 0, y: 0 };
  const fit = adj.fit || 'cover';
  const ratio = fit === 'contain' ? Math.min(cw / nw, ch / nh) : Math.max(cw / nw, ch / nh);
  const bw = nw * ratio;
  const bh = nh * ratio;
  const left = (cw - bw) / 2;
  const top = (ch - bh) / 2;
  const scale = (adj.scale ?? 100) / 100;

  box.style.width = `${bw}px`;
  box.style.height = `${bh}px`;
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
  box.style.transform = `translate(${adj.x ?? 0}%, ${adj.y ?? 0}%) scale(${scale})`;

  customImg.style.objectFit = 'fill';
  customImg.style.transform = 'none';

  sceneMediaBoxMetrics = {
    cw, ch, bw, bh, scale,
    overflowsX: bw * scale > cw + 2,
    overflowsY: bh * scale > ch + 2
  };

  const bounds = getScenePanBounds();
  state.pan.x = Math.max(-bounds.maxX, Math.min(bounds.maxX, state.pan.x || 0));
  state.pan.y = Math.max(-bounds.maxY, Math.min(bounds.maxY, state.pan.y || 0));
  updateMasterplanZoomTransform();
}

function distPointToSegment2D(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function isPointInOrNearPolygon(px, py, polygon, thresholdPct = 4.5) {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  // Ray-casting point-in-polygon
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    const intersect = ((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / ((yj - yi) || 1e-9) + xi);
    if (intersect) inside = !inside;
  }
  if (inside) return true;
  // Minimum distance to any polygon edge
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    if (distPointToSegment2D(px, py, a.x, a.y, b.x, b.y) <= thresholdPct) return true;
  }
  return false;
}

function clearPolygonProximityReveal() {
  document.querySelectorAll('#polygon-svg .unit-polygon.proximity-reveal').forEach((el) => {
    el.classList.remove('proximity-reveal');
  });
}

function updatePolygonProximityReveal(clientX, clientY, thresholdPct = 4.5) {
  if (state.activeView !== 'masterplan') return;
  const box = document.getElementById('scene-media-box');
  if (!box) return;
  const rect = box.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const px = ((clientX - rect.left) / rect.width) * 100;
  const py = ((clientY - rect.top) / rect.height) * 100;
  if (px < -10 || px > 110 || py < -10 || py > 110) {
    clearPolygonProximityReveal();
    return;
  }
  const polys = document.querySelectorAll('#polygon-svg .unit-polygon[data-unit-id]');
  polys.forEach((polyEl) => {
    const u = state.units.find((item) => item.id === polyEl.dataset.unitId);
    const near = u ? isPointInOrNearPolygon(px, py, u.polygon, thresholdPct) : false;
    polyEl.classList.toggle('proximity-reveal', near);
  });
}

function applyActiveImageAdjustment() {
  const adj = state.imageAdjustments[state.activeLevelId] || { fit: 'cover', scale: 100, x: 0, y: 0 };
  syncSceneMediaBox();

  const fitEl = document.getElementById('adj-fit');
  const scaleEl = document.getElementById('adj-scale');
  const xEl = document.getElementById('adj-x');
  const yEl = document.getElementById('adj-y');
  if (fitEl) fitEl.value = adj.fit || 'cover';
  if (scaleEl) scaleEl.value = String(adj.scale ?? 100);
  if (xEl) xEl.value = String(adj.x ?? 0);
  if (yEl) yEl.value = String(adj.y ?? 0);
  document.getElementById('lbl-adj-scale').textContent = `${adj.scale ?? 100}%`;
  document.getElementById('lbl-adj-x').textContent = `${adj.x ?? 0}%`;
  document.getElementById('lbl-adj-y').textContent = `${adj.y ?? 0}%`;
}

function showUnitHoverTooltip(unit, clientX, clientY) {
  const tip = document.getElementById('unit-hover-tooltip');
  if (!tip || !unit) return;
  const isAlreadySelectedOpen = unit.id === state.selectedUnitId && document.getElementById('unit-drawer')?.classList.contains('open');
  if (isAlreadySelectedOpen || state.editingShapeUnitId) {
    tip.classList.remove('visible');
    return;
  }
  const targetLvl = state.levels.find((l) => l.id === (unit.targetLevelId || unit.levelId)) || state.levels[0];
  const statusMap = {
    available: { text: '● Disponible', bg: '#22c55e' },
    reserved: { text: '● Reservado', bg: '#f97316' },
    sold: { text: '● Vendido', bg: '#ef4444' }
  };
  const st = statusMap[unit.status] || statusMap.available;

  document.getElementById('uht-img').src = targetLvl.dayPhoto;
  const badge = document.getElementById('uht-badge');
  if (unit.showAvailability === false) {
    badge.style.display = 'none';
  } else {
    badge.style.display = 'inline-block';
    badge.textContent = st.text;
    badge.style.background = st.bg;
  }
  document.getElementById('uht-title').textContent = unit.code;
  const extraLine = (unit.customLines || [])[0];
  document.getElementById('uht-meta').textContent = extraLine
    ? (extraLine.type === 'metric' ? `${extraLine.label}: ${extraLine.number} ${extraLine.unit}` : extraLine.label)
    : `${unit.beds} Cuartos · ${unit.baths ?? 2} Baños · ${unit.area} m²`;

  const pad = 16;
  const tw = 228;
  const th = 190;
  let left = clientX + 18;
  let top = clientY - 30;
  if (left + tw > window.innerWidth - pad) left = clientX - tw - 18;
  if (top + th > window.innerHeight - pad) top = window.innerHeight - th - pad;
  if (top < 60) top = 60;

  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
  tip.classList.add('visible');
}

function hideUnitHoverTooltip() {
  document.getElementById('unit-hover-tooltip')?.classList.remove('visible');
}

let shapeEditBackupPolygon = null;

function recomputePolygonCentroid(polygon) {
  if (!Array.isArray(polygon) || polygon.length === 0) return { x: 50, y: 50 };
  const x = Math.round((polygon.reduce((s, p) => s + Number(p.x || 0), 0) / polygon.length) * 10) / 10;
  const y = Math.round((polygon.reduce((s, p) => s + Number(p.y || 0), 0) / polygon.length) * 10) / 10;
  return { x, y };
}

function enterPolygonShapeEdit(unitId) {
  if (!isEditor()) return;
  const unit = state.units.find((u) => u.id === unitId);
  if (!unit || !Array.isArray(unit.polygon) || unit.polygon.length < 3) return;
  if (state.isDrawingPolygon) {
    state.isDrawingPolygon = false;
    state.draftPolygonPoints = [];
    document.getElementById('btn-draw-polygon')?.classList.remove('active');
    document.getElementById('polygon-draw-toolbar')?.classList.remove('active');
  }
  shapeEditBackupPolygon = structuredClone(unit.polygon);
  state.editingShapeUnitId = unit.id;
  document.body.classList.add('editing-poly-shape');
  const lbl = document.getElementById('shape-edit-label');
  if (lbl) lbl.textContent = `✏️ Editando: ${unit.code} · Arrastra esquinas · Clic en borde agrega · Doble clic borra`;
  document.getElementById('polygon-shape-toolbar')?.classList.add('active');
  renderMasterplanOverlays();
}

function exitPolygonShapeEdit(saveChanges = true) {
  const unitId = state.editingShapeUnitId;
  const unit = unitId ? state.units.find((u) => u.id === unitId) : null;
  if (unit) {
    if (!saveChanges && Array.isArray(shapeEditBackupPolygon)) {
      unit.polygon = structuredClone(shapeEditBackupPolygon);
    }
    unit.center = recomputePolygonCentroid(unit.polygon);
    if (saveChanges) savePersistedState();
  }
  shapeEditBackupPolygon = null;
  state.editingShapeUnitId = null;
  document.body.classList.remove('editing-poly-shape');
  document.getElementById('polygon-shape-toolbar')?.classList.remove('active');
  renderMasterplanOverlays();
  if (saveChanges && unit) showToast(`Forma de "${unit.code}" guardada`);
}

function renderMasterplanOverlays() {
  const svg = document.getElementById('polygon-svg');
  const pinsContainer = document.getElementById('pins-container');
  if (!svg || !pinsContainer) return;

  svg.innerHTML = '';
  pinsContainer.innerHTML = '';

  const isExterior = state.activeLevelId === 'facade';
  const showAvail = state.showAvailability || !isExterior;
  const levelUnits = state.units.filter((u) => u.levelId === state.activeLevelId);
  const visibleUnits = (isExterior && state.exteriorAngleIndex !== 0) ? [] : levelUnits;

  const statusColorMap = { available: '#22c55e', reserved: '#f97316', sold: '#ef4444' };
  const firstAvailable = visibleUnits.find((u) => u.status === 'available');

  visibleUnits.forEach((unit) => {
    const isSelected = state.selectedUnitId === unit.id && document.getElementById('unit-drawer')?.classList.contains('open');
    const isEditingTarget = isEditor() && state.editingShapeUnitId === unit.id;
    const hideAvailColor = unit.showAvailability === false;
    const color = hideAvailColor ? '#d4af37' : (statusColorMap[unit.status] || '#22c55e');
    const pointsAttr = unit.polygon.map((p) => `${p.x},${p.y}`).join(' ');

    const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    poly.setAttribute('points', pointsAttr);
    poly.setAttribute('fill', color);
    poly.setAttribute('stroke', isSelected ? '#f5d77f' : '#ffffff');
    poly.setAttribute('data-unit-id', unit.id);
    poly.setAttribute('class', `unit-polygon ${isEditingTarget ? 'editing-target' : ''} ${isSelected ? 'selected' : ''}`);

    poly.addEventListener('mouseenter', (e) => { if (!state.isDrawingPolygon) showUnitHoverTooltip(unit, e.clientX, e.clientY); });
    poly.addEventListener('mousemove', (e) => { if (!state.isDrawingPolygon) showUnitHoverTooltip(unit, e.clientX, e.clientY); });
    poly.addEventListener('mouseleave', hideUnitHoverTooltip);
    poly.addEventListener('click', (e) => {
      if (state.isDrawingPolygon || state.isPlacingPlanPoint) return; // let the click reach #scene-frame
      e.stopPropagation();
      if (state.editingShapeUnitId) return;
      hideUnitHoverTooltip();
      selectUnit(unit.id, true);
    });
    poly.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (state.editingShapeUnitId) return;
      hideUnitHoverTooltip();
      triggerPolygonTargetTransition(unit);
    });
    svg.appendChild(poly);

    // Direct interactive shape editing handles (vertices + edge insertion)
    if (isEditor() && state.editingShapeUnitId === unit.id && Array.isArray(unit.polygon)) {
      const pts = unit.polygon;
      pts.forEach((p1, idx) => {
        const p2 = pts[(idx + 1) % pts.length];
        const edgeLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        edgeLine.setAttribute('x1', String(p1.x));
        edgeLine.setAttribute('y1', String(p1.y));
        edgeLine.setAttribute('x2', String(p2.x));
        edgeLine.setAttribute('y2', String(p2.y));
        edgeLine.setAttribute('class', 'edit-edge-hit');
        edgeLine.addEventListener('click', (e) => {
          e.stopPropagation();
          const rect = svg.getBoundingClientRect();
          const nx = Math.max(0, Math.min(100, Math.round(((e.clientX - rect.left) / rect.width) * 1000) / 10));
          const ny = Math.max(0, Math.min(100, Math.round(((e.clientY - rect.top) / rect.height) * 1000) / 10));
          unit.polygon.splice(idx + 1, 0, { x: nx, y: ny });
          unit.center = recomputePolygonCentroid(unit.polygon);
          savePersistedState();
          renderMasterplanOverlays();
        });
        svg.appendChild(edgeLine);
      });

      pts.forEach((pt, vIdx) => {
        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        dot.setAttribute('cx', String(pt.x));
        dot.setAttribute('cy', String(pt.y));
        dot.setAttribute('r', '1.15');
        dot.setAttribute('class', 'edit-vertex-handle');
        dot.setAttribute('data-v-idx', String(vIdx));

        dot.addEventListener('pointerdown', (e) => {
          if (e.button !== 0) return;
          e.stopPropagation();
          const startX = e.clientX;
          const startY = e.clientY;
          let didMove = false;
          const rect = svg.getBoundingClientRect();
          const onMove = (ev) => {
            if (!didMove && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 3) return;
            didMove = true;
            const nx = Math.max(0, Math.min(100, Math.round(((ev.clientX - rect.left) / rect.width) * 1000) / 10));
            const ny = Math.max(0, Math.min(100, Math.round(((ev.clientY - rect.top) / rect.height) * 1000) / 10));
            unit.polygon[vIdx].x = nx;
            unit.polygon[vIdx].y = ny;
            dot.setAttribute('cx', String(nx));
            dot.setAttribute('cy', String(ny));
            poly.setAttribute('points', unit.polygon.map((p) => `${p.x},${p.y}`).join(' '));
          };
          const onUp = () => {
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            if (!didMove) return;
            unit.center = recomputePolygonCentroid(unit.polygon);
            savePersistedState();
            renderMasterplanOverlays();
          };
          window.addEventListener('pointermove', onMove);
          window.addEventListener('pointerup', onUp);
        });

        const deleteVertex = (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (unit.polygon.length <= 3) {
            showToast('Un polígono requiere mínimo 3 vértices');
            return;
          }
          unit.polygon.splice(vIdx, 1);
          unit.center = recomputePolygonCentroid(unit.polygon);
          savePersistedState();
          renderMasterplanOverlays();
        };
        dot.addEventListener('dblclick', deleteVertex);
        dot.addEventListener('contextmenu', deleteVertex);
        svg.appendChild(dot);
      });
    }

    if (state.visibleFields.pinButton !== false && showAvail) {
      const pin = document.createElement('button');
      pin.className = `unit-pin ${isSelected ? 'selected' : ''}`;
      pin.style.left = `${unit.center.x}%`;
      pin.style.top = `${unit.center.y}%`;
      pin.innerHTML = hideAvailColor
        ? `<span style="color:var(--gold-bright);">✦</span> <span>${unit.buttonText || unit.code}</span>`
        : `<i class="status-dot ${unit.status}"></i> <span>${unit.buttonText || unit.code}</span>`;
      pin.addEventListener('mouseenter', (e) => {
        if (!state.isDrawingPolygon) showUnitHoverTooltip(unit, e.clientX, e.clientY);
        poly.classList.add('proximity-reveal');
      });
      pin.addEventListener('mouseleave', () => {
        hideUnitHoverTooltip();
        poly.classList.remove('proximity-reveal');
      });
      pin.addEventListener('click', (e) => {
        if (state.isDrawingPolygon || state.isPlacingPlanPoint) return;
        e.stopPropagation();
        hideUnitHoverTooltip();
        selectUnit(unit.id, true);
      });
      pin.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        hideUnitHoverTooltip();
        triggerPolygonTargetTransition(unit);
      });
      pinsContainer.appendChild(pin);
    }

    // Render floating "Ir a departamento" action above selected exterior polygon
    if (
      (isExterior || state.activeLevelId === 'masterplan') &&
      isSelected &&
      unit.targetLevelId &&
      unit.targetLevelId !== state.activeLevelId &&
      !state.isDrawingPolygon &&
      !state.isPlacingPlanPoint &&
      !state.editingShapeUnitId
    ) {
      const goDeptBtn = document.createElement('button');
      goDeptBtn.type = 'button';
      goDeptBtn.className = 'floating-goto-dept-btn';
      goDeptBtn.style.left = `${unit.center.x}%`;
      goDeptBtn.style.top = `${Math.max(10, unit.center.y)}%`;
      goDeptBtn.innerHTML = '🏢 Ir a departamento →';
      goDeptBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        hideUnitHoverTooltip();
        triggerPolygonTargetTransition(unit);
      });
      pinsContainer.appendChild(goDeptBtn);
    }

    // Editor-only quick floating button to reshape selected polygon directly on canvas
    if (isEditor() && isSelected && !state.isDrawingPolygon && !state.editingShapeUnitId && !state.isPlacingPlanPoint) {
      const quickEditBtn = document.createElement('button');
      quickEditBtn.type = 'button';
      quickEditBtn.className = 'poly-edit-quick-btn';
      quickEditBtn.style.left = `${unit.center.x}%`;
      quickEditBtn.style.top = `${Math.min(92, unit.center.y)}%`;
      quickEditBtn.innerHTML = '✏️ Editar forma';
      quickEditBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        hideUnitHoverTooltip();
        enterPolygonShapeEdit(unit.id);
      });
      pinsContainer.appendChild(quickEditBtn);
    }

    // Render custom render/360° interactive colored points directly on the floor plan when enabled
    (unit.customButtons || []).forEach((cb) => {
      if (!cb.showOnPlan) return;
      const pt = document.createElement('button');
      pt.className = 'plan-render-point';
      const px = cb.pinCoords?.x ?? unit.center.x;
      const py = cb.pinCoords?.y ?? Math.max(8, unit.center.y - 6);
      pt.style.left = `${px}%`;
      pt.style.top = `${py}%`;
      pt.style.setProperty('--pt-color', cb.pinColor || '#d4af37');
      pt.title = cb.actionType === 'tour360' ? `Ir a 360°: ${cb.label}` : `Ver Render: ${cb.label}`;
      pt.innerHTML = `<span class="plan-render-point-dot"></span><span>${cb.label}</span>`;
      pt.addEventListener('click', async (e) => {
        if (state.isDrawingPolygon || state.isPlacingPlanPoint) return;
        e.stopPropagation();
        hideUnitHoverTooltip();
        if (cb.actionType === 'tour360') {
          const scopeLvl = state.activeLevelId !== 'facade' ? state.activeLevelId : (unit.targetLevelId || null);
          await openFloorTour360(scopeLvl, cb.targetRoom360Id || null, true);
        } else {
          const photoSrc = cb.photoMediaKey ? (await getMediaUrl(cb.photoMediaKey)) || cb.photoUrl : cb.photoUrl;
          const nightSrc = cb.nightPhotoMediaKey ? (await getMediaUrl(cb.nightPhotoMediaKey)) || cb.nightPhotoUrl : (cb.nightPhotoUrl || null);
          if (photoSrc) openPhotoLightbox(photoSrc, cb.label, nightSrc);
          else showToast('Este punto aún no tiene una foto render asignada');
        }
      });
      pinsContainer.appendChild(pt);
    });
  });

  if (isEditor() && state.isDrawingPolygon && state.draftPolygonPoints.length > 0) {
    const draftPoly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    draftPoly.setAttribute('points', state.draftPolygonPoints.map((p) => `${p.x},${p.y}`).join(' '));
    draftPoly.setAttribute('fill', 'rgba(245, 215, 127, 0.32)');
    draftPoly.setAttribute('stroke', '#f5d77f');
    draftPoly.setAttribute('stroke-width', '0.45');
    svg.appendChild(draftPoly);

    state.draftPolygonPoints.forEach((pt) => {
      const c = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      c.setAttribute('cx', String(pt.x));
      c.setAttribute('cy', String(pt.y));
      c.setAttribute('r', '0.85');
      c.setAttribute('class', 'draft-vertex-dot');
      svg.appendChild(c);
    });
  }

  const availCount = state.units.filter((u) => u.status === 'available').length;
  const badgeEl = document.getElementById('available-count-badge');
  if (badgeEl) badgeEl.textContent = String(availCount);
}

/* ==========================================================================
   3. TRANSITIONS (VIDEO + 2-IMAGE ANIMATED) & FLOOR CREATOR BUILDER
   ========================================================================== */
function resolveTransitionSlotId(fromLevelId, toLevelId) {
  if (fromLevelId === 'facade' || fromLevelId === 'masterplan') {
    if (toLevelId === 'floor-9') return 'ext_to_floor9';
    if (toLevelId === 'floor-20') return 'ext_to_floor20';
    if (toLevelId === 'floor-35') return 'ext_to_floor35';
    if (toLevelId === 'floor-azotea') return 'ext_to_azotea';
    if (toLevelId === 'masterplan') return 'ext_to_masterplan';
  }
  return 'floor_to_floor';
}

async function resolveTransitionVideoForSlot(slotId, explicitOverride = null) {
  if (explicitOverride === 'none') return null;
  if (!state.transitions.globalEnabled) return null;
  const slot = state.transitions.slots.find((s) => s.id === slotId);
  if (slot && !slot.enabled && (!explicitOverride || explicitOverride === 'auto')) return null;
  if (slot && slot.mediaKey) {
    const customUrl = await getMediaUrl(slot.mediaKey);
    if (customUrl) return customUrl;
  }
  if (explicitOverride && explicitOverride !== 'auto') return explicitOverride;
  if (slot && slot.enabled && slot.defaultVideo) return slot.defaultVideo;
  return null;
}

async function playTransitionVideoThen(videoUrl, onFinish) {
  const overlay = document.getElementById('video-transition-overlay');
  const video = document.getElementById('transition-video-player');
  const skipBtn = document.getElementById('btn-skip-transition');
  if (!videoUrl) { if (onFinish) onFinish(); return; }

  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    video.pause();
    video.onended = null;
    overlay.classList.remove('playing');
    if (onFinish) onFinish();
  };

  video.src = videoUrl;
  overlay.classList.add('playing');
  video.currentTime = 0;
  video.onended = done;
  skipBtn.onclick = done;
  video.play().catch(done);
}

function playTwoImageTransition(img1Url, img2Url, onFinish) {
  const overlay = document.getElementById('two-image-transition-overlay');
  const f1 = document.getElementById('two-img-frame-1');
  const f2 = document.getElementById('two-img-frame-2');
  const skipBtn = document.getElementById('btn-skip-two-img');
  if (!overlay || !f1 || !f2 || (!img1Url && !img2Url)) { if (onFinish) onFinish(); return; }

  let finished = false;
  let t1 = null;
  let t2 = null;
  const done = () => {
    if (finished) return;
    finished = true;
    clearTimeout(t1);
    clearTimeout(t2);
    f1.classList.remove('active');
    f2.classList.remove('active');
    overlay.classList.remove('playing');
    if (onFinish) onFinish();
  };

  f1.src = img1Url || img2Url;
  f2.src = img2Url || img1Url;
  f1.classList.remove('active');
  f2.classList.remove('active');
  overlay.classList.add('playing');
  if (skipBtn) skipBtn.onclick = done;

  requestAnimationFrame(() => {
    f1.classList.add('active');
    t1 = setTimeout(() => {
      if (finished) return;
      f2.classList.add('active');
      t2 = setTimeout(done, 1050);
    }, 950);
  });
}

async function navigateToLevelWithTransition(targetLevelId, explicitOverride = 'auto', recordHistory = true) {
  const fromLevelId = state.activeLevelId;
  if (recordHistory && fromLevelId !== targetLevelId) pushNavHistory();
  const targetLvl = state.levels.find((l) => l.id === targetLevelId);

  const applyLevel = () => {
    state.activeLevelId = targetLevelId;
    state.is2DPlanMode = false;
    state.pan = { x: 0, y: 0 };
    setNavDockExpanded(false);
    document.getElementById('btn-mode-3drender')?.classList.add('active');
    document.getElementById('btn-mode-2dplan')?.classList.remove('active');
    renderLevelsSidebar();
    drawMasterplanRender();
    const firstUnitInLevel = state.units.find((u) => u.levelId === targetLevelId);
    if (firstUnitInLevel) selectUnit(firstUnitInLevel.id, false);
    else {
      document.getElementById('unit-drawer')?.classList.remove('open');
      document.getElementById('restore-unit-drawer')?.classList.add('visible');
      renderMasterplanOverlays();
    }
    updateBackButtonUI();
  };

  if (explicitOverride !== 'none' && state.transitions.globalEnabled) {
    // 1. Exact pair match in Transitions Manager (Edificio -> Piso OR Piso A -> Piso B)
    const exactSlot = (state.transitions.slots || []).find(
      (s) => s.fromLevelId === fromLevelId && s.toLevelId === targetLevelId
    );
    if (exactSlot) {
      if (!exactSlot.enabled || exactSlot.transitionType === 'none') {
        applyLevel();
        return;
      }
      if (exactSlot.transitionType === 'two_images' && (exactSlot.img1Url || exactSlot.img2Url)) {
        playTwoImageTransition(exactSlot.img1Url, exactSlot.img2Url, applyLevel);
        return;
      }
      const url = exactSlot.mediaKey ? await getMediaUrl(exactSlot.mediaKey) : exactSlot.defaultVideo;
      if (url) { await playTransitionVideoThen(url, applyLevel); return; }
    }

    // 2. Level-specific transition configured when creating the floor
    if (targetLvl) {
      if (targetLvl.transitionType === 'two_images' && (targetLvl.transImg1 || targetLvl.transImg2)) {
        playTwoImageTransition(targetLvl.transImg1, targetLvl.transImg2, applyLevel);
        return;
      }
      if (targetLvl.transitionType === 'video' && targetLvl.transitionMediaKey) {
        const lvlVidUrl = await getMediaUrl(targetLvl.transitionMediaKey);
        if (lvlVidUrl) { await playTransitionVideoThen(lvlVidUrl, applyLevel); return; }
      }
      if (targetLvl.transitionType === 'none') {
        applyLevel();
        return;
      }
    }
  }

  const slotId = resolveTransitionSlotId(fromLevelId, targetLevelId);
  const videoUrl = await resolveTransitionVideoForSlot(slotId, explicitOverride);
  await playTransitionVideoThen(videoUrl, applyLevel);
}

function triggerPolygonTargetTransition(unit) {
  if (!unit) return;
  const dest = unit.targetLevelId || 'floor-9';
  if (dest === state.activeLevelId) {
    showToast('Ya te encuentras en la planta de este nivel');
    return;
  }
  navigateToLevelWithTransition(dest, unit.transitionVideo || 'auto', true);
}

/* --- FLOOR CREATOR / EDITOR / DELETE MODAL --- */
let floorDraft = {
  planPhotoUrl: null, planPhotoKey: null,
  nightPhotoUrl: null, nightPhotoKey: null,
  transVideoKey: null, transVideoName: null,
  transImg1Url: null, transImg1Key: null,
  transImg2Url: null, transImg2Key: null,
  init360Url: null, init360Key: null, init360Name: null,
  linkToPolygonModal: false,
  linkToUnitId: null
};

function syncFloorTransTypeUI() {
  const type = document.getElementById('floor-input-trans-type')?.value || 'video';
  const vidBox = document.getElementById('floor-trans-video-box');
  const imgBox = document.getElementById('floor-trans-twoimg-box');
  if (vidBox) vidBox.style.display = type === 'video' ? 'flex' : 'none';
  if (imgBox) imgBox.style.display = type === 'two_images' ? 'grid' : 'none';
}

function deleteFloorById(levelId) {
  if (!isEditor() || !levelId || levelId === 'facade') {
    showToast('No se puede eliminar la vista exterior principal');
    return;
  }
  const lvl = state.levels.find((l) => l.id === levelId);
  if (!lvl) return;
  state.levels = state.levels.filter((l) => l.id !== levelId);
  state.units = state.units.filter((u) => u.levelId !== levelId);
  state.rooms360 = state.rooms360.filter((r) => r.levelId !== levelId);
  state.transitions.slots = (state.transitions.slots || []).filter((s) => s.fromLevelId !== levelId && s.toLevelId !== levelId);
  if (state.activeLevelId === levelId) state.activeLevelId = 'facade';
  if (state.editingFloorId === levelId) state.editingFloorId = null;
  savePersistedState();
  renderLevelsSidebar();
  drawMasterplanRender();
  renderMasterplanOverlays();
  renderExistingFloorsManageList();
  renderTour360FloorsPanel();
  showToast(`Nivel "${lvl.name}" eliminado`);
}

function renderExistingFloorsManageList() {
  const list = document.getElementById('existing-floors-manage-list');
  if (!list) return;
  list.innerHTML = '';
  const editableLevels = state.levels.filter((l) => l.id !== 'facade');
  if (editableLevels.length === 0) {
    list.innerHTML = '<span style="font-size:10px;color:var(--ink-muted);">No hay pisos adicionales creados aún.</span>';
    return;
  }
  editableLevels.forEach((lvl) => {
    const row = document.createElement('div');
    row.className = 'builder-item-row';
    row.innerHTML = `
      <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
        <strong style="color:var(--gold-bright);">${lvl.name}</strong> <small style="opacity:0.7;">(${lvl.badge})</small>
      </span>
      <div style="display:flex;gap:4px;flex-shrink:0;">
        <button type="button" class="glass-pill-btn" data-edit-lvl="${lvl.id}" style="height:22px;padding:0 7px;font-size:10px;">✎ Editar</button>
        <button type="button" class="glass-pill-btn" data-del-lvl="${lvl.id}" style="height:22px;padding:0 7px;font-size:10px;color:#f87171;border-color:rgba(239,68,68,0.4);">🗑️ Eliminar</button>
      </div>
    `;
    row.querySelector('[data-edit-lvl]').addEventListener('click', () => openFloorCreatorModal(lvl));
    row.querySelector('[data-del-lvl]').addEventListener('click', () => deleteFloorById(lvl.id));
    list.appendChild(row);
  });
}

function openFloorCreatorModal(existingLevel = null, options = {}) {
  if (!isEditor()) { showToast('Solo cuentas de Editor pueden crear o eliminar pisos'); return; }
  state.editingFloorId = existingLevel ? existingLevel.id : null;
  const hasRealNight = Boolean(
    existingLevel?.nightMediaKey
    || (existingLevel?.nightPhoto && existingLevel.nightPhoto !== existingLevel.dayPhoto)
  );
  floorDraft = {
    planPhotoUrl: existingLevel?.dayPhoto || null,
    planPhotoKey: existingLevel?.dayMediaKey || null,
    nightPhotoUrl: hasRealNight ? (existingLevel?.nightPhoto || null) : null,
    nightPhotoKey: existingLevel?.nightMediaKey || null,
    transVideoKey: existingLevel?.transitionMediaKey || null,
    transVideoName: existingLevel?.transitionVideoName || null,
    transImg1Url: existingLevel?.transImg1 || null,
    transImg1Key: existingLevel?.transImg1Key || null,
    transImg2Url: existingLevel?.transImg2 || null,
    transImg2Key: existingLevel?.transImg2Key || null,
    init360Url: null, init360Key: null, init360Name: null,
    linkToPolygonModal: !!options.linkToPolygonModal,
    linkToUnitId: options.linkToUnitId || null
  };

  document.getElementById('floor-modal-heading').textContent = existingLevel ? `⚙️ Editar Nivel: ${existingLevel.name}` : '🏗️ Crear Nuevo Piso / Nivel';
  document.getElementById('floor-input-name').value = existingLevel ? existingLevel.name : `Piso ${state.levels.length + 1}° · Planta`;
  document.getElementById('floor-input-badge').value = existingLevel ? existingLevel.badge : `Piso ${state.levels.length + 1}`;
  document.getElementById('floor-input-trans-type').value = existingLevel?.transitionType || 'video';
  document.getElementById('floor-input-has-360').checked = existingLevel ? existingLevel.hasTour360 !== false : true;
  document.getElementById('floor-360-upload-box').style.display = document.getElementById('floor-input-has-360').checked ? 'flex' : 'none';
  document.getElementById('floor-trans-video-name').textContent = floorDraft.transVideoName ? `🎬 ${floorDraft.transVideoName}` : 'Video Demo: transition-floors.mp4';
  document.getElementById('floor-twoimg-1-lbl').textContent = floorDraft.transImg1Url ? '✅ Imagen 1 lista' : 'Sin seleccionar';
  document.getElementById('floor-twoimg-2-lbl').textContent = floorDraft.transImg2Url ? '✅ Imagen 2 lista' : 'Sin seleccionar';
  document.getElementById('floor-plan-photo-lbl').textContent = floorDraft.planPhotoKey ? '✅ Fotografía en planta cargada' : 'Se usará render de planta predeterminado o sube tu foto';
  const nightLbl = document.getElementById('floor-night-photo-lbl');
  if (nightLbl) nightLbl.textContent = floorDraft.nightPhotoUrl ? '✅ Vista nocturna cargada' : 'Opcional: si no se sube, el modo Noche mantiene la foto principal sin oscurecer';
  const clrNightBtn = document.getElementById('btn-floor-clear-night');
  if (clrNightBtn) clrNightBtn.style.display = floorDraft.nightPhotoUrl ? 'inline-flex' : 'none';
  document.getElementById('floor-360-initial-lbl').textContent = 'Opcional: sube ya la 1ra imagen 360° de este piso';
  const delBtn = document.getElementById('btn-delete-floor-modal');
  if (delBtn) delBtn.style.display = (existingLevel && existingLevel.id !== 'facade') ? 'inline-flex' : 'none';
  syncFloorTransTypeUI();
  renderExistingFloorsManageList();
  document.getElementById('modal-floor-creator')?.classList.add('open');
}

function saveFloorFromModal() {
  if (!isEditor()) return;
  const name = document.getElementById('floor-input-name').value.trim() || 'Nuevo Piso';
  const badge = document.getElementById('floor-input-badge').value.trim() || 'Planta';
  const transitionType = document.getElementById('floor-input-trans-type').value;
  const hasTour360 = document.getElementById('floor-input-has-360').checked;

  let targetLvlId = state.editingFloorId;

  if (state.editingFloorId) {
    const lvl = state.levels.find((l) => l.id === state.editingFloorId);
    if (lvl) {
      lvl.name = name;
      lvl.badge = badge;
      lvl.transitionType = transitionType;
      lvl.hasTour360 = hasTour360;
      if (floorDraft.planPhotoUrl) {
        lvl.dayPhoto = floorDraft.planPhotoUrl;
        lvl.dayMediaKey = floorDraft.planPhotoKey;
      }
      lvl.nightPhoto = floorDraft.nightPhotoUrl || null;
      lvl.nightMediaKey = floorDraft.nightPhotoKey || null;
      if (lvl.id === 'facade' && state.exteriorAngles[0]) {
        if (floorDraft.planPhotoUrl) {
          state.exteriorAngles[0].photo = floorDraft.planPhotoUrl;
          state.exteriorAngles[0].mediaKey = floorDraft.planPhotoKey;
        }
        state.exteriorAngles[0].nightPhoto = lvl.nightPhoto;
        state.exteriorAngles[0].nightMediaKey = lvl.nightMediaKey;
      }
      lvl.transitionMediaKey = floorDraft.transVideoKey;
      lvl.transitionVideoName = floorDraft.transVideoName;
      lvl.transImg1 = floorDraft.transImg1Url;
      lvl.transImg1Key = floorDraft.transImg1Key;
      lvl.transImg2 = floorDraft.transImg2Url;
      lvl.transImg2Key = floorDraft.transImg2Key;
    }
  } else {
    targetLvlId = `floor-custom-${Date.now()}`;
    const newLevel = {
      id: targetLvlId,
      name,
      badge,
      floorNum: state.levels.length,
      dayPhoto: floorDraft.planPhotoUrl || './sample-assets/floor-piso9-3d.jpg',
      nightPhoto: floorDraft.nightPhotoUrl || null,
      plan2DPhoto: floorDraft.planPhotoUrl || './sample-assets/floor-piso9-plan.webp',
      dayMediaKey: floorDraft.planPhotoKey || null,
      nightMediaKey: floorDraft.nightPhotoKey || null,
      hasTour360,
      transitionType,
      transitionMediaKey: floorDraft.transVideoKey || null,
      transitionVideoName: floorDraft.transVideoName || null,
      transImg1: floorDraft.transImg1Url || null,
      transImg1Key: floorDraft.transImg1Key || null,
      transImg2: floorDraft.transImg2Url || null,
      transImg2Key: floorDraft.transImg2Key || null
    };
    state.levels.push(newLevel);
    state.imageAdjustments[targetLvlId] = { fit: 'contain', scale: 100, x: 0, y: 0 };

    // Auto-register a dedicated Edificio -> Nuevo Piso slot in the Transitions Manager!
    state.transitions.slots.push({
      id: `trans-ext-to-${targetLvlId}`,
      fromLevelId: 'facade',
      toLevelId: targetLvlId,
      label: `Exterior Principal → ${name}`,
      enabled: transitionType !== 'none',
      transitionType,
      defaultVideo: './sample-assets/transition-floors.mp4',
      mediaKey: floorDraft.transVideoKey || null,
      customName: floorDraft.transVideoName || null,
      img1Url: floorDraft.transImg1Url || null,
      img1Key: floorDraft.transImg1Key || null,
      img2Url: floorDraft.transImg2Url || null,
      img2Key: floorDraft.transImg2Key || null
    });

    if (hasTour360) {
      const roomId = `room-${targetLvlId}-1`;
      state.rooms360.push({
        id: roomId,
        levelId: targetLvlId,
        name: floorDraft.init360Name || `${name} · Vista 360° #1`,
        subtitle: `Recorrido 360° exclusivo de ${name}`,
        themeColor: '#161410',
        customImageUrl: floorDraft.init360Url || null,
        mediaKey: floorDraft.init360Key || null,
        hotspots: []
      });
    }
  }

  if (state.editingFloorId && floorDraft.init360Url) {
    const roomId = `room-${targetLvlId}-${Date.now()}`;
    state.rooms360.push({
      id: roomId,
      levelId: targetLvlId,
      name: floorDraft.init360Name || `${name} · Vista 360°`,
      subtitle: `Panorama 360° de ${name}`,
      themeColor: '#161410',
      customImageUrl: floorDraft.init360Url,
      mediaKey: floorDraft.init360Key,
      hotspots: []
    });
  }

  if (floorDraft.linkToUnitId) {
    const u = state.units.find((x) => x.id === floorDraft.linkToUnitId);
    if (u) u.targetLevelId = targetLvlId;
  }

  savePersistedState();
  renderLevelsSidebar();
  renderTour360FloorsPanel();
  document.getElementById('modal-floor-creator')?.classList.remove('open');

  if (floorDraft.linkToPolygonModal) {
    const targetSelect = document.getElementById('poly-input-target-level');
    if (targetSelect) {
      targetSelect.innerHTML = '';
      state.levels.forEach((lvl) => {
        const opt = document.createElement('option');
        opt.value = lvl.id;
        opt.textContent = lvl.name;
        targetSelect.appendChild(opt);
      });
      targetSelect.value = targetLvlId;
    }
    showToast(`Piso "${name}" creado y vinculado al polígono`);
  } else if (state.activeView === 'studio') {
    showToast(`Nivel "${name}" guardado`);
    populateTransitionSelectors();
    renderStudioFloorsTab();
    renderStudioTransitionsTab();
  } else {
    showToast(`Nivel "${name}" guardado`);
    navigateToLevelWithTransition(targetLvlId, 'auto', true);
  }
}

function getLevelDisplayName(levelId) {
  if (levelId === 'any_floor') return 'Cualquier Piso';
  if (levelId === 'any') return 'Cualquier Vista';
  if (levelId === 'tour360') return 'Recorrido 360°';
  if (levelId === 'model3d') return 'Maqueta 3D';
  const lvl = state.levels.find((l) => l.id === levelId);
  return lvl ? lvl.name : levelId;
}

let studioActiveTab = 'transitions';
let studioTransitionsFilterLevelId = null;

function buildTransitionEndpointOptionsHtml(selectedVal = '') {
  const opts = [];
  (state.levels || []).forEach((lvl) => {
    const label = lvl.id === 'facade' ? `🏛️ Exterior (${lvl.name})` : `🏢 ${lvl.name}`;
    opts.push({ value: lvl.id, label });
  });
  opts.push({ value: 'tour360', label: '🌐 Panorámica 360°' });
  opts.push({ value: 'model3d', label: '🧊 Maqueta 3D' });
  if (selectedVal && !opts.some((o) => o.value === selectedVal)) {
    opts.push({ value: selectedVal, label: getLevelDisplayName(selectedVal) });
  }
  return opts.map((o) => `<option value="${escapeHtml(o.value)}" ${o.value === selectedVal ? 'selected' : ''}>${escapeHtml(o.label)}</option>`).join('');
}

function populateTransitionSelectors() {
  const pairs = [
    [document.getElementById('trans-new-from'), document.getElementById('trans-new-to')],
    [document.getElementById('studio-trans-new-from'), document.getElementById('studio-trans-new-to')]
  ];
  const defaultTo = state.levels.length > 1 ? state.levels[state.levels.length - 1].id : 'tour360';
  pairs.forEach(([fromSel, toSel]) => {
    if (!fromSel || !toSel) return;
    const prevFrom = fromSel.value || 'facade';
    const prevTo = toSel.value || defaultTo;
    fromSel.innerHTML = buildTransitionEndpointOptionsHtml(prevFrom);
    toSel.innerHTML = buildTransitionEndpointOptionsHtml(prevTo);
    fromSel.value = prevFrom;
    toSel.value = prevTo;
  });
}

function syncGlobalTransitionsToggleUI() {
  const enabled = !!state.transitions.globalEnabled;
  [
    ['toggle-global-transitions', 'lbl-global-transitions'],
    ['toggle-studio-global-transitions', 'lbl-studio-global-transitions']
  ].forEach(([cbId, lblId]) => {
    const cb = document.getElementById(cbId);
    const lbl = document.getElementById(lblId);
    if (cb) cb.checked = enabled;
    if (lbl) {
      lbl.textContent = enabled ? 'ACTIVADAS' : 'DESACTIVADAS';
      lbl.style.color = enabled ? '#4ade80' : '#f87171';
    }
  });
}

function openTransitionsManagerModal() {
  if (!isEditor()) { showToast('Solo cuentas de Editor pueden configurar transiciones'); return; }
  const modal = document.getElementById('modal-transitions-manager');
  syncGlobalTransitionsToggleUI();
  populateTransitionSelectors();
  renderTransitionsManagerRows();
  modal.classList.add('open');
}

function refreshAllTransitionsLists() {
  renderTransitionsRowsInto(document.getElementById('transitions-list-container'), null);
  renderTransitionsRowsInto(document.getElementById('studio-transitions-list'), studioTransitionsFilterLevelId);
}

function renderTransitionsManagerRows() {
  refreshAllTransitionsLists();
}

function renderTransitionsRowsInto(container, filterLevelId = null) {
  if (!container) return;
  container.innerHTML = '';

  const slots = state.transitions.slots || [];
  const filteredEntries = slots
    .map((slot, idx) => ({ slot, idx }))
    .filter(({ slot }) => {
      if (!filterLevelId) return true;
      return slot.fromLevelId === filterLevelId || slot.toLevelId === filterLevelId;
    });

  if (filteredEntries.length === 0) {
    container.innerHTML = `<div style="padding:14px;text-align:center;color:var(--ink-silver);font-size:11.5px;border:1px dashed var(--gold-border);border-radius:10px;">No hay transiciones configuradas para este filtro. Usa el formulario superior para añadir una ruta.</div>`;
    return;
  }

  filteredEntries.forEach(({ slot, idx }) => {
    const row = document.createElement('div');
    row.className = 'transition-row editable-grid';
    const tType = slot.transitionType || 'video';
    const desc = tType === 'two_images'
      ? `🖼️ 2 Imágenes (${slot.img1Url ? 'Img1 ✓' : 'Falta 1'} · ${slot.img2Url ? 'Img2 ✓' : 'Falta 2'})`
      : tType === 'none'
        ? '⚡ Cambio directo sin animación'
        : (slot.customName ? `🎬 Video: ${slot.customName}` : (slot.defaultVideo ? `🎞️ Demo: ${slot.defaultVideo.split('/').pop()}` : 'Sin video'));

    const fromVal = slot.fromLevelId || 'facade';
    const toVal = slot.toLevelId || (slot.id === 'to_tour360' ? 'tour360' : slot.id === 'to_model3d' ? 'model3d' : (state.levels[1]?.id || 'facade'));
    const routeLabel = `${getLevelDisplayName(fromVal)} → ${getLevelDisplayName(toVal)}`;

    row.innerHTML = `
      <div class="field-col" style="gap:3px;">
        <select class="trans-endpoint-select" data-slot-from="${slot.id}" title="Inicio (Desde)">
          ${buildTransitionEndpointOptionsHtml(fromVal)}
        </select>
      </div>
      <div class="field-col" style="gap:3px;">
        <select class="trans-endpoint-select" data-slot-to="${slot.id}" title="Fin (Hacia)">
          ${buildTransitionEndpointOptionsHtml(toVal)}
        </select>
      </div>
      <div style="display:flex;flex-direction:column;gap:5px;">
        <span style="font-size:10px;color:${slot.customName || slot.img1Url ? '#4ade80' : 'var(--ink-silver)'};">${desc}</span>
        <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;">
          <select data-slot-type="${slot.id}" style="background:rgba(255,255,255,0.07);border:1px solid var(--gold-border);color:#fff;border-radius:99px;padding:3px 7px;font-size:10px;">
            <option value="video" ${tType === 'video' ? 'selected' : ''}>🎬 Video</option>
            <option value="two_images" ${tType === 'two_images' ? 'selected' : ''}>🖼️ 2 Imág.</option>
            <option value="none" ${tType === 'none' ? 'selected' : ''}>⚡ Directo</option>
          </select>
          <label class="toggle-switch">
            <input type="checkbox" data-slot-toggle="${slot.id}" ${slot.enabled ? 'checked' : ''} />
            <span style="color:${slot.enabled ? '#4ade80' : 'var(--ink-muted)'};">${slot.enabled ? 'ON' : 'OFF'}</span>
          </label>
          ${tType === 'two_images' ? `
            <label class="glass-pill-btn" style="cursor:pointer;height:24px;font-size:10px;padding:0 8px;">Img 1<input type="file" accept="image/*" data-slot-img1="${slot.id}" style="display:none;" /></label>
            <label class="glass-pill-btn" style="cursor:pointer;height:24px;font-size:10px;padding:0 8px;">Img 2<input type="file" accept="image/*" data-slot-img2="${slot.id}" style="display:none;" /></label>
          ` : `
            <label class="glass-pill-btn" style="cursor:pointer;height:24px;font-size:10px;padding:0 8px;">⬆️ Video<input type="file" accept="video/mp4,video/webm" data-slot-upload="${slot.id}" style="display:none;" /></label>
          `}
          <button class="glass-pill-btn" data-slot-test="${slot.id}" style="height:24px;padding:0 7px;">▶️</button>
          <button class="glass-pill-btn" data-slot-del="${idx}" title="Eliminar transición" style="height:24px;padding:0 7px;color:#f87171;">🗑️</button>
        </div>
      </div>
    `;

    row.querySelector(`[data-slot-from="${slot.id}"]`).addEventListener('change', (e) => {
      slot.fromLevelId = e.target.value;
      slot.label = `${getLevelDisplayName(slot.fromLevelId)} → ${getLevelDisplayName(slot.toLevelId || toVal)}`;
      savePersistedState();
      refreshAllTransitionsLists();
      showToast(`Ruta actualizada: ${slot.label}`);
    });
    row.querySelector(`[data-slot-to="${slot.id}"]`).addEventListener('change', (e) => {
      slot.toLevelId = e.target.value;
      slot.label = `${getLevelDisplayName(slot.fromLevelId || fromVal)} → ${getLevelDisplayName(slot.toLevelId)}`;
      savePersistedState();
      refreshAllTransitionsLists();
      showToast(`Ruta actualizada: ${slot.label}`);
    });
    row.querySelector(`[data-slot-type="${slot.id}"]`).addEventListener('change', (e) => {
      slot.transitionType = e.target.value;
      savePersistedState();
      refreshAllTransitionsLists();
    });
    row.querySelector(`[data-slot-toggle="${slot.id}"]`).addEventListener('change', (e) => {
      slot.enabled = e.target.checked;
      savePersistedState();
      refreshAllTransitionsLists();
    });
    const vidInp = row.querySelector(`[data-slot-upload="${slot.id}"]`);
    if (vidInp) {
      vidInp.addEventListener('change', async (e) => {
        const file = e.target.files[0]; if (!file) return;
        const key = `trans-${slot.id}-${Date.now()}`;
        await saveMediaBlob(key, file);
        slot.mediaKey = key;
        slot.customName = file.name;
        slot.transitionType = 'video';
        slot.enabled = true;
        savePersistedState();
        refreshAllTransitionsLists();
        showToast(`Video guardado para "${routeLabel}"`);
      });
    }
    const img1Inp = row.querySelector(`[data-slot-img1="${slot.id}"]`);
    if (img1Inp) {
      img1Inp.addEventListener('change', async (e) => {
        const file = e.target.files[0]; if (!file) return;
        const key = `trans-img1-${slot.id}-${Date.now()}`;
        slot.img1Url = await saveMediaBlob(key, file);
        slot.img1Key = key;
        slot.enabled = true;
        savePersistedState();
        refreshAllTransitionsLists();
        showToast('Imagen 1 de transición guardada');
      });
    }
    const img2Inp = row.querySelector(`[data-slot-img2="${slot.id}"]`);
    if (img2Inp) {
      img2Inp.addEventListener('change', async (e) => {
        const file = e.target.files[0]; if (!file) return;
        const key = `trans-img2-${slot.id}-${Date.now()}`;
        slot.img2Url = await saveMediaBlob(key, file);
        slot.img2Key = key;
        slot.enabled = true;
        savePersistedState();
        refreshAllTransitionsLists();
        showToast('Imagen 2 de transición guardada');
      });
    }
    row.querySelector(`[data-slot-test="${slot.id}"]`).addEventListener('click', async () => {
      if (slot.transitionType === 'two_images' && (slot.img1Url || slot.img2Url)) {
        playTwoImageTransition(slot.img1Url, slot.img2Url, null);
      } else {
        const url = slot.mediaKey ? await getMediaUrl(slot.mediaKey) : slot.defaultVideo;
        if (url) playTransitionVideoThen(url, null);
      }
    });
    row.querySelector('[data-slot-del]').addEventListener('click', () => {
      state.transitions.slots.splice(idx, 1);
      savePersistedState();
      refreshAllTransitionsLists();
      showToast('Transición eliminada');
    });
    container.appendChild(row);
  });
}

function renderStudioTransitionsTab() {
  syncGlobalTransitionsToggleUI();
  populateTransitionSelectors();
  const filterBar = document.getElementById('studio-trans-filter-bar');
  const filterLbl = document.getElementById('studio-trans-filter-label');
  if (filterBar) {
    filterBar.style.display = studioTransitionsFilterLevelId ? 'flex' : 'none';
    if (filterLbl && studioTransitionsFilterLevelId) {
      filterLbl.textContent = `Filtrando transiciones de: ${getLevelDisplayName(studioTransitionsFilterLevelId)}`;
    }
  }
  renderTransitionsRowsInto(document.getElementById('studio-transitions-list'), studioTransitionsFilterLevelId);
}

function renderStudioFloorsTab() {
  const list = document.getElementById('studio-floors-list');
  if (!list) return;
  list.innerHTML = '';

  (state.levels || []).forEach((lvl) => {
    const isFacade = lvl.id === 'facade';
    const polyCount = state.units.filter((u) => u.levelId === lvl.id).length;
    const panoCount = isFacade
      ? state.rooms360.length
      : state.rooms360.filter((r) => r.levelId === lvl.id).length;
    const hasNight = isFacade
      ? Boolean(state.exteriorAngles[0]?.nightPhoto || lvl.nightPhoto)
      : Boolean(lvl.nightPhoto);
    const thumb = isFacade ? (state.exteriorAngles[0]?.photo || lvl.dayPhoto) : lvl.dayPhoto;

    const row = document.createElement('div');
    row.className = 'studio-floor-row';
    row.dataset.floorId = lvl.id;
    row.innerHTML = `
      <div class="studio-floor-row-top">
        <div class="studio-floor-meta">
          <img class="studio-floor-thumb" src="${thumb}" alt="" />
          <div style="min-width:0;flex:1;">
            <strong style="font-size:13px;color:var(--gold-bright);display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
              ${isFacade ? '🏛️ ' : '🏢 '}${escapeHtml(lvl.name || lvl.badge)}
            </strong>
            <span style="font-size:10.5px;color:var(--ink-silver);">
              ${polyCount} polígono(s) · ${panoCount} panorámica(s) 360°${hasNight ? ' · 🌙 Con nocturna' : ''}
            </span>
          </div>
        </div>
        <div class="studio-floor-actions">
          <button type="button" class="glass-pill-btn" data-floor-act="transitions" style="height:28px;font-size:10.5px;padding:0 10px;">🎬 Editar transiciones</button>
          <button type="button" class="glass-pill-btn" data-floor-act="renders" style="height:28px;font-size:10.5px;padding:0 10px;">🖼️ Editar renders de piso</button>
          <button type="button" class="glass-pill-btn active" data-floor-act="plan" style="height:28px;font-size:10.5px;padding:0 10px;">📐 Editar plano planta piso</button>
          <button type="button" class="glass-pill-btn" data-floor-act="panoramas" style="height:28px;font-size:10.5px;padding:0 10px;">🌐 Panorámicas</button>
        </div>
      </div>
      <div class="studio-floor-renders-panel" data-floor-panel="${lvl.id}">
        <label class="glass-pill-btn active" style="cursor:pointer;height:28px;font-size:10.5px;padding:0 10px;">
          ☀️ Subir Render Día
          <input type="file" accept="image/*" style="display:none;" data-floor-upload="day" />
        </label>
        <label class="glass-pill-btn" style="cursor:pointer;height:28px;font-size:10.5px;padding:0 10px;">
          🌙 ${hasNight ? 'Cambiar Nocturna' : 'Subir Nocturna'}
          <input type="file" accept="image/*" style="display:none;" data-floor-upload="night" />
        </label>
        ${hasNight ? `<button type="button" class="glass-pill-btn" data-floor-clear-night style="height:28px;font-size:10.5px;padding:0 9px;color:#fdba74;">✕ Quitar Nocturna</button>` : ''}
        <label class="glass-pill-btn" style="cursor:pointer;height:28px;font-size:10.5px;padding:0 10px;">
          📐 Subir Plano 2D
          <input type="file" accept="image/*" style="display:none;" data-floor-upload="plan2d" />
        </label>
        <button type="button" class="glass-pill-btn" data-floor-open-gallery style="height:28px;font-size:10.5px;padding:0 10px;">🖼️ Abrir Galería</button>
      </div>
    `;

    row.querySelector('[data-floor-act="transitions"]').addEventListener('click', () => {
      studioTransitionsFilterLevelId = lvl.id;
      switchStudioTab('transitions');
      const toSel = document.getElementById('studio-trans-new-to');
      if (toSel) toSel.value = lvl.id;
    });

    row.querySelector('[data-floor-act="renders"]').addEventListener('click', () => {
      if (isFacade) {
        openExteriorManagerModal();
        return;
      }
      const panel = row.querySelector(`[data-floor-panel="${lvl.id}"]`);
      if (panel) panel.classList.toggle('open');
    });

    row.querySelector('[data-floor-act="plan"]').addEventListener('click', () => {
      state.activeLevelId = lvl.id;
      state.is2DPlanMode = false;
      document.getElementById('btn-mode-3drender')?.classList.add('active');
      document.getElementById('btn-mode-2dplan')?.classList.remove('active');
      renderLevelsSidebar();
      switchView('masterplan', false, false);
      drawMasterplanRender();
      renderMasterplanOverlays();
      const fp = document.getElementById('floor-elevator-panel');
      if (fp) fp.classList.remove('minimized', 'collapsed');
      document.getElementById('restore-floors-panel')?.classList.remove('visible');
      showToast(`Editando plano y polígonos de "${lvl.name}"`);
    });

    row.querySelector('[data-floor-act="panoramas"]').addEventListener('click', async () => {
      await openFloorTour360(isFacade ? null : lvl.id, null, false);
      const hud = document.getElementById('tour360-hud-panel');
      if (hud) hud.classList.remove('minimized', 'collapsed');
      const rest = document.getElementById('restore-360-panel');
      if (rest) rest.classList.remove('visible');
    });

    const dayInp = row.querySelector('[data-floor-upload="day"]');
    dayInp?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0]; if (!file) return;
      const key = `floor-day-${lvl.id}-${Date.now()}`;
      lvl.dayPhoto = await saveMediaBlob(key, file);
      lvl.dayMediaKey = key;
      savePersistedState();
      renderStudioFloorsTab();
      if (state.activeLevelId === lvl.id) drawMasterplanRender();
      showToast(`Render Día actualizado en "${lvl.name}"`);
      e.target.value = '';
    });

    const nightInp = row.querySelector('[data-floor-upload="night"]');
    nightInp?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0]; if (!file) return;
      const key = `floor-night-${lvl.id}-${Date.now()}`;
      lvl.nightPhoto = await saveMediaBlob(key, file);
      lvl.nightMediaKey = key;
      savePersistedState();
      renderStudioFloorsTab();
      if (state.activeLevelId === lvl.id) drawMasterplanRender();
      showToast(`Vista Nocturna cargada en "${lvl.name}"`);
      e.target.value = '';
    });

    row.querySelector('[data-floor-clear-night]')?.addEventListener('click', () => {
      lvl.nightPhoto = null;
      lvl.nightMediaKey = null;
      savePersistedState();
      renderStudioFloorsTab();
      if (state.activeLevelId === lvl.id) drawMasterplanRender();
      showToast(`Vista nocturna eliminada en "${lvl.name}"`);
    });

    const plan2dInp = row.querySelector('[data-floor-upload="plan2d"]');
    plan2dInp?.addEventListener('change', async (e) => {
      const file = e.target.files?.[0]; if (!file) return;
      const key = `floor-plan2d-${lvl.id}-${Date.now()}`;
      lvl.plan2DPhoto = await saveMediaBlob(key, file);
      lvl.plan2DMediaKey = key;
      savePersistedState();
      renderStudioFloorsTab();
      if (state.activeLevelId === lvl.id) drawMasterplanRender();
      showToast(`Plano 2D actualizado en "${lvl.name}"`);
      e.target.value = '';
    });

    row.querySelector('[data-floor-open-gallery]')?.addEventListener('click', () => {
      renderGalleryModalContent();
      document.getElementById('modal-renders-gallery')?.classList.add('open');
    });

    list.appendChild(row);
  });
}

function switchStudioTab(tabName = 'transitions') {
  studioActiveTab = tabName;
  document.querySelectorAll('.studio-tab-btn[data-studio-tab]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.studioTab === tabName);
  });
  document.querySelectorAll('.studio-panel').forEach((panel) => {
    panel.classList.toggle('active', panel.id === `studio-panel-${tabName}`);
  });
  if (tabName === 'transitions') renderStudioTransitionsTab();
  if (tabName === 'floors') renderStudioFloorsTab();
}

/* ==========================================================================
   4. UNIT DRAWER, PHOTO LIGHTBOX & DYNAMIC POLYGON / LINES / BUTTONS EDITOR
   ========================================================================== */
let activeLightboxState = { dayUrl: null, nightUrl: null, caption: 'Vista Renderizada' };

function syncDayNightButtonsUI() {
  const isNight = !!state.isNightMode;
  const dnIcon = document.getElementById('day-night-icon');
  if (dnIcon) dnIcon.textContent = isNight ? '🌙' : '☀️';
  document.getElementById('btn-day-night')?.classList.toggle('active', isNight);

  const btn360 = document.getElementById('btn-360-day-night');
  if (btn360) {
    btn360.textContent = isNight ? '🌙' : '☀️';
    btn360.classList.toggle('active', isNight);
  }

  const btnGal = document.getElementById('btn-gallery-day-night');
  if (btnGal) {
    btnGal.textContent = isNight ? '🌙 Noche' : '☀️ Día';
    btnGal.classList.toggle('active', isNight);
  }

  const btnLb = document.getElementById('btn-photo-viewer-day-night');
  if (btnLb) {
    btnLb.textContent = isNight ? '🌙 Modo Noche' : '☀️ Modo Día';
    btnLb.classList.toggle('active', isNight);
  }
}

function syncPhotoLightboxImage(animateCrossfade = false) {
  const img = document.getElementById('photo-viewer-img');
  const overlayImg = document.getElementById('photo-viewer-crossfade-img');
  const toggleBtn = document.getElementById('btn-photo-viewer-day-night');
  if (!img || !activeLightboxState.dayUrl) return;
  const hasNight = Boolean(activeLightboxState.nightUrl);
  const nextUrl = (state.isNightMode && hasNight) ? activeLightboxState.nightUrl : activeLightboxState.dayUrl;
  crossfadeImageElement(img, overlayImg, nextUrl, 'lightbox', animateCrossfade && hasNight);
  img.style.filter = 'none';
  if (toggleBtn) {
    toggleBtn.style.display = hasNight ? 'inline-flex' : 'none';
    toggleBtn.classList.toggle('visible', hasNight);
  }
  syncDayNightButtonsUI();
}

function toggleDayNightMode(forcedNight = null) {
  state.isNightMode = (typeof forcedNight === 'boolean') ? forcedNight : !state.isNightMode;
  syncDayNightButtonsUI();
  drawMasterplanRender(true);
  if (tour360.sphereMesh) {
    loadRoom360(state.activeRoom360Id, { crossfade: state.activeView === 'tour360', preserveView: true });
  }
  if (document.getElementById('modal-renders-gallery')?.classList.contains('open')) renderGalleryModalContent(null, true);
  if (document.getElementById('modal-photo-viewer')?.classList.contains('open')) syncPhotoLightboxImage(true);
}

function openPhotoLightbox(url, caption = 'Vista Renderizada', nightUrl = null) {
  const modal = document.getElementById('modal-photo-viewer');
  const img = document.getElementById('photo-viewer-img');
  const cap = document.getElementById('photo-viewer-caption');
  if (!modal || !img || !url) return;
  activeLightboxState = { dayUrl: url, nightUrl: nightUrl || null, caption };
  if (cap) cap.textContent = caption;
  syncPhotoLightboxImage();
  modal.classList.add('open');
}

function getRooms360ForScope(levelId = null) {
  if (!levelId || levelId === 'facade' || levelId === 'masterplan') return state.rooms360;
  return state.rooms360.filter((r) => r.levelId === levelId);
}

function renderTour360FloorsPanel() {
  const stack = document.getElementById('tour360-floors-stack');
  if (!stack) return;
  stack.innerHTML = '';

  const allBtn = document.createElement('button');
  allBtn.type = 'button';
  allBtn.className = `tour360-floor-btn ${!state.activeTour360LevelId ? 'active' : ''}`;
  allBtn.dataset.tourFloorId = 'all';
  allBtn.innerHTML = `<span>🌐 Todos los pisos</span><small>${state.rooms360.length}</small>`;
  allBtn.addEventListener('click', () => openFloorTour360(null, null, false));
  stack.appendChild(allBtn);

  const realLevels = (state.levels || []).filter((l) => l && l.id !== 'facade' && l.id !== 'masterplan');
  const editorMode = isEditor();

  realLevels.forEach((lvl) => {
    const roomsInFloor = state.rooms360.filter((r) => r.levelId === lvl.id);
    if (!editorMode && (lvl.hasTour360 === false || roomsInFloor.length === 0)) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    const isAct = state.activeTour360LevelId === lvl.id;
    btn.className = `tour360-floor-btn ${isAct ? 'active' : ''} ${roomsInFloor.length === 0 ? 'is-empty' : ''}`;
    btn.dataset.tourFloorId = lvl.id;
    const countTxt = lvl.hasTour360 === false ? '🚫' : String(roomsInFloor.length);
    btn.innerHTML = `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(lvl.name || lvl.badge)}</span><small>${countTxt}</small>`;
    btn.title = lvl.name;
    btn.addEventListener('click', () => openFloorTour360(lvl.id, null, false));
    stack.appendChild(btn);
  });
}

async function openFloorTour360(levelId = null, preferredRoomId = null, allowTransition = true) {
  const targetScope = (levelId && levelId !== 'facade' && levelId !== 'masterplan') ? levelId : null;
  if (targetScope) {
    const lvl = state.levels.find((l) => l.id === targetScope);
    if (lvl && lvl.hasTour360 === false && !isEditor()) {
      showToast(`La panorámica está desactivada en ${lvl.name}`);
      return;
    }
  }
  pushNavHistory();
  state.activeTour360LevelId = targetScope;
  const scopedRooms = getRooms360ForScope(targetScope);
  const chosenRoom = (preferredRoomId && scopedRooms.find((r) => r.id === preferredRoomId))
    || (preferredRoomId && state.rooms360.find((r) => r.id === preferredRoomId))
    || scopedRooms[0]
    || null;
  await switchView('tour360', allowTransition, true);
  loadRoom360(chosenRoom ? chosenRoom.id : null);
  renderTour360FloorsPanel();
}

function selectUnit(unitId, ensureOpen = false) {
  state.selectedUnitId = unitId;
  const unit = state.units.find((u) => u.id === unitId);
  if (!unit) return;

  if (ensureOpen) {
    document.getElementById('unit-drawer')?.classList.add('open');
    document.getElementById('restore-unit-drawer')?.classList.remove('visible');
  }

  const statusLabels = { available: 'DISPONIBLE', reserved: 'RESERVADO', sold: 'VENDIDO' };
  document.getElementById('drawer-availability-banner').className = `availability-top-banner ${unit.status}`;
  document.getElementById('drawer-banner-dot').className = `status-dot ${unit.status}`;
  document.getElementById('drawer-status-text').textContent = statusLabels[unit.status] || 'DISPONIBLE';

  document.getElementById('drawer-title').textContent = unit.code;
  document.getElementById('drawer-subtitle').textContent = `${unit.floorLabel || 'Torre Principal'} · ${unit.orientation || 'Vista'}`;
  document.getElementById('drawer-area').textContent = `${unit.area} m²`;
  document.getElementById('drawer-beds').textContent = `${unit.beds} ${unit.beds === 1 ? 'Cto' : 'Ctos'}`;
  document.getElementById('drawer-baths').textContent = `${unit.baths ?? 2} ${(unit.baths ?? 2) === 1 ? 'Baño' : 'Baños'}`;
  document.getElementById('drawer-kitchens').textContent = `${unit.kitchens ?? 1} Cocina`;
  document.getElementById('drawer-price').textContent = `$${Number(unit.price).toLocaleString()} USD`;

  const currentLvl = state.levels.find((l) => l.id === state.activeLevelId);
  const targetLvl = state.levels.find((l) => l.id === (unit.targetLevelId || unit.levelId)) || state.levels[0];
  const previewWrap = document.getElementById('drawer-floor-preview-wrap');
  const goFloorBtn = document.getElementById('btn-drawer-transition-to-floor');
  const isSameLevel = targetLvl && targetLvl.id === state.activeLevelId;
  if (previewWrap) previewWrap.style.display = isSameLevel ? 'none' : 'block';
  if (goFloorBtn) goFloorBtn.style.display = isSameLevel ? 'none' : 'inline-flex';
  if (targetLvl) {
    document.getElementById('drawer-floor-label').textContent = targetLvl.name;
    document.getElementById('drawer-floor-photo-preview').src = targetLvl.dayPhoto;
  }

  // Show or hide the floor's 360° button based on the current/target floor's hasTour360 setting
  const floorFor360 = (state.activeLevelId !== 'facade' && currentLvl) ? currentLvl : targetLvl;
  const btn360 = document.getElementById('btn-drawer-go-360');
  if (btn360) {
    const allow360 = floorFor360 ? floorFor360.hasTour360 !== false : true;
    btn360.style.display = allow360 ? 'inline-flex' : 'none';
  }

  // Render Unlimited Custom Lines (Texto + Número + Unidad OR Descripción Libre)
  const linesEl = document.getElementById('drawer-custom-lines');
  if (linesEl) {
    linesEl.innerHTML = '';
    const lines = Array.isArray(unit.customLines) ? unit.customLines : [];
    lines.forEach((line) => {
      const div = document.createElement('div');
      if (line.type === 'text') {
        div.className = 'custom-line-desc';
        div.textContent = line.label || '';
      } else {
        div.className = 'custom-line-row';
        const valStr = [line.number, line.unit].filter(Boolean).join(' ');
        div.innerHTML = `<span class="cl-label">${line.label || ''}</span><span class="cl-val">${valStr}</span>`;
      }
      linesEl.appendChild(div);
    });
  }

  // Render Unlimited Custom Action Buttons (Render Photo OR Floor 360° View)
  const btnsEl = document.getElementById('drawer-custom-buttons');
  if (btnsEl) {
    btnsEl.innerHTML = '';
    const cBtns = Array.isArray(unit.customButtons) ? unit.customButtons : [];
    cBtns.forEach((cb) => {
      const b = document.createElement('button');
      b.className = 'custom-view-btn';
      const icon = cb.actionType === 'tour360' ? '🌐' : '🖼️';
      const tag = cb.actionType === 'tour360' ? '360° →' : 'Render →';
      b.innerHTML = `<span>${icon} ${cb.label}</span><small style="opacity:0.8;">${tag}</small>`;
      b.addEventListener('click', async () => {
        if (cb.actionType === 'tour360') {
          const scopeLvl = state.activeLevelId !== 'facade' ? state.activeLevelId : (unit.targetLevelId || null);
          await openFloorTour360(scopeLvl, cb.targetRoom360Id || null, true);
        } else {
          const photoSrc = cb.photoMediaKey ? (await getMediaUrl(cb.photoMediaKey)) || cb.photoUrl : cb.photoUrl;
          const nightSrc = cb.nightPhotoMediaKey ? (await getMediaUrl(cb.nightPhotoMediaKey)) || cb.nightPhotoUrl : (cb.nightPhotoUrl || null);
          if (photoSrc) openPhotoLightbox(photoSrc, cb.label, nightSrc);
          else showToast('Este botón aún no tiene una foto asignada');
        }
      });
      btnsEl.appendChild(b);
    });
  }

  applyFieldVisibilityToDrawer(unit);
  renderMasterplanOverlays();
}

function applyFieldVisibilityToDrawer(activeUnit = null) {
  const unit = activeUnit || state.units.find((u) => u.id === state.selectedUnitId);
  const vf = state.visibleFields;
  const showUnitAvail = vf.availability && (!unit || unit.showAvailability !== false);
  document.getElementById('drawer-availability-banner').style.display = showUnitAvail ? 'flex' : 'none';
  document.getElementById('field-wrap-name').style.display = vf.name ? 'block' : 'none';
  document.getElementById('field-wrap-area').style.display = vf.area ? 'block' : 'none';
  document.getElementById('field-wrap-rooms').style.display = vf.rooms ? 'block' : 'none';
  document.getElementById('field-wrap-baths').style.display = vf.baths ? 'block' : 'none';
  document.getElementById('field-wrap-kitchen').style.display = vf.kitchen ? 'block' : 'none';
  document.getElementById('field-wrap-price').style.display = vf.price ? 'block' : 'none';
}

function renderLevelsSidebar() {
  const container = document.getElementById('levels-list');
  if (!container) return;
  container.innerHTML = '';

  state.levels.forEach((lvl) => {
    const btn = document.createElement('button');
    btn.className = `level-btn ${state.activeLevelId === lvl.id ? 'active' : ''}`;
    const transBadge = lvl.transitionType === 'two_images' ? '🖼️ ' : (lvl.hasTour360 === false ? '🚫360 ' : '');
    btn.innerHTML = `<span>${lvl.name}</span><small>${transBadge}${lvl.badge}</small>`;
    btn.addEventListener('click', () => {
      if (lvl.id === state.activeLevelId) return;
      navigateToLevelWithTransition(lvl.id, 'auto', true);
    });
    container.appendChild(btn);
  });
}

function stepMasterplanLevel(dir) {
  const idx = state.levels.findIndex((l) => l.id === state.activeLevelId);
  const nextIdx = Math.max(0, Math.min(state.levels.length - 1, idx + dir));
  if (nextIdx !== idx) navigateToLevelWithTransition(state.levels[nextIdx].id, 'auto', true);
}

/* --- DYNAMIC CUSTOM LINES & CUSTOM BUTTONS BUILDER STATE FOR POLYGON MODAL --- */
let draftCustomLines = [];
let draftCustomButtons = [];
let pendingNewBtnFile = { url: null, mediaKey: null, name: null };
let pendingNewBtnNightFile = { url: null, mediaKey: null, name: null };
let pendingNewBtnPoint = null;

function syncNewLineTypeInputs() {
  const t = document.getElementById('new-line-type')?.value || 'metric';
  const nw = document.getElementById('new-line-num-wrap');
  const uw = document.getElementById('new-line-unit-wrap');
  if (nw) nw.style.display = t === 'metric' ? 'flex' : 'none';
  if (uw) uw.style.display = t === 'metric' ? 'flex' : 'none';
}

function syncNewBtnTypeUI() {
  const t = document.getElementById('new-btn-action-type')?.value || 'photo';
  const sel360 = document.getElementById('new-btn-existing-360');
  const lbl = document.getElementById('new-btn-file-lbl');
  const nightWrap = document.getElementById('new-btn-night-upload-wrap');
  const clrNightBtn = document.getElementById('btn-clear-new-btn-night');
  const nightLbl = document.getElementById('new-btn-night-file-lbl');
  if (sel360) {
    sel360.style.display = t === 'tour360' ? 'block' : 'none';
    if (t === 'tour360') {
      sel360.innerHTML = '<option value="">-- O elegir vista 360° existente --</option>';
      state.rooms360.forEach((r) => {
        const o = document.createElement('option');
        o.value = r.id;
        o.textContent = `${r.name}${r.levelId ? ` (${r.levelId})` : ''}`;
        sel360.appendChild(o);
      });
    }
  }
  if (lbl && !pendingNewBtnFile.name) {
    lbl.textContent = t === 'tour360' ? 'Subir nueva foto 360° (opcional)' : 'Subir Foto Render asignada';
  }
  if (nightWrap) nightWrap.style.display = t === 'photo' ? 'inline-flex' : 'none';
  if (clrNightBtn) clrNightBtn.style.display = (t === 'photo' && pendingNewBtnNightFile.url) ? 'inline-flex' : 'none';
  if (nightLbl) nightLbl.textContent = pendingNewBtnNightFile.name ? `🌙 ${pendingNewBtnNightFile.name}` : 'Subir Nocturna (Opcional)';
}

function renderDraftCustomLines() {
  const list = document.getElementById('poly-custom-lines-list');
  if (!list) return;
  list.innerHTML = '';
  if (draftCustomLines.length === 0) {
    list.innerHTML = '<span style="font-size:10px;color:var(--ink-muted);">Sin líneas extra aún. Añade cuantas necesites abajo (ej: Baño · 120 · m²).</span>';
    return;
  }
  draftCustomLines.forEach((line, idx) => {
    const row = document.createElement('div');
    row.className = 'builder-item-row';
    const text = line.type === 'text'
      ? `📄 ${line.label}`
      : `📐 <strong>${line.label}</strong>: <span style="color:var(--gold-bright);">${line.number} ${line.unit}</span>`;
    row.innerHTML = `<span>${text}</span><button type="button" class="icon-btn" data-rm-line="${idx}" style="width:22px;height:22px;color:#f87171;">✕</button>`;
    row.querySelector('[data-rm-line]').addEventListener('click', () => {
      draftCustomLines.splice(idx, 1);
      renderDraftCustomLines();
    });
    list.appendChild(row);
  });
}

function renderDraftCustomButtons() {
  const list = document.getElementById('poly-custom-buttons-list');
  if (!list) return;
  list.innerHTML = '';
  if (draftCustomButtons.length === 0) {
    list.innerHTML = '<span style="font-size:10px;color:var(--ink-muted);">Sin botones extra. Crea botones ilimitados para abrir fotos render o vistas 360°.</span>';
    return;
  }
  draftCustomButtons.forEach((btn, idx) => {
    const row = document.createElement('div');
    row.className = 'builder-item-row';
    const badge = btn.actionType === 'tour360' ? '🌐 Vista 360°' : '🖼️ Foto Render';
    const nightTag = btn.nightPhotoUrl ? ' · 🌙 Nocturna' : '';
    const planTag = btn.showOnPlan
      ? ` · <span style="display:inline-flex;align-items:center;gap:4px;"><i style="width:9px;height:9px;border-radius:50%;background:${btn.pinColor || '#d4af37'};display:inline-block;border:1px solid #fff;"></i>Punto en Planta</span>`
      : ' · Lista';
    row.innerHTML = `
      <span><strong style="color:var(--gold-bright);">${btn.label}</strong> <small style="opacity:0.78;">(${badge}${nightTag}${planTag})</small></span>
      <button type="button" class="icon-btn" data-rm-btn="${idx}" style="width:22px;height:22px;color:#f87171;">✕</button>
    `;
    row.querySelector('[data-rm-btn]').addEventListener('click', () => {
      draftCustomButtons.splice(idx, 1);
      renderDraftCustomButtons();
    });
    list.appendChild(row);
  });
}

function openPolygonEditorModal(existingUnit = null) {
  if (!isEditor()) return;
  const modal = document.getElementById('modal-polygon-editor');
  const targetSelect = document.getElementById('poly-input-target-level');
  targetSelect.innerHTML = '';
  state.levels.forEach((lvl) => {
    const opt = document.createElement('option');
    opt.value = lvl.id;
    opt.textContent = lvl.name;
    targetSelect.appendChild(opt);
  });

  pendingNewBtnFile = { url: null, mediaKey: null, name: null };
  pendingNewBtnNightFile = { url: null, mediaKey: null, name: null };
  pendingNewBtnPoint = null;
  document.getElementById('new-line-label').value = '';
  document.getElementById('new-line-number').value = '';
  document.getElementById('new-line-unit').value = 'm²';
  document.getElementById('new-btn-label').value = '';
  document.getElementById('new-btn-file-lbl').textContent = 'Subir Foto Render asignada';
  const nBtnLbl = document.getElementById('new-btn-night-file-lbl');
  if (nBtnLbl) nBtnLbl.textContent = 'Subir Nocturna (Opcional)';
  const clrNightBtn = document.getElementById('btn-clear-new-btn-night');
  if (clrNightBtn) clrNightBtn.style.display = 'none';
  const showPlanCb = document.getElementById('new-btn-show-on-plan');
  const planOpts = document.getElementById('new-btn-plan-point-opts');
  const ptLbl = document.getElementById('new-btn-point-coords-lbl');
  if (showPlanCb) showPlanCb.checked = false;
  if (planOpts) planOpts.style.display = 'none';
  if (ptLbl) ptLbl.textContent = 'Ubicación: Automática (centro)';

  if (existingUnit) {
    state.editingPolygonUnitId = existingUnit.id;
    document.getElementById('poly-input-name').value = existingUnit.code;
    document.getElementById('poly-input-btn-text').value = existingUnit.buttonText || existingUnit.code;
    document.getElementById('poly-input-show-avail').checked = existingUnit.showAvailability !== false;
    document.getElementById('poly-input-status').value = existingUnit.status || 'available';
    document.getElementById('poly-input-price').value = existingUnit.price;
    document.getElementById('poly-input-area').value = existingUnit.area;
    document.getElementById('poly-input-beds').value = existingUnit.beds;
    document.getElementById('poly-input-baths').value = existingUnit.baths ?? 2;
    document.getElementById('poly-input-kitchens').value = existingUnit.kitchens ?? 1;
    targetSelect.value = existingUnit.targetLevelId || state.activeLevelId;
    draftCustomLines = structuredClone(existingUnit.customLines || []);
    draftCustomButtons = structuredClone(existingUnit.customButtons || []);
  } else {
    state.editingPolygonUnitId = null;
    const nextNum = state.units.length + 1;
    document.getElementById('poly-input-name').value = state.activeLevelId === 'facade' ? `Piso / Unidad ${nextNum}` : `Ambiente ${nextNum}`;
    document.getElementById('poly-input-btn-text').value = state.activeLevelId === 'facade' ? `Unidad ${nextNum} · 150 m²` : `Ambiente ${nextNum}`;
    document.getElementById('poly-input-show-avail').checked = true;
    document.getElementById('poly-input-status').value = 'available';
    document.getElementById('poly-input-price').value = '165000';
    document.getElementById('poly-input-area').value = '150';
    document.getElementById('poly-input-beds').value = '3';
    document.getElementById('poly-input-baths').value = '2';
    document.getElementById('poly-input-kitchens').value = '1';
    targetSelect.value = state.activeLevelId === 'facade' ? 'floor-9' : state.activeLevelId;
    draftCustomLines = [];
    draftCustomButtons = [];
  }

  syncNewLineTypeInputs();
  syncNewBtnTypeUI();
  renderDraftCustomLines();
  renderDraftCustomButtons();
  modal.classList.add('open');
}

function savePolygonFromModal() {
  if (!isEditor()) return;
  const name = document.getElementById('poly-input-name').value.trim() || 'Ambiente';
  const buttonText = document.getElementById('poly-input-btn-text').value.trim() || name;
  const showAvailability = document.getElementById('poly-input-show-avail').checked;
  const status = document.getElementById('poly-input-status').value;
  const price = Number(document.getElementById('poly-input-price').value) || 0;
  const area = Number(document.getElementById('poly-input-area').value) || 0;
  const beds = Number(document.getElementById('poly-input-beds').value) || 0;
  const baths = Number(document.getElementById('poly-input-baths').value) || 0;
  const kitchens = Number(document.getElementById('poly-input-kitchens').value) || 0;
  const targetLevelId = document.getElementById('poly-input-target-level').value || state.activeLevelId;
  const customLines = structuredClone(draftCustomLines);
  const customButtons = structuredClone(draftCustomButtons);

  if (state.editingPolygonUnitId) {
    const u = state.units.find((x) => x.id === state.editingPolygonUnitId);
    if (u) Object.assign(u, { code: name, buttonText, showAvailability, status, price, area, beds, baths, kitchens, targetLevelId, customLines, customButtons });
    savePersistedState();
    selectUnit(state.editingPolygonUnitId, true);
    showToast('Polígono y panel actualizados');
  } else if (state.draftPolygonPoints.length >= 3) {
    const cx = state.draftPolygonPoints.reduce((s, p) => s + p.x, 0) / state.draftPolygonPoints.length;
    const cy = state.draftPolygonPoints.reduce((s, p) => s + p.y, 0) / state.draftPolygonPoints.length;
    const newId = `u-poly-${Date.now()}`;
    const activeLvl = state.levels.find((l) => l.id === state.activeLevelId);
    state.units.push({
      id: newId, code: name, buttonText, type: 'Ambiente / Unidad',
      levelId: state.activeLevelId, targetLevelId, transitionVideo: 'auto',
      floorNum: activeLvl?.floorNum || 1, floorLabel: activeLvl?.name || 'Planta',
      area, beds, baths, kitchens, price, orientation: 'Vista', status, showAvailability,
      defaultRoom360: getRooms360ForScope(state.activeLevelId)[0]?.id || 'living',
      customLines, customButtons,
      center: { x: cx, y: cy }, polygon: [...state.draftPolygonPoints]
    });
    state.isDrawingPolygon = false;
    state.draftPolygonPoints = [];
    state.showAvailability = true;
    document.getElementById('btn-draw-polygon').classList.remove('active');
    document.getElementById('polygon-draw-toolbar').classList.remove('active');
    savePersistedState();
    selectUnit(newId, true);
    showToast(`Polígono "${name}" guardado`);
  }
  document.getElementById('modal-polygon-editor').classList.remove('open');
}

let activeGalleryItemId = null;

function renderGalleryModalContent(activeId = null, animateCrossfade = false) {
  const mainImg = document.getElementById('gallery-main-img');
  const overlayImg = document.getElementById('gallery-crossfade-img');
  const mainCap = document.getElementById('gallery-main-caption');
  const row = document.getElementById('gallery-thumbs-row');
  if (!mainImg || !row) return;

  const targetId = activeId || activeGalleryItemId;
  const current = state.renderedViewsGallery.find((g) => g.id === targetId) || state.renderedViewsGallery[0];
  activeGalleryItemId = current?.id || null;
  if (current) {
    const nextUrl = (state.isNightMode && current.nightUrl) ? current.nightUrl : current.url;
    crossfadeImageElement(mainImg, overlayImg, nextUrl, 'gallery', animateCrossfade && Boolean(current.nightUrl));
    mainImg.style.filter = 'none';
    mainCap.textContent = current.title;
  }

  const clrNightBtn = document.getElementById('btn-clear-gallery-night');
  if (clrNightBtn) clrNightBtn.style.display = current?.nightUrl ? 'inline-flex' : 'none';
  syncDayNightButtonsUI();

  row.innerHTML = '';
  state.renderedViewsGallery.forEach((item) => {
    const btn = document.createElement('button');
    btn.className = `room-thumb-card ${current?.id === item.id ? 'active' : ''}`;
    btn.innerHTML = `<img src="${item.url}" alt="" style="width:44px;height:30px;object-fit:cover;border-radius:5px;" /> <span>${item.title}${item.nightUrl ? ' 🌙' : ''}</span>`;
    btn.addEventListener('click', () => renderGalleryModalContent(item.id));
    row.appendChild(btn);
  });
}

/* ==========================================================================
   5. PRO 360° LOSSLESS VIEWER (FLOOR RING TARGET + NUMBERED WHITE PAGINATOR + PER-FLOOR 360°)
   ========================================================================== */
const FLOOR_RING_SVG = `<svg viewBox="0 0 100 56" width="82" height="46" aria-hidden="true"><ellipse cx="50" cy="28" rx="42" ry="21" fill="none" stroke="#ffffff" stroke-width="8.5" /><ellipse cx="50" cy="28" rx="20" ry="10.5" fill="#ffffff" /></svg>`;

const ARROW_SVGS = {
  up: `<svg viewBox="0 0 24 24"><path d="M12 19V5"/><path d="M5 12l7-7 7 7"/></svg>`,
  'up-right': `<svg viewBox="0 0 24 24"><path d="M7 17L17 7"/><path d="M8 7h9v9"/></svg>`,
  'up-left': `<svg viewBox="0 0 24 24"><path d="M17 17L7 7"/><path d="M16 7H7v9"/></svg>`,
  door: `<svg viewBox="0 0 24 24"><path d="M5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16"/><path d="M3 21h18"/><circle cx="14.5" cy="12" r="1.2" fill="#060608"/></svg>`,
  back: `<svg viewBox="0 0 24 24"><path d="M9 14L4 9l5-5"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg>`
};

function getArrowSvg(type) {
  if (type === '⬆️' || type === 'up') return ARROW_SVGS.up;
  if (type === '↗️' || type === 'up-right') return ARROW_SVGS['up-right'];
  if (type === '↖️' || type === 'up-left') return ARROW_SVGS['up-left'];
  if (type === '🚪' || type === 'door') return ARROW_SVGS.door;
  if (type === '🔄' || type === 'back') return ARROW_SVGS.back;
  return ARROW_SVGS.up;
}

let tour360 = {
  scene: null,
  camera: null,
  renderer: null,
  sphereMesh: null,
  currentTexture: null,
  isUserInteracting: false,
  lon: 0,
  lat: 0,
  onPointerDownLon: 0,
  onPointerDownLat: 0,
  onPointerDownX: 0,
  onPointerDownY: 0,
  autoRotate: false,
  hotspotElements: [],
  gyroEnabled: false,
  gyroAutoAttempted: false,
  gyroListenerBound: false,
  gyroBaselineAlpha: null,
  gyroBaselineBeta: null,
  gyroBaselineGamma: null,
  gyroBaseLon: 0,
  gyroBaseLat: 0,
  gyroLastMoveAt: 0,
  loadSeq: 0
};

function handleTour360DeviceOrientation(e) {
  if (!tour360.gyroEnabled || state.activeView !== 'tour360') return;
  if (e.alpha == null && e.beta == null && e.gamma == null) return;
  const alpha = Number(e.alpha) || 0;
  const beta = Number(e.beta) || 0;
  const gamma = Number(e.gamma) || 0;

  if (tour360.gyroBaselineAlpha === null) {
    tour360.gyroBaselineAlpha = alpha;
    tour360.gyroBaselineBeta = beta;
    tour360.gyroBaselineGamma = gamma;
    tour360.gyroBaseLon = tour360.lon;
    tour360.gyroBaseLat = tour360.lat;
    return;
  }

  let dAlpha = alpha - tour360.gyroBaselineAlpha;
  while (dAlpha > 180) dAlpha -= 360;
  while (dAlpha < -180) dAlpha += 360;
  const dBeta = beta - tour360.gyroBaselineBeta;
  const dGamma = gamma - tour360.gyroBaselineGamma;

  if (!tour360.isUserInteracting) {
    const rawAngle = window.screen?.orientation?.angle ?? window.orientation ?? 0;
    const orientAngle = ((Math.round(Number(rawAngle) || 0) % 360) + 360) % 360;
    let adjPitch = dBeta;
    if (orientAngle === 90) adjPitch = -dGamma;
    else if (orientAngle === 270) adjPitch = dGamma;
    else if (orientAngle === 180) adjPitch = -dBeta;
    tour360.lon = tour360.gyroBaseLon - dAlpha;
    tour360.lat = Math.max(-85, Math.min(85, tour360.gyroBaseLat + adjPitch * 0.85));
    if (Math.abs(dAlpha) > 0.4 || Math.abs(adjPitch) > 0.4) {
      tour360.gyroLastMoveAt = Date.now();
    }
  }
}

async function toggleTour360Gyroscope(forceState = null, fromUserTap = false) {
  const btn = document.getElementById('btn-360-gyro');
  if (typeof window.DeviceOrientationEvent === 'undefined') {
    if (fromUserTap) showToast('Este navegador no reporta sensor de movimiento');
    return false;
  }
  const wantEnable = forceState === null ? !tour360.gyroEnabled : Boolean(forceState);
  if (wantEnable) {
    if (fromUserTap && typeof window.DeviceOrientationEvent.requestPermission === 'function') {
      try {
        const perm = await window.DeviceOrientationEvent.requestPermission();
        if (perm !== 'granted') {
          showToast('Permiso de sensor denegado');
          return false;
        }
      } catch (_) {
        showToast('No se pudo solicitar permiso del sensor');
        return false;
      }
    }
    if (!tour360.gyroListenerBound) {
      window.addEventListener('deviceorientation', handleTour360DeviceOrientation);
      tour360.gyroListenerBound = true;
    }
    tour360.gyroBaselineAlpha = null;
    tour360.gyroBaselineBeta = null;
    tour360.gyroBaselineGamma = null;
    tour360.gyroEnabled = true;
    btn?.classList.add('active');
    if (fromUserTap) showToast('📱 Sensor giroscópico activado');
    return true;
  }
  tour360.gyroEnabled = false;
  tour360.gyroBaselineAlpha = null;
  tour360.gyroBaselineBeta = null;
  tour360.gyroBaselineGamma = null;
  btn?.classList.remove('active');
  if (fromUserTap) showToast('Sensor giroscópico desactivado');
  return false;
}

function generateEquirectangularPanoramaTexture(room, isNight) {
  const canvas = document.createElement('canvas');
  canvas.width = 4096;
  canvas.height = 2048;
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;

  const bg = ctx.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#07070a');
  bg.addColorStop(0.26, '#141318');
  bg.addColorStop(0.72, room.themeColor || '#161410');
  bg.addColorStop(0.73, '#261c10');
  bg.addColorStop(1, '#0e0b07');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = 'rgba(212, 175, 55, 0.22)';
  ctx.lineWidth = 3;
  for (let y = h * 0.74; y < h; y += 56) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }

  for (let i = 0; i < 4; i++) {
    const x = i * (w / 4) + 150;
    const winW = w / 4 - 300;
    const winY = h * 0.27;
    const winH = h * 0.45;
    ctx.fillStyle = isNight ? '#050811' : '#1e293b';
    ctx.fillRect(x, winY, winW, winH);
    ctx.fillStyle = 'rgba(245, 215, 127, 0.32)';
    ctx.fillRect(x, winY + winH * 0.68, winW, winH * 0.32);
    ctx.strokeStyle = '#d4af37';
    ctx.lineWidth = 10;
    ctx.strokeRect(x, winY, winW, winH);
  }

  ctx.fillStyle = 'rgba(7, 7, 10, 0.85)';
  ctx.fillRect(w * 0.34, h * 0.39, w * 0.32, 180);
  ctx.strokeStyle = '#d4af37';
  ctx.lineWidth = 5;
  ctx.strokeRect(w * 0.34, h * 0.39, w * 0.32, 180);
  ctx.fillStyle = '#f5d77f';
  ctx.font = '700 52px "Cinzel", serif';
  ctx.textAlign = 'center';
  ctx.fillText(room.name.toUpperCase(), w * 0.5, h * 0.435);
  ctx.fillStyle = '#faf8f5';
  ctx.font = '500 34px "Jost", sans-serif';
  ctx.fillText(room.subtitle || '', w * 0.5, h * 0.465);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  if (tour360.renderer) tex.anisotropy = tour360.renderer.capabilities.getMaxAnisotropy();
  return tex;
}

function loadLossless360Texture(url, onReady) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    const maxGpu = tour360.renderer ? tour360.renderer.capabilities.maxTextureSize : 8192;
    let source = img;
    let finalW = img.naturalWidth;
    let finalH = img.naturalHeight;

    if (finalW > maxGpu || finalH > maxGpu) {
      const ratio = Math.min(maxGpu / finalW, maxGpu / finalH);
      finalW = Math.floor(finalW * ratio);
      finalH = Math.floor(finalH * ratio);
      const off = document.createElement('canvas');
      off.width = finalW;
      off.height = finalH;
      const ctx = off.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, finalW, finalH);
      source = off;
    }

    const tex = new THREE.Texture(source);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    if (tour360.renderer) tex.anisotropy = tour360.renderer.capabilities.getMaxAnisotropy();
    tex.needsUpdate = true;
    onReady(tex, img.naturalWidth, img.naturalHeight);
  };
  img.src = url;
}

function initTour360Viewer() {
  const container = document.getElementById('tour360-container');
  if (!container) return;

  const w = container.clientWidth || window.innerWidth;
  const h = container.clientHeight || window.innerHeight;

  tour360.scene = new THREE.Scene();
  tour360.camera = new THREE.PerspectiveCamera(65, w / h, 1, 1100);

  const geo = new THREE.SphereGeometry(500, 96, 64);
  geo.scale(-1, 1, 1);

  tour360.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  tour360.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 3));
  tour360.renderer.outputColorSpace = THREE.SRGBColorSpace;
  tour360.renderer.toneMapping = THREE.NoToneMapping;
  tour360.renderer.setSize(w, h);
  container.appendChild(tour360.renderer.domElement);

  const initialTex = generateEquirectangularPanoramaTexture(state.rooms360[0], state.isNightMode);
  tour360.currentTexture = initialTex;
  tour360.sphereMesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: initialTex }));
  tour360.scene.add(tour360.sphereMesh);

  const domEl = tour360.renderer.domElement;
  domEl.style.cursor = 'grab';

  domEl.addEventListener('pointerdown', (e) => {
    document.getElementById('tour360-drag-hint')?.classList.add('hidden');
    if (isEditor() && state.isPlacingHotspot360) {
      openHotspot360Modal(e, null);
      return;
    }
    tour360.isUserInteracting = true;
    domEl.style.cursor = 'grabbing';
    tour360.onPointerDownX = e.clientX;
    tour360.onPointerDownY = e.clientY;
    tour360.onPointerDownLon = tour360.lon;
    tour360.onPointerDownLat = tour360.lat;
  });

  window.addEventListener('pointermove', (e) => {
    if (!tour360.isUserInteracting) return;
    tour360.lon = (tour360.onPointerDownX - e.clientX) * 0.16 + tour360.onPointerDownLon;
    tour360.lat = (e.clientY - tour360.onPointerDownY) * 0.16 + tour360.onPointerDownLat;
  });

  window.addEventListener('pointerup', () => {
    if (tour360.isUserInteracting && tour360.gyroEnabled) {
      tour360.gyroBaselineAlpha = null;
      tour360.gyroBaselineBeta = null;
      tour360.gyroBaselineGamma = null;
    }
    tour360.isUserInteracting = false;
    domEl.style.cursor = (isEditor() && state.isPlacingHotspot360) ? 'crosshair' : 'grab';
  });

  domEl.addEventListener('wheel', (e) => {
    e.preventDefault();
    tour360.camera.fov = Math.max(30, Math.min(92, tour360.camera.fov + e.deltaY * 0.035));
    tour360.camera.updateProjectionMatrix();
  }, { passive: false });

  loadRoom360(state.activeRoom360Id);
}

function stepRoom360(dir) {
  const scoped = getRooms360ForScope(state.activeTour360LevelId);
  if (scoped.length === 0) return;
  const idx = scoped.findIndex((r) => r.id === state.activeRoom360Id);
  const safeIdx = idx >= 0 ? idx : 0;
  const next = (safeIdx + dir + scoped.length) % scoped.length;
  loadRoom360(scoped[next].id);
}

function disposeTour360FadeMesh() {
  if (!tour360.fadeMesh) return;
  try {
    if (tour360.scene) tour360.scene.remove(tour360.fadeMesh);
    if (tour360.fadeMesh.material?.map) tour360.fadeMesh.material.map.dispose();
    tour360.fadeMesh.material?.dispose();
    tour360.fadeMesh.geometry?.dispose();
  } catch (_) {}
  tour360.fadeMesh = null;
  tour360.fadeStartTime = 0;
}

function startTour360Crossfade(oldTexture) {
  if (!oldTexture || !tour360.scene) return;
  disposeTour360FadeMesh();
  const geo = new THREE.SphereGeometry(495, 48, 32);
  geo.scale(-1, 1, 1);
  const mat = new THREE.MeshBasicMaterial({
    map: oldTexture,
    transparent: true,
    opacity: 1,
    depthWrite: false
  });
  tour360.fadeMesh = new THREE.Mesh(geo, mat);
  tour360.fadeMesh.renderOrder = 2;
  tour360.scene.add(tour360.fadeMesh);
  tour360.fadeStartTime = performance.now();
}

function resetTour360CameraToCenter() {
  tour360.lon = 0;
  tour360.lat = 0;
  tour360.gyroBaselineAlpha = null;
  tour360.gyroBaselineBeta = null;
  tour360.gyroBaselineGamma = null;
  if (tour360.camera) {
    tour360.camera.fov = 65;
    tour360.camera.updateProjectionMatrix();
  }
}

function loadRoom360(roomId, opts = {}) {
  const reqSeq = ++tour360.loadSeq;
  const prevRoomId = state.activeRoom360Id;
  if (!opts.preserveView) {
    resetTour360CameraToCenter();
  }
  state.activeRoom360Id = roomId;
  let scoped = getRooms360ForScope(state.activeTour360LevelId);
  let room = null;
  if (roomId) {
    room = scoped.find((r) => r.id === roomId) || state.rooms360.find((r) => r.id === roomId) || null;
    if (room && state.activeTour360LevelId && room.levelId !== state.activeTour360LevelId) {
      state.activeTour360LevelId = room.levelId || null;
      scoped = getRooms360ForScope(state.activeTour360LevelId);
    }
  }
  if (!room) {
    room = scoped[0] || (!state.activeTour360LevelId ? state.rooms360[0] : null);
  }

  const ctxLbl = document.getElementById('tour360-floor-context');
  const activeLvl = state.activeTour360LevelId
    ? state.levels.find((l) => l.id === state.activeTour360LevelId)
    : null;

  if (ctxLbl) {
    ctxLbl.textContent = activeLvl ? `Panorámica · ${activeLvl.name || activeLvl.badge}` : 'Panorámica HD';
  }

  const titleEl = document.getElementById('tour360-current-room-title');
  const qualityEl = document.getElementById('tour360-quality-badge');
  const containerEl = document.getElementById('tour360-container');
  const clrNight360 = document.getElementById('btn-clear-360-night');

  const isSameRoomCrossfade = Boolean(opts.crossfade && room && room.id === prevRoomId && room.customNightImageUrl);

  const applyTex = (tex, badgeText, useCrossfade = false) => {
    if (!tour360.sphereMesh) return;
    const prevTex = tour360.currentTexture;
    if (useCrossfade && prevTex && prevTex !== tex) {
      startTour360Crossfade(prevTex);
    } else {
      disposeTour360FadeMesh();
      if (prevTex && prevTex !== tex) prevTex.dispose();
    }
    tour360.currentTexture = tex;
    tour360.sphereMesh.material.map = tex;
    tour360.sphereMesh.material.needsUpdate = true;
    if (qualityEl) qualityEl.textContent = badgeText;
  };

  if (!room || !tour360.sphereMesh) {
    disposeTour360FadeMesh();
    if (clrNight360) clrNight360.style.display = 'none';
    if (containerEl) containerEl.dataset.loadedTexUrl = 'empty';
    if (titleEl) titleEl.textContent = activeLvl ? `Sin vistas 360° en ${activeLvl.name}` : 'Sin vistas 360°';
    if (tour360.sphereMesh) {
      const emptyTex = generateEquirectangularPanoramaTexture({
        name: activeLvl?.name || 'Piso sin Panorámica',
        subtitle: isEditor() ? 'Sube una foto 360° desde el panel izquierdo' : 'Sin vistas disponibles aún',
        themeColor: '#121216'
      }, false);
      applyTex(emptyTex, 'Sin imagen 360° en este piso', false);
    }
    syncDayNightButtonsUI();
    renderNumbered360Bar();
    syncHotspots360DOM();
    renderTour360FloorsPanel();
    return;
  }

  state.activeRoom360Id = room.id;
  if (titleEl) titleEl.textContent = room.name;
  if (clrNight360) clrNight360.style.display = room.customNightImageUrl ? 'inline-flex' : 'none';

  const prevLoadedUrl = containerEl?.dataset.loadedTexUrl || '';
  const targetUrl = (state.isNightMode && room.customNightImageUrl)
    ? room.customNightImageUrl
    : (room.customImageUrl || null);

  if (targetUrl) {
    const doFade = isSameRoomCrossfade && prevLoadedUrl && prevLoadedUrl !== targetUrl;
    if (containerEl) containerEl.dataset.loadedTexUrl = targetUrl;
    loadLossless360Texture(targetUrl, (tex, nw, nh) => {
      if (reqSeq !== tour360.loadSeq) {
        tex.dispose();
        return;
      }
      const aniso = tour360.renderer ? tour360.renderer.capabilities.getMaxAnisotropy() : 16;
      applyTex(tex, `Calidad Original: ${nw} × ${nh} px · AF ${aniso}x`, doFade);
    });
  } else {
    const nextProcKey = `procedural-${state.isNightMode ? 'night' : 'day'}`;
    const doFade = isSameRoomCrossfade && prevLoadedUrl && prevLoadedUrl !== nextProcKey;
    if (containerEl) containerEl.dataset.loadedTexUrl = nextProcKey;
    const tex = generateEquirectangularPanoramaTexture(room, state.isNightMode);
    applyTex(tex, 'Panorama 4K Demo · Calidad Nativa Sin Compresión', doFade);
  }

  syncDayNightButtonsUI();
  renderNumbered360Bar();
  syncHotspots360DOM();
  renderTour360FloorsPanel();
}

function renderNumbered360Bar() {
  const track = document.getElementById('tour360-numbers-track');
  const leftBtn = document.getElementById('btn-360-nums-left');
  const rightBtn = document.getElementById('btn-360-nums-right');
  if (!track) return;

  const scoped = getRooms360ForScope(state.activeTour360LevelId);
  track.innerHTML = '';
  scoped.forEach((room, index) => {
    const btn = document.createElement('button');
    btn.className = `tour360-num-btn ${state.activeRoom360Id === room.id ? 'active' : ''}`;
    btn.textContent = String(index + 1);
    btn.title = `Vista ${index + 1}`;
    btn.setAttribute('aria-label', `Ir a vista 360 número ${index + 1}`);
    btn.addEventListener('click', () => loadRoom360(room.id));
    track.appendChild(btn);
  });

  // Show scroll arrows when there are many numbers (or overflowing track)
  const updateArrows = () => {
    const hasMany = scoped.length > 6 || track.scrollWidth > track.clientWidth + 4;
    if (leftBtn) leftBtn.style.display = hasMany ? 'grid' : 'none';
    if (rightBtn) rightBtn.style.display = hasMany ? 'grid' : 'none';
  };
  updateArrows();
  requestAnimationFrame(updateArrows);
}

function syncHotspots360DOM() {
  const layer = document.getElementById('tour360-hotspots-layer');
  if (!layer) return;
  layer.innerHTML = '';
  tour360.hotspotElements = [];

  const room = state.rooms360.find((r) => r.id === state.activeRoom360Id);
  if (!room) return;

  room.hotspots.forEach((hs, idx) => {
    const marker = document.createElement('div');
    marker.className = 'hotspot-360-marker';
    marker.setAttribute('role', 'button');
    marker.setAttribute('tabindex', '0');

    const isFloorRing = !hs.arrow || hs.arrow === 'floor-ring';
    const iconHtml = isFloorRing
      ? `<span class="hs360-floor-ring-wrap">${FLOOR_RING_SVG}</span>`
      : `<span class="hs360-big-arrow-circle">${getArrowSvg(hs.arrow)}</span>`;

    marker.innerHTML = `
      ${hs.label ? `<span class="hs360-title-above">${hs.label}</span>` : ''}
      ${iconHtml}
      ${isEditor() ? `<button class="hs360-edit-mini" title="Editar texto y botón">✎</button><button class="hs360-delete-mini" title="Eliminar botón">✕</button>` : ''}
    `;

    marker.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.target.closest('.hs360-delete-mini, .hs360-edit-mini')) return;
      loadRoom360(hs.targetRoomId);
    });
    const editBtn = marker.querySelector('.hs360-edit-mini');
    if (editBtn) {
      editBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openHotspot360Modal(null, idx);
      });
    }
    const delBtn = marker.querySelector('.hs360-delete-mini');
    if (delBtn) {
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        room.hotspots.splice(idx, 1);
        savePersistedState();
        syncHotspots360DOM();
        showToast('Botón 360° eliminado');
      });
    }

    layer.appendChild(marker);
    tour360.hotspotElements.push({ hs, el: marker });
  });
}

function updateHotspots360Projection() {
  const container = document.getElementById('tour360-container');
  if (!container || !tour360.camera) return;

  const w = container.clientWidth;
  const h = container.clientHeight;
  if (w > 0 && h > 0 && tour360.renderer) {
    if (tour360._lastW !== w || tour360._lastH !== h) {
      tour360._lastW = w;
      tour360._lastH = h;
      tour360.camera.aspect = w / h;
      tour360.camera.updateProjectionMatrix();
      tour360.renderer.setSize(w, h, true);
    }
  }

  const normDeg = ((Math.round(tour360.lon) % 360) + 360) % 360;
  const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
  const cardinal = dirs[Math.round(normDeg / 45) % 8];
  const compEl = document.getElementById('compass-deg-label');
  if (compEl) compEl.textContent = `${cardinal} ${String(normDeg).padStart(3, '0')}°`;

  if (tour360.hotspotElements.length === 0 || !w || !h) return;
  const camDir = new THREE.Vector3();
  tour360.camera.getWorldDirection(camDir);

  tour360.hotspotElements.forEach(({ hs, el }) => {
    const phi = THREE.MathUtils.degToRad(90 - hs.lat);
    const theta = THREE.MathUtils.degToRad(hs.lon);
    const pos = new THREE.Vector3(
      400 * Math.sin(phi) * Math.cos(theta),
      400 * Math.cos(phi),
      400 * Math.sin(phi) * Math.sin(theta)
    );
    if (camDir.dot(pos.clone().normalize()) <= 0.12) { el.style.display = 'none'; return; }
    pos.project(tour360.camera);
    el.style.display = 'flex';
    el.style.left = `${(pos.x * 0.5 + 0.5) * w}px`;
    el.style.top = `${(-(pos.y * 0.5) + 0.5) * h}px`;
  });
}

function openHotspot360Modal(e, editIndex = null) {
  const room = state.rooms360.find((r) => r.id === state.activeRoom360Id);
  const existingHs = (editIndex !== null && room) ? room.hotspots[editIndex] : null;
  state.editingHotspotIndex = existingHs ? editIndex : null;

  if (!existingHs && e) {
    const rect = tour360.renderer.domElement.getBoundingClientRect();
    const mouse = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    const rc = new THREE.Raycaster();
    rc.setFromCamera(mouse, tour360.camera);
    const d = rc.ray.direction.clone().normalize();
    const clampedY = Math.max(-1, Math.min(1, d.y));
    state.pendingHotspotCoords = {
      lon: THREE.MathUtils.radToDeg(Math.atan2(d.z, d.x)),
      lat: THREE.MathUtils.radToDeg(Math.asin(clampedY))
    };
  }

  const targetSelect = document.getElementById('hs360-input-target');
  targetSelect.innerHTML = '';
  const scoped = getRooms360ForScope(state.activeTour360LevelId);
  const pool = scoped.length > 0 ? scoped : state.rooms360;
  pool.forEach((r, idx) => {
    const opt = document.createElement('option');
    opt.value = r.id;
    opt.textContent = `${idx + 1}. ${r.name}`;
    targetSelect.appendChild(opt);
  });

  const heading = document.getElementById('hs360-modal-title');
  if (existingHs) {
    if (heading) heading.textContent = '✏️ Editar Botón de Piso / Flecha 360°';
    document.getElementById('hs360-input-arrow').value = existingHs.arrow || 'floor-ring';
    document.getElementById('hs360-input-label').value = existingHs.label || '';
    targetSelect.value = existingHs.targetRoomId || pool[0]?.id || '';
  } else {
    if (heading) heading.textContent = '⭕ Programar Botón de Piso / Flecha 360°';
    document.getElementById('hs360-input-arrow').value = 'floor-ring';
    const other = pool.find((r) => r.id !== state.activeRoom360Id) || pool[0];
    if (other) {
      targetSelect.value = other.id;
      document.getElementById('hs360-input-label').value = other.name;
    }
  }
  document.getElementById('modal-hotspot360-editor').classList.add('open');
}

/* ==========================================================================
   6. 3D ENGINE WITH FIXED .OBJ (+ .MTL, .GLB, .FBX) LOADER
   ========================================================================== */
let model3d = {
  scene: null, camera: null, renderer: null, controls: null, clipPlane: null,
  sunLight: null, ambientLight: null, buildingRoot: null, studioGrid: null,
  floorGroups: [], roomLabels3D: [], activeFloor3DId: 'f3d-0', activeFloor3D: 0, isExploded: false, mode: 'orbit',
  droneAngle: 0, droneRadius: 22, droneTargetY: 5.5,
  keys: { forward: false, backward: false, left: false, right: false, up: false, down: false },
  camLerpTargetPos: null, camLerpLookAt: null, teleportRing: null,
  raycaster: new THREE.Raycaster(), pointer: new THREE.Vector2(), wireframe: false
};

function getCurrentCamera3DSnapshot() {
  const p = model3d.camera ? [Number(model3d.camera.position.x.toFixed(2)), Number(model3d.camera.position.y.toFixed(2)), Number(model3d.camera.position.z.toFixed(2))] : [19, 15, 21];
  const t = model3d.controls ? [Number(model3d.controls.target.x.toFixed(2)), Number(model3d.controls.target.y.toFixed(2)), Number(model3d.controls.target.z.toFixed(2))] : [0, 5.5, 0];
  const sliderVal = Number(document.getElementById('slider-cut-height')?.value || model3d.clipPlane?.constant || 16.5);
  return { camPos: p, lookAt: t, heightCut: Number(sliderVal.toFixed(1)) };
}

function render3DCamerasList() {
  const container = document.getElementById('model3d-cameras-grid');
  if (!container) return;
  container.innerHTML = '';
  if (!Array.isArray(state.cameras3D)) state.cameras3D = structuredClone(defaultCameras3D);

  state.cameras3D.forEach((cam, idx) => {
    const row = document.createElement('div');
    row.className = 'cam3d-item-wrap';
    row.innerHTML = `
      <button class="action-btn cam3d-main-btn" data-go-cam="${cam.id}" title="Ir a cámara ${cam.name}">🎥 ${cam.name}</button>
      ${isEditor() ? `
        <div class="cam3d-mini-actions">
          <button class="cam3d-mini-btn" data-save-cam="${idx}" title="Guardar vista actual en esta cámara">💾</button>
          <button class="cam3d-mini-btn" data-rename-cam="${idx}" title="Cambiar nombre">✎</button>
          <button class="cam3d-mini-btn danger" data-del-cam="${idx}" title="Eliminar cámara">✕</button>
        </div>
      ` : ''}
    `;
    row.querySelector('[data-go-cam]').addEventListener('click', () => {
      if (typeof cam.floorNum === 'number' && model3d.floorGroups.length > 0) {
        model3d.floorGroups.forEach((fg) => { fg.visible = (cam.floorNum === 0) ? true : (fg.userData.floorNum <= cam.floorNum); });
      }
      if (typeof cam.heightCut === 'number' && model3d.clipPlane) {
        model3d.clipPlane.constant = cam.heightCut;
        const sl = document.getElementById('slider-cut-height');
        if (sl) sl.value = String(cam.heightCut);
        const lbl = document.getElementById('label-cut-height');
        if (lbl) lbl.textContent = `${cam.heightCut}m`;
      }
      flyCamera3D(cam.camPos, cam.lookAt);
    });
    const saveBtn = row.querySelector('[data-save-cam]');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        const snap = getCurrentCamera3DSnapshot();
        cam.camPos = snap.camPos;
        cam.lookAt = snap.lookAt;
        cam.heightCut = snap.heightCut;
        cam.floorNum = model3d.activeFloor3D;
        savePersistedState();
        showToast(`Vista actual guardada en "${cam.name}"`);
      });
    }
    const renBtn = row.querySelector('[data-rename-cam]');
    if (renBtn) {
      renBtn.addEventListener('click', () => {
        const newName = window.prompt('Nuevo nombre de la cámara 3D:', cam.name);
        if (!newName || !newName.trim()) return;
        cam.name = newName.trim();
        savePersistedState();
        render3DCamerasList();
        showToast(`Cámara renombrada a "${cam.name}"`);
      });
    }
    const delBtn = row.querySelector('[data-del-cam]');
    if (delBtn) {
      delBtn.addEventListener('click', () => {
        state.cameras3D.splice(idx, 1);
        savePersistedState();
        render3DCamerasList();
        showToast(`Cámara "${cam.name}" eliminada`);
      });
    }
    container.appendChild(row);
  });
}

function initModel3DViewer() {
  const container = document.getElementById('model3d-canvas-container');
  if (!container) return;
  const w = container.clientWidth || window.innerWidth;
  const h = container.clientHeight || window.innerHeight;

  model3d.scene = new THREE.Scene();
  model3d.scene.background = new THREE.Color('#090a0f');
  model3d.camera = new THREE.PerspectiveCamera(48, w / h, 0.1, 1000);
  model3d.camera.position.set(19, 15, 21);

  model3d.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  model3d.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  model3d.renderer.outputColorSpace = THREE.SRGBColorSpace;
  model3d.renderer.setSize(w, h);
  model3d.renderer.shadowMap.enabled = true;
  model3d.renderer.localClippingEnabled = true;
  container.appendChild(model3d.renderer.domElement);

  model3d.controls = new OrbitControls(model3d.camera, model3d.renderer.domElement);
  model3d.controls.enableDamping = true;
  model3d.controls.dampingFactor = 0.07;
  model3d.controls.target.set(0, 5.5, 0);

  model3d.clipPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 20);
  model3d.scene.add(new THREE.HemisphereLight('#fffbf0', '#2e2a24', 1.2));
  model3d.ambientLight = new THREE.AmbientLight('#ffffff', 0.45);
  model3d.scene.add(model3d.ambientLight);
  model3d.sunLight = new THREE.DirectionalLight('#fff2d6', 1.75);
  model3d.sunLight.position.set(22, 32, 18);
  model3d.sunLight.castShadow = true;
  model3d.scene.add(model3d.sunLight);
  const fillLight = new THREE.DirectionalLight('#cbd5e1', 0.85);
  fillLight.position.set(-20, 14, -18);
  model3d.scene.add(fillLight);

  model3d.studioGrid = new THREE.GridHelper(32, 32, 0xd4af37, 0x22222c);
  model3d.studioGrid.position.y = -0.04;
  model3d.scene.add(model3d.studioGrid);

  const ringGeo = new THREE.RingGeometry(0.35, 0.52, 32);
  ringGeo.rotateX(-Math.PI / 2);
  model3d.teleportRing = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: '#f5d77f', side: THREE.DoubleSide }));
  model3d.teleportRing.visible = false;
  model3d.scene.add(model3d.teleportRing);

  build4FloorLuxuryTower3D(false);
  render3DCamerasList();
  render3DFloorSelectorButtons();

  model3d.renderer.domElement.addEventListener('dblclick', (e) => {
    const rect = model3d.renderer.domElement.getBoundingClientRect();
    model3d.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    model3d.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
    model3d.raycaster.setFromCamera(model3d.pointer, model3d.camera);
    if (!model3d.buildingRoot) return;
    const hits = model3d.raycaster.intersectObjects(model3d.buildingRoot.children, true);
    const validHit = hits.find((hit) => hit.object.visible && hit.point.y <= model3d.clipPlane.constant);
    if (validHit) {
      const pt = validHit.point;
      model3d.teleportRing.position.set(pt.x, pt.y + 0.05, pt.z);
      model3d.teleportRing.visible = true;
      flyCamera3D([pt.x + 3.8, pt.y + 2.4, pt.z + 4.2], [pt.x, pt.y + 1.0, pt.z]);
    }
  });
}

function build4FloorLuxuryTower3D(resetFloors = true) {
  if (model3d.buildingRoot) model3d.scene.remove(model3d.buildingRoot);
  if (resetFloors || !Array.isArray(state.floors3D) || state.floors3D.length === 0) {
    state.floors3D = structuredClone(defaultFloors3DConfig);
  }

  const root = new THREE.Group();
  model3d.floorGroups = [];
  const clip = [model3d.clipPlane];
  const matObsidian = new THREE.MeshStandardMaterial({ color: '#1a1a24', roughness: 0.35, metalness: 0.2, clippingPlanes: clip, side: THREE.DoubleSide });
  const matMarble = new THREE.MeshStandardMaterial({ color: '#2b251e', roughness: 0.28, metalness: 0.1, clippingPlanes: clip, side: THREE.DoubleSide });
  const matGold = new THREE.MeshStandardMaterial({ color: '#d4af37', roughness: 0.22, metalness: 0.82, clippingPlanes: clip });
  const matWalnut = new THREE.MeshStandardMaterial({ color: '#6b4528', roughness: 0.5, clippingPlanes: clip });
  const matGlass = new THREE.MeshStandardMaterial({ color: '#f5d77f', transparent: true, opacity: 0.28, roughness: 0.1, metalness: 0.5, clippingPlanes: clip });
  const matWater = new THREE.MeshStandardMaterial({ color: '#0891b2', roughness: 0.1, metalness: 0.2, clippingPlanes: clip });
  const matFurniture = new THREE.MeshStandardMaterial({ color: '#d6d3d1', roughness: 0.6, clippingPlanes: clip });

  const addBox = (parent, w, h, d, x, y, z, mat) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m;
  };

  const groundGroup = new THREE.Group();
  addBox(groundGroup, 26, 0.35, 22, 0, -0.18, 0, matObsidian);
  addBox(groundGroup, 13.5, 0.08, 10.5, 0, 0.04, -1, matGold);
  addBox(groundGroup, 8.5, 0.22, 4.2, 0, 0.06, 6.8, matWater);
  addBox(groundGroup, 9.0, 0.12, 4.7, 0, 0.02, 6.8, matGold);
  root.add(groundGroup);

  const floorHeight = 3.4;
  for (let f = 1; f <= 4; f++) {
    const fg = new THREE.Group();
    const baseY = (f - 1) * floorHeight;
    fg.userData = { floorNum: f, baseY };
    const isPenthouse = f === 4;
    const w = isPenthouse ? 10.8 : 12.6;
    const d = isPenthouse ? 8.2 : 9.4;

    addBox(fg, w, 0.26, d, 0, 0.13, -1.2, matMarble);
    addBox(fg, w + 0.35, 0.12, d + 0.35, 0, 0.22, -1.2, matGold);
    addBox(fg, w, 3.0, 0.24, 0, 1.7, -1.2 - d / 2, matObsidian);
    addBox(fg, 0.24, 3.0, d, -w / 2, 1.7, -1.2, matObsidian);
    addBox(fg, 0.24, 3.0, d, w / 2, 1.7, -1.2, matObsidian);
    addBox(fg, 0.2, 3.0, d * 0.72, 0, 1.7, -1.6, matWalnut);
    addBox(fg, w * 0.85, 2.9, 0.08, 0, 1.65, -1.2 + d / 2, matGlass);
    addBox(fg, w, 0.2, 2.2, 0, 0.1, -1.2 + d / 2 + 1.1, matWalnut);
    addBox(fg, w, 1.0, 0.08, 0, 0.7, -1.2 + d / 2 + 2.15, matGlass);
    addBox(fg, w + 0.1, 0.08, 0.12, 0, 1.22, -1.2 + d / 2 + 2.15, matGold);
    addBox(fg, 2.6, 0.7, 1.1, -w * 0.26, 0.6, -2.6, matFurniture);
    addBox(fg, 2.2, 0.9, 1.0, -w * 0.24, 0.7, -0.2, matGold);
    addBox(fg, 2.3, 0.65, 2.4, w * 0.25, 0.58, -3.4, matFurniture);
    if (isPenthouse) {
      addBox(fg, 4.4, 0.35, 2.1, 2.4, 0.3, 2.8, matWater);
      addBox(fg, w * 0.65, 0.22, d * 0.65, -1.2, 3.25, -1.6, matObsidian);
      addBox(fg, w * 0.68, 0.12, d * 0.68, -1.2, 3.32, -1.6, matGold);
    }
    fg.position.y = baseY;
    model3d.floorGroups.push(fg);
    root.add(fg);
  }

  model3d.roomLabels3D = [
    { floorNum: 1, title: 'Dpto 9-01 · 150 m²', unitId: 'u-901', pos: new THREE.Vector3(-3.2, 1.8, -1.5) },
    { floorNum: 1, title: 'Dpto 9-02 · 125 m²', unitId: 'u-902', pos: new THREE.Vector3(3.2, 1.8, -1.0) },
    { floorNum: 2, title: 'Piso 20°', unitId: 'u-ext-p20', pos: new THREE.Vector3(0, 5.2, -1.5) },
    { floorNum: 4, title: 'Penthouse 35°', unitId: 'u-ext-p35', pos: new THREE.Vector3(0, 12.0, -0.5) }
  ];

  model3d.buildingRoot = root;
  model3d.scene.add(root);
  model3d.droneRadius = 22;
  model3d.droneTargetY = 5.5;
  const slider = document.getElementById('slider-cut-height');
  if (slider) { slider.min = '0.5'; slider.max = '18'; slider.value = '16.5'; }
  document.getElementById('btn-restore-demo-3d').style.display = 'none';
  document.getElementById('model-import-status').textContent = 'Activo: Torre SALO Demo (4 Niveles)';
  select3DFloor(0);
}

function normalizeAndMountImported3DModel(rawObj, fileName, persistReset3DFloors = true) {
  if (model3d.buildingRoot) model3d.scene.remove(model3d.buildingRoot);
  model3d.floorGroups = [];
  model3d.roomLabels3D = [];

  let meshCount = 0;
  let totalVerts = 0;

  rawObj.traverse((child) => {
    if (child.isMesh) {
      meshCount++;
      const geo = child.geometry;
      if (geo && geo.attributes && geo.attributes.position) {
        totalVerts += geo.attributes.position.count;
        if (!geo.attributes.normal || geo.attributes.normal.count !== geo.attributes.position.count) geo.computeVertexNormals();
        geo.computeBoundingBox();
        geo.computeBoundingSphere();
      }
      child.castShadow = true;
      child.receiveShadow = true;

      const fixMat = (m) => {
        if (!m) return new THREE.MeshStandardMaterial({ color: '#dfd8cc', roughness: 0.55, metalness: 0.1, side: THREE.DoubleSide, clippingPlanes: [model3d.clipPlane], clipShadows: true });
        const isPitchBlack = m.color && m.color.r < 0.02 && m.color.g < 0.02 && m.color.b < 0.02 && !m.map;
        const isInvisibleOpacity = m.transparent && m.opacity < 0.05;
        if (m.type === 'MeshPhongMaterial' && !m.map) {
          return new THREE.MeshStandardMaterial({
            color: isPitchBlack ? new THREE.Color('#dfd8cc') : m.color.clone(),
            roughness: 0.52, metalness: 0.12, side: THREE.DoubleSide, clippingPlanes: [model3d.clipPlane], clipShadows: true
          });
        }
        if (isPitchBlack) m.color.set('#d4cdc0');
        if (isInvisibleOpacity) { m.opacity = 1; m.transparent = false; }
        m.side = THREE.DoubleSide;
        m.clippingPlanes = [model3d.clipPlane];
        m.clipShadows = true;
        m.needsUpdate = true;
        return m;
      };
      child.material = Array.isArray(child.material) ? child.material.map(fixMat) : fixMat(child.material);
    } else if (child.isLine || child.isLineSegments) {
      meshCount++;
      child.material = new THREE.LineBasicMaterial({ color: '#f5d77f', clippingPlanes: [model3d.clipPlane] });
    }
  });

  if (meshCount === 0) throw new Error('El archivo no contiene geometría 3D visible');

  const wrapper = new THREE.Group();
  rawObj.position.set(0, 0, 0);
  rawObj.rotation.set(0, 0, 0);
  rawObj.scale.set(1, 1, 1);
  wrapper.add(rawObj);
  wrapper.updateMatrixWorld(true);

  const rawBox = new THREE.Box3().setFromObject(rawObj);
  if (rawBox.isEmpty()) throw new Error('Geometría vacía o inválida');
  const rawSize = rawBox.getSize(new THREE.Vector3());
  const maxDim = Math.max(rawSize.x, rawSize.y, rawSize.z);
  const scale = (Number.isFinite(maxDim) && maxDim > 0) ? (16 / maxDim) : 1;

  rawObj.scale.setScalar(scale);
  rawObj.updateMatrixWorld(true);

  const scaledBox = new THREE.Box3().setFromObject(rawObj);
  const scaledCenter = scaledBox.getCenter(new THREE.Vector3());
  rawObj.position.set(-scaledCenter.x, -scaledBox.min.y, -scaledCenter.z);
  wrapper.updateMatrixWorld(true);

  const finalBox = new THREE.Box3().setFromObject(wrapper);
  const finalCenter = finalBox.getCenter(new THREE.Vector3());
  const totalHeight = Math.max(2, finalBox.max.y);
  const radius = Math.max(4, finalBox.getBoundingSphere(new THREE.Sphere()).radius);

  const fullCut = Number((totalHeight + 3).toFixed(1));
  const dist = radius * 2.15;
  if (!Array.isArray(state.floors3D) || state.floors3D.length === 0 || persistReset3DFloors) {
    state.floors3D = [
      { id: 'f3d-0', num: 0, name: 'Modelo Completo', badge: '100%', heightCut: fullCut, camPos: [dist * 0.85, totalHeight * 0.95 + radius * 0.45, dist * 0.95], lookAt: [finalCenter.x, finalCenter.y, finalCenter.z] },
      { id: 'f3d-4', num: 4, name: 'Nivel Superior (4°)', badge: '90%', heightCut: Number((totalHeight * 0.92).toFixed(1)), camPos: [dist * 0.65, totalHeight * 1.15, dist * 0.7], lookAt: [finalCenter.x, totalHeight * 0.72, finalCenter.z] },
      { id: 'f3d-3', num: 3, name: 'Nivel Alto (3°)', badge: '70%', heightCut: Number((totalHeight * 0.70).toFixed(1)), camPos: [dist * 0.65, totalHeight * 0.95, dist * 0.7], lookAt: [finalCenter.x, totalHeight * 0.50, finalCenter.z] },
      { id: 'f3d-2', num: 2, name: 'Nivel Medio (2°)', badge: '48%', heightCut: Number((totalHeight * 0.48).toFixed(1)), camPos: [dist * 0.65, totalHeight * 0.75, dist * 0.7], lookAt: [finalCenter.x, totalHeight * 0.30, finalCenter.z] },
      { id: 'f3d-1', num: 1, name: 'Planta Baja (1°)', badge: '25%', heightCut: Number((totalHeight * 0.25).toFixed(1)), camPos: [dist * 0.65, totalHeight * 0.55, dist * 0.7], lookAt: [finalCenter.x, totalHeight * 0.12, finalCenter.z] }
    ];
  }

  const slider = document.getElementById('slider-cut-height');
  if (slider) { slider.min = '0.2'; slider.max = String(fullCut); slider.value = String(fullCut); }

  model3d.clipPlane.constant = fullCut + 2;
  model3d.droneRadius = dist;
  model3d.droneTargetY = finalCenter.y;
  model3d.buildingRoot = wrapper;
  model3d.scene.add(wrapper);

  const f0 = state.floors3D[0];
  model3d.camera.position.set(...f0.camPos);
  model3d.controls.target.set(...f0.lookAt);
  model3d.controls.update();
  model3d.camLerpTargetPos = null;
  model3d.camLerpLookAt = null;

  render3DFloorSelectorButtons();
  select3DFloor(f0.id);

  document.getElementById('model-import-status').innerHTML = `✅ <b>${fileName}</b> cargado (${meshCount} mallas · ${totalVerts.toLocaleString()} vértices)`;
  document.getElementById('btn-restore-demo-3d').style.display = 'flex';
  showToast(`Modelo 3D "${fileName}" visible en escena`);
}

let dracoLoaderInstance = null;

function createConfiguredGLTFLoader() {
  if (!dracoLoaderInstance) {
    dracoLoaderInstance = new DRACOLoader();
    dracoLoaderInstance.setDecoderPath('./vendor/three/examples/jsm/libs/draco/gltf/');
  }
  const loader = new GLTFLoader();
  loader.setDRACOLoader(dracoLoaderInstance);
  return loader;
}

async function fetchArrayBufferWithProgress(url, label = 'Maqueta 3D') {
  const overlay = document.getElementById('model3d-loading-overlay');
  const titleEl = document.getElementById('model3d-loading-title');
  const detailEl = document.getElementById('model3d-loading-detail');
  const barEl = document.getElementById('model3d-loading-bar');
  if (overlay) overlay.classList.add('visible');
  if (titleEl) titleEl.textContent = `⏳ Descargando ${label}…`;
  if (detailEl) detailEl.textContent = 'Conectando…';
  if (barEl) barEl.style.width = '4%';

  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const total = Number(resp.headers.get('content-length') || 0);
    if (!resp.body || !resp.body.getReader) {
      const buf = await resp.arrayBuffer();
      if (barEl) barEl.style.width = '100%';
      return buf;
    }
    const reader = resp.body.getReader();
    const chunks = [];
    let loaded = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      const loadedMb = (loaded / (1024 * 1024)).toFixed(1);
      if (total > 0) {
        const pct = Math.min(100, Math.round((loaded / total) * 100));
        const totalMb = (total / (1024 * 1024)).toFixed(1);
        if (detailEl) detailEl.textContent = `${loadedMb} MB / ${totalMb} MB (${pct}%)`;
        if (barEl) barEl.style.width = `${pct}%`;
      } else {
        if (detailEl) detailEl.textContent = `${loadedMb} MB descargados`;
        if (barEl) barEl.style.width = '55%';
      }
    }
    const out = new Uint8Array(loaded);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.byteLength;
    }
    if (barEl) barEl.style.width = '100%';
    return out.buffer;
  } finally {
    if (overlay) overlay.classList.remove('visible');
  }
}

async function mountModel3DFromUrl(url, fileName, persistReset = false, mtlUrl = null) {
  if (!url || !model3d.scene) return;
  const statusEl = document.getElementById('model-import-status');
  const ext = (fileName || 'modelo.glb').split('.').pop().toLowerCase();
  if (statusEl) statusEl.textContent = `⏳ Descargando ${fileName}...`;
  try {
    const buf = await fetchArrayBufferWithProgress(url, fileName);
    if (ext === 'obj') {
      const objText = new TextDecoder().decode(buf);
      const objLoader = new OBJLoader();
      if (mtlUrl) {
        const mtlBuf = await fetchArrayBufferWithProgress(mtlUrl, 'materiales.mtl');
        const materials = new MTLLoader().parse(new TextDecoder().decode(mtlBuf), '');
        materials.preload();
        objLoader.setMaterials(materials);
      }
      normalizeAndMountImported3DModel(objLoader.parse(objText), fileName, persistReset);
    } else if (ext === 'glb' || ext === 'gltf') {
      await new Promise((resolve, reject) => {
        createConfiguredGLTFLoader().parse(buf, '', (gltf) => {
          normalizeAndMountImported3DModel(gltf.scene, fileName, persistReset);
          resolve();
        }, reject);
      });
    } else if (ext === 'fbx') {
      normalizeAndMountImported3DModel(new FBXLoader().parse(buf, ''), fileName, persistReset);
    }
  } catch (err) {
    if (statusEl) statusEl.innerHTML = `❌ Error descargando modelo 3D: ${err?.message || err}`;
  }
}

async function loadCustom3DModelFiles(fileList, persistToDb = true) {
  const files = Array.from(fileList || []);
  if (files.length === 0 || !model3d.scene) return;
  const statusEl = document.getElementById('model-import-status');
  const mainFile = files.find((f) => /\.(obj|glb|gltf|fbx|d5a|d5)$/i.test(f.name)) || files[0];
  const mtlFile = files.find((f) => /\.mtl$/i.test(f.name)) || null;
  const ext = mainFile.name.split('.').pop().toLowerCase();

  if (ext === 'd5' || ext === 'd5a') {
    if (statusEl) statusEl.innerHTML = `⚠️ <b>${mainFile.name}</b> es formato cerrado D5. Exporta desde SketchUp/Blender en <b>.OBJ, .GLB o .FBX</b>.`;
    switchView('model3d');
    return;
  }
  if (statusEl) statusEl.textContent = `⏳ Procesando ${mainFile.name}...`;

  try {
    if (ext === 'obj') {
      const objText = await mainFile.text();
      const objLoader = new OBJLoader();
      if (mtlFile) {
        const materials = new MTLLoader().parse(await mtlFile.text(), '');
        materials.preload();
        objLoader.setMaterials(materials);
      }
      normalizeAndMountImported3DModel(objLoader.parse(objText), mainFile.name, persistToDb);
    } else if (ext === 'glb' || ext === 'gltf') {
      const buf = await mainFile.arrayBuffer();
      await new Promise((resolve, reject) => {
        createConfiguredGLTFLoader().parse(buf, '', (gltf) => { normalizeAndMountImported3DModel(gltf.scene, mainFile.name, persistToDb); resolve(); }, reject);
      });
    } else if (ext === 'fbx') {
      normalizeAndMountImported3DModel(new FBXLoader().parse(await mainFile.arrayBuffer(), ''), mainFile.name, persistToDb);
    } else {
      throw new Error(`Formato .${ext} no soportado`);
    }

    if (persistToDb) {
      const key = `model3d-${Date.now()}`;
      await saveMediaBlob(key, mainFile);
      let mtlKey = null;
      if (mtlFile) { mtlKey = `model3d-mtl-${Date.now()}`; await saveMediaBlob(mtlKey, mtlFile); }
      state.customModel3D = { name: mainFile.name, ext, mediaKey: key, mtlMediaKey: mtlKey };
      savePersistedState();
    }
  } catch (err) {
    if (statusEl) statusEl.innerHTML = `❌ Error: ${err?.message || err}`;
    showToast(`Error cargando modelo 3D`);
  }
}

function select3DFloor(floorIdOrNum) {
  const list = Array.isArray(state.floors3D) && state.floors3D.length > 0 ? state.floors3D : defaultFloors3DConfig;
  const cfg = list.find((c) => c.id === floorIdOrNum || c.num === floorIdOrNum) || list[0];
  model3d.activeFloor3DId = cfg.id;
  model3d.activeFloor3D = cfg.num;
  if (model3d.floorGroups.length > 0) {
    model3d.floorGroups.forEach((fg) => { fg.visible = (cfg.num === 0) ? true : (fg.userData.floorNum <= cfg.num); });
  }
  model3d.clipPlane.constant = cfg.num === 0 ? cfg.heightCut + 2 : cfg.heightCut;
  const slider = document.getElementById('slider-cut-height');
  if (slider) {
    if (cfg.heightCut > Number(slider.max)) slider.max = String(Math.ceil(cfg.heightCut + 4));
    slider.value = String(cfg.heightCut);
  }
  document.getElementById('label-cut-height').textContent = cfg.num === 0 ? 'Completo' : `${cfg.heightCut}m`;
  flyCamera3D(cfg.camPos, cfg.lookAt);
  render3DFloorSelectorButtons();
}

function toggleExploded3DView() {
  model3d.isExploded = !model3d.isExploded;
  document.getElementById('btn-3d-explode')?.classList.toggle('active', model3d.isExploded);
  if (model3d.isExploded) {
    model3d.activeFloor3D = 0;
    model3d.clipPlane.constant = 35;
    model3d.floorGroups.forEach((fg) => { fg.visible = true; });
    flyCamera3D([22, 18, 24], [0, 8.5, 0]);
    render3DFloorSelectorButtons();
  } else select3DFloor(0);
}

function flyCamera3D(posArr, lookAtArr) {
  model3d.camLerpTargetPos = new THREE.Vector3(...posArr);
  model3d.camLerpLookAt = new THREE.Vector3(...lookAtArr);
}

let assignPolygonsSaveHandler = null;

function renderAssignPolygonsList(filterQuery = '', checkedSet = new Set()) {
  const list = document.getElementById('assign-poly-list');
  if (!list) return;
  list.innerHTML = '';
  const q = filterQuery.trim().toLowerCase();

  state.levels.forEach((lvl) => {
    const lvlUnits = state.units.filter((u) => {
      if ((u.levelId || 'facade') !== lvl.id) return false;
      if (!q) return true;
      return `${u.code} ${u.buttonText || ''} ${lvl.name}`.toLowerCase().includes(q);
    });
    if (lvlUnits.length === 0) return;

    const grp = document.createElement('div');
    grp.className = 'assign-poly-group';
    grp.innerHTML = `<div class="assign-poly-group-title">${lvl.id === 'facade' ? '🏛️ Vista Exterior' : `📐 ${lvl.name}`}</div>`;
    lvlUnits.forEach((u) => {
      const lbl = document.createElement('label');
      lbl.className = 'assign-poly-item';
      const checked = checkedSet.has(u.id);
      lbl.innerHTML = `
        <input type="checkbox" value="${u.id}" ${checked ? 'checked' : ''} />
        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"><strong>${u.code}</strong> <small style="color:var(--ink-silver);">(${u.buttonText || u.area + ' m²'})</small></span>
      `;
      const cb = lbl.querySelector('input');
      cb.addEventListener('change', () => {
        if (cb.checked) checkedSet.add(u.id);
        else checkedSet.delete(u.id);
      });
      grp.appendChild(lbl);
    });
    list.appendChild(grp);
  });

  if (list.children.length === 0) {
    list.innerHTML = '<span style="font-size:11px;color:var(--ink-muted);padding:10px;text-align:center;">No hay polígonos que coincidan.</span>';
  }
}

let assignPolygonsCheckedSet = new Set();

function openAssignPolygonsModal({ title, subtitle, selectedIds = [], onSave }) {
  if (!isEditor()) return;
  assignPolygonsSaveHandler = onSave;
  assignPolygonsCheckedSet = new Set(Array.isArray(selectedIds) ? selectedIds : []);
  document.getElementById('assign-poly-title').textContent = title || '🔗 Asignar Polígonos';
  document.getElementById('assign-poly-sub').textContent = subtitle || 'Elige los rectángulos/polígonos vinculados:';
  const searchEl = document.getElementById('assign-poly-search');
  if (searchEl) searchEl.value = '';
  renderAssignPolygonsList('', assignPolygonsCheckedSet);
  document.getElementById('modal-assign-polygons')?.classList.add('open');
}

function render3DFloorSelectorButtons() {
  const stack = document.getElementById('model3d-floors-stack');
  if (!stack) return;
  stack.innerHTML = '';
  if (!Array.isArray(state.floors3D) || state.floors3D.length === 0) {
    state.floors3D = structuredClone(defaultFloors3DConfig);
  }

  state.floors3D.forEach((fc, idx) => {
    const row = document.createElement('div');
    row.className = 'floor3d-row-wrap';
    const isActive = model3d.activeFloor3DId === fc.id || (!model3d.activeFloor3DId && model3d.activeFloor3D === fc.num);
    const linkCount = Array.isArray(fc.assignedUnitIds) ? fc.assignedUnitIds.length : 0;
    row.innerHTML = `
      <button class="floor3d-btn ${isActive ? 'active' : ''}" data-sel-f3d="${fc.id}">
        <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${fc.name}</span>
        <small style="opacity:0.75;flex-shrink:0;">${fc.badge}${linkCount > 0 ? ` · 🔗${linkCount}` : ''}</small>
      </button>
      ${isEditor() ? `
        <div class="cam3d-mini-actions">
          <button class="cam3d-mini-btn ${linkCount > 0 ? 'has-links' : ''}" data-assign-f3d="${idx}" title="Asignar a rectángulo/polígono (${linkCount})">🔗</button>
          <button class="cam3d-mini-btn" data-save-f3d="${idx}" title="Guardar vista y altura de corte actual en este piso">💾</button>
          <button class="cam3d-mini-btn" data-ren-f3d="${idx}" title="Cambiar nombre">✎</button>
          ${state.floors3D.length > 1 ? `<button class="cam3d-mini-btn danger" data-del-f3d="${idx}" title="Eliminar piso 3D">🗑️</button>` : ''}
        </div>
      ` : ''}
    `;

    row.querySelector('[data-sel-f3d]').addEventListener('click', () => {
      model3d.isExploded = false;
      document.getElementById('btn-3d-explode')?.classList.remove('active');
      select3DFloor(fc.id);
    });
    const assignBtn = row.querySelector('[data-assign-f3d]');
    if (assignBtn) {
      assignBtn.addEventListener('click', () => {
        openAssignPolygonsModal({
          title: `🔗 Asignar Piso 3D: ${fc.name}`,
          subtitle: 'Cuando el visitante toque uno de estos polígonos y elija "🧊 Piso 3D", verá directamente este nivel con la vista guardada:',
          selectedIds: fc.assignedUnitIds || [],
          onSave: (ids) => {
            fc.assignedUnitIds = ids;
            savePersistedState();
            render3DFloorSelectorButtons();
            showToast(`Piso 3D "${fc.name}" vinculado a ${ids.length} polígono(s)`);
          }
        });
      });
    }
    const saveBtn = row.querySelector('[data-save-f3d]');
    if (saveBtn) {
      saveBtn.addEventListener('click', () => {
        const snap = getCurrentCamera3DSnapshot();
        fc.camPos = snap.camPos;
        fc.lookAt = snap.lookAt;
        fc.heightCut = snap.heightCut;
        savePersistedState();
        showToast(`Vista y corte (${snap.heightCut}m) guardados en "${fc.name}"`);
      });
    }
    const renBtn = row.querySelector('[data-ren-f3d]');
    if (renBtn) {
      renBtn.addEventListener('click', () => {
        const newName = window.prompt('Nuevo nombre del Piso 3D:', fc.name);
        if (!newName || !newName.trim()) return;
        const newBadge = window.prompt('Etiqueta corta (ej: Nivel 5):', fc.badge);
        fc.name = newName.trim();
        if (newBadge && newBadge.trim()) fc.badge = newBadge.trim();
        savePersistedState();
        render3DFloorSelectorButtons();
        showToast(`Piso 3D renombrado a "${fc.name}"`);
      });
    }
    const delBtn = row.querySelector('[data-del-f3d]');
    if (delBtn) {
      delBtn.addEventListener('click', () => {
        if (state.floors3D.length <= 1) return;
        state.floors3D.splice(idx, 1);
        savePersistedState();
        render3DFloorSelectorButtons();
        showToast(`Piso 3D "${fc.name}" eliminado`);
      });
    }
    stack.appendChild(row);
  });
}

function update3DRoomLabelsProjection() {
  const layer = document.getElementById('model3d-labels-layer');
  const container = document.getElementById('model3d-canvas-container');
  if (!layer || !container || !model3d.camera) return;
  const w = container.clientWidth;
  const h = container.clientHeight;
  layer.innerHTML = '';
  model3d.roomLabels3D.forEach((lbl) => {
    if (model3d.activeFloor3D !== 0 && lbl.floorNum !== model3d.activeFloor3D) return;
    const worldPos = lbl.pos.clone();
    if (model3d.isExploded) worldPos.y += (lbl.floorNum - 1) * 2.2;
    if (worldPos.y > model3d.clipPlane.constant) return;
    const projected = worldPos.clone().project(model3d.camera);
    if (projected.z > 1) return;
    const chip = document.createElement('button');
    chip.className = 'label-3d-room';
    chip.style.left = `${(projected.x * 0.5 + 0.5) * w}px`;
    chip.style.top = `${(-(projected.y * 0.5) + 0.5) * h}px`;
    chip.innerHTML = `<span>❖</span> ${lbl.title}`;
    chip.addEventListener('click', () => {
      selectUnit(lbl.unitId, false);
      flyCamera3D([worldPos.x + 2.8, worldPos.y + 1.2, worldPos.z + 3.2], [worldPos.x, worldPos.y - 0.3, worldPos.z]);
    });
    layer.appendChild(chip);
  });
}

/* ==========================================================================
   7. PERSISTENT NAMED FINISHES (ACABADOS) BY TABS — FULL QUALITY
   ========================================================================== */
const FINISHES_PAGE_SIZE = 8;

function getActiveFinishTab() {
  return state.finishes.tabs.find((t) => t.id === state.finishes.activeTabId) || state.finishes.tabs[0];
}

function drawProceduralFinish(canvasId, paletteName, labelTitle) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width; const h = canvas.height;
  const palettes = {
    obsidian_gold: { wall: '#0d0d12', floor: '#1a1612', cabinet: '#14141b', counter: '#d4af37', island: '#09090d' },
    nordic: { wall: '#f8fafc', floor: '#d6a87c', cabinet: '#b45309', counter: '#ffffff', island: '#f1f5f9' },
    minimal: { wall: '#cbd5e1', floor: '#64748b', cabinet: '#334155', counter: '#e2e8f0', island: '#475569' }
  };
  const p = palettes[paletteName] || palettes.obsidian_gold;
  ctx.fillStyle = p.wall; ctx.fillRect(0, 0, w, h * 0.68);
  ctx.fillStyle = p.floor; ctx.fillRect(0, h * 0.68, w, h * 0.32);
  ctx.fillStyle = p.cabinet; ctx.fillRect(w * 0.18, h * 0.22, w * 0.64, h * 0.44);
  ctx.strokeStyle = '#d4af37'; ctx.lineWidth = 2; ctx.strokeRect(w * 0.18, h * 0.22, w * 0.64, h * 0.44);
  ctx.fillStyle = p.counter; ctx.fillRect(w * 0.22, h * 0.36, w * 0.56, h * 0.14);
  ctx.fillStyle = p.island; ctx.fillRect(w * 0.25, h * 0.56, w * 0.5, h * 0.24);
  ctx.fillStyle = p.counter; ctx.fillRect(w * 0.24, h * 0.54, w * 0.52, h * 0.04);
  ctx.fillStyle = 'rgba(7,7,10,0.86)'; ctx.fillRect(w * 0.3, h * 0.44, w * 0.4, 58);
  ctx.strokeStyle = '#d4af37'; ctx.strokeRect(w * 0.3, h * 0.44, w * 0.4, 58);
  ctx.fillStyle = '#f5d77f'; ctx.font = '700 22px "Cinzel", serif'; ctx.textAlign = 'center';
  ctx.fillText(labelTitle.toUpperCase(), w * 0.5, h * 0.478);
}

function renderFinishSide(side, item) {
  const imgEl = document.getElementById(`finish-img-${side}`);
  const canvasEl = document.getElementById(`finish-canvas-${side}`);
  const badgeEl = document.getElementById(`finish-badge-${side}`);
  if (!item || !imgEl || !canvasEl) return;
  if (badgeEl) badgeEl.textContent = `${side === 'left' ? 'A' : 'B'}: ${item.name}`;
  if (item.url) {
    imgEl.src = item.url; imgEl.style.display = 'block'; canvasEl.style.display = 'none';
  } else {
    imgEl.style.display = 'none'; canvasEl.style.display = 'block';
    drawProceduralFinish(`finish-canvas-${side}`, item.palette || 'obsidian_gold', item.name);
  }
}

function renderFinishesTabs() {
  const list = document.getElementById('finishes-tabs-list');
  const pageInd = document.getElementById('finishes-page-indicator');
  const prevBtn = document.getElementById('btn-finishes-prev-page');
  const nextBtn = document.getElementById('btn-finishes-next-page');
  if (!list) return;

  if (!Array.isArray(state.finishes?.tabs) || state.finishes.tabs.length === 0) {
    state.finishes = structuredClone(defaultState.finishes);
  }
  const tabs = state.finishes.tabs;
  const totalPages = Math.max(1, Math.ceil(tabs.length / FINISHES_PAGE_SIZE));
  let curPage = Number(state.finishes.currentPage) || 0;
  if (curPage >= totalPages) curPage = totalPages - 1;
  if (curPage < 0) curPage = 0;
  state.finishes.currentPage = curPage;

  if (pageInd) pageInd.textContent = `${curPage + 1} / ${totalPages}`;
  if (prevBtn) prevBtn.disabled = curPage <= 0;
  if (nextBtn) nextBtn.disabled = curPage >= totalPages - 1;

  const start = curPage * FINISHES_PAGE_SIZE;
  const slice = tabs.slice(start, start + FINISHES_PAGE_SIZE);

  list.innerHTML = '';
  slice.forEach((tab) => {
    const row = document.createElement('div');
    const isActive = tab.id === state.finishes.activeTabId;
    const linkCount = Array.isArray(tab.assignedUnitIds) ? tab.assignedUnitIds.length : 0;
    row.className = `finish-tab-row ${isActive ? 'active' : ''}`;
    row.innerHTML = `
      <button type="button" class="finish-tab-select-btn" data-sel-fin="${tab.id}" title="${tab.name}">
        ${tab.name}${linkCount > 0 ? ` <small style="opacity:0.75;">(🔗${linkCount})</small>` : ''}
      </button>
      ${isEditor() ? `
        <div class="cam3d-mini-actions">
          <button type="button" class="cam3d-mini-btn ${linkCount > 0 ? 'has-links' : ''}" data-assign-fin="${tab.id}" title="Asignar a rectángulos/polígonos (${linkCount})">🔗</button>
          <button type="button" class="cam3d-mini-btn" data-ren-fin="${tab.id}" title="Renombrar acabado">✎</button>
          ${tabs.length > 1 ? `<button type="button" class="cam3d-mini-btn danger" data-del-fin="${tab.id}" title="Eliminar acabado">🗑️</button>` : ''}
        </div>
      ` : ''}
    `;

    row.querySelector('[data-sel-fin]').addEventListener('click', () => {
      state.finishes.activeTabId = tab.id;
      savePersistedState();
      renderFinishesTabs();
    });

    const assignBtn = row.querySelector('[data-assign-fin]');
    if (assignBtn) {
      assignBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openAssignPolygonsModal({
          title: `🔗 Asignar Acabado: ${tab.name}`,
          subtitle: 'Elige rectángulos de vista exterior o plantas. Al tocar "✨ Acabados" en esos polígonos, se abrirá este acabado:',
          selectedIds: tab.assignedUnitIds || [],
          onSave: (ids) => {
            tab.assignedUnitIds = ids;
            savePersistedState();
            renderFinishesTabs();
            showToast(`Acabado "${tab.name}" asignado a ${ids.length} polígono(s)`);
          }
        });
      });
    }

    const renBtn = row.querySelector('[data-ren-fin]');
    if (renBtn) {
      renBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const newName = window.prompt('Nuevo nombre para este acabado:', tab.name);
        if (!newName || !newName.trim()) return;
        tab.name = newName.trim();
        savePersistedState();
        renderFinishesTabs();
        showToast(`Acabado renombrado a "${tab.name}"`);
      });
    }

    const delBtn = row.querySelector('[data-del-fin]');
    if (delBtn) {
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.finishes.tabs.length <= 1) return;
        const idx = state.finishes.tabs.findIndex((t) => t.id === tab.id);
        if (idx >= 0) state.finishes.tabs.splice(idx, 1);
        if (state.finishes.activeTabId === tab.id) {
          state.finishes.activeTabId = state.finishes.tabs[Math.max(0, idx - 1)]?.id || state.finishes.tabs[0]?.id;
        }
        savePersistedState();
        renderFinishesTabs();
        showToast(`Acabado "${tab.name}" eliminado`);
      });
    }

    list.appendChild(row);
  });

  renderActiveFinishTabControlsAndImages();
}

function renderActiveFinishTabControlsAndImages() {
  const tab = getActiveFinishTab();
  if (!tab) return;
  const selLeft = document.getElementById('select-finish-left');
  const selRight = document.getElementById('select-finish-right');
  if (!selLeft || !selRight) return;
  selLeft.innerHTML = ''; selRight.innerHTML = '';
  tab.items.forEach((item) => {
    const o1 = document.createElement('option'); o1.value = item.id; o1.textContent = item.name; selLeft.appendChild(o1);
    const o2 = document.createElement('option'); o2.value = item.id; o2.textContent = item.name; selRight.appendChild(o2);
  });
  const leftItem = tab.items.find((i) => i.id === tab.leftId) || tab.items[0];
  const rightItem = tab.items.find((i) => i.id === tab.rightId) || tab.items[1] || tab.items[0];
  tab.leftId = leftItem.id; tab.rightId = rightItem.id;
  selLeft.value = leftItem.id; selRight.value = rightItem.id;
  renderFinishSide('left', leftItem); renderFinishSide('right', rightItem);
}

function initFinishesComparator() {
  renderFinishesTabs();
  const finPanel = document.getElementById('finishes-tabs-panel');
  const finMinBtn = document.getElementById('btn-min-finishes-panel');
  const finRestoreBtn = document.getElementById('restore-finishes-panel');
  const viewFin = document.getElementById('view-finishes');
  finMinBtn?.addEventListener('click', () => {
    finPanel?.classList.add('minimized');
    finRestoreBtn?.classList.add('visible');
    viewFin?.classList.add('finishes-panel-hidden');
  });
  finRestoreBtn?.addEventListener('click', () => {
    finPanel?.classList.remove('minimized');
    finRestoreBtn?.classList.remove('visible');
    viewFin?.classList.remove('finishes-panel-hidden');
  });
  document.getElementById('btn-finishes-prev-page')?.addEventListener('click', () => {
    state.finishes.currentPage = Math.max(0, (Number(state.finishes.currentPage) || 0) - 1);
    renderFinishesTabs();
  });
  document.getElementById('btn-finishes-next-page')?.addEventListener('click', () => {
    const totalPages = Math.max(1, Math.ceil((state.finishes.tabs || []).length / FINISHES_PAGE_SIZE));
    state.finishes.currentPage = Math.min(totalPages - 1, (Number(state.finishes.currentPage) || 0) + 1);
    renderFinishesTabs();
  });
  document.getElementById('btn-add-finish-tab')?.addEventListener('click', () => {
    if (!isEditor()) return;
    const name = window.prompt('Nombre de la nueva pestaña / vista de Acabados:');
    if (!name || !name.trim()) return;
    const newId = `tab-${Date.now()}`;
    const optA = `f-${Date.now()}-a`, optB = `f-${Date.now()}-b`;
    state.finishes.tabs.push({
      id: newId, name: name.trim(), leftId: optA, rightId: optB, assignedUnitIds: [],
      items: [
        { id: optA, name: `${name.trim()} · Opción A`, url: null, mediaKey: null, palette: 'obsidian_gold' },
        { id: optB, name: `${name.trim()} · Opción B`, url: null, mediaKey: null, palette: 'nordic' }
      ]
    });
    state.finishes.activeTabId = newId;
    state.finishes.currentPage = Math.floor((state.finishes.tabs.length - 1) / FINISHES_PAGE_SIZE);
    savePersistedState();
    renderFinishesTabs();
    showToast(`Acabado "${name.trim()}" añadido`);
  });

  const stage = document.getElementById('finishes-stage');
  const leftLayer = document.getElementById('finish-layer-left');
  const divider = document.getElementById('finish-split-divider');
  let activePointerId = null;
  let startedOnDivider = false;
  let dragging = false;
  let downX = 0;

  const updateSplit = (clientX) => {
    const rect = stage.getBoundingClientRect();
    if (!rect.width) return;
    const pct = Math.max(2, Math.min(98, ((clientX - rect.left) / rect.width) * 100));
    leftLayer.style.clipPath = `polygon(0 0, ${pct}% 0, ${pct}% 100%, 0 100%)`;
    divider.style.left = `${pct}%`;
  };

  divider.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    activePointerId = e.pointerId;
    startedOnDivider = true;
    dragging = true;
    downX = e.clientX;
    try { divider.setPointerCapture(e.pointerId); } catch (_) {}
    updateSplit(e.clientX);
  });

  stage.addEventListener('pointerdown', (e) => {
    if (e.target.closest('#finish-split-divider')) return;
    if (activePointerId !== null) return;
    activePointerId = e.pointerId;
    startedOnDivider = false;
    dragging = false;
    downX = e.clientX;
    try { stage.setPointerCapture(e.pointerId); } catch (_) {}
  });

  const handleMove = (e) => {
    if (activePointerId === null || e.pointerId !== activePointerId) return;
    if (!startedOnDivider && !dragging) {
      if (Math.abs(e.clientX - downX) <= 6) return;
      dragging = true;
    }
    if (dragging) {
      e.preventDefault();
      updateSplit(e.clientX);
    }
  };
  const handleUp = (e) => {
    if (e.pointerId !== activePointerId) return;
    activePointerId = null;
    startedOnDivider = false;
    dragging = false;
  };
  window.addEventListener('pointermove', handleMove, { passive: false });
  window.addEventListener('pointerup', handleUp);
  window.addEventListener('pointercancel', handleUp);
  stage.addEventListener('touchmove', (e) => { if (e.touches.length <= 1) e.preventDefault(); }, { passive: false });

  document.getElementById('select-finish-left').addEventListener('change', (e) => {
    const tab = getActiveFinishTab(); tab.leftId = e.target.value; savePersistedState();
    renderFinishSide('left', tab.items.find((i) => i.id === tab.leftId));
  });
  document.getElementById('select-finish-right').addEventListener('change', (e) => {
    const tab = getActiveFinishTab(); tab.rightId = e.target.value; savePersistedState();
    renderFinishSide('right', tab.items.find((i) => i.id === tab.rightId));
  });

  ['left', 'right'].forEach((side) => {
    document.getElementById(`input-finish-${side}`).addEventListener('change', async (e) => {
      if (!isEditor()) return;
      const file = e.target.files[0]; if (!file) return;
      const tab = getActiveFinishTab();
      const item = tab.items.find((i) => i.id === (side === 'left' ? tab.leftId : tab.rightId));
      if (!item) return;
      const mediaKey = `finish-${tab.id}-${item.id}-${Date.now()}`;
      item.mediaKey = mediaKey;
      item.url = await saveMediaBlob(mediaKey, file);
      const cleanName = file.name.replace(/\.[^.]+$/, '');
      if (cleanName) item.name = cleanName;
      savePersistedState();
      renderActiveFinishTabControlsAndImages();
      showToast(`Guardado "${item.name}" en ${tab.name}`);
      e.target.value = '';
    });
  });

  document.getElementById('btn-add-finish-option').addEventListener('click', () => {
    if (!isEditor()) return;
    const tab = getActiveFinishTab();
    const name = window.prompt(`Nombre de la nueva opción para "${tab.name}":`, `Acabado ${tab.items.length + 1}`);
    if (!name || !name.trim()) return;
    const newId = `f-${Date.now()}`;
    tab.items.push({ id: newId, name: name.trim(), url: null, mediaKey: null, palette: 'obsidian_gold' });
    tab.leftId = newId;
    savePersistedState();
    renderActiveFinishTabControlsAndImages();
  });
  document.getElementById('btn-rename-finish-option').addEventListener('click', () => {
    if (!isEditor()) return;
    const tab = getActiveFinishTab();
    const item = tab.items.find((i) => i.id === tab.leftId);
    if (!item) return;
    const newName = window.prompt('Nuevo nombre:', item.name);
    if (!newName || !newName.trim()) return;
    item.name = newName.trim();
    savePersistedState();
    renderActiveFinishTabControlsAndImages();
  });
}

/* ==========================================================================
   8. LOCATION SATELLITE MAP + GOOGLE EARTH + KML + VISUAL POIs
   ========================================================================== */
const locationMap = {
  centerLat: -17.783327, centerLng: -63.182140, zoom: 15,
  dragging: false, dragMoved: false, dragStartX: 0, dragStartY: 0, dragStartLat: 0, dragStartLng: 0,
  isPlacingPoi: false, tileCache: new Map(), labelCache: new Map(),
  listenersBound: false, hasAutoFitted: false, activePointers: new Map(), pinchStartDist: 0, pinchStartZoom: 15
};

function setLocationMapZoom(newZoom) {
  const z = Math.max(3, Math.min(18, Math.round(Number(newZoom) || 15)));
  locationMap.zoom = z;
  state.location.zoom = z;
  const slider = document.getElementById('slider-map-zoom');
  if (slider) slider.value = String(z);
  renderLocationMap();
}

function fitLocationMapBounds() {
  const stage = document.getElementById('location-map-stage');
  const pts = [{ lat: Number(state.location.lat), lng: Number(state.location.lng) }];
  (state.location.pois || []).forEach((p) => {
    const la = Number(p.lat), ln = Number(p.lng);
    if (Number.isFinite(la) && Number.isFinite(ln)) pts.push({ lat: la, lng: ln });
  });
  const valid = pts.filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  if (valid.length === 0) return;

  const hasStage = Boolean(stage && stage.clientWidth > 50);
  const w = hasStage ? stage.clientWidth : (window.innerWidth || 1024);
  const h = hasStage ? stage.clientHeight : (window.innerHeight || 768);

  const sidebar = document.getElementById('location-sidebar');
  const rail = document.querySelector('.location-zoom-rail');
  const topBar = document.querySelector('.top-bar');
  const sidebarOpen = Boolean(hasStage && sidebar && !sidebar.classList.contains('minimized') && sidebar.offsetWidth > 0);
  const rawLeftInset = sidebarOpen ? (sidebar.offsetWidth + 32) : 44;
  const leftInset = hasStage ? Math.min(rawLeftInset, Math.round(w * 0.48)) : 44;
  const rightInset = (hasStage && rail && rail.offsetWidth > 0) ? (rail.offsetWidth + 36) : 64;
  const topChrome = topBar ? Math.max(80, Math.round(topBar.getBoundingClientRect().bottom)) : 80;
  const topInset = Math.min(Math.round(h * 0.38), topChrome + 72);
  const bottomInset = 68;
  const safeW = Math.max(150, w - leftInset - rightInset);
  const safeH = Math.max(140, h - topInset - bottomInset);

  let midLat = valid[0].lat;
  let midLng = valid[0].lng;
  let bestZoom = Math.max(3, Math.min(18, Math.round(Number(state.location.zoom) || 15)));

  if (valid.length > 1) {
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    valid.forEach((p) => {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lng < minLng) minLng = p.lng;
      if (p.lng > maxLng) maxLng = p.lng;
    });
    midLat = (minLat + maxLat) / 2;
    midLng = (minLng + maxLng) / 2;

    bestZoom = 15;
    for (let z = 18; z >= 3; z--) {
      const pTopLeft = latLngToWorldPx(maxLat, minLng, z);
      const pBottomRight = latLngToWorldPx(minLat, maxLng, z);
      const spanX = Math.abs(pBottomRight.x - pTopLeft.x);
      const spanY = Math.abs(pBottomRight.y - pTopLeft.y);
      if (spanX <= safeW && spanY <= safeH) {
        bestZoom = z;
        break;
      }
      bestZoom = z;
    }
  }

  if (hasStage) {
    const safeCenterX = leftInset + safeW / 2;
    const safeCenterY = topInset + safeH / 2;
    const midW = latLngToWorldPx(midLat, midLng, bestZoom);
    const shifted = worldPxToLatLng(midW.x + (w / 2 - safeCenterX), midW.y + (h / 2 - safeCenterY), bestZoom);
    locationMap.centerLat = Math.max(-80, Math.min(80, shifted.lat));
    locationMap.centerLng = shifted.lng;
    locationMap.hasAutoFitted = true;
  } else {
    locationMap.centerLat = midLat;
    locationMap.centerLng = midLng;
  }

  setLocationMapZoom(bestZoom);
}

function latLngToWorldPx(lat, lng, zoom) {
  const scale = 256 * Math.pow(2, zoom);
  const x = ((lng + 180) / 360) * scale;
  const sinLat = Math.sin((lat * Math.PI) / 180);
  const clamped = Math.max(-0.9999, Math.min(0.9999, sinLat));
  const y = (0.5 - Math.log((1 + clamped) / (1 - clamped)) / (4 * Math.PI)) * scale;
  return { x, y };
}
function worldPxToLatLng(wx, wy, zoom) {
  const scale = 256 * Math.pow(2, zoom);
  const lng = (wx / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * wy) / scale;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lat, lng };
}
function buildGoogleEarthUrl(lat, lng, alt = 450) {
  return `https://earth.google.com/web/@${Number(lat).toFixed(6)},${Number(lng).toFixed(6)},${alt}a,1100d,35y,0h,45t,0r`;
}
function exportLocationToKML() {
  const esc = (s) => String(s || '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
  const bldgName = state.project.buildingName || 'Proyecto SALO';
  const placemarks = [
    `    <Placemark><name>${esc(bldgName)}</name><description>${esc(state.location.placeName)}</description><Point><coordinates>${state.location.lng},${state.location.lat},0</coordinates></Point></Placemark>`,
    ...state.location.pois.map((p) => `    <Placemark><name>${esc(p.name)}</name><description>${esc(p.note || '')}</description><Point><coordinates>${p.lng},${p.lat},0</coordinates></Point></Placemark>`)
  ].join('\n');
  const kml = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n  <Document>\n    <name>${esc(bldgName)} · SALO SHOWROOM</name>\n${placemarks}\n  </Document>\n</kml>`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([kml], { type: 'application/vnd.google-earth.kml+xml' }));
  a.download = 'ubicacion-puntos-google-earth.kml';
  a.click();
  showToast('Archivo .KML descargado para Google Earth');
}

function renderLocationMap() {
  const canvas = document.getElementById('location-tile-canvas');
  const stage = document.getElementById('location-map-stage');
  if (!canvas || !stage) return;
  const w = stage.clientWidth || window.innerWidth;
  const h = stage.clientHeight || window.innerHeight;
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }

  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#070a10'; ctx.fillRect(0, 0, w, h);

  const z = Math.round(locationMap.zoom);
  const centerWorld = latLngToWorldPx(locationMap.centerLat, locationMap.centerLng, z);
  const topLeftX = centerWorld.x - w / 2;
  const topLeftY = centerWorld.y - h / 2;
  const maxTile = Math.pow(2, z);

  ctx.strokeStyle = 'rgba(212, 175, 55, 0.14)';
  for (let gx = (-(topLeftX % 64) + 64) % 64; gx < w; gx += 64) { ctx.beginPath(); ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.stroke(); }
  for (let gy = (-(topLeftY % 64) + 64) % 64; gy < h; gy += 64) { ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke(); }

  const drawLayer = (cache, urlFn) => {
    for (let tx = Math.floor(topLeftX / 256); tx <= Math.floor((topLeftX + w) / 256); tx++) {
      for (let ty = Math.floor(topLeftY / 256); ty <= Math.floor((topLeftY + h) / 256); ty++) {
        if (ty < 0 || ty >= maxTile) continue;
        const wx = ((tx % maxTile) + maxTile) % maxTile;
        const key = `${z}/${ty}/${wx}`;
        let entry = cache.get(key);
        if (!entry) {
          const img = new Image(); img.crossOrigin = 'anonymous';
          entry = { img, loaded: false }; cache.set(key, entry);
          img.onload = () => { entry.loaded = true; if (state.activeView === 'location') renderLocationMap(); };
          img.src = urlFn(z, ty, wx);
        }
        if (entry.loaded) ctx.drawImage(entry.img, Math.floor(tx * 256 - topLeftX), Math.floor(ty * 256 - topLeftY), 256, 256);
      }
    }
  };
  drawLayer(locationMap.tileCache, (zz, yy, xx) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${zz}/${yy}/${xx}`);
  drawLayer(locationMap.labelCache, (zz, yy, xx) => `https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/${zz}/${yy}/${xx}`);
  document.getElementById('map-zoom-label').textContent = `Z${z}`;
  const zSlider = document.getElementById('slider-map-zoom');
  if (zSlider && Number(zSlider.value) !== z) zSlider.value = String(z);
  renderLocationMarkers(topLeftX, topLeftY, z);
}

function renderLocationMarkers(topLeftX, topLeftY, z) {
  const layer = document.getElementById('location-markers-layer');
  if (!layer) return;
  layer.innerHTML = '';

  const mainPt = latLngToWorldPx(state.location.lat, state.location.lng, z);
  const mainEl = document.createElement('div');
  mainEl.className = 'map-poi-marker main-project';
  mainEl.style.left = `${mainPt.x - topLeftX}px`;
  mainEl.style.top = `${mainPt.y - topLeftY}px`;
  mainEl.innerHTML = `<span class="map-poi-label" style="border-color:var(--gold-bright);color:var(--gold-bright);">✦ ${state.project.buildingName || 'Proyecto SALO'}</span><div class="map-poi-pin-head"><span>🏛️</span></div>`;
  mainEl.addEventListener('click', (e) => { e.stopPropagation(); window.open(buildGoogleEarthUrl(state.location.lat, state.location.lng), '_blank'); });
  layer.appendChild(mainEl);

  state.location.pois.forEach((poi) => {
    const pt = latLngToWorldPx(poi.lat, poi.lng, z);
    const el = document.createElement('div');
    el.className = 'map-poi-marker';
    el.style.left = `${pt.x - topLeftX}px`;
    el.style.top = `${pt.y - topLeftY}px`;
    el.innerHTML = `<span class="map-poi-label">${poi.name}${poi.note ? ` · <small style="color:var(--gold-bright);">${poi.note}</small>` : ''}</span><div class="map-poi-pin-head" style="background:${poi.color || '#d4af37'};"><span>${poi.icon || '📍'}</span></div>`;
    el.addEventListener('click', (e) => { e.stopPropagation(); locationMap.centerLat = poi.lat; locationMap.centerLng = poi.lng; renderLocationMap(); });
    layer.appendChild(el);
  });
}

function renderLocationPoiList() {
  const list = document.getElementById('location-poi-list');
  const countEl = document.getElementById('poi-count-badge');
  const roEl = document.getElementById('loc-coords-readonly');
  if (roEl) roEl.textContent = `Lat: ${Number(state.location.lat).toFixed(6)} · Lng: ${Number(state.location.lng).toFixed(6)}`;
  document.getElementById('loc-input-lat').value = String(state.location.lat);
  document.getElementById('loc-input-lng').value = String(state.location.lng);
  if (!list) return;
  list.innerHTML = '';
  if (countEl) countEl.textContent = String(state.location.pois.length);

  state.location.pois.forEach((poi) => {
    const row = document.createElement('div');
    row.className = 'poi-list-item';
    row.innerHTML = `
      <div style="min-width:0;flex:1;">
        <div style="font-size:11px;font-weight:700;color:var(--ink-white);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${poi.icon} ${poi.name}</div>
        <div style="font-size:9.5px;color:var(--ink-silver);">${poi.note || `${poi.lat.toFixed(4)}, ${poi.lng.toFixed(4)}`}</div>
      </div>
      <div style="display:flex;gap:3px;flex-shrink:0;">
        <button class="icon-btn" data-poi-earth="${poi.id}" title="Ver en Google Earth" style="width:24px;height:24px;">🌍</button>
        ${isEditor() ? `<button class="icon-btn" data-poi-del="${poi.id}" title="Eliminar" style="width:24px;height:24px;color:#f87171;">🗑️</button>` : ''}
      </div>
    `;
    row.addEventListener('click', (e) => { if (e.target.closest('button')) return; locationMap.centerLat = poi.lat; locationMap.centerLng = poi.lng; renderLocationMap(); });
    row.querySelector(`[data-poi-earth="${poi.id}"]`).addEventListener('click', (e) => { e.stopPropagation(); window.open(buildGoogleEarthUrl(poi.lat, poi.lng), '_blank'); });
    const del = row.querySelector(`[data-poi-del="${poi.id}"]`);
    if (del) del.addEventListener('click', (e) => { e.stopPropagation(); state.location.pois = state.location.pois.filter((x) => x.id !== poi.id); savePersistedState(); renderLocationPoiList(); renderLocationMap(); });
    list.appendChild(row);
  });
}

function initLocationMap() {
  locationMap.hasAutoFitted = false;
  locationMap.centerLat = state.location.lat;
  locationMap.centerLng = state.location.lng;
  locationMap.zoom = state.location.zoom || 15;
  const stage = document.getElementById('location-map-stage');
  if (!stage) return;

  if (!locationMap.listenersBound) {
    locationMap.listenersBound = true;
    const pinchDist = () => {
      const pts = [...locationMap.activePointers.values()];
      if (pts.length < 2) return 0;
      return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    };

    stage.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.map-poi-marker, .location-zoom-rail')) return;
      e.preventDefault();
      locationMap.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (locationMap.activePointers.size === 2) {
        locationMap.dragging = false;
        locationMap.pinchStartDist = pinchDist();
        locationMap.pinchStartZoom = locationMap.zoom;
        return;
      }
      locationMap.dragging = true; locationMap.dragMoved = false;
      locationMap.dragStartX = e.clientX; locationMap.dragStartY = e.clientY;
      locationMap.dragStartLat = locationMap.centerLat; locationMap.dragStartLng = locationMap.centerLng;
    });
    window.addEventListener('pointermove', (e) => {
      if (locationMap.activePointers.has(e.pointerId)) {
        locationMap.activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      }
      if (state.activeView !== 'location') return;
      if (locationMap.activePointers.size >= 2 && locationMap.pinchStartDist > 0) {
        e.preventDefault();
        const ratio = pinchDist() / locationMap.pinchStartDist;
        const delta = Math.round(Math.log2(Math.max(0.25, Math.min(4, ratio))) * 1.5);
        const nextZ = Math.max(3, Math.min(18, Math.round(locationMap.pinchStartZoom + delta)));
        if (nextZ !== locationMap.zoom) setLocationMapZoom(nextZ);
        return;
      }
      const rect = stage.getBoundingClientRect();
      const z = Math.round(locationMap.zoom);
      const centerW = latLngToWorldPx(locationMap.centerLat, locationMap.centerLng, z);
      const ll = worldPxToLatLng(centerW.x - rect.width / 2 + (e.clientX - rect.left), centerW.y - rect.height / 2 + (e.clientY - rect.top), z);
      const readout = document.getElementById('map-cursor-coords');
      if (readout) readout.textContent = `Lat: ${ll.lat.toFixed(5)} · Lng: ${ll.lng.toFixed(5)}`;
      if (!locationMap.dragging) return;
      e.preventDefault();
      const dx = e.clientX - locationMap.dragStartX, dy = e.clientY - locationMap.dragStartY;
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) locationMap.dragMoved = true;
      const startW = latLngToWorldPx(locationMap.dragStartLat, locationMap.dragStartLng, z);
      const newLL = worldPxToLatLng(startW.x - dx, startW.y - dy, z);
      locationMap.centerLat = Math.max(-80, Math.min(80, newLL.lat));
      locationMap.centerLng = newLL.lng;
      renderLocationMap();
    }, { passive: false });
    const endMapPointer = (e) => {
      locationMap.activePointers.delete(e.pointerId);
      if (locationMap.activePointers.size === 1) {
        locationMap.pinchStartDist = 0;
        const rem = [...locationMap.activePointers.values()][0];
        locationMap.dragging = true;
        locationMap.dragMoved = true;
        locationMap.dragStartX = rem.x;
        locationMap.dragStartY = rem.y;
        locationMap.dragStartLat = locationMap.centerLat;
        locationMap.dragStartLng = locationMap.centerLng;
        return;
      }
      if (locationMap.activePointers.size < 2) locationMap.pinchStartDist = 0;
      if (!locationMap.dragging) return;
      locationMap.dragging = false;
      if (!locationMap.dragMoved && isEditor() && locationMap.isPlacingPoi && state.activeView === 'location') {
        const rect = stage.getBoundingClientRect();
        const z = Math.round(locationMap.zoom);
        const centerW = latLngToWorldPx(locationMap.centerLat, locationMap.centerLng, z);
        const ll = worldPxToLatLng(centerW.x - rect.width / 2 + (e.clientX - rect.left), centerW.y - rect.height / 2 + (e.clientY - rect.top), z);
        document.getElementById('poi-input-name').value = '';
        document.getElementById('poi-input-note').value = '';
        document.getElementById('poi-input-lat').value = ll.lat.toFixed(6);
        document.getElementById('poi-input-lng').value = ll.lng.toFixed(6);
        document.getElementById('modal-poi-editor').classList.add('open');
      }
    };
    window.addEventListener('pointerup', endMapPointer);
    window.addEventListener('pointercancel', endMapPointer);
    stage.addEventListener('touchmove', (e) => { e.preventDefault(); }, { passive: false });
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      setLocationMapZoom(locationMap.zoom + (e.deltaY < 0 ? 1 : -1));
    }, { passive: false });
  }
  renderLocationPoiList();
  fitLocationMapBounds();
}

/* ==========================================================================
   9. UNITS CATALOG (DEPARTAMENTOS / POR NIVELES / CASA TOTAL) & VIEW SWITCHER
   ========================================================================== */
function createUnitCatalogCard(u) {
  const statusLabels = { available: '🟢 Disponible', reserved: '🟠 Reservado', sold: '🔴 Vendido' };
  const card = document.createElement('article');
  card.className = 'unit-card';
  const showAvail = u.showAvailability !== false;
  const extraLinesHtml = (u.customLines || []).slice(0, 3).map((ln) => (
    ln.type === 'text'
      ? `<div style="font-size:10.5px;color:var(--ink-silver);border-left:2px solid var(--gold-primary);padding-left:6px;">${ln.label}</div>`
      : `<div style="display:flex;justify-content:space-between;font-size:10.5px;color:var(--ink-silver);"><span>${ln.label}</span><strong style="color:var(--gold-bright);">${ln.number} ${ln.unit || ''}</strong></div>`
  )).join('');

  card.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;">
      ${showAvail ? `<span class="availability-top-banner ${u.status}" style="padding:3px 8px;font-size:10px;">${statusLabels[u.status] || '🟢 Disponible'}</span>` : '<span class="code-tag">Ambiente / Nivel</span>'}
      ${u.price ? `<strong style="font-family:var(--font-display);font-size:15px;color:var(--gold-bright);">$${Number(u.price).toLocaleString()}</strong>` : ''}
    </div>
    <div>
      <h3 style="font-family:var(--font-display);font-size:14.5px;color:var(--ink-white);">${u.code}</h3>
      <p style="font-size:10.5px;color:var(--ink-silver);">${u.floorLabel || ''}</p>
    </div>
    <div class="unit-kpi-grid">
      <div class="kpi-box"><strong>${u.area} m²</strong><span>Área</span></div>
      <div class="kpi-box"><strong>${u.beds} Ctos / ${u.baths ?? 2} Bñ</strong><span>Ambientes</span></div>
      <div class="kpi-box"><strong>${u.kitchens ?? 1} Cocina</strong><span>Equipada</span></div>
    </div>
    ${extraLinesHtml ? `<div style="display:flex;flex-direction:column;gap:4px;">${extraLinesHtml}</div>` : ''}
    <div style="display:flex;gap:6px;">
      <button class="action-btn" style="flex:1;" data-goto-poly="${u.id}">📍 Ver Unidad</button>
      <button class="action-btn gold-cta" style="flex:1;grid-column:auto;" data-goto-planta="${u.id}">🎬 Ir a Planta</button>
    </div>
  `;
  card.querySelector('[data-goto-poly]').addEventListener('click', () => {
    pushNavHistory();
    state.activeLevelId = u.levelId || 'facade';
    state.showAvailability = true;
    switchView('masterplan', false, true);
    renderLevelsSidebar();
    drawMasterplanRender();
    selectUnit(u.id, true);
  });
  card.querySelector('[data-goto-planta]').addEventListener('click', () => {
    switchView('masterplan', false, true);
    selectUnit(u.id, true);
    triggerPolygonTargetTransition(u);
  });
  return card;
}

function renderUnitsCatalog() {
  const grid = document.getElementById('units-catalog-grid');
  if (!grid) return;

  const mode = state.unitsConfig?.displayMode || 'departments';
  document.querySelectorAll('[data-units-mode]').forEach((b) => b.classList.toggle('active', b.dataset.unitsMode === mode));
  const filterBar = document.getElementById('units-filter-bar');
  if (filterBar) filterBar.style.display = mode === 'house' ? 'none' : 'flex';

  const statusVal = document.getElementById('filter-status')?.value || 'all';
  const bedsVal = Number(document.getElementById('filter-beds')?.value || 0);
  const maxPrice = Number(document.getElementById('filter-price')?.value || 450000);
  const priceLbl = document.getElementById('filter-price-label');
  if (priceLbl) priceLbl.textContent = `$${maxPrice.toLocaleString()}`;

  const filtered = state.units.filter((u) => (statusVal === 'all' || u.status === statusVal) && u.beds >= bedsVal && u.price <= maxPrice);
  grid.innerHTML = '';

  if (mode === 'levels') {
    grid.style.display = 'flex';
    grid.style.flexDirection = 'column';
    grid.style.gap = '14px';

    state.levels.forEach((lvl) => {
      const lvlUnits = filtered.filter((u) => u.levelId === lvl.id || (lvl.id !== 'facade' && u.targetLevelId === lvl.id && u.levelId === 'facade'));
      if (lvl.id === 'facade' && lvlUnits.length === 0) return;

      const sec = document.createElement('section');
      sec.className = 'units-level-section';
      sec.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;border-bottom:1px solid var(--gold-border);padding-bottom:8px;">
          <div style="display:flex;align-items:center;gap:10px;">
            <img src="${lvl.dayPhoto}" alt="" style="width:52px;height:36px;object-fit:cover;border-radius:7px;border:1px solid var(--gold-border);" />
            <div>
              <h3 style="font-family:var(--font-display);font-size:15px;color:var(--gold-bright);">${lvl.name}</h3>
              <span style="font-size:10.5px;color:var(--ink-silver);">${lvlUnits.length} unidades / ambientes · ${lvl.hasTour360 !== false ? 'Tour 360° habilitado' : 'Sin Tour 360°'}</span>
            </div>
          </div>
          <div style="display:flex;gap:6px;">
            <button class="glass-pill-btn active" data-open-lvl="${lvl.id}">🗺️ Abrir Planta</button>
            ${lvl.hasTour360 !== false ? `<button class="glass-pill-btn" data-open-lvl-360="${lvl.id}">🌐 360° del Nivel</button>` : ''}
          </div>
        </div>
        <div class="units-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;"></div>
      `;
      sec.querySelector('[data-open-lvl]').addEventListener('click', () => {
        switchView('masterplan', false, true);
        navigateToLevelWithTransition(lvl.id, 'auto', true);
      });
      const b360 = sec.querySelector('[data-open-lvl-360]');
      if (b360) b360.addEventListener('click', () => openFloorTour360(lvl.id, null, true));

      const innerGrid = sec.querySelector('.units-grid');
      if (lvlUnits.length === 0) {
        innerGrid.innerHTML = '<span style="font-size:11px;color:var(--ink-muted);">Sin polígonos trazados en este nivel todavía.</span>';
      } else {
        lvlUnits.forEach((u) => innerGrid.appendChild(createUnitCatalogCard(u)));
      }
      grid.appendChild(sec);
    });
    return;
  }

  if (mode === 'house') {
    grid.style.display = 'block';
    const totalArea = state.units.reduce((s, u) => s + (Number(u.area) || 0), 0);
    const totalBeds = state.units.reduce((s, u) => s + (Number(u.beds) || 0), 0);
    const totalBaths = state.units.reduce((s, u) => s + (Number(u.baths) || 0), 0);
    const totalPrice = state.units.reduce((s, u) => s + (Number(u.price) || 0), 0);
    const floorLevels = state.levels.filter((l) => l.id !== 'facade' && l.id !== 'masterplan');

    const card = document.createElement('div');
    card.className = 'casa-total-card';
    card.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:14px;">
        <div>
          <span class="dropdown-role-badge">🏡 Vista Casa Total / Propiedad Completa</span>
          <h3 style="font-family:var(--font-display);font-size:22px;color:var(--gold-bright);margin-top:6px;">${state.project.fullTitle}</h3>
          <p style="font-size:12px;color:var(--ink-silver);margin-top:4px;">${state.project.subtitle}</p>
        </div>
        <button class="action-btn whatsapp-cta" id="btn-casa-total-wa" style="grid-column:auto;padding:10px 18px;">💬 Consultar Propiedad Completa</button>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;">
        <div class="kpi-box"><strong style="font-size:18px;">${totalArea.toLocaleString()} m²</strong><span>Superficie Total</span></div>
        <div class="kpi-box"><strong style="font-size:18px;">${floorLevels.length} Niveles</strong><span>Plantas Configuradas</span></div>
        <div class="kpi-box"><strong style="font-size:18px;">${totalBeds} Dorm. / ${totalBaths} Baños</strong><span>Ambientes Totales</span></div>
        <div class="kpi-box"><strong style="font-size:18px;color:#4ade80;">$${totalPrice.toLocaleString()} USD</strong><span>Valor Referencial</span></div>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px;" id="casa-total-floors-list"></div>
    `;
    card.querySelector('#btn-casa-total-wa').addEventListener('click', () => {
      window.open(buildWhatsAppUrl(`Hola, deseo consultar por la propiedad completa ${state.project.fullTitle} (${totalArea} m²).`), '_blank');
    });
    const fList = card.querySelector('#casa-total-floors-list');
    floorLevels.forEach((lvl) => {
      const fItem = document.createElement('div');
      fItem.className = 'unit-card';
      fItem.style.padding = '10px';
      fItem.innerHTML = `
        <img src="${lvl.dayPhoto}" alt="" style="width:100%;height:105px;object-fit:cover;border-radius:8px;border:1px solid var(--gold-border);" />
        <strong style="font-family:var(--font-display);font-size:13px;color:var(--gold-bright);">${lvl.name}</strong>
        <div style="display:flex;gap:5px;">
          <button class="action-btn gold-cta" style="flex:1;grid-column:auto;padding:6px;" data-ch-lvl="${lvl.id}">🗺️ Ver Planta</button>
          ${lvl.hasTour360 !== false ? `<button class="action-btn" style="padding:6px 9px;" data-ch-360="${lvl.id}">🌐 360°</button>` : ''}
        </div>
      `;
      fItem.querySelector('[data-ch-lvl]').addEventListener('click', () => {
        switchView('masterplan', false, true);
        navigateToLevelWithTransition(lvl.id, 'auto', true);
      });
      const b360 = fItem.querySelector('[data-ch-360]');
      if (b360) b360.addEventListener('click', () => openFloorTour360(lvl.id, null, true));
      fList.appendChild(fItem);
    });
    grid.appendChild(card);
    return;
  }

  // Default: 'departments' grid
  grid.style.display = 'grid';
  grid.style.gridTemplateColumns = 'repeat(auto-fill, minmax(265px, 1fr))';
  grid.style.gap = '14px';
  filtered.forEach((u) => grid.appendChild(createUnitCatalogCard(u)));
}

async function switchView(viewName, allowTransition = false, skipHistory = false) {
  if (viewName === 'studio' && !isEditor()) { showToast('Solo cuentas de Editor pueden acceder al Estudio'); return; }
  if (viewName === 'units' && state.unitsConfig?.showTab === false && !isEditor()) {
    showToast('La pestaña de Unidades está oculta');
    return;
  }
  if (viewName === 'model3d' && state.model3dConfig?.showTab === false && !isEditor()) {
    showToast('La Maqueta 3D está oculta en este proyecto');
    return;
  }

  if (!skipHistory && state.activeView !== viewName) pushNavHistory();

  const doSwitch = () => {
    state.activeView = viewName;
    setNavDockExpanded(false);
    document.querySelectorAll('.nav-btn[data-view]').forEach((btn) => btn.classList.toggle('active', btn.dataset.view === viewName));
    document.querySelectorAll('.view-panel').forEach((panel) => panel.classList.toggle('active', panel.id === `view-${viewName}`));
    if (viewName !== 'masterplan') document.body.classList.remove('has-exterior-360-btn');
    else {
      const portalEl = document.getElementById('exterior-portal-360');
      document.body.classList.toggle('has-exterior-360-btn', Boolean(portalEl && portalEl.style.display !== 'none'));
      requestAnimationFrame(() => syncSceneMediaBox());
    }

    const strip = document.getElementById('editor-quick-strip');
    if (strip) strip.style.visibility = (viewName === 'masterplan' && isEditor()) ? 'visible' : 'hidden';

    if (viewName === 'tour360' && tour360.renderer) {
      resetTour360CameraToCenter();
      const c = document.getElementById('tour360-container');
      tour360.camera.aspect = c.clientWidth / c.clientHeight;
      tour360.camera.updateProjectionMatrix();
      tour360.renderer.setSize(c.clientWidth, c.clientHeight);
      renderNumbered360Bar();
      renderTour360FloorsPanel();
      if (('ontouchstart' in window || navigator.maxTouchPoints > 0)
        && typeof window.DeviceOrientationEvent !== 'undefined'
        && typeof window.DeviceOrientationEvent.requestPermission !== 'function'
        && !tour360.gyroEnabled && !tour360.gyroAutoAttempted) {
        tour360.gyroAutoAttempted = true;
        toggleTour360Gyroscope(true, false);
      }
    }
    if (viewName === 'model3d' && model3d.renderer) {
      const c = document.getElementById('model3d-canvas-container');
      model3d.camera.aspect = c.clientWidth / c.clientHeight;
      model3d.camera.updateProjectionMatrix();
      model3d.renderer.setSize(c.clientWidth, c.clientHeight);
    }
    if (viewName === 'finishes') renderActiveFinishTabControlsAndImages();
    if (viewName === 'location') {
      if (!locationMap.hasAutoFitted) fitLocationMapBounds();
      else renderLocationMap();
    }
    if (viewName === 'units') renderUnitsCatalog();
    if (viewName === 'studio') switchStudioTab(studioActiveTab || 'transitions');
    syncProjectLogoUI();
    updateBackButtonUI();
  };

  if (allowTransition && state.activeView !== viewName && state.transitions?.globalEnabled) {
    const fromEndpoint = state.activeView === 'masterplan' ? (state.activeLevelId || 'facade') : state.activeView;
    const toEndpoint = viewName === 'masterplan' ? (state.activeLevelId || 'facade') : viewName;
    const findExactSlot = (f, t) => (state.transitions.slots || []).find((s) => s.fromLevelId === f && s.toLevelId === t);
    let matchedSlot = findExactSlot(fromEndpoint, toEndpoint);
    if (!matchedSlot && viewName === 'masterplan' && toEndpoint !== 'facade') {
      matchedSlot = findExactSlot(fromEndpoint, 'facade');
    }
    if (!matchedSlot && (viewName === 'tour360' || viewName === 'model3d')) {
      const legacyId = viewName === 'tour360' ? 'to_tour360' : 'to_model3d';
      matchedSlot = (state.transitions.slots || []).find((s) => s.id === legacyId && (!s.toLevelId || s.toLevelId === viewName));
    }
    if (matchedSlot && matchedSlot.enabled && matchedSlot.transitionType !== 'none') {
      if (matchedSlot.transitionType === 'two_images' && (matchedSlot.img1Url || matchedSlot.img2Url)) {
        await playTwoImageTransition(matchedSlot.img1Url, matchedSlot.img2Url, doSwitch);
        return;
      }
      const vid = matchedSlot.mediaKey ? await getMediaUrl(matchedSlot.mediaKey) : matchedSlot.defaultVideo;
      if (vid) { await playTransitionVideoThen(vid, doSwitch); return; }
    }
  }
  doSwitch();
}

function updateMasterplanZoomTransform() {
  const layer = document.getElementById('zoom-layer');
  const label = document.getElementById('zoom-percentage');
  if (!layer || !label) return;
  layer.style.transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`;
  label.textContent = `${Math.round(state.zoom * 100)}%`;
}

/* ==========================================================================
   10. EVENT BINDINGS (INCLUDING MAIHUENIA CONTROLS & KEYBOARD NAV)
   ========================================================================== */
function bindEvents() {
  // Project Dropdown
  const ddBtn = document.getElementById('btn-project-dropdown');
  const ddMenu = document.getElementById('project-dropdown-menu');
  const closeDropdown = () => { ddMenu.classList.remove('open'); ddBtn.classList.remove('open'); ddBtn.setAttribute('aria-expanded', 'false'); };
  ddBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = !ddMenu.classList.contains('open');
    ddMenu.classList.toggle('open', open); ddBtn.classList.toggle('open', open); ddBtn.setAttribute('aria-expanded', String(open));
  });
  window.addEventListener('click', (e) => { if (!e.target.closest('.project-dropdown-wrap')) closeDropdown(); });

  // Maihuenia Slide-Over Menu Drawer (☰)
  const menuDrawer = document.getElementById('maihuenia-menu-drawer');
  const menuBackdrop = document.getElementById('menu-drawer-backdrop');
  const openMenuDrawer = () => { menuDrawer.classList.add('open'); menuBackdrop.classList.add('open'); };
  const closeMenuDrawer = () => { menuDrawer.classList.remove('open'); menuBackdrop.classList.remove('open'); };
  document.getElementById('btn-open-menu-drawer').addEventListener('click', openMenuDrawer);
  document.getElementById('btn-close-menu-drawer').addEventListener('click', closeMenuDrawer);
  menuBackdrop.addEventListener('click', closeMenuDrawer);
  document.querySelectorAll('[data-drawer-nav]').forEach((btn) => {
    btn.addEventListener('click', () => { closeMenuDrawer(); switchView(btn.dataset.drawerNav, true); });
  });

  // SALO MULTI-PROJECT PORTAL BINDINGS
  document.querySelectorAll('[data-portal-tab]').forEach((btn) => {
    btn.addEventListener('click', () => switchPortalTab(btn.dataset.portalTab));
  });
  document.getElementById('btn-portal-goto-editor-login')?.addEventListener('click', () => switchPortalTab('editors'));
  document.getElementById('btn-portal-open-code')?.addEventListener('click', () => {
    const code = document.getElementById('portal-code-input')?.value || '';
    openProjectBySecretPortalInput(code);
  });
  document.getElementById('portal-code-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') openProjectBySecretPortalInput(e.target.value);
  });
  document.getElementById('gate-code-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    verifyAndSubmitCodeGate();
  });
  document.getElementById('btn-gate-code-submit')?.addEventListener('click', verifyAndSubmitCodeGate);
  const closeCodeGate = () => {
    pendingGateProject = null;
    document.getElementById('modal-project-code-gate')?.classList.remove('open');
  };
  document.getElementById('btn-close-code-gate')?.addEventListener('click', closeCodeGate);
  document.getElementById('btn-cancel-code-gate')?.addEventListener('click', closeCodeGate);
  document.getElementById('portal-search-input')?.addEventListener('input', renderPortalProjects);

  document.getElementById('btn-portal-create-project')?.addEventListener('click', openNewProjectModal);
  document.getElementById('btn-portal-signed-new-proj')?.addEventListener('click', openNewProjectModal);
  document.getElementById('btn-close-new-project')?.addEventListener('click', () => document.getElementById('modal-new-project').classList.remove('open'));
  document.getElementById('btn-cancel-new-project')?.addEventListener('click', () => document.getElementById('modal-new-project').classList.remove('open'));
  document.getElementById('np-upload-cover')?.addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const key = `proj-cover-${Date.now()}`;
    const url = await saveMediaBlob(key, file);
    newProjectCoverDraft = { url, mediaKey: key };
    document.getElementById('np-cover-lbl').textContent = `✅ Portada lista: ${file.name}`;
    e.target.value = '';
  });
  document.getElementById('btn-confirm-new-project')?.addEventListener('click', createNewProjectFromModal);

  const handlePortalExampleUpload = async (e) => {
    if (!isEditor()) return;
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    for (const file of files) {
      const id = `ex-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const key = `portal-example-${id}`;
      const url = await saveMediaBlob(key, file);
      portalState.examplePhotos.unshift({ id, title: file.name.replace(/\.[^.]+$/, ''), url, mediaKey: key });
    }
    savePortalState();
    renderPortalExamples();
    showToast(`${files.length} foto(s) de ejemplo subidas al portal`);
    e.target.value = '';
  };
  document.getElementById('input-portal-upload-examples')?.addEventListener('change', handlePortalExampleUpload);
  document.getElementById('input-portal-upload-examples-2')?.addEventListener('change', handlePortalExampleUpload);

  // Portfolio Visual Project Folders (Create & Viewer modals)
  document.getElementById('btn-portal-create-folder')?.addEventListener('click', openPortfolioFolderCreateModal);
  document.getElementById('btn-portal-create-folder-2')?.addEventListener('click', openPortfolioFolderCreateModal);
  document.getElementById('btn-close-pf-create')?.addEventListener('click', () => document.getElementById('modal-portfolio-folder-create')?.classList.remove('open'));
  document.getElementById('btn-cancel-pf-create')?.addEventListener('click', () => document.getElementById('modal-portfolio-folder-create')?.classList.remove('open'));
  document.getElementById('btn-confirm-pf-create')?.addEventListener('click', confirmCreatePortfolioFolder);
  document.getElementById('btn-close-pf-viewer')?.addEventListener('click', () => document.getElementById('modal-portfolio-folder-viewer')?.classList.remove('open'));
  document.getElementById('btn-pf-viewer-rename')?.addEventListener('click', () => {
    if (!isEditor() || !activePortfolioFolderId) return;
    const folder = portalState.examplePhotos.find((x) => x && x.id === activePortfolioFolderId && x.type === 'folder');
    if (!folder) return;
    const nextTitle = window.prompt('Nuevo nombre para la carpeta:', folder.title || '');
    if (!nextTitle || !nextTitle.trim()) return;
    folder.title = nextTitle.trim();
    savePortalState();
    renderPortalExamples();
    openPortfolioFolderViewer(folder.id);
    showToast('Carpeta renombrada');
  });
  document.getElementById('input-pf-viewer-cover')?.addEventListener('change', async (e) => {
    if (!isEditor() || !activePortfolioFolderId) return;
    const file = e.target.files?.[0];
    if (!file) return;
    const folder = portalState.examplePhotos.find((x) => x && x.id === activePortfolioFolderId && x.type === 'folder');
    if (!folder) return;
    const key = `portal-folder-cover-${folder.id}-${Date.now()}`;
    folder.coverUrl = await saveMediaBlob(key, file);
    folder.coverMediaKey = key;
    savePortalState();
    renderPortalExamples();
    showToast('Portada de carpeta actualizada');
    e.target.value = '';
  });
  document.getElementById('input-pf-viewer-add-photos')?.addEventListener('change', async (e) => {
    if (!isEditor() || !activePortfolioFolderId) return;
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    const folder = portalState.examplePhotos.find((x) => x && x.id === activePortfolioFolderId && x.type === 'folder');
    if (!folder) return;
    if (!Array.isArray(folder.items)) folder.items = [];
    for (const file of files) {
      const itemId = `it-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const mediaKey = `portal-folder-item-${folder.id}-${itemId}`;
      const url = await saveMediaBlob(mediaKey, file);
      folder.items.push({ id: itemId, title: file.name.replace(/\.[^.]+$/, ''), url, mediaKey });
    }
    savePortalState();
    renderPortalExamples();
    openPortfolioFolderViewer(folder.id);
    showToast(`${files.length} foto(s) añadidas a "${folder.title}"`);
    e.target.value = '';
  });

  document.getElementById('btn-portal-login-submit')?.addEventListener('click', () => {
    const u = document.getElementById('portal-login-user').value.trim();
    const p = document.getElementById('portal-login-pin').value.trim();
    const match = portalState.auth.editors.find((ed) => ed.username.toLowerCase() === u.toLowerCase() && ed.pin === p);
    if (match) {
      portalState.auth.mode = 'editor';
      portalState.auth.currentUser = match.username;
      savePortalState();
      document.getElementById('portal-login-error').style.display = 'none';
      applyRoleUI();
      showToast(`Bienvenido Editor: ${match.username}`);
    } else {
      document.getElementById('portal-login-error').style.display = 'block';
    }
  });
  document.getElementById('btn-portal-signed-manage-accounts')?.addEventListener('click', openAuthModal);
  document.getElementById('btn-portal-logout-editor')?.addEventListener('click', () => {
    portalState.auth.mode = 'public';
    savePortalState();
    applyRoleUI();
    showToast('Sesión cerrada · Vista Público General');
  });

  // Return to SALO Portal Homepage from Showroom
  const goToPortalHome = () => {
    closeDropdown();
    closeMenuDrawer();
    savePersistedState();
    switchPortalTab('projects');
    showScreen('portal');
  };
  document.getElementById('btn-return-to-portal')?.addEventListener('click', goToPortalHome);
  document.getElementById('menu-back-to-portal')?.addEventListener('click', goToPortalHome);
  document.getElementById('drawer-link-portal')?.addEventListener('click', goToPortalHome);

  // Universal Back Button ("← Volver Atrás") & Photo Lightbox Back Button
  document.getElementById('btn-global-back')?.addEventListener('click', goBackHistory);
  document.getElementById('btn-close-photo-viewer')?.addEventListener('click', () => {
    document.getElementById('modal-photo-viewer')?.classList.remove('open');
  });
  document.getElementById('modal-photo-viewer')?.addEventListener('click', (e) => {
    if (e.target.id === 'modal-photo-viewer') e.currentTarget.classList.remove('open');
  });

  // Top-right Toolbar Actions (Consult WhatsApp, Share, Fullscreen, Finder 🔍, Avance de Obra)
  const openWhatsAppGeneral = () => window.open(buildWhatsAppUrl(), '_blank');
  document.getElementById('btn-top-consult').addEventListener('click', openWhatsAppGeneral);
  document.getElementById('drawer-menu-whatsapp').addEventListener('click', openWhatsAppGeneral);

  document.getElementById('btn-top-share').addEventListener('click', () => {
    const shareUrl = `${window.location.origin}${window.location.pathname}?project=${encodeURIComponent(state.project.code || 'SALO-001')}&mode=public`;
    navigator.clipboard?.writeText(shareUrl).catch(() => {});
    showToast(`🔗 Enlace público (${state.project.code}) copiado`);
  });

  document.getElementById('btn-top-fullscreen').addEventListener('click', () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
    else document.exitFullscreen?.().catch(() => {});
  });

  document.getElementById('btn-finder-lupa').addEventListener('click', () => switchView('units'));

  // Avance de Obra Modal
  const openAvanceModal = () => { syncAvanceUI(); document.getElementById('modal-avance-obra').classList.add('open'); };
  document.getElementById('btn-open-avance').addEventListener('click', openAvanceModal);
  document.getElementById('menu-open-avance').addEventListener('click', () => { closeDropdown(); openAvanceModal(); });
  document.getElementById('drawer-link-avance').addEventListener('click', () => { closeMenuDrawer(); openAvanceModal(); });
  document.getElementById('btn-close-avance-modal').addEventListener('click', () => document.getElementById('modal-avance-obra').classList.remove('open'));
  document.getElementById('avance-input-pct').addEventListener('input', (e) => { document.getElementById('avance-edit-lbl').textContent = `${e.target.value}%`; });
  document.getElementById('btn-save-avance').addEventListener('click', () => {
    if (!isEditor()) return;
    state.avance.percent = Number(document.getElementById('avance-input-pct').value) || 0;
    state.avance.delivery = document.getElementById('avance-input-delivery').value.trim() || 'A definir';
    state.avance.stage = document.getElementById('avance-input-stage').value.trim() || 'En obra';
    savePersistedState();
    syncAvanceUI();
    document.getElementById('modal-avance-obra').classList.remove('open');
    showToast(`Avance de obra actualizado al ${state.avance.percent}%`);
  });

  // Collapsible Top Nav Dock Toggle
  document.getElementById('btn-toggle-nav-dock')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const shell = document.getElementById('showroom-shell');
    const isCollapsed = shell?.classList.contains('nav-dock-collapsed');
    setNavDockExpanded(isCollapsed);
  });

  // Sync #scene-media-box on image load & viewport changes
  const mpImgEl = document.getElementById('masterplan-custom-img');
  if (mpImgEl) mpImgEl.addEventListener('load', () => syncSceneMediaBox());
  window.addEventListener('resize', () => syncSceneMediaBox());
  window.addEventListener('orientationchange', () => setTimeout(syncSceneMediaBox, 120));
  window.visualViewport?.addEventListener('resize', () => syncSceneMediaBox());

  // Single Exterior View Cycle Button + Drag-to-Pan (overflowing/zoomed) or Drag-to-Orbit + Polygon Proximity Reveal
  document.getElementById('btn-flyby-prev').addEventListener('click', () => rotateExteriorFlyby(-1));
  document.getElementById('btn-flyby-next').addEventListener('click', () => rotateExteriorFlyby(1));
  document.getElementById('btn-cycle-exterior-view')?.addEventListener('click', () => rotateExteriorFlyby(1));

  let flybyDragStartX = null;
  let mpPanDrag = null;
  const mpViewport = document.getElementById('masterplan-viewport');
  mpViewport.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'touch') updatePolygonProximityReveal(e.clientX, e.clientY, 5.5);
    if (state.isDrawingPolygon || state.isPlacingPlanPoint || e.target.closest('button, .unit-polygon, .portal-360-hotspot')) return;
    const bounds = getScenePanBounds();
    if (bounds.overflowsX || bounds.overflowsY || state.zoom > 1) {
      mpPanDrag = { startX: e.clientX, startY: e.clientY, origX: state.pan.x || 0, origY: state.pan.y || 0, bounds };
      flybyDragStartX = null;
    } else {
      flybyDragStartX = e.clientX;
      mpPanDrag = null;
    }
  });
  mpViewport.addEventListener('pointermove', (e) => {
    if (mpPanDrag) {
      const dx = e.clientX - mpPanDrag.startX;
      const dy = e.clientY - mpPanDrag.startY;
      state.pan.x = Math.max(-mpPanDrag.bounds.maxX, Math.min(mpPanDrag.bounds.maxX, mpPanDrag.origX + dx));
      state.pan.y = Math.max(-mpPanDrag.bounds.maxY, Math.min(mpPanDrag.bounds.maxY, mpPanDrag.origY + dy));
      updateMasterplanZoomTransform();
      return;
    }
    if (!state.isDrawingPolygon && !state.editingShapeUnitId) {
      updatePolygonProximityReveal(e.clientX, e.clientY, 4.5);
    }
  });
  mpViewport.addEventListener('pointerleave', () => {
    clearPolygonProximityReveal();
  });
  const endMpPointerDrag = (e, allowSwipe = true) => {
    if (mpPanDrag) {
      mpPanDrag = null;
      return;
    }
    if (flybyDragStartX === null) return;
    const dx = allowSwipe && e ? (e.clientX - flybyDragStartX) : 0;
    flybyDragStartX = null;
    if (allowSwipe && Math.abs(dx) > 70 && state.activeView === 'masterplan' && state.activeLevelId === 'facade') {
      rotateExteriorFlyby(dx < 0 ? 1 : -1);
    }
  };
  window.addEventListener('pointerup', (e) => endMpPointerDrag(e, true));
  window.addEventListener('pointercancel', () => {
    endMpPointerDrag(null, false);
    tour360.isUserInteracting = false;
  });

  document.getElementById('btn-portal-360-enter').addEventListener('click', (e) => {
    e.stopPropagation();
    openFloorTour360(state.activeLevelId === 'facade' ? null : state.activeLevelId, null, true);
  });

  // Project Dropdown & Menu Drawer Items
  const openRenders = () => { renderGalleryModalContent(); document.getElementById('modal-renders-gallery').classList.add('open'); };
  document.getElementById('menu-open-location').addEventListener('click', () => { closeDropdown(); switchView('location'); });
  document.getElementById('menu-open-renders').addEventListener('click', () => { closeDropdown(); openRenders(); });
  document.getElementById('drawer-link-renders').addEventListener('click', () => { closeMenuDrawer(); openRenders(); });
  document.getElementById('menu-open-transitions').addEventListener('click', () => { closeDropdown(); openTransitionsManagerModal(); });
  document.getElementById('drawer-link-transitions').addEventListener('click', () => { closeMenuDrawer(); openTransitionsManagerModal(); });
  document.getElementById('btn-quick-transitions').addEventListener('click', openTransitionsManagerModal);
  document.getElementById('menu-open-studio').addEventListener('click', () => { closeDropdown(); switchView('studio'); });
  document.getElementById('nav-studio-pill').addEventListener('click', () => switchView('studio'));

  // Exterior Views & Intro Video Manager Bindings
  document.getElementById('btn-open-exterior-manager')?.addEventListener('click', openExteriorManagerModal);
  document.getElementById('menu-open-exterior-mgr')?.addEventListener('click', () => { closeDropdown(); openExteriorManagerModal(); });
  document.getElementById('drawer-link-exterior-mgr')?.addEventListener('click', () => { closeMenuDrawer(); openExteriorManagerModal(); });
  document.getElementById('btn-studio-open-exterior-mgr')?.addEventListener('click', openExteriorManagerModal);
  document.getElementById('btn-close-exterior-mgr')?.addEventListener('click', () => document.getElementById('modal-exterior-manager').classList.remove('open'));
  document.getElementById('toggle-intro-video-enabled')?.addEventListener('change', (e) => {
    if (!isEditor()) return;
    state.intro.enabled = e.target.checked;
    const lbl = document.getElementById('lbl-intro-enabled');
    if (lbl) {
      lbl.textContent = state.intro.enabled ? 'ACTIVADO' : 'DESACTIVADO';
      lbl.style.color = state.intro.enabled ? '#4ade80' : 'var(--ink-silver)';
    }
    savePersistedState();
    showToast(state.intro.enabled ? 'Video de Intro activado al ingresar' : 'Video de Intro desactivado');
  });
  document.getElementById('input-upload-intro-video')?.addEventListener('change', async (e) => {
    if (!isEditor()) return;
    const file = e.target.files[0]; if (!file) return;
    const key = `intro-video-${Date.now()}`;
    await saveMediaBlob(key, file);
    state.intro.mediaKey = key;
    state.intro.customName = file.name;
    state.intro.enabled = true;
    savePersistedState();
    openExteriorManagerModal();
    showToast(`Video de Intro "${file.name}" guardado`);
    e.target.value = '';
  });
  document.getElementById('btn-play-intro-now')?.addEventListener('click', () => {
    document.getElementById('modal-exterior-manager')?.classList.remove('open');
    playIntroVideo(true);
  });
  document.getElementById('input-replace-main-exterior')?.addEventListener('change', async (e) => {
    if (!isEditor()) return;
    const file = e.target.files[0]; if (!file) return;
    const key = `ext-main-${Date.now()}`;
    const url = await saveMediaBlob(key, file);
    if (state.exteriorAngles[0]) {
      state.exteriorAngles[0].photo = url;
      state.exteriorAngles[0].mediaKey = key;
      if (!state.exteriorAngles[0].nightMediaKey) state.exteriorAngles[0].nightPhoto = null;
      state.exteriorAngles[0].label = file.name.replace(/\.[^.]+$/, '') || 'Fachada Principal';
    }
    const facadeLvl = state.levels.find((l) => l.id === 'facade');
    if (facadeLvl) {
      facadeLvl.dayPhoto = url;
      facadeLvl.dayMediaKey = key;
      if (!facadeLvl.nightMediaKey) facadeLvl.nightPhoto = null;
    }
    state.activeLevelId = 'facade';
    state.exteriorAngleIndex = 0;
    savePersistedState();
    renderExteriorViewsManagerList();
    drawMasterplanRender();
    showToast('Vista principal actualizada en calidad original');
    e.target.value = '';
  });
  document.getElementById('input-add-exterior-photos')?.addEventListener('change', async (e) => {
    if (!isEditor()) return;
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;
    for (const file of files) {
      const id = `ext-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const key = `ext-photo-${id}`;
      const url = await saveMediaBlob(key, file);
      state.exteriorAngles.push({
        id,
        angleDeg: state.exteriorAngles.length * 45,
        label: file.name.replace(/\.[^.]+$/, '') || `Exterior ${state.exteriorAngles.length + 1}`,
        photo: url,
        nightPhoto: null,
        mediaKey: key,
        nightMediaKey: null
      });
    }
    savePersistedState();
    renderExteriorViewsManagerList();
    drawMasterplanRender();
    showToast(`${files.length} vista(s) exterior(es) añadidas`);
    e.target.value = '';
  });

  // Floor Creator Modal Bindings (+ Delete Floor)
  document.getElementById('btn-open-floor-creator')?.addEventListener('click', () => openFloorCreatorModal(null));
  document.getElementById('menu-open-floor-creator')?.addEventListener('click', () => { closeDropdown(); openFloorCreatorModal(null); });
  document.getElementById('drawer-link-floor-creator')?.addEventListener('click', () => { closeMenuDrawer(); openFloorCreatorModal(null); });
  document.getElementById('btn-sidebar-create-floor')?.addEventListener('click', () => openFloorCreatorModal(null));
  document.getElementById('btn-sidebar-edit-floor')?.addEventListener('click', () => {
    const activeLvl = state.levels.find((l) => l.id === state.activeLevelId);
    if (activeLvl) openFloorCreatorModal(activeLvl);
  });
  document.getElementById('btn-delete-floor-modal')?.addEventListener('click', () => {
    if (!isEditor() || !state.editingFloorId) return;
    const toDelete = state.editingFloorId;
    deleteFloorById(toDelete);
    document.getElementById('modal-floor-creator')?.classList.remove('open');
  });
  document.getElementById('input-upload-floor-plan-direct')?.addEventListener('change', async (e) => {
    if (!isEditor()) return;
    const file = e.target.files[0]; if (!file) return;
    const lvl = state.levels.find((l) => l.id === state.activeLevelId);
    if (!lvl) return;
    const key = `floor-plan-${lvl.id}-${Date.now()}`;
    const url = await saveMediaBlob(key, file);
    lvl.dayPhoto = url;
    lvl.dayMediaKey = key;
    if (!lvl.nightMediaKey) lvl.nightPhoto = null;
    if (lvl.id === 'facade' && state.exteriorAngles[0]) {
      state.exteriorAngles[0].photo = url;
      state.exteriorAngles[0].mediaKey = key;
      if (!state.exteriorAngles[0].nightMediaKey) state.exteriorAngles[0].nightPhoto = null;
    }
    savePersistedState();
    drawMasterplanRender();
    showToast(`Fotografía en planta guardada en ${lvl.name}`);
    e.target.value = '';
  });
  document.getElementById('input-upload-floor-night-direct')?.addEventListener('change', async (e) => {
    if (!isEditor()) return;
    const file = e.target.files[0]; if (!file) return;
    const lvl = state.levels.find((l) => l.id === state.activeLevelId);
    if (!lvl) return;
    const key = `floor-night-${lvl.id}-${Date.now()}`;
    const url = await saveMediaBlob(key, file);
    lvl.nightPhoto = url;
    lvl.nightMediaKey = key;
    if (lvl.id === 'facade') {
      const ang = state.exteriorAngles[state.exteriorAngleIndex] || state.exteriorAngles[0];
      if (ang) { ang.nightPhoto = url; ang.nightMediaKey = key; }
    }
    savePersistedState();
    toggleDayNightMode(true);
    showToast(`Vista nocturna cargada en ${lvl.name}`);
    e.target.value = '';
  });
  document.getElementById('floor-input-trans-type')?.addEventListener('change', syncFloorTransTypeUI);
  document.getElementById('floor-input-has-360')?.addEventListener('change', (e) => {
    const box = document.getElementById('floor-360-upload-box');
    if (box) box.style.display = e.target.checked ? 'flex' : 'none';
  });
  document.getElementById('floor-upload-trans-video')?.addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const key = `floor-trans-vid-${Date.now()}`;
    await saveMediaBlob(key, file);
    floorDraft.transVideoKey = key;
    floorDraft.transVideoName = file.name;
    document.getElementById('floor-trans-video-name').textContent = `🎬 ${file.name}`;
    showToast('Video de transición listo');
  });
  document.getElementById('floor-upload-trans-img1')?.addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const key = `floor-trans-img1-${Date.now()}`;
    floorDraft.transImg1Url = await saveMediaBlob(key, file);
    floorDraft.transImg1Key = key;
    document.getElementById('floor-twoimg-1-lbl').textContent = `✅ ${file.name}`;
  });
  document.getElementById('floor-upload-trans-img2')?.addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const key = `floor-trans-img2-${Date.now()}`;
    floorDraft.transImg2Url = await saveMediaBlob(key, file);
    floorDraft.transImg2Key = key;
    document.getElementById('floor-twoimg-2-lbl').textContent = `✅ ${file.name}`;
  });
  document.getElementById('floor-upload-plan-photo')?.addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const key = `floor-plan-photo-${Date.now()}`;
    floorDraft.planPhotoUrl = await saveMediaBlob(key, file);
    floorDraft.planPhotoKey = key;
    document.getElementById('floor-plan-photo-lbl').textContent = `✅ ${file.name}`;
    e.target.value = '';
  });
  document.getElementById('floor-input-night-file')?.addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const key = `floor-night-photo-${Date.now()}`;
    floorDraft.nightPhotoUrl = await saveMediaBlob(key, file);
    floorDraft.nightPhotoKey = key;
    const lbl = document.getElementById('floor-night-photo-lbl');
    if (lbl) lbl.textContent = `✅ ${file.name}`;
    const clr = document.getElementById('btn-floor-clear-night');
    if (clr) clr.style.display = 'inline-flex';
    e.target.value = '';
  });
  document.getElementById('btn-floor-clear-night')?.addEventListener('click', () => {
    floorDraft.nightPhotoUrl = null;
    floorDraft.nightPhotoKey = null;
    const lbl = document.getElementById('floor-night-photo-lbl');
    if (lbl) lbl.textContent = 'Opcional: si no se sube, el modo Noche mantiene la foto principal sin oscurecer';
    const clr = document.getElementById('btn-floor-clear-night');
    if (clr) clr.style.display = 'none';
  });
  document.getElementById('floor-upload-initial-360')?.addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const key = `floor-init-360-${Date.now()}`;
    floorDraft.init360Url = await saveMediaBlob(key, file);
    floorDraft.init360Key = key;
    floorDraft.init360Name = file.name.replace(/\.[^.]+$/, '');
    document.getElementById('floor-360-initial-lbl').textContent = `✅ 360° listo: ${file.name}`;
  });
  document.getElementById('btn-save-floor-modal')?.addEventListener('click', saveFloorFromModal);
  document.getElementById('btn-close-floor-modal')?.addEventListener('click', () => document.getElementById('modal-floor-creator').classList.remove('open'));
  document.getElementById('btn-cancel-floor-modal')?.addEventListener('click', () => document.getElementById('modal-floor-creator').classList.remove('open'));

  // Project Settings Modal (Building Name, Logo 2 Pos + Size + Opacity, WhatsApp, Áreas disponibles)
  const openProjectSettingsModal = () => {
    if (!isEditor()) return;
    const meta = portalState.projects.find((p) => p.code.toUpperCase() === (state.project.code || '').toUpperCase());
    document.getElementById('proj-input-building').value = state.project.buildingName || '';
    document.getElementById('proj-input-code-ro').value = state.project.code || 'SALO-001';
    const accInp = document.getElementById('proj-input-access-code');
    if (accInp) accInp.value = meta?.accessCode ?? state.project.accessCode ?? '';
    document.getElementById('proj-input-sub').value = state.project.subtitle || '';
    document.getElementById('proj-input-show-logo').checked = !!state.project.showLogo;
    document.getElementById('proj-input-logo-size').value = String(state.project.logoSizePx || 48);
    document.getElementById('lbl-logo-size').textContent = `${state.project.logoSizePx || 48} px`;
    document.getElementById('proj-input-logo-opacity').value = String(state.project.logoOpacity ?? 100);
    document.getElementById('lbl-logo-opacity').textContent = `${state.project.logoOpacity ?? 100}%`;
    document.getElementById('proj-input-logo-pos').value = (state.project.logoPosition === 'pos-bottom-right') ? 'pos-bottom-right' : 'pos-above-exterior';
    document.getElementById('proj-input-wa-phone').value = state.project.whatsappPhone || '';
    document.getElementById('proj-input-wa-custom-url').value = state.project.whatsappCustomUrl || '';
    document.getElementById('proj-input-wa-msg').value = state.project.whatsappMessage || '';
    const m3dCb = document.getElementById('proj-input-show-model3d');
    if (m3dCb) m3dCb.checked = state.model3dConfig?.showTab !== false;
    document.getElementById('proj-input-show-units').checked = state.unitsConfig?.showTab !== false;
    document.getElementById('proj-input-units-mode').value = state.unitsConfig?.displayMode || 'departments';
    const pubCb = document.getElementById('proj-input-published');
    if (pubCb) pubCb.checked = meta ? meta.published !== false : true;
    document.getElementById('modal-project-settings').classList.add('open');
  };
  document.getElementById('menu-edit-project-info').addEventListener('click', () => { closeDropdown(); openProjectSettingsModal(); });
  document.getElementById('drawer-link-proj-settings')?.addEventListener('click', () => { closeMenuDrawer(); openProjectSettingsModal(); });
  document.getElementById('btn-quick-settings')?.addEventListener('click', openProjectSettingsModal);
  document.getElementById('btn-close-proj-modal').addEventListener('click', () => document.getElementById('modal-project-settings').classList.remove('open'));
  document.getElementById('proj-upload-logo')?.addEventListener('change', async (e) => {
    if (!isEditor()) return;
    const file = e.target.files[0]; if (!file) return;
    const key = `proj-logo-${Date.now()}`;
    state.project.logoUrl = await saveMediaBlob(key, file);
    state.project.logoMediaKey = key;
    state.project.showLogo = true;
    document.getElementById('proj-input-show-logo').checked = true;
    savePersistedState();
    syncProjectLogoUI();
    showToast('Logo cargado');
    e.target.value = '';
  });
  document.getElementById('btn-remove-proj-logo')?.addEventListener('click', () => {
    if (!isEditor()) return;
    state.project.logoUrl = null;
    state.project.logoMediaKey = null;
    state.project.showLogo = false;
    document.getElementById('proj-input-show-logo').checked = false;
    savePersistedState();
    syncProjectLogoUI();
    showToast('Logo eliminado');
  });
  document.getElementById('proj-input-logo-size')?.addEventListener('input', (e) => {
    const px = Number(e.target.value) || 48;
    document.getElementById('lbl-logo-size').textContent = `${px} px`;
    state.project.logoSizePx = px;
    syncProjectLogoUI();
  });
  document.getElementById('proj-input-logo-opacity')?.addEventListener('input', (e) => {
    const op = Number(e.target.value) || 100;
    document.getElementById('lbl-logo-opacity').textContent = `${op}%`;
    state.project.logoOpacity = op;
    syncProjectLogoUI();
  });
  document.getElementById('proj-input-logo-pos')?.addEventListener('change', (e) => {
    state.project.logoPosition = e.target.value;
    syncProjectLogoUI();
  });
  document.getElementById('proj-input-show-logo')?.addEventListener('change', (e) => {
    state.project.showLogo = e.target.checked;
    syncProjectLogoUI();
  });
  document.getElementById('btn-save-proj-modal').addEventListener('click', async () => {
    if (!isEditor()) return;
    const accInp = document.getElementById('proj-input-access-code');
    const accessCode = accInp ? normalizeAccessCode(accInp.value) : (state.project.accessCode || '');
    const accessCodeHash = await hashAccessCode(accessCode);
    const conflict = findUniqueAccessCodeConflict(portalState.projects, accessCode, accessCodeHash, state.project.code);
    if (conflict) {
      showToast(`❌ El código "${accessCode}" ya está en uso en "${conflict.buildingName}". Usa uno único.`);
      return;
    }

    state.project.buildingName = document.getElementById('proj-input-building').value.trim() || 'Proyecto SALO';
    state.project.shortName = 'SALO SHOWROOM';
    state.project.fullTitle = `SALO SHOWROOM · ${state.project.buildingName}`;
    state.project.subtitle = document.getElementById('proj-input-sub').value.trim() || '';
    state.project.accessCode = accessCode;
    state.project.accessCodeHash = accessCodeHash;
    state.project.requiresCode = Boolean(accessCodeHash);
    state.project.showLogo = document.getElementById('proj-input-show-logo').checked;
    state.project.logoSizePx = Number(document.getElementById('proj-input-logo-size').value) || 48;
    state.project.logoOpacity = Number(document.getElementById('proj-input-logo-opacity').value) || 100;
    state.project.logoPosition = document.getElementById('proj-input-logo-pos').value === 'pos-bottom-right' ? 'pos-bottom-right' : 'pos-above-exterior';
    state.project.whatsappPhone = document.getElementById('proj-input-wa-phone').value.trim();
    state.project.whatsappCustomUrl = document.getElementById('proj-input-wa-custom-url').value.trim();
    state.project.whatsappMessage = document.getElementById('proj-input-wa-msg').value.trim();
    const m3dCb = document.getElementById('proj-input-show-model3d');
    if (m3dCb) {
      if (!state.model3dConfig) state.model3dConfig = { showTab: true };
      state.model3dConfig.showTab = m3dCb.checked;
    }
    state.unitsConfig.showTab = document.getElementById('proj-input-show-units').checked;
    state.unitsConfig.displayMode = document.getElementById('proj-input-units-mode').value || 'departments';
    const pubCb = document.getElementById('proj-input-published');
    const meta = portalState.projects.find((p) => p.code.toUpperCase() === (state.project.code || '').toUpperCase());
    if (meta) {
      meta.accessCode = accessCode;
      meta.accessCodeHash = accessCodeHash;
      meta.requiresCode = Boolean(accessCodeHash);
      if (pubCb) meta.published = pubCb.checked;
    }
    savePersistedState();
    renderPortalProjects();
    syncProjectBrandingUI();
    renderUnitsCatalog();
    if (state.activeView === 'location') renderLocationMap();
    document.getElementById('modal-project-settings').classList.remove('open');
    showToast('Configuración guardada');
  });

  // Role & Editor Accounts (Shared with SALO Portal)
  document.getElementById('btn-role-toggle').addEventListener('click', openAuthModal);
  document.getElementById('menu-manage-accounts').addEventListener('click', () => { closeDropdown(); openAuthModal(); });
  document.getElementById('drawer-link-accounts').addEventListener('click', () => { closeMenuDrawer(); openAuthModal(); });
  document.getElementById('menu-login-editor').addEventListener('click', () => { closeDropdown(); openAuthModal(); });
  document.getElementById('menu-switch-to-public').addEventListener('click', () => {
    closeDropdown(); portalState.auth.mode = 'public'; savePortalState(); applyRoleUI();
    showToast('Vista Público General activada');
  });
  document.getElementById('btn-close-auth-modal').addEventListener('click', () => document.getElementById('modal-editor-auth').classList.remove('open'));
  document.getElementById('btn-enter-public-mode').addEventListener('click', () => {
    portalState.auth.mode = 'public'; savePortalState(); applyRoleUI();
    document.getElementById('modal-editor-auth').classList.remove('open');
    showToast('Cambiado a Vista Público General');
  });
  document.getElementById('btn-copy-public-link').addEventListener('click', () => {
    const pubUrl = `${window.location.origin}${window.location.pathname}?project=${encodeURIComponent(state.project.code || 'SALO-001')}&mode=public`;
    navigator.clipboard?.writeText(pubUrl).catch(() => {});
    showToast(`Enlace público copiado`);
  });
  document.getElementById('btn-submit-editor-login').addEventListener('click', () => {
    const u = document.getElementById('auth-input-user').value.trim();
    const p = document.getElementById('auth-input-pin').value.trim();
    const match = portalState.auth.editors.find((ed) => ed.username.toLowerCase() === u.toLowerCase() && ed.pin === p);
    if (match) {
      portalState.auth.mode = 'editor'; portalState.auth.currentUser = match.username; savePortalState(); applyRoleUI();
      document.getElementById('modal-editor-auth').classList.remove('open');
      showToast(`Bienvenido Editor: ${match.username}`);
    } else document.getElementById('auth-error-msg').style.display = 'block';
  });
  document.getElementById('btn-add-editor-account').addEventListener('click', () => {
    if (!isEditor()) return;
    const u = document.getElementById('new-editor-user').value.trim();
    const p = document.getElementById('new-editor-pin').value.trim();
    if (!u || !p) { showToast('Ingresa usuario y clave'); return; }
    portalState.auth.editors.push({ username: u, pin: p, role: 'Editor Autorizado' });
    document.getElementById('new-editor-user').value = ''; document.getElementById('new-editor-pin').value = '';
    savePortalState(); renderAuthorizedEditorsList(); showToast(`Editor "${u}" autorizado`);
  });

  // Panel Minimize / Restore for ALL 6 side panels
  setupPanelMinimize('floor-elevator-panel', 'btn-min-floors-panel', 'restore-floors-panel', 'minimized');
  setupPanelMinimize('unit-drawer', 'btn-min-unit-drawer', 'restore-unit-drawer', 'drawer');
  setupPanelMinimize('tour360-hud-panel', 'btn-min-360-panel', 'restore-360-panel', 'minimized');
  setupPanelMinimize('model3d-hud-left', 'btn-min-3d-left', 'restore-3d-left', 'minimized');
  setupPanelMinimize('model3d-floor-selector', 'btn-min-3d-floors', 'restore-3d-floors', 'minimized');
  setupPanelMinimize('location-sidebar', 'btn-min-location-panel', 'restore-location-panel', 'minimized');

  // Top Nav
  document.querySelectorAll('.nav-btn[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.dataset.view === 'tour360') {
        const scope = (state.activeView === 'masterplan' && state.activeLevelId !== 'facade' && state.activeLevelId !== 'masterplan') ? state.activeLevelId : null;
        openFloorTour360(scope, null, true);
      } else {
        switchView(btn.dataset.view, true);
      }
    });
  });

  // Renders Gallery
  document.getElementById('btn-drawer-open-renders').addEventListener('click', openRenders);
  document.getElementById('btn-close-gallery-modal').addEventListener('click', () => document.getElementById('modal-renders-gallery').classList.remove('open'));
  document.getElementById('btn-gallery-day-night')?.addEventListener('click', () => toggleDayNightMode());
  document.getElementById('input-add-gallery-render').addEventListener('change', async (e) => {
    if (!isEditor()) return;
    for (const file of Array.from(e.target.files || [])) {
      const id = `rv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const mediaKey = `gallery-${id}`;
      const url = await saveMediaBlob(mediaKey, file);
      state.renderedViewsGallery.unshift({ id, title: file.name.replace(/\.[^.]+$/, ''), url, mediaKey, nightUrl: null, nightMediaKey: null });
      renderGalleryModalContent(id);
    }
    savePersistedState(); showToast('Renders guardados en calidad nativa');
    e.target.value = '';
  });
  document.getElementById('input-upload-gallery-night')?.addEventListener('change', async (e) => {
    if (!isEditor()) return;
    const file = e.target.files?.[0];
    if (!file) return;
    const current = state.renderedViewsGallery.find((g) => g.id === activeGalleryItemId) || state.renderedViewsGallery[0];
    if (!current) return;
    const key = `gallery-night-${current.id}-${Date.now()}`;
    const url = await saveMediaBlob(key, file);
    current.nightUrl = url;
    current.nightMediaKey = key;
    savePersistedState();
    toggleDayNightMode(true);
    renderGalleryModalContent(current.id);
    showToast(`Vista nocturna cargada en "${current.title}"`);
    e.target.value = '';
  });
  document.getElementById('btn-clear-gallery-night')?.addEventListener('click', () => {
    if (!isEditor()) return;
    const current = state.renderedViewsGallery.find((g) => g.id === activeGalleryItemId) || state.renderedViewsGallery[0];
    if (!current) return;
    current.nightUrl = null;
    current.nightMediaKey = null;
    savePersistedState();
    renderGalleryModalContent(current.id);
    showToast('Vista nocturna eliminada de la vista');
  });

  // Transitions Manager
  document.getElementById('btn-open-transitions-inline').addEventListener('click', openTransitionsManagerModal);
  document.getElementById('btn-studio-open-transitions').addEventListener('click', openTransitionsManagerModal);
  document.getElementById('btn-studio-manage-transitions-card').addEventListener('click', openTransitionsManagerModal);
  document.getElementById('btn-close-transitions-modal').addEventListener('click', () => document.getElementById('modal-transitions-manager').classList.remove('open'));
  const onToggleGlobalTransitions = (e) => {
    if (!isEditor()) return;
    state.transitions.globalEnabled = e.target.checked;
    syncGlobalTransitionsToggleUI();
    savePersistedState();
  };
  document.getElementById('toggle-global-transitions')?.addEventListener('change', onToggleGlobalTransitions);
  document.getElementById('toggle-studio-global-transitions')?.addEventListener('change', onToggleGlobalTransitions);

  const createCustomTransitionRoute = (fromSelId, toSelId, typeSelId) => {
    if (!isEditor()) return;
    const fromLevelId = document.getElementById(fromSelId)?.value || 'facade';
    const toLevelId = document.getElementById(toSelId)?.value || state.levels[1]?.id || 'floor-9';
    const transitionType = document.getElementById(typeSelId)?.value || 'video';
    if (fromLevelId === toLevelId) {
      showToast('Elige un origen y destino diferentes');
      return;
    }
    const existing = state.transitions.slots.find((s) => s.fromLevelId === fromLevelId && s.toLevelId === toLevelId);
    const label = `${getLevelDisplayName(fromLevelId)} → ${getLevelDisplayName(toLevelId)}`;
    if (existing) {
      existing.transitionType = transitionType;
      existing.enabled = transitionType !== 'none';
      existing.label = label;
      showToast(`Transición "${label}" actualizada`);
    } else {
      state.transitions.slots.push({
        id: `trans-${fromLevelId}-to-${toLevelId}-${Date.now()}`,
        fromLevelId,
        toLevelId,
        label,
        enabled: transitionType !== 'none',
        transitionType,
        defaultVideo: './sample-assets/transition-floors.mp4',
        mediaKey: null,
        customName: null,
        img1Url: null,
        img1Key: null,
        img2Url: null,
        img2Key: null
      });
      showToast(`Transición "${label}" creada`);
    }
    savePersistedState();
    refreshAllTransitionsLists();
  };

  document.getElementById('btn-add-custom-transition')?.addEventListener('click', () => {
    createCustomTransitionRoute('trans-new-from', 'trans-new-to', 'trans-new-type');
  });
  document.getElementById('btn-studio-add-transition')?.addEventListener('click', () => {
    createCustomTransitionRoute('studio-trans-new-from', 'studio-trans-new-to', 'studio-trans-new-type');
  });
  document.getElementById('btn-studio-clear-trans-filter')?.addEventListener('click', () => {
    studioTransitionsFilterLevelId = null;
    renderStudioTransitionsTab();
  });
  document.querySelectorAll('.studio-tab-btn[data-studio-tab]').forEach((btn) => {
    btn.addEventListener('click', () => switchStudioTab(btn.dataset.studioTab));
  });
  document.getElementById('btn-studio-create-floor')?.addEventListener('click', () => {
    openFloorCreatorModal(null);
  });
  document.getElementById('studio-upload-transition').addEventListener('change', async (e) => {
    if (!isEditor()) return;
    const file = e.target.files[0]; if (!file) return;
    const slot = state.transitions.slots.find((s) => s.id === 'ext_to_floor9');
    if (slot) {
      const key = `trans-ext_to_floor9-${Date.now()}`;
      const url = await saveMediaBlob(key, file);
      slot.mediaKey = key; slot.customName = file.name; slot.enabled = true; savePersistedState();
      switchView('masterplan'); playTransitionVideoThen(url, () => navigateToLevelWithTransition('floor-9', 'none'));
    }
  });

  // Day / Night
  document.getElementById('btn-day-night').addEventListener('click', () => toggleDayNightMode());
  document.getElementById('btn-photo-viewer-day-night')?.addEventListener('click', () => toggleDayNightMode());
  document.getElementById('btn-360-day-night')?.addEventListener('click', () => toggleDayNightMode());

  // Image Framing ("Encuadre")
  const adjPopover = document.getElementById('image-adjust-popover');
  document.getElementById('btn-adjust-image').addEventListener('click', () => {
    if (!isEditor()) return;
    switchView('masterplan'); adjPopover.classList.toggle('open'); applyActiveImageAdjustment();
  });
  document.getElementById('btn-close-adjust').addEventListener('click', () => adjPopover.classList.remove('open'));
  const updateAdj = () => {
    if (!isEditor()) return;
    state.imageAdjustments[state.activeLevelId] = {
      fit: document.getElementById('adj-fit').value, scale: Number(document.getElementById('adj-scale').value),
      x: Number(document.getElementById('adj-x').value), y: Number(document.getElementById('adj-y').value)
    };
    applyActiveImageAdjustment(); savePersistedState();
  };
  ['adj-fit', 'adj-scale', 'adj-x', 'adj-y'].forEach((id) => document.getElementById(id).addEventListener('input', updateAdj));
  document.getElementById('btn-reset-adjust').addEventListener('click', () => {
    if (!isEditor()) return;
    state.imageAdjustments[state.activeLevelId] = { fit: 'cover', scale: 100, x: 0, y: 0 };
    applyActiveImageAdjustment(); savePersistedState();
  });
  document.getElementById('input-quick-replace-img').addEventListener('change', async (e) => {
    if (!isEditor()) return;
    const file = e.target.files[0]; if (!file) return;
    const key = `lvl-img-${state.activeLevelId}-${state.exteriorAngleIndex}-${Date.now()}`;
    const url = await saveMediaBlob(key, file);
    if (state.activeLevelId === 'facade') {
      const ang = state.exteriorAngles[state.exteriorAngleIndex];
      if (ang) {
        ang.photo = url;
        ang.mediaKey = key;
        if (!ang.nightMediaKey) ang.nightPhoto = null;
      }
      if (state.exteriorAngleIndex === 0) {
        const facadeLvl = state.levels.find((l) => l.id === 'facade');
        if (facadeLvl) {
          facadeLvl.dayPhoto = url;
          facadeLvl.dayMediaKey = key;
          if (!facadeLvl.nightMediaKey) facadeLvl.nightPhoto = null;
        }
      }
    } else {
      const lvl = state.levels.find((l) => l.id === state.activeLevelId);
      if (lvl) {
        lvl.dayPhoto = url;
        lvl.dayMediaKey = key;
        if (!lvl.nightMediaKey) lvl.nightPhoto = null;
      }
    }
    savePersistedState(); drawMasterplanRender(); showToast('Foto guardada en calidad original');
    e.target.value = '';
  });

  // Polygon Drawing
  const drawBtn = document.getElementById('btn-draw-polygon');
  const drawToolbar = document.getElementById('polygon-draw-toolbar');
  const updateDraftCounter = () => { document.getElementById('draft-points-count').textContent = String(state.draftPolygonPoints.length); };
  drawBtn.addEventListener('click', () => {
    if (!isEditor()) return;
    switchView('masterplan');
    state.isDrawingPolygon = !state.isDrawingPolygon;
    state.draftPolygonPoints = [];
    drawBtn.classList.toggle('active', state.isDrawingPolygon);
    drawToolbar.classList.toggle('active', state.isDrawingPolygon);
    updateDraftCounter(); renderMasterplanOverlays();
  });
  const sceneFrame = document.getElementById('scene-frame');
  sceneFrame.addEventListener('click', (e) => {
    if (!isEditor()) return;
    const mediaBox = document.getElementById('scene-media-box') || sceneFrame;
    const rect = mediaBox.getBoundingClientRect();
    const px = Math.max(0, Math.min(100, Math.round(((e.clientX - rect.left) / rect.width) * 1000) / 10));
    const py = Math.max(0, Math.min(100, Math.round(((e.clientY - rect.top) / rect.height) * 1000) / 10));

    if (state.isPlacingPlanPoint) {
      pendingNewBtnPoint = { x: px, y: py };
      state.isPlacingPlanPoint = false;
      document.body.classList.remove('placing-plan-point');
      document.getElementById('plan-point-place-banner')?.classList.remove('active');
      const ptLbl = document.getElementById('new-btn-point-coords-lbl');
      if (ptLbl) ptLbl.textContent = `✅ Punto fijado en planta (${px}%, ${py}%)`;
      document.getElementById('modal-polygon-editor')?.classList.add('open');
      showToast(`Punto sobre planta fijado (${px}%, ${py}%)`);
      return;
    }

    if (!state.isDrawingPolygon) return;
    state.draftPolygonPoints.push({ x: px, y: py });
    updateDraftCounter(); renderMasterplanOverlays();
  });
  document.getElementById('btn-undo-polygon-pt').addEventListener('click', () => { state.draftPolygonPoints.pop(); updateDraftCounter(); renderMasterplanOverlays(); });
  document.getElementById('btn-cancel-polygon').addEventListener('click', () => {
    state.isDrawingPolygon = false; state.draftPolygonPoints = [];
    drawBtn.classList.remove('active'); drawToolbar.classList.remove('active'); renderMasterplanOverlays();
  });
  document.getElementById('btn-finish-polygon').addEventListener('click', () => {
    if (state.draftPolygonPoints.length < 3) { showToast('Marca al menos 3 puntos'); return; }
    openPolygonEditorModal(null);
  });
  document.getElementById('btn-save-polygon-modal').addEventListener('click', savePolygonFromModal);
  document.getElementById('btn-close-poly-modal').addEventListener('click', () => document.getElementById('modal-polygon-editor').classList.remove('open'));
  document.getElementById('btn-cancel-poly-modal').addEventListener('click', () => document.getElementById('modal-polygon-editor').classList.remove('open'));

  // Drawer Controls
  document.querySelectorAll('[data-set-status]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!isEditor()) return;
      const unit = state.units.find((u) => u.id === state.selectedUnitId);
      if (unit) { unit.status = btn.dataset.setStatus; savePersistedState(); selectUnit(unit.id, false); }
    });
  });
  document.getElementById('btn-toggle-info-config').addEventListener('click', () => { if (isEditor()) document.getElementById('info-config-panel').classList.toggle('open'); });
  document.querySelectorAll('[data-toggle-field]').forEach((cb) => {
    cb.checked = state.visibleFields[cb.dataset.toggleField] !== false;
    cb.addEventListener('change', () => {
      if (!isEditor()) return;
      state.visibleFields[cb.dataset.toggleField] = cb.checked; savePersistedState();
      applyFieldVisibilityToDrawer(); renderMasterplanOverlays();
    });
  });
  document.getElementById('btn-edit-current-polygon').addEventListener('click', () => {
    const unit = state.units.find((u) => u.id === state.selectedUnitId);
    if (unit) openPolygonEditorModal(unit);
  });
  document.getElementById('btn-drawer-quick-buttons')?.addEventListener('click', () => {
    const unit = state.units.find((u) => u.id === state.selectedUnitId);
    if (unit) openPolygonEditorModal(unit);
  });
  const triggerShapeEditFromDrawer = () => {
    const unit = state.units.find((u) => u.id === state.selectedUnitId);
    if (unit) enterPolygonShapeEdit(unit.id);
  };
  document.getElementById('btn-edit-shape-polygon')?.addEventListener('click', triggerShapeEditFromDrawer);
  document.getElementById('btn-drawer-quick-shape')?.addEventListener('click', triggerShapeEditFromDrawer);
  document.getElementById('btn-save-shape-edit')?.addEventListener('click', () => exitPolygonShapeEdit(true));
  document.getElementById('btn-cancel-shape-edit')?.addEventListener('click', () => exitPolygonShapeEdit(false));
  document.getElementById('btn-shape-open-panel')?.addEventListener('click', () => {
    const unit = state.units.find((u) => u.id === (state.editingShapeUnitId || state.selectedUnitId));
    if (unit) openPolygonEditorModal(unit);
  });
  document.getElementById('btn-create-floor-from-unit')?.addEventListener('click', () => {
    openFloorCreatorModal(null, { linkToUnitId: state.selectedUnitId });
  });
  document.getElementById('btn-poly-modal-create-floor')?.addEventListener('click', () => {
    openFloorCreatorModal(null, { linkToPolygonModal: true });
  });

  // Dynamic Custom Lines & Custom Buttons Builders inside #modal-polygon-editor
  document.getElementById('new-line-type')?.addEventListener('change', syncNewLineTypeInputs);
  document.getElementById('btn-add-custom-line')?.addEventListener('click', () => {
    const type = document.getElementById('new-line-type').value;
    const label = document.getElementById('new-line-label').value.trim();
    const number = document.getElementById('new-line-number').value.trim();
    const unit = document.getElementById('new-line-unit').value.trim();
    if (!label) { showToast('Escribe el texto o descripción de la línea'); return; }
    if (type === 'text') {
      draftCustomLines.push({ type: 'text', label });
    } else {
      draftCustomLines.push({ type: 'metric', label, number: number || '1', unit: unit || '' });
    }
    document.getElementById('new-line-label').value = '';
    document.getElementById('new-line-number').value = '';
    renderDraftCustomLines();
  });

  document.getElementById('new-btn-action-type')?.addEventListener('change', syncNewBtnTypeUI);
  document.getElementById('new-btn-show-on-plan')?.addEventListener('change', (e) => {
    const opts = document.getElementById('new-btn-plan-point-opts');
    if (opts) opts.style.display = e.target.checked ? 'flex' : 'none';
  });
  document.getElementById('btn-pick-plan-point')?.addEventListener('click', () => {
    if (!isEditor()) return;
    state.isPlacingPlanPoint = true;
    document.getElementById('modal-polygon-editor')?.classList.remove('open');
    document.body.classList.add('placing-plan-point');
    document.getElementById('plan-point-place-banner')?.classList.add('active');
    if (state.activeView !== 'masterplan') switchView('masterplan', false, true);
    showToast('Haz clic sobre la planta para ubicar el punto interactivo');
  });
  document.getElementById('btn-cancel-plan-point')?.addEventListener('click', () => {
    state.isPlacingPlanPoint = false;
    document.body.classList.remove('placing-plan-point');
    document.getElementById('plan-point-place-banner')?.classList.remove('active');
    document.getElementById('modal-polygon-editor')?.classList.add('open');
  });
  document.getElementById('new-btn-upload-file')?.addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const key = `custom-btn-media-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const url = await saveMediaBlob(key, file);
    pendingNewBtnFile = { url, mediaKey: key, name: file.name };
    document.getElementById('new-btn-file-lbl').textContent = `✅ ${file.name}`;
    e.target.value = '';
  });
  document.getElementById('new-btn-upload-night-file')?.addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const key = `custom-btn-night-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const url = await saveMediaBlob(key, file);
    pendingNewBtnNightFile = { url, mediaKey: key, name: file.name };
    syncNewBtnTypeUI();
    e.target.value = '';
  });
  document.getElementById('btn-clear-new-btn-night')?.addEventListener('click', () => {
    pendingNewBtnNightFile = { url: null, mediaKey: null, name: null };
    syncNewBtnTypeUI();
  });
  document.getElementById('btn-add-custom-button')?.addEventListener('click', () => {
    const label = document.getElementById('new-btn-label').value.trim();
    const actionType = document.getElementById('new-btn-action-type').value;
    if (!label) { showToast('Escribe el texto del botón'); return; }

    const showOnPlan = !!document.getElementById('new-btn-show-on-plan')?.checked;
    const pinColor = document.getElementById('new-btn-pin-color')?.value || '#d4af37';
    const pinCoords = showOnPlan && pendingNewBtnPoint ? { ...pendingNewBtnPoint } : null;

    if (actionType === 'tour360') {
      let targetRoom360Id = document.getElementById('new-btn-existing-360').value || null;
      if (pendingNewBtnFile.url) {
        const newRoomId = `room-btn-${Date.now()}`;
        const scopeLvl = state.activeLevelId !== 'facade' ? state.activeLevelId : null;
        state.rooms360.push({
          id: newRoomId,
          levelId: scopeLvl,
          name: label,
          subtitle: 'Panorama 360° asignado desde botón',
          themeColor: '#161410',
          customImageUrl: pendingNewBtnFile.url,
          mediaKey: pendingNewBtnFile.mediaKey,
          customNightImageUrl: null,
          nightMediaKey: null,
          hotspots: []
        });
        targetRoom360Id = newRoomId;
      }
      draftCustomButtons.push({
        id: `cb-${Date.now()}`,
        label,
        actionType: 'tour360',
        photoUrl: null,
        photoMediaKey: null,
        nightPhotoUrl: null,
        nightPhotoMediaKey: null,
        targetRoom360Id: targetRoom360Id || getRooms360ForScope(state.activeLevelId)[0]?.id || state.rooms360[0]?.id || null,
        showOnPlan,
        pinColor,
        pinCoords
      });
    } else {
      draftCustomButtons.push({
        id: `cb-${Date.now()}`,
        label,
        actionType: 'photo',
        photoUrl: pendingNewBtnFile.url || './sample-assets/render-interior-1.jpg',
        photoMediaKey: pendingNewBtnFile.mediaKey || null,
        nightPhotoUrl: pendingNewBtnNightFile.url || null,
        nightPhotoMediaKey: pendingNewBtnNightFile.mediaKey || null,
        targetRoom360Id: null,
        showOnPlan,
        pinColor,
        pinCoords
      });
    }

    pendingNewBtnFile = { url: null, mediaKey: null, name: null };
    pendingNewBtnNightFile = { url: null, mediaKey: null, name: null };
    pendingNewBtnPoint = null;
    document.getElementById('new-btn-label').value = '';
    const fileLbl = document.getElementById('new-btn-file-lbl');
    if (fileLbl) fileLbl.textContent = 'Subir Foto Render asignada';
    const showPlanCb = document.getElementById('new-btn-show-on-plan');
    const planOpts = document.getElementById('new-btn-plan-point-opts');
    const ptLbl = document.getElementById('new-btn-point-coords-lbl');
    if (showPlanCb) showPlanCb.checked = false;
    if (planOpts) planOpts.style.display = 'none';
    if (ptLbl) ptLbl.textContent = 'Ubicación: Automática (centro)';
    syncNewBtnTypeUI();
    renderDraftCustomButtons();
    showToast(showOnPlan ? `Punto "${label}" añadido sobre la planta y al panel` : `Botón "${label}" añadido a la lista`);
  });

  document.getElementById('btn-delete-current-polygon').addEventListener('click', () => {
    if (!isEditor() || state.units.length <= 1) return;
    state.units = state.units.filter((u) => u.id !== state.selectedUnitId);
    savePersistedState(); selectUnit(state.units[0].id, false); showToast('Polígono eliminado');
  });

  const goFloorWithVideo = () => triggerPolygonTargetTransition(state.units.find((u) => u.id === state.selectedUnitId));
  document.getElementById('btn-drawer-transition-to-floor').addEventListener('click', goFloorWithVideo);
  document.getElementById('drawer-floor-photo-preview').addEventListener('click', goFloorWithVideo);
  document.getElementById('btn-floor-up').addEventListener('click', () => stepMasterplanLevel(-1));
  document.getElementById('btn-floor-down').addEventListener('click', () => stepMasterplanLevel(1));
  document.getElementById('btn-mode-3drender').addEventListener('click', (e) => {
    state.is2DPlanMode = false; e.currentTarget.classList.add('active'); document.getElementById('btn-mode-2dplan').classList.remove('active'); drawMasterplanRender();
  });
  document.getElementById('btn-mode-2dplan').addEventListener('click', (e) => {
    state.is2DPlanMode = true; e.currentTarget.classList.add('active'); document.getElementById('btn-mode-3drender').classList.remove('active'); drawMasterplanRender();
  });

  document.getElementById('btn-zoom-in').addEventListener('click', () => { state.zoom = Math.min(2.6, state.zoom + 0.25); updateMasterplanZoomTransform(); });
  document.getElementById('btn-zoom-out').addEventListener('click', () => { state.zoom = Math.max(1, state.zoom - 0.25); if (state.zoom === 1) state.pan = { x: 0, y: 0 }; updateMasterplanZoomTransform(); });
  document.getElementById('btn-zoom-reset').addEventListener('click', () => { state.zoom = 1; state.pan = { x: 0, y: 0 }; updateMasterplanZoomTransform(); });

  document.getElementById('btn-drawer-go-3d-floor').addEventListener('click', async () => {
    const unit = state.units.find((u) => u.id === state.selectedUnitId);
    const assignedFloor = unit
      ? (state.floors3D || []).find((f) => Array.isArray(f.assignedUnitIds) && f.assignedUnitIds.includes(unit.id))
      : null;
    await switchView('model3d', true);
    select3DFloor(assignedFloor ? assignedFloor.id : (unit?.floorNum || 1));
  });
  document.getElementById('btn-close-assign-polygons')?.addEventListener('click', () => document.getElementById('modal-assign-polygons')?.classList.remove('open'));
  document.getElementById('btn-cancel-assign-polygons')?.addEventListener('click', () => document.getElementById('modal-assign-polygons')?.classList.remove('open'));
  document.getElementById('assign-poly-search')?.addEventListener('input', (e) => renderAssignPolygonsList(e.target.value, assignPolygonsCheckedSet));
  document.getElementById('btn-save-assign-polygons')?.addEventListener('click', () => {
    if (typeof assignPolygonsSaveHandler === 'function') {
      assignPolygonsSaveHandler([...assignPolygonsCheckedSet]);
    }
    document.getElementById('modal-assign-polygons')?.classList.remove('open');
  });

  // Cloud Publishing, Multi-Email Google Drive & Guide Modal Bindings
  const switchCloudModalTab = (tabName) => {
    document.querySelectorAll('[data-cloud-tab]').forEach((b) => b.classList.toggle('active', b.dataset.cloudTab === tabName));
    const panels = {
      publish: document.getElementById('cloud-panel-publish'),
      accounts: document.getElementById('cloud-panel-accounts'),
      guide: document.getElementById('cloud-panel-guide')
    };
    Object.entries(panels).forEach(([k, el]) => {
      if (el) el.style.display = k === tabName ? 'flex' : 'none';
    });
  };

  const renderCloudGuideSnippets = (cfg) => {
    const activeDrv = getActiveDriveProfile(cfg);
    const activeSecret = document.getElementById('cloud-drv-secret')?.value.trim() || activeDrv?.uploadSecret || 'PEGA_AQUI_TU_CLAVE_SECRETA';
    const wEl = document.getElementById('cloud-copy-worker-src');
    const gEl = document.getElementById('cloud-copy-gas-src');
    if (wEl) wEl.textContent = WORKER_SCRIPT_TEMPLATE;
    if (gEl) gEl.textContent = buildAppsScriptTemplate(activeSecret);
  };

  const renderCloudDriveProfiles = (cfg) => {
    const list = document.getElementById('cloud-drive-profiles-list');
    const activeDrv = getActiveDriveProfile(cfg);
    const activeBadge = document.getElementById('cloud-active-drive-badge');
    const pubLbl = document.getElementById('cloud-publish-drive-lbl');
    const activeTxt = activeDrv ? `${activeDrv.verifiedEmail || activeDrv.label}` : 'ninguno elegido';
    if (activeBadge) activeBadge.textContent = activeDrv ? `Activo: ${activeTxt}` : 'Ningún correo seleccionado';
    if (pubLbl) pubLbl.textContent = activeTxt;
    if (!list) return;
    list.innerHTML = '';
    if (!cfg.driveProfiles || cfg.driveProfiles.length === 0) {
      list.innerHTML = '<span style="font-size:10.5px;color:var(--ink-muted);">Aún no guardaste ningún correo Gmail / Apps Script. Añade uno abajo.</span>';
      return;
    }
    cfg.driveProfiles.forEach((prof, idx) => {
      const isAct = activeDrv && prof.id === activeDrv.id;
      const row = document.createElement('div');
      row.className = `drive-profile-row ${isAct ? 'active' : ''}`;
      row.innerHTML = `
        <div style="min-width:0;flex:1;">
          <strong style="color:${isAct ? '#4ade80' : 'var(--gold-bright)'};">${prof.label || 'Cuenta Google'}</strong>
          <div style="font-size:10px;color:var(--ink-silver);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${prof.verifiedEmail ? `📧 ${prof.verifiedEmail} · ` : ''}${prof.scriptUrl}</div>
        </div>
        <div style="display:flex;gap:4px;flex-shrink:0;">
          <button type="button" class="glass-pill-btn ${isAct ? 'active' : ''}" data-use-drv="${prof.id}" style="height:24px;padding:0 8px;font-size:10px;">${isAct ? '✓ Activo' : 'Usar'}</button>
          <button type="button" class="glass-pill-btn" data-del-drv="${idx}" style="height:24px;padding:0 7px;font-size:10px;color:#f87171;">🗑️</button>
        </div>
      `;
      row.querySelector('[data-use-drv]').addEventListener('click', () => {
        cfg.activeDriveProfileId = prof.id;
        saveCloudConfig(cfg);
        document.getElementById('cloud-drv-label').value = prof.label || '';
        document.getElementById('cloud-drv-url').value = prof.scriptUrl || '';
        document.getElementById('cloud-drv-secret').value = prof.uploadSecret || '';
        renderCloudDriveProfiles(cfg);
        renderCloudGuideSnippets(cfg);
        showToast(`Correo Drive cambiado a: ${prof.verifiedEmail || prof.label}`);
      });
      row.querySelector('[data-del-drv]').addEventListener('click', () => {
        cfg.driveProfiles.splice(idx, 1);
        if (cfg.activeDriveProfileId === prof.id) cfg.activeDriveProfileId = cfg.driveProfiles[0]?.id || '';
        saveCloudConfig(cfg);
        renderCloudDriveProfiles(cfg);
        renderCloudGuideSnippets(cfg);
      });
      list.appendChild(row);
    });
  };

  const renderCloudProjectsChecklist = () => {
    const box = document.getElementById('cloud-projects-checklist');
    if (!box) return;
    box.innerHTML = '';
    portalState.projects.forEach((proj) => {
      const isPub = proj.published !== false;
      const row = document.createElement('label');
      row.className = 'assign-poly-item';
      row.innerHTML = `
        <input type="checkbox" data-cloud-proj-pub="${proj.code}" ${isPub ? 'checked' : ''} />
        <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"><strong>${proj.buildingName}</strong> <small style="color:var(--gold-bright);">(${proj.code})</small></span>
        <span class="code-tag" style="${isPub ? 'background:rgba(34,197,94,0.2);color:#4ade80;' : ''}">${isPub ? '🟢 Publicar' : '📝 Borrador (PC)'}</span>
      `;
      row.querySelector('input').addEventListener('change', (e) => {
        proj.published = e.target.checked;
        savePortalState();
        renderPortalProjects();
        renderCloudProjectsChecklist();
      });
      box.appendChild(row);
    });
  };

  const openCloudPublishModal = async () => {
    if (!isEditor()) return;
    const cfg = loadCloudConfig();
    document.getElementById('cloud-gh-owner').value = cfg.ghOwner || '';
    document.getElementById('cloud-gh-repo').value = cfg.ghRepo || 'salo-showroom';
    document.getElementById('cloud-gh-branch').value = cfg.ghBranch || 'main';
    document.getElementById('cloud-gh-token').value = cfg.ghToken || '';
    document.getElementById('cloud-cf-worker').value = cfg.cfWorkerUrl || '';
    document.getElementById('cloud-opt-upload-pages').checked = cfg.uploadPages !== false;
    document.getElementById('cloud-opt-upload-releases').checked = cfg.uploadReleases !== false;
    document.getElementById('cloud-opt-backup-drive').checked = cfg.backupToDrive !== false;

    const actDrv = getActiveDriveProfile(cfg);
    document.getElementById('cloud-drv-label').value = actDrv?.label || '';
    document.getElementById('cloud-drv-url').value = actDrv?.scriptUrl || '';
    document.getElementById('cloud-drv-secret').value = actDrv?.uploadSecret || generateRandomSecret();

    renderCloudProjectsChecklist();
    renderCloudDriveProfiles(cfg);
    renderCloudGuideSnippets(cfg);
    switchCloudModalTab('publish');
    document.getElementById('modal-cloud-publish')?.classList.add('open');

    const warnBox = document.getElementById('cloud-bigfile-warning');
    if (warnBox) {
      const bigWarns = await detectBigMediaWarnings(portalState, getRawProjectStateForPublish, getMediaBlob);
      if (bigWarns.length > 0) {
        warnBox.style.display = 'block';
        warnBox.innerHTML = `⚠️ <b>Aviso de peso móvil:</b><br/>${bigWarns.join('<br/>')}<br/><small>Se publicarán sin problema en tamaño completo, pero en celulares puede demorar al abrir. Para carga rápida móvil usa compresión Draco / texturas 2K.</small>`;
      } else {
        warnBox.style.display = 'none';
      }
    }
  };

  document.getElementById('btn-portal-open-cloud')?.addEventListener('click', openCloudPublishModal);
  document.getElementById('btn-quick-cloud-publish')?.addEventListener('click', openCloudPublishModal);
  document.getElementById('menu-open-cloud-publish')?.addEventListener('click', () => { closeDropdown(); openCloudPublishModal(); });
  document.getElementById('drawer-link-cloud-publish')?.addEventListener('click', () => { closeMenuDrawer(); openCloudPublishModal(); });
  document.getElementById('btn-close-cloud-modal')?.addEventListener('click', () => document.getElementById('modal-cloud-publish')?.classList.remove('open'));
  document.querySelectorAll('[data-cloud-tab]').forEach((btn) => btn.addEventListener('click', () => switchCloudModalTab(btn.dataset.cloudTab)));

  const syncCloudFieldsToStorage = () => {
    const cfg = loadCloudConfig();
    cfg.ghOwner = document.getElementById('cloud-gh-owner').value.trim();
    cfg.ghRepo = document.getElementById('cloud-gh-repo').value.trim() || 'salo-showroom';
    cfg.ghBranch = document.getElementById('cloud-gh-branch').value.trim() || 'main';
    cfg.ghToken = document.getElementById('cloud-gh-token').value.trim();
    cfg.cfWorkerUrl = document.getElementById('cloud-cf-worker').value.trim();
    cfg.uploadPages = document.getElementById('cloud-opt-upload-pages').checked;
    cfg.uploadReleases = document.getElementById('cloud-opt-upload-releases').checked;
    cfg.backupToDrive = document.getElementById('cloud-opt-backup-drive').checked;
    saveCloudConfig(cfg);
    return cfg;
  };
  ['cloud-gh-owner', 'cloud-gh-repo', 'cloud-gh-branch', 'cloud-gh-token', 'cloud-cf-worker', 'cloud-opt-upload-pages', 'cloud-opt-upload-releases', 'cloud-opt-backup-drive'].forEach((id) => {
    document.getElementById(id)?.addEventListener('input', syncCloudFieldsToStorage);
    document.getElementById(id)?.addEventListener('change', syncCloudFieldsToStorage);
  });

  document.getElementById('btn-cloud-gen-secret')?.addEventListener('click', () => {
    document.getElementById('cloud-drv-secret').value = generateRandomSecret();
    renderCloudGuideSnippets(loadCloudConfig());
  });
  document.getElementById('cloud-drv-secret')?.addEventListener('input', () => renderCloudGuideSnippets(loadCloudConfig()));

  document.getElementById('btn-cloud-save-drive-profile')?.addEventListener('click', () => {
    const cfg = syncCloudFieldsToStorage();
    const label = document.getElementById('cloud-drv-label').value.trim() || `Correo ${cfg.driveProfiles.length + 1}`;
    const scriptUrl = document.getElementById('cloud-drv-url').value.trim();
    const uploadSecret = document.getElementById('cloud-drv-secret').value.trim() || generateRandomSecret();
    if (!scriptUrl) { showToast('Ingresa la URL (/exec) de Apps Script'); return; }
    let prof = cfg.driveProfiles.find((p) => p.scriptUrl === scriptUrl);
    if (prof) {
      prof.label = label;
      prof.uploadSecret = uploadSecret;
    } else {
      prof = { id: `drv-${Date.now()}-${Math.random().toString(36).slice(2, 5)}`, label, scriptUrl, uploadSecret, verifiedEmail: '', sheetUrl: '', folderUrl: '' };
      cfg.driveProfiles.push(prof);
    }
    cfg.activeDriveProfileId = prof.id;
    saveCloudConfig(cfg);
    renderCloudDriveProfiles(cfg);
    renderCloudGuideSnippets(cfg);
    showToast(`Cuenta Drive "${label}" activada`);
  });

  document.getElementById('btn-cloud-test-github')?.addEventListener('click', async () => {
    const cfg = syncCloudFieldsToStorage();
    const st = document.getElementById('cloud-gh-status');
    if (st) st.textContent = '⏳ Probando…';
    try {
      const r = await testGitHubConnection(cfg, window.__SALO_TEST_MOCK_API_BASE || '');
      if (r.ok) {
        if (st) { st.textContent = `✅ Conectado: ${r.fullName} (rama ${r.defaultBranch})`; st.style.color = '#4ade80'; }
      } else {
        if (st) { st.textContent = `❌ ${r.error}`; st.style.color = '#f87171'; }
      }
    } catch (e) {
      if (st) { st.textContent = `❌ ${e.message}`; st.style.color = '#f87171'; }
    }
  });

  document.getElementById('btn-cloud-test-drive')?.addEventListener('click', async () => {
    const cfg = loadCloudConfig();
    const scriptUrl = document.getElementById('cloud-drv-url').value.trim() || getActiveDriveProfile(cfg)?.scriptUrl || '';
    const badge = document.getElementById('cloud-active-drive-badge');
    if (badge) badge.textContent = '⏳ Probando Apps Script…';
    try {
      const res = await testDriveProfile({ scriptUrl });
      if (res.ok) {
        const prof = cfg.driveProfiles.find((p) => p.scriptUrl === scriptUrl) || getActiveDriveProfile(cfg);
        if (prof) {
          prof.verifiedEmail = res.email || prof.verifiedEmail;
          prof.sheetUrl = res.sheetUrl || prof.sheetUrl;
          prof.folderUrl = res.folderUrl || prof.folderUrl;
          saveCloudConfig(cfg);
        }
        renderCloudDriveProfiles(cfg);
        showToast(`Conectado como ${res.email || 'Google Drive'}`);
      } else {
        if (badge) badge.textContent = `❌ Error: ${res.error || 'No responde'}`;
      }
    } catch (e) {
      if (badge) badge.textContent = `❌ ${e.message}`;
    }
  });

  document.getElementById('btn-copy-worker-code')?.addEventListener('click', () => {
    navigator.clipboard?.writeText(WORKER_SCRIPT_TEMPLATE).catch(() => {});
    showToast('Código Cloudflare Worker copiado');
  });
  document.getElementById('btn-copy-gas-code')?.addEventListener('click', () => {
    const txt = document.getElementById('cloud-copy-gas-src')?.textContent || '';
    navigator.clipboard?.writeText(txt).catch(() => {});
    showToast('Código Google Apps Script copiado');
  });

  document.getElementById('btn-cloud-publish-now')?.addEventListener('click', async () => {
    const cfg = syncCloudFieldsToStorage();
    const btn = document.getElementById('btn-cloud-publish-now');
    const progBox = document.getElementById('cloud-progress-box');
    const progBar = document.getElementById('cloud-progress-bar');
    const progSt = document.getElementById('cloud-progress-status');
    const logEl = document.getElementById('cloud-publish-log');
    const resBox = document.getElementById('cloud-publish-result');
    if (progBox) progBox.style.display = 'flex';
    if (resBox) resBox.style.display = 'none';
    if (logEl) logEl.textContent = '';
    if (btn) btn.disabled = true;

    try {
      const result = await publishShowroomOrchestrator({
        cfg,
        portalState,
        loadProjectStateByCode: getRawProjectStateForPublish,
        getMediaBlob,
        onProgress: (pct, msg) => {
          if (progBar) progBar.style.width = `${pct}%`;
          if (progSt) progSt.textContent = msg;
        },
        onLog: (line) => {
          if (logEl) { logEl.textContent += `${line}\n`; logEl.scrollTop = logEl.scrollHeight; }
        },
        mockApiBase: window.__SALO_TEST_MOCK_API_BASE || '',
        mockUploadsBase: window.__SALO_TEST_MOCK_UPLOADS_BASE || ''
      });
      if (resBox) {
        resBox.style.display = 'block';
        resBox.innerHTML = `
          <strong>✅ ¡Publicación completada!</strong> (${result.stats.publishedCount} proyectos públicos)<br/>
          🌐 Página pública (espera ~1–2 min la primera vez): <a href="${result.pagesUrl}" target="_blank" rel="noopener" style="color:var(--gold-bright);">${result.pagesUrl}</a><br/>
          ${result.sheetUrl ? `📊 <a href="${result.sheetUrl}" target="_blank" rel="noopener" style="color:#4ade80;">Abrir Hoja de Visitas (Sheets / Excel)</a><br/>` : ''}
          ${result.folderUrl ? `📁 <a href="${result.folderUrl}" target="_blank" rel="noopener" style="color:#4ade80;">Abrir Carpeta en Google Drive</a><br/>` : ''}
          ${result.warnings.length ? `<small style="color:#fdba74;">⚠️ Avisos: ${result.warnings.join(' · ')}</small>` : ''}
        `;
      }
      showToast('🚀 Showroom publicado en la nube');
    } catch (err) {
      if (progSt) progSt.textContent = `❌ Error: ${err?.message || err}`;
      if (logEl) logEl.textContent += `❌ ERROR: ${err?.message || err}\n`;
      showToast(`Error al publicar: ${err?.message || err}`);
    } finally {
      if (btn) btn.disabled = false;
    }
  });
  document.getElementById('btn-drawer-go-360').addEventListener('click', async () => {
    const unit = state.units.find((u) => u.id === state.selectedUnitId);
    const scopeLvl = state.activeLevelId !== 'facade' ? state.activeLevelId : (unit?.targetLevelId || null);
    await openFloorTour360(scopeLvl, unit?.defaultRoom360 || null, true);
  });
  document.getElementById('btn-drawer-go-finishes').addEventListener('click', () => {
    const unit = state.units.find((u) => u.id === state.selectedUnitId);
    if (unit && Array.isArray(state.finishes?.tabs)) {
      const matchIdx = state.finishes.tabs.findIndex((t) => Array.isArray(t.assignedUnitIds) && t.assignedUnitIds.includes(unit.id));
      if (matchIdx >= 0) {
        state.finishes.activeTabId = state.finishes.tabs[matchIdx].id;
        state.finishes.currentPage = Math.floor(matchIdx / FINISHES_PAGE_SIZE);
        savePersistedState();
        renderFinishesTabs();
      }
    }
    switchView('finishes', true);
  });
  document.getElementById('btn-drawer-whatsapp').addEventListener('click', () => {
    const unit = state.units.find((u) => u.id === state.selectedUnitId);
    const msg = `Hola, me interesa consultar por ${unit?.code || state.project.fullTitle}${unit?.area ? ` (${unit.area} m²)` : ''}.`;
    window.open(buildWhatsAppUrl(msg), '_blank');
  });

  // Pro 360° Controls (Side Prev/Next, Numbered Bar Scroll Arrows, Zoom, Reset, AutoRotate, Back)
  document.getElementById('btn-360-prev-room').addEventListener('click', () => stepRoom360(-1));
  document.getElementById('btn-360-next-room').addEventListener('click', () => stepRoom360(1));
  document.getElementById('btn-360-nums-left')?.addEventListener('click', () => {
    document.getElementById('tour360-numbers-track')?.scrollBy({ left: -160, behavior: 'smooth' });
  });
  document.getElementById('btn-360-nums-right')?.addEventListener('click', () => {
    document.getElementById('tour360-numbers-track')?.scrollBy({ left: 160, behavior: 'smooth' });
  });
  document.getElementById('btn-360-zoom-in').addEventListener('click', () => {
    if (!tour360.camera) return;
    tour360.camera.fov = Math.max(30, tour360.camera.fov - 8);
    tour360.camera.updateProjectionMatrix();
  });
  document.getElementById('btn-360-zoom-out').addEventListener('click', () => {
    if (!tour360.camera) return;
    tour360.camera.fov = Math.min(92, tour360.camera.fov + 8);
    tour360.camera.updateProjectionMatrix();
  });
  document.getElementById('btn-360-reset-view').addEventListener('click', () => {
    resetTour360CameraToCenter();
  });
  document.getElementById('btn-360-gyro')?.addEventListener('click', () => toggleTour360Gyroscope(null, true));
  const t360Panel = document.getElementById('tour360-floors-panel');
  const t360Restore = document.getElementById('restore-360-floors');
  const view360El = document.getElementById('view-tour360');
  document.getElementById('btn-min-360-floors')?.addEventListener('click', () => {
    t360Panel?.classList.add('minimized');
    t360Restore?.classList.add('visible');
    view360El?.classList.add('tour360-floors-hidden');
  });
  t360Restore?.addEventListener('click', () => {
    t360Panel?.classList.remove('minimized');
    t360Restore?.classList.remove('visible');
    view360El?.classList.remove('tour360-floors-hidden');
  });
  document.getElementById('btn-360-exit-exterior').addEventListener('click', goBackHistory);

  document.getElementById('btn-360-add-hotspot').addEventListener('click', (e) => {
    if (!isEditor()) return;
    state.isPlacingHotspot360 = !state.isPlacingHotspot360;
    e.currentTarget.classList.toggle('active', state.isPlacingHotspot360);
    document.getElementById('hotspot-place-hint').style.display = state.isPlacingHotspot360 ? 'block' : 'none';
  });
  document.getElementById('hs360-upload-new-target').addEventListener('change', async (e) => {
    if (!isEditor()) return;
    const file = e.target.files[0]; if (!file) return;
    const customName = document.getElementById('hs360-new-room-name').value.trim() || file.name.replace(/\.[^.]+$/, '');
    const newId = `room-${Date.now()}`;
    const mediaKey = `pano360-${newId}`;
    const url = await saveMediaBlob(mediaKey, file);
    const scopeLvl = state.activeTour360LevelId || (state.activeLevelId !== 'facade' ? state.activeLevelId : null);
    state.rooms360.push({
      id: newId, levelId: scopeLvl, name: customName, subtitle: 'Panorama 360° HD', customImageUrl: url, mediaKey,
      hotspots: [{ arrow: 'floor-ring', lon: 0, lat: -14, targetRoomId: state.activeRoom360Id, label: 'Regresar' }]
    });
    savePersistedState();
    renderNumbered360Bar();
    const sel = document.getElementById('hs360-input-target');
    const opt = document.createElement('option'); opt.value = newId; opt.textContent = customName; sel.appendChild(opt); sel.value = newId;
    document.getElementById('hs360-input-label').value = customName;
    showToast(`Panorama "${customName}" subido sin pérdida`);
    e.target.value = '';
  });
  document.getElementById('btn-save-hs360-modal').addEventListener('click', () => {
    if (!isEditor()) return;
    const room = state.rooms360.find((r) => r.id === state.activeRoom360Id);
    if (room) {
      const arrow = document.getElementById('hs360-input-arrow').value || 'floor-ring';
      const label = document.getElementById('hs360-input-label').value.trim();
      const targetRoomId = document.getElementById('hs360-input-target').value;
      if (state.editingHotspotIndex !== null && room.hotspots[state.editingHotspotIndex]) {
        Object.assign(room.hotspots[state.editingHotspotIndex], { arrow, label, targetRoomId });
        showToast('Botón 360° actualizado');
      } else {
        room.hotspots.push({
          arrow, label, targetRoomId,
          lon: state.pendingHotspotCoords.lon, lat: state.pendingHotspotCoords.lat
        });
        showToast('Botón 360° colocado');
      }
      savePersistedState();
      syncHotspots360DOM();
    }
    state.editingHotspotIndex = null;
    state.isPlacingHotspot360 = false;
    document.getElementById('btn-360-add-hotspot').classList.remove('active');
    document.getElementById('hotspot-place-hint').style.display = 'none';
    document.getElementById('modal-hotspot360-editor').classList.remove('open');
  });
  document.getElementById('btn-close-hs360-modal').addEventListener('click', () => { state.editingHotspotIndex = null; document.getElementById('modal-hotspot360-editor').classList.remove('open'); });
  document.getElementById('btn-cancel-hs360-modal').addEventListener('click', () => { state.editingHotspotIndex = null; document.getElementById('modal-hotspot360-editor').classList.remove('open'); });

  const handle360Upload = async (file, customName) => {
    if (!isEditor() || !file) return;
    const newId = `room-${Date.now()}`;
    const mediaKey = `pano360-${newId}`;
    const url = await saveMediaBlob(mediaKey, file);
    const title = customName || file.name.replace(/\.[^.]+$/, '');
    const scopeLvl = state.activeTour360LevelId || (state.activeLevelId !== 'facade' ? state.activeLevelId : null);
    const prevRoomId = state.activeRoom360Id || 'living';
    state.rooms360.push({
      id: newId,
      levelId: scopeLvl,
      name: title,
      subtitle: 'Panorama 360° Calidad Original',
      customImageUrl: url,
      mediaKey,
      customNightImageUrl: null,
      nightMediaKey: null,
      hotspots: [{ arrow: 'floor-ring', lon: 0, lat: -14, targetRoomId: prevRoomId, label: 'Volver' }]
    });
    savePersistedState();
    await switchView('tour360', false, true);
    loadRoom360(newId);
    showToast(`Panorama "${title}" cargado en calidad nativa`);
  };
  const handle360NightUpload = async (file) => {
    if (!isEditor() || !file) return;
    const scoped = getRooms360ForScope(state.activeTour360LevelId);
    if (state.activeTour360LevelId && scoped.length === 0) {
      showToast('Primero sube una imagen 360° para este piso');
      return;
    }
    const targetRoom = scoped.find((r) => r.id === state.activeRoom360Id)
      || scoped[0]
      || state.rooms360.find((r) => r.id === state.activeRoom360Id)
      || state.rooms360[0];
    if (!targetRoom) { showToast('Primero sube o elige un panorama 360°'); return; }
    const nightKey = `pano360-night-${targetRoom.id}-${Date.now()}`;
    const url = await saveMediaBlob(nightKey, file);
    targetRoom.customNightImageUrl = url;
    targetRoom.nightMediaKey = nightKey;
    savePersistedState();
    await switchView('tour360', false, true);
    state.activeRoom360Id = targetRoom.id;
    toggleDayNightMode(true);
    showToast(`360° Nocturna cargada en "${targetRoom.name}"`);
  };
  document.getElementById('input-upload-360-inline').addEventListener('change', (e) => { handle360Upload(e.target.files[0]); e.target.value = ''; });
  document.getElementById('input-upload-360-night-inline')?.addEventListener('change', (e) => { handle360NightUpload(e.target.files[0]); e.target.value = ''; });
  document.getElementById('btn-clear-360-night')?.addEventListener('click', () => {
    if (!isEditor()) return;
    const targetRoom = state.rooms360.find((r) => r.id === state.activeRoom360Id);
    if (!targetRoom) return;
    targetRoom.customNightImageUrl = null;
    targetRoom.nightMediaKey = null;
    savePersistedState();
    loadRoom360(targetRoom.id);
    showToast(`360° nocturna quitada de "${targetRoom.name}"`);
  });
  document.getElementById('studio-upload-360').addEventListener('change', (e) => { handle360Upload(e.target.files[0], document.getElementById('studio-360-name').value); e.target.value = ''; });
  document.getElementById('studio-upload-360-night')?.addEventListener('change', (e) => { handle360NightUpload(e.target.files[0]); e.target.value = ''; });

  // 3D Controls (Editable Floors & Editable Direct Cameras)
  const step3DFloor = (delta) => {
    const list = [...(Array.isArray(state.floors3D) && state.floors3D.length > 0 ? state.floors3D : defaultFloors3DConfig)]
      .sort((a, b) => (a.heightCut ?? a.num) - (b.heightCut ?? b.num));
    let curIdx = list.findIndex((f) => f.id === model3d.activeFloor3DId || (!model3d.activeFloor3DId && f.num === model3d.activeFloor3D));
    if (curIdx < 0) curIdx = 0;
    const nextIdx = Math.max(0, Math.min(list.length - 1, curIdx + delta));
    select3DFloor(list[nextIdx].id);
  };
  document.getElementById('btn-3d-floor-up').addEventListener('click', () => step3DFloor(1));
  document.getElementById('btn-3d-floor-down').addEventListener('click', () => step3DFloor(-1));
  document.getElementById('btn-3d-explode').addEventListener('click', toggleExploded3DView);
  document.getElementById('slider-cut-height').addEventListener('input', (e) => {
    model3d.camLerpTargetPos = null;
    const val = parseFloat(e.target.value);
    model3d.clipPlane.constant = val;
    document.getElementById('label-cut-height').textContent = `${val.toFixed(1)}m`;
  });
  document.getElementById('slider-sun-hour').addEventListener('input', (e) => {
    const hr = parseFloat(e.target.value);
    const angle = ((hr - 6) / 15) * Math.PI;
    model3d.sunLight.position.set(Math.cos(angle) * 26, Math.max(3, Math.sin(angle) * 30), 16);
    const hh = Math.floor(hr); const mm = Math.round((hr - hh) * 60).toString().padStart(2, '0');
    document.getElementById('label-sun-hour').textContent = `${hh}:${mm} hs`;
  });
  document.getElementById('btn-3d-save-camera')?.addEventListener('click', () => {
    if (!isEditor()) return;
    const defaultName = `Vista 3D ${(state.cameras3D?.length || 0) + 1}`;
    const name = window.prompt('Nombre para guardar la vista actual de cámara 3D:', defaultName);
    if (!name || !name.trim()) return;
    const snap = getCurrentCamera3DSnapshot();
    if (!Array.isArray(state.cameras3D)) state.cameras3D = structuredClone(defaultCameras3D);
    state.cameras3D.push({
      id: `cam-${Date.now()}`,
      name: name.trim(),
      camPos: snap.camPos,
      lookAt: snap.lookAt,
      heightCut: snap.heightCut,
      floorNum: model3d.activeFloor3D ?? 0
    });
    savePersistedState();
    render3DCamerasList();
    showToast(`Cámara "${name.trim()}" guardada`);
  });
  document.getElementById('btn-3d-add-floor')?.addEventListener('click', () => {
    if (!isEditor()) return;
    if (!Array.isArray(state.floors3D)) state.floors3D = structuredClone(defaultFloors3DConfig);
    const nextNum = state.floors3D.length;
    const name = window.prompt('Nombre del nuevo Piso / Nivel 3D (se guardará la cámara y corte actuales):', `Piso ${nextNum}° · Nivel 3D`);
    if (!name || !name.trim()) return;
    const badge = window.prompt('Etiqueta corta (ej: Nivel 5, Mezzanine, Azotea):', `Nivel ${nextNum}`) || `Nivel ${nextNum}`;
    const snap = getCurrentCamera3DSnapshot();
    const newFloor = {
      id: `f3d-${Date.now()}`,
      num: nextNum,
      name: name.trim(),
      badge: badge.trim() || `Nivel ${nextNum}`,
      heightCut: snap.heightCut,
      camPos: snap.camPos,
      lookAt: snap.lookAt
    };
    state.floors3D.push(newFloor);
    model3d.activeFloor3DId = newFloor.id;
    model3d.activeFloor3D = newFloor.num;
    savePersistedState();
    render3DFloorSelectorButtons();
    showToast(`Piso 3D "${newFloor.name}" creado (corte ${snap.heightCut}m)`);
  });
  const set3DMode = (m) => {
    model3d.mode = (m === 'walk') ? 'walk' : 'orbit';
    document.getElementById('btn-3d-mode-orbit')?.classList.toggle('active', model3d.mode === 'orbit');
    document.getElementById('btn-3d-mode-walk')?.classList.toggle('active', model3d.mode === 'walk');
  };
  document.getElementById('btn-3d-mode-orbit')?.addEventListener('click', () => set3DMode('orbit'));
  document.getElementById('btn-3d-mode-walk')?.addEventListener('click', () => set3DMode('walk'));
  document.querySelectorAll('[data-move]').forEach((btn) => {
    const dir = btn.dataset.move;
    btn.addEventListener('pointerdown', () => { model3d.camLerpTargetPos = null; model3d.keys[dir] = true; });
    btn.addEventListener('pointerup', () => { model3d.keys[dir] = false; });
    btn.addEventListener('pointerleave', () => { model3d.keys[dir] = false; });
  });
  document.getElementById('btn-3d-wireframe').addEventListener('click', () => {
    model3d.wireframe = !model3d.wireframe;
    if (model3d.buildingRoot) {
      model3d.buildingRoot.traverse((c) => {
        if (c.isMesh && c.material) (Array.isArray(c.material) ? c.material : [c.material]).forEach((m) => { m.wireframe = model3d.wireframe; });
      });
    }
  });
  document.getElementById('input-upload-3d-inline').addEventListener('change', (e) => { if (isEditor()) loadCustom3DModelFiles(e.target.files, true); e.target.value = ''; });
  document.getElementById('studio-upload-glb').addEventListener('change', (e) => { if (isEditor()) { switchView('model3d'); loadCustom3DModelFiles(e.target.files, true); } e.target.value = ''; });
  document.getElementById('btn-restore-demo-3d').addEventListener('click', () => {
    if (!isEditor()) return;
    state.customModel3D = { name: null, ext: null, mediaKey: null, mtlMediaKey: null }; savePersistedState(); build4FloorLuxuryTower3D();
  });

  // Location & Google Earth
  document.getElementById('btn-apply-project-coords').addEventListener('click', () => {
    if (!isEditor()) return;
    const lat = parseFloat(document.getElementById('loc-input-lat').value), lng = parseFloat(document.getElementById('loc-input-lng').value);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    state.location.lat = lat; state.location.lng = lng; locationMap.centerLat = lat; locationMap.centerLng = lng;
    savePersistedState(); renderLocationPoiList(); renderLocationMap(); showToast('Coordenadas guardadas');
  });
  document.getElementById('btn-center-project-map').addEventListener('click', () => { fitLocationMapBounds(); });
  document.getElementById('btn-open-google-earth').addEventListener('click', () => {
    const lat = parseFloat(document.getElementById('loc-input-lat').value) || state.location.lat;
    const lng = parseFloat(document.getElementById('loc-input-lng').value) || state.location.lng;
    window.open(buildGoogleEarthUrl(lat, lng), '_blank');
  });
  document.getElementById('btn-export-kml').addEventListener('click', exportLocationToKML);
  document.getElementById('btn-toggle-place-poi').addEventListener('click', (e) => {
    if (!isEditor()) return;
    locationMap.isPlacingPoi = !locationMap.isPlacingPoi;
    e.currentTarget.classList.toggle('active', locationMap.isPlacingPoi);
    document.getElementById('poi-place-hint').style.display = locationMap.isPlacingPoi ? 'block' : 'none';
    document.getElementById('location-map-stage').classList.toggle('placing-poi', locationMap.isPlacingPoi);
  });
  document.getElementById('btn-save-poi-modal').addEventListener('click', () => {
    if (!isEditor()) return;
    const name = document.getElementById('poi-input-name').value.trim() || 'Punto de Referencia';
    const lat = parseFloat(document.getElementById('poi-input-lat').value), lng = parseFloat(document.getElementById('poi-input-lng').value);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    state.location.pois.push({
      id: `poi-${Date.now()}`, name, icon: document.getElementById('poi-input-icon').value,
      color: document.getElementById('poi-input-color').value, note: document.getElementById('poi-input-note').value.trim(), lat, lng
    });
    locationMap.isPlacingPoi = false;
    document.getElementById('btn-toggle-place-poi').classList.remove('active');
    document.getElementById('poi-place-hint').style.display = 'none';
    document.getElementById('location-map-stage').classList.remove('placing-poi');
    document.getElementById('modal-poi-editor').classList.remove('open');
    savePersistedState(); renderLocationPoiList(); fitLocationMapBounds(); showToast(`Punto "${name}" guardado`);
  });
  document.getElementById('btn-close-poi-modal').addEventListener('click', () => document.getElementById('modal-poi-editor').classList.remove('open'));
  document.getElementById('btn-cancel-poi-modal').addEventListener('click', () => document.getElementById('modal-poi-editor').classList.remove('open'));
  document.getElementById('btn-map-zoom-in').addEventListener('click', () => setLocationMapZoom(locationMap.zoom + 1));
  document.getElementById('btn-map-zoom-out').addEventListener('click', () => setLocationMapZoom(locationMap.zoom - 1));
  document.getElementById('btn-fit-map-bounds')?.addEventListener('click', () => fitLocationMapBounds());
  document.getElementById('slider-map-zoom')?.addEventListener('input', (e) => setLocationMapZoom(e.target.value));
  document.getElementById('slider-map-zoom')?.addEventListener('change', (e) => setLocationMapZoom(e.target.value));

  // Studio Uploads
  document.getElementById('studio-upload-day-render').addEventListener('change', async (e) => {
    if (!isEditor()) return;
    const file = e.target.files[0]; if (!file) return;
    const key = `lvl-day-${state.activeLevelId}-${Date.now()}`;
    const url = await saveMediaBlob(key, file);
    if (state.activeLevelId === 'facade') {
      const ang = state.exteriorAngles[state.exteriorAngleIndex] || state.exteriorAngles[0];
      if (ang) {
        ang.photo = url;
        ang.mediaKey = key;
        if (!ang.nightMediaKey) ang.nightPhoto = null;
      }
      if (state.exteriorAngleIndex === 0) {
        const facadeLvl = state.levels.find((l) => l.id === 'facade');
        if (facadeLvl) {
          facadeLvl.dayPhoto = url;
          facadeLvl.dayMediaKey = key;
          if (!facadeLvl.nightMediaKey) facadeLvl.nightPhoto = null;
        }
      }
    } else {
      const lvl = state.levels.find((l) => l.id === state.activeLevelId);
      if (lvl) {
        lvl.dayPhoto = url;
        lvl.dayMediaKey = key;
        if (!lvl.nightMediaKey) lvl.nightPhoto = null;
      }
    }
    state.is2DPlanMode = false;
    savePersistedState();
    switchView('masterplan');
    toggleDayNightMode(false);
    document.getElementById('image-adjust-popover').classList.add('open');
    e.target.value = '';
  });
  document.getElementById('studio-upload-night-render').addEventListener('change', async (e) => {
    if (!isEditor()) return;
    const file = e.target.files[0]; if (!file) return;
    const key = `lvl-night-${state.activeLevelId}-${Date.now()}`;
    const url = await saveMediaBlob(key, file);
    if (state.activeLevelId === 'facade') {
      const ang = state.exteriorAngles[state.exteriorAngleIndex] || state.exteriorAngles[0];
      if (ang) { ang.nightPhoto = url; ang.nightMediaKey = key; }
      if (state.exteriorAngleIndex === 0) {
        const facadeLvl = state.levels.find((l) => l.id === 'facade');
        if (facadeLvl) { facadeLvl.nightPhoto = url; facadeLvl.nightMediaKey = key; }
      }
    } else {
      const lvl = state.levels.find((l) => l.id === state.activeLevelId);
      if (lvl) { lvl.nightPhoto = url; lvl.nightMediaKey = key; }
    }
    state.is2DPlanMode = false;
    savePersistedState();
    switchView('masterplan');
    toggleDayNightMode(true);
    e.target.value = '';
  });

  ['filter-status', 'filter-beds', 'filter-price'].forEach((id) => document.getElementById(id).addEventListener('input', renderUnitsCatalog));

  // Units Mode Tabs (Departamentos / Por Niveles / Casa Total) & Show/Hide Toggle
  document.querySelectorAll('[data-units-mode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.unitsConfig.displayMode = btn.dataset.unitsMode;
      savePersistedState();
      renderUnitsCatalog();
    });
  });
  document.getElementById('toggle-show-units-tab')?.addEventListener('change', (e) => {
    if (!isEditor()) return;
    state.unitsConfig.showTab = e.target.checked;
    savePersistedState();
    syncUnitsTabVisibilityUI();
    showToast(state.unitsConfig.showTab ? 'Pestaña Áreas disponibles ($) visible al público' : 'Pestaña Áreas disponibles ($) oculta al público');
  });

  // Export / Import / Reset
  const doResetDemo = async () => {
    if (!isEditor()) return;
    const code = state.project.code || portalState.activeProjectCode || 'SALO-001';
    const meta = portalState.projects.find((p) => p.code.toUpperCase() === code.toUpperCase()) || {
      code,
      buildingName: state.project.buildingName || 'Torre Imperial SALO',
      subtitle: state.project.subtitle || 'Showroom Interactivo 3D · Panorámica · Plantas',
      whatsappPhone: state.project.whatsappPhone || '59173080076'
    };
    localStorage.removeItem(getProjectStorageKey(code));
    navHistory.length = 0;
    state = createFreshProjectState(meta);
    savePersistedState();
    syncProjectBrandingUI(); syncAvanceUI(); applyRoleUI(); renderLevelsSidebar(); drawMasterplanRender(); renderFinishesTabs(); build4FloorLuxuryTower3D(); render3DCamerasList(); render3DFloorSelectorButtons(); initLocationMap(); renderUnitsCatalog(); updateBackButtonUI();
    showToast(`Proyecto ${code} restaurado a ejemplo`);
  };
  document.getElementById('btn-reset-demo-data').addEventListener('click', doResetDemo);
  document.getElementById('menu-reset-demo').addEventListener('click', () => { closeDropdown(); doResetDemo(); });

  const doExportJson = () => {
    if (!isEditor()) return;
    const payload = {
      project: state.project, intro: state.intro, unitsConfig: state.unitsConfig, model3dConfig: state.model3dConfig, avance: state.avance,
      exteriorAngles: state.exteriorAngles, levels: state.levels, units: state.units, rooms360: state.rooms360,
      visibleFields: state.visibleFields, imageAdjustments: state.imageAdjustments, location: state.location,
      finishes: state.finishes, transitions: state.transitions,
      cameras3D: state.cameras3D, floors3D: state.floors3D
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `proyecto-salo-${(state.project.code || 'showroom').toLowerCase()}.json`; a.click();
    showToast('Proyecto exportado (.JSON)');
  };
  document.getElementById('btn-export-project').addEventListener('click', doExportJson);
  document.getElementById('menu-export-json').addEventListener('click', () => { closeDropdown(); doExportJson(); });

  const doImportJson = (file) => {
    if (!isEditor() || !file) return;
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const data = JSON.parse(reader.result);
        if (data.project) state.project = { ...state.project, ...data.project, code: state.project.code };
        if (data.intro) state.intro = { ...state.intro, ...data.intro };
        if (data.unitsConfig) state.unitsConfig = { ...state.unitsConfig, ...data.unitsConfig };
        if (data.model3dConfig) state.model3dConfig = { ...state.model3dConfig, ...data.model3dConfig };
        if (data.avance) state.avance = { ...state.avance, ...data.avance };
        if (Array.isArray(data.exteriorAngles)) state.exteriorAngles = data.exteriorAngles;
        if (Array.isArray(data.levels)) state.levels = data.levels;
        if (Array.isArray(data.units)) state.units = data.units;
        if (Array.isArray(data.rooms360)) state.rooms360 = data.rooms360;
        if (data.visibleFields) state.visibleFields = data.visibleFields;
        if (data.imageAdjustments) state.imageAdjustments = data.imageAdjustments;
        if (data.location) state.location = data.location;
        if (data.finishes) state.finishes = data.finishes;
        if (data.transitions) state.transitions = data.transitions;
        if (Array.isArray(data.cameras3D) && data.cameras3D.length > 0) state.cameras3D = data.cameras3D;
        if (Array.isArray(data.floors3D) && data.floors3D.length > 0) state.floors3D = data.floors3D;

        let accessCode = normalizeAccessCode(state.project.accessCode || '');
        let accessCodeHash = accessCode ? await hashAccessCode(accessCode) : (state.project.accessCodeHash || null);
        if (accessCodeHash && findUniqueAccessCodeConflict(portalState.projects, accessCode, accessCodeHash, state.project.code)) {
          showToast(`⚠️ Código "${accessCode}" en uso por otro proyecto; se limpió en el importado`);
          accessCode = '';
          accessCodeHash = null;
        }
        const requiresCode = Boolean(accessCodeHash);
        state.project.accessCode = accessCode;
        state.project.accessCodeHash = accessCodeHash;
        state.project.requiresCode = requiresCode;

        const meta = portalState.projects.find((p) => p.code.toUpperCase() === (state.project.code || '').toUpperCase());
        if (meta) {
          meta.buildingName = state.project.buildingName || meta.buildingName;
          meta.subtitle = state.project.subtitle || meta.subtitle;
          meta.whatsappPhone = state.project.whatsappPhone || meta.whatsappPhone;
          meta.accessCode = accessCode;
          meta.accessCodeHash = accessCodeHash;
          meta.requiresCode = requiresCode;
        }

        savePersistedState();
        syncProjectBrandingUI();
        syncModel3DTabVisibilityUI();
        syncAvanceUI();
        renderLevelsSidebar();
        drawMasterplanRender();
        render3DCamerasList();
        render3DFloorSelectorButtons();
        renderFinishesTabs();
        renderLocationPoiList();
        renderUnitsCatalog();
        renderPortalProjects();
        showToast('Proyecto importado');
      } catch (_) {}
    };
    reader.readAsText(file);
  };
  document.getElementById('input-import-project').addEventListener('change', (e) => { doImportJson(e.target.files[0]); e.target.value = ''; });
  document.getElementById('menu-input-import-project').addEventListener('change', (e) => { closeDropdown(); doImportJson(e.target.files[0]); e.target.value = ''; });

  // Keyboard Shortcuts (Escape / Arrow Navigation)
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      document.querySelectorAll('.modal-backdrop.open').forEach((m) => m.classList.remove('open'));
      document.getElementById('modal-photo-viewer')?.classList.remove('open');
      closeMenuDrawer();
      closeDropdown();
      return;
    }
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    if (e.key === 'Enter' && isEditor() && state.isDrawingPolygon && state.draftPolygonPoints.length >= 3) {
      openPolygonEditorModal(null);
    } else if (state.activeView === 'masterplan') {
      if (e.key === 'ArrowLeft') rotateExteriorFlyby(-1);
      if (e.key === 'ArrowRight') rotateExteriorFlyby(1);
    } else if (state.activeView === 'tour360') {
      if (e.key === 'ArrowLeft') stepRoom360(-1);
      if (e.key === 'ArrowRight') stepRoom360(1);
    }
  });

  window.addEventListener('resize', () => {
    if (state.activeView === 'tour360' && tour360.renderer) {
      const c = document.getElementById('tour360-container');
      tour360.camera.aspect = c.clientWidth / c.clientHeight; tour360.camera.updateProjectionMatrix(); tour360.renderer.setSize(c.clientWidth, c.clientHeight);
    }
    if (state.activeView === 'model3d' && model3d.renderer) {
      const c = document.getElementById('model3d-canvas-container');
      model3d.camera.aspect = c.clientWidth / c.clientHeight; model3d.camera.updateProjectionMatrix(); model3d.renderer.setSize(c.clientWidth, c.clientHeight);
    }
    if (state.activeView === 'location') renderLocationMap();
  });
}

function animate() {
  requestAnimationFrame(animate);

  if (state.activeView === 'tour360' && tour360.renderer && tour360.camera) {
    if (tour360.fadeMesh && tour360.fadeStartTime) {
      const elapsed = performance.now() - tour360.fadeStartTime;
      const t = Math.min(1, Math.max(0, elapsed / 1000));
      tour360.fadeMesh.material.opacity = 1 - t;
      if (t >= 1) disposeTour360FadeMesh();
    }
    tour360.lat = Math.max(-85, Math.min(85, tour360.lat));
    const phi = THREE.MathUtils.degToRad(90 - tour360.lat);
    const theta = THREE.MathUtils.degToRad(tour360.lon);
    tour360.camera.lookAt(new THREE.Vector3(500 * Math.sin(phi) * Math.cos(theta), 500 * Math.cos(phi), 500 * Math.sin(phi) * Math.sin(theta)));
    tour360.renderer.render(tour360.scene, tour360.camera);
    updateHotspots360Projection();
  }

  if (state.activeView === 'model3d' && model3d.renderer && model3d.camera) {
    if (model3d.floorGroups.length > 0) {
      model3d.floorGroups.forEach((fg) => {
        const targetY = fg.userData.baseY + (model3d.isExploded ? (fg.userData.floorNum - 1) * 2.2 : 0);
        fg.position.y += (targetY - fg.position.y) * 0.1;
      });
    }
    if (model3d.camLerpTargetPos && model3d.camLerpLookAt) {
      model3d.camera.position.lerp(model3d.camLerpTargetPos, 0.09);
      model3d.controls.target.lerp(model3d.camLerpLookAt, 0.09);
      if (model3d.camera.position.distanceTo(model3d.camLerpTargetPos) < 0.08) { model3d.camLerpTargetPos = null; model3d.camLerpLookAt = null; }
    }
    const speed = 0.18;
    const forward = new THREE.Vector3(); model3d.camera.getWorldDirection(forward); forward.y = 0; forward.normalize();
    const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
    if (model3d.keys.forward) { model3d.camera.position.addScaledVector(forward, speed); model3d.controls.target.addScaledVector(forward, speed); }
    if (model3d.keys.backward) { model3d.camera.position.addScaledVector(forward, -speed); model3d.controls.target.addScaledVector(forward, -speed); }
    if (model3d.keys.left) { model3d.camera.position.addScaledVector(right, -speed); model3d.controls.target.addScaledVector(right, -speed); }
    if (model3d.keys.right) { model3d.camera.position.addScaledVector(right, speed); model3d.controls.target.addScaledVector(right, speed); }
    if (model3d.keys.up) { model3d.camera.position.y += speed * 0.8; model3d.controls.target.y += speed * 0.8; }
    if (model3d.keys.down) { model3d.camera.position.y = Math.max(0.5, model3d.camera.position.y - speed * 0.8); model3d.controls.target.y = Math.max(0.3, model3d.controls.target.y - speed * 0.8); }
    model3d.controls.update();
    model3d.renderer.render(model3d.scene, model3d.camera);
    update3DRoomLabelsProjection();
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  const publishedMode = isPublishedRuntime();
  const urlParams = new URLSearchParams(window.location.search);
  const urlMode = urlParams.get('mode');
  const urlProjectCode = (urlParams.get('project') || urlParams.get('code') || '').trim().toUpperCase();

  if (publishedMode) {
    document.body.dataset.runtime = 'published';
    portalState.auth = { mode: 'public', currentUser: '', editors: [] };
    try {
      const pubPortal = await fetchPublishedPortal('./');
      portalState.projects = pubPortal.projects || [];
      portalState.examplePhotos = pubPortal.examplePhotos || [];
      portalState.publishVersion = pubPortal.publishVersion || '';
      portalState.visitsScriptUrl = pubPortal.visitsScriptUrl || '';
      if (portalState.projects[0]?.code) portalState.activeProjectCode = portalState.projects[0].code;
    } catch (err) {
      showToast('No se pudieron cargar los proyectos publicados');
    }
  } else {
    document.body.dataset.runtime = 'local';
    loadPortalState();
    await hydratePortalMediaFromIndexedDB();
    if (urlMode === 'public') portalState.auth.mode = 'public';
  }

  const targetCode = urlProjectCode || portalState.activeProjectCode;
  if (!publishedMode) loadPersistedState(targetCode);
  else state = createFreshProjectState(portalState.projects.find((p) => p.code.toUpperCase() === targetCode) || portalState.projects[0] || { code: 'SALO-001', buildingName: 'SALO Showroom' });

  syncProjectBrandingUI();
  syncAvanceUI();
  initTour360Viewer();
  initModel3DViewer();
  initFinishesComparator();
  initLocationMap();
  bindEvents();

  renderPortalProjects();
  renderPortalExamples();
  syncPortalEditorTabUI();

  if (!publishedMode) {
    for (const p of portalState.projects) {
      if (p.accessCode && !p.accessCodeHash) {
        p.accessCodeHash = await hashAccessCode(p.accessCode);
        p.requiresCode = true;
      }
    }
  }

  const matchedUrlMeta = urlProjectCode
    ? portalState.projects.find((p) => p.code.toUpperCase() === urlProjectCode)
    : null;
  const openedDirectly = Boolean(matchedUrlMeta);
  const forcedDirectRole = (publishedMode || urlMode === 'public') ? 'public' : null;
  if (openedDirectly && (!matchedUrlMeta.requiresCode || (!forcedDirectRole && isEditor()))) {
    await openProjectByCode(urlProjectCode, forcedDirectRole);
  } else {
    if (!publishedMode) await hydrateMediaFromIndexedDB();
    render3DCamerasList();
    render3DFloorSelectorButtons();
    syncProjectBrandingUI();
    applyRoleUI();
    renderLevelsSidebar();
    drawMasterplanRender();
    selectUnit(state.selectedUnitId, false);
    loadRoom360(state.activeRoom360Id);
    renderFinishesTabs();
    renderUnitsCatalog();
    updateBackButtonUI();
    showScreen('portal');
    if (openedDirectly && matchedUrlMeta.requiresCode) {
      await requestProjectAccessAndOpen(matchedUrlMeta, forcedDirectRole);
    }
  }

  if (publishedMode && portalState.visitsScriptUrl) {
    const activeMeta = portalState.projects.find((p) => p.code.toUpperCase() === (openedDirectly ? urlProjectCode : '').toUpperCase());
    trackPublicVisitOnce({
      visitsScriptUrl: portalState.visitsScriptUrl,
      projectCode: openedDirectly ? urlProjectCode : 'PORTAL',
      buildingName: openedDirectly ? (activeMeta?.buildingName || state.project.buildingName) : 'Portal SALO',
      initialView: openedDirectly ? 'showroom' : 'portal'
    });
  }

  animate();
});
