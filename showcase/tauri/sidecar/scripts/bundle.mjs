// Bundles the sidekick brain into dist/ so the app ships one JS file instead of node_modules.
// Cross-platform (Node, no shell): `npm run build` in this folder runs this. Optional voice deps stay external (never loaded).
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const WEB_EXT = ['@huggingface/transformers', 'ogg-opus-decoder', '@mozilla/readability', 'turndown', 'turndown-plugin-gfm', 'unpdf'];

function bundle(entry, outfile, externals) {
  return build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile,
    external: externals,
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    logLevel: 'warning',
  });
}

fs.rmSync('dist', { recursive: true, force: true });
fs.mkdirSync('dist/node_modules', { recursive: true });
await bundle('sidekick.mjs', 'dist/sidekick.mjs', WEB_EXT);
await bundle('agentrun.mjs', 'dist/agentrun.mjs', ['@huggingface/transformers', 'ogg-opus-decoder']);

// The readers and their dependencies, laid out as npm installed them (a nested copy travels with its parent).
// One that's missing only costs web_fetch its Markdown: it falls back to plain text.
const names = ['linkedom', '@mozilla/readability', 'turndown', 'turndown-plugin-gfm', 'unpdf'];
const done = new Set();
function copy(name, from) {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const src = path.join(dir, 'node_modules', name);
    if (fs.existsSync(path.join(src, 'package.json'))) {
      if (dir !== process.cwd() || done.has(name)) return; // nested ones travel with their parent
      done.add(name);
      fs.cpSync(src, path.join('dist/node_modules', name), { recursive: true, dereference: true });
      const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
      for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) copy(dep, src);
      return;
    }
    if (dir === process.cwd()) return console.error(`bundle: ${name} isn't installed; web_fetch will read pages as plain text`);
  }
}
for (const name of names) copy(name, process.cwd());

// The recorded beats (beats/make.mjs): the audio and its index, not the script.
fs.mkdirSync('dist/beats', { recursive: true });
fs.copyFileSync('beats/index.json', 'dist/beats/index.json');
for (const f of fs.readdirSync('beats')) if (f.endsWith('.pcm')) fs.copyFileSync(path.join('beats', f), path.join('dist/beats', f));

fs.writeFileSync('dist/package.json', '{"type":"module"}');
console.log('sidecar bundled into dist/');
