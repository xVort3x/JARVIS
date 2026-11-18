// The speaking pill: visible only while J.A.R.V.I.S talks. The orb pulses and the bars breathe from a
// playback clock, so no audio ever leaves the machine; the shortcut chip shows the talk keys.
(() => {
  const pill = document.getElementById('pill'), chip = document.getElementById('chip');
  const orbC = document.getElementById('orb'), waveC = document.getElementById('wave');
  const o = orbC.getContext('2d'), w = waveC.getContext('2d');
  const speech = { on: false, env: 0 };
  // Sidecar → us: {kind:'speech', id, rate, pcm} for each chunk, {kind:'speech', id, end} at the end.
  window.__roamieHost = (m) => {
    if (m.kind === 'talk_keys' && m.keys) chip.textContent = m.keys;
    else if (m.kind === 'speech') { speech.on = !m.end; if (m.end) setTimeout(() => pill.classList.remove('on'), 420); else pill.classList.add('on'); }
  };
  let raf = 0;
  const frame = (t) => {
    speech.env += ((speech.on ? 1 : 0) - speech.env) * 0.055;
    const env = speech.env;
    if (env > 0.005) {
      const ts = t / 1000;
      // Orb.
      const s = orbC.width, cx = s / 2;
      o.clearRect(0, 0, s, s);
      const pulse = 1 + 0.11 * Math.sin(ts * 2.3) * env + 0.05 * Math.sin(ts * 6.1) * env;
      const glow = o.createRadialGradient(cx, cx, 8, cx, cx, 31);
      glow.addColorStop(0, 'rgba(255,255,255,0.72)');
      glow.addColorStop(0.5, 'rgba(196,216,255,0.22)');
      glow.addColorStop(1, 'rgba(196,216,255,0)');
      o.fillStyle = glow; o.fillRect(0, 0, s, s);
      const sphere = o.createRadialGradient(cx - 7, cx - 8, 2, cx, cx, 21 * pulse);
      sphere.addColorStop(0, '#ffffff');
      sphere.addColorStop(0.4, '#dce8ff');
      sphere.addColorStop(0.78, '#8fb7ff');
      sphere.addColorStop(1, '#3f63d8');
      o.fillStyle = sphere;
      o.beginPath(); o.arc(cx, cx, 19 * pulse, 0, Math.PI * 2); o.fill();
      // Waveform: superimposed sines, symmetrical.
      const hw = waveC.width, hh = waveC.height, n = 19, unit = hw / (n * 1.7);
      w.clearRect(0, 0, hw, hh);
      for (let i = 0; i < n; i++) {
        const k = i / (n - 1);
        const centre = 1 - Math.abs(k - 0.5) * 2;
        const a = 0.55 + 0.45 * Math.sin(ts * 5.2 + i * 0.8) * Math.sin(ts * 1.9 - i * 0.35);
        const h = Math.max(3, hh * 0.9 * a * centre * (0.35 + 0.65 * env));
        const hue = 236 + (i % 4) * 7;
        w.fillStyle = `hsl(${hue} 78% ${62 + centre * 16}%)`;
        const x = i * unit * 1.7 + unit * 0.35;
        const y = (hh - h) / 2;
        const r = Math.min(2.4, h / 2);
        w.beginPath();
        if (w.roundRect) { w.roundRect(x, y, unit * 0.95, h, r); w.fill(); } else { w.rect(x, y, unit * 0.95, h); w.fill(); }
      }
    }
    // Keep rendering when visible or fading.
    if (pill.classList.contains('on') || speech.env > 0.02) raf = requestAnimationFrame(frame);
    else raf = 0;
  };
  // Kick the loop when the pill opens.
  const observer = new MutationObserver(() => {
    if (pill.classList.contains('on') && !raf) { speech.env = Math.max(speech.env, 0.01); raf = requestAnimationFrame(frame); }
  });
  observer.observe(pill, { attributes: true, attributeFilter: ['class'] });
})();
