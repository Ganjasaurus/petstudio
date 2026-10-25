/**
 * look.mjs: quick screenshots of the built app at the three reference
 * viewports (development aid). Usage: node scripts/look.mjs [query] [outDir]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serveDir, launchBrowser } from './cdp-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const query = process.argv[2] ?? '?skipIntro=1&seed=look&mute=1';
const outDir = process.argv[3] ?? path.join(root, 'artifacts', 'look');
const DEVICES = [
  { name: 'phone-390x844', width: 390, height: 844, deviceScaleFactor: 2, mobile: true, touch: true },
  { name: 'tablet-768x1024', width: 768, height: 1024, deviceScaleFactor: 1, mobile: true, touch: true },
  { name: 'desktop-1440x900', width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, touch: false },
];

const server = await serveDir(path.join(root, 'dist'));
const browser = await launchBrowser();
try {
  for (const d of DEVICES) {
    const page = await browser.newPage(d);
    await page.goto(server.url + query, { readyExpr: 'window.__PET_STUDIO__ && window.__PET_STUDIO__.ready === true', timeout: 45000 });
    await page.sleep(2500);
    const file = await page.screenshot(path.join(outDir, `${d.name}.png`));
    const report = await page.eval('JSON.stringify(window.__PET_STUDIO__.layout())');
    console.log(d.name, file, '\n', report, '\n errors:', page.errors);
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
