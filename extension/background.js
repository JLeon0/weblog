// Service worker: abre el panel lateral, inyecta el selector de área en la pestaña
// activa y toma la captura cuando el usuario termina de seleccionar el recuadro.

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

async function startCapture() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error('No hay una pestaña activa');
  if (!/^https?:/.test(tab.url || '')) {
    throw new Error('Solo se puede capturar en páginas web (http/https)');
  }
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] });
}

async function captureSelected(windowId, rect, vw, vh) {
  // El overlay ya se quitó en la página; aquí solo se toma la imagen visible
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  chrome.runtime.sendMessage({ type: 'capture:image', dataUrl, rect, vw, vh }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'capture:start') {
    startCapture()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true; // respuesta asíncrona
  }

  if (msg.type === 'capture:selected' && sender.tab) {
    captureSelected(sender.tab.windowId, msg.rect, msg.vw, msg.vh).catch((err) => {
      chrome.runtime.sendMessage({ type: 'capture:error', error: err.message }).catch(() => {});
    });
    return false;
  }

  return false;
});
