// Customize Remobi controls, gestures, and appearance. Restart to apply.
const popup = (id, label, description, key) => ({
  id, label, description,
  action: { type: 'send', data: `\x02\x1b[${key}~` },
});

export default {
  drawer: {
    buttons: (defaults) => [
      popup('ai-usage', 'AI Usage', 'Show remaining Codex quota', 15),
      popup('scratch', 'Quick Shell', 'Open a temporary shell', 17),
      popup('diff', 'Diff', 'Review local or committed Git changes', 18),
      popup('ports', 'Ports', 'Check configured app previews', 19),
      ...defaults,
    ],
  },
};
