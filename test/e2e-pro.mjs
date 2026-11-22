// Pro: límite gratuito, varias matrículas, vincular un segundo dispositivo
// (los dos reciben y ven lo que contesta el otro), respuestas propias,
// cambio de clave y diseños de pegatina. En el navegador no hay Google Play:
// Pro se activa directamente en el almacenamiento local.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { PNG } from 'pngjs';
import jsQR from 'jsqr';
const { chromium } = createRequire(import.meta.url)('playwright');

const URL = 'http://localhost:8080/?relays=ws://localhost:7777';
const P1 = '2001BCD', P2 = '2002BCD', PF = '2003BCD';
const b = await chromium.launch();
const errors = [];
const dev = async (name, pro = false) => {
  const c = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  if (pro) await c.addInitScript(() => { if (!localStorage.getItem('mc:v1')) localStorage.setItem('mc:v1', '{"pro":true}'); });
  const p = await c.newPage();
  p.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  p.on('dialog', d => d.accept());
  await p.goto(URL); await p.waitForSelector('h1');
  return p;
};
const step = s => console.log('✓', s);
const home = async p => { while (await p.$('.thread-head [data-action=back]')) await p.click('.thread-head [data-action=back]'); await p.waitForSelector('h1'); };
const claim = async (p, plate) => {
  await home(p);
  await p.fill('form[data-action=claim] input', plate);
  await p.click('form[data-action=claim] button');
  await p.waitForFunction(pl => window.__mc.plateStatus(pl) === 'active', plate, { timeout: 20000 });
};
const send = async (p, plate, preset) => {
  await home(p);
  await p.fill('form[data-action=compose] input', plate);
  await p.click(`.presets button[value=${preset}]`);
  await p.waitForSelector('.messages .msg.me', { timeout: 20000 });
};
const threadsFor = (p, plate) => p.evaluate(pl => Object.values(window.__mc.store.threads).filter(t => t.role === 'holder' && t.plate === pl).length, plate);
const toast = async p => { await p.waitForSelector('.toast.error'); const t = await p.textContent('.toast.error'); await p.click('.toast.error'); return t; };

// 1) Versión gratuita: una matrícula
const F = await dev('F');
await claim(F, PF);
assert.equal(await F.$('form[data-action=claim]'), null);
assert.ok(await F.$('.upsell'));
assert.match(await F.textContent('[data-action=pair]'), /Pro/);
await F.click('.upsell');
await F.waitForSelector('.pro-card');
assert.match(await F.textContent('.pro-card'), /Disponible en la app de Android/);
step('gratis: una sola matrícula, con aviso de Pro para añadir más');

// 2) Pro: dos matrículas
const A = await dev('A', true);
await claim(A, P1);
await claim(A, P2);
assert.equal(await A.$$eval('.plate-card', e => e.length), 2);
await A.screenshot({ path: 'shots/v2/18-varias-matriculas.png', fullPage: true });
const B = await dev('B');
await send(B, P1, 'lights');
await send(B, P2, 'tyre');
await A.waitForFunction(() => Object.values(window.__mc.store.threads).filter(t => t.role === 'holder').length === 2, null, { timeout: 15000 });
assert.equal(await threadsFor(A, P1), 1);
assert.equal(await threadsFor(A, P2), 1);
step('Pro: dos matrículas en el mismo móvil, cada aviso a la suya');

// 3) Vincular un segundo dispositivo (gratuito) a P1
await home(A);
await A.click(`[data-action=pair][data-plate="${P1}"]`);
await A.click('[data-action=pair-show]');
await A.waitForSelector('.pair-qr svg');
await A.screenshot({ path: 'shots/v2/19-vincular.png', fullPage: true });
const code = await A.getAttribute('[data-action=pair-copy]', 'data-code');
assert.match(code, /^MCV1\./);
const png = PNG.sync.read(await A.locator('.pair-qr svg').screenshot());
assert.equal(jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data, code);
step(`el QR de vinculación se lee y contiene el código (${code.length} caracteres)`);
const A2 = await dev('A2');
await A2.click('[data-action=link]');
await A2.fill('form[data-action=link-code] textarea', code);
await A2.click('form[data-action=link-code] button');
await A2.waitForFunction(pl => window.__mc.plateStatus(pl) === 'active', P1, { timeout: 20000 });
assert.match(await A2.textContent('.plate-card'), /Vinculada/);
step('el segundo dispositivo se vincula pegando el código y queda activo');

const B2 = await dev('B2');
await send(B2, P1, 'blocking');
await A.waitForFunction(() => Object.values(window.__mc.store.threads).filter(t => t.role === 'holder').length === 3, null, { timeout: 15000 });
await A2.waitForFunction(() => Object.values(window.__mc.store.threads).filter(t => t.role === 'holder').length >= 1, null, { timeout: 15000 });
step('un aviso nuevo llega a los dos dispositivos');

// A contesta con texto: A2 lo ve como propio y ya acepta texto libre de B2
const b2key = await B2.evaluate(() => Object.values(window.__mc.store.threads)[0].myPub);
await home(A);
await A.click(`[data-open="in:${b2key}"]`);
await A.fill('form[data-action=text] input', 'Bajo ahora mismo');
await A.click('form[data-action=text] button');
await A2.waitForFunction(k => window.__mc.store.threads['in:' + k]?.messages.some(m => m.from === 'me' && m.text === 'Bajo ahora mismo'), b2key, { timeout: 15000 });
await B2.waitForSelector('form[data-action=text] input:not([disabled])', { timeout: 15000 });
await B2.fill('form[data-action=text] input', 'Genial, gracias');
await B2.click('form[data-action=text] button');
await A2.waitForFunction(k => window.__mc.store.threads['in:' + k]?.messages.some(m => m.from === 'peer' && m.text === 'Genial, gracias'), b2key, { timeout: 15000 });
step('lo que contesta un dispositivo aparece en el otro, que también recibe la conversación libre');

// 4) Respuestas propias
await home(A);
await A.click('[data-action=pro]');
await A.waitForSelector('form[data-action=reply-add]');
await A.fill('form[data-action=reply-add] input', 'eres un capullo');
await A.click('form[data-action=reply-add] button');
assert.match(await toast(A), /no permitido/);
await A.fill('form[data-action=reply-add] input', 'Llego en 5 minutos');
await A.click('form[data-action=reply-add] button');
await A.waitForFunction(() => window.__mc.store.replies.includes('Llego en 5 minutos'));
await A.screenshot({ path: 'shots/v2/20-pro.png', fullPage: true });
await home(A);
await A.click(`[data-open="in:${b2key}"]`);
await A.click('[data-reply="0"]');
await B2.waitForFunction(() => [...document.querySelectorAll('.msg.peer .bubble')].some(e => e.textContent.includes('Llego en 5 minutos')), null, { timeout: 15000 });
step('respuestas propias: se filtran al guardarlas y se envían con un toque');

// 5) Diseños de pegatina
await home(F);
await F.click(`[data-action=sticker][data-plate="${PF}"]`);
assert.ok(await F.isDisabled('select[name=theme]'));
await home(A);
await A.click(`[data-action=sticker][data-plate="${P2}"]`);
await A.selectOption('select[name=theme]', 'y');
await A.selectOption('select[name=headline]', '1');
const svg = await A.innerHTML('.sticker-preview');
assert.ok(svg.includes('#ffd400') && svg.includes('¿TE BLOQUEO?'));
await A.screenshot({ path: 'shots/v2/21-pegatina-amarilla.png' });
step('diseños: bloqueados en gratis, disponibles en Pro');

// 6) Cambiar clave: el dispositivo vinculado deja de recibir
await home(A);
await A.click(`[data-action=pair][data-plate="${P1}"]`);
await A.click('[data-action=rekey]');
await A.waitForSelector('.toast:not(.error)', { timeout: 20000 });
await A2.waitForFunction(pl => window.__mc.plateStatus(pl) === 'lost', P1, { timeout: 20000 });
await home(A);
assert.equal(await A.evaluate(pl => window.__mc.plateStatus(pl), P1), 'active');
step('«Cambiar clave» desvincula al otro dispositivo; este sigue activo');

assert.deepEqual(errors, []);
await b.close();
console.log('\nTodo correcto.');
