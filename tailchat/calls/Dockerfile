# Tailchat's call service, built from the peer-calls source in this folder
# (see README.md). docker compose builds it on your own machine; the running
# container needs nothing from outside your tailnet.

# The full Node image comes with git, which npm needs: one dependency
# (simple-peer) is a git checkout.
FROM node:22-bookworm AS frontend
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM golang:1.24-alpine AS server
ENV CGO_ENABLED=0
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=frontend /src/build/ ./build/
RUN go build -mod=readonly -trimpath -ldflags "-s -w -X main.GitDescribe=v4.2.7-tailchat" -o peer-calls .

FROM scratch
COPY --from=server /src/peer-calls /usr/local/bin/peer-calls
USER 65534:65534
EXPOSE 3000/tcp
STOPSIGNAL SIGINT
ENTRYPOINT ["/usr/local/bin/peer-calls"]
