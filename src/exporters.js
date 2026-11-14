/**
 * exporters.js: high-resolution asset exporters & cross-app target lists for Pet Studio.
 *
 * - Pet Drawing (.png): 1024x1024 canvas via paintDrawing()
 * - Pet Melody (.wav): 16-bit stereo PCM WAV via renderPhraseToWav()
 * - 3D Pet (.glb): binary glTF 2.0 via GLTFExporter with MeshStandardMaterial + live face map
 */
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { paintDrawing } from './creation-render.js';
import { renderPhraseToWav } from './audio.js';
import { RF_APPS, sendToRfApp, triggerDownload } from './rf-bridge.js';

export const DRAWING_SEND_TARGETS = Object.freeze([
  { to: 'fotoe',      label: 'Fotoe',      role: '' },
  { to: 'soulcode',   label: 'Soulcode',   role: '' },
  { to: 'masque',     label: 'MASQUE',     role: 'mouth' },
  { to: 'flipbook',   label: 'Flipbook',   role: '' },
  { to: 'ripperclip', label: 'RipperClip', role: '' },
  { to: 'zaypen',     label: 'Zaypen',     role: '' },
  { to: 'littleloop', label: 'Littleloop', role: '' },
]);

export const MELODY_SEND_TARGETS = Object.freeze([
  { to: 'ripperclip', label: 'RipperClip', role: '' },
  { to: 'glyphnote',  label: 'Glyphnote',  role: '' },
  { to: 'flipbook',   label: 'Flipbook',   role: '' },
  { to: 'soulcode',   label: 'Soulcode',   role: '' },
  { to: 'littleloop', label: 'Littleloop', role: '' },
]);

export const PET_GLB_SEND_TARGETS = Object.freeze([
  { to: 'masque',   label: 'MASQUE',   role: 'avatar' },
  { to: 'soulcode', label: 'Soulcode', role: 'prop' },
]);

export function slugifyFileBase(name, fallback = 'pet-creation') {
  const clean = String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return clean || fallback;
}

/** Renders a Pet Studio stroke drawing onto a crisp 1024x1024 PNG Blob. */
export async function renderDrawingToPng(drawing, { size = 1024 } = {}) {
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  const ctx = cv.getContext('2d');
  paintDrawing(ctx, drawing, size);
  const blob = await new Promise((resolve, reject) => {
    if (cv.toBlob) {
      cv.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG export failed'))), 'image/png');
    } else {
      try {
        const dataUrl = cv.toDataURL('image/png');
        const bin = atob(dataUrl.split(',')[1] || '');
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        resolve(new Blob([bytes], { type: 'image/png' }));
      } catch (err) {
        reject(err);
      }
    }
  });
  return blob;
}

/**
 * Prepares a clean glTF-ready clone of `petModel.root` (strips outlines & sprites,
 * swaps MeshToonMaterial -> MeshStandardMaterial preserving color & live face map)
 * and exports a binary `.glb` Blob + ArrayBuffer.
 */
export function preparePetGlbRoot(petModel) {
  if (!petModel?.root) throw new Error('3D pet model is unavailable.');
  if (petModel.face) {
    petModel.face.draw();
    if (petModel.face.texture) petModel.face.texture.needsUpdate = true;
    petModel.face.dirty = false;
  }

  const clone = petModel.root.clone(true);
  clone.position.set(0, 0, 0);
  clone.rotation.set(0, 0, 0);
  clone.scale.setScalar(1);

  const toRemove = [];
  clone.traverse((obj) => {
    if (obj === clone) return;
    if (obj.userData?.isOutline || obj.isSprite || (typeof obj.name === 'string' && obj.name.endsWith(':outline'))) {
      toRemove.push(obj);
    }
  });
  for (const obj of toRemove) obj.removeFromParent();

  const tempMaterials = [];
  const convertMat = (src) => {
    if (!src) return new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.65, metalness: 0.04 });
    const std = new THREE.MeshStandardMaterial({
      name: src.name || '',
      color: src.color ? src.color.clone() : new THREE.Color('#ffffff'),
      map: src.map || null,
      transparent: !!src.transparent,
      opacity: src.opacity ?? 1,
      alphaTest: src.alphaTest ?? 0,
      side: src.side ?? THREE.FrontSide,
      roughness: 0.65,
      metalness: 0.04,
    });
    if (src.emissive && src.emissiveIntensity > 0) {
      std.emissive = src.emissive.clone();
      std.emissiveIntensity = src.emissiveIntensity;
    }
    tempMaterials.push(std);
    return std;
  };

  clone.traverse((obj) => {
    if (!obj.isMesh) return;
    if (Array.isArray(obj.material)) {
      obj.material = obj.material.map(convertMat);
    } else {
      obj.material = convertMat(obj.material);
    }
  });
  clone.updateMatrixWorld(true);
  return {
    root: clone,
    dispose() {
      for (const m of tempMaterials) m.dispose();
    },
  };
}

export async function exportPetToGlb(petModel) {
  const prepared = preparePetGlbRoot(petModel);
  try {
    const exporter = new GLTFExporter();
    const result = await exporter.parseAsync(prepared.root, { binary: true, onlyVisible: true });
    const bytes = result instanceof ArrayBuffer
      ? result
      : new TextEncoder().encode(JSON.stringify(result)).buffer;
    const blob = new Blob([bytes], { type: 'model/gltf-binary' });
    return { bytes, blob };
  } finally {
    prepared.dispose();
  }
}

export async function downloadDrawingPng(drawing, title = 'pet-drawing') {
  const blob = await renderDrawingToPng(drawing, { size: 1024 });
  const filename = `${slugifyFileBase(title, 'pet-drawing')}.png`;
  triggerDownload(blob, filename);
  return { filename, bytes: blob.size, blob };
}

export async function downloadPhraseWav(phrase, title = 'pet-melody', opts = {}) {
  const blob = await renderPhraseToWav(phrase, opts);
  const filename = `${slugifyFileBase(title, 'pet-melody')}.wav`;
  triggerDownload(blob, filename);
  return { filename, bytes: blob.size, blob };
}

export async function downloadPetGlb(petModel, petName = 'pet') {
  const { blob, bytes } = await exportPetToGlb(petModel);
  const filename = `${slugifyFileBase(petName, 'pet')}-3d.glb`;
  triggerDownload(blob, filename);
  return { filename, bytes: bytes.byteLength, blob };
}

/** Synchronously opens target app (inside click handler) and delivers drawing PNG. */
export function sendDrawingToApp(drawing, title, targetAppId, { role = '', onStatus } = {}) {
  const effectiveRole = role || (targetAppId === 'masque' ? 'mouth' : '');
  const filename = `${slugifyFileBase(title, 'pet-drawing')}.png`;
  return sendToRfApp({
    from: 'petstudio',
    to: targetAppId,
    kind: 'image',
    role: effectiveRole,
    onStatus,
    producePayload: async () => {
      const blob = await renderDrawingToPng(drawing, { size: 1024 });
      return { blob, name: filename, mime: 'image/png', meta: { title: String(title || 'Pet Drawing') } };
    },
  });
}

/** Synchronously opens target app (inside click handler) and delivers melody WAV. */
export function sendPhraseToApp(phrase, title, targetAppId, { duetSplit = null, onStatus } = {}) {
  const filename = `${slugifyFileBase(title, 'pet-melody')}.wav`;
  return sendToRfApp({
    from: 'petstudio',
    to: targetAppId,
    kind: 'audio',
    onStatus,
    producePayload: async () => {
      const blob = await renderPhraseToWav(phrase, { duetSplit });
      return { blob, name: filename, mime: 'audio/wav', meta: { title: String(title || 'Pet Melody'), tempo: phrase?.tempo ?? 110 } };
    },
  });
}

/** Synchronously opens target app (inside click handler) and delivers 3D pet GLB. */
export function sendPetGlbToApp(petModel, petName, targetAppId, { role = '', onStatus } = {}) {
  const effectiveRole = role || (targetAppId === 'masque' ? 'avatar' : targetAppId === 'soulcode' ? 'prop' : '');
  const filename = `${slugifyFileBase(petName, 'pet')}-3d.glb`;
  return sendToRfApp({
    from: 'petstudio',
    to: targetAppId,
    kind: 'model3d',
    role: effectiveRole,
    onStatus,
    producePayload: async () => {
      const { blob, bytes } = await exportPetToGlb(petModel);
      return {
        bytes,
        blob,
        name: filename,
        mime: 'model/gltf-binary',
        meta: { name: String(petName || 'Pet'), app: RF_APPS.petstudio.name },
      };
    },
  });
}
