import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = createApp(config);
const address = await app.listen();
const where = `${config.tlsCert ? 'https' : 'http'}://${address.address}:${address.port}`;
console.log(`Tailchat listening on ${where} (auth: ${config.auth}, data: ${config.dataDir})`);
if (config.auth === 'serve') {
  console.log(`Expose it on your tailnet with:  tailscale serve --bg --https=443 ${where}`);
}
if (config.auth === 'dev') console.log(`Dev mode: open ${where}/dev/login`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await app.close();
    process.exit(0);
  });
}
