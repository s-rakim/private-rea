"""Running without Docker: the secret path in front of tailscale serve, and
the launcher that sets it up (driven against a stand-in tailscale command)."""

import os
import stat
import sys
import tempfile
import unittest
from pathlib import Path

from aiohttp.test_utils import AioHTTPTestCase

from tailchat_server.app import create_app
from tailchat_server.config import load_config
from tailchat_server.local import SetupError, TailscaleServe, load_secret, tailnet_name

SECRET = "s" * 43
IDENTITY = {"Host": "pc.tail1234.ts.net", "Tailscale-User-Login": "alice@example.com"}


class SecretConfigTests(unittest.TestCase):
    def test_secret_rules(self):
        self.assertEqual(load_config({"TAILCHAT_SERVE_SECRET": SECRET}).serve_secret, SECRET)
        for bad in ["short", "x" * 40 + "/", "x" * 40 + "%2f"]:
            with self.assertRaises(ValueError, msg=bad):
                load_config({"TAILCHAT_SERVE_SECRET": bad})
        with self.assertRaises(ValueError):
            load_config({"TAILCHAT_AUTH": "dev", "TAILCHAT_SERVE_SECRET": SECRET})


class SecretPathTests(AioHTTPTestCase):
    async def get_application(self):
        self.tmp = tempfile.TemporaryDirectory()
        config = load_config({"TAILCHAT_SERVE_SECRET": SECRET, "TAILCHAT_DATA": self.tmp.name})
        return create_app(config)

    async def asyncTearDown(self):
        await super().asyncTearDown()
        self.tmp.cleanup()

    async def test_only_the_secret_path_answers(self):
        for path in ["/", "/api/me", "/index.html", "/ws", f"/{SECRET[:-1]}/api/me", f"/x{SECRET}/api/me"]:
            res = await self.client.get(path, headers=IDENTITY)
            self.assertEqual(res.status, 404, path)
        res = await self.client.get(f"/{SECRET}/", headers=IDENTITY)
        self.assertEqual(res.status, 200)
        self.assertIn("text/html", res.headers["Content-Type"])
        res = await self.client.get(f"/{SECRET}/api/me", headers=IDENTITY)
        self.assertEqual(res.status, 200)
        self.assertEqual((await res.json())["user"]["id"], "alice@example.com")
        res = await self.client.get(f"/{SECRET}/app.js", headers=IDENTITY)
        self.assertEqual(res.status, 200)
        # The other checks still apply behind the secret.
        res = await self.client.get(f"/{SECRET}/api/me", headers={**IDENTITY, "Host": "evil.example"})
        self.assertEqual(res.status, 421)


FAKE_TAILSCALE = """#!{python}
import json, os, sys
log = os.environ["FAKE_TS_LOG"]
with open(log, "a") as f:
    f.write(" ".join(sys.argv[1:]) + "\\n")
if sys.argv[1:3] == ["status", "--json"]:
    print(os.environ["FAKE_TS_STATUS"])
"""


@unittest.skipIf(os.name == "nt", "stand-in tailscale is a script")
class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        cli = self.tmp / "tailscale"
        cli.write_text(FAKE_TAILSCALE.format(python=sys.executable))
        cli.chmod(cli.stat().st_mode | stat.S_IEXEC)
        self.log = self.tmp / "calls"
        self.env = {"PATH": f"{self.tmp}{os.pathsep}{os.environ['PATH']}", "FAKE_TS_LOG": str(self.log)}
        self.old_env = dict(os.environ)
        os.environ.update(self.env)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.old_env)

    def status(self, **over):
        status = {"BackendState": "Running", "CertDomains": ["pc.tail1234.ts.net"], "Self": {"DNSName": "pc.tail1234.ts.net."}}
        os.environ["FAKE_TS_STATUS"] = __import__("json").dumps({**status, **over})

    def test_points_serve_at_the_secret_path(self):
        self.status()
        serve = TailscaleServe(8443, self.tmp / "data")
        secret, url = serve.prepare()
        self.assertEqual(url, "https://pc.tail1234.ts.net")
        self.assertEqual((self.tmp / "data" / "serve-secret").read_text(), secret)
        serve.stop()
        calls = self.log.read_text().splitlines()
        self.assertEqual(calls, ["status --json", f"serve --bg --https=443 http://127.0.0.1:8443/{secret}", "serve --https=443 off"])
        # The same secret is used next time.
        self.assertEqual(TailscaleServe(8443, self.tmp / "data").prepare()[0], secret)

    def test_explains_what_to_fix(self):
        self.status(BackendState="NeedsLogin")
        with self.assertRaisesRegex(SetupError, "isn't connected"):
            TailscaleServe(8443, self.tmp / "data").prepare()
        self.status(CertDomains=None)
        with self.assertRaisesRegex(SetupError, "HTTPS certificates"):
            TailscaleServe(8443, self.tmp / "data").prepare()


class HelperTests(unittest.TestCase):
    def test_tailnet_name_prefers_this_machine(self):
        status = {"BackendState": "Running", "CertDomains": ["a.t.ts.net", "pc.t.ts.net"], "Self": {"DNSName": "pc.t.ts.net."}}
        self.assertEqual(tailnet_name(status), "pc.t.ts.net")

    def test_bad_saved_secret_is_replaced(self):
        with tempfile.TemporaryDirectory() as tmp:
            Path(tmp, "serve-secret").write_text("short")
            secret = load_secret(Path(tmp))
            self.assertGreaterEqual(len(secret), 32)
            self.assertEqual(load_secret(Path(tmp)), secret)


if __name__ == "__main__":
    unittest.main()
