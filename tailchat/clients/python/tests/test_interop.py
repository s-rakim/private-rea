"""End-to-end tests against a real dev-mode server, with interop checked both ways
against the JS reference implementation (public/crypto.js)."""

from __future__ import annotations

import json
import os
import queue
import shutil
import stat
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

from tailchat import crypto
from tailchat.api import Client, Session
from tailchat.state import State

from .support import CLIENT_DIR, NODE, DevServer, cli_env, cli_json, js, run_cli

MiB = 1024 * 1024


@unittest.skipUnless(NODE, "node is required for the interop tests")
class InteropTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = DevServer()
        cls.tmp = Path(tempfile.mkdtemp(prefix="tailchat-client-test-"))
        cls.alice_state = cls.tmp / "alice" / "state.json"
        cls.bob_state = cls.tmp / "bob.json"
        cls.reg = cli_json("--state", str(cls.alice_state), "--server", cls.server.base, "--dev-user", "alice",
                           "--name", "alice's python", "register")
        cls.bob = js("register", cls.server.base, "bob", cls.bob_state)

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def alice(self, *args, **kw):
        return cli_json("--state", str(self.alice_state), *args)

    def alice_session(self) -> Session:
        return Session(State.load(self.alice_state))

    def outdir(self, name: str) -> Path:
        d = self.tmp / name
        d.mkdir(exist_ok=True)
        return d

    def js_read(self, chat_id: str) -> dict:
        rows = js("read", self.bob_state, chat_id, self.outdir("js-read"))
        return {r["id"]: r for r in rows}

    # ---------- registration ----------

    def test_registration_state_file(self):
        self.assertEqual(self.reg["userId"], "alice@dev")
        mode = stat.S_IMODE(self.alice_state.stat().st_mode)
        self.assertEqual(mode, 0o600)
        state = json.loads(self.alice_state.read_text())
        self.assertEqual(state["device_id"], self.reg["deviceId"])
        self.assertTrue(state["token"].startswith(state["device_id"] + "."))
        self.assertIn("BEGIN PRIVATE KEY", state["private_key_pem"])
        # The server has the matching public key.
        session = self.alice_session()
        keys = session.client.keys([session.device_id])
        self.assertEqual(keys[0]["publicKey"], crypto.public_jwk(session.ring.private_key))
        # A state file readable by others is refused.
        loose = self.tmp / "loose.json"
        shutil.copy(self.alice_state, loose)
        os.chmod(loose, 0o644)
        with self.assertRaises(PermissionError):
            State.load(loose)
        # Registering again over an existing state needs --force.
        again = run_cli("--state", str(self.alice_state), "--server", self.server.base, "--dev-user", "alice",
                        "register", check=False)
        self.assertEqual(again.returncode, 1)
        self.assertIn("--force", again.stderr)

    def test_whoami_users_and_security_code(self):
        me = self.alice("whoami")
        self.assertEqual(me["user"]["id"], "alice@dev")
        self.assertEqual(me["device"]["id"], self.reg["deviceId"])
        users = {u["id"] for u in self.alice("users")}
        self.assertTrue({"alice@dev", "bob@dev"} <= users)
        # Security codes match crypto.js.
        devices = {"devices": self.alice_session().client.user_devices("bob@dev")}
        devices_path = self.tmp / "bob-devices.json"
        devices_path.write_text(json.dumps(devices["devices"]))
        self.assertEqual(self.alice("code", "bob")["securityCode"], js("security-code", devices_path)["code"])
        # Several devices, in any order (Alice's and Bob's together).
        both = devices["devices"] + self.alice_session().client.user_devices("alice@dev")
        devices_path.write_text(json.dumps(list(reversed(both))))
        self.assertEqual(crypto.security_code(both), js("security-code", devices_path)["code"])

    # ---------- text ----------

    def test_text_python_to_js(self):
        text = "héllo from Python 👋 \"quotes\" \\ </script>"
        sent = self.alice("send", "bob@dev", text)
        chat_id = sent["chatId"]
        row = self.js_read(chat_id)[sent["message"]["id"]]
        self.assertNotIn("error", row)
        self.assertEqual(row["content"], {"type": "text", "text": text})
        # Bare dev names resolve to user ids and land in the same direct chat.
        again = self.alice("send", "bob", "second")
        self.assertEqual(again["chatId"], chat_id)
        # A chat id works as a target, too.
        self.assertEqual(self.alice("send", chat_id, "third")["chatId"], chat_id)

    def test_text_js_to_python(self):
        text = "hi from crypto.js ✓"
        sent = js("send", self.bob_state, "alice@dev", text)
        chat_id = sent["chatId"]
        own = self.alice("send", chat_id, "and back from python")
        history = {m["id"]: m for m in self.alice("history", chat_id, "--limit", "200")}
        self.assertEqual(history[sent["message"]["id"]]["content"], {"type": "text", "text": text})
        self.assertEqual(history[sent["message"]["id"]]["senderId"], "bob@dev")
        # The sender wraps for itself, so its own messages decrypt too.
        self.assertEqual(history[own["message"]["id"]]["content"]["text"], "and back from python")
        self.assertTrue(all("error" not in m for m in history.values()))
        chats = {c["id"]: c for c in self.alice("chats")}
        self.assertEqual(chats[chat_id]["preview"], "and back from python")
        self.assertEqual(chats[chat_id]["label"], "bob@dev")
        # Plain-text output renders too.
        out = run_cli("--state", str(self.alice_state), "history", chat_id).stdout
        self.assertIn("bob@dev: hi from crypto.js ✓", out)

    # ---------- files ----------

    def test_files_python_to_js(self):
        cases = {
            "multi.bin": os.urandom(2 * MiB + MiB // 2 + 7),  # three chunks, short last one
            "exact.bin": os.urandom(2 * MiB),                # last chunk exactly 1 MiB
            "empty.txt": b"",                                # one empty chunk
        }
        for name, data in cases.items():
            with self.subTest(name=name):
                path = self.tmp / name
                path.write_bytes(data)
                sent = self.alice("send-file", "bob@dev", str(path))
                content = sent["message"]["content"]
                self.assertEqual(content["type"], "media")
                self.assertEqual(content["kind"], "document")
                self.assertEqual(content["file"]["size"], len(data))
                self.assertEqual(content["file"]["name"], name)
                row = self.js_read(sent["chatId"])[sent["message"]["id"]]
                self.assertNotIn("error", row)
                self.assertEqual(Path(row["savedTo"]).read_bytes(), data)

    def test_files_js_to_python(self):
        cases = {"report.pdf": os.urandom(2 * MiB + 1234), "one.bin": os.urandom(MiB), "nothing.dat": b""}
        for name, data in cases.items():
            with self.subTest(name=name):
                src = self.tmp / f"js-{name}"
                src.write_bytes(data)
                sent = js("send-file", self.bob_state, "alice@dev", src, name, "application/octet-stream")
                out = self.outdir("py-downloads")
                got = self.alice("download", sent["message"]["id"], str(out))
                self.assertEqual(Path(got["path"]), out / name)
                self.assertEqual(Path(got["path"]).read_bytes(), data)
                self.assertEqual(stat.S_IMODE(Path(got["path"]).stat().st_mode) & 0o077, 0)
                # A second download doesn't overwrite the first.
                again = self.alice("download", sent["message"]["id"], str(out), "--chat", sent["chatId"])
                self.assertNotEqual(again["path"], got["path"])
                self.assertEqual(Path(again["path"]).read_bytes(), data)

    def test_download_rejects_tampered_metadata(self):
        data = os.urandom(MiB + 10)
        src = self.tmp / "tamper.bin"
        src.write_bytes(data)
        sent = js("send-file", self.bob_state, "alice@dev", src, "tamper.bin", "application/octet-stream")
        session = self.alice_session()
        content = session.decrypt_message(session.find_message(sent["message"]["id"]))
        out = self.outdir("tampered")
        bad_sum = dict(content["file"], sha256=crypto.b64u(b"\0" * 32))
        with self.assertRaisesRegex(crypto.CryptoError, "checksum"):
            session.download_file(bad_sum, out)
        bad_size = dict(content["file"], size=content["file"]["size"] - 10)
        with self.assertRaises(crypto.CryptoError):
            session.download_file(bad_size, out)
        self.assertEqual(list(out.iterdir()), [], "nothing is left behind after a failed download")
        # Missing from history: a clear error, not a crash.
        missing = run_cli("--state", str(self.alice_state), "download", "nosuchmessageid00000", str(out), check=False)
        self.assertEqual(missing.returncode, 1)

    # ---------- realtime ----------

    def test_listen_prints_saves_and_sends_receipts(self):
        save = self.outdir("listen-saved")
        proc = subprocess.Popen(
            [sys.executable, "-m", "tailchat", "--state", str(self.alice_state), "--json", "listen",
             "--save-files", str(save), "--count", "2"],
            cwd=CLIENT_DIR, env=cli_env(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )
        lines: queue.Queue = queue.Queue()
        threading.Thread(target=lambda: [lines.put(l) for l in proc.stdout], daemon=True).start()

        def next_event(timeout=30):
            try:
                return json.loads(lines.get(timeout=timeout))
            except queue.Empty:
                proc.kill()
                self.fail(f"listen produced no output; stderr: {proc.stderr.read()}")

        try:
            self.assertEqual(next_event()["event"], "ready")
            text = js("send", self.bob_state, "alice@dev", "live message")
            data = os.urandom(MiB + 99)
            src = self.tmp / "live.bin"
            src.write_bytes(data)
            media = js("send-file", self.bob_state, "alice@dev", src, "live.bin", "application/octet-stream")

            first = next_event()
            self.assertEqual(first["id"], text["message"]["id"])
            self.assertEqual(first["content"], {"type": "text", "text": "live message"})
            second = next_event()
            self.assertEqual(second["id"], media["message"]["id"])
            self.assertEqual(Path(second["savedTo"]).read_bytes(), data)
            self.assertEqual(proc.wait(30), 0)
        finally:
            if proc.poll() is None:
                proc.kill()
            proc.stdout.close()
            proc.stderr.close()

        # Bob sees Alice's delivered receipt for both messages.
        bob = json.loads(self.bob_state.read_text())
        chat = Client(self.server.base, token=bob["token"], dev_user="bob").chat(text["chatId"])
        alice_member = next(m for m in chat["members"] if m["userId"] == "alice@dev")
        deadline = time.time() + 5
        while alice_member["deliveredSeq"] < media["message"]["seq"] and time.time() < deadline:
            time.sleep(0.1)
            chat = Client(self.server.base, token=bob["token"], dev_user="bob").chat(text["chatId"])
            alice_member = next(m for m in chat["members"] if m["userId"] == "alice@dev")
        self.assertGreaterEqual(alice_member["deliveredSeq"], media["message"]["seq"])

    # ---------- errors ----------

    def test_cli_errors(self):
        unknown = run_cli("--state", str(self.alice_state), "send", "nobody@nowhere", "hi", check=False)
        self.assertEqual(unknown.returncode, 1)
        self.assertIn("No such user", unknown.stderr)
        unregistered = run_cli("--state", str(self.tmp / "none.json"), "chats", check=False)
        self.assertEqual(unregistered.returncode, 1)
        self.assertIn("--server", unregistered.stderr)
        wrong_server = run_cli("--state", str(self.alice_state), "--server", "https://other.example.ts.net",
                               "chats", check=False)
        self.assertEqual(wrong_server.returncode, 1)


@unittest.skipUnless(NODE, "node is required for the interop tests")
class OfflineCryptoInteropTest(unittest.TestCase):
    """Byte-level checks with no server: Python seals, crypto.js opens, and vice versa."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="tailchat-crypto-"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_python_file_blob_decrypts_in_js(self):
        for size in (0, 5, MiB - 1, MiB, MiB + 1, 3 * MiB + 17):
            with self.subTest(size=size):
                data = os.urandom(size)
                blob, file = crypto.encrypt_bytes(data)
                self.assertEqual(len(blob), crypto.encrypted_size(size))
                (self.tmp / "blob").write_bytes(blob)
                (self.tmp / "file.json").write_text(json.dumps(file))
                js("decrypt-file", self.tmp / "blob", self.tmp / "file.json", self.tmp / "out")
                self.assertEqual((self.tmp / "out").read_bytes(), data)
                self.assertEqual(crypto.decrypt_bytes(blob, file), data)

    def test_tampering_is_detected(self):
        data = os.urandom(2 * MiB + 5)
        blob, file = crypto.encrypt_bytes(data)
        with self.assertRaises(crypto.CryptoError):
            crypto.decrypt_bytes(blob[:-10], file)
        # Dropping the whole last chunk: chunk 1 then claims to be last, which its AAD forbids.
        with self.assertRaises(crypto.CryptoError):
            crypto.decrypt_bytes(blob[: 2 * (MiB + 16)], dict(file, size=2 * MiB))
        flipped = bytearray(blob)
        flipped[MiB + 100] ^= 1
        with self.assertRaises(crypto.CryptoError):
            crypto.decrypt_bytes(bytes(flipped), file)

    def test_envelope_aad_and_keys(self):
        a = crypto.KeyRing("devA", crypto.generate_private_key())
        b = crypto.KeyRing("devB", crypto.generate_private_key())
        b.add_public_key("devA", crypto.public_jwk(a.private_key))
        payload = a.seal({"type": "text", "text": "x"}, crypto.chat_aad("c1", "m1"),
                         [{"id": "devB", "publicKey": crypto.public_jwk(b.private_key)}])
        env = json.loads(payload)
        self.assertEqual(sorted(env["keys"]), ["devA", "devB"])
        self.assertEqual(len(crypto.unb64u(env["keys"]["devB"])), 40)
        self.assertEqual(len(crypto.unb64u(env["iv"])), 12)
        self.assertNotIn("=", payload)
        self.assertEqual(b.open(payload, crypto.chat_aad("c1", "m1"))["text"], "x")
        self.assertEqual(a.open(payload, crypto.chat_aad("c1", "m1"))["text"], "x")
        with self.assertRaises(crypto.CryptoError):
            b.open(payload, crypto.chat_aad("c1", "m2"))
        c = crypto.KeyRing("devC", crypto.generate_private_key())
        with self.assertRaises(crypto.NoKeyError):
            c.open(payload, crypto.chat_aad("c1", "m1"))

    def test_relabelled_sender_is_rejected(self):
        a = crypto.KeyRing("devA", crypto.generate_private_key())
        b = crypto.KeyRing("devB", crypto.generate_private_key())
        b.add_public_key("devA", crypto.public_jwk(a.private_key), "alice@example.com")
        payload = a.seal({"type": "text", "text": "x"}, crypto.chat_aad("c1", "m1"),
                         [{"id": "devB", "publicKey": crypto.public_jwk(b.private_key), "userId": "bob@example.com"}])
        self.assertEqual(b.open(payload, crypto.chat_aad("c1", "m1"), "alice@example.com")["text"], "x")
        # The server claims Mallory sent it: the envelope says otherwise.
        with self.assertRaises(crypto.CryptoError):
            b.open(payload, crypto.chat_aad("c1", "m1"), "mallory@example.com")
        # And it can't change who a device belongs to after the fact.
        with self.assertRaises(crypto.CryptoError):
            b.add_public_key("devA", crypto.public_jwk(a.private_key), "mallory@example.com")


if __name__ == "__main__":
    unittest.main()
