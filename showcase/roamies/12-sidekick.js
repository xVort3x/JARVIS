// The desktop's Jarvis: the LED globe with the agent layer on top.
Roamie.register(Roamie.ditherKit({
  id: 'sidekick', label: 'Jarvis', matrix: true, pixel: 1.3, glow: 0.55, speed: 80,
  pal: [[6, 12, 28], [12, 36, 74], [22, 88, 148], [56, 184, 255], [206, 246, 255]],
  plugin: (kit) => Roamie.agentPlugin?.(kit) ?? null,
}));
