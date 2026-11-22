// Prueba de punta a punta: 3 dispositivos (A titular, B remitente, C impostor)
// contra el relay local. Uso: npm run relay & (cd dist && python3 -m http.server 8080) & node test/e2e.mjs
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)('playwright');
import assert from 'node:assert/strict';

const URL = process.env.APP_URL || 'http://localhost:8080/?relays=ws://localhost:7777';
const PLATE = '1234 BCD';
const browser = await chromium.launch();
const errors = [];
async function device(name) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  page.on('dialog', d => d.accept());
  await page.goto(URL);
  await page.waitForSelector('h1');
  return page;
}
const step = s => console.log('✓', s);
const shot = (p, n) => p.screenshot({ path: `shots/${n}.png` });

const A = await device('A'), B = await device('B'), C = await device('C');

// 1. A registra su matrícula
await A.fill('form[data-action=claim] input', PLATE);
await A.click('form[data-action=claim] button');
await A.waitForSelector('.status.ok', { timeout: 15000 });
step('A registra 1234 BCD y está recibiendo');
await shot(A, '1-A-registrada');

// 2. B envía un aviso predefinido
await B.fill('form[data-action=compose] input', PLATE);
await B.click('.presets button[value=lights]');
await B.waitForSelector('.thread-head');
await A.waitForSelector('.thread .dot', { timeout: 10000 });
step('A recibe el aviso de B');

// 3. B no puede escribir texto libre hasta que A conteste
assert.ok(await B.isDisabled('form[data-action=text] input'));
step('B no puede escribir texto libre todavía');

// 3b. Aunque B modifique su app y envíe texto, el cliente de A lo descarta
await B.evaluate(() => { const t = Object.values(window.__mc.store.threads)[0]; t.peerReplied = true; });
await B.click('[data-preset=thanks]'); // fuerza un render
await B.waitForTimeout(300);
await B.fill('form[data-action=text] input', 'mensaje no permitido');
await B.click('form[data-action=text] button');
await B.waitForTimeout(1500);
await A.click('.thread');
await A.waitForSelector('.msg.peer');
const aTexts = await A.$$eval('.msg.peer .bubble', els => els.map(e => e.textContent));
assert.ok(!aTexts.some(t => t.includes('no permitido')), 'A no debe ver texto libre antes de contestar');
assert.ok(aTexts.some(t => t.includes('luces')));
step('el texto libre de un cliente modificado se descarta en A');
await B.evaluate(() => { const t = Object.values(window.__mc.store.threads)[0]; t.peerReplied = false; });

// 4. A contesta con texto; B lo recibe y ya puede escribir
await A.fill('form[data-action=text] input', 'Gracias, bajo ahora');
await A.click('form[data-action=text] button');
await B.waitForFunction(() => [...document.querySelectorAll('.msg.peer .bubble')].some(e => e.textContent.includes('bajo ahora')), null, { timeout: 10000 });
await B.waitForSelector('form[data-action=text] input:not([disabled])');
await B.fill('form[data-action=text] input', 'Perfecto, te espero');
await B.click('form[data-action=text] button');
await A.waitForFunction(() => [...document.querySelectorAll('.msg.peer .bubble')].some(e => e.textContent.includes('te espero')), null, { timeout: 10000 });
step('conversación libre tras la respuesta de A');
await shot(A, '2-A-conversacion');
await shot(B, '3-B-conversacion');

// 5. C reclama la misma matrícula: A queda expulsado
await C.fill('form[data-action=claim] input', PLATE);
await C.click('form[data-action=claim] button');
await C.waitForSelector('.status.ok', { timeout: 15000 });
await A.click('[data-action=back]');
await A.waitForSelector('.banner.danger', { timeout: 10000 });
step('C reclama la matrícula y A recibe el aviso de expulsión');
await shot(A, '4-A-expulsado');
assert.equal(await C.$$eval('.thread', e => e.length), 0);
step('C no ve ningún mensaje anterior');

// 6. B intenta seguir la conversación: se cierra
await B.click('[data-preset=thanks]');
await B.waitForSelector('.hint.danger', { timeout: 10000 });
step('la conversación de B se cierra porque el titular cambió de dispositivo');
await shot(B, '5-B-cerrada');

// 7. A recupera (cambio 2) y C vuelve a reclamar (cambio 3): matrícula en disputa
await A.click('[data-action=reclaim]');
await A.waitForSelector('.status.ok', { timeout: 15000 });
await C.waitForSelector('.banner.danger', { timeout: 10000 });
step('A recupera la matrícula');
await C.click('[data-action=reclaim]');
await C.waitForSelector('.banner.warn', { timeout: 15000 });
await A.waitForSelector('.banner.warn', { timeout: 10000 });
step('al tercer cambio en 24 h la matrícula queda en disputa en todos los dispositivos');
await shot(A, '6-A-disputa');

// 8. Escribir a una matrícula en disputa parece un envío normal, pero no le llega a nadie
await B.click('[data-action=back]');
const before = { A: await A.$$eval('.thread', t => t.length), C: await C.$$eval('.thread', t => t.length) };
await B.fill('form[data-action=compose] input', PLATE);
await B.click('.presets button[value=tyre]');
await B.waitForSelector('.messages .msg.me');
assert.equal(await B.$('.toast.error'), null);
await A.waitForTimeout(1500);
assert.equal(await A.$$eval('.thread', t => t.length), before.A);
assert.equal(await C.$$eval('.thread', t => t.length), before.C);
step('avisar a una matrícula en disputa parece normal, pero nadie lo recibe');

assert.deepEqual(errors, []);
await browser.close();
console.log('\nTodo correcto.');
