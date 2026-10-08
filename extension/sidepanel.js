// Panel lateral: navega las filas de la matriz de pruebas en un Excel local (.xlsx/.xls)
// y guarda capturas como PNG en una carpeta de evidencias. La celda Evidencia enlaza al PNG.
// Lectura/escritura del Excel con SheetJS (xlsx.full.min.js) sobre la misma ruta del archivo.

const $ = (id) => document.getElementById(id);
const state = {
  wbHandle: null, // FileSystemFileHandle del Excel
  bookType: 'xlsx', // 'xlsx' o 'xls' según el archivo abierto
  wb: null, // libro de SheetJS en memoria
  sheetTitle: null,
  ws: null, // hoja actual
  range: null, // rango de la hoja { s, e }
  cols: {}, // índices relativos a la hoja: usuario, funcionalidad, datos, pasos, evidencia
  rows: [], // { rowIdx (relativo al rango), cells }
  current: 0,
  evidenceDir: null, // FileSystemDirectoryHandle de las capturas
  blob: null,
  previewUrl: null,
};

// Límite de Excel para el contenido de una celda
const MAX_CELL_CHARS = 32767;

// Campos editables: encabezado en la hoja (normalizado) y control del formulario
const EDITABLE = [
  { key: 'requestSite', header: 'request site', id: 'e-request-site' },
  { key: 'request', header: 'request', id: 'e-request' },
  { key: 'response', header: 'response', id: 'e-response' },
  { key: 'observaciones', header: 'observaciones', id: 'e-observaciones' },
  { key: 'resultado', header: 'resultado', id: 'e-resultado' },
];

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

// Nombre de archivo válido en Windows: quita caracteres prohibidos, espacios repetidos,
// puntos finales y limita la longitud
function safeFileName(text) {
  return String(text)
    .replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 150);
}

// ---------- Persistencia de handles (IndexedDB) ----------
// Los FileSystemHandle se guardan para recordar el Excel y la carpeta entre sesiones
const DB_NAME = 'evidencias-ext';
const STORE = 'handles';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveHandle(key, handle) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(handle, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadHandle(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

// Pide permiso de lectura/escritura si hace falta (debe llamarse desde un clic)
async function ensurePerm(handle) {
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  return (await handle.requestPermission(opts)) === 'granted';
}

// ---------- Lectura de la hoja ----------
// Convierte una hoja en matriz de textos. Así las posiciones coinciden con el rango real.
function sheetRows(ws) {
  if (!ws || !ws['!ref']) return { rows: [], range: null };
  const range = XLSX.utils.decode_range(ws['!ref']);
  const rows = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })];
      row.push(cell ? (cell.w ?? cell.v ?? '') : '');
    }
    rows.push(row);
  }
  return { rows, range };
}

// Localiza el encabezado (fila con "Pasos") y las columnas que usamos.
// Devuelve { error } o { cols, rows }. Los índices son relativos a la matriz.
function parseTab(rows) {
  const headerIdx = rows.slice(0, 10).findIndex((r) => r.some((c) => norm(c) === 'pasos'));
  if (headerIdx < 0) return { error: 'No encontré la columna "Pasos" en esta pestaña.' };

  const headers = rows[headerIdx].map(norm);
  const cols = {
    usuario: headers.indexOf('usuario'),
    funcionalidad: headers.indexOf('funcionalidad'),
    datos: headers.indexOf('datos de entrada'),
    pasos: headers.indexOf('pasos'),
    evidencia: headers.indexOf('evidencia'),
  };
  // Columnas editables: opcionales (si no existen, su campo se deshabilita)
  for (const f of EDITABLE) cols[f.key] = headers.indexOf(f.header);
  // Enlace de la captura también en Pruebas Evidencia (opcional)
  cols.pruebasEvidencia = headers.indexOf('pruebas evidencia');
  const names = {
    usuario: 'Usuario',
    funcionalidad: 'Funcionalidad',
    datos: 'Datos de entrada',
    pasos: 'Pasos',
    evidencia: 'Evidencia',
  };
  const missing = ['usuario', 'funcionalidad', 'datos', 'pasos', 'evidencia']
    .filter((k) => cols[k] < 0)
    .map((k) => names[k]);
  if (missing.length) return { error: `Faltan columnas en esta pestaña: ${missing.join(', ')}` };

  const data = rows
    .slice(headerIdx + 1)
    .map((cells, i) => ({ rowIdx: headerIdx + 1 + i, cells }))
    .filter((r) => r.cells.some((c) => String(c ?? '').trim() !== ''));
  return { cols, rows: data };
}

// ---------- Excel ----------
// Muestra el loader y deja que el navegador lo pinte antes de un trabajo pesado
function showLoader(text) {
  $('loader-text').textContent = text;
  $('loader').classList.remove('hidden');
}

function hideLoader() {
  $('loader').classList.add('hidden');
}

const nextPaint = () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

async function readWorkbook(handle) {
  showLoader('Leyendo el archivo…');
  try {
    const file = await handle.getFile();
    const buf = await file.arrayBuffer();
    showLoader('Procesando el libro… (puede tardar con archivos grandes)');
    await nextPaint();
    // XLSX.read es síncrono: mientras corre, la página no responde
    state.wb = XLSX.read(buf, { type: 'array' });
    state.bookType = /\.xls$/i.test(handle.name) ? 'xls' : 'xlsx';
    state.wbHandle = handle;
    $('file-name').textContent = handle.name;
    $('reload-btn').disabled = false;
    await saveHandle('workbook', handle);

    const select = $('tab-select');
    select.replaceChildren();
    for (const t of state.wb.SheetNames) {
      const o = document.createElement('option');
      o.value = t;
      o.textContent = t;
      select.appendChild(o);
    }
    select.disabled = false;
    const saved = (await chrome.storage.local.get('sheetTitle')).sheetTitle;
    await loadTab(state.wb.SheetNames.includes(saved) ? saved : state.wb.SheetNames[0]);
  } finally {
    hideLoader();
  }
}

async function loadTab(title) {
  showLoader(`Cargando "${title}"…`);
  try {
    await nextPaint();
    state.sheetTitle = title;
    $('tab-select').value = title;
    chrome.storage.local.set({ sheetTitle: title });
    state.ws = state.wb.Sheets[title];
    const { rows, range } = sheetRows(state.ws);
    state.range = range;

    const parsed = parseTab(rows);
    if (parsed.error) {
      state.rows = [];
      state.cols = {};
      fillRowSelect();
      render();
      return setStatus(parsed.error, 'error');
    }
    state.cols = parsed.cols;
    state.rows = parsed.rows;
    state.current = 0;
    clearPreview();
    fillRowSelect();
    render();
    setStatus(`${state.rows.length} filas cargadas de "${title}".`, 'ok');
  } finally {
    hideLoader();
  }
}

// Número real de fila en la hoja (1-based) para una fila de la matriz
const sheetRowOf = (r) => state.range.s.r + r.rowIdx + 1;

function fillRowSelect() {
  const select = $('row-select');
  select.replaceChildren();
  state.rows.forEach((r, i) => {
    const o = document.createElement('option');
    const func = String(r.cells[state.cols.funcionalidad] ?? '').trim();
    o.value = i;
    o.textContent = `Fila ${sheetRowOf(r)} · ${func.slice(0, 40) || '(sin funcionalidad)'}`;
    select.appendChild(o);
  });
  select.disabled = state.rows.length === 0;
}

// keepDraft: no sobrescribe lo que el usuario está escribiendo en el formulario
function render(keepDraft = false) {
  const hasRows = state.rows.length > 0;
  $('prev-btn').disabled = !hasRows || state.current === 0;
  $('next-btn').disabled = !hasRows || state.current >= state.rows.length - 1;
  $('capture-btn').disabled = !hasRows || !state.wbHandle;
  $('row-select').value = state.current;

  const r = state.rows[state.current];
  if (!r) {
    for (const id of ['f-usuario', 'f-funcionalidad', 'f-datos', 'f-pasos', 'f-evidencia']) $(id).textContent = '';
    $('counter').textContent = '';
    if (!keepDraft) fillEditor(null);
    return;
  }
  const get = (k) => String(r.cells[state.cols[k]] ?? '');
  $('f-usuario').textContent = get('usuario') || '—';
  $('f-funcionalidad').textContent = get('funcionalidad') || '—';
  $('f-datos').textContent = get('datos') || '—';
  $('f-pasos').textContent = get('pasos') || '—';

  const ev = get('evidencia').trim();
  $('f-evidencia').textContent = !ev ? 'Vacía' : /\.png$/i.test(ev) ? `Captura: ${ev}` : `Contenido: ${ev.slice(0, 80)}`;
  $('counter').textContent = `${state.current + 1} de ${state.rows.length} · fila ${sheetRowOf(r)}`;
  if (!keepDraft) fillEditor(r);
}

// ---------- Edición de campos ----------
// Carga los valores de la fila en el formulario. Resultado solo admite Correcto o Error
function fillEditor(r) {
  for (const f of EDITABLE) {
    const input = $(f.id);
    const idx = r ? state.cols[f.key] : -1;
    input.disabled = !r || idx === undefined || idx < 0;
    const val = idx >= 0 ? String(r.cells[idx] ?? '') : '';
    if (f.key === 'resultado') {
      // Si la hoja tiene otro valor, se muestra tal cual para no perderlo sin querer
      input.querySelectorAll('option[data-extra]').forEach((o) => o.remove());
      if (val && !['Correcto', 'Error'].includes(val)) {
        const o = document.createElement('option');
        o.value = val;
        o.textContent = val;
        o.dataset.extra = '1';
        input.appendChild(o);
      }
    }
    input.value = val;
    input.dataset.original = val;
  }
  updateDirty();
}

const isDirty = () =>
  EDITABLE.some((f) => {
    const input = $(f.id);
    return !input.disabled && input.value !== input.dataset.original;
  });

function updateDirty() {
  const dirty = isDirty();
  $('save-edit-btn').disabled = !dirty;
  $('revert-btn').disabled = !dirty;
}

// Pregunta antes de salir de una fila con cambios sin guardar
function confirmDiscard() {
  return !isDirty() || confirm('Hay cambios sin guardar en esta fila. ¿Descartarlos?');
}

async function saveEdits() {
  const r = state.rows[state.current];
  const changes = EDITABLE.filter((f) => {
    const input = $(f.id);
    return !input.disabled && input.value !== input.dataset.original;
  });
  if (!r || !changes.length) return;
  if (!state.wbHandle) throw new Error('Primero abre el archivo Excel.');
  assertWritable();

  // Excel no admite más de 32.767 caracteres por celda: se valida antes de tocar nada
  const tooLong = changes.filter((f) => $(f.id).value.length > MAX_CELL_CHARS);
  if (tooLong.length) {
    const detail = tooLong.map((f) => `${f.header} (${$(f.id).value.length.toLocaleString('es')})`).join(', ');
    throw new Error(`Texto demasiado largo para Excel, máximo ${MAX_CELL_CHARS.toLocaleString('es')} caracteres: ${detail}. Acórtalo y vuelve a guardar.`);
  }
  if (!(await ensurePerm(state.wbHandle))) throw new Error('Sin permiso para guardar el Excel.');

  // Guarda los valores anteriores por si la escritura falla
  const previous = changes.map((f) => {
    const idx = state.cols[f.key];
    return { idx, value: r.cells[idx] };
  });

  setBusy(true);
  try {
    for (const f of changes) {
      const idx = state.cols[f.key];
      const value = $(f.id).value;
      setCellText(state.ws, state.range, r.rowIdx, idx, value);
      r.cells[idx] = value;
    }
    setStatus('Guardando cambios en el Excel…');
    await persistWorkbook();
    render();
    setStatus(`Cambios guardados en la fila ${sheetRowOf(r)}.`, 'ok');
  } catch (err) {
    for (const p of previous) {
      setCellText(state.ws, state.range, r.rowIdx, p.idx, String(p.value ?? ''));
      r.cells[p.idx] = p.value;
    }
    throw err;
  } finally {
    setBusy(false);
  }
}

EDITABLE.forEach((f) => {
  const input = $(f.id);
  input.addEventListener('input', updateDirty);
  input.addEventListener('change', updateDirty);
});
$('save-edit-btn').addEventListener('click', () => {
  saveEdits().catch((err) => setStatus(err.message, 'error'));
});
$('revert-btn').addEventListener('click', () => {
  const r = state.rows[state.current];
  fillEditor(r || null);
  setStatus('Cambios descartados.');
});

function goTo(i) {
  if (i < 0 || i >= state.rows.length) return;
  if (!confirmDiscard()) {
    $('row-select').value = state.current; // deshace la selección del desplegable
    return;
  }
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
// Escribe la celda Evidencia de la hoja actual con un enlace relativo al PNG
// Escribe texto en una celda de la matriz (rowIdx/colIdx relativos al rango de la hoja)
function setCellText(ws, range, rowIdx, colIdx, text, link) {
  const addr = XLSX.utils.encode_cell({ r: range.s.r + rowIdx, c: range.s.c + colIdx });
  ws[addr] = link ? { t: 's', v: text, l: link } : { t: 's', v: text };
  const cell = XLSX.utils.decode_cell(addr);
  const ref = XLSX.utils.decode_range(ws['!ref'] || addr);
  ref.s.r = Math.min(ref.s.r, cell.r);
  ref.s.c = Math.min(ref.s.c, cell.c);
  ref.e.r = Math.max(ref.e.r, cell.r);
  ref.e.c = Math.max(ref.e.c, cell.c);
  ws['!ref'] = XLSX.utils.encode_range(ref);
}

function setEvidenceCell(ws, range, rowIdx, colIdx, fileName, folderName) {
  setCellText(ws, range, rowIdx, colIdx, fileName, { Target: `${folderName}/${fileName}`, Tooltip: 'Abrir captura' });
}

// Celdas de cualquier hoja que superan el límite de Excel (SheetJS no escribe el libro si hay alguna)
function oversizedCells(wb) {
  const found = [];
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name];
    for (const addr of Object.keys(ws)) {
      if (addr.startsWith('!')) continue;
      const v = ws[addr]?.v;
      if (typeof v === 'string' && v.length > MAX_CELL_CHARS) found.push({ sheet: name, addr, len: v.length });
    }
  }
  return found;
}

// Lanza error si el libro no se puede guardar; no modifica nada
function assertWritable() {
  const big = oversizedCells(state.wb);
  if (!big.length) return;
  const list = big
    .slice(0, 5)
    .map((b) => `${b.sheet}!${b.addr} (${b.len.toLocaleString('es')} caracteres)`)
    .join(', ');
  const more = big.length > 5 ? ` y ${big.length - 5} más` : '';
  throw new Error(
    `Excel no admite celdas de más de ${MAX_CELL_CHARS.toLocaleString('es')} caracteres. ` +
      `Acorta el texto en: ${list}${more}. Mientras existan, el archivo no se puede guardar.`,
  );
}

// Escribe el libro completo con el formato del archivo original (.xlsx o .xls)
async function persistWorkbook() {
  assertWritable();
  const out = XLSX.write(state.wb, { bookType: state.bookType, type: 'array' });
  await writeFile(state.wbHandle, out);
}

async function writeFile(handle, data) {
  const w = await handle.createWritable();
  await w.write(data);
  await w.close();
}

async function saveEvidence() {
  const r = state.rows[state.current];
  if (!r || !state.blob) return;
  if (!state.wbHandle) return setStatus('Primero abre el archivo Excel.', 'error');
  if (!state.evidenceDir) return setStatus('Primero elige la carpeta de evidencias.', 'error');
  assertWritable();

  const current = String(r.cells[state.cols.evidencia] ?? '').trim();
  if (current && !confirm('Esta fila ya tiene evidencia. ¿Reemplazarla? La captura anterior sigue en la carpeta.')) {
    return;
  }

  setBusy(true);
  try {
    if (!(await ensurePerm(state.evidenceDir))) throw new Error('Sin permiso para escribir en la carpeta de evidencias.');
    if (!(await ensurePerm(state.wbHandle))) throw new Error('Sin permiso para guardar el Excel.');

    setStatus('Guardando captura…');
    const funcionalidad = String(r.cells[state.cols.funcionalidad] ?? '').trim() || 'sin funcionalidad';
    const prefix = $('prefix-input').value;
    const fileName = `${safeFileName(`${prefix}Fila ${sheetRowOf(r)} - ${funcionalidad}`)}.png`;

    // 1) PNG en la carpeta de evidencias
    const pngHandle = await state.evidenceDir.getFileHandle(fileName, { create: true });
    await writeFile(pngHandle, state.blob);

    // 2) Enlaces al PNG: columna Evidencia y, si existe, Pruebas Evidencia
    const targets = [state.cols.evidencia];
    const hasPruebas = state.cols.pruebasEvidencia >= 0;
    if (hasPruebas) targets.push(state.cols.pruebasEvidencia);
    const previous = targets.map((idx) => ({ idx, value: r.cells[idx] }));
    for (const idx of targets) {
      setEvidenceCell(state.ws, state.range, r.rowIdx, idx, fileName, state.evidenceDir.name);
      r.cells[idx] = fileName;
    }

    // 3) Excel completo (SheetJS reescribe el libro; ver aviso en el README)
    setStatus('Actualizando el Excel…');
    try {
      await persistWorkbook();
    } catch (err) {
      // Si no se guarda el Excel, la celda en memoria vuelve a su valor anterior
      for (const p of previous) {
        setCellText(state.ws, state.range, r.rowIdx, p.idx, String(p.value ?? ''));
        r.cells[p.idx] = p.value;
      }
      throw err;
    }

    clearPreview();
    render(true); // conserva lo que el usuario esté escribiendo en el formulario
    const extra = hasPruebas ? '' : ' (no existe la columna "Pruebas Evidencia", solo se enlazó Evidencia)';
    setStatus(`Evidencia guardada en la fila ${sheetRowOf(r)}${extra}.`, 'ok');
  } finally {
    setBusy(false);
  }
}

function setBusy(busy) {
  $('save-btn').disabled = busy;
  $('capture-btn').disabled = busy || state.rows.length === 0 || !state.wbHandle;
}

$('save-btn').addEventListener('click', () => {
  saveEvidence().catch((err) => setStatus(err.message, 'error'));
});

// ---------- Archivos ----------
$('open-btn').addEventListener('click', async () => {
  try {
    const [handle] = await window.showOpenFilePicker({
      multiple: false,
      types: [
        {
          description: 'Libro de Excel',
          accept: {
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
            'application/vnd.ms-excel': ['.xls'],
          },
        },
      ],
    });
    if (handle) await readWorkbook(handle);
  } catch (err) {
    if (err.name !== 'AbortError') setStatus(err.message, 'error');
  }
});

$('reload-btn').addEventListener('click', async () => {
  if (!state.wbHandle || !confirmDiscard()) return;
  try {
    if (!(await ensurePerm(state.wbHandle))) throw new Error('Sin permiso para leer el Excel.');
    await readWorkbook(state.wbHandle);
  } catch (err) {
    setStatus(err.message, 'error');
  }
});

$('folder-btn').addEventListener('click', async () => {
  try {
    const dir = await window.showDirectoryPicker({ mode: 'readwrite' });
    state.evidenceDir = dir;
    $('folder-name').textContent = dir.name;
    await saveHandle('evidenceDir', dir);
    setStatus(`Carpeta de evidencias: ${dir.name}`, 'ok');
  } catch (err) {
    if (err.name !== 'AbortError') setStatus(err.message, 'error');
  }
});

// ---------- Navegación ----------
$('prev-btn').addEventListener('click', () => goTo(state.current - 1));
$('next-btn').addEventListener('click', () => goTo(state.current + 1));
$('row-select').addEventListener('change', (e) => goTo(Number(e.target.value)));
$('tab-select').addEventListener('change', (e) => {
  if (!confirmDiscard()) {
    e.target.value = state.sheetTitle; // vuelve a la pestaña actual
    return;
  }
  loadTab(e.target.value).catch((err) => setStatus(err.message, 'error'));
});

// Flechas izquierda/derecha para cambiar de fila (salvo cuando se escribe en un campo)
document.addEventListener('keydown', (e) => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
  if (e.key === 'ArrowLeft') goTo(state.current - 1);
  if (e.key === 'ArrowRight') goTo(state.current + 1);
});

// ---------- Arranque ----------
$('prefix-input').addEventListener('input', (e) => {
  chrome.storage.local.set({ capturePrefix: e.target.value });
});

(async function boot() {
  $('prefix-input').value = (await chrome.storage.local.get('capturePrefix')).capturePrefix || '';

  // Carpeta de evidencias recordada (el permiso se pide al guardar)
  const dir = await loadHandle('evidenceDir');
  if (dir) {
    state.evidenceDir = dir;
    $('folder-name').textContent = dir.name;
  }

  // Excel recordado: se reabre solo si el navegador conserva el permiso
  const saved = await loadHandle('workbook');
  if (saved && (await saved.queryPermission({ mode: 'readwrite' })) === 'granted') {
    await readWorkbook(saved);
  } else if (saved) {
    setStatus(`Vuelve a abrir "${saved.name}" con el botón Abrir Excel.`);
  } else {
    setStatus('Abre tu Excel de la matriz de pruebas para empezar.');
  }
})().catch((err) => setStatus(err.message, 'error'));
