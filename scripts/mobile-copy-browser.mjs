// Optional browser check: npm install --no-save playwright && npx playwright install chromium webkit
// Run: node scripts/mobile-copy-browser.mjs
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
const playwright = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const script = await readFile(new URL('../app/mobile-copy.js', import.meta.url), 'utf8');
const html = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}#wt-drawer{display:none;position:fixed;bottom:0;left:0;right:0;padding:24px 12px 12px}#wt-drawer.open{display:block}#wt-drawer-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}#wt-drawer-grid button{min-height:48px}</style><textarea id="terminal"></textarea><button id="more">☰ More</button><div id="wt-drawer"><div id="wt-drawer-grid">${Array.from({ length: 20 }, (_, i) => `<button>Existing action ${i}</button>`).join('')}</div></div><script>${script}
let closes=0, leaked=0;const drawer={drawer:document.querySelector('#wt-drawer'),close(){closes++;this.drawer.classList.remove('open')}};
document.querySelector('#more').onclick=()=>drawer.drawer.classList.add('open');installTerminalCopy(drawer);
for(const type of ['touchstart','touchmove','touchend','keydown','wheel','input','paste'])document.body.addEventListener(type,()=>leaked++);
</script>`;
const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
try {
  for (const engine of (process.env.BROWSER_ENGINES || 'chromium,webkit').split(',')) {
    const browser = await playwright[engine].launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      let body = { paneId: 'w1:p2', text: '  α 😀 <script>literal</script>\n' + 'long row '.repeat(200) + '\n' + 'row\n'.repeat(100) }, status = 200, delayed = false, pending;
      await page.route('**/api/terminal/copy', async route => {
        if (delayed) await new Promise(resolve => { pending = resolve; });
        try { await route.fulfill({ status, json: body }); } catch { /* Closed panel cancels its request. */ }
      });
      await page.goto(base);
      const open = async () => {
        await page.locator('#more').tap();
        assert.equal(await page.locator('#wt-drawer-grid button').first().textContent(), 'Copy');
        const drawerBounds = await page.locator('#wt-drawer').boundingBox();
        assert.ok(drawerBounds.y >= 0 && drawerBounds.height <= page.viewportSize().height, 'all drawer rows remain reachable on a short screen');
        await page.getByRole('button', { name: 'Copy', exact: true }).tap();
        await page.waitForFunction(() => document.querySelector('#terminal-copy')?.open);
        assert.equal(await page.locator('#wt-drawer').evaluate(el => el.classList.contains('open')), false);
      };
      const ready = () => page.waitForFunction(() => !document.querySelector('#terminal-copy').hasAttribute('aria-busy'));
      const panel = page.locator('#terminal-copy');
      const close = async () => {
        await panel.getByRole('button', { name: 'Close', exact: true }).tap();
        await panel.waitFor({ state: 'detached' });
      };
      await open(); await ready();
      assert.equal(await panel.locator('textarea').inputValue(), body.text);
      assert.equal(await panel.locator('textarea').getAttribute('readonly'), '');
      assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Close');
      // Modal text never becomes HTML, and ongoing output does not change it.
      assert.equal(await panel.locator('textarea script').count(), 0);
      const captured = body.text;
      body = { paneId: 'w1:p3', text: 'Fresh output' };
      assert.equal(await panel.locator('textarea').inputValue(), captured);
      await page.evaluate(() => { window.copied = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText(value) { window.copied = value; return new Promise(resolve => window.copyResolve = resolve); } } }); });
      await panel.getByRole('button', { name: 'Copy all', exact: true }).tap();
      assert.equal(await page.evaluate(() => window.copied), captured);
      assert.ok(!(await panel.getByRole('status').textContent()).includes('Copied all'));
      await page.evaluate(() => window.copyResolve());
      await page.waitForFunction(() => document.querySelector('[role=status]').textContent === 'Copied all text.');
      // Denial and lack of API select the original snapshot for native Copy.
      for (const supported of [true, false]) {
        await page.evaluate(supported => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: supported ? { writeText: () => Promise.reject(Error('denied')) } : undefined }), supported);
        await panel.getByRole('button', { name: 'Copy all', exact: true }).tap();
        await page.waitForFunction(() => document.querySelector('[role=status]').textContent.includes('Automatic copy is unavailable'));
        assert.deepEqual(await panel.locator('textarea').evaluate(el => [el.selectionStart, el.selectionEnd]), [0, captured.length]);
      }
      // Events retain their defaults but never reach the terminal's ancestors.
      assert.equal(await page.evaluate(() => {
        const before = leaked, el = document.querySelector('#terminal-copy textarea');
        const event = new Event('touchmove', { bubbles: true, cancelable: true });
        el.dispatchEvent(event);
        for (const type of ['keydown','wheel','input','paste']) el.dispatchEvent(new Event(type, { bubbles: true }));
        return leaked === before && !event.defaultPrevented;
      }), true);
      await page.setViewportSize({ width: 844, height: 390 });
      const bounds = await panel.boundingBox();
      assert.ok(bounds.height <= 390 && bounds.width <= 844);
      assert.equal(await panel.locator('textarea').inputValue(), captured);
      await panel.getByRole('button', { name: 'Retry', exact: true }).tap(); await ready();
      assert.equal(await panel.locator('textarea').inputValue(), 'Fresh output');
      await close();
      assert.equal(await panel.count(), 0);
      assert.equal(await page.evaluate(() => document.activeElement.id), 'more');
      body.text = '';
      await open(); await ready();
      assert.equal(await panel.getByRole('button', { name: 'Copy all', exact: true }).isDisabled(), true);
      assert.match(await panel.getByRole('status').textContent(), /No terminal output/);
      status = 401; body = { error: 'Your login has expired. Sign in again, then retry.' };
      await panel.getByRole('button', { name: 'Retry', exact: true }).tap(); await ready();
      assert.match(await panel.getByRole('status').textContent(), /login has expired/);
      status = 200; body = { paneId: 'w1:p2', text: 'Recovered' };
      await panel.getByRole('button', { name: 'Retry', exact: true }).tap(); await ready();
      assert.equal(await panel.locator('textarea').inputValue(), 'Recovered');
      await close();
      delayed = true;
      await open();
      await page.waitForFunction(() => document.querySelector('[role=status]').textContent.includes('Loading'));
      await close();
      pending?.(); delayed = false;
      await open(); await ready();
      assert.equal(await panel.locator('textarea').inputValue(), 'Recovered');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('#terminal-copy'));
      assert.deepEqual(errors, []);
      console.log(`Mobile copy browser checks passed (${engine})`);
    } finally { await browser.close(); }
  }
} finally { server.closeAllConnections(); server.close(); }
