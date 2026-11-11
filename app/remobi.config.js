// Customize Remobi controls, gestures, and appearance. Restart to apply.
const shortcut = (id, label, description, key) => ({
  id, label, description,
  action: { type: 'send', data: `\x02\x1b[${key}~` },
});

// Remobi's documented Herdr overrides; compatible defaults keep their actions.
const incompatible = new Set([
  'tmux-split-vertical', 'tmux-split-horizontal', 'tmux-sessions', 'tmux-windows', 'tmux-copy',
]);
const labels = {
  'tmux-new-window': { label: '+ Tab', description: 'Create Herdr tab' },
  'tmux-help': { description: 'Herdr key bindings' },
  'tmux-kill-pane': { label: 'Close pane', description: 'Close current Herdr pane' },
};

export default {
  gestures: { swipe: { left: '\x02n', right: '\x02p', leftLabel: 'Next Herdr tab', rightLabel: 'Previous Herdr tab' } },
  toolbar: { row1: defaults => defaults.map(button => button.id === 'tmux-prefix' ? { ...button, description: 'Herdr prefix (Ctrl+B)' } : button) },
  drawer: {
    buttons: (defaults) => [
      shortcut('codex', 'Codex', 'Choose how to start Codex', 20),
      shortcut('ai-usage', 'AI Usage', 'Show remaining Codex quota', 15),
      shortcut('diff', 'Diff', 'Review local or committed Git changes', 18),
      shortcut('ports', 'Ports', 'Check configured app previews', 19),
      shortcut('scratch', 'Quick Shell', 'Open a temporary shell', 17),
      ...defaults
        .filter(button => !incompatible.has(button.id))
        .map(button => labels[button.id] ? { ...button, ...labels[button.id] } : button),
      ...[
        ['rename-tab', 'Rename', 'Rename tab', 'T'],
        ['split-vertical', 'Split |', 'Split vertically', 'v'],
        ['split-horizontal', 'Split —', 'Split horizontally', '-'],
        ['workspaces', 'Workspaces', 'Choose workspace', 'w'],
        ['tabs', 'Tabs', 'Navigate tabs and panes', 'g'],
        ['sidebar', 'Sidebar', 'Toggle sidebar', 'b'],
        ['scrollback', 'Scrollback', 'Open scrollback', 'e'],
        ['close-tab', 'Close tab', 'Close tab', 'X'],
      ].map(([id, label, description, key]) => ({ id, label, description, action: { type: 'send', data: '\x02' + key } })),
    ],
  },
};
