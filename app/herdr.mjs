import { mkdirSync, readFileSync, writeFileSync, lstatSync, realpathSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
export function prepareHerdr(environment = process.env) {
  const env = { ...environment };
  for (const key of Object.keys(env)) {
    if (/^(HERDR_|TMUX(?:_|$)|CODEX_THREAD_ID$|STY$|WINDOW$|ZELLIJ(?:_|$)|AUTH_(USERNAME|PASSWORD|PASSWORD_HASH)$)/.test(key)) delete env[key];
  }
  const home = environment.HOME || homedir();
  env.CODEX_HOME = resolve(environment.CODEX_HOME || join(home, '.codex'));
  const dir = join(env.CODEX_HOME, 'herdr');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const standard = join(environment.XDG_CONFIG_HOME || join(home, '.config'), 'herdr');
  mkdirSync(environment.XDG_CONFIG_HOME || join(home, '.config'), { recursive: true });
  if (standard !== dir) {
    let existing;
    try { existing = lstatSync(standard); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing) {
      if (!existing.isSymbolicLink() || realpathSync(standard) !== realpathSync(dir)) throw Error(`Conflicting Herdr configuration at ${standard}; expected a symlink to ${dir}`);
    } else symlinkSync(dir, standard, 'dir');
  }
  for (const [name, source] of [['config.toml', 'herdr.toml'], ['remobi.config.js', 'remobi.config.js']]) {
    try { writeFileSync(join(dir, name), readFileSync(new URL(source, import.meta.url)), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  env.HERDR_SESSION = 'main';
  env.HERDR_CONFIG_PATH = join(dir, 'config.toml');
  try { execFileSync('herdr', ['integration', 'install', 'codex'], { env, stdio: 'pipe', timeout: 15000 }); }
  catch (error) { throw Error(`Unable to install Herdr Codex integration: ${error.stderr?.toString() || error.message}`); }
  return { env, config: join(dir, 'remobi.config.js') };
}
