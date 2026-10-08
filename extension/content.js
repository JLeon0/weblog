// Se inyecta en la pestaña activa: muestra un overlay para seleccionar un recuadro.
// Al soltar el mouse quita el overlay (para que no salga en la captura) y avisa al
// service worker con el rectángulo en píxeles CSS de la ventana.
(() => {
  const OVERLAY_ID = '__evidencias_overlay';
  document.getElementById(OVERLAY_ID)?.remove();

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(0,0,0,.25);';

  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;border:2px dashed #4f8cff;background:rgba(79,140,255,.18);display:none;pointer-events:none;';

  const hint = document.createElement('div');
  hint.textContent = 'Arrastra para seleccionar el área. Esc cancela.';
  hint.style.cssText =
    'position:fixed;top:10px;left:50%;transform:translateX(-50%);background:#111;color:#fff;' +
    'padding:6px 10px;border-radius:6px;font:13px system-ui,sans-serif;pointer-events:none;';

  overlay.append(box, hint);
  document.documentElement.appendChild(overlay);

  let sx = 0;
  let sy = 0;
  let dragging = false;

  const cleanup = () => {
    window.removeEventListener('keydown', onKey, true);
    overlay.remove();
  };

  const cancel = () => {
    cleanup();
    chrome.runtime.sendMessage({ type: 'capture:cancelled' }).catch(() => {});
  };

  const onKey = (e) => {
    if (e.key === 'Escape') cancel();
  };
  window.addEventListener('keydown', onKey, true);

  const rectFrom = (e) => ({
    x: Math.min(sx, e.clientX),
    y: Math.min(sy, e.clientY),
    w: Math.abs(e.clientX - sx),
    h: Math.abs(e.clientY - sy),
  });

  const drawBox = (e) => {
    const r = rectFrom(e);
    Object.assign(box.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
  };

  overlay.addEventListener('mousedown', (e) => {
    dragging = true;
    sx = e.clientX;
    sy = e.clientY;
    box.style.display = 'block';
    drawBox(e);
  });

  overlay.addEventListener('mousemove', (e) => {
    if (dragging) drawBox(e);
  });

  overlay.addEventListener('mouseup', (e) => {
    if (!dragging) return;
    dragging = false;
    const rect = rectFrom(e);
    cleanup();
    if (rect.w < 5 || rect.h < 5) {
      chrome.runtime.sendMessage({ type: 'capture:cancelled' }).catch(() => {});
      return;
    }
    // Pequeña espera para que el navegador repinte la página sin el overlay
    setTimeout(() => {
      chrome.runtime
        .sendMessage({ type: 'capture:selected', rect, vw: window.innerWidth, vh: window.innerHeight })
        .catch(() => {});
    }, 120);
  });
})();
