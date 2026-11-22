// Tienda de pegatinas: oculta sin enlaces; con enlaces (de prueba), resumen del
// pedido, enlace a Stripe con el código de pedido, ruta #pedido y página #gracias.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const { chromium } = createRequire(import.meta.url)('playwright');

const URL = 'http://localhost:8080/?relays=ws://localhost:7777';
const b = await chromium.launch();
const errors = [];
const step = s => console.log('✓', s);
const shopWithLinks = readFileSync('dist/shop.js', 'utf8')
  .replace("{ id: 'p2', units: 2, price: '6,90 €', url: '' }", "{ id: 'p2', units: 2, price: '6,90 €', url: 'https://buy.stripe.com/test_p2' }")
  .replace("{ id: 'p4', units: 4, price: '9,90 €', url: '' }", "{ id: 'p4', units: 4, price: '9,90 €', url: 'https://buy.stripe.com/test_p4' }");
assert.ok(shopWithLinks.includes('test_p4'));

async function dev(links) {
  const c = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  if (links) await c.route('**/shop.js', r => r.fulfill({ body: shopWithLinks, contentType: 'application/javascript' }));
  await c.route('https://buy.stripe.com/**', r => r.fulfill({ body: '<h1>Stripe (simulado)</h1>', contentType: 'text/html' }));
  const p = await c.newPage();
  p.on('pageerror', e => errors.push(e.message));
  return p;
}

// 1) Sin enlaces configurados: no aparece
const P0 = await dev(false);
await P0.goto(URL + '#pegatina=4321FGH');
await P0.waitForSelector('.sticker-svg');
assert.equal(await P0.$('.shop'), null);
step('sin enlaces de pago configurados, la tienda no aparece');

// 2) Con enlaces
const P = await dev(true);
await P.goto(URL + '#pegatina=4321FGH');
await P.waitForSelector('.shop .pack');
assert.equal(await P.$$eval('.shop .pack', e => e.length), 2);
await P.screenshot({ path: 'shots/v2/16-tienda.png', fullPage: true });
step('con enlaces, aparecen los dos packs');

await P.selectOption('select[name=size]', '50');
await P.uncheck('input[name=showPlate]');
await P.click('[data-order=p4]');
await P.waitForSelector('.summary');
const summary = await P.textContent('.summary');
assert.match(summary, /4 de vinilo, 5 cm/);
assert.match(summary, /Matrícula impresa\s*No/);
assert.match(summary, /9,90 €/);
const href = await P.getAttribute('[data-action=order-go]', 'href');
assert.equal(href, 'https://buy.stripe.com/test_p4?client_reference_id=4321FGH-50-0&locale=es');
await P.screenshot({ path: 'shots/v2/17-confirmar-pedido.png', fullPage: true });
step(`el resumen refleja las opciones y el enlace lleva el código de pedido: ${href}`);

await P.click('[data-action=order-cancel]');
await P.waitForSelector('.shop .pack');
await P.click('[data-order=p2]');
const [popup] = await Promise.all([P.waitForEvent('popup'), P.click('[data-action=order-go]')]);
await popup.waitForLoadState();
assert.equal(popup.url(), 'https://buy.stripe.com/test_p2?client_reference_id=4321FGH-50-0&locale=es');
step('«Ir a pagar» abre Stripe en una pestaña nueva');

// 3) Ruta #pedido: la pegatina exacta del pedido, para imprimirla
const Q = await dev(false);
await Q.goto(URL + '#pedido=4321FGH-90-0');
await Q.waitForSelector('.sticker-svg');
assert.equal(await Q.inputValue('select[name=size]'), '90');
assert.equal(await Q.isChecked('input[name=showPlate]'), false);
assert.ok(!(await Q.innerHTML('.sticker-preview')).includes('4321 FGH'));
step('#pedido=4321FGH-90-0 abre la pegatina con esas opciones');

// 4) Página de gracias
await Q.goto(URL + '#gracias');
await Q.waitForSelector('.thanks');
assert.match(await Q.textContent('.thanks'), /Gracias por tu pedido/);
step('#gracias muestra el agradecimiento');

assert.deepEqual(errors, []);
await b.close();
console.log('\nTodo correcto.');
