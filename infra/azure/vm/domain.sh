#!/bin/bash
set -euo pipefail
# Changes only HTTPS/auth services; the terminal container and its processes stay running.
python3 - <<'PY'
import base64,json,os,pathlib,re,shutil,socket,subprocess,tomllib

p=json.loads(base64.b64decode(os.environ.pop('CODEX_VM_PAYLOAD')))
root=pathlib.Path('/etc/codex-terminal')
backup=root/'.domain-change-backup'
files=['Caddyfile','oauth2-proxy.cfg']
compose=['docker','compose','-f',str(root/'compose.json')]

def restart():
    subprocess.run(compose+['up','-d','--no-deps','--force-recreate','auth','https'],
                   check=True,capture_output=True)

def write(name,data):
    target=root/name
    target.write_bytes(data)
    target.chmod(0o400 if name=='oauth2-proxy.cfg' else 0o600)
    if name=='oauth2-proxy.cfg': os.chown(target,65532,65532)

def restore():
    if backup.exists():
        for name in files: write(name,(backup/name).read_bytes())
        restart()
        shutil.rmtree(backup)

if p['action']=='commit':
    shutil.rmtree(backup)
    print('DOMAIN_CHANGE_COMMITTED')
elif p['action']=='rollback':
    restore()
    print('DOMAIN_CHANGE_ROLLED_BACK')
elif p['action']=='apply':
    addresses={item[4][0] for item in socket.getaddrinfo(p['host'],443,family=socket.AF_INET)}
    assert addresses=={p['ip']}, 'Public domain must resolve directly to this VM.'
    assert not backup.exists(), 'A previous domain change needs commit or rollback first.'
    cfg=tomllib.loads((root/'oauth2-proxy.cfg').read_text())
    assert cfg['allowed_groups']==[p['owner']] and cfg['client_id']==p['client']
    assert cfg['cookie_secure'] and cfg['cookie_httponly']
    proxy,count=re.subn(r'^redirect_url\s*=.*$',
                       'redirect_url = '+json.dumps('https://'+p['host']+'/oauth2/callback'),
                       (root/'oauth2-proxy.cfg').read_text(),flags=re.M)
    assert count==1, 'Expected exactly one OIDC redirect URL.'
    assert tomllib.loads(proxy)=={**cfg,'redirect_url':'https://'+p['host']+'/oauth2/callback'}
    backup.mkdir(mode=0o700)
    for name in files:
        (backup/name).write_bytes((root/name).read_bytes())
        (backup/name).chmod(0o600)
    try:
        write('Caddyfile',p['caddy'].encode())
        subprocess.run(compose+['run','--rm','--no-deps','https','caddy','validate',
                               '--config','/etc/caddy/Caddyfile','--adapter','caddyfile'],
                       check=True,capture_output=True)
        write('oauth2-proxy.cfg',proxy.encode())
        restart()
    except Exception:
        restore()
        raise RuntimeError('Domain change failed; previous proxy configuration restored.') from None
    print('CUSTOM_DOMAIN_CONFIGURED')
else:
    raise RuntimeError('Unknown domain operation.')
PY
