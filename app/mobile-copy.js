function installTerminalCopy(drawer) {
  // A long customized drawer must keep its first rows reachable on short screens.
  drawer.drawer.style.maxHeight = '100vh';
  drawer.drawer.style.maxHeight = 'calc(100dvh - env(safe-area-inset-top, 0px))';
  drawer.drawer.style.overflowY = 'auto';
  drawer.drawer.style.boxSizing = 'border-box';
  drawer.drawer.style.overscrollBehavior = 'contain';
  const entry = document.createElement('button');
  entry.type = 'button';
  entry.textContent = 'Copy';
  drawer.drawer.querySelector('#wt-drawer-grid').prepend(entry);
  entry.addEventListener('click', () => {
    drawer.close();
    openTerminalCopy();
  });
}

function openTerminalCopy() {
  const dialog = document.createElement('dialog');
  dialog.id = 'terminal-copy';
  dialog.setAttribute('aria-labelledby', 'terminal-copy-title');
  dialog.innerHTML = `<style>
#terminal-copy{position:fixed;inset:0;margin:0;width:100%;max-width:none;height:100%;height:100dvh;max-height:none;box-sizing:border-box;border:0;background:#1e1e2e;color:#cdd6f4;padding:16px;padding: max(16px,env(safe-area-inset-top)) max(16px,env(safe-area-inset-right)) max(16px,env(safe-area-inset-bottom)) max(16px,env(safe-area-inset-left));font:16px system-ui;overscroll-behavior:contain}
#terminal-copy[open]{display:flex;flex-direction:column;gap:12px}#terminal-copy h2,#terminal-copy p{margin:0}#terminal-copy textarea{flex:1;min-height:0;width:100%;box-sizing:border-box;resize:none;background:#11111b;color:inherit;font:16px monospace;white-space:pre;overflow:auto;touch-action:auto;user-select:text;-webkit-user-select:text;overscroll-behavior:contain}#terminal-copy nav{display:flex;gap:12px;flex-wrap:wrap}#terminal-copy button{font:inherit;padding:12px;min-height:44px}#terminal-copy :focus-visible{outline:2px solid #a6e3a1;outline-offset:2px}
</style><h2 id="terminal-copy-title">Copy</h2><p>Snapshot of up to 500 available rows in the focused pane.</p><textarea readonly inputmode="none" spellcheck="false" aria-label="Captured terminal text"></textarea><p role="status" aria-live="polite"></p><nav><button type="button" disabled>Copy all</button><button type="button">Retry</button><button type="button" autofocus>Close</button></nav>`;
  const text = dialog.querySelector('textarea');
  const status = dialog.querySelector('[role=status]');
  const [copy, retry, close] = dialog.querySelectorAll('button');
  let request, version = 0, closed = false;
  // Keep native selection/scrolling, but do not bubble gestures or keys to Remobi.
  for (const type of ['touchstart', 'touchmove', 'touchend', 'pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'wheel', 'keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'paste']) {
    dialog.addEventListener(type, event => event.stopPropagation());
  }
  function cleanup() {
    closed = true;
    version++;
    request?.abort();
    dialog.remove();
    // Focus a control, never xterm's editable textarea (which opens phone keyboards).
    const more = [...document.querySelectorAll('button')].find(button => button.textContent.includes('More'));
    more?.focus({ preventScroll: true });
  }
  dialog.addEventListener('close', cleanup, { once: true });
  close.addEventListener('click', () => dialog.close());
  async function load() {
    request?.abort();
    request = new AbortController();
    const current = ++version;
    text.value = '';
    copy.disabled = true;
    dialog.setAttribute('aria-busy', 'true');
    status.textContent = 'Loading terminal text…';
    try {
      const response = await fetch('/api/terminal/copy', { cache: 'no-store', credentials: 'same-origin', signal: request.signal });
      const result = await response.json();
      if (!response.ok) throw Error(result.error || 'Unable to capture terminal text. Please retry.');
      if (typeof result.text !== 'string' || typeof result.paneId !== 'string') throw Error('Invalid terminal capture. Please retry.');
      if (closed || version !== current) return;
      text.value = result.text;
      copy.disabled = !result.text;
      status.textContent = result.text ? 'Ready. Select text to use your phone’s Copy menu, or tap Copy all.' : 'No terminal output is available. Try again after the pane produces output.';
    } catch (error) {
      if (closed || version !== current) return;
      status.textContent = error.name === 'AbortError' ? 'Capture cancelled. Tap Retry.' : error.message;
    } finally {
      if (!closed && version === current) dialog.removeAttribute('aria-busy');
    }
  }
  retry.addEventListener('click', load);
  copy.addEventListener('click', async () => {
    const current = version;
    function fallback() {
      if (closed || version !== current) return;
      text.focus({ preventScroll: true });
      text.select();
      text.setSelectionRange(0, text.value.length);
      status.textContent = 'Automatic copy is unavailable. Touch and hold the selected text, then choose Copy from your phone’s menu (or press Ctrl+C / Command+C).';
    }
    try {
      // Invoke immediately during the tap; no fetch or other await before this call.
      if (!navigator.clipboard?.writeText) return fallback();
      await navigator.clipboard.writeText(text.value);
      if (!closed && version === current) status.textContent = 'Copied all text.';
    } catch { fallback(); }
  });
  document.body.appendChild(dialog);
  dialog.showModal();
  close.focus({ preventScroll: true });
  load();
}
