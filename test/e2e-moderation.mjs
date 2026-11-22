// Moderación, límite de ritmo, bloqueo y copia de la conversación.
// Los mensajes "de una app modificada" se firman y publican desde Node,
// saltándose los filtros del remitente, para comprobar que el receptor se protege igual.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { Relay, useWebSocketImplementation } from 'nostr-tools/relay';
import { finalizeEvent } from 'nostr-tools/pure';
import * as nip44 from 'nostr-tools/nip44';
import { hexToBytes } from '@noble/hashes/utils.js';
useWebSocketImplementation(WebSocket);
const { chromium } = createRequire(import.meta.url)('playwright');

const RELAY = 'ws://localhost:7777';
const URL = `http://localhost:8080/?relays=${RELAY}`;
const PLATE = '7777 KLM';
const b = await chromium.launch();
const errors = [];
const dev = async (name) => {
  const c = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, acceptDownloads: true });
  const p = await c.newPage();
  p.on('pageerror', e => errors.push(`${name}: ${e.message}`));
  p.on('dialog', d => d.accept());
  await p.goto(URL); await p.waitForSelector('h1');
  return p;
};
const step = s => console.log('✓', s);
const peerBubbles = p => p.$$eval('.msg.peer .bubble', els => els.map(e => e.textContent.trim()));
const toast = async p => { await p.waitForSelector('.toast.error'); const t = await p.textContent('.toast.error'); await p.click('.toast.error'); return t; };

const A = await dev('A'), B = await dev('B');
await A.fill('form[data-action=claim] input', PLATE);
await A.click('form[data-action=claim] button');
await A.waitForSelector('.status.ok', { timeout: 15000 });
await B.fill('form[data-action=compose] input', PLATE);
await B.click('.presets button[value=blocking]');
await B.waitForSelector('.messages .msg.me');
await A.waitForSelector('.thread .dot', { timeout: 10000 });
await A.click('.thread');
await A.fill('form[data-action=text] input', 'Hola, ¿qué pasa?');
await A.click('form[data-action=text] button');
await B.waitForFunction(() => document.querySelectorAll('.msg.peer').length === 1, null, { timeout: 10000 });
step('conversación abierta entre A (titular) y B');

// 1) No se pueden enviar palabras prohibidas
await A.fill('form[data-action=text] input', 'eres un g1l1p0ll4s');
await A.click('form[data-action=text] button');
const t1 = await toast(A);
assert.match(t1, /lenguaje no permitido/);
assert.match(t1, /g\*{9}/);
assert.equal(await A.inputValue('form[data-action=text] input'), 'eres un g1l1p0ll4s');
await B.waitForTimeout(1200);
assert.equal((await peerBubbles(B)).length, 1);
step(`A no puede enviar un insulto disfrazado: «${t1.trim()}»`);

// Mensajes desde una "app modificada" con la clave de B
const bThread = await B.evaluate(() => { const t = Object.values(window.__mc.store.threads)[0]; return { sk: t.sk, peer: t.peer }; });
const relay = await Relay.connect(RELAY);
const base = Math.floor(Date.now() / 1000);
const sendAsB = (text, dt = 0) => relay.publish(finalizeEvent({
  kind: 7152, created_at: base + dt, tags: [['p', bThread.peer]],
  content: nip44.encrypt(JSON.stringify({ v: 1, type: 'text', text }), nip44.getConversationKey(hexToBytes(bThread.sk), bThread.peer)),
}, hexToBytes(bThread.sk)));

await sendAsB('eres un gilipollas');
await sendAsB('z0rra');
await sendAsB('sé dónde vives');
await A.waitForFunction(() => document.querySelectorAll('.msg.peer').length === 4, null, { timeout: 10000 });
let bubbles = await peerBubbles(A);
assert.ok(bubbles.includes('eres un g*********'), bubbles.join(' | '));
assert.ok(bubbles.some(t => t.startsWith('Mensaje ocultado')));
assert.ok(!bubbles.some(t => t.includes('zorra') || t.includes('z0rra')));
step('en destino, el insulto llega censurado y el mensaje grave oculto');
await A.click('[data-reveal]');
bubbles = await peerBubbles(A);
assert.ok(bubbles.includes('z****'), bubbles.join(' | '));
step('al pulsar «Ver», el mensaje grave se muestra censurado');
assert.equal(await A.$$eval('.threat', e => e.length), 1);
assert.match(await A.textContent('.threat'), /112/);
await A.screenshot({ path: 'shots/v2/15-moderacion.png' });
step('la amenaza muestra el aviso del 112');

// 2) Guardar copia (sin censura, con ids)
const [dl] = await Promise.all([A.waitForEvent('download'), A.click('.thread-actions [data-action=export]')]);
const file = '/tmp/claude-0/conversacion.txt';
await dl.saveAs(file);
const copy = readFileSync(file, 'utf8');
assert.match(copy, /eres un gilipollas/);
assert.match(copy, /sé dónde vives/);
assert.match(copy, /id del evento: [0-9a-f]{64}/);
step('la copia de la conversación guarda los mensajes originales y sus ids');

// 3) Bloqueo por parte del remitente (B bloquea al titular)
await B.click('.thread-actions [data-action=block]');
await B.waitForSelector('.hint.danger');
await A.click('[data-preset=onmyway]');
await A.waitForTimeout(1500);
assert.equal((await peerBubbles(B)).length, 1);
step('B bloquea la conversación y deja de recibir mensajes de A');

// 4) Bloqueo por parte del titular, y desbloqueo
await A.click('.thread-actions [data-action=block]');
await A.waitForSelector('.thread-actions [data-action=unblock]');
await sendAsB('¿hola?', 130);
await A.waitForTimeout(1500);
assert.equal((await peerBubbles(A)).length, 4);
const stored = await A.evaluate(() => window.__mc.store.blocked.length);
assert.equal(stored, 1);
step('A bloquea a B: su siguiente mensaje no aparece');
await A.click('.thread-actions [data-action=unblock]');
await sendAsB('perdona, ya muevo el coche', 135);
await A.waitForFunction(() => document.querySelectorAll('.msg.peer').length === 5, null, { timeout: 10000 });
step('A desbloquea y vuelve a recibir mensajes');

// 5) Límite de ritmo en destino: 7 mensajes del mismo minuto → solo entran 5
for (let i = 0; i < 7; i++) await sendAsB(`mensaje ${i}`, 200);
await A.waitForTimeout(2000);
assert.equal((await peerBubbles(A)).length, 10);
step('en destino solo se aceptan 5 mensajes por minuto del mismo remitente');

// 6) Límite de ritmo al enviar: A ya ha enviado 2; puede 3 más y el 6º se bloquea
for (let i = 0; i < 3; i++) { await A.click('[data-preset=thanks]'); await A.waitForTimeout(250); }
await A.waitForFunction(() => document.querySelectorAll('.msg.me').length === 5);
await A.click('[data-preset=thanks]');
const t6 = await toast(A);
assert.match(t6, /5 mensajes en el último minuto/);
step(`A no puede enviar un 6º mensaje en el mismo minuto: «${t6.trim()}»`);

relay.close();
assert.deepEqual(errors, []);
await b.close();
console.log('\nTodo correcto.');
