// Prueba de punta a punta de las pegatinas: genera el PNG, lee el QR de la
// imagen, abre esa URL en otro dispositivo y envía un aviso al titular.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';
const { chromium } = createRequire(import.meta.url)('playwright');

const URL = process.env.APP_URL || 'http://localhost:8080/?relays=ws://localhost:7777';
const PLATE = '4321 FGH';
const b = await chromium.launch();
const errors = [];
const dev = async (name) => {
  const c = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, acceptDownloads: true });
  const p = await c.newPage();
  p.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  return p;
};
const step = s => console.log('✓', s);
const decode = file => {
  const png = PNG.sync.read(readFileSync(file));
  return jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data;
};

const A = await dev('A');
await A.goto(URL);
await A.fill('form[data-action=claim] input', PLATE);
await A.click('form[data-action=claim] button');
await A.waitForSelector('.status.ok', { timeout: 15000 });
await A.click('[data-action=sticker]');
await A.waitForSelector('.sticker-svg');
await A.screenshot({ path: 'shots/v2/12-pegatina.png' });
step('A abre el generador de pegatinas');

// Opciones: 9 cm sin matrícula → cambia la vista previa
await A.selectOption('select[name=size]', '90');
await A.uncheck('input[name=showPlate]');
assert.ok(!(await A.innerHTML('.sticker-preview')).includes('4321 FGH'));
await A.check('input[name=showPlate]');
assert.ok((await A.innerHTML('.sticker-preview')).includes('4321 FGH'));
step('las opciones de la pegatina actualizan la vista previa');

// PNG → leer el QR
const [dl] = await Promise.all([A.waitForEvent('download'), A.click('[data-action=sticker-png]')]);
const file = '/tmp/claude-0/pegatina.png';
await dl.saveAs(file);
const png = PNG.sync.read(readFileSync(file));
assert.equal(png.width, Math.round(90 / 25.4 * 300)); // 9 cm a 300 ppp
const url = decode(file);
assert.equal(url, URL + '#avisar=4321FGH');
step(`el QR del PNG (${png.width}×${png.height}) se lee y apunta a ${url}`);

// Hoja de impresión (A4)
await A.evaluate(() => { window.print = () => {}; });
await A.selectOption('select[name=size]', '70');
await A.selectOption('select[name=copies]', '6');
await A.click('[data-action=sticker-print]');
assert.equal(await A.$$eval('#print-sheet svg', s => s.length), 6);
await A.pdf({ path: 'shots/v2/hoja-a4.pdf', format: 'A4' });
step('la hoja de impresión lleva 6 pegatinas (PDF A4 generado)');

// B escanea: abre la URL del QR
const B = await dev('B');
await B.goto(url);
await B.waitForSelector('.quick');
assert.ok((await B.textContent('.quick .plate')).includes('4321 FGH'));
await B.screenshot({ path: 'shots/v2/13-aviso-rapido.png' });
await B.click('[data-quick=lights]');
await B.waitForSelector('.messages .msg.me');
assert.equal(new globalThis.URL(B.url()).hash, '');
step('B abre el enlace del QR y envía el aviso con un toque');

await A.click('[data-action=back]');
await A.waitForSelector('.thread .dot', { timeout: 10000 });
await A.click('.thread');
assert.ok((await A.textContent('.messages')).includes('luces encendidas'));
step('A recibe el aviso enviado desde la pegatina');

// El titular no puede avisarse a sí mismo desde su propia pegatina
await A.goto(url);
await A.waitForSelector('.quick');
await A.waitForTimeout(800);
await A.click('[data-quick=tyre]');
await A.waitForSelector('.toast.error');
assert.match(await A.textContent('.toast.error'), /propia matrícula/);
step('el titular no puede avisarse a sí mismo');

// Un enlace con basura no rompe nada
const C = await dev('C');
let dialogs = 0;
C.on('dialog', d => { dialogs++; d.dismiss(); });
await C.goto(URL + '#avisar=<img src=x onerror=alert(1)>');
await C.waitForSelector('h1');
await C.goto(URL + '#avisar=1234<b>BCD</b>');
await C.waitForSelector('.quick');
assert.ok((await C.textContent('.quick .plate')).includes('1234BBCDB'));
assert.equal(dialogs, 0);
step('un fragmento malicioso no rompe la app');

assert.deepEqual(errors, []);
await b.close();
console.log('\nTodo correcto.');
