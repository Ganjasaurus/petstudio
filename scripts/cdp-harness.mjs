/**
 * cdp-harness.mjs: dependency-free browser automation for UI verification.
 *
 * Serves dist/ with node:http, launches headless Microsoft Edge (or Chrome)
 * and drives it over the Chrome DevTools Protocol using Node's built-in
 * WebSocket: device emulation, real touch and mouse input, console capture
 * and screenshots. Development tooling only; nothing here ships in the app.
 */
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.map': 'application/json', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
};

/** Static file server for a directory; resolves to { url, close }. */
export function serveDir(dir) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let file = path.normalize(path.join(dir, decodeURIComponent(url.pathname)));
      if (!file.startsWith(path.normalize(dir))) throw new Error('outside root');
      if (url.pathname.endsWith('/')) file = path.join(file, 'index.html');
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ url: `http://127.0.0.1:${port}/`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

const BROWSER_CANDIDATES = [
  process.env.PETSTUDIO_BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/microsoft-edge', '/usr/bin/google-chrome', '/usr/bin/chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean);

export function findBrowser() {
  return BROWSER_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Launches a headless browser with a throwaway profile; resolves to a connected Browser. */
export async function launchBrowser({ executable = findBrowser(), extraArgs = [] } = {}) {
  if (!executable) throw new Error('No Edge/Chrome executable found (set PETSTUDIO_BROWSER).');
  const profile = await mkdtemp(path.join(tmpdir(), 'petstudio-cdp-'));
  const args = [
    '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-sync',
    '--disable-background-networking', '--hide-scrollbars', '--mute-audio',
    // Keep requestAnimationFrame running in every page: otherwise unfocused
    // headless pages are throttled and layout probes read stale frames.
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required',
    ...extraArgs, 'about:blank',
  ];
  const proc = spawn(executable, args, { stdio: 'ignore', windowsHide: true });
  const portFile = path.join(profile, 'DevToolsActivePort');
  let wsPath = null;
  for (let i = 0; i < 150 && !wsPath; i++) {
    await sleep(100);
    if (existsSync(portFile)) {
      const [port, p] = readFileSync(portFile, 'utf8').trim().split(/\r?\n/);
      if (port && p) wsPath = `ws://127.0.0.1:${port}${p}`;
    }
  }
  if (!wsPath) {
    proc.kill();
    throw new Error('Browser did not expose a DevTools endpoint.');
  }
  const conn = await CdpConnection.open(wsPath);
  return new Browser(conn, proc, profile);
}

class CdpConnection {
  static open(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(new CdpConnection(ws));
      ws.onerror = (e) => reject(new Error(`CDP socket error: ${e.message ?? e}`));
    });
  }

  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Set();
    ws.onmessage = (msg) => {
      const data = JSON.parse(typeof msg.data === 'string' ? msg.data : msg.data.toString());
      if (data.id && this.pending.has(data.id)) {
        const { resolve, reject, method } = this.pending.get(data.id);
        this.pending.delete(data.id);
        if (data.error) reject(new Error(`${method}: ${data.error.message}`));
        else resolve(data.result);
      } else if (data.method) {
        for (const fn of this.listeners) fn(data);
      }
    };
  }

  send(method, params = {}, sessionId) {
    const id = ++this.seq;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify(payload));
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

export class Browser {
  constructor(conn, proc, profile) {
    this.conn = conn;
    this.proc = proc;
    this.profile = profile;
  }

  /** Opens a fresh page (own browser context, so storage is isolated). */
  async newPage({ width, height, deviceScaleFactor = 1, mobile = false, touch = false } = {}) {
    const { browserContextId } = await this.conn.send('Target.createBrowserContext', { disposeOnDetach: true });
    const { targetId } = await this.conn.send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await this.conn.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(this.conn, sessionId, targetId, browserContextId, { width, height, deviceScaleFactor, mobile, touch });
    await page.init();
    return page;
  }

  async close() {
    try {
      await this.conn.send('Browser.close');
    } catch {
      /* ignore */
    }
    this.conn.close();
    await sleep(300);
    try {
      this.proc.kill();
    } catch {
      /* ignore */
    }
    await rm(this.profile, { recursive: true, force: true }).catch(() => {});
  }
}

export class Page {
  constructor(conn, sessionId, targetId, contextId, device) {
    this.conn = conn;
    this.sessionId = sessionId;
    this.targetId = targetId;
    this.contextId = contextId;
    this.device = device;
    this.console = [];
    this.errors = [];
    conn.listeners.add((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ');
        this.console.push({ type: msg.params.type, text });
        if (msg.params.type === 'error' || msg.params.type === 'assert') this.errors.push(`console.${msg.params.type}: ${text}`);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.errors.push(`exception: ${d.exception?.description ?? d.text}`);
      } else if (msg.method === 'Log.entryAdded') {
        const e = msg.params.entry;
        if (e.level === 'error') this.errors.push(`log.${e.source}: ${e.text} ${e.url ?? ''}`.trim());
      }
    });
  }

  send(method, params) {
    return this.conn.send(method, params, this.sessionId);
  }

  async init() {
    const d = this.device;
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Log.enable');
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: d.width, height: d.height, deviceScaleFactor: d.deviceScaleFactor, mobile: d.mobile,
      screenWidth: d.width, screenHeight: d.height,
    });
    if (d.touch) await this.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await this.send('Page.bringToFront').catch(() => {});
  }

  async goto(url, { readyExpr = null, timeout = 30000 } = {}) {
    const loaded = new Promise((resolve) => {
      const fn = (msg) => {
        if (msg.sessionId === this.sessionId && msg.method === 'Page.loadEventFired') {
          this.conn.listeners.delete(fn);
          resolve();
        }
      };
      this.conn.listeners.add(fn);
    });
    await this.send('Page.navigate', { url });
    await loaded;
    if (readyExpr) await this.waitFor(readyExpr, { timeout });
  }

  /** Evaluates an expression (or a function + args) in the page and returns its JSON value. */
  async eval(fnOrExpr, ...args) {
    const expression = typeof fnOrExpr === 'function'
      ? `(${fnOrExpr.toString()})(...${JSON.stringify(args)})`
      : fnOrExpr;
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (res.exceptionDetails) {
      throw new Error(`eval failed: ${res.exceptionDetails.exception?.description ?? res.exceptionDetails.text}`);
    }
    return res.result.value;
  }

  async waitFor(fnOrExpr, { timeout = 15000, interval = 100, args = [] } = {}) {
    const start = Date.now();
    let last = null;
    while (Date.now() - start < timeout) {
      try {
        last = await this.eval(fnOrExpr, ...args);
        if (last) return last;
      } catch (err) {
        last = err.message;
      }
      await sleep(interval);
    }
    throw new Error(`waitFor timed out after ${timeout} ms: ${typeof fnOrExpr === 'function' ? fnOrExpr.toString().slice(0, 120) : fnOrExpr} (last: ${JSON.stringify(last)})`);
  }

  sleep(ms) {
    return sleep(ms);
  }

  /** Centre of the first element matching `selector` that is visible, or null. */
  async center(selector) {
    return this.eval((sel) => {
      const nodes = [...document.querySelectorAll(sel)];
      for (const n of nodes) {
        const r = n.getBoundingClientRect();
        const cs = getComputedStyle(n);
        if (r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none') {
          return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
        }
      }
      return null;
    }, selector);
  }

  /** Real input: a touch tap on touch devices, a mouse click otherwise. */
  async tap(selectorOrPoint, { scroll = true } = {}) {
    let pt = selectorOrPoint;
    if (typeof selectorOrPoint === 'string') {
      if (scroll) {
        await this.eval((sel) => {
          const n = [...document.querySelectorAll(sel)].find((el) => el.getClientRects().length);
          n?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }, selectorOrPoint);
      }
      pt = await this.center(selectorOrPoint);
      if (!pt) throw new Error(`tap: no visible element for ${selectorOrPoint}`);
    }
    if (this.device.touch) {
      const tp = [{ x: pt.x, y: pt.y, radiusX: 4, radiusY: 4, force: 0.5, id: 1 }];
      await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp });
      await sleep(40);
      await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
      await sleep(30);
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    }
    await sleep(60);
    return pt;
  }

  /** Real drag gesture through a list of viewport points (touch or mouse). */
  async drag(points, { stepMs = 16 } = {}) {
    if (!points.length) return;
    const [first, ...rest] = points;
    if (this.device.touch) {
      await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: first.x, y: first.y, id: 1, force: 0.5 }] });
      for (const p of rest) {
        await sleep(stepMs);
        await this.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p.x, y: p.y, id: 1, force: 0.5 }] });
      }
      await sleep(stepMs);
      await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: first.x, y: first.y });
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: first.x, y: first.y, button: 'left', buttons: 1, clickCount: 1 });
      for (const p of rest) {
        await sleep(stepMs);
        await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'left', buttons: 1 });
      }
      const last = rest.at(-1) ?? first;
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: last.x, y: last.y, button: 'left', buttons: 0, clickCount: 1 });
    }
    await sleep(60);
  }

  async key(key, { code = key, text = key.length === 1 ? key : undefined } = {}) {
    const vk = { Enter: 13, Escape: 27, ' ': 32, Tab: 9 }[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
    const common = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await this.send('Input.dispatchKeyEvent', { type: key.length === 1 || key === 'Enter' ? 'keyDown' : 'rawKeyDown', ...common, text: key === 'Enter' ? '\r' : text });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
    await sleep(60);
  }

  async screenshot(file) {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' });
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, Buffer.from(data, 'base64'));
    return file;
  }

  async close() {
    try {
      await this.conn.send('Target.closeTarget', { targetId: this.targetId });
      await this.conn.send('Target.disposeBrowserContext', { browserContextId: this.contextId });
    } catch {
      /* ignore */
    }
  }
}
