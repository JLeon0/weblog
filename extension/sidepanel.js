// Panel lateral: navega las filas de la matriz de pruebas en Google Sheets y
// guarda capturas en la columna Evidencia (la imagen se sube a tu Google Drive).
// Usa la cuenta de Google con la que inicies sesión en Chrome (chrome.identity).

const DEFAULT_SHEET_ID = '1kt9jqLDhTPPL3m3Pm8z1BzXMZklFS7eD8RROQI5-nXk';
const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

const $ = (id) => document.getElementById(id);
const state = {
  spreadsheetId: null,
  sheetTitle: null,
  cols: {}, // índices de columnas: usuario, funcionalidad, datos, pasos, evidencia
  rows: [], // { sheetRow, cells }
  current: 0,
  blob: null,
  previewUrl: null,
};

// ---------- Utilidades ----------
function setStatus(msg, kind = '') {
  const s = $('status');
  s.textContent = msg;
  s.className = `status ${kind}`;
}

// Normaliza encabezados: sin acentos, minúsculas y espacios simples
const norm = (s) =>
  String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

// Índice de columna (0-based) -> letra de Sheets (0 = A, 26 = AA)
function colLetter(i) {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function parseSheetId(input) {
  const m = input.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (m) return m[1];
  const t = input.trim();
  return /^[a-zA-Z0-9-_]{20,}$/.test(t) ? t : null;
}

const isEvidenceFormula = (v) => /^=\s*(IMAGE|HYPERLINK)\(/i.test(v.trim());

// ---------- Autenticación ----------
function getToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError || !token) {
        reject(new Error(chrome.runtime.lastError?.message || 'No se obtuvo token de Google'));
      } else resolve(token);
    });
  });
}

function dropToken(token) {
  return new Promise((resolve) => chrome.identity.removeCachedAuthToken({ token }, resolve));
}

// fetch autenticado; si el token caducó, lo renueva una vez
async function gfetch(url, opts = {}, retry = true) {
  const token = await getToken(true);
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });
  if (res.status === 401 && retry) {
    await dropToken(token);
    return gfetch(url, opts, false);
  }
  if (!res.ok) {
    let msg = `Error ${res.status}`;
    try {
      const j = await res.json();
      msg = j.error?.message || msg;
    } catch (_) {
      /* respuesta sin JSON */
    }
    throw new Error(msg);
  }
  return res;
}

async function refreshAuthButton() {
  try {
    await getToken(false);
    $('auth-btn').textContent = 'Cuenta conectada';
    $('auth-btn').classList.add('secondary');
    return true;
  } catch (_) {
    $('auth-btn').textContent = 'Conectar Google';
    $('auth-btn').classList.remove('secondary');
    return false;
  }
}

$('auth-btn').addEventListener('click', async () => {
  try {
    if (await refreshAuthButton()) {
      // Ya conectada: al pulsar de nuevo se cierra la sesión de la extensión
      const token = await getToken(false);
      await dropToken(token);
      setStatus('Sesión de la extensión cerrada.');
      await refreshAuthButton();
      return;
    }
    await getToken(true);
    await refreshAuthButton();
    setStatus('Cuenta conectada.', 'ok');
  } catch (err) {
    setStatus(err.message, 'error');
  }
});

// ---------- Carga de hoja y filas ----------
async function loadSheet() {
  const id = parseSheetId($('sheet-input').value);
  if (!id) return setStatus('La URL o el ID de la hoja no es válido.', 'error');
  state.spreadsheetId = id;
  chrome.storage.local.set({ spreadsheetId: id });

  setStatus('Leyendo pestañas de la hoja…');
  const meta = await (await gfetch(`${SHEETS}/${id}?fields=sheets(properties(title))`)).json();
  const titles = meta.sheets.map((s) => s.properties.title);

  const saved = (await chrome.storage.local.get('sheetTitle')).sheetTitle;
  const select = $('tab-select');
  select.replaceChildren();
  for (const t of titles) {
    const o = document.createElement('option');
    o.value = t;
    o.textContent = t;
    select.appendChild(o);
  }
  select.disabled = false;
  await loadTab(titles.includes(saved) ? saved : titles[0]);
}

async function loadTab(title) {
  setStatus(`Leyendo "${title}"…`);
  state.sheetTitle = title;
  $('tab-select').value = title;
  chrome.storage.local.set({ sheetTitle: title });

  const range = encodeURIComponent(`'${title.replace(/'/g, "''")}'`);
  const data = await (await gfetch(`${SHEETS}/${state.spreadsheetId}/values/${range}?valueRenderOption=FORMULA`)).json();
  const values = data.values || [];

  // El encabezado es la fila que contiene "Pasos" (dentro de las primeras 10 filas)
  const headerIdx = values.slice(0, 10).findIndex((r) => r.some((c) => norm(c) === 'pasos'));
  if (headerIdx < 0) throw new Error('No encontré la columna "Pasos" en esta pestaña.');

  const headers = values[headerIdx].map(norm);
  const find = (name) => headers.indexOf(name);
  state.cols = {
    usuario: find('usuario'),
    funcionalidad: find('funcionalidad'),
    datos: find('datos de entrada'),
    pasos: find('pasos'),
    evidencia: find('evidencia'),
  };
  const names = {
    usuario: 'Usuario',
    funcionalidad: 'Funcionalidad',
    datos: 'Datos de entrada',
    pasos: 'Pasos',
    evidencia: 'Evidencia',
  };
  const missing = Object.keys(state.cols).filter((k) => state.cols[k] < 0).map((k) => names[k]);
  if (missing.length) throw new Error(`Faltan columnas en esta pestaña: ${missing.join(', ')}`);

  // Fila de datos: sheetRow es el número real de fila en la hoja (1-based)
  state.rows = values
    .slice(headerIdx + 1)
    .map((cells, i) => ({ sheetRow: headerIdx + 2 + i, cells }))
    .filter((r) => r.cells.some((c) => String(c ?? '').trim() !== ''));
  state.current = 0;

  fillRowSelect();
  clearPreview();
  render();
  setStatus(`${state.rows.length} filas cargadas de "${title}".`, 'ok');
}

function fillRowSelect() {
  const select = $('row-select');
  select.replaceChildren();
  state.rows.forEach((r, i) => {
    const o = document.createElement('option');
    const func = String(r.cells[state.cols.funcionalidad] ?? '').trim();
    o.value = i;
    o.textContent = `Fila ${r.sheetRow} · ${func.slice(0, 40) || '(sin funcionalidad)'}`;
    select.appendChild(o);
  });
  select.disabled = state.rows.length === 0;
}

function render() {
  const hasRows = state.rows.length > 0;
  $('prev-btn').disabled = !hasRows || state.current === 0;
  $('next-btn').disabled = !hasRows || state.current >= state.rows.length - 1;
  $('capture-btn').disabled = !hasRows;
  $('row-select').value = state.current;

  const r = state.rows[state.current];
  if (!r) {
    for (const id of ['f-usuario', 'f-funcionalidad', 'f-datos', 'f-pasos', 'f-evidencia']) $(id).textContent = '';
    $('counter').textContent = '';
    return;
  }
  const get = (k) => String(r.cells[state.cols[k]] ?? '');
  $('f-usuario').textContent = get('usuario') || '—';
  $('f-funcionalidad').textContent = get('funcionalidad') || '—';
  $('f-datos').textContent = get('datos') || '—';
  $('f-pasos').textContent = get('pasos') || '—';

  const ev = get('evidencia').trim();
  $('f-evidencia').textContent = !ev
    ? 'Vacía'
    : isEvidenceFormula(ev)
      ? 'Ya tiene captura'
      : `Contenido: ${ev.slice(0, 80)}`;

  $('counter').textContent = `${state.current + 1} de ${state.rows.length} · fila ${r.sheetRow}`;
}

function goTo(i) {
  if (i < 0 || i >= state.rows.length) return;
  state.current = i;
  clearPreview();
  render();
}

// ---------- Captura ----------
function clearPreview() {
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = null;
  state.blob = null;
  $('preview').removeAttribute('src');
  $('preview-wrap').classList.add('hidden');
}

function setPreview(blob) {
  clearPreview();
  state.blob = blob;
  state.previewUrl = URL.createObjectURL(blob);
  $('preview').src = state.previewUrl;
  $('preview-wrap').classList.remove('hidden');
}

// Recorta la captura completa (píxeles del dispositivo) al recuadro en píxeles CSS
function cropImage(dataUrl, rect, vw, vh) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const sx = img.naturalWidth / vw;
      const sy = img.naturalHeight / vh;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(rect.w * sx));
      canvas.height = Math.max(1, Math.round(rect.h * sy));
      canvas
        .getContext('2d')
        .drawImage(img, rect.x * sx, rect.y * sy, rect.w * sx, rect.h * sy, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No se pudo generar la imagen'))), 'image/png');
    };
    img.onerror = () => reject(new Error('La captura no se pudo leer'));
    img.src = dataUrl;
  });
}

$('capture-btn').addEventListener('click', async () => {
  clearPreview();
  const res = await chrome.runtime.sendMessage({ type: 'capture:start' });
  if (!res?.ok) setStatus(res?.error || 'No se pudo iniciar la captura.', 'error');
  else setStatus('Arrastra sobre la página para elegir el área. Esc cancela.');
});

// Mensajes del service worker y del selector de la página
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'capture:image') {
    cropImage(msg.dataUrl, msg.rect, msg.vw, msg.vh)
      .then((blob) => {
        setPreview(blob);
        setStatus('Revisa la captura y pulsa "Guardar en Evidencia".');
      })
      .catch((err) => setStatus(err.message, 'error'));
  } else if (msg.type === 'capture:cancelled') {
    setStatus('Captura cancelada.');
  } else if (msg.type === 'capture:error') {
    setStatus(msg.error, 'error');
  }
});

$('discard-btn').addEventListener('click', () => {
  clearPreview();
  setStatus('Captura descartada.');
});

// ---------- Guardar evidencia ----------
async function uploadPng(blob, name) {
  const boundary = `evid${Date.now()}`;
  const meta = JSON.stringify({ name, mimeType: 'image/png' });
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`,
    `--${boundary}\r\nContent-Type: image/png\r\n\r\n`,
    blob,
    `\r\n--${boundary}--`,
  ]);
  const res = await gfetch(`${DRIVE_UPLOAD}?uploadType=multipart&fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  return res.json();
}

async function saveEvidence() {
  const r = state.rows[state.current];
  if (!r || !state.blob) return;

  const current = String(r.cells[state.cols.evidencia] ?? '').trim();
  if (current && !confirm('Esta fila ya tiene evidencia en la celda. ¿Reemplazarla? La captura anterior sigue en tu Drive.')) {
    return;
  }

  setBusy(true);
  try {
    setStatus('Subiendo captura a tu Drive…');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const safeTitle = state.sheetTitle.replace(/[^\w-]+/g, '_');
    const file = await uploadPng(state.blob, `evidencia_${safeTitle}_fila${r.sheetRow}_${stamp}.png`);

    const inline = $('show-inline').checked;
    if (inline) {
      // Necesario para que IMAGE() pueda mostrarla dentro de la celda
      await gfetch(`${DRIVE}/${file.id}/permissions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: 'reader', type: 'anyone' }),
      });
    }
    const formula = inline
      ? `=IMAGE("https://drive.google.com/uc?export=view&id=${file.id}")`
      : `=HYPERLINK("https://drive.google.com/file/d/${file.id}/view","Captura fila ${r.sheetRow}")`;

    setStatus('Escribiendo en la celda Evidencia…');
    const cell = encodeURIComponent(`'${state.sheetTitle.replace(/'/g, "''")}'!${colLetter(state.cols.evidencia)}${r.sheetRow}`);
    await gfetch(`${SHEETS}/${state.spreadsheetId}/values/${cell}?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ values: [[formula]] }),
    });

    r.cells[state.cols.evidencia] = formula;
    clearPreview();
    render();
    setStatus(`Evidencia guardada en la fila ${r.sheetRow}.`, 'ok');
  } finally {
    setBusy(false);
  }
}

function setBusy(busy) {
  $('save-btn').disabled = busy;
  $('capture-btn').disabled = busy || state.rows.length === 0;
}

$('save-btn').addEventListener('click', () => {
  saveEvidence().catch((err) => setStatus(err.message, 'error'));
});

// ---------- Navegación ----------
$('prev-btn').addEventListener('click', () => goTo(state.current - 1));
$('next-btn').addEventListener('click', () => goTo(state.current + 1));
$('row-select').addEventListener('change', (e) => goTo(Number(e.target.value)));
$('tab-select').addEventListener('change', (e) => {
  loadTab(e.target.value).catch((err) => setStatus(err.message, 'error'));
});
$('load-btn').addEventListener('click', () => {
  loadSheet().catch((err) => setStatus(err.message, 'error'));
});
$('reload-btn').addEventListener('click', () => {
  if (state.sheetTitle) loadTab(state.sheetTitle).catch((err) => setStatus(err.message, 'error'));
});
$('show-inline').addEventListener('change', (e) => chrome.storage.local.set({ showInline: e.target.checked }));

// Flechas izquierda/derecha para cambiar de fila (salvo cuando se escribe en un campo)
document.addEventListener('keydown', (e) => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
  if (e.key === 'ArrowLeft') goTo(state.current - 1);
  if (e.key === 'ArrowRight') goTo(state.current + 1);
});

// ---------- Arranque ----------
(async function boot() {
  const saved = await chrome.storage.local.get(['spreadsheetId', 'showInline']);
  $('sheet-input').value = saved.spreadsheetId || DEFAULT_SHEET_ID;
  $('show-inline').checked = !!saved.showInline;
  const connected = await refreshAuthButton();
  if (connected) {
    loadSheet().catch((err) => setStatus(err.message, 'error'));
  } else {
    setStatus('Conecta tu cuenta de Google para cargar la hoja.');
  }
})();
