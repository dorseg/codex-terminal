import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

for (const [choice, yolo] of [['n', false], ['y', true], ['', null]]) test('Codex chooser dispatch: '+(choice || 'cancel'), async t => {
  const dir = await mkdtemp(join(tmpdir(),'herdr-popup-'));
  t.after(() => rm(dir,{recursive:true,force:true}));
  const preload = join(dir,'preload.mjs');
  await writeFile(preload, `import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
cp.execFileSync = (command,args) => {
 console.log('CALL:'+JSON.stringify({command,args}));
 return JSON.stringify({result:{root_pane:{pane_id:'w2:p9'}}});
}; syncBuiltinESMExports();`);
  const cwd = "/workspace/a'b $(literal)";
  const child = spawn(process.execPath,['--import',preload,resolve('app/popup.mjs'),'codex'],{env:{...process.env,HERDR_ACTIVE_WORKSPACE_ID:'w2',HERDR_ACTIVE_PANE_CWD:cwd}});
  let output='';
  child.stdout.on('data', data => {
    output+=data;
    if(output.includes('cancel: ') && !child.stdin.writableEnded) child.stdin.end(choice+'\n');
  });
  child.stderr.resume();
  assert.equal(await new Promise(resolve => child.on('exit',resolve)),0);
  const calls=[...output.matchAll(/CALL:([^\n]+)/g)].map(match=>JSON.parse(match[1]));
  if(yolo === null) assert.deepEqual(calls,[]);
  else {
    assert.deepEqual(calls[0],{command:'herdr',args:['tab','create','--workspace','w2','--cwd',cwd,'--label','Codex','--focus']});
    assert.deepEqual(calls[1],{command:'herdr',args:['pane','run','w2:p9',"cd -- '/workspace/a'\\''b $(literal)' && exec codex"+(yolo?' --yolo':'')]});
  }
});
