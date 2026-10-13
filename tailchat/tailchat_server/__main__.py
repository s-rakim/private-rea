"""Run the Tailchat server: python -m tailchat_server"""

from __future__ import annotations

import logging
import sys

from aiohttp import web

from .app import create_app, ssl_context
from .config import load_config


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    try:
        config = load_config()
    except ValueError as err:
        sys.exit(f"tailchat: {err}")
    scheme = "https" if config.tls_cert else "http"
    where = f"{scheme}://{config.host or '0.0.0.0'}:{config.port}"
    print(f"Tailchat listening on {where} (auth: {config.auth}, data: {config.data_dir})", flush=True)
    if config.auth == "serve":
        print(f"Expose it on your tailnet with:  tailscale serve --bg --https=443 {where}", flush=True)
    if config.auth == "dev":
        print(f"Dev mode: open {where}/dev/login", flush=True)
    web.run_app(
        create_app(config),
        host=config.host or None,
        port=config.port,
        ssl_context=ssl_context(config),
        print=None,
        access_log=None,
    )


if __name__ == "__main__":
    main()
