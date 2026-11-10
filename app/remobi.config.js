// Customize Remobi controls, gestures, and appearance. Restart to apply.
export default {
  name: 'Dev Terminal',
  font: {
    family: 'JetBrainsMono NFM, monospace',
    mobileSizeDefault: 14,
    sizeRange: [10, 24],
  },
  gestures: {
    pinch: { enabled: true },
  },
  drawer: {
    buttons: (defaults) => [
      {
        id: 'git',
        label: 'Git',
        description: 'Git status',
        action: { type: 'send', data: 'git status\r' },
      },
      {
        id: 'codex',
        label: 'Codex',
        description: 'Start Codex CLI',
        action: { type: 'send', data: 'codex\r' },
      },
      ...defaults,
    ],
  },
  pwa: {
    enabled: true,
    themeColor: '#1e1e2e',
    shortName: 'Terminal',
  },
};
