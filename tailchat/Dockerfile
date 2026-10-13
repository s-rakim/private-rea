# Tailchat server. Run it next to a Tailscale container (see docker-compose.yml)
# so it is only ever reachable from your tailnet.
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TAILCHAT_AUTH=serve \
    TAILCHAT_HOST=127.0.0.1 \
    TAILCHAT_PORT=8443 \
    TAILCHAT_DATA=/data

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
 && useradd --system --uid 10001 --home-dir /data tailchat \
 && mkdir -p /data && chown tailchat /data

COPY tailchat_server ./tailchat_server
COPY public ./public

USER tailchat
VOLUME /data
CMD ["python", "-m", "tailchat_server"]
