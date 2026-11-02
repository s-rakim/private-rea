// An https front for a Tailchat dev server, for the emulator test: the app
// only opens https addresses. Everything through it is signed in as one dev
// user (the X-Dev-User header), the way Tailscale says who you are.
//
//   node tls-proxy.cjs cert.pem key.pem [listen port] [server port] [user]

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

const [certFile, keyFile, listen = '8443', target = '8099', user = 'malcolm'] = process.argv.slice(2);
const upstream = { host: '127.0.0.1', port: Number(target) };

const server = https.createServer({ cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }, (req, res) => {
  const up = http.request({ ...upstream, method: req.method, path: req.url, headers: { ...req.headers, 'x-dev-user': user } }, (r) => {
    res.writeHead(r.statusCode, r.rawHeaders);
    r.pipe(res);
  });
  up.on('error', () => res.destroy());
  req.pipe(up);
});

// WebSockets: pass the upgrade on as it came, plus the user.
server.on('upgrade', (req, socket, head) => {
  const up = net.connect(upstream.port, upstream.host, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (req.rawHeaders[i].toLowerCase() !== 'x-dev-user') lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    lines.push(`X-Dev-User: ${user}`);
    up.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) up.write(head);
    up.pipe(socket);
    socket.pipe(up);
  });
  up.on('error', () => socket.destroy());
  socket.on('error', () => up.destroy());
});

server.listen(Number(listen), '127.0.0.1', () => console.log(`https://localhost:${listen} -> http://127.0.0.1:${target} as ${user}`));
