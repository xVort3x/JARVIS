// The browser pages GG Coder's libraries show after a sign-in name GG Coder; in the shipped app they say Jarvis.
// bundle.sh runs this over the bundles after esbuild: `node rebrand.mjs <file>…`. Each page's words must be found in
// one of the files, or the build fails (a library update changed them; update the pair here).
// Only these pages: the rest of the library's wording, and about.mjs's "Sign-in is shared with GG Coder", stay.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const REBRAND = [
  // ChatGPT sign-in callback (@kenkaiiii/gg-core).
  ["<h1>You're signed in to GG Coder.</h1>", "<h1>You're signed in to Jarvis.</h1>"],
  // A connection's (MCP server's) OAuth callback (@kenkaiiii/ggcoder/mcp).
  ['<p>You can close this tab and return to GG Coder.</p>', '<p>You can close this tab and return to Jarvis.</p>'],
];

/** Rebrands the pages in these files in place; throws naming any page found in none of them. */
export function rebrandFiles(files) {
  const texts = files.map((f) => fs.readFileSync(f, 'utf8'));
  const missing = REBRAND.filter(([from]) => !texts.some((t) => t.includes(from))).map(([from]) => from);
  if (missing.length) throw new Error(`rebrand: not found in ${files.join(', ')}: ${missing.join(' | ')}`);
  files.forEach((f, i) => {
    const out = REBRAND.reduce((t, [from, to]) => t.split(from).join(to), texts[i]);
    if (out !== texts[i]) fs.writeFileSync(f, out);
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  try { rebrandFiles(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(1); }
}
