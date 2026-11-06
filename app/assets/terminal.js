(() => {
  let pending = false;
  let terminal;

  function fit() {
    pending = false;
    const viewport = window.visualViewport;
    const root = document.documentElement;
    // Use the visible area when the keyboard opens. Leave pinch zoom to the browser.
    const visible = viewport && viewport.scale === 1;
    root.style.setProperty('--terminal-width', `${visible ? viewport.width : window.innerWidth}px`);
    root.style.setProperty('--terminal-height', `${visible ? viewport.height : window.innerHeight}px`);
    root.style.setProperty('--terminal-left', `${visible ? viewport.offsetLeft : 0}px`);
    root.style.setProperty('--terminal-top', `${visible ? viewport.offsetTop : 0}px`);

    const current = window.term;
    if (!current?.element || typeof current.fit !== 'function') {
      schedule();
      return;
    }
    if (terminal !== current) {
      terminal = current;
      // A reconnect or late server preferences can redraw the terminal.
      terminal.onRender(schedule);
      new ResizeObserver(schedule).observe(document.getElementById('terminal-container'));
    }
    // With a device-width viewport, use a readable mobile size without oversized cells.
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
  document.fonts?.ready.then(schedule);
  schedule();
})();
