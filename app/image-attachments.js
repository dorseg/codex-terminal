function installTerminalImages(terminal) {
  installTerminalImages.terminal = terminal;
  const root = terminal.element;
  function images(transfer) {
    return [...(transfer?.files || [])].filter(file => file.type.startsWith('image/') || /\.(png|jpe?g|webp|heic|heif)$/i.test(file.name));
  }
  root.addEventListener('paste', event => {
    const files = images(event.clipboardData);
    if (!files.length) return; // Ordinary text paste stays with xterm.
    event.preventDefault();
    event.stopImmediatePropagation();
    openImageAttachments(files);
  }, true);
  root.addEventListener('dragover', event => {
    if ([...(event.dataTransfer?.items || [])].some(item => item.kind === 'file')) {
      event.preventDefault(); event.stopPropagation();
      event.dataTransfer.dropEffect = 'copy';
    }
  }, true);
  root.addEventListener('drop', event => {
    const files = images(event.dataTransfer);
    if (!files.length) return;
    event.preventDefault(); event.stopImmediatePropagation();
    openImageAttachments(files);
  }, true);
}

function installImageAttachments(drawer) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Images';
  drawer.drawer.querySelector('#wt-drawer-grid').prepend(button);
  button.addEventListener('click', () => { drawer.close(); openImageAttachments(); });
}

function openImageAttachments(files = []) {
  if (openImageAttachments.active) { openImageAttachments.active(files); return; }
  const terminal = installTerminalImages.terminal;
  const connected = () => Boolean(terminal && window.__remobiSockets?.some(socket => socket.readyState === WebSocket.OPEN));
  const dialog = document.createElement('dialog');
  dialog.id = 'terminal-images';
  dialog.setAttribute('aria-labelledby', 'terminal-images-title');
  dialog.innerHTML = `<style>
#terminal-images{position:fixed;inset:0;box-sizing:border-box;width:min(720px,100%);max-width:100%;max-height:100vh;max-height:100dvh;margin:auto;border:1px solid #585b70;border-radius:12px;background:#1e1e2e;color:#cdd6f4;padding:20px;padding:max(20px,env(safe-area-inset-top)) max(20px,env(safe-area-inset-right)) max(20px,env(safe-area-inset-bottom)) max(20px,env(safe-area-inset-left));font:16px system-ui;overflow:auto;overscroll-behavior:contain;touch-action:auto}
#terminal-images::backdrop{background:#0009}#terminal-images h2{margin-top:0}#terminal-images nav{display:flex;flex-wrap:wrap;gap:10px}#terminal-images button{font:inherit;padding:10px;min-height:44px;cursor:pointer}#terminal-images button:disabled{cursor:default;opacity:.55}#terminal-images :focus-visible{outline:2px solid #a6e3a1;outline-offset:2px}#terminal-images article{margin-top:16px;padding:12px;border:1px solid #585b70;border-radius:8px;overflow-wrap:anywhere}#terminal-images img{display:block;max-width:100%;width:120px;height:90px;object-fit:contain}#terminal-images input[type=text]{width:100%;box-sizing:border-box;background:#11111b;color:inherit;font:14px monospace;padding:10px;user-select:text}#terminal-images [data-saved-image]{padding:12px 0;border-top:1px solid #585b70;display:flex;gap:12px;align-items:center}#terminal-images [data-saved-image] code{flex:1;min-width:0;overflow-wrap:anywhere;user-select:text;-webkit-user-select:text}#terminal-images [role=status]{min-height:1.5em}#terminal-images p{line-height:1.45}
@media(max-width:600px){#terminal-images{width:100%;height:100%;height:100dvh;max-height:100dvh;border:0;border-radius:0}}
</style><h2 id="terminal-images-title">Images</h2><p>PNG, JPEG or WebP, up to 10 MiB per image. Export HEIC/HEIF photos as JPEG, or use a screenshot.</p><p>Insert reference into the pane focused at insertion time. Connected browsers share terminal focus. This adds text to your current prompt without submitting it.</p><nav><button type="button" data-choose>Choose images</button><button type="button" data-paste>Paste image</button><button type="button" data-close>Close / cancel</button></nav><input type="file" accept="image/png,image/jpeg,image/webp" multiple hidden><p role="status" aria-live="polite"></p><div data-list></div><section data-saved><h3>Saved images</h3><p>Deleting saved images removes their files from the workspace, including older uploads. References to deleted images will stop working.</p><nav><button type="button" data-refresh>Refresh saved images</button><button type="button" data-cleanup disabled>Delete all saved images</button></nav><p data-saved-status role="status" aria-live="polite"></p><div data-saved-list></div></section>`;
  const picker = dialog.querySelector('input[type=file]');
  const status = dialog.querySelector('[role=status]');
  const list = dialog.querySelector('[data-list]');
  const entries = [];
  const savedList = dialog.querySelector('[data-saved-list]');
  const savedStatus = dialog.querySelector('[data-saved-status]');
  const cleanup = dialog.querySelector('[data-cleanup]');
  let savedImages = [], deleting = false, loadingSaved = false, savedRequest, savedVersion = 0;
  let closed = false, running = false, request;
  for (const type of ['touchstart', 'touchmove', 'touchend', 'pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'wheel', 'keydown', 'keyup', 'keypress', 'beforeinput', 'input', 'paste', 'dragover', 'drop']) {
    dialog.addEventListener(type, event => event.stopPropagation());
  }
  function updateDeleteButtons() {
    for (const button of dialog.querySelectorAll('[data-choose], [data-paste], [data-refresh]')) button.disabled = deleting;
    for (const entry of entries) {
      entry.insert.disabled = deleting || !entry.result || !connected();
      entry.copy.disabled = deleting;
      entry.remove.disabled = running || deleting || loadingSaved || !entry.result;
    }
    cleanup.disabled = !savedImages.length || running || deleting || loadingSaved;
    for (const button of savedList.querySelectorAll('button')) button.disabled = running || deleting || loadingSaved;
  }
  async function loadSaved() {
    if (closed) return;
    savedRequest?.abort();
    savedRequest = new AbortController();
    const version = ++savedVersion;
    loadingSaved = true; updateDeleteButtons();
    savedStatus.textContent = 'Loading saved images…';
    try {
      const response = await fetch('/api/terminal/images', { cache: 'no-store', credentials: 'same-origin', signal: savedRequest.signal });
      const result = await response.json();
      if (!response.ok) throw Error(result.error || 'Unable to list saved images. Retry.');
      if (!Array.isArray(result.images)) throw Error('Invalid saved image list. Retry.');
      if (closed || version !== savedVersion) return;
      savedImages = result.images;
      savedList.replaceChildren();
      for (const image of savedImages) {
        const row = document.createElement('div'); row.dataset.savedImage = '';
        const path = document.createElement('code'); path.textContent = image.path;
        const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Delete';
        remove.setAttribute('aria-label', `Delete ${image.path.split('/').pop()}`);
        remove.onclick = () => removeSaved(image.path);
        row.append(path, remove); savedList.append(row);
      }
      savedStatus.textContent = savedImages.length ? `${savedImages.length} saved image${savedImages.length === 1 ? '' : 's'}.` : 'No saved images.';
    } catch (error) {
      if (!closed && version === savedVersion) savedStatus.textContent = error.message;
    } finally {
      if (!closed && version === savedVersion) { loadingSaved = false; updateDeleteButtons(); }
    }
  }
  async function removeSaved(path) {
    if (running || deleting || loadingSaved || closed) return;
    deleting = true; updateDeleteButtons();
    savedStatus.textContent = 'Deleting saved images…';
    try {
      const endpoint = '/api/terminal/images' + (path ? '/' + encodeURIComponent(path.split('/').pop()) : '');
      const response = await fetch(endpoint, { method: 'DELETE', credentials: 'same-origin' });
      const result = await response.json();
      if (!response.ok) throw Error(result.error || 'Unable to delete saved images. Retry.');
      if (closed) return;
      for (const entry of entries) {
        if (!entry.result || (path && entry.result.path !== path)) continue;
        entry.result = null; entry.state = 'deleted';
        entry.reference.hidden = entry.copy.hidden = entry.remove.hidden = true; entry.reference.value = '';
        entry.message.textContent = 'Saved image deleted. Choose the image again to upload it.';
        if (entry.url) { URL.revokeObjectURL(entry.url); entry.url = null; }
        entry.preview?.remove();
      }
      refresh();
      await loadSaved();
      if (!closed) status.textContent = `Deleted ${result.deleted} saved image${result.deleted === 1 ? '' : 's'}.`;
    } catch (error) {
      if (!closed) { await loadSaved(); if (!closed) savedStatus.textContent = error.message; }
    } finally { deleting = false; if (!closed) updateDeleteButtons(); }
  }
  dialog.querySelector('[data-refresh]').onclick = loadSaved;
  cleanup.onclick = () => removeSaved();
  function refresh() {
    updateDeleteButtons();
    status.textContent = connected() ? 'Select images or paste an image. Completed uploads stay in the workspace until manually deleted.' : 'Terminal disconnected. You can upload and copy a saved reference; reconnect to insert it.';
  }
  async function upload() {
    if (running || closed) return;
    running = true; updateDeleteButtons();
    try {
      for (const entry of entries) {
        if (closed) break;
        if (entry.state !== 'queued') continue;
        entry.state = 'uploading'; entry.message.textContent = 'Uploading…'; entry.retry.hidden = true;
        request = new AbortController();
        try {
          const response = await fetch('/api/terminal/images', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': entry.mimeType }, body: entry.file, signal: request.signal });
          const result = await response.json();
          if (!response.ok) throw Error(result.error || 'Upload failed. Retry.');
          if (!/^\/workspace\/\.codex-terminal\/uploads\/[\da-f-]+\.(png|jpg|webp)$/.test(result.path)) throw Error('Invalid upload response. Retry.');
          if (closed) break;
          entry.result = result;
          entry.state = 'complete';
          entry.reference.value = ` Inspect the image at ${result.path} `;
          entry.reference.hidden = entry.copy.hidden = entry.remove.hidden = false;
          entry.message.textContent = 'Uploaded. Ready to insert reference.';
        } catch (error) {
          if (closed) break;
          entry.state = 'failed'; entry.message.textContent = error.message; entry.retry.hidden = false;
        }
        refresh();
      }
    } finally {
      running = false;
      if (!closed) { updateDeleteButtons(); loadSaved(); }
      if (!closed && entries.some(entry => entry.state === 'queued')) upload();
    }
  }
  function add(selected) {
    if (closed || deleting || !selected.length) return;
    for (const file of selected) {
      const mimeType = file.type || ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' }[file.name.split('.').pop().toLowerCase()]);
      const valid = ['image/png', 'image/jpeg', 'image/webp'].includes(mimeType) && file.size > 0 && file.size <= 10 * 1024 * 1024;
      const article = document.createElement('article');
      const name = document.createElement('p'); name.textContent = file.name || 'Clipboard image'; article.append(name);
      let url, preview;
      if (valid) {
        url = URL.createObjectURL(file);
        preview = document.createElement('img'); preview.src = url; preview.alt = `Preview of ${name.textContent}`; article.append(preview);
      }
      const message = document.createElement('p'); message.setAttribute('role', 'status');
      message.textContent = valid ? 'Queued…' : 'Choose a nonempty PNG, JPEG or WebP up to 10 MiB. Export HEIC/HEIF as JPEG, or use a screenshot.';
      const reference = document.createElement('input'); reference.type = 'text'; reference.readOnly = true; reference.hidden = true; reference.setAttribute('aria-label', `Saved reference for ${name.textContent}`);
      const nav = document.createElement('nav');
      const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Retry'; retry.hidden = true;
      const insert = document.createElement('button'); insert.type = 'button'; insert.textContent = 'Insert into current pane'; insert.disabled = true;
      const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = 'Copy reference'; copy.hidden = true;
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Delete image'; remove.hidden = true;
      remove.setAttribute('aria-label', `Delete image ${name.textContent}`);
      nav.append(insert, copy, remove, retry); article.append(message, reference, nav); list.append(article);
      const entry = { file, mimeType, message, reference, retry, insert, copy, remove, url, preview, state: valid ? 'queued' : 'invalid' };
      entries.push(entry);
      remove.onclick = () => { if (entry.result) removeSaved(entry.result.path); };
      retry.onclick = () => { entry.state = 'queued'; retry.hidden = true; message.textContent = 'Queued…'; upload(); };
      insert.onclick = () => {
        if (!entry.result || !connected() || deleting) { refresh(); return; }
        terminal.paste(reference.value);
        message.textContent = 'Reference inserted into the current pane. Review your prompt before submitting.';
      };
      copy.onclick = async () => {
        try {
          if (!navigator.clipboard?.writeText) throw Error('Unavailable');
          await navigator.clipboard.writeText(reference.value);
          if (!closed) message.textContent = 'Reference copied.';
        } catch {
          if (closed) return;
          reference.focus(); reference.select();
          message.textContent = 'Use the selected reference’s Copy menu, or Ctrl+C / Command+C.';
        }
      };
    }
    upload();
  }
  openImageAttachments.active = add;
  dialog.querySelector('[data-choose]').onclick = () => picker.click();
  picker.onchange = () => { add([...picker.files]); picker.value = ''; };
  dialog.querySelector('[data-paste]').onclick = async () => {
    try {
      // Call directly in the tap's activation, before any await.
      if (!navigator.clipboard?.read) throw Error('Unavailable');
      const pending = navigator.clipboard.read();
      const items = await pending;
      const selected = [];
      for (const item of items) {
        const type = item.types.find(type => ['image/png', 'image/jpeg', 'image/webp'].includes(type));
        if (type) selected.push(new File([await item.getType(type)], 'Clipboard image.' + type.split('/')[1], { type }));
      }
      if (closed) return;
      if (!selected.length) { status.textContent = 'No supported image on the clipboard. Use Choose images.'; return; }
      add(selected);
    } catch {
      if (!closed) status.textContent = 'Clipboard reading is unavailable or was denied. It requires HTTPS and browser support. Use Choose images, or paste a copied image over the terminal.';
    }
  };
  dialog.addEventListener('paste', event => {
    const selected = [...(event.clipboardData?.files || [])];
    if (selected.length) { event.preventDefault(); add(selected); }
  });
  dialog.addEventListener('dragover', event => event.preventDefault());
  dialog.addEventListener('drop', event => { event.preventDefault(); add([...(event.dataTransfer?.files || [])]); });
  dialog.querySelector('[data-close]').onclick = () => dialog.close();
  // Update only when connection state changes, preserving clipboard feedback.
  let wasConnected = connected();
  const timer = setInterval(() => { if (wasConnected !== connected()) { wasConnected = connected(); refresh(); } }, 250);
  dialog.addEventListener('close', () => {
    closed = true; request?.abort(); savedRequest?.abort(); clearInterval(timer);
    for (const entry of entries) if (entry.url) URL.revokeObjectURL(entry.url);
    openImageAttachments.active = null; dialog.remove();
    [...document.querySelectorAll('button')].find(button => button.textContent.includes('More'))?.focus({ preventScroll: true });
  }, { once: true });
  document.body.append(dialog); dialog.showModal();
  dialog.querySelector('[data-choose]').focus({ preventScroll: true });
  refresh(); loadSaved(); add(files);
}
