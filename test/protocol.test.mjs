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
const belongs = ev => ev.tags.some(t => t[0] === 'x' && t[1] === TAG);
const resolve = (evs, now) => resolveClaims(evs, belongs, now, P);

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
  assert.equal(resolveClaims(evs, belongs, H, { ...PARAMS, claimPow: 16 }).status, 'held'); // id = 000...0
  const bad = { ...claim('B', 10), id: 'f'.repeat(64) };
  assert.equal(resolveClaims([...evs, bad], belongs, H, { ...PARAMS, claimPow: 16 }).holder, 'A');
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

import { sendWait, inboundAllowed } from '../src/protocol.js';

test('sendWait: 5 por minuto', () => {
  assert.equal(sendWait([], 1000), 0);
  assert.equal(sendWait([990, 991, 992, 993], 1000), 0);
  assert.equal(sendWait([990, 991, 992, 993, 994], 1000), 50);   // el 1º caduca a los 1050
  assert.equal(sendWait([900, 990, 991, 992, 993, 994], 1000), 50);
  assert.equal(sendWait([930, 931, 932, 933, 934], 1000), 0);    // ya pasó el minuto
});

test('inboundAllowed: ritmo por remitente', () => {
  const base = { replied: true, newThread: false };
  assert.ok(inboundAllowed({ ...base, times: [1, 2, 3, 4], t: 5 }));
  assert.ok(!inboundAllowed({ ...base, times: [1, 2, 3, 4, 5], t: 6 }));
  assert.ok(inboundAllowed({ ...base, times: [1, 2, 3, 4, 5], t: 100 }));
  // llegada desordenada: un mensaje "anterior" que cae en una ventana llena también se descarta
  assert.ok(!inboundAllowed({ ...base, times: [100, 101, 102, 103, 104], t: 50 }));
});

test('inboundAllowed: máximo de avisos sin respuesta', () => {
  const times = Array.from({ length: 10 }, (_, i) => i * 1000);
  assert.ok(!inboundAllowed({ times, t: 20000, replied: false, newThread: false }));
  assert.ok(inboundAllowed({ times, t: 20000, replied: true, newThread: false }));
});

test('inboundAllowed: conversaciones nuevas por matrícula', () => {
  const starts = Array.from({ length: 10 }, (_, i) => 1000 + i * 10);
  assert.ok(!inboundAllowed({ times: [], t: 1200, replied: false, newThread: true, threadStarts: starts }));
  assert.ok(inboundAllowed({ times: [], t: 5000, replied: false, newThread: true, threadStarts: starts }));
});

import { sha256 } from '@noble/hashes/sha2.js';
import { scrypt } from '@noble/hashes/scrypt.js';
import { bucketTag, proofInput, parseClaim, PLATE_KDF, BUCKET_BITS } from '../src/protocol.js';

test('bucketTag: determinista, 12 bits, distinto por matrícula', () => {
  const a = bucketTag(sha256, '1234BCD');
  assert.equal(a, bucketTag(sha256, '1234BCD'));
  assert.match(a, /^mc2-[0-9a-f]{3}$/);
  assert.equal(BUCKET_BITS, 12);
  const tags = new Set(Array.from({ length: 300 }, (_, i) => bucketTag(sha256, `${1000 + i}BCD`)));
  assert.ok(tags.size > 250, `pocas colisiones esperadas, hay ${tags.size} cubos distintos`);
});

test('prueba scrypt: solo coincide con la matrícula y la sal correctas', () => {
  const { N, r, p, dkLen } = PLATE_KDF;
  const salt = 'ab'.repeat(16);
  const proof = hex(scrypt(...proofInput('1234BCD', salt), { N, r, p, dkLen }));
  assert.equal(proof, hex(scrypt(...proofInput('1234BCD', salt), { N, r, p, dkLen })));
  assert.notEqual(proof, hex(scrypt(...proofInput('1234BCF', salt), { N, r, p, dkLen })));
  assert.notEqual(proof, hex(scrypt(...proofInput('1234BCD', 'cd'.repeat(16)), { N, r, p, dkLen })));
});

test('parseClaim', () => {
  const ok = { content: JSON.stringify({ v: 2, action: 'claim', s: 'a'.repeat(32), p: 'b'.repeat(64) }) };
  assert.deepEqual(parseClaim(ok), { action: 'claim', s: 'a'.repeat(32), p: 'b'.repeat(64) });
  assert.equal(parseClaim({ content: '{"action":"claim"}' }), null);          // formato v1
  assert.equal(parseClaim({ content: JSON.stringify({ v: 2, s: 'zz', p: 'b'.repeat(64) }) }), null);
  assert.equal(parseClaim({ content: 'no json' }), null);
});

function hex(b) { return Array.from(b, x => x.toString(16).padStart(2, '0')).join(''); }
