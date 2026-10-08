// Bóveda: cifra las contraseñas en disco con AES-256-GCM.
// La clave se deriva de una clave maestra (scrypt) que pides al arrancar la app.
// La clave maestra nunca se guarda; sin ella no se pueden leer las contraseñas.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const VAULT_FILE = path.join(DATA_DIR, 'vault.json');
const CHECK_TEXT = 'vault-ok';

let key = null; // clave derivada, solo en memoria mientras la bóveda está desbloqueada

function deriveKey(master, saltB64) {
  return crypto.scryptSync(master, Buffer.from(saltB64, 'base64'), 32);
}

function encryptWith(k, text) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', k, iv);
  const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

function decryptWith(k, box) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(box.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(box.data, 'base64')), decipher.final()]).toString('utf8');
}

function exists() {
  return fs.existsSync(VAULT_FILE);
}

function isUnlocked() {
  return key !== null;
}

function setup(master) {
  if (exists()) throw new Error('La bóveda ya existe');
  if (!master || master.length < 8) throw new Error('La clave maestra debe tener al menos 8 caracteres');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const salt = crypto.randomBytes(16).toString('base64');
  const k = deriveKey(master, salt);
  const vault = { salt, check: encryptWith(k, CHECK_TEXT) };
  fs.writeFileSync(VAULT_FILE, JSON.stringify(vault, null, 2));
  key = k;
}

function unlock(master) {
  if (!exists()) throw new Error('Primero crea la bóveda');
  const vault = JSON.parse(fs.readFileSync(VAULT_FILE, 'utf8'));
  const k = deriveKey(master || '', vault.salt);
  let ok = false;
  try {
    ok = decryptWith(k, vault.check) === CHECK_TEXT;
  } catch (_) {
    ok = false;
  }
  if (!ok) throw new Error('Clave maestra incorrecta');
  key = k;
}

function lock() {
  key = null;
}

function encrypt(text) {
  if (!key) throw new Error('La bóveda está bloqueada');
  return encryptWith(key, text);
}

function decrypt(box) {
  if (!key) throw new Error('La bóveda está bloqueada');
  return decryptWith(key, box);
}

module.exports = { DATA_DIR, exists, isUnlocked, setup, unlock, lock, encrypt, decrypt };
