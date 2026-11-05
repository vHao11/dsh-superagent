// Local HTTP CONNECT proxy that pins GitHub hostnames to working IPs.
// Needed on networks whose internal DNS returns NXDOMAIN for api.github.com /
// codeload.github.com while github.com resolves. Run in the background:
//   node github-pin-proxy.mjs [port]
import net from 'node:net';

const PORT = Number(process.argv[2] || 8899);
const PINS = {
  'github.com': ['20.205.243.166', '20.27.177.113', '20.205.243.168'],
  'api.github.com': ['20.205.243.168', '20.205.243.166'],
  'codeload.github.com': ['20.205.243.166', '20.205.243.168'],
  'raw.githubusercontent.com': ['185.199.108.133', '185.199.109.133'],
  'objects.githubusercontent.com': ['185.199.108.133'],
};

const ts = () => new Date().toISOString();
const log = (...a) => console.error(ts(), ...a);

const server = net.createServer((client) => {
  client.once('data', (chunk) => {
    const head = chunk.toString('latin1');
    const m = /^CONNECT ([^:\s]+):(\d+) /i.exec(head.split('\r\n')[0] || '');
    if (!m) { client.destroy(); return; }
    const host = m[1].toLowerCase();
    const port = Number(m[2]);
    const ips = PINS[host];
    if (!ips) { log('[deny]', host); client.destroy(); return; }
    let attempt = 0;
    const connectNext = () => {
      const ip = ips[attempt % ips.length];
      attempt += 1;
      const upstream = net.connect(port, ip);
      upstream.setTimeout(15000, () => { upstream.destroy(); });
      upstream.once('connect', () => {
        upstream.setTimeout(0);
        log('[ok]', host, '->', ip);
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.once('error', (e) => {
        log('[fail]', host, ip, e.code || e.message);
        upstream.destroy();
        if (attempt <= ips.length) connectNext(); else client.destroy();
      });
    };
    client.on('error', () => {});
    connectNext();
  });
});
server.listen(PORT, '127.0.0.1', () => log('[listening]', PORT));
