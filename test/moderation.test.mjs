import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, checkOutgoing } from '../src/moderation.js';

const level = t => analyze(t).level;

test('texto normal: limpio', () => {
  for (const t of ['Gracias por avisar, bajo ahora', 'Perdona, no me había dado cuenta', 'Tienes la luz de freno fundida',
    'me voy a la playa', '¿Puedes mover el coche? Gracias 😊', 'Ok', '1234 BCD'])
    assert.equal(level(t), 'clean', t);
});

test('sin falsos positivos por palabras contenidas o parecidas', () => {
  for (const t of ['computadora', 'disputa', 'reputación', 'diputado', 'escupitajo', 'Pola de Siero', 'apolla', 'imputado',
    'se te ha escapado la perra', 'noto algo anormal en tu coche', 'voy retrasado, perdona', 'marisco', 'sudadera',
    'cabrero', 'putativo', 'follaje', 'tetera'])
    assert.equal(level(t), 'clean', t);
});

test('insultos', () => {
  for (const t of ['eres un gilipollas', 'cabrón', 'CABRONES', 'capulla', 'imbécil', 'vaya mierda', 'puto coche', 'hdp'])
    assert.equal(level(t), 'insult', t);
});

test('graves', () => {
  for (const t of ['zorra', 'maricón', 'sudaca', 'subnormal', 'enséñame las tetas', 'te voy a follar', 'moro de mierda'])
    assert.equal(level(t), 'severe', t);
});

test('trucos de evasión', () => {
  for (const t of ['g1l1p0ll4s', 'p u t a', 'p.u.t.a', 'p-u-t-a', 'putaaaaa', 'gilipolllas', 'puttaa', 'gili pollas',
    'eres un p*ta', 'ZoRrA', 'c4br0n', 'hijo puta', 'h1jo de put4', 'imbéciiiiil'])
    assert.notEqual(level(t), 'clean', t);
});

test('censura: primera letra y asteriscos, el resto intacto', () => {
  assert.equal(analyze('eres un gilipollas, vale?').masked, 'eres un g*********, vale?');
  assert.equal(analyze('HIJO DE PUTA!!').masked, 'H*** ** ****!!');
  assert.equal(analyze('😀 imbécil 😀').masked, '😀 i****** 😀');
  assert.equal(analyze('Gracias').masked, 'Gracias');
});

test('amenazas', () => {
  for (const t of ['te voy a matar', 'Te voy a partir la cara', 'sé dónde vives', 'Sé muy bien dónde vives',
    'te voy a rayar el coche', 'te pincho las ruedas', 'te estoy vigilando', 'vas a arrepentirte', 'te encontraré',
    'no sabes con quién te estás metiendo', 't3 v0y a m4t4r'])
    assert.ok(analyze(t).threat, t);
  for (const t of ['te voy a avisar si veo la grúa', 'voy a por el coche', 'te espero aquí, no tardo', 'cuidado con la rueda',
    'te voy a buscar el número del taller'])
    assert.ok(!analyze(t).threat, t);
});

test('checkOutgoing', () => {
  assert.deepEqual(checkOutgoing('Gracias'), { ok: true });
  const r = checkOutgoing('eres un capullo');
  assert.equal(r.ok, false);
  assert.equal(r.masked, 'eres un c******');
});
