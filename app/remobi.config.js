// Customize Remobi controls, gestures, and appearance. Restart to apply.
const shortcut = (id, label, description, key) => ({
  id, label, description,
  action: { type: 'send', data: `\x02\x1b[${key}~` },
});

export default {
  gestures: { swipe: { left: '\x02n', right: '\x02p', leftLabel: 'Next Herdr tab', rightLabel: 'Previous Herdr tab' } },
  toolbar: { row1: defaults => defaults.map(button => button.id === 'tmux-prefix' ? { ...button, id: 'herdr-prefix', description: 'Herdr prefix (Ctrl+B)' } : button) },
  drawer: {
    buttons: (defaults) => [
      shortcut('codex', 'Codex', 'Choose how to start Codex', 20),
      shortcut('ai-usage', 'AI Usage', 'Show remaining Codex quota', 15),
      shortcut('diff', 'Diff', 'Review local or committed Git changes', 18),
      shortcut('ports', 'Ports', 'Check configured app previews', 19),
      shortcut('scratch', 'Quick Shell', 'Open a temporary shell', 17),
      ...[
        ['new-tab', '+ Tab', 'Create tab', 'c'],
        ['rename-tab', 'Rename', 'Rename tab', 'T'],
        ['split-vertical', 'Split |', 'Split vertically', 'v'],
        ['split-horizontal', 'Split —', 'Split horizontally', '-'],
        ['workspaces', 'Workspaces', 'Choose workspace', 'w'],
        ['tabs', 'Tabs', 'Navigate tabs and panes', 'g'],
        ['sidebar', 'Sidebar', 'Toggle sidebar', 'b'],
        ['scrollback', 'Scrollback', 'Open scrollback', 'e'],
        ['zoom', 'Zoom', 'Toggle zoom', 'z'],
        ['close-pane', 'Close pane', 'Close pane', 'x'],
        ['close-tab', 'Close tab', 'Close tab', 'X'],
        ['help', 'Help', 'Herdr key bindings', '?'],
      ].map(([id, label, description, key]) => ({ id, label, description, action: { type: 'send', data: '\x02' + key } })),
      ...defaults.filter(button => !button.id.startsWith('tmux-')),
    ],
  },
};
