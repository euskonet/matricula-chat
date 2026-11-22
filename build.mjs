import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/vendor-entry.js'],
  bundle: true, format: 'esm', minify: true, target: 'es2022',
  outfile: 'dist/vendor.js', legalComments: 'eof',
});
for (const f of ['index.html', 'app.js', 'protocol.js', 'sticker.js', 'moderation.js', 'shop.js', 'style.css', 'manifest.webmanifest', 'icon.svg']) {
  await cp(`src/${f}`, `dist/${f}`);
}
console.log('dist/ listo');
