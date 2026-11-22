import test from 'node:test';
import assert from 'node:assert/strict';
import qrcode from 'qrcode-generator';
import { quickLink, parseHash, qrPath, stickerSvg, WEB_URL } from '../src/sticker.js';

test('quickLink pone la matrícula en el fragmento', () => {
  assert.equal(quickLink(WEB_URL, '1234BCD'), 'https://euskonet.github.io/matricula-chat/#avisar=1234BCD');
  assert.equal(quickLink('http://x/app/#algo', '1234BCD'), 'http://x/app/#avisar=1234BCD');
});

test('parseHash', () => {
  assert.deepEqual(parseHash('#avisar=1234BCD'), { action: 'avisar', plate: '1234BCD' });
  assert.deepEqual(parseHash('#avisar=1234-bcd'), { action: 'avisar', plate: '1234BCD' });
  assert.deepEqual(parseHash('#pegatina=1234BCD'), { action: 'pegatina', plate: '1234BCD' });
  assert.deepEqual(parseHash('#avisar=<script>'), { action: 'avisar', plate: 'SCRIPT' }); // solo quedan [A-Z0-9]
  assert.equal(parseHash('#avisar=AB'), null);
  assert.equal(parseHash(''), null);
  assert.equal(parseHash('#otra=1'), null);
});

test('qrPath genera un QR del tamaño esperado', () => {
  const { d, size } = qrPath(qrcode, quickLink(WEB_URL, '1234BCD'));
  assert.ok(size >= 21 && size <= 41, `tamaño ${size}`);
  assert.match(d, /^M\d+ \d+h\d+v1h-\d+z/);
});

test('stickerSvg: tamaño físico, matrícula opcional y escapado', () => {
  const url = quickLink(WEB_URL, '1234BCD');
  const svg = stickerSvg({ qrcode, url, plate: '1234BCD', widthMm: 50 });
  assert.match(svg, /width="50mm" height="65\.0mm"/);
  assert.match(svg, /1234 BCD/);
  const sinMatricula = stickerSvg({ qrcode, url, plate: '1234BCD', showPlate: false });
  assert.ok(!sinMatricula.includes('1234 BCD'));
  assert.ok(sinMatricula.includes('Matrícula Chat'));
});
