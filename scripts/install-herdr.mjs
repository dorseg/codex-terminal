// Resolve GitHub's stable release and require its published asset SHA-256 digest.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

function buildToken() {
  const path = '/run/secrets/github_token';
  return existsSync(path) ? readFileSync(path, 'utf8').trim() : '';
}

export async function installHerdr(targetArch, { token = buildToken(), fetchImpl = fetch, destination = '/usr/local/bin/herdr' } = {}) {
  const architecture = { amd64: 'x86_64', arm64: 'aarch64' }[targetArch];
  if (!architecture) throw Error('Unsupported Herdr architecture');
  async function get(url, json = false) {
    // Only the GitHub API receives the optional build secret, never download hosts.
    const headers = token && new URL(url).origin === 'https://api.github.com'
      ? { authorization: `Bearer ${token}` } : {};
    const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(120000) });
    if (!response.ok) {
      const limited = response.headers.get('x-ratelimit-remaining') === '0' ? ' (GitHub API rate limit exhausted)' : '';
      throw Error(`Herdr download failed: ${response.status} ${url}${limited}`);
    }
    return json ? response.json() : Buffer.from(await response.arrayBuffer());
  }
  const release = await get('https://api.github.com/repos/herdrdev/herdr/releases/latest', true);
  if (release.draft || release.prerelease) throw Error('Expected a stable Herdr release');
  const asset = release.assets.find(a => a.name === `herdr-linux-${architecture}`);
  if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || '')) throw Error('Missing published Herdr SHA-256 checksum');
  const binary = await get(asset.browser_download_url);
  if (`sha256:${createHash('sha256').update(binary).digest('hex')}` !== asset.digest) throw Error('Herdr checksum mismatch');
  writeFileSync(destination, binary, { mode: 0o755 });
  console.log(`Installed Herdr ${release.tag_name} (${asset.name}), SHA-256 verified`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await installHerdr(process.argv[2]);
}
