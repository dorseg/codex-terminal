import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import tomllib
import unittest
from unittest.mock import Mock, patch

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / 'vm'))
from manage_vm import VM, compose, proxy_config, Failure, public_hostname, caddy_config

spec = importlib.util.spec_from_file_location('codex_config', HERE / 'vm/codex-config.py')
codex_config = importlib.util.module_from_spec(spec)
spec.loader.exec_module(codex_config)


class VMSecurityTests(unittest.TestCase):
    def test_domain_callback_update_retries_a_transport_reset(self):
        vm = object.__new__(VM)
        vm.config = {'contactEmail': 'owner@example.com'}
        vm.state = {'applicationObjectId': 'app', 'servicePrincipalId': 'sp',
                    'userObjectId': 'owner', 'clientId': 'client',
                    'vm': {'hostName': 'old.example.com', 'ipAddress': '192.0.2.1', 'url': 'https://old.example.com'}}
        vm.preflight = Mock()
        vm.collection = Mock(return_value=[{'principalId': 'owner'}])
        vm.run = Mock(return_value='done')
        vm.check_https = Mock()
        vm.save = Mock()
        resets = []

        def graph(path, method='GET', body=None):
            if method == 'PATCH':
                if body['web']['redirectUris'] == ['https://new.example.com/oauth2/callback'] and not resets:
                    resets.append(True)
                    raise ConnectionResetError('transient reset')
                return {}
            if path.startswith('applications/'):
                return {'signInAudience': 'AzureADMyOrg', 'web': {'redirectUris': ['https://old.example.com/oauth2/callback']}}
            return {'appRoleAssignmentRequired': True}

        vm.graph = Mock(side_effect=graph)
        with tempfile.TemporaryDirectory() as directory, patch('manage_vm.time.sleep'), patch('builtins.print'):
            vm.config_path = Path(directory) / 'config.json'
            vm.set_domain('new.example.com')
        self.assertTrue(resets)
        self.assertEqual([call.args[0] for call in vm.run.call_args_list],
                         ['custom-domain-apply', 'custom-domain-commit'])
        self.assertEqual(vm.state['vm']['url'], 'https://new.example.com')
        vm.check_https.assert_called_once_with(url='https://new.example.com')
        vm.save.assert_called_once()

    def test_custom_domain_is_canonical_for_tls_and_authentication(self):
        state = {'vm': {'hostName': 'terminal.region.cloudapp.azure.com'}}
        host = public_hostname({'customDomain': 'terminal.example.com'}, state)
        config = caddy_config(host, state['vm']['hostName'], 'owner@example.com')
        self.assertIn('terminal.example.com {', config)
        self.assertIn('terminal.region.cloudapp.azure.com {', config)
        self.assertIn('redir https://terminal.example.com{uri} permanent', config)
        self.assertEqual(config.count('reverse_proxy 127.0.0.1:4180'), 1)
        proxy = tomllib.loads(proxy_config('tenant', 'client', 'owner', host, 'fake', 'fake'))
        self.assertEqual(proxy['redirect_url'], 'https://terminal.example.com/oauth2/callback')
        self.assertEqual(public_hostname({}, state), state['vm']['hostName'])
        for bad in ['https://terminal.example.com', 'terminal.example.com:443', '*.example.com',
                    'terminal.example.com/path', 'terminal.example.com\nadmin off', '-terminal.example.com']:
            with self.subTest(host=bad), self.assertRaises(Failure):
                public_hostname({'customDomain': bad}, state)

    def test_oid_not_email_controls_access_and_tokens_stay_in_proxy(self):
        cfg = tomllib.loads(proxy_config('tenant', 'client', 'immutable-owner', 'terminal.example',
                                        'fake-secret', 'fake-cookie-key'))
        self.assertEqual(cfg['oidc_issuer_url'], 'https://login.microsoftonline.com/tenant/v2.0')
        self.assertEqual(cfg['allowed_groups'], ['immutable-owner'])
        self.assertEqual(cfg['oidc_groups_claim'], 'oid')
        self.assertEqual(cfg['code_challenge_method'], 'S256')
        self.assertEqual(cfg['redirect_url'], 'https://terminal.example/oauth2/callback')
        for key in ['pass_access_token', 'pass_authorization_header', 'set_authorization_header',
                    'pass_basic_auth', 'pass_user_headers', 'insecure_oidc_skip_nonce']:
            self.assertFalse(cfg[key], key)
        self.assertTrue(cfg['cookie_secure'])
        self.assertTrue(cfg['cookie_httponly'])

    def test_shell_has_only_data_mounts_and_loopback_port(self):
        for size in ['Standard_B1ms', 'Standard_B2als_v2']:
            services = compose(dict.fromkeys(['terminal', 'auth', 'https'], 'pinned@sha256:test'), size)['services']
            terminal = services['terminal']
            self.assertEqual(terminal['user'], '1000:1000')
            self.assertEqual(terminal['cap_drop'], ['ALL'])
            self.assertNotIn('network_mode', terminal)
            self.assertNotIn('environment', terminal)
            self.assertEqual(terminal['ports'], ['127.0.0.1:7681:7681'])
            self.assertEqual(len(terminal['volumes']), 2)
            self.assertTrue(all('/srv/codex-terminal/' in mount for mount in terminal['volumes']))
            self.assertIn('no-new-privileges:true', terminal['security_opt'])
            self.assertTrue(services['auth']['read_only'])
            self.assertFalse(any('oauth2' in mount for mount in terminal['volumes']))
        with self.assertRaises(Failure):
            compose({}, 'unknown')

    def test_seccomp_stays_default_deny_with_namespace_support(self):
        profile = json.loads((HERE / 'vm/seccomp.json').read_text())
        self.assertEqual(profile['defaultAction'], 'SCMP_ACT_ERRNO')
        allowed = {name for rule in profile['syscalls'] if rule['action'] == 'SCMP_ACT_ALLOW' and not rule.get('includes')
                   for name in rule['names']}
        self.assertTrue({'unshare', 'mount', 'umount2', 'pivot_root'} <= allowed)
        self.assertNotIn('init_module', allowed)
        self.assertNotIn('finit_module', allowed)

    def test_codex_defaults_preserve_unrelated_and_project_settings(self):
        original = ('model = "some-model"\nsandbox_mode = "danger-full-access"\n'
                    '[projects."/workspace/project"]\ntrust_level = "trusted"\n')
        value = codex_config.configured(original)
        cfg = tomllib.loads(value)
        self.assertEqual(cfg['sandbox_mode'], 'workspace-write')
        self.assertEqual(cfg['approval_policy'], 'on-request')
        self.assertEqual(cfg['sqlite_home'], '/home/node/.codex/sqlite')
        self.assertEqual(cfg['model'], 'some-model')
        self.assertEqual(cfg['projects']['/workspace/project']['trust_level'], 'trusted')
        self.assertEqual(codex_config.configured(value), value)


if __name__ == '__main__':
    unittest.main()
