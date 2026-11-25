// The alarm sound: a short three-note chime written once as a WAV, looped by the OS's own player. It rings alongside
// the spoken nudge, so a timer is heard even when the overlay is hidden, and stops after 40 s or when the user starts
// talking again.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RING_SECONDS = 40;
export const ALARM_FILE = path.join(os.homedir(), '.gg', 'alarm.wav');

/** A 2.4 s, 16-bit mono chime (C6, E6, G6), as a complete WAV file. */
export function chimeWav(rate = 44_100) {
  const n = Math.round(rate * 2.4), data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    let v = 0;
    for (const [at, f] of [[0, 1046.5], [0.22, 1318.5], [0.44, 1568]]) {
      const u = t - at;
      if (u < 0 || u > 1.6) continue;
      const env = Math.min(1, u / 0.006) * Math.exp(-2.6 * u);
      v += env * (Math.sin(2 * Math.PI * f * u) + 0.32 * Math.sin(4 * Math.PI * f * u));
    }
    data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 6500))), i * 2);
  }
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

let player = null;
export const ringing = () => !!player;
export function stop() {
  if (!player) return;
  try { player.kill(); } catch { /* already gone */ }
  player = null;
}
/** Ring until stopped or `seconds` pass. False when the sound couldn't be made or the player couldn't start. */
export function ring({ seconds = RING_SECONDS, spawnImpl = spawn } = {}) {
  stop();
  try {
    fs.mkdirSync(path.dirname(ALARM_FILE), { recursive: true });
    if (!fs.existsSync(ALARM_FILE)) fs.writeFileSync(ALARM_FILE, chimeWav());
  } catch { return false; }
  const secs = Math.max(1, Math.round(seconds));
  const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`, psq = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const plan = process.platform === 'win32'
    ? ['powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', `$p = New-Object System.Media.SoundPlayer ${psq(ALARM_FILE)}; $p.PlayLooping(); Start-Sleep -Seconds ${secs}; $p.Stop()`]]
    : process.platform === 'darwin'
      ? ['/bin/sh', ['-c', `end=$(( $(date +%s) + ${secs} )); while [ $(date +%s) -lt $end ]; do afplay ${shq(ALARM_FILE)}; done`]]
      : ['/bin/sh', ['-c', `end=$(( $(date +%s) + ${secs} )); while [ $(date +%s) -lt $end ]; do paplay ${shq(ALARM_FILE)} 2>/dev/null || aplay -q ${shq(ALARM_FILE)}; done`]];
  let p;
  try { p = spawnImpl(plan[0], plan[1], { stdio: 'ignore', windowsHide: true }); } catch { return false; }
  player = p;
  p.on?.('error', () => { if (player === p) player = null; });
  p.on?.('exit', () => { if (player === p) player = null; });
  p.unref?.();
  return true;
}
