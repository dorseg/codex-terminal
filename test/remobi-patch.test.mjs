import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const setup = 'const grid={id:"wt-drawer-grid"};const drawer={backdrop:o,drawer:l,open:d,close:u,isOpen:c};t.open(el),document.documentElement.style.background="black";document.body.appendChild(d.backdrop),document.body.appendChild(d.drawer),await h.runDrawerCreated({drawer:d.drawer});';
test('build patch connects to the drawer object and fails without unique integration points', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'remobi-patch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'bundle.js');
  const patch = () => execFileSync(process.execPath, [resolve('scripts/patch-remobi-client.mjs'), path], { stdio: 'pipe' });
  await writeFile(path, setup);
  patch();
  const patched = await readFile(path, 'utf8');
  assert.ok(patched.includes('t.open(el),installMobileInput(t),document'));
  assert.ok(patched.includes('appendChild(d.drawer),installTerminalCopy(d),await h.runDrawerCreated('));
  assert.ok(patched.includes('drawer.close();'));
  for (const broken of [setup.replace('.open(el)', '.changed(el)'), setup.replace('.backdrop', '.changed'), setup.replace('close:u', 'shutdown:u'), setup.replace('wt-drawer-grid', 'new-grid'), setup + setup]) {
    await writeFile(path, broken);
    assert.throws(patch, /Could not locate/);
    assert.equal(await readFile(path, 'utf8'), broken, 'failure must not partially modify the bundle');
  }
});
