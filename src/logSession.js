// Sesión de log: conecta (opcionalmente pasando por un jump host), ejecuta
// `tail -F` sobre el archivo y reenvía las líneas. Si se cae la conexión,
// reintenta con espera creciente. Mantiene un buffer de las últimas líneas.
const { Client } = require('ssh2');
const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');

// Algoritmos antiguos incluidos: el servidor del cliente solo acepta estos
// (equivale al "-legacy" de OpenSSH). Los modernos van primero.
const ALGORITHMS = {
  kex: [
    'curve25519-sha256',
    'ecdh-sha2-nistp256',
    'diffie-hellman-group14-sha256',
    'diffie-hellman-group14-sha1',
    'diffie-hellman-group1-sha1',
    'diffie-hellman-group-exchange-sha256',
    'diffie-hellman-group-exchange-sha1',
  ],
  serverHostKey: ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'rsa-sha2-512', 'rsa-sha2-256', 'ssh-rsa', 'ssh-dss'],
};

const MAX_LINES = 5000;
const INITIAL_TAIL = 200;
const KEEPALIVE_MS = 20000; // igual que ServerAliveInterval=20
const MAX_BACKOFF_MS = 30000;

const STEP_TIMEOUT_MS = 15000; // tope para abrir la ruta al destino y para arrancar tail

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (promise, ms, what) => {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`tiempo agotado ${what}`)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
};
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`; // escapa para shell remoto

function connect(cred, sock, onError) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client.once('ready', () => resolve(client));
    client.once('error', reject);
    client.on('error', onError);
    // Si la conexión se cierra sin error (red caída, servidor reiniciado), también hay que reconectar
    client.on('close', () => onError(new Error('la conexión SSH se cerró')));
    client.on('end', () => onError(new Error('el servidor cerró la conexión SSH')));
    // Algunos servidores piden contraseña por keyboard-interactive en vez de password
    client.on('keyboard-interactive', (_name, _instr, _lang, _prompts, finish) => finish([cred.password]));
    client.connect({
      host: cred.host,
      port: cred.port,
      username: cred.user,
      password: cred.password,
      sock,
      tryKeyboard: true,
      readyTimeout: 20000,
      keepaliveInterval: KEEPALIVE_MS,
      keepaliveCountMax: 3,
      algorithms: ALGORITHMS,
    });
  });
}

// Ejecuta un comando que termina solo (no tail -f) y devuelve su salida completa en bytes
function execCollect(client, cmd, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('el servidor no respondió al leer el log')), timeoutMs);
    client.exec(cmd, (err, stream) => {
      if (err) {
        clearTimeout(timer);
        return reject(err);
      }
      const chunks = [];
      let errOut = '';
      stream.on('data', (d) => chunks.push(d));
      stream.stderr.on('data', (d) => (errOut += d.toString('utf8')));
      stream.on('close', () => {
        clearTimeout(timer);
        resolve({ buf: Buffer.concat(chunks), errOut });
      });
      stream.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  });
}

function forward(client, host, port) {
  return new Promise((resolve, reject) => {
    client.forwardOut('127.0.0.1', 0, host, port, (err, stream) => (err ? reject(err) : resolve(stream)));
  });
}

class LogSession extends EventEmitter {
  // profile: resultado de profiles.decrypted(id)
  constructor(profile) {
    super();
    this.profile = profile;
    this.state = 'idle';
    this.lines = [];
    this.stopped = true;
    this.finish = null;
    this.clients = [];
    this.everConnected = false;
    this.offset = null; // bytes del archivo ya leídos (null = aún no se leyó nada)
  }

  get label() {
    const t = this.profile.target;
    return `${t.user}@${t.host}:${this.profile.logDir}/${this.profile.logFile}`;
  }

  setState(state, msg = '') {
    this.state = state;
    this.emit('status', { state, msg });
  }

  pushText(text) {
    const parts = (this.partial + text).split(/\r?\n/);
    this.partial = parts.pop();
    if (parts.length === 0) return;
    this.lines.push(...parts);
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
    this.emit('lines', parts);
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.partial = '';
    this.decoder = new StringDecoder('utf8');
    this.run();
  }

  stop() {
    this.stopped = true;
    if (this.finish) this.finish(new Error('Detenido por el usuario'));
    this.setState('stopped');
  }

  async run() {
    // La espera crece con cada fallo seguido y vuelve a 2 s cuando una conexión se establece
    this.backoff = 2000;
    while (!this.stopped) {
      try {
        this.setState('connecting', this.everConnected ? 'Reconectando...' : 'Conectando...');
        await this.connectOnce();
      } catch (err) {
        if (this.stopped) break;
        const delay = this.backoff;
        this.setState('reconnecting', `Conexión perdida: ${err.message}. Reintento en ${Math.round(delay / 1000)} s`);
        await sleep(delay);
        this.backoff = Math.min(delay * 2, MAX_BACKOFF_MS);
        continue;
      }
      // La conexión terminó sin error (el servidor cerró el tail): reintentar
      if (this.stopped) break;
      this.setState('reconnecting', 'El servidor cerró la conexión. Reintento en 2 s');
      await sleep(2000);
    }
    this.setState('stopped');
  }

  // Abre la cadena de conexiones y ejecuta tail. Resuelve/rechaza cuando el canal termina.
  connectOnce() {
    return new Promise(async (resolve, reject) => {
      let settled = false;
      let execTimer = null;
      const done = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(execTimer);
        this.closeClients();
        this.finish = null;
        err ? reject(err) : resolve();
      };
      this.finish = done;
      const onError = (err) => done(err);

      try {
        const { jump, target, logDir, logFile } = this.profile;
        let sock;
        if (jump) {
          this.setState('connecting', `Conectando al salto ${jump.user}@${jump.host}...`);
          const jumpClient = await connect(jump, undefined, onError);
          this.clients.push(jumpClient);
          this.setState('connecting', `Salto conectado. Abriendo ruta hacia ${target.host}:${target.port}...`);
          try {
            sock = await withTimeout(forward(jumpClient, target.host, target.port), STEP_TIMEOUT_MS, 'abriendo la ruta al destino');
          } catch (err) {
            // El salto conectó, pero desde él no se llega al destino (host/puerto incorrectos, bloqueado o sin respuesta)
            throw new Error(`el servidor intermedio no pudo llegar a ${target.host}:${target.port} (${err.message})`);
          }
        }
        this.setState('connecting', `Conectando a ${target.user}@${target.host}...`);
        const targetClient = await connect(target, sock, onError);
        this.clients.push(targetClient);

        // Posición en bytes del archivo hasta donde ya se leyó. Al reconectar se retoma desde ahí,
        // así las líneas escritas durante la caída también aparecen.
        let reconnecting = this.offset !== null;
        if (reconnecting) {
          const { buf } = await execCollect(targetClient, `cd ${shq(logDir)} && wc -c < ${shq(logFile)}`, STEP_TIMEOUT_MS);
          const size = Number(buf.toString('utf8').trim());
          if (!Number.isFinite(size)) throw new Error(`no se pudo leer el tamaño de ${logFile}`);
          if (size < this.offset) {
            // El archivo fue recortado o reemplazado: se vuelve a leer desde las últimas líneas
            this.offset = null;
            reconnecting = false;
          }
        }

        if (this.offset === null) {
          // Primera lectura: últimas 200 líneas. El final va marcado con el tamaño exacto del archivo.
          const snap = `cd ${shq(logDir)} && tail -n ${INITIAL_TAIL} ${shq(logFile)} && printf '\\0__END__%s' "$(wc -c < ${shq(logFile)})"`;
          const { buf, errOut } = await execCollect(targetClient, snap, STEP_TIMEOUT_MS);
          const trailerAt = buf.lastIndexOf(0);
          const trailer = trailerAt >= 0 ? buf.slice(trailerAt).toString('ascii') : '';
          const endM = trailer.match(/^\0__END__(\d+)$/);
          if (!endM) throw new Error(`no se pudo leer ${logFile}${errOut ? `: ${errOut.trim()}` : ''}`);
          this.pushText(this.decoder.write(buf.slice(0, trailerAt)));
          this.offset = Number(endM[1]);
        }

        this.everConnected = true;
        const cmd = `cd ${shq(logDir)} && tail -c +${this.offset + 1} -F ${shq(logFile)}`;

        // Si el servidor no responde al comando, no quedarse esperando para siempre
        execTimer = setTimeout(() => done(new Error('el destino no respondió al iniciar tail')), STEP_TIMEOUT_MS);
        this.setState('connecting', 'Ejecutando tail en el servidor...');
        targetClient.exec(cmd, (err, stream) => {
          clearTimeout(execTimer);
          if (err) return done(err);
          this.backoff = 2000; // conexión buena: el siguiente corte se reintenta rápido
          this.setState('connected', `Conectado a ${this.label}`);
          if (reconnecting) {
            this.pushText(`--- reconectado ${new Date().toLocaleTimeString()} ---\n`);
          }
          stream.on('data', (d) => {
            this.offset += d.length; // bytes exactos del archivo
            this.pushText(this.decoder.write(d));
          });
          stream.stderr.on('data', (d) => this.emit('status', { state: 'warn', msg: d.toString('utf8').trim() }));
          stream.on('close', () => done(new Error('El canal de tail se cerró')));
          stream.on('error', (e) => done(e));
        });
      } catch (err) {
        done(err);
      }
    });
  }

  closeClients() {
    for (const c of this.clients) {
      try {
        c.end();
      } catch (_) {
        /* ya cerrado */
      }
    }
    this.clients = [];
  }
}

module.exports = { LogSession };
