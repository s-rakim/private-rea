"""Run the Tailchat server: python -m tailchat_server

  --tailscale  also set up `tailscale serve` on this machine (no Docker needed)
"""

from __future__ import annotations

import logging
import os
import sys

from aiohttp import web

from .app import create_app, ssl_context
from .config import load_config
from .local import SetupError, TailscaleServe


def main() -> None:
    # Messages are encrypted, but metadata and uploads are still private.
    os.umask(0o077)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    env = dict(os.environ)
    serve = None
    url = None
    if "--tailscale" in sys.argv[1:]:
        env.setdefault("TAILCHAT_AUTH", "serve")
        env.setdefault("TAILCHAT_HOST", "127.0.0.1")
    try:
        config = load_config(env)
        if "--tailscale" in sys.argv[1:]:
            if config.auth != "serve":
                raise ValueError("--tailscale only works with TAILCHAT_AUTH=serve")
            serve = TailscaleServe(config.port, config.data_dir)
            secret, url = serve.prepare()
            config = load_config({**env, "TAILCHAT_SERVE_SECRET": secret})
    except (ValueError, SetupError) as err:
        sys.exit(f"tailchat: {err}")
    scheme = "https" if config.tls_cert else "http"
    where = f"{scheme}://{config.host or '0.0.0.0'}:{config.port}"
    print(f"Tailchat listening on {where} (auth: {config.auth}, data: {config.data_dir})", flush=True)
    if url:
        print(f"Open {url} on any device signed in to your tailnet. Press Ctrl+C to stop.", flush=True)
    elif config.auth == "serve":
        print(f"Expose it on your tailnet with:  tailscale serve --bg --https=443 {where}", flush=True)
    if config.auth == "dev":
        print(f"Dev mode: open {where}/dev/login", flush=True)
    try:
        web.run_app(
            create_app(config),
            host=config.host or None,
            port=config.port,
            ssl_context=ssl_context(config),
            print=None,
            access_log=None,
        )
    finally:
        if serve:
            serve.stop()


if __name__ == "__main__":
    main()
