"""Test helpers: start a dev-mode Tailchat server, run the Python CLI and the JS interop script."""

from __future__ import annotations

import http.client
import json
import os
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

CLIENT_DIR = Path(__file__).resolve().parents[1]          # tailchat/clients/python
TAILCHAT_DIR = CLIENT_DIR.parents[1]                       # tailchat/
INTEROP_JS = Path(__file__).resolve().with_name("interop.mjs")
NODE = shutil.which("node")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def server_command() -> list[str]:
    """How to run the server: $TAILCHAT_SERVER_CMD, else the Python port if present, else Node."""
    override = os.environ.get("TAILCHAT_SERVER_CMD")
    if override:
        return shlex.split(override)
    if (TAILCHAT_DIR / "tailchat_server" / "__main__.py").exists():
        return [sys.executable, "-m", "tailchat_server"]
    if not NODE:
        raise RuntimeError("node is not installed and there is no tailchat_server package")
    if not (TAILCHAT_DIR / "node_modules" / "ws").exists():
        subprocess.run(["npm", "install", "--no-audit", "--no-fund"], cwd=TAILCHAT_DIR, check=True)
    return [NODE, "--no-warnings=ExperimentalWarning", "server/index.js"]


class DevServer:
    def __init__(self):
        self.data = tempfile.mkdtemp(prefix="tailchat-pytest-")
        self.port = free_port()
        self.base = f"http://127.0.0.1:{self.port}"
        env = {k: v for k, v in os.environ.items() if k != "PYTHONPATH"}
        env.update(TAILCHAT_AUTH="dev", TAILCHAT_HOST="127.0.0.1", TAILCHAT_PORT=str(self.port), TAILCHAT_DATA=self.data)
        self.log_path = os.path.join(self.data, "server.log")
        self.log = open(self.log_path, "wb")
        self.cmd = server_command()
        self.proc = subprocess.Popen(self.cmd, cwd=TAILCHAT_DIR, env=env, stdout=self.log, stderr=subprocess.STDOUT)
        try:
            self._wait_ready()
        except BaseException:
            self.stop()
            raise

    def _wait_ready(self, timeout: float = 30) -> None:
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(f"server exited ({self.proc.returncode}): {self.output()}")
            try:
                conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=2)
                # An unknown API path answers 404 without creating a user.
                conn.request("GET", "/api/__ready")
                status = conn.getresponse().status
                conn.close()
                if status < 500:  # any answer means it is serving
                    return
            except OSError:
                pass
            time.sleep(0.1)
        raise RuntimeError(f"server did not start in {timeout}s: {self.output()}")

    def output(self) -> str:
        self.log.flush()
        with open(self.log_path, "rb") as f:
            return f.read().decode("utf-8", "replace")[-4000:]

    def stop(self) -> None:
        if self.proc.poll() is None:
            self.proc.terminate()
            try:
                self.proc.wait(10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
        self.log.close()
        shutil.rmtree(self.data, ignore_errors=True)


def cli_env() -> dict:
    env = dict(os.environ)
    env["PYTHONPATH"] = str(CLIENT_DIR) + os.pathsep + env.get("PYTHONPATH", "")
    env.pop("TAILCHAT_STATE", None)
    return env


def run_cli(*args: str, check: bool = True, timeout: float = 120) -> subprocess.CompletedProcess:
    proc = subprocess.run([sys.executable, "-m", "tailchat", *args], cwd=CLIENT_DIR, env=cli_env(),
                          capture_output=True, text=True, timeout=timeout)
    if check and proc.returncode != 0:
        raise AssertionError(f"tailchat {' '.join(args)} failed ({proc.returncode}):\n{proc.stdout}\n{proc.stderr}")
    return proc


def cli_json(*args: str):
    out = run_cli("--json", *args).stdout.strip().splitlines()
    return json.loads(out[-1])


def js(*args: str, timeout: float = 120):
    if not NODE:
        raise RuntimeError("node is required for the interop tests")
    proc = subprocess.run([NODE, "--no-warnings", str(INTEROP_JS), *map(str, args)], cwd=TAILCHAT_DIR,
                          capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        raise AssertionError(f"interop.mjs {args[0]} failed:\n{proc.stderr}")
    return json.loads(proc.stdout.strip().splitlines()[-1])
