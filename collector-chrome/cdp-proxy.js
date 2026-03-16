// Simple HTTP+WebSocket proxy: 0.0.0.0:9222 → 127.0.0.1:9223
// Rewrites Host header to localhost so Chrome accepts the connection
const http = require('http');
const net = require('net');

const TARGET = '127.0.0.1';
const TARGET_PORT = 9223;
const LISTEN_PORT = 9222;

const server = http.createServer((req, res) => {
  const proxy = http.request({
    hostname: TARGET, port: TARGET_PORT,
    path: req.url, method: req.method,
    headers: { ...req.headers, host: `${TARGET}:${TARGET_PORT}` },
  }, (pRes) => {
    // Rewrite webSocketDebuggerUrl in /json/version
    if (req.url.includes('/json/')) {
      let body = '';
      pRes.on('data', c => body += c);
      pRes.on('end', () => {
        body = body.replace(/127\.0\.0\.1:9223/g, `0.0.0.0:${LISTEN_PORT}`);
        body = body.replace(/localhost:9223/g, `0.0.0.0:${LISTEN_PORT}`);
        res.writeHead(pRes.statusCode, pRes.headers);
        res.end(body);
      });
    } else {
      res.writeHead(pRes.statusCode, pRes.headers);
      pRes.pipe(res);
    }
  });
  proxy.on('error', () => res.destroy());
  req.pipe(proxy);
});

// WebSocket upgrade
server.on('upgrade', (req, socket, head) => {
  const proxy = net.connect(TARGET_PORT, TARGET, () => {
    const upgReq = `${req.method} ${req.url} HTTP/1.1\r\n` +
      Object.entries({ ...req.headers, host: `${TARGET}:${TARGET_PORT}` })
        .map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n';
    proxy.write(upgReq);
    if (head.length) proxy.write(head);
    socket.pipe(proxy).pipe(socket);
  });
  proxy.on('error', () => socket.destroy());
  socket.on('error', () => proxy.destroy());
});

server.listen(LISTEN_PORT, '0.0.0.0', () => {
  console.log(`CDP proxy: 0.0.0.0:${LISTEN_PORT} → ${TARGET}:${TARGET_PORT}`);
});
