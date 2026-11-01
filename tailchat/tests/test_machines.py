"""Your machines on the tailnet (tailchat_server/machines.py): which ones are
listed as chats, and which machine a request comes from."""

import json
import tempfile
import unittest
from pathlib import Path

from tailchat_server.config import load_config
from tailchat_server.machines import Tailnet, epoch_ms, short_name

STATUS = {
    "BackendState": "Running",
    "Self": {"ID": "nSELF", "DNSName": "tailchat.tail1234.ts.net.", "HostName": "tailchat", "OS": "linux", "UserID": 1},
    "Peer": {
        "k1": {"ID": "nPC", "DNSName": "holysukuns.tail1234.ts.net.", "HostName": "HOLYSUKUNS", "OS": "windows", "UserID": 1, "Online": True},
        "k2": {"ID": "nPHONE", "DNSName": "pixel.tail1234.ts.net.", "HostName": "Pixel 8", "OS": "android", "UserID": 1, "Online": False, "LastSeen": "2026-10-30T08:00:00Z"},
        "k3": {"ID": "nTAG", "DNSName": "nas.tail1234.ts.net.", "OS": "linux", "UserID": 1, "Tags": ["tag:server"], "Online": True},
        "k4": {"ID": "nBOB", "DNSName": "bobs-laptop.tail1234.ts.net.", "OS": "macOS", "UserID": 2, "Online": True},
        "k5": {"DNSName": "no-id.tail1234.ts.net.", "UserID": 1},
        "k6": {"ID": "nOLD", "DNSName": "", "HostName": "Old Laptop", "OS": "linux", "UserID": 1, "LastSeen": "0001-01-01T00:00:00Z"},
    },
    "User": {
        "1": {"ID": 1, "LoginName": "Mo@Example.com", "DisplayName": "Mo"},
        "2": {"ID": 2, "LoginName": "bob@example.com", "DisplayName": "Bob"},
    },
}


def whois_of(node_id, name, login, tags=None):
    return {
        "Node": {"StableID": node_id, "Name": f"{name}.tail1234.ts.net.", "Tags": tags, "Hostinfo": {"Hostname": name, "OS": "windows"}},
        "UserProfile": {"LoginName": login},
    }


class FakeRequest:
    def __init__(self, headers=None, cookies=None):
        self.headers = headers or {}
        self.cookies = cookies or {}
        self.transport = None


class FakeTailnet(Tailnet):
    """Answers status and whois from fixtures instead of tailscaled."""

    def __init__(self, config, status=STATUS, whois=None):
        super().__init__(config)
        self.fixture = status
        self.whois_answers = whois or {}
        self.asked = []

    async def status(self):
        return self.fixture

    async def whois(self, ip):
        self.asked.append(ip)
        return self.whois_answers.get(ip)


class NamesTests(unittest.TestCase):
    def test_short_name(self):
        self.assertEqual(short_name("holysukuns.tail1234.ts.net."), "holysukuns")
        self.assertEqual(short_name("", "Old Laptop"), "Old Laptop")
        self.assertEqual(short_name(None, None), "")
        self.assertEqual(short_name("evil\x1b[31m.tail1234.ts.net."), "evil[31m")

    def test_epoch_ms(self):
        self.assertEqual(epoch_ms("2026-10-30T08:00:00Z"), 1793347200000)
        self.assertEqual(epoch_ms("2026-10-30T08:00:00.123456789Z"), 1793347200123)
        self.assertEqual(epoch_ms("2026-10-30T10:00:00.5+02:00"), 1793347200500)
        self.assertIsNone(epoch_ms("0001-01-01T00:00:00Z"))
        self.assertIsNone(epoch_ms("not a time"))
        self.assertIsNone(epoch_ms(None))


class MachinesOfTests(unittest.IsolatedAsyncioTestCase):
    async def test_lists_only_your_untagged_machines(self):
        net = FakeTailnet(load_config({"TAILCHAT_AUTH": "serve"}))
        found = await net.machines_of("mo@example.com")
        self.assertEqual([m["name"] for m in found], ["holysukuns", "Old Laptop", "pixel"])
        pc, old, phone = found
        self.assertEqual(pc, {"id": "nPC", "name": "holysukuns", "os": "windows", "online": True, "lastSeen": None})
        self.assertEqual((phone["online"], phone["lastSeen"]), (False, 1793347200000))
        self.assertIsNone(old["lastSeen"])
        # Bob's laptop, the tagged server and the server itself aren't yours to chat with.
        self.assertEqual([m["id"] for m in await net.machines_of("bob@example.com")], ["nBOB"])
        self.assertEqual(await net.machines_of("nobody@example.com"), [])

    async def test_the_server_machine_when_it_is_yours(self):
        net = FakeTailnet(load_config({"TAILCHAT_AUTH": "serve", "TAILCHAT_LIST_SELF": "1"}))
        found = await net.machines_of("mo@example.com")
        me = next(m for m in found if m["id"] == "nSELF")
        self.assertEqual((me["name"], me["online"]), ("tailchat", True))
        net = FakeTailnet(load_config({"TAILCHAT_AUTH": "serve"}))
        self.assertIn("nSELF", [m["id"] for m in await net.machines_of("mo@example.com", include_self=True)])

    async def test_nothing_when_tailscaled_cant_be_asked(self):
        config = load_config({"TAILCHAT_AUTH": "serve", "TAILSCALE_SOCKET": "/nonexistent/tailscaled.sock"})
        net = Tailnet(config)
        self.assertIsNone(await net.machines_of("mo@example.com"))
        # The failure is remembered for a few seconds rather than retried on every request.
        self.assertGreater(net._status[0], 0)
        self.assertIsNone(await net.whois("100.64.0.1"))
        off = Tailnet(load_config({"TAILCHAT_AUTH": "serve", "TAILCHAT_TAILNET": "off"}))
        self.assertIsNone(await off.machines_of("mo@example.com"))
        self.assertIsNone(await off.machine_of(FakeRequest({"X-Forwarded-For": "100.64.0.1"}), "mo@example.com"))

    async def test_reads_a_dev_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "tailnet.json"
            path.write_text(json.dumps(STATUS))
            net = Tailnet(load_config({"TAILCHAT_AUTH": "dev", "TAILCHAT_DEV_TAILNET": str(path)}))
            self.assertEqual(len(await net.machines_of("mo@example.com")), 3)
            path.write_text("[1, 2]")
            net = Tailnet(load_config({"TAILCHAT_AUTH": "dev", "TAILCHAT_DEV_TAILNET": str(path)}))
            self.assertIsNone(await net.machines_of("mo@example.com"))


class MachineOfTests(unittest.IsolatedAsyncioTestCase):
    async def test_serve_mode_uses_the_address_tailscale_serve_forwards(self):
        net = FakeTailnet(
            load_config({"TAILCHAT_AUTH": "serve"}),
            whois={
                "100.101.1.2": whois_of("nPC", "holysukuns", "Mo@Example.com"),
                "100.101.1.3": whois_of("nBOB", "bobs-laptop", "bob@example.com"),
                "100.101.1.4": whois_of("nTAG", "nas", "mo@example.com", tags=["tag:server"]),
            },
        )
        got = await net.machine_of(FakeRequest({"X-Forwarded-For": "100.101.1.2, 203.0.113.9"}), "mo@example.com")
        self.assertEqual(got, {"id": "nPC", "name": "holysukuns", "os": "windows"})
        self.assertEqual(net.asked, ["100.101.1.2"])
        # Someone else's machine, or a tagged one, is never yours.
        self.assertIsNone(await net.machine_of(FakeRequest({"X-Forwarded-For": "100.101.1.3"}), "mo@example.com"))
        self.assertIsNone(await net.machine_of(FakeRequest({"X-Forwarded-For": "100.101.1.4"}), "mo@example.com"))
        # Addresses outside the tailnet aren't looked up at all.
        net.asked.clear()
        for value in ["203.0.113.9", "", "not an address", "100.101.1.2/32"]:
            self.assertIsNone(await net.machine_of(FakeRequest({"X-Forwarded-For": value}), "mo@example.com"), value)
        self.assertIsNone(await net.machine_of(FakeRequest(), "mo@example.com"))
        self.assertEqual(net.asked, [])

    async def test_dev_mode_picks_the_machine_by_name(self):
        net = FakeTailnet(load_config({"TAILCHAT_AUTH": "dev"}))
        net.source = "dev"
        self.assertEqual((await net.machine_of(FakeRequest(cookies={"tailchat_dev_machine": "pixel"}), "mo@example.com"))["id"], "nPHONE")
        self.assertEqual((await net.machine_of(FakeRequest({"X-Dev-Machine": "tailchat"}), "mo@example.com"))["id"], "nSELF")
        self.assertIsNone(await net.machine_of(FakeRequest(cookies={"tailchat_dev_machine": "bobs-laptop"}), "mo@example.com"))
        self.assertIsNone(await net.machine_of(FakeRequest(), "mo@example.com"))


class TailnetConfigTests(unittest.TestCase):
    def test_defaults(self):
        serve = load_config({"TAILCHAT_AUTH": "serve"})
        self.assertEqual((serve.tailnet, serve.list_self), ("localapi", False))
        self.assertTrue(load_config({"TAILCHAT_AUTH": "serve", "TAILCHAT_LIST_SELF": "1"}).list_self)
        self.assertEqual(load_config({"TAILCHAT_AUTH": "dev"}).tailnet, "off")
        self.assertEqual(load_config({"TAILCHAT_AUTH": "dev", "TAILCHAT_DEV_TAILNET": "x.json"}).tailnet, "dev")
        self.assertEqual(load_config({"TAILCHAT_AUTH": "dev", "TAILCHAT_DEV_TAILNET": "x.json", "TAILCHAT_TAILNET": "off"}).tailnet, "off")

    def test_refusals(self):
        for env in [
            {"TAILCHAT_AUTH": "serve", "TAILCHAT_DEV_TAILNET": "x.json"},
            {"TAILCHAT_AUTH": "serve", "TAILCHAT_TAILNET": "dev"},
            {"TAILCHAT_AUTH": "dev", "TAILCHAT_TAILNET": "dev"},
            {"TAILCHAT_AUTH": "serve", "TAILCHAT_TAILNET": "everything"},
            {"TAILCHAT_AUTH": "serve", "TAILCHAT_TAILNET": "cli"},
        ]:
            with self.assertRaises(ValueError, msg=env):
                load_config(env)


if __name__ == "__main__":
    unittest.main()
