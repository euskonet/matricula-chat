import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveClaims, validateMessage, normalizePlate, isModernSpanishPlate,
  leadingZeroBits, KIND_CLAIM, PARAMS,
} from '../src/protocol.js';

const TAG = 'tag1';
const P = { ...PARAMS, claimPow: 0 };
let n = 0;
const claim = (pubkey, t, action = 'claim', tag = TAG) => ({
  id: (n++).toString(16).padStart(64, '0'), kind: KIND_CLAIM, pubkey,
  created_at: t, tags: [['x', tag]], content: JSON.stringify({ action }),
});
const H = 3600;
const resolve = (evs, now) => resolveClaims(evs, TAG, now, P);

test('normaliza y valida matrículas', () => {
  assert.equal(normalizePlate(' 1234-bcd '), '1234BCD');
  assert.ok(isModernSpanishPlate('1234BCD'));
  assert.ok(!isModernSpanishPlate('1234ABC')); // la A es vocal
});

test('leadingZeroBits', () => {
  assert.equal(leadingZeroBits('0000ff'), 16);
  assert.equal(leadingZeroBits('1f'), 3);
  assert.equal(leadingZeroBits('8'), 0);
});

test('sin reclamaciones está libre', () => {
  assert.equal(resolve([], 1000).status, 'free');
});

test('gana la última reclamación', () => {
  const r = resolve([claim('A', 1000), claim('B', 2000)], 3000);
  assert.equal(r.status, 'held');
  assert.equal(r.holder, 'B');
});

test('el orden de llegada no importa, solo created_at', () => {
  const r = resolve([claim('B', 2000), claim('A', 1000)], 3000);
  assert.equal(r.holder, 'B');
});

test('renovar con la misma clave no cuenta como cambio', () => {
  const r = resolve([claim('A', 0), claim('A', H), claim('A', 2 * H)], 3 * H);
  assert.equal(r.holder, 'A');
  assert.equal(r.since, 0);
  assert.equal(r.changes, 0);
});

test('ping-pong: 3 cambios en 24h congelan la matrícula', () => {
  const evs = [claim('A', 0), claim('B', H), claim('A', 2 * H), claim('B', 3 * H)];
  const r = resolve(evs, 4 * H);
  assert.equal(r.status, 'disputed');
  assert.equal(r.holder, null);
  assert.equal(r.frozenUntil, 3 * H + 24 * H);
});

test('durante la congelación se ignoran reclamaciones; después queda libre', () => {
  const evs = [claim('A', 0), claim('B', H), claim('A', 2 * H), claim('B', 3 * H), claim('C', 4 * H)];
  assert.equal(resolve(evs, 5 * H).status, 'disputed');
  assert.equal(resolve(evs, 28 * H).status, 'free');
  const r = resolve([...evs, claim('A', 30 * H)], 31 * H);
  assert.equal(r.holder, 'A');
  assert.equal(r.changes, 0);
});

test('cambios espaciados más de 24h no congelan', () => {
  const evs = [claim('A', 0), claim('B', 0.5 * H), claim('A', 25 * H), claim('B', 50 * H)];
  const r = resolve(evs, 51 * H);
  assert.equal(r.status, 'held');
  assert.equal(r.holder, 'B');
});

test('release del titular libera sin contar como cambio', () => {
  const r = resolve([claim('A', 0), claim('A', H, 'release')], 2 * H);
  assert.equal(r.status, 'free');
  const r2 = resolve([claim('A', 0), claim('A', H, 'release'), claim('B', 2 * H)], 3 * H);
  assert.equal(r2.holder, 'B');
  assert.equal(r2.changes, 0);
});

test('release de alguien que no es titular se ignora', () => {
  const r = resolve([claim('A', 0), claim('B', H, 'release')], 2 * H);
  assert.equal(r.holder, 'A');
});

test('se ignoran eventos fechados en el futuro', () => {
  const r = resolve([claim('A', 0), claim('B', 1000 * H)], H);
  assert.equal(r.holder, 'A');
});

test('se ignoran reclamaciones de otra matrícula', () => {
  const r = resolve([claim('A', 0), claim('B', H, 'claim', 'otra')], 2 * H);
  assert.equal(r.holder, 'A');
});

test('la reclamación caduca sin renovar', () => {
  assert.equal(resolve([claim('A', 0)], 31 * 24 * H).status, 'free');
  assert.equal(resolve([claim('A', 0), claim('A', 20 * 24 * H)], 31 * 24 * H).holder, 'A');
});

test('una reclamación caducada no cuenta como cambio al reclamarla otro', () => {
  const r = resolve([claim('A', 0), claim('B', 40 * 24 * H)], 40 * 24 * H + 1);
  assert.equal(r.holder, 'B');
  assert.equal(r.changes, 0);
});

test('se exige prueba de trabajo', () => {
  const evs = [claim('A', 0)];
  assert.equal(resolveClaims(evs, TAG, H, { ...PARAMS, claimPow: 16 }).status, 'held'); // id = 000...0
  const bad = { ...claim('B', 10), id: 'f'.repeat(64) };
  assert.equal(resolveClaims([...evs, bad], TAG, H, { ...PARAMS, claimPow: 16 }).holder, 'A');
});

test('validateMessage: presets siempre, texto solo si se permite', () => {
  assert.deepEqual(validateMessage({ v: 1, type: 'preset', preset: 'lights' }, { allowText: false }),
    { type: 'preset', preset: 'lights' });
  assert.equal(validateMessage({ v: 1, type: 'preset', preset: 'nope' }, { allowText: true }), null);
  assert.equal(validateMessage({ v: 1, type: 'text', text: 'hola' }, { allowText: false }), null);
  assert.deepEqual(validateMessage({ v: 1, type: 'text', text: ' hola ' }, { allowText: true }),
    { type: 'text', text: 'hola' });
  assert.equal(validateMessage({ v: 1, type: 'text', text: 'x'.repeat(900) }, { allowText: true }).text.length, 500);
  assert.equal(validateMessage({ v: 2, type: 'preset', preset: 'lights' }, { allowText: true }), null);
});
