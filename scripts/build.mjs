import { build } from 'esbuild';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';

await build({
  entryPoints: ['src/main.jsx'],
  outfile: 'public/js/cockpit.js',
  bundle: true,
  external: ['./app.js'],
  format: 'esm',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  target: ['es2020', 'safari15'],
  legalComments: 'linked',
});

const leaflet = 'node_modules/leaflet';
await mkdir('public/leaflet/images', { recursive: true });
async function copyText(source, destination) {
  const contents = await readFile(source, 'utf8');
  await writeFile(destination, contents.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, ''));
}

await Promise.all([
  copyText(`${leaflet}/dist/leaflet.css`, 'public/leaflet/leaflet.css'),
  copyText(`${leaflet}/LICENSE`, 'public/leaflet/LICENSE'),
  ...(await readdir(`${leaflet}/dist/images`)).map((file) =>
    copyFile(`${leaflet}/dist/images/${file}`, `public/leaflet/images/${file}`)),
]);
