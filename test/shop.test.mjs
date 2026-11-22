import test from 'node:test';
import assert from 'node:assert/strict';
import { SHOP, activePacks, orderRef, parseOrderRef, checkoutUrl } from '../src/shop.js';
import { parseHash } from '../src/sticker.js';

test('sin enlaces configurados no hay packs activos', () => {
  assert.equal(activePacks().length, SHOP.packs.filter(p => p.url).length);
  assert.deepEqual(activePacks({ packs: [{ id: 'a', url: '' }] }), []);
});

test('solo se aceptan enlaces de pago de Stripe', () => {
  const shop = { packs: [
    { id: 'ok', url: 'https://buy.stripe.com/test_123' },
    { id: 'mal', url: 'https://buy.stripe.com.evil.example/x' },
    { id: 'http', url: 'http://buy.stripe.com/x' },
  ] };
  assert.deepEqual(activePacks(shop).map(p => p.id), ['ok']);
  assert.throws(() => checkoutUrl(shop.packs[1], 'X'));
});

test('código de pedido de ida y vuelta', () => {
  const ref = orderRef('1234BCD', 70, true);
  assert.equal(ref, '1234BCD-70-1-A0');
  assert.deepEqual(parseOrderRef(ref), { plate: '1234BCD', size: 70, showPlate: true, theme: 'a', headline: '0' });
  assert.deepEqual(parseOrderRef('1234bcd-50-0'), { plate: '1234BCD', size: 50, showPlate: false, theme: 'a', headline: '0' });
  assert.deepEqual(parseOrderRef(orderRef('1234BCD', 90, false, 'y', '2')), { plate: '1234BCD', size: 90, showPlate: false, theme: 'y', headline: '2' });
  assert.equal(parseOrderRef('1234BCD-70-1-Z9'), null);
  assert.equal(parseOrderRef('1234BCD-60-1'), null);
  assert.equal(parseOrderRef('<x>-70-1'), null);
});

test('checkoutUrl añade el código y el idioma', () => {
  const url = checkoutUrl({ url: 'https://buy.stripe.com/test_123' }, '1234BCD-70-1');
  assert.equal(url, 'https://buy.stripe.com/test_123?client_reference_id=1234BCD-70-1&locale=es');
});

test('rutas #pedido y #gracias', () => {
  assert.deepEqual(parseHash('#pedido=1234BCD-90-0'), { action: 'pedido', plate: '1234BCD', size: 90, showPlate: false, theme: 'a', headline: '0' });
  assert.deepEqual(parseHash('#pedido=1234BCD-50-1-R1'), { action: 'pedido', plate: '1234BCD', size: 50, showPlate: true, theme: 'r', headline: '1' });
  assert.equal(parseHash('#pedido=basura'), null);
  assert.deepEqual(parseHash('#gracias'), { action: 'gracias' });
});
