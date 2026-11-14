import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  RF_APPS,
  isTrustedRfOrigin,
  resolveRfAppUrl,
  base64UrlToBytes,
  sendToRfApp,
  installRfImportReceiver,
} from '../src/rf-bridge.js';
import { renderPhraseToWav } from '../src/audio.js';
import {
  DRAWING_SEND_TARGETS,
  MELODY_SEND_TARGETS,
  PET_GLB_SEND_TARGETS,
  preparePetGlbRoot,
} from '../src/exporters.js';

describe('rf-bridge v1 & Pet Studio asset exporters', () => {
  it('validates RF_APPS target lists and MASQUE coopRelay URL resolution', () => {
    assert.deepEqual(
      DRAWING_SEND_TARGETS.map((t) => t.to),
      ['fotoe', 'soulcode', 'masque', 'flipbook', 'ripperclip', 'zaypen', 'littleloop'],
    );
    assert.equal(DRAWING_SEND_TARGETS.find((t) => t.to === 'masque')?.role, 'mouth');
    assert.deepEqual(
      MELODY_SEND_TARGETS.map((t) => t.to),
      ['ripperclip', 'glyphnote', 'flipbook', 'soulcode', 'littleloop'],
    );
    assert.deepEqual(
      PET_GLB_SEND_TARGETS,
      [
        { to: 'masque', label: 'MASQUE', role: 'avatar' },
        { to: 'soulcode', label: 'Soulcode', role: 'prop' },
      ],
    );
    assert.equal(isTrustedRfOrigin('https://masque.retrofleshed.com'), true);
    assert.equal(isTrustedRfOrigin('http://127.0.0.1:4188'), true);
    assert.equal(isTrustedRfOrigin('https://evil.example.com'), false);

    const masqueUrl = new URL(resolveRfAppUrl('masque', 'petstudio', 'model3d', 'avatar', 'rf_tok1'));
    assert.equal(masqueUrl.pathname, '/rf-relay.html');
    assert.equal(masqueUrl.searchParams.get('rf_import'), '1');
    assert.equal(masqueUrl.searchParams.get('rf_from'), 'petstudio');
    assert.equal(masqueUrl.searchParams.get('rf_kind'), 'model3d');
    assert.equal(masqueUrl.searchParams.get('rf_role'), 'avatar');
    assert.equal(masqueUrl.searchParams.get('rf_token'), 'rf_tok1');
    assert.equal(RF_APPS.petstudio.accepts.includes('json'), true);
  });

  it('opens window synchronously before producePayload resolves and completes rf:ack handshake', async () => {
    const prevWin = globalThis.window;
    const prevLoc = globalThis.location;
    const prevHist = globalThis.history;
    const listeners = new Map();
    const events = [];
    let openedWin = null;

    globalThis.location = new URL('http://localhost:4188/?view=wall');
    globalThis.history = { state: null, replaceState: () => {} };
    globalThis.window = {
      location: globalThis.location,
      opener: null,
      addEventListener(type, fn) {
        if (!listeners.has(type)) listeners.set(type, new Set());
        listeners.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        listeners.get(type)?.delete(fn);
      },
      open(url, target) {
        events.push(`open:${target}:${new URL(url).hostname}`);
        openedWin = {
          postMessage(msg, targetOrigin) {
          assert.equal(targetOrigin, 'https://soulcode.retrofleshed.com');
            events.push(`post:${msg.type}:${msg.kind}:${msg.role}`);
            for (const fn of listeners.get('message') ?? []) {
              fn({
                origin: 'https://soulcode.retrofleshed.com',
                source: openedWin,
                data: { type: 'rf:ack', token: msg.token, app: 'soulcode' },
              });
            }
          },
        };
        setTimeout(() => {
          for (const fn of listeners.get('message') ?? []) {
            const postsBefore = events.filter(v => v.startsWith('post:')).length;
            fn({ origin: 'https://attacker.invalid', source: openedWin, data: { type: 'rf:ready' } });
            fn({ origin: 'https://soulcode.retrofleshed.com', source: {}, data: { type: 'rf:ready' } });
            assert.equal(events.filter(v => v.startsWith('post:')).length, postsBefore);
            fn({
              origin: 'https://soulcode.retrofleshed.com',
              source: openedWin,
              data: { type: 'rf:ready', app: 'soulcode' },
            });
          }
        }, 15);
        return openedWin;
      },
    };

    try {
      const promise = sendToRfApp({
        from: 'petstudio',
        to: 'soulcode',
        kind: 'model3d',
        role: 'prop',
        producePayload: async () => {
          events.push('produce');
          await new Promise((r) => setTimeout(r, 5));
          return { bytes: new Uint8Array([0x67, 0x6c, 0x54, 0x46]).buffer, name: 'mochi-3d.glb', mime: 'model/gltf-binary' };
        },
      });
      assert.equal(events[0], 'open:_blank:soulcode.retrofleshed.com');
      const res = await promise;
      assert.deepEqual(res, { delivered: true, fallback: false });
      assert.ok(events.includes('post:rf:import:model3d:prop'));

      // Verify hash #rf_b64 receiver path too
      const received = [];
      const rawBytes = new Uint8Array([123, 34, 111, 107, 34, 58, 49, 125]);
      const b64 = Buffer.from(rawBytes).toString('base64url');
      assert.deepEqual(new Uint8Array(base64UrlToBytes(b64)), rawBytes);
      const meta = encodeURIComponent(JSON.stringify({
        token: 'rf_hash_1',
        from: 'masque',
        to: 'petstudio',
        kind: 'image',
        role: '',
        name: 'avatar-snap.png',
        mime: 'image/png',
      }));
      globalThis.location = new URL(`http://localhost:4188/#rf_meta=${meta}&rf_b64=${b64}`);
      globalThis.window.location = globalThis.location;
      installRfImportReceiver({
        appId: 'petstudio',
        accepts: ['image', 'audio', 'json'],
        onImport: (pkt) => received.push(pkt),
      });
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(received.length, 1);
      assert.equal(received[0].kind, 'image');
      assert.equal(received[0].name, 'avatar-snap.png');
    } finally {
      globalThis.window = prevWin;
      globalThis.location = prevLoc;
      globalThis.history = prevHist;
    }
  });

  it('renders Pet Studio melodies (including duet xylophone + drums) to 16-bit PCM RIFF WAV', async () => {
    const phrase = {
      tempo: 120,
      beats: 8,
      notes: [
        { beat: 0, midi: 60, dur: 0.5, vel: 0.85 },
        { beat: 1, midi: 64, dur: 0.5, vel: 0.8 },
        { beat: 4, midi: 67, dur: 1.0, vel: 0.9 },
      ],
      hits: [
        { beat: 0, midi: 36, vel: 0.9 },
        { beat: 2, midi: 39, vel: 0.8 },
        { beat: 3, midi: 42, vel: 0.75 },
        { beat: 4, midi: 76, vel: 0.8 },
      ],
    };
    const blob = await renderPhraseToWav(phrase, { duetSplit: 4, sampleRate: 22050 });
    assert.equal(blob.type, 'audio/wav');
    const ab = await blob.arrayBuffer();
    assert.ok(ab.byteLength > 44 + 22050 * 4, 'WAV contains multi-second stereo 16-bit PCM payload');
    const dv = new DataView(ab);
    const ascii = (off, len) => String.fromCharCode(...new Uint8Array(ab, off, len));
    assert.equal(ascii(0, 4), 'RIFF');
    assert.equal(ascii(8, 4), 'WAVE');
    assert.equal(ascii(12, 4), 'fmt ');
    assert.equal(dv.getUint16(20, true), 1); // PCM
    assert.equal(dv.getUint16(22, true), 2); // stereo
    assert.equal(dv.getUint32(24, true), 22050);
    assert.equal(dv.getUint16(34, true), 16); // 16-bit
    assert.equal(ascii(36, 4), 'data');

    const samples = new Int16Array(ab, 44);
    let peak = 0;
    for (let i = 0; i < samples.length; i++) {
      const a = Math.abs(samples[i]);
      if (a > peak) peak = a;
    }
    assert.ok(peak > 1500, `expected audible PCM signal, got peak=${peak}`);
  });

  it('prepares 3D pet clone for GLB export by stripping outlines/sprites and converting MeshToonMaterial to MeshStandardMaterial with face map', () => {
    const root = new THREE.Group();
    root.position.set(2.5, 0.3, -1.2);
    const faceTex = new THREE.DataTexture(new Uint8Array([255, 180, 200, 255]), 1, 1);
    const bodyMat = new THREE.MeshToonMaterial({ color: '#ffb8c9' });
    const faceMat = new THREE.MeshBasicMaterial({ map: faceTex, transparent: true });
    const outlineMat = new THREE.MeshBasicMaterial({ color: '#3b2434', side: THREE.BackSide });

    const body = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 8), bodyMat);
    body.name = 'body';
    const outline = new THREE.Mesh(new THREE.SphereGeometry(0.52, 8, 8), outlineMat);
    outline.name = 'body:outline';
    outline.userData.isOutline = true;
    body.add(outline);

    const faceMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.4), faceMat);
    faceMesh.name = 'face';
    const bubble = new THREE.Sprite();
    bubble.name = 'thought-bubble';

    root.add(body, faceMesh, bubble);

    let faceDrawn = false;
    const fakePetModel = {
      root,
      face: {
        dirty: true,
        texture: faceTex,
        draw() {
          faceDrawn = true;
        },
      },
    };

    const prepared = preparePetGlbRoot(fakePetModel);
    try {
      assert.equal(faceDrawn, true);
      assert.deepEqual(prepared.root.position.toArray(), [0, 0, 0]);
      const names = [];
      let foundFaceStd = null;
      let foundBodyStd = null;
      prepared.root.traverse((obj) => {
        if (obj !== prepared.root) names.push(obj.name);
        assert.ok(!obj.userData?.isOutline, 'outline meshes must be stripped');
        assert.ok(!obj.isSprite, 'sprites must be stripped');
        if (obj.isMesh) {
          assert.ok(obj.material.isMeshStandardMaterial, `expected MeshStandardMaterial on ${obj.name}`);
          if (obj.name === 'face') foundFaceStd = obj.material;
          if (obj.name === 'body') foundBodyStd = obj.material;
        }
      });
      assert.deepEqual(names.sort(), ['body', 'face']);
      assert.equal(foundFaceStd.map, faceTex);
      assert.equal(foundFaceStd.transparent, true);
      assert.equal(foundBodyStd.color.getHexString(), new THREE.Color('#ffb8c9').getHexString());
    } finally {
      prepared.dispose();
    }
  });
});
