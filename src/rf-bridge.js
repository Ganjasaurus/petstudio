// RetroFleshed Universal Cross-App Bridge (rf-bridge v1.2)
// Hardened for iPadOS Safari / WebKit, Home Screen PWAs, and Cloudflare COOP/COEP Workers.

export const RF_APPS = {
  clai:       { id: 'clai',       name: 'CLAI',       url: 'https://clai.retrofleshed.com/',       accepts: ['clai', 'image'],                         desc: '3D clay studio' },
  masque:     { id: 'masque',     name: 'MASQUE',     url: 'https://masque.retrofleshed.com/',     accepts: ['model3d', 'clai', 'image'], coopRelay: true, desc: '3D face & VTuber studio' },
  fotoe:      { id: 'fotoe',      name: 'Fotoe',      url: 'https://fotoe.retrofleshed.com/',      accepts: ['image'],                                 desc: 'Photo editor' },
  soulcode:   { id: 'soulcode',   name: 'Soulcode',   url: 'https://soulcode.retrofleshed.com/',   accepts: ['image', 'model3d', 'clai', 'audio'],     desc: '2D/3D game maker' },
  ripperclip: { id: 'ripperclip', name: 'RipperClip', url: 'https://ripperclip.retrofleshed.com/', accepts: ['video', 'image', 'audio'],               desc: 'Video studio' },
  flipbook:   { id: 'flipbook',   name: 'Flipbook',   url: 'https://flipbook.retrofleshed.com/',   accepts: ['image', 'audio'],                        desc: 'Animation studio' },
  glyphnote:  { id: 'glyphnote',  name: 'Glyphnote',  url: 'https://glyphnote.retrofleshed.com/',  accepts: ['audio', 'json'],                         desc: 'Music loop toy' },
  zaypen:     { id: 'zaypen',     name: 'Zaypen',     url: 'https://zaypen.retrofleshed.com/',     accepts: ['image'],                                 desc: 'Kids drawing & piano pad' },
  generator:  { id: 'generator',  name: 'Generator',  url: 'https://generator.retrofleshed.com/',  accepts: ['model3d', 'image', 'json'],              desc: 'Procedural 3D worlds' },
  littleloop: { id: 'littleloop', name: 'Littleloop', url: 'https://littleloop.retrofleshed.com/', accepts: ['video', 'image', 'audio'],               desc: 'Family memories hub' },
  petstudio:  { id: 'petstudio',  name: 'Pet Studio', url: 'https://petstudio.retrofleshed.com/',  accepts: ['image', 'audio', 'json'],                desc: '3D creative pet studio' },
  lingrove:   { id: 'lingrove',   name: 'Lingrove',   url: 'https://lingrove.retrofleshed.com/',   accepts: ['audio', 'json', 'image'],                desc: 'Bilingual lesson studio' },
};

export const RF_HASH_MAX_BYTES = 768 * 1024; // 768 KB binary (~1.02 MB base64url)
export const RF_HASH_MAX_CHARS = 2 * 1024 * 1024; // 2M chars hard cap before decode

function getWin() {
  return typeof window !== 'undefined' ? window : undefined;
}

function getLoc(targetWin) {
  if (targetWin && targetWin.location) return targetWin.location;
  if (typeof location !== 'undefined') return location;
  const w = getWin();
  return w && w.location ? w.location : undefined;
}

export function isTrustedRfOrigin(origin) {
  if (!origin || typeof origin !== 'string') return false;
  const loc = getLoc();
  if (loc && loc.origin && origin === loc.origin) return true;
  return /^https:\/\/([a-z0-9-]+\.)?retrofleshed\.com$/i.test(origin) ||
         /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin);
}

export function openRfInboxDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('rf-bridge-inbox-v1', 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains('packets')) {
        req.result.createObjectStore('packets', { keyPath: 'token' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function readAndDeleteRfInbox(token) {
  if (!token || typeof indexedDB === 'undefined') return null;
  try {
    const db = await openRfInboxDb();
    return await new Promise((resolve) => {
      const tx = db.transaction('packets', 'readwrite');
      const store = tx.objectStore('packets');
      const getReq = store.get(token);
      let val = null;
      getReq.onsuccess = () => {
        val = getReq.result || null;
        if (val) store.delete(token);
      };
      tx.oncomplete = () => resolve(val);
      tx.onerror = () => resolve(val);
      getReq.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export function resolveRfAppUrl(targetAppId, sourceAppId, kind, role = '', token = '') {
  const entry = RF_APPS[targetAppId];
  if (!entry) throw new Error(`Unknown app: ${targetAppId}`);
  let base = entry.url;
  try {
    const w = getWin();
    const store = (typeof localStorage !== 'undefined' ? localStorage : undefined) || w?.localStorage;
    const map = JSON.parse(store?.getItem('rf_app_urls') || 'null');
    if (map && typeof map[targetAppId] === 'string' && map[targetAppId]) {
      base = map[targetAppId];
    }
  } catch {}
  const loc = getLoc();
  const u = new URL(base, loc && loc.href ? loc.href : 'https://retrofleshed.com/');
  if (entry.coopRelay) {
    u.pathname = u.pathname.replace(/\/index\.html$/i, '/').replace(/\/?$/, '/rf-relay.html');
  }
  u.searchParams.set('rf_import', '1');
  if (sourceAppId) u.searchParams.set('rf_from', sourceAppId);
  if (kind) u.searchParams.set('rf_kind', kind);
  if (role) u.searchParams.set('rf_role', role);
  if (token) u.searchParams.set('rf_token', token);
  return u.toString();
}

export function bytesToBase64Url(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(str) {
  if (typeof str !== 'string' || str.length > RF_HASH_MAX_CHARS) {
    throw new Error('Encoded bridge payload exceeds maximum hash size.');
  }
  const pad = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(pad + '==='.slice((pad.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out.buffer;
}

export function hasPendingRfImport(loc = getLoc()) {
  if (!loc) return false;
  const search = typeof loc.search === 'string' ? loc.search : '';
  const hash = typeof loc.hash === 'string' ? loc.hash : '';
  if (hash.includes('rf_b64=')) return true;
  if (!search) return false;
  const params = new URLSearchParams(search);
  return params.get('rf_import') === '1' || Boolean(params.get('rf_inbox')) || Boolean(params.get('rf_token'));
}

export function parseRfHashMeta(metaRaw) {
  if (!metaRaw || typeof metaRaw !== 'string' || metaRaw.length > 8192) return null;
  // URLSearchParams.get('rf_meta') already percent-decodes once; parse directly first so literal '%' in names/meta never throws URIError.
  try {
    const parsed = JSON.parse(metaRaw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    try {
      const parsed = JSON.parse(decodeURIComponent(metaRaw));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }
}

function buildDirectHashUrl(opts, token, safeName, mime, ab) {
  const header = encodeURIComponent(JSON.stringify({
    token,
    from: opts.from,
    to: opts.to,
    kind: opts.kind,
    role: opts.role || '',
    name: safeName,
    mime,
    meta: opts.meta || {},
  }));
  const b64 = bytesToBase64Url(ab);
  const baseDirect = resolveRfAppUrl(opts.to, opts.from, opts.kind, opts.role || '', token)
    .replace(/\/rf-relay(?:\.html)?\/?(\?|$)/, '/$1');
  return baseDirect + '#rf_meta=' + header + '&rf_b64=' + b64;
}

function navigateOrOpen(w, preWin, url) {
  if (preWin && typeof preWin.location?.replace === 'function') {
    try {
      preWin.location.replace(url);
      return preWin;
    } catch {}
  }
  try {
    return w?.open?.(url, '_blank') || preWin || null;
  } catch {
    return preWin || null;
  }
}

function showTapToOpenPrompt(w, url, appName, onStatus) {
  const doc = typeof document !== 'undefined' ? document : w?.document;
  if (!doc || typeof doc.createElement !== 'function' || !doc.body?.appendChild) return false;
  try {
    doc.getElementById('rf-bridge-open-prompt')?.remove?.();
    const bar = doc.createElement('div');
    bar.id = 'rf-bridge-open-prompt';
    bar.setAttribute('role', 'status');
    bar.style.cssText = 'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:2147483647;display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:999px;background:#141824;color:#fff;font:600 14px/1.2 system-ui,-apple-system,sans-serif;box-shadow:0 10px 28px rgba(0,0,0,.35)';
    const label = doc.createElement('span');
    label.textContent = `Ready for ${appName}`;
    const openBtn = doc.createElement('a');
    openBtn.href = url;
    openBtn.target = '_blank';
    openBtn.rel = 'noopener';
    openBtn.textContent = `Tap to open ${appName} →`;
    openBtn.style.cssText = 'padding:8px 14px;border-radius:999px;background:#38bdf8;color:#081018;text-decoration:none;font-weight:700';
    openBtn.onclick = () => {
      onStatus?.(`Sent to ${appName}!`);
      setTimeout(() => { try { bar.remove(); } catch {} }, 150);
    };
    const closeBtn = doc.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '✕';
    closeBtn.setAttribute('aria-label', 'Dismiss');
    closeBtn.style.cssText = 'border:0;background:transparent;color:#cbd5e1;font-size:15px;padding:4px 6px;cursor:pointer';
    closeBtn.onclick = () => { try { bar.remove(); } catch {} };
    bar.appendChild(label);
    bar.appendChild(openBtn);
    bar.appendChild(closeBtn);
    doc.body.appendChild(bar);
    const t = setTimeout(() => { try { bar.remove(); } catch {} }, 30000);
    t?.unref?.();
    return true;
  } catch {
    return false;
  }
}

export async function sendToRfApp(opts) {
  const w = getWin();
  const appName = RF_APPS[opts.to]?.name || opts.to;
  const token = 'rf_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now().toString(36);
  const targetUrl = resolveRfAppUrl(opts.to, opts.from, opts.kind, opts.role || '', token);
  const targetOrigin = new URL(targetUrl).origin;
  const isStandalonePwa = Boolean(w?.navigator && w.navigator.standalone === true);
  const isCoopIsolated = typeof crossOriginIsolated !== 'undefined' && Boolean(crossOriginIsolated);
  const isolatedSender = isCoopIsolated || isStandalonePwa;
  // Only apps with coopRelay: true (MASQUE) host a local /rf-relay.html outbox page.
  const hasLocalOutboxRelay = Boolean(RF_APPS[opts.from]?.coopRelay);

  let win = null;
  let childReady = false;
  let acked = false;
  let sendCount = 0;
  let retryTimer = null;
  let rescueTimer = null;
  let timeoutTimer = null;
  let message = null;
  let ab = null;
  let resolveHandshake = null;

  const cleanup = () => {
    w?.removeEventListener?.('message', onMessage);
    if (retryTimer) { clearInterval(retryTimer); retryTimer = null; }
    if (rescueTimer) { clearTimeout(rescueTimer); rescueTimer = null; }
    if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
  };

  const pushPayload = () => {
    if (acked || !win || !message || !ab) return;
    sendCount++;
    try {
      win.postMessage({ ...message, bytes: ab.slice(0) }, targetOrigin);
    } catch {}
  };

  const startPushing = () => {
    if (acked || !win || !message || !ab) return;
    if (rescueTimer) { clearTimeout(rescueTimer); rescueTimer = null; }
    pushPayload();
    if (!retryTimer) {
      retryTimer = setInterval(() => {
        if (acked || sendCount >= 6) {
          clearInterval(retryTimer);
          retryTimer = null;
        } else {
          pushPayload();
        }
      }, 900);
      retryTimer?.unref?.();
    }
  };

  const onMessage = (ev) => {
    if (!ev.data || typeof ev.data !== 'object') return;
    if (ev.origin !== targetOrigin || ev.source !== win) return;
    if (ev.data.type === 'rf:ready' && (!ev.data.token || ev.data.token === token)) {
      childReady = true;
      if (message && ab) startPushing();
    } else if (ev.data.type === 'rf:ack' && ev.data.token === token) {
      acked = true;
      cleanup();
      opts.onStatus?.(`Sent to ${appName}!`);
      resolveHandshake?.({ delivered: true, fallback: false });
    }
  };

  if (!isolatedSender) {
    w?.addEventListener?.('message', onMessage);
  }

  let preIsolatedWin = null;
  let wasAsyncPayload = false;
  let raw;
  try {
    if (!isolatedSender) {
      try {
        win = w?.open?.(targetUrl, '_blank') || null;
      } catch {
        win = null;
      }
      raw = await opts.producePayload();
    } else {
      const maybePromise = opts.producePayload();
      if (maybePromise && typeof maybePromise.then === 'function') {
        wasAsyncPayload = true;
        if (!isStandalonePwa && typeof navigator !== 'undefined' && typeof document !== 'undefined') {
          try {
            const candidate = w?.open?.('about:blank', '_blank') || null;
            if (candidate && typeof candidate.location?.replace === 'function') {
              preIsolatedWin = candidate;
            }
          } catch {}
        }
        raw = await maybePromise;
      } else {
        raw = maybePromise;
      }
    }
  } catch (err) {
    cleanup();
    try { win?.close?.(); preIsolatedWin?.close?.(); } catch {}
    throw err;
  }

  let blob;
  const mime = raw.mime || (raw.blob && raw.blob.type) || 'application/octet-stream';
  if (raw.bytes instanceof ArrayBuffer) {
    ab = raw.bytes;
    blob = raw.blob || new Blob([ab], { type: mime });
  } else if (ArrayBuffer.isView(raw.bytes)) {
    ab = raw.bytes.buffer.slice(raw.bytes.byteOffset, raw.bytes.byteOffset + raw.bytes.byteLength);
    blob = raw.blob || new Blob([ab], { type: mime });
  } else if (raw.blob instanceof Blob) {
    wasAsyncPayload = true;
    if (isolatedSender && !isStandalonePwa && !preIsolatedWin && typeof navigator !== 'undefined' && typeof document !== 'undefined') {
      try {
        const candidate = w?.open?.('about:blank', '_blank') || null;
        if (candidate && typeof candidate.location?.replace === 'function') {
          preIsolatedWin = candidate;
        }
      } catch {}
    }
    blob = raw.blob;
    ab = await raw.blob.arrayBuffer();
  } else {
    cleanup();
    try { win?.close?.(); preIsolatedWin?.close?.(); } catch {}
    throw new Error('producePayload must return blob or bytes');
  }
  const safeName = String(raw.name || 'asset').replace(/[^a-zA-Z0-9._ -]/g, '_');

  message = {
    type: 'rf:import',
    version: 1,
    token,
    from: opts.from,
    to: opts.to,
    kind: opts.kind,
    role: opts.role || '',
    name: safeName,
    mime,
    bytes: ab,
    meta: raw.meta || {},
  };

  try {
    if (typeof BroadcastChannel !== 'undefined') {
      const bc = new BroadcastChannel('retrofleshed-bridge-v1');
      bc.unref?.();
      bc.postMessage(message);
      const t = setTimeout(() => bc.close(), 2000);
      t?.unref?.();
    }
  } catch {}

  if (isolatedSender) {
    cleanup();
    if (ab.byteLength <= RF_HASH_MAX_BYTES) {
      const hashUrl = buildDirectHashUrl({ ...opts, meta: raw.meta }, token, safeName, mime, ab);
      const w2 = navigateOrOpen(w, preIsolatedWin, hashUrl);
      if (w2) {
        opts.onStatus?.(`Sent to ${appName}!`);
        return { delivered: true, fallback: false };
      }
      // If async rendering outlived Safari's transient activation on a standalone WebClip, show a fresh 1-tap open bar AND save backup
      if (wasAsyncPayload && showTapToOpenPrompt(w, hashUrl, appName, opts.onStatus)) {
        opts.onStatus?.(`Tap "Open ${appName}" above to finish sending!`);
        return { delivered: false, fallback: true };
      }
    }
    if (hasLocalOutboxRelay) {
      try {
        if (typeof indexedDB !== 'undefined') {
          const db = await openRfInboxDb();
          await new Promise((res, rej) => {
            const tx = db.transaction('packets', 'readwrite');
            tx.objectStore('packets').put({ ...message, targetUrl, savedAt: Date.now() });
            tx.oncomplete = () => res();
            tx.onerror = () => rej(tx.error);
          });
          const loc = getLoc();
          const relayOut = new URL('./rf-relay.html', loc?.href || 'https://retrofleshed.com/');
          relayOut.searchParams.set('rf_outbox', token);
          const wRelay = navigateOrOpen(w, preIsolatedWin, relayOut.toString());
          if (wRelay) {
            opts.onStatus?.(`Sending ${safeName} to ${appName}…`);
            return { delivered: true, fallback: false };
          }
          if (wasAsyncPayload && showTapToOpenPrompt(w, relayOut.toString(), appName, opts.onStatus)) {
            opts.onStatus?.(`Tap "Open ${appName}" above to finish sending!`);
            return { delivered: false, fallback: true };
          }
        }
      } catch {}
    }
    try { preIsolatedWin?.close?.(); } catch {}
    if (opts.onFallbackDownload) opts.onFallbackDownload(blob, safeName, 'isolated-large');
    else triggerDownload(blob, safeName);
    const fallbackAppUrl = RF_APPS[opts.to]?.url || targetUrl;
    const openedFallback = (() => { try { return w?.open?.(fallbackAppUrl, '_blank') || null; } catch { return null; } })();
    if (!openedFallback && wasAsyncPayload) {
      showTapToOpenPrompt(w, fallbackAppUrl, appName, opts.onStatus);
    }
    opts.onStatus?.(`Saved ${safeName} and opened ${appName} — drop it right in!`);
    return { delivered: false, fallback: true };
  }

  if (!win) {
    cleanup();
    if (opts.onFallbackDownload) opts.onFallbackDownload(blob, safeName, 'popup-blocked');
    else triggerDownload(blob, safeName);
    opts.onStatus?.(`Saved ${safeName} — open ${appName} and drop it in!`);
    return { delivered: false, fallback: true };
  }

  return new Promise((resolve) => {
    resolveHandshake = resolve;
    if (childReady) {
      startPushing();
    } else if (ab.byteLength <= RF_HASH_MAX_BYTES && typeof win.location?.replace === 'function') {
      rescueTimer = setTimeout(() => {
        if (!childReady && !acked && sendCount === 0 && win && !win.closed) {
          try {
            const hashUrl = buildDirectHashUrl({ ...opts, meta: raw.meta }, token, safeName, mime, ab);
            win.location.replace(hashUrl);
            cleanup();
            opts.onStatus?.(`Sent to ${appName}!`);
            resolve({ delivered: true, fallback: false });
          } catch {}
        }
      }, 1100);
      rescueTimer?.unref?.();
    }

    timeoutTimer = setTimeout(() => {
      if (!acked) {
        cleanup();
        if (opts.onFallbackDownload) opts.onFallbackDownload(blob, safeName, 'handshake-timeout');
        else triggerDownload(blob, safeName);
        opts.onStatus?.(`Saved ${safeName} — open ${appName} and drop it in!`);
        resolve({ delivered: false, fallback: true });
      }
    }, 25000);
    timeoutTimer?.unref?.();
  });
}

export function triggerDownload(blob, filename) {
  const doc = typeof document !== 'undefined' ? document : getWin()?.document;
  if (!doc) return;
  const url = URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = filename;
  doc.body.appendChild(a);
  a.click();
  a.remove();
  // 60s revoke window so iPadOS Safari's download confirmation dialog never hits a revoked blob: URL
  const t = setTimeout(() => URL.revokeObjectURL(url), 60000);
  t?.unref?.();
}

export function installRfImportReceiver({ appId, accepts, onImport, targetWindow }) {
  const w = targetWindow || getWin();
  const loc = getLoc(targetWindow);
  const seenTokens = new Set();
  const inflightTokens = new Set();
  let bc = null;

  const params = new URLSearchParams(loc && loc.search ? loc.search : '');
  const inboxToken = params.get('rf_inbox') || '';
  const expectedToken = params.get('rf_token') || '';
  const expectedFrom = params.get('rf_from') || '';
  const hasImportFlag = params.get('rf_import') === '1';

  const sendAck = (replySource, replyOrigin, tok) => {
    if (!replySource || !replyOrigin || replyOrigin === '*') return;
    try {
      replySource.postMessage({ type: 'rf:ack', token: tok, app: appId }, replyOrigin);
    } catch {}
  };

  const handlePacket = async (data, replySource, replyOrigin) => {
    if (!data || data.type !== 'rf:import') return;
    if (data.to && data.to !== appId) return;
    if (accepts && accepts.length && data.kind && !accepts.includes(data.kind)) return;
    const tok = typeof data.token === 'string' ? data.token : '';
    if (tok && seenTokens.has(tok)) {
      sendAck(replySource, replyOrigin, tok);
      return;
    }
    if (tok && inflightTokens.has(tok)) return;

    let ab = null;
    if (data.bytes instanceof ArrayBuffer) ab = data.bytes;
    else if (ArrayBuffer.isView(data.bytes)) ab = data.bytes.buffer.slice(data.bytes.byteOffset, data.bytes.byteLength + data.bytes.byteOffset);
    else if (data.blob instanceof Blob) ab = await data.blob.arrayBuffer();
    if (!ab || ab.byteLength === 0 || ab.byteLength > 210 * 1024 * 1024) return;

    if (tok) inflightTokens.add(tok);
    const safeName = String(data.name || 'imported-file').replace(/[^a-zA-Z0-9._ -]/g, '_');
    const mime = String(data.mime || 'application/octet-stream');
    const blob = new Blob([ab], { type: mime });
    const file = typeof File !== 'undefined' ? new File([blob], safeName, { type: mime }) : Object.assign(blob, { name: safeName });

    try {
      await onImport({
        file,
        blob,
        bytes: ab,
        name: safeName,
        mime,
        kind: String(data.kind || ''),
        role: String(data.role || ''),
        from: String(data.from || ''),
        meta: data.meta && typeof data.meta === 'object' ? data.meta : {},
      });
      if (tok) seenTokens.add(tok);
      sendAck(replySource, replyOrigin, tok);
    } finally {
      if (tok) inflightTokens.delete(tok);
    }
  };

  const onWindowMessage = (ev) => {
    if (!ev.data || ev.data.type !== 'rf:import') return;
    if (!isTrustedRfOrigin(ev.origin)) return;
    if (w && w.opener && ev.source && ev.source !== w.opener) return;
    if (expectedToken && ev.data.token && ev.data.token !== expectedToken) return;
    if (expectedFrom && ev.data.from && ev.data.from !== expectedFrom) return;
    void handlePacket(ev.data, ev.source, ev.origin);
  };

  w?.addEventListener?.('message', onWindowMessage);

  try {
    if (typeof BroadcastChannel !== 'undefined') {
      bc = new BroadcastChannel('retrofleshed-bridge-v1');
      bc.unref?.();
      bc.addEventListener('message', (ev) => {
        if (ev.data?.type === 'rf:import' && ev.data?.to === appId) {
          void handlePacket(ev.data, null, '');
        }
      });
    }
  } catch {
    bc = null;
  }

  if (inboxToken) {
    void readAndDeleteRfInbox(inboxToken).then((pkt) => {
      if (pkt) void handlePacket({ ...pkt, type: 'rf:import' }, null, '');
    });
  }

  if (loc && loc.hash && loc.hash.includes('rf_b64=')) {
    const rawHash = loc.hash.slice(1);
    // Clear hash from URL immediately before decoding/importing
    try {
      const hist = w?.history || (typeof history !== 'undefined' ? history : undefined);
      hist?.replaceState?.(hist.state, '', (loc.pathname || '/') + (loc.search || ''));
    } catch {}
    if (rawHash.length <= RF_HASH_MAX_CHARS + 4096) {
      try {
        const hp = new URLSearchParams(rawHash);
        const metaRaw = hp.get('rf_meta');
        const b64 = hp.get('rf_b64');
        if (metaRaw && b64 && metaRaw.length <= 8192 && b64.length <= RF_HASH_MAX_CHARS) {
          const meta = parseRfHashMeta(metaRaw);
          if (meta) {
            const bytes = base64UrlToBytes(b64);
            void handlePacket({ ...meta, type: 'rf:import', bytes }, null, '');
          }
        }
      } catch {}
    }
  }

  if (w && w.opener && (hasImportFlag || expectedToken)) {
    const announce = () => {
      if (expectedToken && seenTokens.has(expectedToken)) return;
      try {
        w.opener.postMessage({ type: 'rf:ready', app: appId, token: expectedToken }, '*');
      } catch {}
    };
    announce();
    setTimeout(announce, 250)?.unref?.();
    setTimeout(announce, 900)?.unref?.();
    setTimeout(announce, 2200)?.unref?.();
  }

  if ((hasImportFlag || inboxToken || expectedToken) && loc?.href) {
    try {
      const clean = new URL(loc.href);
      ['rf_import', 'rf_from', 'rf_kind', 'rf_role', 'rf_token', 'rf_inbox'].forEach((k) => clean.searchParams.delete(k));
      const keptHash = clean.hash && clean.hash.includes('rf_b64=') ? '' : clean.hash;
      const hist = w?.history || (typeof history !== 'undefined' ? history : undefined);
      hist?.replaceState?.(hist.state, '', clean.pathname + clean.search + keptHash);
    } catch {}
  }

  return () => {
    w?.removeEventListener?.('message', onWindowMessage);
    try { bc?.close?.(); } catch {}
  };
}

export function targetsForKind(kind, excludeAppId = '') {
  return Object.values(RF_APPS).filter((a) => a.id !== excludeAppId && a.accepts.includes(kind));
}
