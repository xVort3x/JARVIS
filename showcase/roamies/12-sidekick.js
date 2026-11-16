// The chosen sidekick: the LED matrix dither blob, without the drips, with the agent layer on top.
Roamie.register(Roamie.ditherKit({
  id: 'sidekick', label: 'Sidekick', matrix: true, pixel: 1.3, glow: 0.55, speed: 80,
  pal: [[20, 12, 4], [92, 58, 14], [196, 120, 40], [255, 179, 71], [255, 230, 200]],
  plugin: (kit) => Roamie.agentPlugin?.(kit) ?? null,
}));
