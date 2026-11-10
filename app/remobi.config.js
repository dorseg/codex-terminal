// Customize Remobi controls, gestures, and appearance. Restart to apply.
const shortcut = (id, label, description, key) => ({
  id, label, description,
  action: { type: 'send', data: `\x02\x1b[${key}~` },
});

export default {
  drawer: {
    buttons: (defaults) => [
      shortcut('ai-usage', 'AI Usage', 'Show remaining Codex quota', 15),
      shortcut('scratch', 'Quick Shell', 'Open a temporary shell', 17),
      shortcut('diff', 'Diff', 'Review local or committed Git changes', 18),
      shortcut('ports', 'Ports', 'Check configured app previews', 19),
      shortcut('codex', 'Codex', 'Choose how to start Codex', 20),
      ...defaults,
    ],
  },
};
