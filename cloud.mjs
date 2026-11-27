/**
 * SALO SHOWROOM — Cloud Publishing, Sanitization, Multi-Email Drive & Visit Logger
 */

export const CLOUD_CONFIG_STORAGE_KEY = 'salo_cloud_config_v8';

export function normalizeAccessCode(raw) {
  return String(raw || '').trim().toUpperCase();
}

function sha256PureJs(str) {
  const bytes = new TextEncoder().encode(str);
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const bitLen = bytes.length * 8;
  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLen);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);
  dv.setUint32(paddedLen - 4, bitLen >>> 0, false);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let i = 0; i < paddedLen; i += 64) {
    for (let t = 0; t < 16; t++) w[t] = dv.getUint32(i + t * 4, false);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(w[t - 15], 7) ^ rotr(w[t - 15], 18) ^ (w[t - 15] >>> 3);
      const s1 = rotr(w[t - 2], 17) ^ rotr(w[t - 2], 19) ^ (w[t - 2] >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ ((~e) & g);
      const t1 = (h + S1 + ch + K[t] + w[t]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
  }
  return Array.from(H).map((x) => x.toString(16).padStart(8, '0')).join('');
}

export async function hashAccessCode(raw) {
  const norm = normalizeAccessCode(raw);
  if (!norm) return null;
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.subtle) {
    const buf = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(norm));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return sha256PureJs(norm);
}

export function findUniqueAccessCodeConflict(projects, candidateCode, candidateHash = null, ignoreProjectCode = null) {
  const norm = normalizeAccessCode(candidateCode);
  if (!norm && !candidateHash) return null;
  const ignore = String(ignoreProjectCode || '').toUpperCase();
  for (const p of (projects || [])) {
    if (!p || String(p.code || '').toUpperCase() === ignore) continue;
    if (candidateHash && p.accessCodeHash && p.accessCodeHash === candidateHash) return p;
    if (norm && p.accessCode && normalizeAccessCode(p.accessCode) === norm) return p;
  }
  return null;
}

export function isPublishedRuntime(loc = (typeof window !== 'undefined' ? window.location : null)) {
  if (!loc) return false;
  try {
    const params = new URLSearchParams(loc.search || '');
    if (params.get('runtime') === 'published') return true;
    if ((loc.pathname || '').startsWith('/pages-site/')) return true;
    const h = (loc.hostname || '').toLowerCase();
    if (!h) return false;
    return h !== '127.0.0.1' && h !== 'localhost' && loc.protocol !== 'file:';
  } catch (_) {
    return false;
  }
}

export function normalizePublishAssetUrl(val) {
  if (typeof val !== 'string') return val;
  if (val.startsWith('/sample-assets/')) return `.${val}`;
  return val;
}

export function normalizeAssetUrlsDeep(node) {
  if (typeof node === 'string') return normalizePublishAssetUrl(node);
  if (Array.isArray(node)) return node.map((v) => normalizeAssetUrlsDeep(v));
  if (node && typeof node === 'object') {
    const out = {};
    for (const k of Object.keys(node)) {
      out[k] = normalizeAssetUrlsDeep(node[k]);
    }
    return out;
  }
  return node;
}

export function formatReleaseAssetUrl(workerBaseUrl, owner, repo, tag, assetName) {
  const cleanWorker = String(workerBaseUrl || '').replace(/\/+$/, '');
  const safeName = encodeURIComponent(assetName);
  const safeTag = encodeURIComponent(tag);
  if (cleanWorker) {
    return `${cleanWorker}/${owner}/${repo}/releases/download/${safeTag}/${safeName}`;
  }
  return `https://github.com/${owner}/${repo}/releases/download/${safeTag}/${safeName}`;
}

function resolveMediaField(currentUrl, mediaKey, assetUrlMap, fallbackUrl = null) {
  if (mediaKey && assetUrlMap instanceof Map && assetUrlMap.has(mediaKey)) {
    return assetUrlMap.get(mediaKey);
  }
  if (currentUrl && typeof currentUrl === 'string' && !currentUrl.startsWith('blob:')) {
    return normalizePublishAssetUrl(currentUrl);
  }
  return fallbackUrl;
}

export function sanitizePortalForPublish(portalState, assetUrlMap = new Map(), visitsScriptUrl = '') {
  const publishedProjects = (portalState?.projects || [])
    .filter((p) => p && p.published !== false)
    .map((p) => ({
      code: String(p.code || '').toUpperCase(),
      projectType: p.projectType === 'structures' ? 'structures' : 'showroom',
      buildingName: p.buildingName || 'Proyecto SALO',
      subtitle: p.subtitle || '',
      whatsappPhone: p.whatsappPhone || '59173080076',
      published: true,
      requiresCode: Boolean(p.requiresCode && p.accessCodeHash),
      accessCodeHash: (p.requiresCode && p.accessCodeHash) ? String(p.accessCodeHash).toLowerCase() : null,
      coverUrl: resolveMediaField(p.coverUrl, p.coverMediaKey, assetUrlMap, './sample-assets/exterior-tower.webp'),
      createdAt: p.createdAt || ''
    }));

  const examplePhotos = (portalState?.examplePhotos || []).map((ex) => {
    if (ex && ex.type === 'folder') {
      const items = (ex.items || []).map((it) => ({
        id: it.id,
        title: it.title || 'Vista del Proyecto',
        url: resolveMediaField(it.url, it.mediaKey, assetUrlMap, './sample-assets/exterior-tower.webp')
      }));
      return {
        id: ex.id,
        type: 'folder',
        title: ex.title || 'Carpeta de Proyecto',
        coverUrl: resolveMediaField(ex.coverUrl, ex.coverMediaKey, assetUrlMap, items[0]?.url || './sample-assets/exterior-tower.webp'),
        items
      };
    }
    return {
      id: ex.id,
      type: 'photo',
      title: ex.title || 'Proyecto SALO',
      url: resolveMediaField(ex.url, ex.mediaKey, assetUrlMap, './sample-assets/exterior-tower.webp')
    };
  });

  const news = (portalState?.news || [])
    .filter((n) => n && typeof n.url === 'string' && /^https?:\/\/(?:[a-z0-9-]+\.)?tiktok\.com\//i.test(n.url))
    .map((n) => ({
      id: n.id || `news-${Date.now()}`,
      title: n.title || 'Noticia SALO',
      url: n.url,
      videoId: (n.videoId && /^\d{8,25}$/.test(String(n.videoId))) ? String(n.videoId) : null,
      createdAt: n.createdAt || ''
    }));

  return {
    publishVersion: String(Date.now()),
    publishedAt: new Date().toISOString(),
    visitsScriptUrl: visitsScriptUrl || '',
    projects: publishedProjects,
    examplePhotos,
    news
  };
}

export function sanitizeProjectForPublish(projectState, assetUrlMap = new Map()) {
  const clone = normalizeAssetUrlsDeep(structuredClone(projectState || {}));

  delete clone.auth;
  delete clone.cloudConfig;
  delete clone.editingShapeUnitId;
  delete clone.editingPolygonUnitId;
  delete clone.editingFloorId;
  delete clone.editingHotspotIndex;
  delete clone.isDrawingPolygon;
  delete clone.isPlacingPlanPoint;
  delete clone.draftPolygonPoints;

  if (clone.project) {
    clone.project.shortName = 'SALO SHOWROOM';
    delete clone.project.accessCode;
    delete clone.project.accessCodeHash;
    clone.project.logoUrl = resolveMediaField(clone.project.logoUrl, clone.project.logoMediaKey, assetUrlMap, null);
    clone.project.logoMediaKey = null;
  }

  if (clone.intro) {
    clone.intro.defaultVideo = resolveMediaField(clone.intro.defaultVideo, clone.intro.mediaKey, assetUrlMap, './sample-assets/transition-fly.mp4');
    clone.intro.mediaKey = null;
  }

  const isStruct = clone.project?.projectType === 'structures';
  const fallbackExtImg = isStruct ? '' : './sample-assets/exterior-tower.webp';
  const fallbackFloorImg = isStruct ? '' : './sample-assets/floor-piso9-3d.jpg';
  const fallbackPlan2DImg = isStruct ? null : './sample-assets/floor-piso9-plan.webp';

  if (Array.isArray(clone.exteriorAngles)) {
    clone.exteriorAngles = clone.exteriorAngles.map((a) => ({
      ...a,
      photo: resolveMediaField(a.photo, a.mediaKey, assetUrlMap, fallbackExtImg),
      nightPhoto: resolveMediaField(a.nightPhoto, a.nightMediaKey, assetUrlMap, null),
      mediaKey: null,
      nightMediaKey: null
    }));
  }

  if (Array.isArray(clone.levels)) {
    clone.levels = clone.levels.map((l) => ({
      ...l,
      dayPhoto: resolveMediaField(l.dayPhoto, l.dayMediaKey, assetUrlMap, fallbackFloorImg),
      nightPhoto: resolveMediaField(l.nightPhoto, l.nightMediaKey, assetUrlMap, null),
      plan2DPhoto: resolveMediaField(l.plan2DPhoto, l.plan2DMediaKey, assetUrlMap, fallbackPlan2DImg),
      transitionVideo: resolveMediaField(l.transitionVideo, l.transitionMediaKey, assetUrlMap, null),
      transImg1: resolveMediaField(l.transImg1, l.transImg1Key, assetUrlMap, null),
      transImg2: resolveMediaField(l.transImg2, l.transImg2Key, assetUrlMap, null),
      dayMediaKey: null,
      nightMediaKey: null,
      plan2DMediaKey: null,
      transitionMediaKey: null,
      transImg1Key: null,
      transImg2Key: null
    }));
  }

  if (Array.isArray(clone.units)) {
    clone.units = clone.units.map((u) => ({
      ...u,
      customButtons: (u.customButtons || []).map((cb) => ({
        ...cb,
        photoUrl: resolveMediaField(cb.photoUrl, cb.photoMediaKey, assetUrlMap, cb.actionType === 'pdf' ? null : './sample-assets/render-interior-1.jpg'),
        nightPhotoUrl: resolveMediaField(cb.nightPhotoUrl, cb.nightPhotoMediaKey, assetUrlMap, null),
        pdfUrl: resolveMediaField(cb.pdfUrl, cb.pdfMediaKey, assetUrlMap, null),
        photoMediaKey: null,
        nightPhotoMediaKey: null,
        pdfMediaKey: null
      }))
    }));
  }

  if (Array.isArray(clone.planPoints)) {
    clone.planPoints = clone.planPoints.map((pt) => ({
      ...pt,
      fileUrl: resolveMediaField(pt.fileUrl, pt.fileMediaKey, assetUrlMap, null),
      rebarUrl: resolveMediaField(pt.rebarUrl, pt.rebarMediaKey, assetUrlMap, null),
      fileMediaKey: null,
      rebarMediaKey: null
    }));
  }

  if (Array.isArray(clone.renderedViewsGallery)) {
    clone.renderedViewsGallery = clone.renderedViewsGallery.map((g) => ({
      ...g,
      url: resolveMediaField(g.url, g.mediaKey, assetUrlMap, './sample-assets/render-amenities.jpg'),
      nightUrl: resolveMediaField(g.nightUrl, g.nightMediaKey, assetUrlMap, null),
      mediaKey: null,
      nightMediaKey: null
    }));
  }

  if (Array.isArray(clone.rooms360)) {
    clone.rooms360 = clone.rooms360.map((r) => ({
      ...r,
      customImageUrl: resolveMediaField(r.customImageUrl, r.mediaKey, assetUrlMap, null),
      customNightImageUrl: resolveMediaField(r.customNightImageUrl, r.nightMediaKey, assetUrlMap, null),
      mediaKey: null,
      nightMediaKey: null
    }));
  }

  if (clone.finishes && Array.isArray(clone.finishes.tabs)) {
    clone.finishes.tabs = clone.finishes.tabs.map((t) => ({
      ...t,
      items: (t.items || []).map((it) => ({
        ...it,
        url: resolveMediaField(it.url, it.mediaKey, assetUrlMap, null),
        mediaKey: null
      }))
    }));
  }

  if (clone.transitions && Array.isArray(clone.transitions.slots)) {
    clone.transitions.slots = clone.transitions.slots.map((sl) => ({
      ...sl,
      defaultVideo: resolveMediaField(sl.defaultVideo, sl.mediaKey, assetUrlMap, sl.defaultVideo || null),
      img1Url: resolveMediaField(sl.img1Url, sl.img1Key, assetUrlMap, null),
      img2Url: resolveMediaField(sl.img2Url, sl.img2Key, assetUrlMap, null),
      mediaKey: null,
      img1Key: null,
      img2Key: null
    }));
  }

  if (clone.customModel3D) {
    const resolvedModelUrl = resolveMediaField(clone.customModel3D.url, clone.customModel3D.mediaKey, assetUrlMap, null);
    const resolvedMtlUrl = resolveMediaField(clone.customModel3D.mtlUrl, clone.customModel3D.mtlMediaKey, assetUrlMap, null);
    clone.customModel3D = {
      name: clone.customModel3D.name || null,
      ext: clone.customModel3D.ext || null,
      url: resolvedModelUrl,
      mtlUrl: resolvedMtlUrl,
      mediaKey: null,
      mtlMediaKey: null
    };
  }

  return clone;
}

export function collectProjectMediaKeys(projectState) {
  const map = new Map();
  if (!projectState) return [];
  const add = (k, hint) => { if (k && !map.has(k)) map.set(k, { key: k, hint: hint || k }); };

  add(projectState.project?.logoMediaKey, 'logo');
  add(projectState.intro?.mediaKey, 'intro');
  (projectState.exteriorAngles || []).forEach((a, i) => {
    add(a.mediaKey, `ext-${i}`);
    add(a.nightMediaKey, `ext-${i}-night`);
  });
  (projectState.levels || []).forEach((l) => {
    add(l.dayMediaKey, `${l.id}-day`);
    add(l.nightMediaKey, `${l.id}-night`);
    add(l.plan2DMediaKey, `${l.id}-plan2d`);
    add(l.transitionMediaKey, `${l.id}-trans`);
    add(l.transImg1Key, `${l.id}-img1`);
    add(l.transImg2Key, `${l.id}-img2`);
  });
  (projectState.units || []).forEach((u) => {
    (u.customButtons || []).forEach((cb) => {
      add(cb.photoMediaKey, `btn-${cb.id}`);
      add(cb.nightPhotoMediaKey, `btn-${cb.id}-night`);
      add(cb.pdfMediaKey, `btn-${cb.id}.pdf`);
    });
  });
  (projectState.planPoints || []).forEach((pt) => {
    add(pt.fileMediaKey, pt.actionType === 'pdf' ? `planpt-${pt.id}.pdf` : `planpt-${pt.id}`);
    add(pt.rebarMediaKey, `planpt-${pt.id}-rebar`);
  });
  (projectState.renderedViewsGallery || []).forEach((g) => {
    add(g.mediaKey, `gallery-${g.id}`);
    add(g.nightMediaKey, `gallery-${g.id}-night`);
  });
  (projectState.rooms360 || []).forEach((r) => {
    add(r.mediaKey, `360-${r.id}`);
    add(r.nightMediaKey, `360-${r.id}-night`);
  });
  (projectState.finishes?.tabs || []).forEach((t) => {
    (t.items || []).forEach((it) => add(it.mediaKey, `finish-${it.id}`));
  });
  (projectState.transitions?.slots || []).forEach((s) => {
    add(s.mediaKey, `slot-${s.id}`);
    add(s.img1Key, `slot-${s.id}-1`);
    add(s.img2Key, `slot-${s.id}-2`);
  });
  if (projectState.customModel3D?.mediaKey) {
    add(projectState.customModel3D.mediaKey, projectState.customModel3D.name || `modelo.${projectState.customModel3D.ext || 'glb'}`);
  }
  if (projectState.customModel3D?.mtlMediaKey) {
    add(projectState.customModel3D.mtlMediaKey, 'materials.mtl');
  }

  return [...map.values()];
}

export function guessExtFromBlob(blob, fallbackHint = '') {
  const mHint = String(fallbackHint || '').match(/\.[a-z0-9]{2,5}$/i);
  if (mHint) return mHint[0].toLowerCase();
  const mime = (blob?.type || '').toLowerCase();
  if (mime.includes('jpeg') || mime.includes('jpg')) return '.jpg';
  if (mime.includes('png')) return '.png';
  if (mime.includes('webp')) return '.webp';
  if (mime.includes('pdf')) return '.pdf';
  if (mime.includes('mp4')) return '.mp4';
  if (mime.includes('webm')) return '.webm';
  if (mime.includes('gltf-binary')) return '.glb';
  return '.bin';
}

/* ==========================================================================
   LOCAL PC CLOUD CONFIG (STORED STRICTLY ON PC, NEVER PUBLISHED)
   ========================================================================== */
export function loadCloudConfig() {
  const fallback = {
    ghOwner: '',
    ghRepo: 'salo-showroom',
    ghBranch: 'main',
    ghToken: '',
    cfWorkerUrl: '',
    uploadPages: true,
    uploadReleases: true,
    backupToDrive: true,
    activeDriveProfileId: '',
    driveProfiles: []
  };
  try {
    const raw = localStorage.getItem(CLOUD_CONFIG_STORAGE_KEY);
    if (!raw) return fallback;
    const saved = JSON.parse(raw);
    return {
      ...fallback,
      ...saved,
      driveProfiles: Array.isArray(saved.driveProfiles) ? saved.driveProfiles : []
    };
  } catch (_) {
    return fallback;
  }
}

export function saveCloudConfig(cfg) {
  try {
    localStorage.setItem(CLOUD_CONFIG_STORAGE_KEY, JSON.stringify(cfg));
  } catch (_) {}
}

export function getActiveDriveProfile(cfg) {
  if (!cfg || !Array.isArray(cfg.driveProfiles) || cfg.driveProfiles.length === 0) return null;
  return cfg.driveProfiles.find((p) => p.id === cfg.activeDriveProfileId) || cfg.driveProfiles[0];
}

export const WORKER_SCRIPT_TEMPLATE = `export default {
  async fetch(request) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range, Content-Type, Accept',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges'
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method Not Allowed', { status: 405, headers: cors });
    const url = new URL(request.url);
    if (!/^\\/([A-Za-z0-9_.-]+)\\/([A-Za-z0-9_.-]+)\\/releases\\/download\\/([^/]+)\\/(.+)$/.test(url.pathname)) {
      return new Response('SALO Worker activo', { status: 200, headers: cors });
    }
    const reqHeaders = new Headers({ 'User-Agent': 'SALO-Showroom-Worker/1.0' });
    if (request.headers.has('Range')) reqHeaders.set('Range', request.headers.get('Range'));
    const upstream = await fetch('https://github.com' + url.pathname, { method: request.method, headers: reqHeaders, redirect: 'follow' });
    const h = new Headers(upstream.headers);
    Object.entries(cors).forEach(([k, v]) => h.set(k, v));
    return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: h });
  }
};`;

export function generateRandomSecret() {
  const arr = new Uint8Array(12);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(arr);
  return 'SALO-' + [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function buildAppsScriptTemplate(secret = 'PEGA_AQUI_TU_CLAVE_SECRETA') {
  return `/**
 * SALO SHOWROOM — Google Apps Script (Visitas a Sheets / Excel + Respaldos en Drive)
 */
const SALO_UPLOAD_SECRET = '${secret || 'PEGA_AQUI_TU_CLAVE_SECRETA'}';
const SALO_SHEET_NAME = 'Visitas SALO Showroom';
const SALO_DRIVE_ROOT = 'SALO Showroom Archivos';

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function getEffectiveEmail_() {
  return Session.getEffectiveUser().getEmail() || Session.getActiveUser().getEmail() || '';
}
function getOrCreateRootFolder_() {
  var props = PropertiesService.getScriptProperties();
  var savedId = props.getProperty('SALO_ROOT_FOLDER_ID');
  if (savedId) { try { return DriveApp.getFolderById(savedId); } catch (_) {} }
  var iter = DriveApp.getFoldersByName(SALO_DRIVE_ROOT);
  var folder = iter.hasNext() ? iter.next() : DriveApp.createFolder(SALO_DRIVE_ROOT);
  props.setProperty('SALO_ROOT_FOLDER_ID', folder.getId());
  return folder;
}
function getOrCreateProjectFolder_(code) {
  var clean = String(code || 'GENERAL').toUpperCase().replace(/[^A-Z0-9_-]/g, '');
  var root = getOrCreateRootFolder_();
  var iter = root.getFoldersByName(clean);
  return iter.hasNext() ? iter.next() : root.createFolder(clean);
}
function getOrCreateVisitsSpreadsheet_() {
  var props = PropertiesService.getScriptProperties();
  var savedId = props.getProperty('SALO_VISITS_SHEET_ID');
  var ss = null;
  if (savedId) { try { ss = SpreadsheetApp.openById(savedId); } catch (_) {} }
  if (!ss) {
    var iter = DriveApp.getFilesByName(SALO_SHEET_NAME);
    ss = iter.hasNext() ? SpreadsheetApp.open(iter.next()) : SpreadsheetApp.create(SALO_SHEET_NAME);
    props.setProperty('SALO_VISITS_SHEET_ID', ss.getId());
  }
  var sheet = ss.getSheets()[0];
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['Fecha y Hora (Bolivia)', 'Código Proyecto', 'Edificio', 'Vista Inicial', 'Dispositivo', 'Pantalla', 'Idioma', 'Origen / Referrer', 'Sesión ID']);
    sheet.getRange(1, 1, 1, 9).setBackground('#0b0b10').setFontColor('#f5d77f').setFontWeight('bold');
    sheet.setFrozenRows(1);
  }
  return ss;
}
function verifySecret_(s) {
  return SALO_UPLOAD_SECRET !== 'PEGA_AQUI_TU_CLAVE_SECRETA' && String(s || '') === SALO_UPLOAD_SECRET;
}
function doGet(e) {
  var ss = getOrCreateVisitsSpreadsheet_();
  var folder = getOrCreateRootFolder_();
  return jsonOut_({ ok: true, email: getEffectiveEmail_(), sheetUrl: ss.getUrl(), folderUrl: folder.getUrl() });
}
function doPost(e) {
  try {
    var data = JSON.parse((e && e.postData && e.postData.contents) ? e.postData.contents : '{}');
    var action = data.action || 'visit';
    if (action === 'visit') {
      var ss = getOrCreateVisitsSpreadsheet_();
      var nowBo = Utilities.formatDate(new Date(), 'America/La_Paz', 'yyyy-MM-dd HH:mm:ss');
      ss.getSheets()[0].appendRow([nowBo, String(data.projectCode || 'PORTAL'), String(data.buildingName || ''), String(data.initialView || ''), String(data.device || ''), String(data.screen || ''), String(data.language || ''), String(data.referrer || 'Directo'), String(data.sessionId || '')]);
      return jsonOut_({ ok: true, sheetUrl: ss.getUrl() });
    }
    if (action === 'initDriveUpload') {
      if (!verifySecret_(data.uploadSecret)) return jsonOut_({ ok: false, error: 'Clave secreta inválida (403)' });
      var folder = getOrCreateProjectFolder_(data.projectCode);
      var token = ScriptApp.getOAuthToken();
      var resp = UrlFetchApp.fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name', {
        method: 'post', contentType: 'application/json',
        headers: { 'Authorization': 'Bearer ' + token, 'X-Upload-Content-Type': String(data.mimeType || 'application/octet-stream'), 'X-Upload-Content-Length': String(data.fileSize || 0) },
        payload: JSON.stringify({ name: String(data.fileName || 'archivo.bin'), parents: [folder.getId()] }),
        muteHttpExceptions: true
      });
      var h = resp.getAllHeaders();
      return jsonOut_({ ok: true, sessionUri: h['Location'] || h['location'], token: token, folderUrl: folder.getUrl() });
    }
    if (action === 'finishDriveUpload') {
      if (!verifySecret_(data.uploadSecret)) return jsonOut_({ ok: false, error: 'Clave secreta inválida (403)' });
      var file = DriveApp.getFileById(String(data.fileId));
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      return jsonOut_({ ok: true, fileId: file.getId(), webViewLink: file.getUrl(), directUrl: 'https://drive.google.com/uc?export=view&id=' + file.getId() });
    }
    return jsonOut_({ ok: false, error: 'Acción desconocida' });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  }
}`;
}

export async function testGitHubConnection(cfg, mockApiBase = '') {
  const resp = await fetch('./api/cloud/check-repo', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      owner: cfg.ghOwner,
      repo: cfg.ghRepo,
      token: cfg.ghToken,
      ghApiBase: mockApiBase || undefined
    })
  });
  return resp.json();
}

export async function testDriveProfile(profile) {
  if (!profile?.scriptUrl) return { ok: false, error: 'Ingresa la URL /exec del Apps Script' };
  const sep = profile.scriptUrl.includes('?') ? '&' : '?';
  const resp = await fetch(`${profile.scriptUrl}${sep}action=ping`, { method: 'GET', redirect: 'follow' });
  if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
  return resp.json();
}

export async function detectBigMediaWarnings(portalState, loadProjectStateByCode, getMediaBlob) {
  const warnings = [];
  for (const p of (portalState?.projects || []).filter((x) => x.published !== false)) {
    const pState = loadProjectStateByCode(p.code);
    if (!pState) continue;
    if (pState.customModel3D?.mediaKey) {
      const b = await getMediaBlob(pState.customModel3D.mediaKey);
      if (b && b.size > 150 * 1024 * 1024) {
        const mb = (b.size / (1024 * 1024)).toFixed(0);
        warnings.push(`${p.code}: El modelo "${pState.customModel3D.name}" pesa ${mb} MB (en celulares puede tardar varios minutos o cerrar la pestaña).`);
      }
    }
    for (const r of (pState.rooms360 || [])) {
      if (r.mediaKey) {
        const b = await getMediaBlob(r.mediaKey);
        if (b && b.size > 40 * 1024 * 1024) {
          warnings.push(`${p.code}: Panorama 360° "${r.name}" pesa ${(b.size / (1024 * 1024)).toFixed(0)} MB.`);
        }
      }
    }
  }
  return warnings;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = String(reader.result || '');
      const idx = res.indexOf(',');
      resolve(idx >= 0 ? res.slice(idx + 1) : res);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function uploadBlobToDriveViaRelay(profile, projectCode, fileName, blob, mimeType) {
  const r = await fetch('./api/cloud/drive-upload', {
    method: 'POST',
    headers: {
      'x-script-url': profile.scriptUrl,
      'x-upload-secret': profile.uploadSecret || '',
      'x-project-code': projectCode,
      'x-filename': fileName,
      'x-mime-type': mimeType || 'application/octet-stream',
      'content-type': mimeType || 'application/octet-stream'
    },
    body: blob
  });
  const data = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
  if (!r.ok || !data.ok) throw new Error(data.error || `Drive HTTP ${r.status}`);
  return data;
}

export async function publishShowroomOrchestrator({
  cfg,
  portalState,
  loadProjectStateByCode,
  getMediaBlob,
  onProgress,
  onLog,
  removeRemoteCodes = [],
  mockApiBase = '',
  mockUploadsBase = ''
}) {
  const publishedProjects = (portalState.projects || []).filter((p) => p && p.published !== false);
  const removeSet = new Set((removeRemoteCodes || []).map((c) => String(c || '').toUpperCase()).filter(Boolean));
  const activeDrive = getActiveDriveProfile(cfg);
  const warnings = [];
  const log = (msg) => { if (onLog) onLog(msg); };
  const prog = (pct, status) => { if (onProgress) onProgress(pct, status); };

  if (publishedProjects.length === 0 && removeSet.size === 0) {
    throw new Error('Marca al menos un proyecto para subir o actualizar en la web.');
  }
  if (!cfg.ghOwner || !cfg.ghRepo || !cfg.ghToken) {
    throw new Error('Configura tu Usuario, Repositorio y Token de GitHub en la pestaña "Cuentas y Drive".');
  }

  // Preflight check: verify local publishing relay server (server.mjs) is reachable before looping media
  try {
    const ping = await fetch('./api/cloud/app-files');
    if (!ping.ok) throw new Error(`HTTP ${ping.status}`);
  } catch (pingErr) {
    throw new Error('No se pudo conectar con el servidor local de publicación (server.mjs en 127.0.0.1:4173). Asegúrate de tener abierto Iniciar_Editor_SALO.bat y vuelve a intentar.');
  }

  prog(5, 'Consultando proyectos ya publicados en la web (modo incremental)…');
  let remotePortal = null;
  try {
    const rpResp = await fetch('./api/cloud/fetch-remote-portal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        owner: cfg.ghOwner,
        repo: cfg.ghRepo,
        branch: cfg.ghBranch || 'main',
        token: cfg.ghToken,
        ...(mockApiBase ? { ghApiBase: mockApiBase } : {})
      })
    });
    const rpJson = await rpResp.json().catch(() => ({}));
    if (rpResp.ok && rpJson.ok && rpJson.portal) {
      remotePortal = rpJson.portal;
      const keptCount = (remotePortal.projects || []).filter(
        (rp) => rp?.code && !publishedProjects.some((p) => p.code.toUpperCase() === rp.code.toUpperCase()) && !removeSet.has(rp.code.toUpperCase())
      ).length;
      if (keptCount > 0) {
        log(`♻️ Modo incremental: se conservarán intactos ${keptCount} proyecto(s) ya publicados sin volver a subirlos.`);
      }
    }
  } catch (_) {}

  log(`Proyectos a subir/actualizar en este envío: ${publishedProjects.map((p) => p.code).join(', ') || 'ninguno'}${removeSet.size > 0 ? ` · Retirar: ${[...removeSet].join(', ')}` : ''}.`);

  // Collect all unique media items across Portal & Published projects
  const assetUrlMap = new Map(); // mediaKey -> public URL
  const smallPagesFiles = [];
  const mediaQueue = [];

  for (const ex of (portalState.examplePhotos || [])) {
    if (ex && ex.type === 'folder') {
      if (ex.coverMediaKey) mediaQueue.push({ scope: 'PORTAL', key: ex.coverMediaKey, hint: `folder-cover-${ex.id}` });
      for (const it of (ex.items || [])) {
        if (it?.mediaKey) mediaQueue.push({ scope: 'PORTAL', key: it.mediaKey, hint: `folder-${ex.id}-${it.id}` });
      }
    } else if (ex?.mediaKey) {
      mediaQueue.push({ scope: 'PORTAL', key: ex.mediaKey, hint: `example-${ex.id}` });
    }
  }
  const loadedStates = new Map();
  for (const proj of publishedProjects) {
    if (proj.coverMediaKey) mediaQueue.push({ scope: proj.code, key: proj.coverMediaKey, hint: 'cover' });
    const pState = loadProjectStateByCode(proj.code);
    loadedStates.set(proj.code, pState);
    for (const item of collectProjectMediaKeys(pState)) {
      mediaQueue.push({ scope: proj.code, key: item.key, hint: item.hint });
    }
  }

  // Deduplicate by key
  const uniqueTasks = [];
  const seenKeys = new Set();
  for (const m of mediaQueue) {
    if (seenKeys.has(m.key)) continue;
    seenKeys.add(m.key);
    uniqueTasks.push(m);
  }

  const totalSteps = Math.max(1, uniqueTasks.length + 2);
  let doneSteps = 0;
  let releaseCount = 0;
  let pagesMediaCount = 0;
  let driveBackupCount = 0;

  for (const task of uniqueTasks) {
    const blob = await getMediaBlob(task.key);
    doneSteps++;
    if (!blob) continue;

    const ext = guessExtFromBlob(blob, task.hint);
    const rawKeyClean = String(task.key).replace(/[^a-zA-Z0-9_-]/g, '') || 'asset';
    let keyHash = 2166136261;
    for (let i = 0; i < rawKeyClean.length; i++) {
      keyHash ^= rawKeyClean.charCodeAt(i);
      keyHash = Math.imul(keyHash, 16777619) >>> 0;
    }
    const baseClean = rawKeyClean.length > 48
      ? `${rawKeyClean.slice(0, 38)}_${keyHash.toString(16).padStart(8, '0')}`
      : rawKeyClean;
    const fileName = baseClean.endsWith(ext) ? baseClean : `${baseClean}${ext}`;
    const sizeMb = (blob.size / (1024 * 1024)).toFixed(2);
    const isSmallWebFile = blob.size <= 3 * 1024 * 1024 && !/\.(glb|gltf|fbx|obj|mp4|webm)$/i.test(ext);
    const fitsGitHubRelease = blob.size <= 2 * 1024 * 1024 * 1024; // 2 GiB cap

    prog(Math.round((doneSteps / totalSteps) * 80) + 5, `Subiendo ${fileName} (${sizeMb} MB)…`);

    let placedInWeb = false;
    if (isSmallWebFile && cfg.uploadPages !== false) {
      const b64 = await blobToBase64(blob);
      const relPath = `media/${task.scope}/${fileName}`;
      smallPagesFiles.push({ path: relPath, encoding: 'base64', content: b64 });
      assetUrlMap.set(task.key, `./${relPath}`);
      placedInWeb = true;
      pagesMediaCount++;
      log(`✓ Pages (${sizeMb} MB): ${relPath}`);
    } else if (fitsGitHubRelease && cfg.uploadReleases !== false) {
      const tag = task.scope === 'PORTAL' ? 'portal-media' : `media-${task.scope}`;
      try {
        const relResp = await fetch('./api/cloud/publish-release-asset', {
          method: 'POST',
          headers: {
            'x-gh-owner': cfg.ghOwner,
            'x-gh-repo': cfg.ghRepo,
            'x-gh-token': cfg.ghToken,
            'x-gh-tag': tag,
            'x-asset-name': fileName,
            ...(mockApiBase ? { 'x-gh-api-base': mockApiBase } : {}),
            ...(mockUploadsBase ? { 'x-gh-uploads-base': mockUploadsBase } : {}),
            'content-type': blob.type || 'application/octet-stream'
          },
          body: blob
        });
        const relJson = await relResp.json().catch(() => ({ ok: false, error: `HTTP ${relResp.status}` }));
        if (!relResp.ok || !relJson.ok) throw new Error(relJson.error || `HTTP ${relResp.status}`);
        const publicUrl = formatReleaseAssetUrl(cfg.cfWorkerUrl, cfg.ghOwner, cfg.ghRepo, tag, fileName);
        assetUrlMap.set(task.key, publicUrl);
        placedInWeb = true;
        releaseCount++;
        log(`${relJson.skipped ? '↺ Sin cambios en Release' : '✓ Subido a Release'} (${sizeMb} MB): ${fileName}`);
      } catch (err) {
        log(`⚠️ No se pudo subir ${fileName} a Releases (${err.message}); intentando Drive como respaldo…`);
        warnings.push(`Release falló para ${fileName}: ${err.message}`);
      }
    }

    // Google Drive Backup (and automatic fallback if file couldn't go to web)
    if (cfg.backupToDrive !== false || !placedInWeb) {
      if (activeDrive?.scriptUrl && activeDrive?.uploadSecret) {
        try {
          const drv = await uploadBlobToDriveViaRelay(activeDrive, task.scope, fileName, blob, blob.type);
          driveBackupCount++;
          log(`☁️ Drive (${activeDrive.verifiedEmail || activeDrive.label}): ${fileName} respaldado.`);
          if (!placedInWeb) {
            assetUrlMap.set(task.key, drv.directUrl);
            placedInWeb = true;
            warnings.push(`${fileName} se enlazó desde Google Drive porque no pudo cargarse al hosting web.`);
          }
        } catch (drvErr) {
          const msg = `Drive respaldo falló para ${fileName}: ${drvErr.message}`;
          warnings.push(msg);
          log(`⚠️ ${msg} (la publicación web continúa).`);
        }
      } else if (!placedInWeb) {
        warnings.push(`${fileName} no pudo subirse porque falta configurar Google Drive / Apps Script.`);
      }
    }
  }

  // Generate sanitized JSONs (incremental merge: keep already-published remote projects untouched unless explicitly removed)
  prog(88, 'Fusionando proyectos con la web publicada (sin borrar proyectos previos)…');
  const visitsScriptUrl = activeDrive?.scriptUrl || '';
  const sanitizedPortal = sanitizePortalForPublish(portalState, assetUrlMap, visitsScriptUrl);

  if (remotePortal && Array.isArray(remotePortal.projects)) {
    const incomingCodes = new Set(sanitizedPortal.projects.map((p) => String(p.code || '').toUpperCase()));
    const preservedRemoteProjects = remotePortal.projects.filter((rp) => {
      const code = String(rp?.code || '').toUpperCase();
      return code && !incomingCodes.has(code) && !removeSet.has(code);
    });
    sanitizedPortal.projects = [...sanitizedPortal.projects, ...preservedRemoteProjects];
  }

  const extraFiles = [
    ...smallPagesFiles,
    { path: 'data/portal.json', content: JSON.stringify(sanitizedPortal, null, 2) }
  ];
  for (const proj of publishedProjects) {
    const cleanProj = sanitizeProjectForPublish(loadedStates.get(proj.code), assetUrlMap);
    extraFiles.push({ path: `data/projects/${proj.code}.json`, content: JSON.stringify(cleanProj, null, 2) });
  }

  // Only remove project JSONs & releases explicitly requested for removal from the web
  const deletePaths = [...removeSet].map((code) => `data/projects/${code}.json`);
  for (const code of removeSet) {
    await fetch('./api/cloud/delete-release', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        owner: cfg.ghOwner, repo: cfg.ghRepo, token: cfg.ghToken,
        tag: `media-${code}`,
        ...(mockApiBase ? { ghApiBase: mockApiBase } : {})
      })
    }).catch(() => {});
  }

  prog(94, 'Publicando commit final en GitHub Pages…');
  const cmtResp = await fetch('./api/cloud/commit-site', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      owner: cfg.ghOwner,
      repo: cfg.ghRepo,
      branch: cfg.ghBranch || 'main',
      token: cfg.ghToken,
      message: `SALO Showroom: publicar ${publishedProjects.map((p) => p.code).join(', ')}`,
      includeAppFiles: true,
      extraFiles,
      deletePaths,
      ...(mockApiBase ? { ghApiBase: mockApiBase } : {})
    })
  });
  const cmtJson = await cmtResp.json().catch(() => ({ ok: false, error: `HTTP ${cmtResp.status}` }));
  if (!cmtResp.ok || !cmtJson.ok) {
    throw new Error(cmtJson.error || 'No se pudo hacer commit en GitHub');
  }

  prog(100, '¡Publicación completada!');
  log(`🎉 Commit ${cmtJson.commitSha} listo (${cmtJson.uploadedBlobs} archivos nuevos, ${cmtJson.skippedBlobs} sin cambios).`);

  return {
    ok: true,
    pagesUrl: cmtJson.pagesUrl,
    commitSha: cmtJson.commitSha,
    stats: { publishedCount: publishedProjects.length, pagesMediaCount, releaseCount, driveBackupCount },
    warnings,
    sheetUrl: activeDrive?.sheetUrl || '',
    folderUrl: activeDrive?.folderUrl || ''
  };
}

export async function fetchPublishedPortal(basePath = './') {
  const url = `${basePath}data/portal.json?v=${Date.now()}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`No se encontró portal publicado (HTTP ${r.status})`);
  return normalizeAssetUrlsDeep(await r.json());
}

export async function fetchPublishedProject(code, publishVersion = '', basePath = './') {
  const cleanCode = String(code || '').toUpperCase();
  const v = publishVersion || Date.now();
  const r = await fetch(`${basePath}data/projects/${encodeURIComponent(cleanCode)}.json?v=${encodeURIComponent(v)}`);
  if (!r.ok) throw new Error(`Proyecto ${cleanCode} no disponible (${r.status})`);
  return normalizeAssetUrlsDeep(await r.json());
}

export function trackPublicVisitOnce({ visitsScriptUrl, projectCode, buildingName, initialView }) {
  if (!visitsScriptUrl) return;
  try {
    const key = 'salo_visit_logged_v8';
    if (sessionStorage.getItem(key)) return;
    let sid = sessionStorage.getItem('salo_session_id_v8');
    if (!sid) {
      sid = `v-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      sessionStorage.setItem('salo_session_id_v8', sid);
    }
    sessionStorage.setItem(key, '1');

    const ua = navigator.userAgent || '';
    const isMobile = /Mobi|Android|iPhone|iPad/i.test(ua);
    const payload = JSON.stringify({
      action: 'visit',
      projectCode: projectCode || 'PORTAL',
      buildingName: buildingName || 'SALO Portal',
      initialView: initialView || 'portal',
      device: isMobile ? 'Móvil / Tablet' : 'PC / Escritorio',
      screen: `${window.innerWidth}x${window.innerHeight}`,
      language: navigator.language || 'es',
      referrer: document.referrer || 'Directo',
      sessionId: sid
    });

    if (navigator.sendBeacon) {
      const blob = new Blob([payload], { type: 'text/plain;charset=utf-8' });
      if (navigator.sendBeacon(visitsScriptUrl, blob)) return;
    }
    fetch(visitsScriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: payload,
      keepalive: true
    }).catch(() => {});
  } catch (_) {}
}
