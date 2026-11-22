import test from 'node:test';
import assert from 'node:assert/strict';
import qrcode from 'qrcode-generator';
import { PRO, encodePairing, decodePairing, validateReply } from '../src/pro.js';
import { stickerSvg, THEMES, HEADLINES } from '../src/sticker.js';

const plateObj = { plate: '1234BCD', sk: 'a'.repeat(64), salt: 'b'.repeat(32) };

test('código de vinculación de ida y vuelta', () => {
  const code = encodePairing(plateObj, 1000);
  assert.match(code, /^MCV1\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodePairing(code), { ...plateObj, t: 1000 });
  assert.deepEqual(decodePairing(encodePairing({ ...plateObj, proof: 'c'.repeat(64) }, 1000)), { ...plateObj, t: 1000 }); // la prueba no viaja
  assert.deepEqual(decodePairing('  ' + code + '\n'), { ...plateObj, t: 1000 });
});

test('códigos de vinculación inválidos', () => {
  assert.equal(decodePairing(''), null);
  assert.equal(decodePairing('hola'), null);
  assert.equal(decodePairing('MCV1.@@@'), null);
  assert.equal(decodePairing(encodePairing({ ...plateObj, sk: 'zz' })), null);
  assert.equal(decodePairing(encodePairing({ ...plateObj, plate: '<b>' })), null);
});

test('respuestas propias', () => {
  assert.deepEqual(validateReply('  Llego en   5 minutos '), { ok: true, text: 'Llego en 5 minutos' });
  assert.equal(validateReply('').ok, false);
  assert.equal(validateReply('x'.repeat(81)).ok, false);
  assert.match(validateReply('eres un capullo').error, /no permitido/);
  assert.match(validateReply('Gracias', ['gracias']).error, /Ya tienes/);
  assert.match(validateReply('Otra', Array(PRO.maxReplies).fill('a')).error, /Máximo/);
});

test('diseños de pegatina', () => {
  const base = { qrcode, url: 'https://x/#avisar=1234BCD', plate: '1234BCD' };
  const def = stickerSvg(base);
  assert.ok(def.includes('#0b3d91') && def.includes('¿PASA ALGO CON'));
  const y = stickerSvg({ ...base, theme: 'y', headline: '1', showPlate: false });
  assert.ok(y.includes('#ffd400') && y.includes('¿TE BLOQUEO?') && y.includes('AVÍSAME'));
  assert.ok(y.includes('fill="#111"'));                 // texto oscuro sobre amarillo
  assert.ok(stickerSvg({ ...base, theme: 'zz' }).includes('#0b3d91')); // desconocido → por defecto
  assert.equal(THEMES[0].id, 'a'); assert.equal(HEADLINES[0].id, '0');
});
