// Interfaz del visor: bóveda, perfiles, WebSocket con el backend, filtros y colores.
// Todo texto del log se inserta con textContent (nunca innerHTML).
(() => {
  const MAX_RENDER = 3000; // líneas máximas que se pintan a la vez
  const $ = (id) => document.getElementById(id);

  const el = {
    vaultScreen: $('vault-screen'),
    vaultForm: $('vault-form'),
    vaultHelp: $('vault-help'),
    vaultSubmit: $('vault-submit'),
    vaultError: $('vault-error'),
    master: $('master'),
    master2: $('master2'),
    master2Row: $('master2-row'),
    app: $('app'),
    profileList: $('profile-list'),
    toggleSidebar: $('toggle-sidebar'),
    settingsBtn: $('settings-btn'),
    settingsDialog: $('settings-dialog'),
    darkMode: $('dark-mode'),
    settingsClose: $('settings-close'),
    settingsReset: $('settings-reset'),
    vaultReset: $('vault-reset'),
    resetDialog: $('reset-dialog'),
    resetConfirmText: $('reset-confirm-text'),
    resetError: $('reset-error'),
    resetCancel: $('reset-cancel'),
    resetConfirm: $('reset-confirm'),
    tabs: $('tabs'),
    newProfile: $('new-profile'),
    lock: $('lock'),
    title: $('current-title'),
    status: $('status'),
    editProfile: $('edit-profile'),
    restart: $('restart'),
    closeConn: $('close-conn'),
    filters: $('filters'),
    toggleFilters: $('toggle-filters'),
    detailDialog: $('detail-dialog'),
    detailTitle: $('detail-title'),
    detailBody: $('detail-body'),
    detailOpen: $('detail-open'),
    detailEdit: $('detail-edit'),
    detailClone: $('detail-clone'),
    manualPath: $('manual-path'),
    browseDialog: $('browse-dialog'),
    browseCrumb: $('browse-path'),
    browseList: $('browse-list'),
    browseStatus: $('browse-status'),
    browseError: $('browse-error'),
    browseUp: $('browse-up'),
    browseUse: $('browse-use'),
    browseCancel: $('browse-cancel'),
    detailDelete: $('detail-delete'),
    detailClose: $('detail-close'),
    closeDialog: $('close-dialog'),
    closeText: $('close-text'),
    closeCancel: $('close-cancel'),
    closeConfirm: $('close-confirm'),
    search: $('search'),
    regex: $('regex'),
    caseSens: $('case'),
    onlyIo: $('only-io'),
    autoscroll: $('autoscroll'),
    fmtXml: $('fmt-xml'),
    clearAll: $('clear-all'),
    counter: $('counter'),
    clear: $('clear'),
    exportBtn: $('export'),
    log: $('log'),
    multi: $('multi'),
    dialog: $('profile-dialog'),
    dialogTitle: $('dialog-title'),
    profileForm: $('profile-form'),
    profileError: $('profile-error'),
    useJump: $('use-jump'),
    jumpFields: $('jump-fields'),
    deleteProfile: $('delete-profile'),
    cancelProfile: $('cancel-profile'),
  };

  let profiles = [];
  // Pestañas: una vista por perfil abierto { id, entries, state, blockTag }
  const views = new Map();
  let tabOrder = [];
  const MULTI_ID = '__multi__'; // id sintético de la pestaña MultiView
  let currentId = null; // perfil de la pestaña activa (o MULTI_ID)
  let entries = []; // alias de views.get(currentId).entries: { text, level, tag, marker }
  const multiSelected = new Set(); // perfiles marcados para MultiView (máx. 4)
  const multiPanes = new Map(); // id -> { pane, dot, name, log } (persisten para conservar el scroll)
  let multiOrder = ''; // orden actual de paneles, para reordenar solo cuando cambia la selección
  let ws = null;
  let wsRetry = null;
  let renderPending = false;
  let editingId = null;
  let blockTag = ''; // etiqueta del bloque request/response en curso (se mantiene entre líneas)

  // ---------- API ----------
  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
    return data;
  }

  // ---------- Colores / clasificación ----------
  function classify(text) {
    let level = 'OTHER';
    if (/\b(ERROR|SEVERE|FATAL)\b|Exception\b/.test(text)) level = 'ERROR';
    else if (/\bWARN(ING)?\b/.test(text)) level = 'WARN';
    else if (/\bINFO\b/.test(text)) level = 'INFO';
    else if (/\b(DEBUG|TRACE)\b/.test(text)) level = 'DEBUG';

    // Un bloque empieza en "Inicio mensaje request/response" (o "Request url") y termina
    // en "Fin ...". Todas las líneas del bloque, incluido el cuerpo XML, llevan la etiqueta.
    let tag = '';
    let start = false; // "Inicio mensaje ..." (aquí aparece el botón copiar)
    let end = false; // "Fin ..." que cierra el bloque
    if (/Inicio mensaje (request|response)|Request url of Endpoint/i.test(text)) {
      blockTag = /response/i.test(text) ? 'response' : 'request';
      start = /Inicio mensaje/i.test(text);
      tag = blockTag;
      if (/Fin /i.test(text)) {
        end = true;
        blockTag = '';
      }
    } else if (blockTag) {
      tag = blockTag;
      if (/Fin /i.test(text)) {
        end = true;
        blockTag = '';
      }
    } else if (/\bresponse\b/i.test(text)) tag = 'response';
    else if (/\brequest\b/i.test(text)) tag = 'request';

    const marker = text.startsWith('--- ');
    return { text, level, tag, marker, start, end };
  }

  // Texto desde una entrada de inicio hasta su línea de fin (incluye lo oculto por filtros)
  function blockText(view, startEntry) {
    const list = view.entries;
    const i = list.indexOf(startEntry);
    if (i < 0) return null;
    const fmt = el.fmtXml.checked;
    const out = [];
    for (let j = i; j < list.length; j++) {
      out.push(displayText(list[j], fmt));
      if (list[j].end) break;
    }
    return { text: out.join('\n'), closed: list[i + out.length - 1]?.end === true };
  }

  // ---------- Formato XML ----------
  // Indenta un fragmento XML (una etiqueta por línea, sangría de 2 espacios)
  function prettyXml(xml) {
    const tokens = xml.replace(/>\s*</g, '>\n<').split('\n');
    let depth = 0;
    const out = [];
    for (const raw of tokens) {
      const t = raw.trim();
      if (!t) continue;
      const closing = /^<\//.test(t);
      const declaration = /^<[?!]/.test(t);
      const selfClosing = /\/>$/.test(t);
      const inlineClose = /<\//.test(t); // p. ej. <a>texto</a> en la misma línea
      if (closing) depth = Math.max(0, depth - 1);
      out.push('  '.repeat(depth) + t);
      if (!closing && !declaration && !selfClosing && !inlineClose && /^<[^/]/.test(t)) depth++;
    }
    return out.join('\n');
  }

  // Separa el texto previo y posterior al XML de la línea, y formatea el XML
  function prettyLine(text) {
    const start = text.search(/<[A-Za-z?!/]/);
    const end = text.lastIndexOf('>');
    if (start < 0 || end < start) return text;
    const before = text.slice(0, start).trimEnd();
    const after = text.slice(end + 1).trim();
    const parts = [];
    if (before) parts.push(before);
    parts.push(prettyXml(text.slice(start, end + 1)));
    if (after) parts.push(after);
    return parts.join('\n');
  }

  // Texto que se muestra (o se copia): formateado si el checkbox está activo
  function displayText(e, fmt) {
    if (!fmt) return e.text;
    if (e.pretty === undefined) e.pretty = prettyLine(e.text);
    return e.pretty;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (_) {
      // Respaldo para contextos sin Clipboard API
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    }
  }

  // ---------- Filtros ----------
  function levelChecked(level) {
    const box = document.querySelector(`input[data-level="${level}"]`);
    return box ? box.checked : true;
  }

  // Devuelve { base: RegExp|null, invalid: bool }
  function currentMatcher() {
    const q = el.search.value;
    el.search.classList.remove('bad');
    if (!q) return { base: null, invalid: false };
    try {
      const src = el.regex.checked ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return { base: new RegExp(src, el.caseSens.checked ? '' : 'i'), invalid: false };
    } catch (_) {
      el.search.classList.add('bad');
      return { base: null, invalid: true };
    }
  }

  function visibleEntries(view) {
    const { base, invalid } = currentMatcher();
    const onlyIo = el.onlyIo.checked;
    return view.entries.filter((e) => {
      if (e.marker) return true;
      if (!levelChecked(e.level)) return false;
      if (onlyIo && !e.tag) return false;
      if (invalid) return false;
      if (base && !base.test(e.text)) return false;
      return true;
    });
  }

  // Pinta el texto resaltando coincidencias (usando solo nodos de texto)
  function appendHighlighted(parent, text, base) {
    if (!base) {
      parent.appendChild(document.createTextNode(text));
      return;
    }
    const g = new RegExp(base.source, base.flags + 'g');
    let last = 0;
    for (const m of text.matchAll(g)) {
      if (m[0].length === 0) continue;
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      const mark = document.createElement('mark');
      mark.textContent = m[0];
      parent.appendChild(mark);
      last = m.index + m[0].length;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
  }

  // Pinta las entradas visibles de una vista en un contenedor. Devuelve cuántas coinciden.
  function renderView(view, container) {
    const { base } = currentMatcher();
    const fmt = el.fmtXml.checked;
    const list = visibleEntries(view);
    const shown = list.slice(-MAX_RENDER);
    const keep = el.autoscroll.checked ? null : container.scrollTop;

    const frag = document.createDocumentFragment();
    for (const e of shown) {
      const div = document.createElement('span');
      div.className = 'line';
      if (e.marker) div.classList.add('marker');
      else {
        div.classList.add(`lvl-${e.level}`);
        if (e.tag) div.classList.add(`tag-${e.tag}`);
      }
      if (e.start) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'copy-btn';
        btn.textContent = 'Copiar bloque';
        btn.addEventListener('click', async () => {
          const block = blockText(view, e);
          if (!block) {
            btn.textContent = 'No disponible';
          } else {
            const ok = await copyText(block.text);
            btn.textContent = ok ? (block.closed ? 'Copiado' : 'Copiado (bloque sin Fin)') : 'Error al copiar';
          }
          setTimeout(() => (btn.textContent = 'Copiar bloque'), 1500);
        });
        div.appendChild(btn);
      }
      appendHighlighted(div, displayText(e, fmt), base);
      div.appendChild(document.createTextNode('\n'));
      frag.appendChild(div);
    }
    container.replaceChildren(frag);
    if (el.autoscroll.checked) container.scrollTop = container.scrollHeight;
    else if (keep) container.scrollTop = keep;
    return list.length;
  }

  // Vista múltiple: un panel por perfil marcado. Los paneles se reutilizan para
  // conservar la posición de scroll cuando Auto-scroll está apagado.
  function renderMulti() {
    const ids = [...multiSelected];
    el.multi.className = `multi n${ids.length}`;
    for (const [id, p] of multiPanes) {
      if (!ids.includes(id)) {
        p.pane.remove();
        multiPanes.delete(id);
      }
    }
    for (const id of ids) {
      const v = views.get(id);
      if (!v) continue;
      if (!multiPanes.has(id)) {
        const pane = document.createElement('section');
        pane.className = 'pane';
        const head = document.createElement('div');
        head.className = 'pane-head';
        const dot = document.createElement('span');
        dot.className = `dot ${v.state}`;
        const name = document.createElement('span');
        name.className = 'pane-name';
        head.append(dot, name);
        const log = document.createElement('pre');
        log.className = 'log';
        pane.append(head, log);
        multiPanes.set(id, { pane, dot, name, log });
      }
    }
    // Mover paneles resetea su scroll: solo reordenar cuando cambió la selección
    const order = ids.join('\u0000');
    if (order !== multiOrder) {
      for (const id of ids) {
        const p = multiPanes.get(id);
        if (p) el.multi.appendChild(p.pane);
      }
      multiOrder = order;
    }
    for (const id of ids) {
      const v = views.get(id);
      if (!v) continue;
      const p = multiPanes.get(id);
      const prof = profiles.find((x) => x.id === id);
      p.dot.className = `dot ${v.state}`;
      p.name.textContent = prof ? prof.name : '(perfil eliminado)';
      p.name.title = prof ? `${prof.target.user}@${prof.target.host}` : '';
      renderView(v, p.log);
    }
    el.counter.textContent = `${ids.length} sesiones`;
  }

  function render() {
    renderPending = false;
    const inMulti = currentId === MULTI_ID;
    el.log.classList.toggle('hidden', inMulti);
    el.multi.classList.toggle('hidden', !inMulti);
    if (inMulti) {
      renderMulti();
    } else {
      const v = views.get(currentId);
      if (v) {
        const n = renderView(v, el.log);
        el.counter.textContent = `${n} de ${v.entries.length} líneas${n > MAX_RENDER ? ` (mostrando las últimas ${MAX_RENDER})` : ''}`;
      } else {
        el.log.replaceChildren();
        el.counter.textContent = '';
      }
    }
  }

  function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    requestAnimationFrame(render);
  }

  // ---------- Estado de conexión ----------
  // Guarda el estado de una pestaña y, si es la activa, lo muestra en la barra
  function updateState(id, state, msg = '') {
    const v = views.get(id);
    if (v) v.state = state;
    renderTabs();
    if (currentId === MULTI_ID) {
      showMultiStatus();
      scheduleRender(); // actualiza el punto de estado de los paneles
    } else if (id === currentId) {
      showStatus(state, msg);
    }
  }

  function showStatus(state, msg = '') {
    el.status.textContent = labelFor(state);
    el.status.className = `status ${state === 'connected' ? 'connected' : state}`;
    el.status.title = msg;
    // "Cerrar" solo tiene sentido mientras hay una conexión activa o reintentando
    const active = ['connecting', 'connected', 'reconnecting'].includes(state);
    el.closeConn.disabled = !currentId || !active;
  }

  function labelFor(state) {
    return {
      idle: 'inactivo',
      connecting: 'conectando',
      connected: 'conectado',
      reconnecting: 'reconectando',
      stopped: 'detenido',
      error: 'error',
    }[state] || state;
  }

  // ---------- WebSocket ----------
  function connectWs() {
    clearTimeout(wsRetry);
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      // Tras reconectar, vuelve a suscribir todas las pestañas abiertas
      for (const id of views.keys()) ws.send(JSON.stringify({ type: 'subscribe', profileId: id }));
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      const v = views.get(msg.profileId);
      if (!v) return;
      const isShown = v.id === currentId || (currentId === MULTI_ID && multiSelected.has(v.id));

      if (msg.type === 'backlog') {
        v.blockTag = '';
        v.entries.length = 0;
        ingest(v, msg.lines);
        v.state = msg.state;
        renderTabs();
        if (isShown) render();
        if (currentId === MULTI_ID) showMultiStatus();
        else if (v.id === currentId) showStatus(msg.state);
      } else if (msg.type === 'lines') {
        ingest(v, msg.lines);
        if (isShown) scheduleRender();
      } else if (msg.type === 'status') {
        if (msg.state === 'warn') {
          v.entries.push({ text: `[stderr] ${msg.msg}`, level: 'WARN', tag: '', marker: false });
          if (isShown) scheduleRender();
        } else {
          updateState(v.id, msg.state, msg.msg);
          if (msg.msg && msg.state !== 'connected') {
            v.entries.push({ text: `--- ${msg.msg} ---`, level: 'OTHER', tag: '', marker: true });
            if (isShown) scheduleRender();
          }
        }
      } else if (msg.type === 'error') {
        updateState(v.id, 'error', msg.msg);
        v.entries.push({ text: `--- ${msg.msg} ---`, level: 'ERROR', tag: '', marker: true });
        if (isShown) scheduleRender();
      }
    };
    ws.onclose = () => {
      if (el.app.classList.contains('hidden')) return; // bóveda bloqueada
      wsRetry = setTimeout(connectWs, 2000);
    };
  }

  // Clasifica líneas nuevas de una pestaña respetando el bloque request/response en curso
  function ingest(v, texts) {
    blockTag = v.blockTag;
    for (const t of texts) v.entries.push(classify(t));
    v.blockTag = blockTag;
    if (v.entries.length > 5000) v.entries.splice(0, v.entries.length - 5000);
  }

  function sendWs(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  // Abre una pestaña para el perfil (si no existe) y la activa
  function openTab(id) {
    if (!views.has(id)) {
      views.set(id, { id, entries: [], state: 'idle', blockTag: '' });
      tabOrder.push(id);
      sendWs({ type: 'subscribe', profileId: id });
    }
    activate(id);
  }

  // Estado agregado de las sesiones en MultiView (para el título y el punto)
  function multiStatus() {
    const st = [...multiSelected].map((id) => views.get(id)?.state ?? 'stopped');
    const connected = st.every((s) => s === 'connected');
    const dead = st.every((s) => s === 'error' || s === 'stopped');
    if (connected) return { state: 'connected', label: 'conectado', msg: 'Todas las sesiones conectadas' };
    if (dead) return { state: 'stopped', label: 'detenido', msg: 'Todas detenidas o con error' };
    return { state: 'reconnecting', label: 'conectando', msg: 'Algunas sesiones sin conectar' };
  }

  function showMultiStatus() {
    const s = multiStatus();
    el.status.textContent = s.label;
    el.status.className = `status ${s.state}`;
    el.status.title = s.msg;
    el.editProfile.disabled = true;
    el.restart.disabled = true;
    el.closeConn.disabled = true;
  }

  function activate(id) {
    if (id === MULTI_ID) {
      currentId = MULTI_ID;
      entries = [];
      el.title.textContent = 'MultiView';
      showMultiStatus();
      renderTabs();
      renderProfiles();
      render();
      return;
    }
    const v = views.get(id);
    currentId = id;
    entries = v ? v.entries : [];
    const p = profiles.find((x) => x.id === id);
    el.title.textContent = p ? p.name : 'Abre un perfil desde la lista';
    el.editProfile.disabled = !p;
    el.restart.disabled = !p;
    showStatus(v ? v.state : 'idle');
    renderTabs();
    renderProfiles();
    render();
  }

  // Cierra la pestaña (solo deja de mostrarla; la conexión sigue viva en el servidor)
  function closeTab(id) {
    if (!views.has(id)) return;
    sendWs({ type: 'unsubscribe', profileId: id });
    views.delete(id);
    tabOrder = tabOrder.filter((x) => x !== id);
    multiSelected.delete(id);
    if (currentId === id) {
      const next = tabOrder[tabOrder.length - 1] ?? null;
      if (next) activate(next);
      else {
        currentId = null;
        entries = [];
        activate(null);
      }
    } else if (currentId === MULTI_ID && multiSelected.size < 2) {
      const next = tabOrder[tabOrder.length - 1] ?? null;
      if (next) activate(next);
      else activate(null);
    } else {
      renderTabs();
      renderProfiles();
      render();
      if (currentId === MULTI_ID) showMultiStatus();
    }
  }

  // Marca o desmarca una pestaña para la vista múltiple (máx. 4)
  function toggleSelect(id, on) {
    if (on) {
      if (multiSelected.size >= 4) return;
      multiSelected.add(id);
    } else {
      multiSelected.delete(id);
    }
    if (currentId === MULTI_ID && multiSelected.size < 2) {
      const next = tabOrder[tabOrder.length - 1] ?? null;
      if (next) activate(next);
      else activate(null);
    } else {
      renderTabs();
      render();
      if (currentId === MULTI_ID) showMultiStatus();
    }
  }

  // Cierra la pestaña MultiView y desmarca todas las sesiones
  function closeMultiTab() {
    multiSelected.clear();
    const next = tabOrder[tabOrder.length - 1] ?? null;
    if (next) activate(next);
    else activate(null);
  }

  function renderTabs() {
    el.tabs.replaceChildren();
    const showMultiTab = multiSelected.size >= 2;
    if (!tabOrder.length && !showMultiTab) {
      const hint = document.createElement('span');
      hint.className = 'tabs-hint';
      hint.textContent = 'Abre un perfil desde la lista para verlo aquí';
      el.tabs.appendChild(hint);
      return;
    }
    for (const id of tabOrder) {
      const v = views.get(id);
      const p = profiles.find((x) => x.id === id);
      const tab = document.createElement('div');
      tab.className = `tab${id === currentId ? ' active' : ''}`;
      tab.title = p ? `${p.target.user}@${p.target.host}` : '';
      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.className = 'tab-select';
      chk.title = 'Ver en MultiView (máx. 4)';
      chk.checked = multiSelected.has(id);
      if (!chk.checked && multiSelected.size >= 4) chk.disabled = true;
      chk.addEventListener('click', (ev) => {
        ev.stopPropagation();
        toggleSelect(id, chk.checked);
      });
      const dot = document.createElement('span');
      dot.className = `dot ${v.state}`;
      const name = document.createElement('span');
      name.className = 'tab-name';
      name.textContent = p ? p.name : '(perfil eliminado)';
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'tab-close';
      close.title = 'Cerrar pestaña (la conexión sigue activa)';
      close.textContent = '×';
      close.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeTab(id);
      });
      tab.append(chk, dot, name, close);
      tab.addEventListener('click', () => activate(id));
      el.tabs.appendChild(tab);
    }
    if (showMultiTab) {
      const s = multiStatus();
      const tab = document.createElement('div');
      tab.className = `tab${currentId === MULTI_ID ? ' active' : ''}`;
      tab.title = 'Ver las sesiones marcadas a la vez';
      const dot = document.createElement('span');
      dot.className = `dot ${s.state}`;
      const name = document.createElement('span');
      name.className = 'tab-name';
      name.textContent = 'MultiView';
      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'tab-close';
      close.title = 'Cerrar MultiView (desmarca las sesiones)';
      close.textContent = '×';
      close.addEventListener('click', (ev) => {
        ev.stopPropagation();
        closeMultiTab();
      });
      tab.append(dot, name, close);
      tab.addEventListener('click', () => activate(MULTI_ID));
      el.tabs.appendChild(tab);
    }
  }

  // ---------- Detalle del perfil (modal) ----------
  let detailId = null;

  function openDetail(id) {
    const p = profiles.find((x) => x.id === id);
    if (!p) return;
    detailId = id;
    el.detailTitle.textContent = p.name;
    const rows = [
      ['Destino', `${p.target.user}@${p.target.host}:${p.target.port}`],
      ['Contraseña destino', p.target.hasPassword ? 'guardada (cifrada)' : 'no guardada'],
      ['Salto', p.jump ? `${p.jump.user}@${p.jump.host}:${p.jump.port}` : 'ninguno (conexión directa)'],
    ];
    if (p.jump) rows.push(['Contraseña salto', p.jump.hasPassword ? 'guardada (cifrada)' : 'no guardada']);
    rows.push(['Carpeta', p.logDir || '(home del usuario)'], ['Archivo', p.logFile]);
    el.detailBody.replaceChildren();
    for (const [k, v] of rows) {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      el.detailBody.append(dt, dd);
    }
    el.detailDialog.showModal();
  }

  el.detailOpen.addEventListener('click', () => {
    el.detailDialog.close();
    openTab(detailId);
  });

  el.detailEdit.addEventListener('click', () => {
    el.detailDialog.close();
    openDialog(profiles.find((p) => p.id === detailId));
  });

  el.detailClone.addEventListener('click', () => {
    el.detailDialog.close();
    cloneProfile(detailId);
  });

  el.detailClose.addEventListener('click', () => el.detailDialog.close());

  el.detailDelete.addEventListener('click', async () => {
    const p = profiles.find((x) => x.id === detailId);
    if (!p) return;
    if (!confirm(`¿Eliminar el perfil "${p.name}"? Esta acción no se puede deshacer.`)) return;
    try {
      await api('DELETE', `/api/profiles/${encodeURIComponent(p.id)}`);
    } catch (err) {
      alert(`No se pudo eliminar: ${err.message}`);
      return;
    }
    el.detailDialog.close();
    if (views.has(p.id)) closeTab(p.id);
    await loadProfiles();
  });

  // ---------- Perfiles ----------
  function renderProfiles() {
    el.profileList.replaceChildren();
    for (const p of profiles) {
      const li = document.createElement('li');
      if (p.id === currentId) li.classList.add('active');
      const name = document.createElement('span');
      name.textContent = p.name;
      const small = document.createElement('small');
      small.textContent = `${p.target.user}@${p.target.host}${p.jump ? ' · vía salto' : ''}`;
      li.append(name, small);
      li.addEventListener('click', () => openDetail(p.id));
      el.profileList.appendChild(li);
    }
  }

  // Duplica el perfil y abre la copia en el formulario para editar sus datos internos
  async function cloneProfile(id) {
    try {
      const copy = await api('POST', `/api/profiles/${encodeURIComponent(id)}/clone`);
      await loadProfiles();
      openDialog(copy);
    } catch (err) {
      alert(`No se pudo clonar: ${err.message}`);
    }
  }

  async function loadProfiles() {
    profiles = await api('GET', '/api/profiles');
    renderProfiles();
    renderTabs();
  }

  function openDialog(profile) {
    editingId = profile ? profile.id : null;
    el.dialogTitle.textContent = profile ? 'Editar perfil' : 'Nuevo perfil';
    el.deleteProfile.classList.toggle('hidden', !profile);
    el.profileError.textContent = '';
    const f = el.profileForm;
    f.reset();
    const v = (name, val) => { f.elements[name].value = val ?? ''; };
    v('name', profile?.name);
    v('logDir', profile?.logDir);
    v('logFile', profile?.logFile);
    v('target_host', profile?.target.host);
    v('target_port', profile?.target.port ?? 22);
    v('target_user', profile?.target.user);
    v('jump_host', profile?.jump?.host);
    v('jump_port', profile?.jump?.port ?? 22);
    v('jump_user', profile?.jump?.user);
    f.elements.target_password.placeholder = profile ? '(sin cambios)' : '';
    f.elements.jump_password.placeholder = profile ? '(sin cambios)' : '';
    el.useJump.checked = !!profile?.jump;
    el.jumpFields.classList.toggle('hidden', !el.useJump.checked);
    el.manualPath.checked = true;
    el.dialog.showModal();
  }

  // ---------- Explorador de carpetas y archivos del servidor ----------
  // El switch "Escribir a mano" apagado abre el explorador con los datos del formulario
  let browsePath = 'log';

  const joinPath = (base, name) => (base === '.' ? name : `${base}/${name}`);
  const parentPath = (p) => p.split('/').filter(Boolean).slice(0, -1).join('/') || '.';

  function formCreds() {
    const f = el.profileForm.elements;
    return {
      target: { host: f.target_host.value, port: f.target_port.value, user: f.target_user.value, password: f.target_password.value },
      jump: el.useJump.checked
        ? { host: f.jump_host.value, port: f.jump_port.value, user: f.jump_user.value, password: f.jump_password.value }
        : null,
    };
  }

  async function browseTo(path) {
    el.browseError.textContent = '';
    el.browseStatus.textContent = 'Cargando…';
    el.browseList.replaceChildren();
    el.browseUp.disabled = true;
    try {
      const { target, jump } = formCreds();
      const data = await api('POST', '/api/browse', { profileId: editingId || undefined, target, jump, path });
      browsePath = data.path;
      el.browseCrumb.textContent = `Ruta: ${data.path}`;
      el.browseUp.disabled = browsePath === '.';
      el.browseStatus.textContent = data.entries.length ? `${data.entries.length} elementos` : 'Carpeta vacía';
      for (const entry of data.entries) {
        const li = document.createElement('li');
        li.className = entry.type;
        li.textContent = `${entry.type === 'dir' ? '📁' : '📄'} ${entry.name}`;
        li.addEventListener('click', () => {
          if (entry.type === 'dir') browseTo(joinPath(browsePath, entry.name));
          else pickFile(entry.name);
        });
        el.browseList.appendChild(li);
      }
    } catch (err) {
      el.browseStatus.textContent = '';
      el.browseError.textContent = err.message;
    } finally {
      el.browseUp.disabled = browsePath === '.';
    }
  }

  function openBrowse() {
    const start = el.profileForm.elements.logDir.value.trim() || 'log';
    el.browseDialog.showModal();
    browseTo(start);
  }

  // Al elegir un archivo: llena Carpeta y Archivo y vuelve al modo manual para ajustar
  function pickFile(name) {
    const f = el.profileForm.elements;
    f.logDir.value = browsePath === '.' ? '' : browsePath;
    f.logFile.value = name;
    el.browseDialog.close();
  }

  el.manualPath.addEventListener('change', () => {
    if (!el.manualPath.checked) openBrowse();
  });
  el.browseUp.addEventListener('click', () => browseTo(parentPath(browsePath)));
  el.browseUse.addEventListener('click', () => {
    el.profileForm.elements.logDir.value = browsePath === '.' ? '' : browsePath;
    el.browseDialog.close();
  });
  el.browseCancel.addEventListener('click', () => el.browseDialog.close());
  // Cualquier cierre (incluido Esc) vuelve el switch a modo manual
  el.browseDialog.addEventListener('close', () => {
    el.manualPath.checked = true;
  });

  el.useJump.addEventListener('change', () => {
    el.jumpFields.classList.toggle('hidden', !el.useJump.checked);
  });

  el.newProfile.addEventListener('click', () => openDialog(null));
  el.editProfile.addEventListener('click', () => openDialog(profiles.find((p) => p.id === currentId)));
  el.cancelProfile.addEventListener('click', () => el.dialog.close());

  el.profileForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const f = el.profileForm.elements;
    const body = {
      id: editingId || undefined,
      name: f.name.value,
      logDir: f.logDir.value,
      logFile: f.logFile.value,
      target: {
        host: f.target_host.value,
        port: f.target_port.value,
        user: f.target_user.value,
        password: f.target_password.value,
      },
      jump: el.useJump.checked
        ? { host: f.jump_host.value, port: f.jump_port.value, user: f.jump_user.value, password: f.jump_password.value }
        : null,
    };
    try {
      const saved = await api('POST', '/api/profiles', body);
      el.profileForm.reset();
      el.dialog.close();
      await loadProfiles();
      openTab(saved.id);
    } catch (err) {
      el.profileError.textContent = err.message;
    }
  });

  el.deleteProfile.addEventListener('click', async () => {
    if (!editingId) return;
    if (!confirm('¿Eliminar este perfil?')) return;
    await api('DELETE', `/api/profiles/${encodeURIComponent(editingId)}`);
    el.dialog.close();
    if (views.has(editingId)) closeTab(editingId);
    await loadProfiles();
  });

  // ---------- Bóveda ----------
  function showVault(exists) {
    el.vaultScreen.classList.remove('hidden');
    el.app.classList.add('hidden');
    el.master2Row.classList.toggle('hidden', exists);
    el.master2.required = !exists;
    el.vaultHelp.textContent = exists
      ? 'Introduce tu clave maestra para desbloquear las contraseñas.'
      : 'Primera vez: crea una clave maestra. Cifra las contraseñas guardadas. No se puede recuperar si la olvidas.';
    el.vaultSubmit.textContent = exists ? 'Desbloquear' : 'Crear bóveda';
    el.vaultError.textContent = '';
    el.master.value = '';
    el.master.focus();
  }

  function showApp() {
    el.vaultScreen.classList.add('hidden');
    el.app.classList.remove('hidden');
  }

  el.vaultForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    el.vaultError.textContent = '';
    const { vaultExists } = await api('GET', '/api/state');
    try {
      if (vaultExists) {
        await api('POST', '/api/unlock', { master: el.master.value });
      } else {
        if (el.master.value !== el.master2.value) throw new Error('Las claves no coinciden');
        await api('POST', '/api/setup', { master: el.master.value });
      }
      el.master.value = '';
      el.master2.value = '';
      showApp();
      await loadProfiles();
      connectWs();
    } catch (err) {
      el.vaultError.textContent = err.message;
    }
  });

  el.lock.addEventListener('click', async () => {
    await api('POST', '/api/lock');
    if (ws) ws.close();
    views.clear();
    tabOrder = [];
    currentId = null;
    entries = [];
    multiSelected.clear();
    multiPanes.clear();
    el.multi.replaceChildren();
    renderTabs();
    render();
    showVault(true);
  });

  el.restart.addEventListener('click', () => {
    if (ws && ws.readyState === WebSocket.OPEN && currentId && views.has(currentId)) {
      entries.push({ text: '--- reiniciando conexión ---', level: 'OTHER', tag: '', marker: true });
      ws.send(JSON.stringify({ type: 'restart', profileId: currentId }));
    }
  });

  // Cerrar conexión: pide confirmación antes de enviar la orden al servidor
  el.closeConn.addEventListener('click', () => {
    const p = profiles.find((x) => x.id === currentId);
    el.closeText.textContent = `Se cerrará la conexión con "${p ? p.name : 'este perfil'}" y dejarás de recibir líneas. Podrás volver a conectarla con "Reiniciar conexión".`;
    el.closeDialog.showModal();
  });
  el.closeCancel.addEventListener('click', () => el.closeDialog.close());
  el.closeConfirm.addEventListener('click', () => {
    el.closeDialog.close();
    if (ws && ws.readyState === WebSocket.OPEN && currentId) {
      ws.send(JSON.stringify({ type: 'stop', profileId: currentId }));
      entries.push({ text: '--- conexión cerrada por el usuario ---', level: 'OTHER', tag: '', marker: true });
      scheduleRender();
    }
  });

  // ---------- Preferencias de filtros (se guardan en este navegador) ----------
  const PREFS_KEY = 'visor-logs-filters';

  function savePrefs() {
    const prefs = {
      levels: {},
      regex: el.regex.checked,
      caseSens: el.caseSens.checked,
      onlyIo: el.onlyIo.checked,
      autoscroll: el.autoscroll.checked,
      fmtXml: el.fmtXml.checked,
      clearAll: el.clearAll.checked,
    };
    document.querySelectorAll('input[data-level]').forEach((b) => (prefs.levels[b.dataset.level] = b.checked));
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch (_) {
      /* almacenamiento bloqueado: los filtros solo duran la sesión */
    }
  }

  function loadPrefs() {
    let prefs = null;
    try {
      prefs = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null');
    } catch (_) {
      prefs = null;
    }
    if (!prefs) return;
    el.regex.checked = !!prefs.regex;
    el.caseSens.checked = !!prefs.caseSens;
    el.onlyIo.checked = !!prefs.onlyIo;
    el.autoscroll.checked = prefs.autoscroll !== false;
    el.fmtXml.checked = !!prefs.fmtXml;
    el.clearAll.checked = !!prefs.clearAll;
    updateClearLabel();
    document.querySelectorAll('input[data-level]').forEach((b) => {
      if (prefs.levels && typeof prefs.levels[b.dataset.level] === 'boolean') {
        b.checked = prefs.levels[b.dataset.level];
      }
    });
  }

  const onFilterChange = () => {
    savePrefs();
    render();
  };

  // ---------- Barra de filtros y acciones ----------
  let searchTimer = null;
  el.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(render, 150);
  });
  for (const id of ['regex', 'case', 'only-io', 'autoscroll', 'fmt-xml']) $(id).addEventListener('change', onFilterChange);
  document.querySelectorAll('input[data-level]').forEach((b) => b.addEventListener('change', onFilterChange));

  // Con la casilla marcada, Limpiar vacía todas las pestañas abiertas; si no, solo la activa
  function updateClearLabel() {
    el.clear.textContent = el.clearAll.checked ? 'Limpiar todas' : 'Limpiar vista';
  }

  el.clear.addEventListener('click', () => {
    if (el.clearAll.checked) {
      for (const v of views.values()) v.entries.length = 0; // sin soltar las referencias
    } else {
      entries.length = 0; // vacía la pestaña activa sin soltar la referencia
    }
    render();
  });

  el.clearAll.addEventListener('change', () => {
    updateClearLabel();
    onFilterChange();
  });

  el.exportBtn.addEventListener('click', () => {
    const v = views.get(currentId);
    const text = (v ? visibleEntries(v) : []).map((e) => e.text).join('\n');
    const name = `${(profiles.find((p) => p.id === currentId)?.name || 'log').replace(/[^\w-]+/g, '_')}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  // Ctrl+F enfoca la búsqueda en vez del buscador del navegador
  document.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'f' && !el.app.classList.contains('hidden')) {
      ev.preventDefault();
      el.search.focus();
      el.search.select();
    }
  });

  // ---------- Menú de perfiles plegable ----------
  const SIDEBAR_KEY = 'visor-sidebar-collapsed';

  function applySidebar(collapsed) {
    el.app.classList.toggle('collapsed', collapsed);
    try {
      localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
    } catch (_) {
      /* sin almacenamiento: vuelve a abrirse al recargar */
    }
  }

  el.toggleSidebar.addEventListener('click', () => applySidebar(!el.app.classList.contains('collapsed')));

  // ---------- Ocultar filtros ----------
  const FILTERS_KEY = 'visor-filters-hidden';

  function applyFiltersHidden(hidden) {
    el.filters.classList.toggle('hidden', hidden);
    el.toggleFilters.textContent = hidden ? 'Mostrar filtros' : 'Ocultar filtros';
    el.toggleFilters.title = el.toggleFilters.textContent;
    try {
      localStorage.setItem(FILTERS_KEY, hidden ? '1' : '0');
    } catch (_) {
      /* sin almacenamiento: los filtros vuelven a mostrarse al recargar */
    }
  }

  el.toggleFilters.addEventListener('click', () => applyFiltersHidden(!el.filters.classList.contains('hidden')));

  // ---------- Tema: modo oscuro / claro ----------
  const THEME_KEY = 'visor-theme';
  const systemLight = window.matchMedia('(prefers-color-scheme: light)');

  // Oscuro si el usuario lo eligió; si no, el del sistema (CSS decide con data-theme ausente)
  const isDarkNow = () => {
    const t = document.documentElement.dataset.theme;
    return t ? t === 'dark' : !systemLight.matches;
  };

  function applyTheme(dark, save = true) {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    if (save) {
      try {
        localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light');
      } catch (_) {
        /* sin almacenamiento: el tema dura solo esta sesión */
      }
    }
  }

  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark' || saved === 'light') applyTheme(saved === 'dark', false);
  } catch (_) {
    /* sin almacenamiento: tema del sistema */
  }

  // ---------- Configuración (engranaje) ----------
  function openSettings() {
    el.darkMode.checked = isDarkNow();
    el.settingsDialog.showModal();
  }

  el.darkMode.addEventListener('change', () => applyTheme(el.darkMode.checked));
  el.settingsBtn.addEventListener('click', openSettings);
  el.settingsClose.addEventListener('click', () => el.settingsDialog.close());
  el.settingsReset.addEventListener('click', () => {
    el.settingsDialog.close();
    openResetDialog();
  });

  // ---------- Reinicio completo ----------
  function openResetDialog() {
    el.resetConfirmText.value = '';
    el.resetConfirm.disabled = true;
    el.resetError.textContent = '';
    el.resetDialog.showModal();
    el.resetConfirmText.focus();
  }

  el.vaultReset.addEventListener('click', openResetDialog);
  el.resetCancel.addEventListener('click', () => el.resetDialog.close());
  el.resetConfirmText.addEventListener('input', () => {
    el.resetConfirm.disabled = el.resetConfirmText.value.trim() !== 'BORRAR';
  });

  el.resetConfirm.addEventListener('click', async () => {
    if (el.resetConfirmText.value.trim() !== 'BORRAR') return;
    try {
      await api('POST', '/api/reset');
      if (ws) ws.close();
      el.resetDialog.close();
      location.reload(); // vuelve a arrancar como la primera vez
    } catch (err) {
      el.resetError.textContent = err.message;
    }
  });

  // ---------- Arranque ----------
  (async function boot() {
    loadPrefs();
    try {
      applySidebar(localStorage.getItem(SIDEBAR_KEY) === '1');
      applyFiltersHidden(localStorage.getItem(FILTERS_KEY) === '1');
    } catch (_) {
      /* sin almacenamiento: menú abierto */
    }
    renderTabs();
    const state = await api('GET', '/api/state');
    if (state.unlocked) {
      showApp();
      await loadProfiles();
      connectWs();
    } else {
      showVault(state.vaultExists);
    }
  })().catch((err) => {
    el.vaultScreen.classList.remove('hidden');
    el.vaultError.textContent = `No se pudo contactar con el servidor: ${err.message}`;
  });
})();
