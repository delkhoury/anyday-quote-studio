// PDF generation: headless Chromium prints the exact HTML used by the live preview.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const ASSET_HOST = 'https://proposal-assets.anyday.local';
let browserPromise = null;

function findChromium() {
  if (process.env.CHROMIUM_PATH && fs.existsSync(process.env.CHROMIUM_PATH)) return process.env.CHROMIUM_PATH;
  const roots = [process.env.PLAYWRIGHT_BROWSERS_PATH, '/ms-playwright', '/opt/pw-browsers', path.join(process.env.HOME || '', '.cache/ms-playwright')].filter(Boolean);
  for (const r of roots) {
    if (!fs.existsSync(r)) continue;
    for (const d of fs.readdirSync(r).filter(d => d.startsWith('chromium')).sort().reverse()) {
      for (const rel of ['chrome-linux/chrome', 'chrome-linux64/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-win/chrome.exe']) {
        const p = path.join(r, d, rel); if (fs.existsSync(p)) return p;
      }
    }
  }
  for (const p of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']) if (fs.existsSync(p)) return p;
  return null;
}

export function pdfAvailable() { return !!findChromium(); }

async function browser() {
  if (!browserPromise) {
    const executablePath = findChromium();
    if (!executablePath) throw Object.assign(new Error('Chromium not found. Run "npx playwright install chromium" or set CHROMIUM_PATH.'), { status: 503 });
    browserPromise = chromium.launch({ executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] }).catch(e => { browserPromise = null; throw e; });
  }
  return browserPromise;
}

export function markDataUri(publicDir) {
  // Anyday gem mark for the page footer; full resolution, scaled by CSS so it stays crisp
  return 'data:image/png;base64,' + fs.readFileSync(path.join(publicDir, 'assets/anyday-mark.png')).toString('base64');
}

export const PDF_ASSET_BASE = ASSET_HOST + '/assets';

// Render a proposal HTML document (built with assetBase = PDF_ASSET_BASE) to a PDF buffer.
export async function htmlToPdf(html, { publicDir }) {
  const b = await browser();
  const ctx = await b.newContext();
  try {
    const page = await ctx.newPage();
    await page.route('**/*', async route => {
      const url = route.request().url();
      if (url.startsWith(ASSET_HOST + '/')) {
        const rel = decodeURIComponent(url.slice(ASSET_HOST.length + 1)).replace(/\.\.+/g, '');
        const file = path.join(publicDir, rel);
        if (file.startsWith(publicDir) && fs.existsSync(file)) {
          const type = file.endsWith('.woff2') ? 'font/woff2' : file.endsWith('.png') ? 'image/png' : 'application/octet-stream';
          return route.fulfill({ status: 200, body: fs.readFileSync(file), headers: { 'content-type': type } });
        }
        return route.fulfill({ status: 404, body: '' });
      }
      if (url.startsWith('data:') || url === 'about:blank') return route.continue();
      return route.abort(); // proposals never load anything from the network
    });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    return await page.pdf({ printBackground: true, preferCSSPageSize: true });
  } finally {
    await ctx.close();
  }
}

export async function closeBrowser() { if (browserPromise) { const b = await browserPromise.catch(() => null); browserPromise = null; await b?.close(); } }
