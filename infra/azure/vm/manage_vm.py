#!/usr/bin/env python3
"""Manage the VM deployment without public SSH or a VM managed identity."""
import argparse
import base64
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import urllib.parse

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
from common import Deployment, Failure, az, require, http_json, NoRedirect


def pinned_image(registry, repository, tag):
    if registry == 'registry-1.docker.io':
        token = http_json('https://auth.docker.io/token?service=registry.docker.io&scope=repository:' + repository + ':pull')['token']
        headers = {'Authorization': 'Bearer ' + token}
    else:
        headers = {}
    headers['Accept'] = 'application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json'
    url = f'https://{registry}/v2/{repository}/manifests/{tag}'
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as response:
        raw = response.read()
        digest = 'sha256:' + hashlib.sha256(raw).hexdigest()
        require(response.headers.get('Docker-Content-Digest') == digest, 'Registry manifest digest mismatch.')
    prefix = 'docker.io/' if registry == 'registry-1.docker.io' else registry + '/'
    return prefix + repository + '@' + digest


def proxy_config(tenant, client, owner_oid, hostname, secret, cookie_secret):
    # CoerceClaim in the pinned OAuth2 Proxy supports a scalar OIDC claim as a group
    # list. Using oid makes authorization depend on an immutable tenant object ID.
    settings = {
        'provider': 'oidc',
        'oidc_issuer_url': f'https://login.microsoftonline.com/{tenant}/v2.0',
        'client_id': client,
        'client_secret': secret,
        'redirect_url': f'https://{hostname}/oauth2/callback',
        'scope': 'openid profile',
        'user_id_claim': 'oid',
        'oidc_email_claim': 'oid',
        'oidc_groups_claim': 'oid',
        'allowed_groups': [owner_oid],
        'email_domains': ['*'],
        'skip_claims_from_profile_url': True,
        'insecure_oidc_skip_nonce': False,
        'code_challenge_method': 'S256',
        'http_address': '127.0.0.1:4180',
        'upstreams': ['http://127.0.0.1:7681/'],
        'reverse_proxy': True,
        'pass_host_header': True,
        'proxy_websockets': True,
        'skip_provider_button': True,
        'cookie_name': '__Host-codex_terminal',
        'cookie_secret': cookie_secret,
        'cookie_secure': True,
        'cookie_httponly': True,
        'cookie_samesite': 'lax',
        'cookie_expire': '4h',
        'cookie_refresh': '0',
        'pass_access_token': False,
        'pass_authorization_header': False,
        'set_authorization_header': False,
        'pass_basic_auth': False,
        'pass_user_headers': False,
        'request_logging': False,
        'auth_logging': True,
        'standard_logging': True,
    }
    return '\n'.join(f'{key} = {json.dumps(value)}' for key, value in settings.items()) + '\n'


def compose(images, size):
    require(size in ['Standard_B1ms', 'Standard_B2als_v2'], 'Unsupported VM size.')
    small = size == 'Standard_B1ms'
    return {
        'name': 'codex-terminal',
        'services': {
            'terminal': {
                'image': images['terminal'], 'user': '1000:1000', 'restart': 'unless-stopped',
                'ports': ['127.0.0.1:7681:7681'],
                'volumes': ['/srv/codex-terminal/workspace:/workspace',
                            '/srv/codex-terminal/codex-config:/home/node/.codex'],
                'cap_drop': ['ALL'],
                'security_opt': ['no-new-privileges:true', 'seccomp=/etc/codex-terminal/seccomp.json',
                                 'apparmor=codex-terminal'],
                'mem_limit': '1280m' if small else '3g',
                'memswap_limit': '1280m' if small else '3g',
                'cpus': 0.9 if small else 1.8,
                'pids_limit': 512,
            },
            'auth': {
                'image': images['auth'], 'user': '65532:65532', 'restart': 'unless-stopped',
                'network_mode': 'host', 'read_only': True, 'cap_drop': ['ALL'],
                'security_opt': ['no-new-privileges:true'],
                'command': ['--config=/etc/oauth2-proxy.cfg'],
                'volumes': ['/etc/codex-terminal/oauth2-proxy.cfg:/etc/oauth2-proxy.cfg:ro'],
                'tmpfs': ['/tmp:rw,noexec,nosuid,size=16m,mode=1777'], 'mem_limit': '128m',
            },
            'https': {
                'image': images['https'], 'restart': 'unless-stopped', 'network_mode': 'host',
                'read_only': True, 'cap_drop': ['ALL'], 'cap_add': ['NET_BIND_SERVICE'],
                'security_opt': ['no-new-privileges:true'],
                'volumes': ['/etc/codex-terminal/Caddyfile:/etc/caddy/Caddyfile:ro',
                            '/srv/codex-terminal/caddy-data:/data', '/srv/codex-terminal/caddy-config:/config'],
                'mem_limit': '128m',
            },
        },
    }


def public_hostname(config, state):
    host = config.get('customDomain') or state['vm']['hostName']
    require(isinstance(host, str) and len(host) <= 253 and '.' in host and
            all(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', part)
                for part in host.split('.')), 'Supply a lowercase DNS hostname without a scheme, port or path.')
    return host


def caddy_config(host, azure_host, email):
    config = f'''{{
    admin off
    email {email}
    servers {{
        protocols h1 h2
    }}
}}
{host} {{
    tls {{
        protocols tls1.2 tls1.3
    }}
    header Strict-Transport-Security "max-age=31536000"
    reverse_proxy 127.0.0.1:4180 {{
        header_up X-Forwarded-Proto https
        header_up X-Forwarded-Host {{host}}
        header_up -X-Auth-Request-User
        header_up -X-Auth-Request-Email
        header_up -X-Forwarded-User
    }}
}}
'''
    if azure_host != host:
        config += f'''{azure_host} {{
    tls {{
        protocols tls1.2 tls1.3
    }}
    redir https://{host}{{uri}} permanent
}}
'''
    return config


class VM(Deployment):
    @property
    def vm_path(self):
        return self.state['vm']['vmId']

    def run(self, name, script, protected=None, timeout=900):
        path = self.vm_path + '/runCommands/' + name
        body = {'location': self.config['location'], 'properties': {
            'source': {'script': script + '\n# invocation ' + str(time.time_ns()) + '\n'}, 'asyncExecution': False,
            'timeoutInSeconds': timeout, 'treatFailureAsDeploymentFailure': True,
            'protectedParameters': [] if protected is None else [{'name': 'CODEX_VM_PAYLOAD', 'value': protected}],
            'parameters': [],
        }}
        self.arm(path, 'PUT', body, api='2024-11-01')
        deadline = time.monotonic() + timeout + 120
        url = f'https://management.azure.com{path}?api-version=2024-11-01&$expand=instanceView'
        while time.monotonic() < deadline:
            result = http_json(url, headers={'Authorization': 'Bearer ' + self.token('https://management.azure.com/')})
            view = result['properties'].get('instanceView', {})
            state = view.get('executionState')
            if state in ['Succeeded', 'Failed', 'Canceled', 'TimedOut']:
                # Never dump a failed script's output when it carried protected arguments.
                if state != 'Succeeded' or view.get('exitCode') != 0:
                    if protected is None:
                        print(view.get('output', '')[-3000:])
                        print(view.get('error', '')[-3000:], file=sys.stderr)
                    raise Failure(f'VM operation {name} failed; state={state}, exit={view.get("exitCode")}.')
                return view.get('output', '')
            time.sleep(5)
        raise Failure(f'VM operation {name} did not finish within its timeout.')

    def provision(self):
        self.preflight()
        c = self.config
        for provider in ['Microsoft.Compute', 'Microsoft.Network', 'Microsoft.RecoveryServices', 'Microsoft.Insights', 'Microsoft.Consumption']:
            status = az('provider', 'show', '--namespace', provider, '--subscription', c['subscriptionId'])
            if status['registrationState'] != 'Registered':
                az('provider', 'register', '--namespace', provider, '--wait', '--subscription', c['subscriptionId'])
        exists = az('group', 'exists', '--name', c['resourceGroup'], '--subscription', c['subscriptionId'])
        if exists:
            group = az('group', 'show', '--name', c['resourceGroup'], '--subscription', c['subscriptionId'])
            require(group.get('tags', {}).get('application') == 'codex-terminal', 'Existing RG is not owned by this deployment.')
        else:
            az('group', 'create', '--name', c['resourceGroup'], '--location', c['location'],
               '--tags', 'application=codex-terminal', 'hosting=vm', '--subscription', c['subscriptionId'])
        self.identity()
        self.state['image'] = self.image()
        self.save()
        public_key = self.directory / 'vm-admin-key.pub'
        if not public_key.exists():
            subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'codex-terminal-vm',
                            '-f', str(self.directory / 'vm-admin-key')], check=True)
        parameters = {
            'location': self.config['location'], 'prefix': self.config['prefix'],
            'vmSize': self.config.get('vmSize', 'Standard_B1ms'),
            'adminPublicKey': public_key.read_text().strip(), 'contactEmail': self.config['contactEmail'],
            'monthlyBudget': self.config.get('monthlyBudget', 100),
            'budgetStartDate': dt.datetime.now(dt.timezone.utc).strftime('%Y-%m-01T00:00:00Z'),
            'imageVersion': self.config.get('imageVersion', '0.20261026.2643'),
            'backupSnapshotResourceGroup': self.config.get('backupSnapshotResourceGroup',
                                                         'AzureBackupRG_' + self.config['location'] + '_1'),
        }
        fd, filename = tempfile.mkstemp(dir=self.directory, suffix='.json')
        try:
            with os.fdopen(fd, 'w') as stream:
                json.dump({'parameters': {k: {'value': v} for k, v in parameters.items()}}, stream)
            result = az('deployment', 'group', 'create', '--name', 'codex-terminal-vm',
                        '--resource-group', self.config['resourceGroup'], '--template-file', str(HERE / 'main.bicep'),
                        '--parameters', '@' + filename, '--subscription', self.config['subscriptionId'])
            self.state.setdefault('vm', {}).update({k: v['value'] for k, v in result['properties']['outputs'].items()})
            self.save()
        finally:
            os.unlink(filename)
        print(self.config.get('vmSize', 'Standard_B1ms') + ' infrastructure provisioned. No public SSH; no managed identity.')

    def configure(self):
        self.preflight()
        print(self.mfa(), flush=True)
        host = public_hostname(self.config, self.state)
        registration = self.graph('applications/' + self.state['applicationObjectId'])
        callbacks = registration['web'].get('redirectUris', [])
        callback = f'https://{host}/oauth2/callback'
        web = {**registration['web'], 'redirectUris': list(dict.fromkeys(callbacks + [callback]))}
        web['implicitGrantSettings'] = {'enableAccessTokenIssuance': False, 'enableIdTokenIssuance': False}
        self.graph('applications/' + self.state['applicationObjectId'], 'PATCH', {'web': web})
        images = self.state['vm'].get('images') or {
            'terminal': self.state['image'],
            'auth': pinned_image('quay.io', 'oauth2-proxy/oauth2-proxy', 'v7.15.6'),
            'https': pinned_image('registry-1.docker.io', 'library/caddy', '2.11.9'),
        }
        images['terminal'] = self.image()
        self.state['image'] = images['terminal']
        self.state['vm']['images'] = images
        self.save()
        secret = self.credential()
        # Keep an encrypted cookie key on the VM; local state contains neither key nor client secret.
        cookie_secret = base64.urlsafe_b64encode(secrets.token_bytes(32)).decode()
        proxy = proxy_config(self.config['tenantId'], self.state['clientId'], self.state['userObjectId'],
                             host, secret, cookie_secret)
        caddy = caddy_config(host, self.state['vm']['hostName'], self.config['contactEmail'])
        files = {
            'compose.json': json.dumps(compose(images, self.config.get('vmSize', 'Standard_B1ms')), indent=2),
            'oauth2-proxy.cfg': proxy, 'Caddyfile': caddy,
            'seccomp.json': (HERE / 'seccomp.json').read_text(),
            'apparmor.profile': (HERE / 'apparmor.profile').read_text(),
            'network-rules.sh': (HERE / 'network-rules.sh').read_text(),
            'boot-guards.sh': (HERE / 'boot-guards.sh').read_text(),
            'codex-config.py': (HERE / 'codex-config.py').read_text(),
        }
        payload = base64.b64encode(json.dumps({'files': {
            name: base64.b64encode(value.encode()).decode() for name, value in files.items()}}).encode()).decode()
        print('Installing pinned images and proxy configuration through protected Run Command...', flush=True)
        output = self.run('configure-terminal', (HERE / 'configure.sh').read_text(), payload)
        require('CONFIGURATION_INSTALLED' in output, 'VM configuration did not report completion.')
        self.state['vm']['url'] = 'https://' + host
        self.state['vm']['configuredAt'] = dt.datetime.now(dt.timezone.utc).isoformat()
        self.save()
        print('Configured: ' + self.state['vm']['url'])

    def set_domain(self, domain):
        self.preflight()
        host = public_hostname({**self.config, 'customDomain': domain}, self.state)
        registration_path = 'applications/' + self.state['applicationObjectId']

        def patch_web(value):
            # PATCH is idempotent; retry transient transport failures without
            # retrying credential-creation POSTs or weakening authorization.
            for attempt in range(3):
                try:
                    self.graph(registration_path, 'PATCH', {'web': value})
                    return
                except urllib.error.HTTPError as error:
                    if error.code not in [429, 500, 502, 503, 504] or attempt == 2:
                        raise
                except (ConnectionError, TimeoutError, urllib.error.URLError):
                    if attempt == 2:
                        raise
                time.sleep(2 ** attempt)

        registration = self.graph(registration_path)
        require(registration['signInAudience'] == 'AzureADMyOrg', 'Entra registration must remain single tenant.')
        principal = self.graph('servicePrincipals/' + self.state['servicePrincipalId'])
        assignments = self.collection('servicePrincipals/' + self.state['servicePrincipalId'] + '/appRoleAssignedTo')
        require(principal['appRoleAssignmentRequired'] and len(assignments) == 1 and
                assignments[0]['principalId'] == self.state['userObjectId'], 'Owner-only Entra assignment changed.')
        callback = 'https://' + host + '/oauth2/callback'
        web = {**registration['web'], 'redirectUris': list(dict.fromkeys(registration['web']['redirectUris'] + [callback]))}
        patch_web(web)
        payload = {'action': 'apply', 'host': host, 'ip': self.state['vm']['ipAddress'],
                   'owner': self.state['userObjectId'], 'client': self.state['clientId'],
                   'caddy': caddy_config(host, self.state['vm']['hostName'], self.config['contactEmail'])}

        def operate(action):
            body = {**payload, 'action': action}
            return self.run('custom-domain-' + action, (HERE / 'domain.sh').read_text(),
                            base64.b64encode(json.dumps(body).encode()).decode(), timeout=300)

        try:
            print(operate('apply'), flush=True)
            print('Waiting for the public certificate and checking the new Entra redirect...', flush=True)
            deadline = time.monotonic() + 180
            while True:
                try:
                    self.check_https(url='https://' + host)
                    break
                except (Failure, OSError):
                    if time.monotonic() >= deadline:
                        raise
                    time.sleep(5)
            patch_web({**web, 'redirectUris': [callback]})
        except Exception:
            operate('rollback')
            patch_web(registration['web'])
            raise
        self.config['customDomain'] = host
        self.config_path.write_text(json.dumps(self.config, indent=2) + '\n')
        self.state['vm']['url'] = 'https://' + host
        self.state['vm']['customDomainConfiguredAt'] = dt.datetime.now(dt.timezone.utc).isoformat()
        self.state['activeUrl'] = self.state['vm']['url']
        self.save()
        print(operate('commit'), flush=True)
        print('Custom domain ready: ' + self.state['vm']['url'] + '. Terminal container was not restarted.')

    def verify(self):
        self.preflight()
        print(self.mfa(), flush=True)
        machine = self.arm(self.vm_path, api='2024-11-01')
        require(machine['properties']['hardwareProfile']['vmSize'] in ['Standard_B1ms', 'Standard_B2als_v2'], 'Unexpected VM size.')
        require(not machine.get('identity', {}).get('principalId') and not machine.get('identity', {}).get('userAssignedIdentities'), 'VM must have no managed identity.')
        interfaces = machine['properties']['networkProfile']['networkInterfaces']
        require(len(interfaces) == 1, 'Unexpected VM network interfaces.')
        interface = self.arm(interfaces[0]['id'], api='2024-05-01')
        addresses = interface['properties']['ipConfigurations']
        require(len(addresses) == 1 and addresses[0]['properties']['subnet']['id'].lower() ==
                self.state['vm']['subnetId'].lower(), 'VM no longer uses the verified subnet.')
        address = self.arm(addresses[0]['properties']['publicIPAddress']['id'], api='2024-05-01')
        require(address['properties']['ipAddress'] == self.state['vm']['ipAddress'], 'Unexpected public IP.')
        subnet = self.arm(self.state['vm']['subnetId'], api='2024-05-01')
        firewall = self.arm(subnet['properties']['networkSecurityGroup']['id'], api='2024-05-01')
        rules = [rule['properties'] for rule in firewall['properties']['securityRules']
                 if rule['properties']['direction'] == 'Inbound']
        deny = [rule for rule in rules if rule['access'] == 'Deny' and rule['protocol'] == '*' and
                rule.get('sourceAddressPrefix') == '*' and rule.get('destinationAddressPrefix') == '*' and
                rule.get('sourcePortRange') == '*' and rule.get('destinationPortRange') == '*']
        require(deny, 'Explicit deny-all inbound NSG rule missing.')
        for rule in rules:
            if rule['access'] == 'Allow':
                require(rule['protocol'].lower() == 'tcp' and rule.get('destinationPortRange') in ['80', '443']
                        and rule['priority'] < min(item['priority'] for item in deny),
                        'Unexpected public or private inbound NSG allow rule.')
        registration = self.graph('applications/' + self.state['applicationObjectId'])
        require(registration['signInAudience'] == 'AzureADMyOrg', 'Entra application must remain single tenant.')
        require(self.state['vm']['url'] + '/oauth2/callback' in registration['web']['redirectUris'], 'VM callback missing.')
        principal = self.graph('servicePrincipals/' + self.state['servicePrincipalId'])
        require(principal['appRoleAssignmentRequired'] is True, 'Entra assignment is not required.')
        assignments = self.collection('servicePrincipals/' + self.state['servicePrincipalId'] + '/appRoleAssignedTo')
        require(len(assignments) == 1 and assignments[0]['principalId'] == self.state['userObjectId'], 'Unexpected enterprise app assignment.')
        script = '''#!/bin/bash
set -eu
cd /etc/codex-terminal
docker compose -f compose.json ps
docker compose -f compose.json exec -T terminal sh -c 'test "$(id -u)" = 1000; codex sandbox -- /bin/sh -c "echo INNER_SANDBOX_OK"'
docker compose -f compose.json exec -T terminal sh -c 'test ! -S /var/run/docker.sock; test ! -e /etc/oauth2-proxy.cfg'
docker compose -f compose.json exec -T terminal sh -c 'touch /home/node/.codex/.sandbox-control; rm /home/node/.codex/.sandbox-control; if codex sandbox -- /bin/sh -c "touch /home/node/.codex/.sandbox-deny-check"; then rm -f /home/node/.codex/.sandbox-deny-check; exit 1; fi; test ! -e /home/node/.codex/.sandbox-deny-check; echo INNER_SANDBOX_WRITE_DENIED'
docker compose -f compose.json exec -T terminal sh -c 'if curl -fsS --max-time 3 -o /dev/null -H Metadata:true "http://169.254.169.254/metadata/instance?api-version=2021-02-01"; then exit 1; fi; echo AZURE_METADATA_BLOCKED'
python3 - <<'PY'
import json,subprocess,tomllib
c=json.loads(subprocess.check_output(['docker','compose','-f','compose.json','config','--format','json']))
t=c['services']['terminal']
assert t['user']=='1000:1000' and t.get('privileged') is not True
assert t['cap_drop']==['ALL']
assert len(t['ports'])==1 and t['ports'][0]['host_ip']=='127.0.0.1'
assert not t.get('environment')
ids=subprocess.check_output(['docker','compose','-f','compose.json','ps','-q']).decode().split()
assert len(ids)==3
for item in json.loads(subprocess.check_output(['docker','inspect',*ids])):
 assert item['State']['Running'] and not item['State']['Restarting']
 if item['Config']['Labels'].get('com.docker.compose.service')=='terminal':
  assert item['HostConfig']['CapDrop']==['ALL'] and not item['HostConfig']['Privileged']
  assert item['AppArmorProfile']=='codex-terminal'
  assert 'no-new-privileges:true' in item['HostConfig']['SecurityOpt']
  assert any(opt.startswith('seccomp=') and 'unconfined' not in opt for opt in item['HostConfig']['SecurityOpt'])
  assert item['HostConfig']['PortBindings']['7681/tcp'][0]['HostIp']=='127.0.0.1'
  assert {m['Source'] for m in item['Mounts']}=={'/srv/codex-terminal/workspace','/srv/codex-terminal/codex-config'}
cfg=tomllib.load(open('/etc/codex-terminal/oauth2-proxy.cfg','rb'))
assert cfg['provider']=='oidc' and cfg['oidc_groups_claim']=='oid'
assert cfg['cookie_secure'] and cfg['cookie_httponly'] and not cfg['insecure_oidc_skip_nonce']
assert cfg['code_challenge_method']=='S256' and not cfg['pass_access_token']
print('OUTER_CONTAINER_BOUNDARIES_OK')
PY
'''
        identity_assert = ('\npython3 - <<\'IDENTITY\'\nimport tomllib\n'
                           'c=tomllib.load(open("/etc/codex-terminal/oauth2-proxy.cfg","rb"))\n'
                           f'assert c["allowed_groups"]=={[self.state["userObjectId"]]!r}\n'
                           f'assert c["client_id"]=={self.state["clientId"]!r}\n'
                           f'assert c["oidc_issuer_url"]=={"https://login.microsoftonline.com/"+self.config["tenantId"]+"/v2.0"!r}\n'
                           'print("IMMUTABLE_OWNER_ID_ALLOWLIST_OK")\nIDENTITY\n')
        output = self.run('verify-terminal', script + identity_assert)
        print(output)
        self.check_https()
        self.state['vm']['verifiedAt'] = dt.datetime.now(dt.timezone.utc).isoformat()
        self.save()

    def check_https(self, url=None):
        url = url or self.state['vm']['url']
        opener = urllib.request.build_opener(NoRedirect())
        for path, headers in [('/', {}), ('/token', {}), ('/ws', {
                'Connection': 'Upgrade', 'Upgrade': 'websocket', 'Sec-WebSocket-Version': '13',
                'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ=='}),
                ('/', {'X-Auth-Request-User': self.state['userObjectId'],
                       'Cookie': '__Host-codex_terminal=forged'})]:
            try:
                response = opener.open(urllib.request.Request(url + path, headers=headers), timeout=20)
            except urllib.error.HTTPError as error:
                response = error
            location = response.headers.get('Location', '')
            target = urllib.parse.urlsplit(location)
            query = urllib.parse.parse_qs(target.query)
            require(response.code in [302, 303, 307] and target.hostname == 'login.microsoftonline.com' and
                    target.path.startswith('/' + self.config['tenantId'] + '/') and
                    query.get('client_id') == [self.state['clientId']] and
                    query.get('redirect_uri') == [url + '/oauth2/callback'],
                    'Anonymous HTTP/WebSocket bypass or wrong issuer/callback detected.')
            response.close()
        print('Public TLS, Entra redirects, anonymous WebSocket and forged-cookie rejection verified.')

    def test_proxy(self):
        images = self.state['vm']['images']
        owner = self.state['userObjectId']
        config = proxy_config('test-tenant', 'test-client', owner, 'test.invalid', 'test-only',
                              base64.urlsafe_b64encode(secrets.token_bytes(32)).decode())
        config = config.replace('https://login.microsoftonline.com/test-tenant/v2.0', 'http://127.0.0.1:19000')
        config = config.replace('https://test.invalid/oauth2/callback', 'http://127.0.0.1:14181/oauth2/callback')
        config = config.replace('127.0.0.1:4180', '127.0.0.1:14181').replace('127.0.0.1:7681', '127.0.0.1:19000')
        config = config.replace('cookie_secure = true', 'cookie_secure = false').replace('__Host-codex_terminal', 'codex_test')
        files = {'issuer.mjs': (HERE / 'test-issuer.mjs').read_text(),
                 'flow.py': (HERE / 'test-proxy-flow.py').read_text(), 'test.cfg': config}
        # The embedded payload contains only synthetic test credentials and public configuration.
        payload = base64.b64encode(json.dumps(files).encode()).decode()
        script = f'''#!/bin/bash
set -euo pipefail
testdir=$(mktemp -d /run/codex-auth-test.XXXXXX)
chmod 755 "$testdir"
issuer_name=codex-test-issuer-$$
auth_name=codex-test-auth-$$
cleanup() {{ docker rm -f "$auth_name" "$issuer_name" >/dev/null 2>&1 || true; rm -rf "$testdir"; }}
trap cleanup EXIT
printf '%s' '{payload}' | base64 -d | python3 -c 'import json,sys,pathlib; root=pathlib.Path(sys.argv[1]); [(root/k).write_text(v) for k,v in json.load(sys.stdin).items()]' "$testdir"
chmod 644 "$testdir"/*
docker run -d --name "$issuer_name" --network host --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges \
  --entrypoint node -e OWNER_OID={owner} -v "$testdir:/test:ro" {images['terminal']} /test/issuer.mjs >/dev/null
for attempt in $(seq 1 30); do curl -fsS http://127.0.0.1:19000/keys >/dev/null 2>&1 && break; sleep 1; done
docker run -d --name "$auth_name" --network host --user 65532:65532 --cap-drop ALL --security-opt no-new-privileges \
  --read-only --tmpfs /tmp -v "$testdir/test.cfg:/etc/test.cfg:ro" {images['auth']} --config=/etc/test.cfg >/dev/null
for attempt in $(seq 1 30); do curl -fsS http://127.0.0.1:14181/ping >/dev/null 2>&1 && break; sleep 1; done
python3 "$testdir/flow.py"
'''
        output = self.run('proxy-integration-tests', script, timeout=240)
        require('PROXY_IDENTITY_SIGNATURE_ISSUER_AUDIENCE_NONCE_TESTS_PASSED' in output, 'Missing identity test completion marker.')
        print(output)
        self.state['vm']['proxyTestsPassedAt'] = dt.datetime.now(dt.timezone.utc).isoformat()
        self.save()

    def runtime_check(self):
        self.preflight()
        script = base64.b64encode((HERE.parent / 'runtime-check.sh').read_bytes()).decode()
        output = self.run('runtime-file-check', '#!/bin/bash\nset -euo pipefail\nprintf %s ' + script +
                          ' | base64 -d | docker compose -f /etc/codex-terminal/compose.json exec -T terminal sh\n')
        require('configuration checks passed.' in output, 'Runtime check did not complete.')
        print(output)

    def resize(self, size):
        self.preflight()
        print(self.mfa(), flush=True)
        require(size in ['Standard_B1ms', 'Standard_B2als_v2'], 'Unsupported size.')
        name = self.state['vm']['vmName']
        shared = ['--resource-group', self.config['resourceGroup'], '--name', name,
                  '--subscription', self.config['subscriptionId']]
        previous = self.arm(self.vm_path, api='2024-11-01')['properties']['hardwareProfile']['vmSize']
        print('Stopping VM for resize; active terminal processes will end.', flush=True)
        az('vm', 'deallocate', *shared)
        try:
            az('vm', 'resize', *shared, '--size', size)
            az('vm', 'start', *shared)
        except Failure:
            print('Resize failed; restoring the previous size and starting the VM.', flush=True)
            az('vm', 'resize', *shared, '--size', previous)
            az('vm', 'start', *shared)
            raise
        self.config['vmSize'] = size
        self.config_path.write_text(json.dumps(self.config, indent=2) + '\n')
        limits = compose(self.state['vm']['images'], size)['services']['terminal']
        script = ('#!/bin/bash\nset -eu\ncd /etc/codex-terminal\npython3 - <<\'LIMITS\'\n'
                  'import json\np="compose.json"\nc=json.load(open(p))\n'
                  f'c["services"]["terminal"].update({{k:v for k,v in {limits!r}.items() if k in ["mem_limit","memswap_limit","cpus"]}})\n'
                  'open(p,"w").write(json.dumps(c,indent=2))\nLIMITS\n'
                  'docker compose -f compose.json up -d terminal\n')
        self.run('resize-container-limits', script)
        self.verify()
        print('VM and terminal limits resized; persistent files retained.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['provision', 'configure', 'verify', 'preflight', 'runtime-check', 'test-proxy', 'resize', 'set-domain'])
    parser.add_argument('--config', default=str(HERE.parent / '.azure/config.json'))
    parser.add_argument('--size', choices=['Standard_B1ms', 'Standard_B2als_v2'])
    parser.add_argument('--domain')
    args = parser.parse_args()
    deployment = VM(args.config)
    if args.command == 'set-domain':
        require(args.domain, 'Supply --domain.')
        deployment.set_domain(args.domain)
    elif args.command == 'resize':
        require(args.size, 'Supply --size.')
        deployment.resize(args.size)
    elif args.command == 'runtime-check':
        deployment.runtime_check()
    elif args.command == 'test-proxy':
        deployment.test_proxy()
    else:
        getattr(deployment, args.command)()


if __name__ == '__main__':
    try:
        main()
    except urllib.error.HTTPError as error:
        print(f'ERROR: Azure/registry API returned HTTP {error.code}; no response body or credentials printed.', file=sys.stderr)
        sys.exit(1)
    except (Failure, ValueError, KeyError, OSError) as error:
        print(f'ERROR: {error}', file=sys.stderr)
        sys.exit(1)
