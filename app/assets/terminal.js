(() => {
  let pending = false;
  let terminal;

  const keys = [
    { label: 'Esc', key: 'Escape', code: 'Escape', keyCode: 27 },
    { label: 'Tab', key: 'Tab', code: 'Tab', keyCode: 9 },
    { label: '⇧ Tab', key: 'Tab', code: 'Tab', keyCode: 9, shiftKey: true },
    { label: 'Ctrl+C', key: 'c', code: 'KeyC', keyCode: 67, ctrlKey: true },
    { label: '←', key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
    { label: '↓', key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
    { label: '↑', key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
    { label: '→', key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
    { label: 'Enter', key: 'Enter', code: 'Enter', keyCode: 13 },
  ];

  const mobile = window.matchMedia('(max-width: 767px) and (pointer: coarse)');
  const toolbar = document.createElement('nav');
  toolbar.id = 'mobile-terminal-keys';
  toolbar.setAttribute('aria-label', 'Terminal keyboard shortcuts');
  for (const spec of keys) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = spec.label;
    button.setAttribute('aria-label', spec.label);
    // Keep terminal focus and the Android software keyboard open on tap.
    button.addEventListener('pointerdown', event => event.preventDefault());
    button.addEventListener('click', () => sendKey(spec));
    toolbar.appendChild(button);
  }
  document.body.appendChild(toolbar);

  function sendKey(spec) {
    const input = window.term?.textarea || document.querySelector('.xterm-helper-textarea');
    if (!input) return;
    const options = {
      bubbles: true, cancelable: true,
      key: spec.key, code: spec.code,
      ctrlKey: !!spec.ctrlKey, shiftKey: !!spec.shiftKey,
    };
    const event = new KeyboardEvent('keydown', options);
    // xterm.js 5.x still reads the legacy keyCode in its keyboard handler.
    Object.defineProperty(event, 'keyCode', { get: () => spec.keyCode });
    Object.defineProperty(event, 'which', { get: () => spec.keyCode });
    input.dispatchEvent(event);
    const release = new KeyboardEvent('keyup', options);
    Object.defineProperty(release, 'keyCode', { get: () => spec.keyCode });
    input.dispatchEvent(release);
  }

  function fit() {
    pending = false;
    const viewport = window.visualViewport;
    const root = document.documentElement;
    const visible = viewport && viewport.scale === 1;
    const width = visible ? viewport.width : window.innerWidth;
    const height = visible ? viewport.height : window.innerHeight;
    const left = visible ? viewport.offsetLeft : 0;
    const top = visible ? viewport.offsetTop : 0;
    const toolbarHeight = mobile.matches ? toolbar.offsetHeight : 0;

    root.style.setProperty('--terminal-width', `${width}px`);
    root.style.setProperty('--terminal-height', `${Math.max(0, height - toolbarHeight)}px`);
    root.style.setProperty('--terminal-left', `${left}px`);
    root.style.setProperty('--terminal-top', `${top}px`);
    root.style.setProperty('--mobile-keys-left', `${left}px`);
    root.style.setProperty('--mobile-keys-top', `${top + height - toolbarHeight}px`);
    root.style.setProperty('--mobile-keys-width', `${width}px`);

    const current = window.term;
    if (!current?.element || typeof current.fit !== 'function') {
      schedule();
      return;
    }
    if (terminal !== current) {
      terminal = current;
      terminal.onRender(schedule);
      new ResizeObserver(schedule).observe(document.getElementById('terminal-container'));
    }
    const fontSize = window.innerWidth < 768 ? 12 : 16;
    if (terminal.options.fontSize !== fontSize) terminal.options.fontSize = fontSize;
    if (terminal.options.lineHeight !== 1.2) terminal.options.lineHeight = 1.2;
    terminal.fit();
  }

  function schedule() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(fit);
  }

  window.addEventListener('resize', schedule);
  window.addEventListener('orientationchange', schedule);
  window.visualViewport?.addEventListener('resize', schedule);
  window.visualViewport?.addEventListener('scroll', schedule);
  mobile.addEventListener('change', schedule);
  document.fonts?.ready.then(schedule);
  schedule();
})();
