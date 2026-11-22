// Protocolo v2: migración desde v1, matrículas que comparten cubo, envío
// neutro a matrículas sin registrar y lo que queda publicado en los relays.
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { generateSecretKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils.js';
const { chromium } = createRequire(import.meta.url)('playwright');

const RELAY = 'ws://localhost:7777';
const URL = `http://localhost:8080/?relays=${RELAY}`;
// 1003BCD y 1016BCD caen en el mismo cubo (mc2-794)
const P1 = '1003BCD', P2 = '1016BCD', NEW = '9999ZZZ', OLD = '5555HJK';

const b = await chromium.launch();
const errors = [];
const dev = async (name, init) => {
  const c = await b.newContext({ viewport: { width: 390, height: 844 } });
  if (init) await c.addInitScript(init);
  const p = await c.newPage();
  p.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  p.on('dialog', d => d.accept());
  await p.goto(URL); await p.waitForSelector('h1');
  return p;
};
const step = s => console.log('✓', s);
const claim = async (p, plate) => {
  await p.fill('form[data-action=claim] input', plate);
  await p.click('form[data-action=claim] button');
  await p.waitForSelector('.status.ok', { timeout: 20000 });
};
const send = async (p, plate, preset) => {
  if (await p.$('[data-action=back]')) await p.click('[data-action=back]');
  await p.fill('form[data-action=compose] input', plate);
  await p.click(`.presets button[value=${preset}]`);
  await p.waitForSelector('.messages .msg.me', { timeout: 20000 });
};
const allClaims = () => new Promise(res => {
  const ws = new WebSocket(RELAY), out = [];
  ws.on('open', () => ws.send(JSON.stringify(['REQ', 'x', { kinds: [7151] }])));
  ws.on('message', m => { const [t, , ev] = JSON.parse(m); if (t === 'EVENT') out.push(ev); else if (t === 'EOSE') { ws.close(); res(out); } });
});

// 1) Migración: un dispositivo con una matrícula guardada en formato v1
const oldSk = bytesToHex(generateSecretKey());
const v1Store = JSON.stringify({ plate: { plate: OLD, tag: 'a'.repeat(64), sk: oldSk }, threads: {}, seen: [] });
const M = await dev('M', `if (!localStorage.getItem('mc:v1')) localStorage.setItem('mc:v1', ${JSON.stringify(v1Store)});`);
await M.waitForSelector('.status.ok', { timeout: 20000 });
const mStore = await M.evaluate(() => window.__mc.store.plates[0]);
assert.equal(mStore.v, 2);
assert.equal(mStore.sk, oldSk);
step('una matrícula del formato anterior se migra sola, con la misma clave');

const B = await dev('B');
await send(B, OLD, 'lights');
await M.waitForSelector('.thread .dot', { timeout: 15000 });
step('y sigue recibiendo avisos');

// 2) Dos matrículas en el mismo cubo no se confunden
const A = await dev('A'), E = await dev('E');
await claim(A, P1);
await claim(E, P2);
await A.waitForTimeout(1500);
assert.ok(await A.$('.status.ok'), 'A no debe verse expulsado por otra matrícula de su cubo');
await send(B, P2, 'tyre');
await E.waitForSelector('.thread .dot', { timeout: 15000 });
assert.equal(await A.$$eval('.thread', t => t.length), 0);
step(`${P1} y ${P2} comparten cubo y cada una recibe solo lo suyo`);

// 3) Envío neutro a una matrícula sin registrar
await send(B, NEW, 'blocking');
assert.equal(await B.$('.toast.error'), null);
assert.ok((await B.textContent('.messages')).includes('bloqueando'));
assert.ok(await B.isDisabled('form[data-action=text] input'));
step('avisar a una matrícula sin registrar parece un envío normal');

const D = await dev('D');
await claim(D, NEW);
await B.click('[data-preset=thanks]');
await D.waitForSelector('.thread .dot', { timeout: 15000 });
await D.click('.thread');
assert.ok((await D.textContent('.messages')).includes('Gracias'));
assert.ok(!(await D.textContent('.messages')).includes('bloqueando'));
step('cuando esa matrícula se registra, el siguiente aviso de la conversación sí le llega');

// 4) Lo que se publica
const claims = await allClaims();
const v2 = claims.filter(ev => ev.tags.some(t => t[0] === 'x' && t[1].startsWith('mc2-')));
assert.ok(v2.length >= 4);
for (const ev of v2) {
  const x = ev.tags.find(t => t[0] === 'x')[1];
  assert.match(x, /^mc2-[0-9a-f]{3}$/);
  const c = JSON.parse(ev.content);
  assert.equal(c.v, 2); assert.match(c.s, /^[0-9a-f]{32}$/); assert.match(c.p, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(ev).includes('BCD') && !JSON.stringify(ev).includes('ZZZ'));
}
const salts = new Set(v2.map(ev => JSON.parse(ev.content).s));
assert.equal(salts.size, new Set(v2.map(ev => ev.pubkey)).size);
step(`en los relays solo hay cubos de 12 bits y pruebas con sal propia (${v2.length} reclamaciones)`);

assert.deepEqual(errors, []);
await b.close();
console.log('\nTodo correcto.');
