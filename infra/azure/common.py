#!/usr/bin/env python3
"""Shared account, identity and private-state helpers for the Azure VM example."""
import base64
import datetime as dt
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.request
import uuid

API = '2024-11-01'
ARM = 'https://management.azure.com'
GRAPH = 'https://graph.microsoft.com/v1.0'


class Failure(RuntimeError):
    pass


def require(condition, message):
    if not condition:
        raise Failure(message)


def az(*args):
    """Never log arguments: parameters and CLI results may contain secrets."""
    executable = shutil.which('az')
    require(executable, 'Azure CLI is required (az).')
    result = subprocess.run([executable, *args, '--only-show-errors', '-o', 'json'],
                            capture_output=True, text=True)
    if result.returncode:
        # Suppress arbitrary CLI output: failed deployment responses may echo secret values.
        codes = list(dict.fromkeys(re.findall(r'"code"\s*:\s*"([A-Za-z0-9_.-]+)"', result.stderr)))
        raise Failure(f'Azure CLI {" ".join(args[:2])} failed (exit {result.returncode}). '
                      + ('Azure codes: ' + ', '.join(codes) + '. ' if codes else '') +
                      'Check Azure sign-in, permissions, regional eligibility, or deployment Operations.')
    return json.loads(result.stdout) if result.stdout.strip() else None


def claims(token):
    try:
        part = token.split('.')[1]
        return json.loads(base64.urlsafe_b64decode(part + '=' * (-len(part) % 4)))
    except (IndexError, ValueError) as error:
        raise Failure('Azure CLI returned a token without readable tenant claims.') from error


def http_json(url, *, method='GET', body=None, headers=None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(url, data=data, method=method,
                                     headers={'Content-Type': 'application/json', **(headers or {})})
    with urllib.request.urlopen(request, timeout=60) as response:
        raw = response.read()
        return json.loads(raw) if raw else {}


def validate_config(config):
    for key in ['subscriptionId', 'tenantId']:
        try:
            uuid.UUID(config[key])
        except (KeyError, ValueError, TypeError) as error:
            raise Failure(f'Supply a valid {key}.') from error
    for key in ['userEmail', 'contactEmail']:
        require(re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', config.get(key, '')), f'Supply {key}.')
    require(re.fullmatch(r'[a-z][a-z0-9-]{1,18}[a-z0-9]', config.get('prefix', '')),
            'prefix must have 3–20 lowercase letters, digits, or hyphens.')
    require(re.fullmatch(r'[A-Za-z0-9_-]{1,80}', config.get('resourceGroup', '')),
            'Supply a simple resourceGroup name.')
    require(re.fullmatch(r'[a-z0-9]+', config.get('location', '')), 'Supply an Azure region code.')
    require(type(config.get('monthlyBudget', 100)) is int and config.get('monthlyBudget', 100) > 0,
            'monthlyBudget must be a positive integer in the subscription billing currency.')


class Deployment:
    def __init__(self, config_path):
        self.config_path = Path(config_path).resolve()
        self.config = json.loads(self.config_path.read_text())
        validate_config(self.config)
        self.directory = self.config_path.parent
        require('.azure' in self.directory.parts, 'Keep private configuration and state under .azure/.')
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.directory.chmod(0o700)
        self.config_path.chmod(0o600)
        self.state_path = self.directory / 'state.json'
        self.state = json.loads(self.state_path.read_text()) if self.state_path.exists() else {}
        for key in ['subscriptionId', 'tenantId', 'resourceGroup', 'prefix']:
            require(key not in self.state or self.state[key] == self.config[key],
                    f'State belongs to a different {key}; use another .azure directory.')
        self.tokens = {}

    def save(self):
        self.state.update({k: self.config[k] for k in ['subscriptionId', 'tenantId', 'resourceGroup', 'prefix']})
        fd, name = tempfile.mkstemp(dir=self.directory)
        try:
            with os.fdopen(fd, 'w') as stream:
                json.dump(self.state, stream, indent=2)
                stream.write('\n')
            os.replace(name, self.state_path)
        finally:
            if os.path.exists(name):
                os.unlink(name)

    def token(self, resource):
        if resource not in self.tokens:
            value = az('account', 'get-access-token', '--subscription', self.config['subscriptionId'],
                       '--resource', resource)['accessToken']
            require(claims(value).get('tid') == self.config['tenantId'], 'Refusing a token for another tenant.')
            self.tokens[resource] = value
        return self.tokens[resource]

    def graph(self, path, method='GET', body=None):
        url = path if path.startswith(GRAPH + '/') else GRAPH + '/' + path.lstrip('/')
        require(url.startswith(GRAPH + '/'), 'Unexpected Graph URL.')
        return http_json(url, method=method, body=body,
                         headers={'Authorization': 'Bearer ' + self.token('https://graph.microsoft.com/')})

    def collection(self, path):
        result, rows = self.graph(path), []
        while True:
            rows.extend(result.get('value', []))
            if '@odata.nextLink' not in result:
                return rows
            result = self.graph(result['@odata.nextLink'])

    def arm(self, path, method='GET', body=None, api=API):
        require(path.startswith(f'/subscriptions/{self.config["subscriptionId"]}/'),
                'ARM operation targets another subscription.')
        return http_json(f'{ARM}{path}?api-version={api}', method=method, body=body,
                         headers={'Authorization': 'Bearer ' + self.token('https://management.azure.com/')})

    def preflight(self):
        c = self.config
        account = az('account', 'show', '--subscription', c['subscriptionId'])
        require(account['tenantId'] == c['tenantId'] and account['state'] == 'Enabled',
                'Subscription tenant mismatch or subscription disabled.')
        require(account['user']['name'].lower() == c['userEmail'].lower(),
                'Subscription is signed in as another user; sign in with the intended personal account.')
        require(account.get('environmentName') == 'AzureCloud', 'This deployment targets Azure public cloud.')
        user = self.graph('me?$select=id,userPrincipalName')
        require('userObjectId' not in self.state or self.state['userObjectId'] == user['id'],
                'Signed-in user differs from the previously allowlisted identity.')
        self.state['userObjectId'] = user['id']
        self.save()
        print(f'Account verified: {account["name"]}; region: {c["location"]}; user object: {user["id"]}', flush=True)
        return user

    def mfa(self):
        evidence = self.config.get('mfaEvidence') or {}
        try:
            policy = self.graph('policies/identitySecurityDefaultsEnforcementPolicy')
        except urllib.error.HTTPError as error:
            if error.code != 403:
                raise
            policy = None
        if policy and policy.get('isEnabled') is True:
            return 'Security Defaults enabled (verified through Graph)'
        # The CLI's Graph delegated scopes may not include Policy.Read.All, even for a Global Admin.
        if policy is None and evidence.get('type') == 'security-defaults' and evidence.get('confirmedEnabled') is True:
            try:
                checked = dt.datetime.fromisoformat(evidence['checkedAt'].replace('Z', '+00:00'))
                age = dt.datetime.now(dt.timezone.utc) - checked
                require(dt.timedelta(0) <= age <= dt.timedelta(hours=24), 'Refresh the Security Defaults check (24 hours).')
            except (KeyError, ValueError, TypeError) as error:
                raise Failure('Supply a recent UTC checkedAt value for the portal MFA verification.') from error
            return 'Security Defaults enabled (user verified in Entra portal; Graph policy read unavailable)'
        raise Failure('MFA prerequisite unresolved. Verify Security Defaults in Entra and record fresh '
                      'mfaEvidence; configuration is stopped. Do not change tenant-wide policies automatically.')

    def image(self):
        configured = self.config.get('image') or self.state.get('image')
        if configured:
            require(re.fullmatch(r'ghcr\.io/dorseg/codex-terminal@sha256:[0-9a-f]{64}', configured),
                    'image must pin the upstream GHCR image by SHA256 digest.')
            return configured
        token_url = 'https://ghcr.io/token?service=ghcr.io&scope=repository:dorseg/codex-terminal:pull'
        token = http_json(token_url)['token']
        req = urllib.request.Request('https://ghcr.io/v2/dorseg/codex-terminal/manifests/latest', headers={
            'Authorization': 'Bearer ' + token,
            'Accept': 'application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json'})
        with urllib.request.urlopen(req, timeout=30) as response:
            raw = response.read()
            digest = 'sha256:' + hashlib.sha256(raw).hexdigest()
            require(response.headers.get('Docker-Content-Digest') == digest, 'Image manifest digest mismatch.')
            manifest = json.loads(raw)
            require(any(m.get('platform', {}).get('architecture') == 'amd64' and
                        m.get('platform', {}).get('os') == 'linux' for m in manifest.get('manifests', [])),
                    'Published image does not contain linux/amd64.')
        return 'ghcr.io/dorseg/codex-terminal@' + digest

    def identity(self):
        if 'applicationObjectId' not in self.state:
            app = self.graph('applications', 'POST', {
                'displayName': self.config['prefix'] + '-personal',
                'signInAudience': 'AzureADMyOrg',
                'web': {'implicitGrantSettings': {'enableIdTokenIssuance': False, 'enableAccessTokenIssuance': False}},
                'requiredResourceAccess': []})
            self.state.update(applicationObjectId=app['id'], clientId=app['appId'])
            self.save()
        app = self.graph('applications/' + self.state['applicationObjectId'])
        require(app['appId'] == self.state['clientId'] and app['signInAudience'] == 'AzureADMyOrg',
                'Saved app registration no longer matches this deployment.')
        if 'servicePrincipalId' not in self.state:
            principal = self.graph('servicePrincipals', 'POST', {
                'appId': self.state['clientId'], 'appRoleAssignmentRequired': True})
            self.state['servicePrincipalId'] = principal['id']
            self.save()
        sp = self.state['servicePrincipalId']
        self.graph('servicePrincipals/' + sp, 'PATCH', {'appRoleAssignmentRequired': True})
        assignments = self.collection(f'servicePrincipals/{sp}/appRoleAssignedTo')
        require(not any(x['principalId'] != self.state['userObjectId'] for x in assignments),
                'Unexpected enterprise app assignments; inspect these before continuing.')
        if not assignments:
            self.graph(f'servicePrincipals/{sp}/appRoleAssignedTo', 'POST', {
                'principalId': self.state['userObjectId'], 'resourceId': sp,
                'appRoleId': '00000000-0000-0000-0000-000000000000'})

    def credential(self):
        expiry = dt.datetime.now(dt.timezone.utc) + dt.timedelta(days=180)
        credential = self.graph(f'applications/{self.state["applicationObjectId"]}/addPassword', 'POST', {
            'passwordCredential': {'displayName': 'codex-terminal-oidc', 'endDateTime': expiry.isoformat()}})
        self.state.update(secretKeyId=credential['keyId'], secretExpiresAt=expiry.isoformat())
        self.save()
        # Returned only in memory. Existing credentials are not deleted until a replacement is verified.
        return credential['secretText']


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None
