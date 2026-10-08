// Perfiles de conexión guardados en SQLite (data/visor.db).
// Las contraseñas van cifradas con la bóveda; la API pública nunca devuelve contraseñas.
// Usa el módulo integrado node:sqlite (Node 22.5+), sin dependencias extra.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const vault = require('./vault');

fs.mkdirSync(vault.DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(vault.DATA_DIR, 'visor.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS profiles (
    id       TEXT PRIMARY KEY,
    name     TEXT NOT NULL,
    log_dir  TEXT NOT NULL DEFAULT '',
    log_file TEXT NOT NULL,
    jump     TEXT,            -- JSON de la credencial del salto (contraseña cifrada) o NULL
    target   TEXT NOT NULL    -- JSON de la credencial del destino (contraseña cifrada)
  )
`);

const upsertStmt = db.prepare(`
  INSERT INTO profiles (id, name, log_dir, log_file, jump, target)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name,
    log_dir = excluded.log_dir,
    log_file = excluded.log_file,
    jump = excluded.jump,
    target = excluded.target
`);

function upsert(p) {
  upsertStmt.run(p.id, p.name, p.logDir, p.logFile, p.jump ? JSON.stringify(p.jump) : null, JSON.stringify(p.target));
}

function fromRow(row) {
  return {
    id: row.id,
    name: row.name,
    logDir: row.log_dir,
    logFile: row.log_file,
    jump: row.jump ? JSON.parse(row.jump) : null,
    target: JSON.parse(row.target),
  };
}

// Migra data/profiles.json (versión anterior) a la base de datos, una sola vez
function migrateJsonIfNeeded() {
  const old = path.join(vault.DATA_DIR, 'profiles.json');
  if (!fs.existsSync(old)) return;
  const count = db.prepare('SELECT COUNT(*) AS n FROM profiles').get().n;
  if (count === 0) {
    for (const p of JSON.parse(fs.readFileSync(old, 'utf8'))) upsert(p);
  }
  fs.renameSync(old, `${old}.migrado`);
}
migrateJsonIfNeeded();

function readAll() {
  return db.prepare('SELECT * FROM profiles ORDER BY rowid').all().map(fromRow);
}

function publicCred(c) {
  if (!c) return null;
  return { host: c.host, port: c.port, user: c.user, hasPassword: !!c.password };
}

function publicView(p) {
  return {
    id: p.id,
    name: p.name,
    logDir: p.logDir,
    logFile: p.logFile,
    jump: publicCred(p.jump),
    target: publicCred(p.target),
  };
}

function list() {
  return readAll().map(publicView);
}

function get(id) {
  const row = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id);
  return row ? fromRow(row) : null;
}

// Construye una credencial nueva. Si no llega contraseña, conserva la anterior.
function buildCred(incoming, previous) {
  const cred = {
    host: String(incoming.host || '').trim(),
    port: Number(incoming.port) || 22,
    user: String(incoming.user || '').trim(),
    password: null,
  };
  if (!cred.host || !cred.user) throw new Error('Falta host o usuario');
  if (incoming.password) cred.password = vault.encrypt(incoming.password);
  else if (previous && previous.password) cred.password = previous.password;
  if (!cred.password) throw new Error(`Falta la contraseña de ${cred.user}@${cred.host}`);
  return cred;
}

function save(input) {
  const previous = input.id ? get(input.id) : null;
  if (input.id && !previous) throw new Error('Perfil no encontrado');

  const profile = {
    id: previous ? previous.id : crypto.randomUUID(),
    name: String(input.name || '').trim() || 'Sin nombre',
    logDir: String(input.logDir || '').trim(),
    logFile: String(input.logFile || '').trim(),
    jump: input.jump && input.jump.host ? buildCred(input.jump, previous && previous.jump) : null,
    target: buildCred(input.target, previous && previous.target),
  };
  if (!profile.logFile) throw new Error('Falta el nombre del archivo log');

  upsert(profile);
  return publicView(profile);
}

function remove(id) {
  db.prepare('DELETE FROM profiles WHERE id = ?').run(id);
}

// Duplica un perfil. Las contraseñas cifradas se copian tal cual (misma bóveda),
// así la copia funciona sin volver a escribirlas; luego se edita como cualquier perfil.
function clone(id) {
  const src = get(id);
  if (!src) throw new Error('Perfil no encontrado');
  const copy = { ...src, id: crypto.randomUUID(), name: `${src.name} (copia)` };
  upsert(copy);
  return publicView(copy);
}

// Devuelve el perfil con contraseñas en claro. Solo para uso interno al abrir una sesión.
function decrypted(id) {
  const p = get(id);
  if (!p) throw new Error('Perfil no encontrado');
  const plain = (c) => (c ? { host: c.host, port: c.port, user: c.user, password: vault.decrypt(c.password) } : null);
  return { id: p.id, name: p.name, logDir: p.logDir, logFile: p.logFile, jump: plain(p.jump), target: plain(p.target) };
}

module.exports = { list, get, save, remove, clone, decrypted };
