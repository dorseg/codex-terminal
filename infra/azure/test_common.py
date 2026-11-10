import base64
import datetime as dt
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import Deployment, Failure


class AccountBoundaryTests(unittest.TestCase):
    def test_wrong_tenant_token_is_rejected_before_api_use(self):
        deployment = object.__new__(Deployment)
        deployment.config = {'tenantId': 'intended-tenant', 'subscriptionId': 'personal-subscription'}
        deployment.tokens = {}
        payload = base64.urlsafe_b64encode(json.dumps({'tid': 'other-tenant'}).encode()).decode().rstrip('=')
        with patch('common.az', return_value={'accessToken': 'header.' + payload + '.signature'}):
            with self.assertRaises(Failure):
                deployment.token('https://graph.microsoft.com/')
        self.assertEqual(deployment.tokens, {})

    def test_resource_group_change_cannot_reuse_old_state(self):
        config = {'subscriptionId': '00000000-0000-0000-0000-000000000001',
                  'tenantId': '00000000-0000-0000-0000-000000000002',
                  'userEmail': 'owner@example.com', 'contactEmail': 'owner@example.com',
                  'location': 'northeurope', 'resourceGroup': 'new-rg', 'prefix': 'codex-terminal'}
        with tempfile.TemporaryDirectory() as directory:
            private = Path(directory) / '.azure'
            private.mkdir()
            path = private / 'config.json'
            path.write_text(json.dumps(config))
            (private / 'state.json').write_text(json.dumps({'resourceGroup': 'different-rg'}))
            with self.assertRaises(Failure):
                Deployment(path)

    def test_portal_attestation_cannot_override_disabled_security_defaults(self):
        deployment = object.__new__(Deployment)
        deployment.config = {'mfaEvidence': {'type': 'security-defaults', 'confirmedEnabled': True,
                             'checkedAt': dt.datetime.now(dt.timezone.utc).isoformat()}}
        deployment.graph = Mock(return_value={'isEnabled': False})
        with self.assertRaises(Failure):
            deployment.mfa()

    def test_expired_portal_attestation_is_rejected_when_graph_is_unavailable(self):
        deployment = object.__new__(Deployment)
        deployment.config = {'mfaEvidence': {'type': 'security-defaults', 'confirmedEnabled': True,
                             'checkedAt': (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=2)).isoformat()}}
        deployment.graph = Mock(side_effect=urllib.error.HTTPError('https://graph.microsoft.com', 403, 'Forbidden', {}, None))
        with self.assertRaises(Failure):
            deployment.mfa()


if __name__ == '__main__':
    unittest.main()
