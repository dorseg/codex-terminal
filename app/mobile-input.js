function installMobileInput(terminal) {
  if (!matchMedia('(pointer: coarse)').matches) return;

  const textarea = terminal.textarea;
  const root = terminal.element;
  textarea.setAttribute('autocomplete', 'off');

  let previous = '';
  let composing = false;
  let commitTimer;
  let keypressText;
  const segmenter = Intl.Segmenter && new Intl.Segmenter();

  function characters(text) {
    return segmenter ? Array.from(segmenter.segment(text), entry => entry.segment) : Array.from(text);
  }

  function reset() {
    previous = textarea.value = '';
  }

  function resetWhenIdle() {
    if (!composing && !commitTimer) reset();
  }

  function capture(type, handler) {
    root.addEventListener(type, event => {
      if (event.target === textarea) handler(event);
    }, true);
  }

  terminal.onKey(({ key, domEvent }) => {
    if (domEvent.type === 'keypress') {
      keypressText = key;
    } else {
      resetWhenIdle();
    }
  });
  root.addEventListener('paste', resetWhenIdle, true);
  root.addEventListener('pointerdown', resetWhenIdle, true);
  // Remobi's toolbar writes directly to the PTY through its terminal bridge.
  queueMicrotask(() => {
    const bridge = window.term;
    const input = bridge.input.bind(bridge);
    bridge.input = (...args) => {
      resetWhenIdle();
      input(...args);
    };
  });
  textarea.addEventListener('blur', () => {
    previous = '';
    keypressText = undefined;
  });

  function endKeypress() {
    // A hardware key can change the terminal without editing the textarea.
    if (keypressText !== undefined) resetWhenIdle();
    keypressText = undefined;
  }

  capture('keydown', event => {
    endKeypress();
    // Let the browser edit the textarea for Process keys. xterm otherwise
    // schedules its own diff and can drop or duplicate the following input.
    if (!composing && !commitTimer && (event.keyCode === 229 || event.key === 'Process')) {
      event.stopPropagation();
    }
  });
  capture('keyup', endKeypress);
  textarea.addEventListener('compositionstart', () => { composing = true; });
  textarea.addEventListener('compositionend', () => {
    composing = false;
    // xterm schedules its composition commit before this listener runs.
    clearTimeout(commitTimer);
    commitTimer = setTimeout(() => {
      commitTimer = undefined;
      if (!composing) reset();
    }, 0);
  });

  capture('beforeinput', event => {
    if (!composing && !commitTimer && !event.isComposing && event.cancelable &&
        event.inputType === 'deleteContentBackward' && !textarea.value) {
      // An empty textarea cannot be edited, but the PTY may still have text.
      event.preventDefault();
      terminal.input('\x7f');
    }
  });
  capture('input', event => {
    if (composing || event.isComposing || commitTimer) {
      // xterm reads the textarea when committing the composition, including
      // any space delivered by the browser in the same event sequence.
      event.stopPropagation();
      return;
    }
    if (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph') {
      event.stopPropagation();
      reset();
      terminal.input('\r');
      return;
    }
    if (!['insertText', 'insertReplacementText', 'deleteContentBackward', 'deleteWordBackward'].includes(event.inputType)) return;
    event.stopPropagation();

    const oldValue = previous;
    previous = textarea.value;
    const sentByKeypress = event.inputType === 'insertText' && event.data === keypressText;
    keypressText = undefined;
    if (sentByKeypress) return;
    if (!oldValue && !previous && event.inputType === 'deleteContentBackward') {
      terminal.input('\x7f');
      return;
    }
    if (previous === oldValue) return;
    if (previous.startsWith(oldValue)) {
      terminal.input(previous.slice(oldValue.length));
      return;
    }
    const oldText = characters(oldValue);
    const newText = characters(previous);
    let prefix = 0;
    while (prefix < oldText.length && oldText[prefix] === newText[prefix]) prefix++;
    terminal.input('\x7f'.repeat(oldText.length - prefix) + newText.slice(prefix).join(''));
  });
}
