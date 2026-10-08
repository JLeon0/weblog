// Servidor local: sirve la interfaz web, la API de perfiles/bóveda y un WebSocket
// que transmite las líneas del log al navegador. Solo escucha en 127.0.0.1.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const vault = require('./src/vault');
const profiles = require('./src/profiles');
const { LogSession } = require('./src/logSession');

const PORT = Number(process.env.PORT) || 3000;
const HOST = '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, 'public');

const sessions = new Map(); // profileId -> LogSession (sobreviven aunque cierres la pestaña)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) {
        reject(new Error('Petición demasiado grande'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (_) {
        reject(new Error('JSON no válido'));
      }
    });
    req.on('error', reject);
  });
}

function stopAllSessions() {
  for (const s of sessions.values()) s.stop();
  sessions.clear();
}

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;

  if (method === 'GET' && pathname === '/api/state') {
    return sendJson(res, 200, { vaultExists: vault.exists(), unlocked: vault.isUnlocked() });
  }
  if (method === 'POST' && pathname === '/api/setup') {
    const { master } = await readBody(req);
    vault.setup(master);
    return sendJson(res, 200, { ok: true });
  }
  if (method === 'POST' && pathname === '/api/unlock') {
    const { master } = await readBody(req);
    vault.unlock(master);
    return sendJson(res, 200, { ok: true });
  }
  if (method === 'POST' && pathname === '/api/lock') {
    stopAllSessions();
    vault.lock();
    return sendJson(res, 200, { ok: true });
  }
  if (method === 'GET' && pathname === '/api/profiles') {
    return sendJson(res, 200, profiles.list());
  }
  if (method === 'POST' && /^\/api\/profiles\/[^/]+\/clone$/.test(pathname)) {
    const id = decodeURIComponent(pathname.split('/')[3]);
    return sendJson(res, 200, profiles.clone(id));
  }
  if (method === 'POST' && pathname === '/api/profiles') {
    if (!vault.isUnlocked()) return sendJson(res, 403, { error: 'Desbloquea la bóveda primero' });
    const saved = profiles.save(await readBody(req));
    return sendJson(res, 200, saved);
  }
  if (method === 'DELETE' && pathname.startsWith('/api/profiles/')) {
    const id = decodeURIComponent(pathname.slice('/api/profiles/'.length));
    if (sessions.has(id)) {
      sessions.get(id).stop();
      sessions.delete(id);
    }
    profiles.remove(id);
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 404, { error: 'No encontrado' });
}

function serveStatic(req, res, url) {
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('No encontrado');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (url.pathname.startsWith('/api/')) {
    try {
      await handleApi(req, res, url);
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }
  serveStatic(req, res, url);
});

// WebSocket: el navegador se suscribe a un perfil y recibe el buffer + líneas nuevas
const wss = new WebSocketServer({
  server,
  path: '/ws',
  verifyClient: ({ req }) => {
    // Solo aceptamos peticiones desde la propia app local
    const origin = req.headers.origin;
    return !origin || origin.startsWith(`http://${HOST}:${PORT}`) || origin.startsWith(`http://localhost:${PORT}`);
  },
});

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

wss.on('connection', (ws) => {
  let current = null; // { session, listeners }

  const detach = () => {
    if (!current) return;
    const { session, listeners } = current;
    session.off('lines', listeners.lines);
    session.off('status', listeners.status);
    current = null;
  };

  const attach = (session) => {
    const listeners = {
      lines: (lines) => send(ws, { type: 'lines', lines }),
      status: (st) => send(ws, { type: 'status', ...st }),
    };
    session.on('lines', listeners.lines);
    session.on('status', listeners.status);
    current = { session, listeners };
    send(ws, { type: 'backlog', lines: session.lines, state: session.state });
  };

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (_) {
      return;
    }

    if (msg.type === 'subscribe') {
      detach();
      if (!vault.isUnlocked()) return send(ws, { type: 'error', msg: 'Bóveda bloqueada' });
      try {
        let session = sessions.get(msg.profileId);
        if (!session) {
          session = new LogSession(profiles.decrypted(msg.profileId));
          sessions.set(msg.profileId, session);
        }
        attach(session);
        session.start();
      } catch (err) {
        send(ws, { type: 'error', msg: err.message });
      }
    }

    if (msg.type === 'restart' && current) {
      const { session } = current;
      session.stop();
      const fresh = new LogSession(profiles.decrypted(msg.profileId));
      sessions.set(msg.profileId, fresh);
      detach();
      attach(fresh);
      fresh.start();
    }

    // Cierra la conexión del perfil. Se mantiene suscrito para poder reiniciarla después.
    if (msg.type === 'stop' && current) {
      const session = sessions.get(msg.profileId);
      if (session) {
        session.stop(); // emite status "stopped" al navegador
        sessions.delete(msg.profileId);
      }
    }

    if (msg.type === 'unsubscribe') detach();
  });

  ws.on('close', detach);
});

server.listen(PORT, HOST, () => {
  console.log(`Visor de logs listo en http://${HOST}:${PORT}`);
});

process.on('SIGINT', () => {
  stopAllSessions();
  process.exit(0);
});
