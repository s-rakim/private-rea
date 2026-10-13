"""Two Tailchat peers on this machine (127.0.0.1 and 127.0.0.2) send each
other messages, including to one that starts after the message was sent.
Run: python3 -m unittest peer/test_peer.py"""

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from urllib import request
from urllib.error import HTTPError

HERE = Path(__file__).resolve().parent
PEER_PORT = 18766


def status(me: str, other: str) -> dict:
    def node(name, ip):
        return {"HostName": name, "DNSName": f"{name}.t.ts.net.", "TailscaleIPs": [ip, "fd7a:115c:a1e0::1"], "Online": True, "UserID": 1, "OS": "linux"}
    names = {"127.0.0.1": "laptop", "127.0.0.2": "desktop"}
    return {"BackendState": "Running", "Self": node(names[me], me), "Peer": {"k": node(names[other], other)}, "User": {"1": {"LoginName": "m@x"}}}


class PeerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.procs = []

    def tearDown(self):
        for p in self.procs:
            p.kill()
            p.wait()

    def start(self, ip: str, other: str, ui_port: int) -> str:
        d = self.tmp / ip
        d.mkdir(exist_ok=True)
        (d / "status.json").write_text(json.dumps(status(ip, other)))
        env = {**os.environ, "TAILCHAT_PEER_STATUS_FILE": str(d / "status.json"), "TAILCHAT_PEER_DATA": str(d / "data"),
               "TAILCHAT_PEER_UI_PORT": str(ui_port), "TAILCHAT_PEER_PORT": str(PEER_PORT), "TAILCHAT_PEER_NO_BROWSER": "1"}
        p = subprocess.Popen([sys.executable, str(HERE / "tailchat_peer.py")], env=env, stdout=subprocess.PIPE, text=True)
        self.procs.append(p)
        for _ in range(3):
            line = p.stdout.readline()
            if "key=" in line:
                return line.split("key=")[1].strip()
        self.fail("peer didn't start")

    def call(self, port, key, path, body=None, host=None):
        req = request.Request(f"http://127.0.0.1:{port}{path}", data=json.dumps(body).encode() if body else None,
                              headers={"X-Key": key, "Content-Type": "application/json", **({"Host": host} if host else {})})
        with request.urlopen(req, timeout=5) as res:
            return json.loads(res.read())

    def wait_for(self, fn, timeout=15):
        end = time.time() + timeout
        while time.time() < end:
            v = fn()
            if v:
                return v
            time.sleep(0.3)
        self.fail("timed out")

    def test_messages_go_device_to_device(self):
        a = self.start("127.0.0.1", "127.0.0.2", 18765)
        # desktop isn't running yet: the message waits on the laptop.
        sent = self.call(18765, a, "/api/send", {"peer": "desktop.t.ts.net", "text": "hello from the laptop"})
        self.assertEqual(sent["status"], "waiting")
        b = self.start("127.0.0.2", "127.0.0.1", 18775)
        got = self.wait_for(lambda: self.call(18775, b, "/api/state?since=0")["messages"])
        self.assertEqual(got[0]["text"], "hello from the laptop")
        self.assertEqual(got[0]["peer"], "laptop.t.ts.net")
        self.assertEqual(got[0]["outgoing"], 0)
        self.wait_for(lambda: self.call(18765, a, "/api/state?since=0")["messages"][-1]["status"] == "sent")
        self.call(18775, b, "/api/send", {"peer": "laptop.t.ts.net", "text": "hi back"})
        self.wait_for(lambda: any(m["text"] == "hi back" for m in self.call(18765, a, "/api/state?since=0")["messages"]))

    def test_refuses_strangers_and_other_sites(self):
        a = self.start("127.0.0.1", "127.0.0.2", 18765)
        with self.assertRaises(HTTPError) as err:
            self.call(18765, "wrong", "/api/state?since=0")
        self.assertEqual(err.exception.code, 403)
        with self.assertRaises(HTTPError) as err:
            self.call(18765, a, "/api/state?since=0", host="evil.example:18765")
        self.assertEqual(err.exception.code, 421)
        # 127.0.0.3 isn't a device on the tailnet. Linux only, where all of
        # 127/8 is loopback.
        if sys.platform.startswith("linux"):
            import socket
            s = socket.create_connection(("127.0.0.1", PEER_PORT), source_address=("127.0.0.3", 0))
            body = json.dumps({"id": "6f1c8d1e-6f4b-4a8e-9a63-2b8f5a7e9c11", "text": "spoof", "sent_at": 1}).encode()
            s.sendall(b"POST /inbox HTTP/1.1\r\nHost: x\r\nContent-Length: %d\r\n\r\n" % len(body) + body)
            self.assertIn(b" 403 ", s.recv(100))
            s.close()


if __name__ == "__main__":
    unittest.main()
