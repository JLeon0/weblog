// Servidor local: sirve la interfaz web, la API de perfiles/bóveda y un WebSocket
// que transmite las líneas de los logs al navegador. Solo escucha en 127.0.0.1.
// Un mismo WebSocket atiende varios perfiles: cada mensaje lleva el profileId.
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

// WebSocket: el navegador se suscribe a uno o varios perfiles (una pestaña cada uno).
// Cada mensaje lleva profileId para que el cliente sepa a qué pestaña pertenece.
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
  const subs = new Map(); // profileId -> { session, listeners }

  const detach = (id) => {
    const sub = subs.get(id);
    if (!sub) return;
    sub.session.off('lines', sub.listeners.lines);
    sub.session.off('status', sub.listeners.status);
    subs.delete(id);
  };

  const sendBacklog = (id, session) => {
    send(ws, { type: 'backlog', profileId: id, lines: session.lines, state: session.state });
  };

  const attach = (id, session) => {
    const listeners = {
      lines: (lines) => send(ws, { type: 'lines', profileId: id, lines }),
      status: (st) => send(ws, { type: 'status', profileId: id, ...st }),
    };
    session.on('lines', listeners.lines);
    session.on('status', listeners.status);
    subs.set(id, { session, listeners });
    sendBacklog(id, session);
  };

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch (_) {
      return;
    }
    const id = msg.profileId;

    try {
      if (msg.type === 'subscribe') {
        if (!vault.isUnlocked()) throw new Error('Bóveda bloqueada');
        if (subs.has(id)) return sendBacklog(id, subs.get(id).session);
        let session = sessions.get(id);
        if (!session) {
          session = new LogSession(profiles.decrypted(id));
          sessions.set(id, session);
        }
        attach(id, session);
        session.start();
      }

      if (msg.type === 'unsubscribe') detach(id); // la sesión sigue viva en el servidor

      // Cierra la conexión del perfil; la pestaña sigue suscrita para poder reiniciarla
      if (msg.type === 'stop') {
        const session = sessions.get(id);
        if (session) {
          session.stop(); // emite status "stopped" a quien esté suscrito
          sessions.delete(id);
        }
      }

      if (msg.type === 'restart') {
        const old = sessions.get(id);
        if (old) old.stop();
        detach(id);
        const fresh = new LogSession(profiles.decrypted(id));
        sessions.set(id, fresh);
        attach(id, fresh);
        fresh.start();
      }
    } catch (err) {
      send(ws, { type: 'error', profileId: id, msg: err.message });
    }
  });

  ws.on('close', () => {
    for (const id of [...subs.keys()]) detach(id);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Visor de logs listo en http://${HOST}:${PORT}`);
});

process.on('SIGINT', () => {
  stopAllSessions();
  process.exit(0);
});
