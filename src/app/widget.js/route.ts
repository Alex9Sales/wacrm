// ============================================================
// 🧩 Widget embutível — /widget.js. O cliente cola UMA tag de script no site
// dele e ganha o balão flutuante que abre a página de captação (chat/form/
// quiz) num iframe. Vanilla JS, zero dependência, ~1.5KB. Atributos:
//   data-fluxia="<slug>"      (obrigatório — qual página abre)
//   data-color="#7c3aed"      (cor do balão; opcional)
//   data-position="right|left" (canto; opcional, padrão right)
// O X-Frame-Options de /f/* foi aberto no next.config pra permitir o iframe.
// ============================================================

const WIDGET_JS = `(function () {
  var s = document.currentScript;
  if (!s) return;
  var slug = s.getAttribute('data-fluxia');
  if (!slug) return;
  var color = s.getAttribute('data-color') || '#7c3aed';
  var side = s.getAttribute('data-position') === 'left' ? 'left' : 'right';
  var origin;
  try { origin = new URL(s.src).origin; } catch (e) { return; }
  if (document.getElementById('fluxia-widget-btn')) return;

  var btn = document.createElement('button');
  btn.id = 'fluxia-widget-btn';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Abrir chat');
  btn.textContent = '💬';
  btn.style.cssText = 'position:fixed;bottom:20px;' + side + ':20px;width:60px;height:60px;border-radius:50%;border:none;background:' + color + ';color:#fff;font-size:26px;line-height:60px;text-align:center;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.25);z-index:2147483000;transition:transform .15s ease;padding:0;';
  btn.onmouseenter = function () { btn.style.transform = 'scale(1.06)'; };
  btn.onmouseleave = function () { btn.style.transform = 'scale(1)'; };

  var panel = null;
  var open = false;
  function toggle() {
    open = !open;
    if (open && !panel) {
      panel = document.createElement('div');
      panel.id = 'fluxia-widget-panel';
      panel.style.cssText = 'position:fixed;bottom:92px;' + side + ':20px;width:380px;max-width:calc(100vw - 24px);height:600px;max-height:calc(100vh - 120px);border-radius:16px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,.3);z-index:2147483000;background:#fff;';
      var frame = document.createElement('iframe');
      frame.src = origin + '/f/' + encodeURIComponent(slug) + '?embed=1';
      frame.title = 'Fale com a gente';
      frame.style.cssText = 'width:100%;height:100%;border:0;display:block;';
      panel.appendChild(frame);
      document.body.appendChild(panel);
    }
    if (panel) panel.style.display = open ? 'block' : 'none';
    btn.textContent = open ? '✕' : '💬';
    btn.style.fontSize = open ? '22px' : '26px';
  }
  btn.onclick = toggle;

  if (document.body) document.body.appendChild(btn);
  else document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(btn); });
})();
`

export function GET() {
  return new Response(WIDGET_JS, {
    headers: {
      'content-type': 'application/javascript; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  })
}
