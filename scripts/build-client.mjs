// Bundle the browser app. `node scripts/build-client.mjs` -> public/app.js + public/app.css
// `node scripts/build-client.mjs --prototype out.html` -> single self contained HTML prototype
// (in-memory data seeded with the library, AAIF catalogue and LF examples; no server features).
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const proto = process.argv.indexOf('--prototype');

const result = await esbuild.build({
  entryPoints: [path.join(root, 'client/main.js')], bundle: true, format: 'esm', target: 'es2020', minify: true,
  outdir: path.join(root, proto > -1 ? 'build/proto' : 'public'), entryNames: 'app', loader: { '.woff2': 'file' },
  external: ['/assets/*'], logLevel: 'warning', metafile: true,
});
if (proto < 0) { console.log('Built public/app.js and public/app.css'); process.exit(0); }

// ---- prototype: one HTML file ---------------------------------------------
const out = process.argv[proto + 1] || path.join(root, 'build/anyday-quote-studio-prototype.html');
const js = fs.readFileSync(path.join(root, 'build/proto/app.js'), 'utf8');
const dataUri = (f, type) => `data:${type};base64,` + fs.readFileSync(path.join(root, f)).toString('base64');
const lorien = dataUri('public/assets/fonts/md-lorien-regular.woff2', 'font/woff2');
// Prototype: Inter comes from Google Fonts; MD Lorien is not on Google Fonts, so it is embedded.
let css = fs.readFileSync(path.join(root, 'build/proto/app.css'), 'utf8').replace(/@font-face\{[^}]*\}/g, '');
css = `@font-face{font-family:'MD Lorien';font-weight:400;font-style:normal;src:url(${lorien}) format('woff2');font-display:swap}` + css;
const logoWhite = dataUri('public/assets/anyday-logo-white.png', 'image/png');
const mark = dataUri('public/assets/anyday-mark.png', 'image/png');
const seed = {
  library: JSON.parse(fs.readFileSync(path.join(root, 'shared/library-default.json'), 'utf8')),
  catalogue: JSON.parse(fs.readFileSync(path.join(root, 'shared/aaif-catalogue.json'), 'utf8')),
  quotes: fs.readdirSync(path.join(root, 'seed/quotes')).map(f => JSON.parse(fs.readFileSync(path.join(root, 'seed/quotes', f), 'utf8'))),
};
const fonts = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap';
// Artifact page contract: no doctype/html/head/body of our own; title and styles first.
const page = `<title>Anyday Quote Studio</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="${fonts}">
<style>${css}</style>
<div id="app"><div style="padding:40px;font-family:Inter,system-ui,sans-serif">Loading Anyday Quote Studio…</div></div>
<script>window.__LOGO_WHITE__=${JSON.stringify(logoWhite)};window.__MARK_URL__=${JSON.stringify(mark)};window.__LORIEN__=${JSON.stringify(lorien)};window.__FONT_CSS__=${JSON.stringify(fonts)};window.__SEED__=${JSON.stringify(seed).replace(/</g, '\\u003c')};</script>
<script type="module">${js.replace(/<\/script/gi, '<\\/script')}</script>
`;
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, page);
console.log('Prototype written to', out, (page.length / 1024 / 1024).toFixed(2) + ' MB');
