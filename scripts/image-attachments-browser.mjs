// npm install --no-save playwright @xterm/xterm
// npx playwright install --with-deps chromium webkit
// node scripts/image-attachments-browser.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const playwright = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const script = await readFile(new URL('../app/image-attachments.js', import.meta.url), 'utf8');
const xtermPath = process.env.XTERM_SCRIPT || require.resolve('@xterm/xterm');
const xterm = await readFile(xtermPath, 'utf8');
const css = await readFile(resolve(dirname(xtermPath), '../css/xterm.css'), 'utf8');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');
const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}body{margin:0;overflow:hidden}#terminal{width:100%;height:200px;overflow:hidden}</style><div id="terminal"></div><button id="more">More</button><div id="drawer"><div id="wt-drawer-grid"></div></div><script src="/xterm.js"></script><script nonce="image-browser-check">${script}
window.originalClipboard=navigator.clipboard;
window.terminal=new Terminal({cols:30,rows:8});terminal.open(document.querySelector('#terminal'));
window.promptText='existing prompt';window.sent=[];window.focusedPane='one';window.inserted=[];
terminal.onData(text=>{sent.push(text);promptText+=text;inserted.push({pane:focusedPane,text})});
window.__remobiSockets=[{readyState:WebSocket.OPEN}];installTerminalImages(terminal);
const drawer={drawer:document.querySelector('#drawer'),close(){this.drawer.hidden=true}};
installImageAttachments(drawer);document.querySelector('#more').onclick=()=>drawer.drawer.hidden=false;
window.leaked=0;for(const type of ['touchmove','keydown','wheel','input','paste'])document.body.addEventListener(type,()=>leaked++);
window.created=0;window.revoked=0;const create=URL.createObjectURL.bind(URL),revoke=URL.revokeObjectURL.bind(URL);
URL.createObjectURL=(...args)=>{created++;return create(...args)};URL.revokeObjectURL=url=>{revoked++;revoke(url)};
window.image=()=>new File([Uint8Array.from(atob('${png.toString('base64')}'),c=>c.charCodeAt(0))],'paste.png',{type:'image/png'});
</script>`;
// Match Remobi's policy, including the image-preview allowance installed by the
// build patch. Keep CSP enabled so a blocked thumbnail cannot pass unnoticed.
const imageCsp = "default-src 'self'; script-src 'self' 'nonce-image-browser-check'; style-src 'self' 'unsafe-inline' https:; font-src 'self' https:; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";
const server = http.createServer((req, res) => {
  res.setHeader('Content-Security-Policy', req.url.includes('blocked-preview=1') ? imageCsp.replace(' data: blob:;', ' data:;') : imageCsp);
  res.setHeader('Content-Type', req.url === '/xterm.js' ? 'text/javascript' : 'text/html');
  res.end(req.url === '/xterm.js' ? xterm : html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
try {
  for (const [engine, mobile] of [['chromium', false], ['chromium', true], ['webkit', true]].filter(([engine]) => !process.env.BROWSER_ENGINES || process.env.BROWSER_ENGINES.split(',').includes(engine))) {
    const browser = await playwright[engine].launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }, hasTouch: mobile, isMobile: mobile });
      page.setDefaultTimeout(10000);
      const errors = []; page.on('pageerror', error => errors.push(error.message));
      let sequence = 0, active = 0, maxActive = 0, failNext = false, failDelete = false, hold = false, release;
      let savedRecords = [];
      await page.route('**/api/terminal/images**', async route => {
        if (route.request().method() === 'GET') return route.fulfill({ json: { images: savedRecords } });
        if (route.request().method() === 'DELETE') {
          if (failDelete) { failDelete = false; return route.fulfill({ status: 503, json: { error: 'Delete busy. Retry.' } }); }
          const name = new URL(route.request().url()).pathname.split('/api/terminal/images')[1].slice(1);
          const before = savedRecords.length;
          savedRecords = name ? savedRecords.filter(image => image.path.split('/').pop() !== name) : [];
          return route.fulfill({ json: { deleted: before - savedRecords.length } });
        }
        active++; maxActive = Math.max(maxActive, active); sequence++;
        const path = `/workspace/.codex-terminal/uploads/00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}.png`;
        const failure = failNext; failNext = false;
        if (hold) await new Promise(resolve => { release = resolve; });
        else await new Promise(resolve => setTimeout(resolve, 30));
        const image = { path, mimeType: 'image/png', size: png.length };
        if (!failure) savedRecords.push(image);
        try { await route.fulfill({ status: failure ? 503 : 201, json: failure ? { error: 'Storage busy. Retry.' } : image }); } catch { /* cancellation */ }
        active--;
      });
      // Negative control reproduces the original policy blocking blob images.
      await page.goto(`http://127.0.0.1:${server.address().port}/?blocked-preview=1`);
      assert.equal(await page.evaluate(() => new Promise(resolve => {
        const preview = new Image();
        const url = URL.createObjectURL(image());
        preview.onload = () => { URL.revokeObjectURL(url); resolve(true); };
        preview.onerror = () => { URL.revokeObjectURL(url); resolve(false); };
        preview.src = url;
        document.body.append(preview);
      })), false, 'the original policy blocks blob previews');
      await page.goto(`http://127.0.0.1:${server.address().port}`);
      const panel = page.locator('#terminal-images');
      const open = async () => {
        await page.locator('#more').click(); await page.getByRole('button', { name: 'Images', exact: true }).click(); await panel.waitFor();
        assert.equal(await page.locator('#drawer').isVisible(), false);
      };
      const close = async () => { await panel.getByRole('button', { name: 'Close / cancel' }).click(); await panel.waitFor({ state: 'detached' }); };
      const select = files => panel.locator('input[type=file]').setInputFiles(files);
      const file = name => ({ name, mimeType: 'image/png', buffer: png });
      await open();
      assert.equal(await panel.locator('input[type=file]').getAttribute('capture'), null);
      failNext = true;
      await select([file('failed.png'), file('success.png')]);
      await panel.locator('article').nth(1).getByRole('textbox').waitFor();
      assert.match(await panel.locator('article').first().textContent(), /Storage busy/);
      assert.equal(await panel.locator('img').count(), 2);
      await page.waitForFunction(() => [...document.querySelectorAll('#terminal-images img')].every(preview => preview.complete && preview.naturalWidth === 1 && preview.naturalHeight === 1));
      await panel.getByRole('button', { name: 'Retry', exact: true }).click();
      await panel.locator('article').first().getByRole('textbox').waitFor();
      assert.equal(sequence, 3); assert.equal(maxActive, 1, 'uploads are sequential');
      const reference = await panel.locator('article').first().getByRole('textbox').inputValue();
      await page.evaluate(() => { focusedPane = 'two'; });
      await panel.getByRole('button', { name: 'Insert into current pane', exact: true }).first().click();
      assert.equal(await page.evaluate(() => promptText), 'existing prompt' + reference);
      assert.deepEqual(await page.evaluate(() => inserted), [{ pane: 'two', text: reference }]);
      assert.ok(!/[\r\n\x00-\x1f]/.test(reference), 'no submission or control keys');
      await page.evaluate(() => { __remobiSockets[0].readyState = WebSocket.CLOSED; });
      await page.waitForFunction(() => document.querySelector('article button').disabled);
      assert.equal(await panel.locator('input[type=text]').first().inputValue(), reference);
      // Clipboard copy fallback keeps a selectable reference when disconnected.
      await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
      await panel.getByRole('button', { name: 'Copy reference' }).first().click();
      assert.deepEqual(await panel.locator('input[type=text]').first().evaluate(el => [el.selectionStart, el.selectionEnd]), [0, reference.length]);
      assert.equal(await page.evaluate(() => {
        const before = leaked, target = document.querySelector('#terminal-images input[type=text]');
        for (const type of ['touchmove','keydown','wheel','input','paste']) target.dispatchEvent(new Event(type, { bubbles: true }));
        return before === leaked;
      }), true);
      await page.evaluate(() => { __remobiSockets[0].readyState = WebSocket.OPEN; });
      await page.waitForFunction(() => !document.querySelector('article button').disabled);
      failDelete = true;
      await panel.locator('article').first().getByRole('button', { name: 'Delete image failed.png', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[data-saved-status]').textContent.includes('Delete busy'));
      assert.equal(await panel.locator('article input[type=text]').first().isVisible(), true, 'failed deletion preserves references');
      await panel.locator('article').first().getByRole('button', { name: 'Delete image failed.png', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#terminal-images > [role=status]').textContent === 'Deleted 1 saved image.');
      assert.equal(await panel.locator('[data-saved-image]').count(), 1);
      assert.equal(await panel.locator('article input[type=text]').first().isVisible(), false);
      assert.equal(await panel.getByRole('button', { name: 'Insert into current pane', exact: true }).first().isDisabled(), true);
      await page.setViewportSize({ width: 844, height: 390 });
      const bounds = await panel.boundingBox(); assert.ok(bounds.height <= 390 && bounds.width <= 844);
      await close();
      assert.equal(await page.evaluate(() => created === revoked), true);
      // Non-image clipboard text still reaches xterm exactly once.
      await page.evaluate(() => {
        const data = new DataTransfer(); data.setData('text/plain', ' plain text');
        terminal.textarea.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
      });
      assert.equal(await page.evaluate(() => promptText), 'existing prompt' + reference + ' plain text');
      // Native image paste is intercepted before xterm, and drop joins the dialog.
      await page.evaluate(() => {
        const data = new DataTransfer(); data.items.add(image());
        terminal.textarea.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
      });
      await panel.locator('article').getByRole('textbox').waitFor();
      await page.evaluate(() => {
        const data = new DataTransfer(); data.items.add(image());
        document.querySelector('#terminal-images').dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
      });
      await panel.locator('article').nth(1).getByRole('textbox').waitFor();
      assert.equal(await page.evaluate(() => sent.length), 2, 'images never paste raw data into terminal');
      await close();
      await page.evaluate(() => {
        const data = new DataTransfer(); data.items.add(image());
        terminal.element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
      });
      await panel.locator('article').getByRole('textbox').waitFor(); await close();
      if (engine === 'chromium') {
        // Exercise the actual Clipboard API, beyond format/permission mocks.
        await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
        await page.evaluate(async () => {
          Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard });
          const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
          canvas.getContext('2d').fillRect(0, 0, 1, 1);
          const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        });
        await open();
        await panel.getByRole('button', { name: 'Paste image', exact: true }).click();
        await panel.locator('article input[type=text]').waitFor();
        await close();
      }
      await open();
      // Button reads clipboard synchronously in its handler, with success and fallbacks.
      await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { read() { window.clipboardRead = true; return Promise.resolve([{ types: ['image/png'], getType: async () => image() }]); } } }));
      await panel.getByRole('button', { name: 'Paste image', exact: true }).click();
      assert.equal(await page.evaluate(() => clipboardRead), true);
      await panel.locator('article').getByRole('textbox').waitFor();
      for (const mode of ['empty', 'text', 'html', 'unsupported', 'denied', 'missing']) {
        await page.evaluate(mode => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: mode === 'missing' ? undefined : { read: () => mode === 'empty' ? Promise.resolve([]) : mode === 'unsupported' ? Promise.resolve([{ types: ['image/gif'] }]) : mode === 'text' || mode === 'html' ? Promise.resolve([{ types: [mode === 'text' ? 'text/plain' : 'text/html'] }]) : Promise.reject(Error('denied')) } }), mode);
        await panel.getByRole('button', { name: 'Paste image', exact: true }).click();
        await page.waitForFunction(() => document.querySelector('#terminal-images > [role=status]').textContent.toLowerCase().includes('use choose images'));
      }
      await select([{ name: 'photo.heic', mimeType: 'image/heic', buffer: png }, { name: 'empty.png', mimeType: 'image/png', buffer: Buffer.alloc(0) }, { name: 'large.png', mimeType: 'image/png', buffer: Buffer.alloc(10 * 1024 * 1024 + 1) }]);
      assert.equal(await panel.locator('article').count(), 4);
      for (let i = 1; i < 4; i++) assert.match(await panel.locator('article').nth(i).textContent(), /nonempty PNG/);
      assert.ok(await panel.locator('[data-saved-image]').count() > 1, 'saved images persist across dialog visits');
      await panel.getByRole('button', { name: 'Delete all saved images', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[data-saved-status]').textContent === 'No saved images.');
      assert.equal(await panel.locator('[data-saved-image]').count(), 0);
      assert.equal(await panel.getByRole('button', { name: 'Delete all saved images', exact: true }).isDisabled(), true);
      assert.match(await panel.locator('article').first().textContent(), /Saved image deleted/);
      await page.keyboard.press('Escape'); await panel.waitFor({ state: 'detached' });
      assert.equal(await page.evaluate(() => created === revoked), true);
      hold = true; await open(); await select(file('cancel.png'));
      await page.waitForFunction(() => document.querySelector('#terminal-images article').textContent.includes('Uploading'));
      await close(); release?.(); hold = false;
      await open(); assert.equal(await panel.locator('article').count(), 0); await close();
      assert.equal(await page.evaluate(() => created === revoked), true);
      assert.deepEqual(errors, []);
      console.log(`Image attachment browser checks passed (${engine}, ${mobile ? 'mobile' : 'desktop'})`);
    } finally { await browser.close(); }
  }
} finally { server.closeAllConnections(); server.close(); }
