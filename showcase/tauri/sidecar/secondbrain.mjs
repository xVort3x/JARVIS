// The second brain: a folder of the user's own notes and memory (an Obsidian vault, a context repo) that the chat
// works from, set on the panel's Second brain page. The setting is a map of locations, { root, raw, context, research,
// projects, agents } (LOCATIONS): '' means "find it in root" (looked for again at each new chat), a path is the user's
// choice and is never replaced. Relative file paths in the chat's file tools resolve against root, its skills
// (<agents>/skills/<name>/SKILL.md) show beside the user's own (skills.mjs), raw is read-only (safety.mjs), and its
// rules (root's AGENTS.md, or CLAUDE.md) ride in the system prompt, capped so small local models still fit.
// Jarvis' own data stays in ~/Jarvis.
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

export const RULES_MAX = 6000;
const RULE_FILES = ['AGENTS.md', 'CLAUDE.md'];

/** A typed folder path → { ok, dir } or { ok: false, why }. It has to be a folder that exists, inside the home folder
 *  (where it really leads, after links) and not the home folder itself. '' means off. */
export function checkSecondBrain(raw, home) {
  let d = String(raw ?? '').trim().replace(/^["']|["']$/g, '');
  if (!d) return { ok: false, why: 'empty' };
  if (d === '~' || d.startsWith('~/') || d.startsWith('~\\')) d = path.join(home, d.slice(1));
  if (!path.isAbsolute(d)) return { ok: false, why: 'Give the full path of the folder, like ~/Documents/Notes.' };
  d = path.resolve(d);
  let real, h;
  try { if (!statSync(d).isDirectory()) return { ok: false, why: "That's a file, not a folder." }; real = realpathSync(d); } catch { return { ok: false, why: "I can't find that folder on this computer." }; }
  try { h = realpathSync(home); } catch { h = path.resolve(home); }
  if (real === h) return { ok: false, why: 'Pick the second brain folder itself, not your whole home folder.' };
  if (!real.startsWith(h + path.sep)) return { ok: false, why: 'The second brain folder has to be inside your home folder.' };
  return { ok: true, dir: d };
}

// The rules file's text, read again only when it changes (by modification time and size).
const cache = new Map();
/** The folder's AGENTS.md (or CLAUDE.md when there's none): { file, text }, or null. */
export function rulesOf(dir) {
  for (const name of RULE_FILES) {
    const f = path.join(dir, name);
    let st;
    try { st = statSync(f); } catch { continue; }
    if (!st.isFile()) continue;
    const key = `${st.mtimeMs}:${st.size}`, hit = cache.get(f);
    if (hit?.key === key) return { file: name, text: hit.text };
    try {
      const text = readFileSync(f, 'utf8').replace(/^﻿/, '').trim();
      cache.set(f, { key, text });
      return { file: name, text };
    } catch { continue; }
  }
  return null;
}

// ---------- the locations ----------
// Each place the setting names, with its default folder name (looked for in root in any letter case, and made by
// "Create a new one") and the one-line role the prompt gives it.
export const LOCATIONS = [
  { key: 'root', label: 'Root' },
  { key: 'raw', label: 'Raw evidence', name: '_raw', role: 'raw evidence, unedited: the proof. Read and cite it; never change it' },
  { key: 'context', label: 'Context (wiki)', name: '_context', also: ['wiki'], role: 'memory and the wiki: summarised context, notes and decisions. Memory, not proof' },
  { key: 'research', label: 'Research', name: '_research', role: 'research write-ups built from the context' },
  { key: 'projects', label: 'Projects', name: 'projects', role: 'projects, each self-contained with its own rules' },
  { key: 'agents', label: 'Agents folder', name: '.agents', role: 'agent files; its skills/ folder holds skills (how-tos), listed beside your own' },
];
export const KEYS = LOCATIONS.map((l) => l.key);
export const SUBS = KEYS.slice(1);
const LOC = Object.fromEntries(LOCATIONS.map((l) => [l.key, l]));

// A typed path, made full: quotes and a trailing slash dropped, ~ is the home folder. null when it isn't a full path.
function fullPath(raw, home) {
  let d = String(raw ?? '').trim().replace(/^["']|["']$/g, '');
  if (!d) return '';
  if (d === '~' || d.startsWith('~/') || d.startsWith('~\\')) d = path.join(home, d.slice(1));
  return path.isAbsolute(d) ? path.resolve(d) : null;
}
// Where a path really leads (links followed), for one that may not exist yet: its nearest existing folder's real path
// plus the rest.
function realOf(p) {
  let at = p, rest = [];
  for (;;) {
    try { return path.join(realpathSync(at), ...rest); } catch {}
    const up = path.dirname(at);
    if (up === at) return p;
    rest.unshift(path.basename(at)); at = up;
  }
}
const homeOf = (home) => { try { return realpathSync(home); } catch { return path.resolve(home); } };
const inside = (p, dir) => p.startsWith(dir + path.sep);

/** One location's typed path → { ok, dir } or { ok: false, why }. Any location: a full path inside the home folder
 *  (where it really leads), not the home folder itself and not a file. It needn't exist yet. '' means unset. */
export function checkLocation(raw, home) {
  const d = fullPath(raw, home);
  if (d === '') return { ok: false, why: 'empty' };
  if (d == null) return { ok: false, why: 'Give the full path of the folder, like ~/Documents/Notes.' };
  try { if (!statSync(d).isDirectory()) return { ok: false, why: "That's a file, not a folder." }; } catch {}
  const real = realOf(d), h = homeOf(home);
  if (real === h) return { ok: false, why: 'Pick a folder in it, not your whole home folder.' };
  if (!inside(real, h)) return { ok: false, why: 'It has to be inside your home folder.' };
  return { ok: true, dir: d };
}

// Finds `names` (relative paths) under `dir` in any letter case, as folders or files; the first that's there, else null.
function finder(dir) {
  const lists = new Map();
  const list = (d) => { if (!lists.has(d)) { let n = []; try { n = readdirSync(d); } catch {} lists.set(d, new Map(n.map((x) => [x.toLowerCase(), x]))); } return lists.get(d); };
  return (rel, wantDir) => {
    if (!dir) return null;
    let at = dir;
    for (const part of rel.split('/')) { const real = list(at).get(part.toLowerCase()); if (!real) return null; at = path.join(at, real); }
    try { const st = statSync(at); return (wantDir ? st.isDirectory() : st.isFile()) ? at : null; } catch { return null; }
  };
}

/** The locations found in `root` by their usual names: { raw, context, research, projects, agents }, '' for each
 *  that isn't there. A few folder listings, cheap enough for every new chat. */
export function detectLocations(root) {
  const find = finder(root), out = {};
  for (const k of SUBS) out[k] = [LOC[k].name, ...(LOC[k].also ?? [])].map((n) => find(n, true)).find(Boolean) ?? '';
  return out;
}

/** The saved setting, in today's shape: { root, raw, context, research, projects, agents } (strings), or null when
 *  off. The old setting was the root alone (a string): its locations are found in it now, once. */
export function migrateBrain(saved) {
  if (typeof saved === 'string') {
    const root = saved.trim();
    return root ? { root, ...detectLocations(root) } : null;
  }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return null;
  const out = Object.fromEntries(KEYS.map((k) => [k, typeof saved[k] === 'string' ? saved[k].trim() : '']));
  return out.root ? out : null;
}

/** The locations in use: the saved ones (each still inside the home folder), and for each one left unset, the one
 *  found in root now; plus skills (<agents>/skills). null when off or root is gone. */
export function resolveBrain(saved, home) {
  const s = migrateBrain(saved);
  if (!s || !checkSecondBrain(s.root, home).ok) return null;
  const found = detectLocations(s.root), out = { root: s.root };
  for (const k of SUBS) { const c = s[k] ? checkLocation(s[k], home) : null; out[k] = c?.ok ? c.dir : found[k]; }
  out.skills = out.agents ? path.join(out.agents, 'skills') : '';
  return out;
}

/** The page's check of what's typed: for each location { path, status, why?, warn? }. status: 'found' (a folder that's
 *  there), 'missing', 'will create' (create: it'll be made), 'unset' or 'bad' (why says what's wrong). warn: a
 *  subfolder outside root (allowed while it's inside the home folder). found: what root holds by the usual names. */
export function checkForm(form = {}, home, { create = false } = {}) {
  const root = fullPath(form.root, home) || '';
  const out = {}, found = create ? {} : detectLocations(root);
  for (const k of KEYS) {
    const typed = String(form[k] ?? '').trim();
    if (!typed) { out[k] = { path: '', status: 'unset' }; continue; }
    const c = checkLocation(typed, home);
    if (!c.ok) { out[k] = { path: typed, status: 'bad', why: c.why }; continue; }
    let there = false;
    try { there = statSync(c.dir).isDirectory(); } catch {}
    out[k] = { path: c.dir, status: there ? 'found' : create ? 'will create' : 'missing' };
    if (k !== 'root' && root && !inside(c.dir, root) && c.dir !== root) out[k].warn = "Outside the root folder. That's fine while it's in your home folder.";
  }
  if (!create && out.root.status === 'found' && root) { const r = checkSecondBrain(root, home); if (!r.ok) out.root = { path: root, status: 'bad', why: r.why }; }
  return { status: out, found };
}

// ---------- making a new one ----------
// The starter files: written only where there's no file yet (never over one). Short on purpose: theirs to grow.
const rel = (root, p) => { const r = path.relative(root, p); return r && !r.startsWith('..') && !path.isAbsolute(r) ? r.split(path.sep).join('/') : p; };
function starters(l) {
  const n = (k) => (l[k] ? rel(l.root, l[k]) : null);
  const files = [];
  const lines = [
    ['raw', 'raw evidence: notes, transcripts, exports, as they came. Never edited.'],
    ['context', 'context: the wiki, summarised memory (words only). Memory, not proof.'],
    ['research', 'research: write-ups built from the context.'],
    ['projects', 'projects: each one self-contained, with its own rules.'],
    ['agents', 'agent files; skills/ holds skills (how-tos).'],
  ].filter(([k]) => l[k]).map(([k, t]) => `- \`${n(k)}/\`: ${t}`);
  files.push([path.join(l.root, 'AGENTS.md'), `# AGENTS.md

My second brain. What each folder is for:

${lines.join('\n')}

## Rules

${[l.raw && l.context ? `- Knowledge flows one way: ${n('raw')} → ${n('context')}${l.research ? ` → ${n('research')}` : ''}. Never write synthesis back into ${n('raw')}.` : '',
    l.raw ? `- ${n('raw')} is never edited: read it, cite it, leave it as it is.` : '',
    l.context ? `- ${n('context')} is word-only memory: no images or other binary files. Check important claims in ${l.raw ? n('raw') : 'the sources'}.` : '',
    l.projects ? `- Each project in ${n('projects')} is self-contained: its own files, its own rules.` : '',
  ].filter(Boolean).join('\n')}
`]);
  if (l.context) {
    files.push([path.join(l.context, 'index.md'), `# Index

Start here. One line per topic, with a link to its note.
`]);
    files.push([path.join(l.context, 'source-map.md'), `# Source map

Where the proof for each topic is${l.raw ? ` in ${n('raw')}` : ''}. One line per topic: topic → source path.
`]);
  }
  if (l.projects) files.push([path.join(l.projects, 'index.md'), `# Projects

One line per project: name, folder, what it is.
`]);
  return files;
}

/** Makes a new second brain: root and each location given (agents with its skills folder), then the starter files
 *  where there are none. Never writes over anything. locations: { root, raw, … } full paths, '' to skip one.
 *  → { ok, locations, made: [paths], kept: [paths already there] } or { ok: false, why }. */
export function createBrain(locations, home) {
  const l = { root: '' };
  for (const k of KEYS) {
    const typed = String(locations?.[k] ?? '').trim();
    if (!typed) { if (k === 'root') return { ok: false, why: 'Choose where to make it and give it a name.' }; l[k] = ''; continue; }
    const c = checkLocation(typed, home);
    if (!c.ok) return { ok: false, why: `${LOC[k].label}: ${c.why}` };
    l[k] = c.dir;
  }
  const made = [], kept = [];
  try {
    for (const k of KEYS) {
      if (!l[k]) continue;
      for (const d of k === 'agents' ? [l[k], path.join(l[k], 'skills')] : [l[k]]) {
        if (existsSync(d)) continue;
        mkdirSync(d, { recursive: true }); made.push(d);
      }
    }
    // Their rules in a CLAUDE.md stay the ones in use: no AGENTS.md is added beside it (rulesOf reads AGENTS.md first).
    const ownRules = finder(l.root)('CLAUDE.md', false);
    for (const [f, text] of starters(l)) {
      if (ownRules && f === path.join(l.root, 'AGENTS.md')) { kept.push(ownRules); continue; }
      try { writeFileSync(f, text, { flag: 'wx' }); made.push(f); } catch (e) { if (e.code === 'EEXIST') kept.push(f); else throw e; }
    }
  } catch (e) { return { ok: false, why: `I couldn't make it: ${e.message}`, made }; }
  return { ok: true, locations: l, made, kept };
}

// ---------- the setup guide's default ----------
/** The account's names, { full, user }: os.userInfo() has no full name, so it's id -F on macOS, the passwd GECOS
 *  field (before its first comma) on Linux, and USERNAME on Windows. A command that fails gives ''. */
export function accountNames({ platform = process.platform, user = '', env = process.env, run = runText } = {}) {
  let full = '';
  try {
    if (platform === 'darwin') full = run('id', ['-F']) ?? '';
    else if (platform === 'win32') full = env.USERNAME ?? '';
    else if (user) full = String(run('getent', ['passwd', user]) ?? '').split(':')[4]?.split(',')[0] ?? '';
  } catch { full = ''; }
  return { full: String(full).trim(), user };
}
function runText(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
}
// What a folder name can't hold (on any of the three systems), and leading or trailing dots and spaces.
const folderSafe = (s) => String(s ?? '').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '').replace(/^[.\s]+|[.\s]+$/g, '');
/** The default second brain's folder name: "<First> OS", First being the full name's first word, else the username,
 *  else "Second Brain". */
export function brainName({ full, user } = {}) {
  const first = folderSafe(String(full ?? '').trim().split(/\s+/)[0]) || folderSafe(user);
  return first ? `${first} OS` : 'Second Brain';
}
const SHELL_FOLDERS = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders';
/** The user's real Desktop folder. Windows: the registry's User Shell Folders value (OneDrive backup moves it),
 *  %USERPROFILE% being `home`. Linux: XDG_DESKTOP_DIR (the environment, then user-dirs.dirs; localised, like
 *  ~/Schreibtisch), $HOME being `home`. macOS, or nothing usable: ~/Desktop. */
const pathOf = (platform = process.platform) => (platform === 'win32' ? path.win32 : path.posix);
export function desktopDir(home, { platform = process.platform, env = process.env, run = runText, read = (f) => readFileSync(f, 'utf8') } = {}) {
  const p = pathOf(platform), plain = p.join(home, 'Desktop');
  let dir = '';
  try {
    if (platform === 'win32') {
      const raw = String(run('reg', ['query', SHELL_FOLDERS, '/v', 'Desktop']) ?? '').match(/^\s*Desktop\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/m)?.[1] ?? '';
      const envOf = (k) => (k.toUpperCase() === 'USERPROFILE' ? home : Object.entries(env).find(([n]) => n.toUpperCase() === k.toUpperCase())?.[1]);
      dir = raw.replace(/%([^%]+)%/g, (m, k) => envOf(k) ?? m);
    } else if (platform !== 'darwin') {
      dir = env.XDG_DESKTOP_DIR || String(read(p.join(env.XDG_CONFIG_HOME || p.join(home, '.config'), 'user-dirs.dirs')) ?? '').match(/^\s*XDG_DESKTOP_DIR="([^"]+)"/m)?.[1] || '';
      dir = dir.replace(/^\$HOME(?=\/|$)/, home);
    }
  } catch { dir = ''; }
  return dir && !dir.includes('%') && p.isAbsolute(dir) ? p.normalize(dir) : plain;
}
/** Where the setup guide's default one goes: <Desktop>/<name> (desktopDir, brainName). */
export const desktopBrainDir = (home, name = 'Second Brain', opts) => pathOf(opts?.platform).join(desktopDir(home, opts), name);
/** Makes (or fills in) <Desktop>/<name>: when it's already there, the locations found in it by name are kept
 *  and only the missing folders and starter files are added, never over a file. → createBrain's result. */
export function makeDesktopBrain(home, name, opts) {
  const root = desktopBrainDir(home, name, opts), found = detectLocations(root), l = { root };
  for (const k of SUBS) l[k] = found[k] || path.join(root, LOC[k].name);
  return createBrain(l, home);
}

// ---------- what it holds, for the prompt ----------
// The folders and key files, from the locations in use: each folder's role, then the files known to matter.
const FILES = [
  { key: 'index', in: 'context', at: 'index.md', role: 'start here for their business, work, projects or context' },
  { key: 'sourceMap', in: 'context', at: 'source-map.md', role: 'where the proof for each topic is in the raw evidence' },
  { key: 'projectsIndex', in: 'projects', at: 'index.md', role: 'the list of projects' },
];
const asMap = (b) => (typeof b === 'string' ? (b ? { root: b, ...detectLocations(b), skills: '' } : null) : b);

/** What the second brain holds: [{ key, label?, path, dir, role }] for each location in use that's there (the raw
 *  evidence, the context (or wiki), a wiki inside it, research, projects, skills), then its rules and key files.
 *  `b`: the locations in use (resolveBrain), or the root alone (its locations found by name). */
export function brainLayout(b) {
  const l = asMap(b);
  if (!l) return [];
  const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
  const out = [];
  const add = (key, label, p, role) => { if (p && isDir(p)) out.push({ key, label, path: p, dir: true, role }); };
  add('raw', 'raw', l.raw, LOC.raw.role);
  add('context', 'context', l.context, LOC.context.role);
  const wiki = l.context ? finder(l.context)('wiki', true) : null;
  if (wiki && wiki !== l.context) add('wiki', 'wiki', wiki, 'the wiki: the summarised context, by topic');
  add('research', 'research', l.research, LOC.research.role);
  add('projects', 'projects', l.projects, LOC.projects.role);
  const skills = l.skills || (l.agents ? finder(l.agents)('skills', true) : null);
  add('skills', 'skills', skills, 'skills (how-tos), listed beside your own');
  const rules = rulesOf(l.root);
  if (rules) out.push({ key: 'rules', path: path.join(l.root, rules.file), dir: false, role: 'rules for agents working here' });
  for (const f of FILES) { const hit = l[f.in] ? finder(l[f.in])(f.at, false) : null; if (hit) out.push({ key: f.key, path: hit, dir: false, role: f.role }); }
  // No wiki folder of its own: the context is the wiki (that's what its owner calls it).
  const ctx = out.find((x) => x.key === 'context');
  if (ctx && !out.some((x) => x.key === 'wiki')) ctx.label = 'context (wiki)';
  else if (ctx) ctx.role = 'memory: summarised context, notes and decisions. Memory, not proof';
  return out;
}
/** The panel's short line of what was found: the folders' labels. */
export const layoutFound = (layout) => layout.filter((x) => x.label).map((x) => x.label);

/** The system prompt's second-brain part; '' when none is set or the folder is gone. `b`: the locations in use
 *  (resolveBrain), or the root alone. `max` caps the part that varies (the list and the rules) so small local
 *  models still fit. */
export function secondBrainBlock(b, { max = RULES_MAX } = {}) {
  const l = asMap(b);
  const dir = l?.root;
  if (!dir) return '';
  try { if (!statSync(dir).isDirectory()) return ''; } catch { return ''; }
  const layout = brainLayout(l), has = (k) => layout.find((x) => x.key === k);
  // The list, last lines (the files) dropped first if it alone would pass the cap.
  const lines = layout.map((x) => `- ${x.path}${x.dir ? '/' : ''}: ${x.role}`);
  const head = '\nYour second brain (found in it):\n';
  while (lines.length && head.length + lines.join('\n').length > max) lines.pop();
  const map = lines.length ? head + lines.join('\n') : '';
  const rules = rulesOf(dir);
  let text = rules?.text ?? '';
  const room = Math.max(0, max - map.length);
  if (text.length > room) text = `${text.slice(0, room).trimEnd()}\n…(cut here; read_file ${rules.file} for the rest)`;
  const raw = has('raw'), index = has('index'), src = has('sourceMap');
  const rawName = raw ? `${rel(dir, raw.path)}/` : '';
  const guide = [
    `When they ask about themselves, their business, channels, projects or people, or a task needs a personal detail (their name, a link, an account) that is not already in what you know about them, look in the second brain first (${index ? `start at ${rel(dir, index.path)}` : 'search_files for it'}, then read what it points to) before ever saying you don't know.`,
    index ? `For questions about their business, work, projects or context, start at ${rel(dir, index.path)}${src && raw ? `, and use ${rel(dir, src.path)} to find the proof in ${rawName}` : ''}.` : '',
    has('context') && raw ? `${rel(dir, has('context').path)} is memory, not proof: check important claims in ${rawName}.` : '',
    raw ? `Never write, move or delete anything in ${rawName} (unedited evidence): the file tools and commands refuse it.` : '',
  ].filter(Boolean).join(' ');
  return `
Second brain: ${dir} is the user's second brain, the folder of their notes and memory you work from. File paths without a full path (read_file, list_files, search_files, write_file) resolve against it, and shell commands (run_command) start in it too; Jarvis's own files are in ~/Jarvis, so give that full path.${guide ? ` ${guide}` : ''}${map}${text ? `
Its own rules, from ${rules.file} (the user wrote these for agents working in this folder; follow them where they fit what you can do):
<second-brain-rules>
${text}
</second-brain-rules>` : ''}`;
}
