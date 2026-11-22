// Pegatinas QR: enlace de aviso rápido + diseño en SVG (nítido a cualquier tamaño).
// Módulo puro: recibe el generador de QR para poder testearlo sin navegador.

// Dirección pública de la web. La app nativa la usa para generar el enlace del QR;
// en la web se usa la dirección desde la que se está sirviendo.
export const WEB_URL = 'https://euskonet.github.io/matricula-chat/';

// La matrícula va en el fragmento (#): el navegador no lo envía al servidor,
// así que el hosting no llega a saber qué matrícula se ha escaneado.
export function quickLink(base, plate) {
  return `${base.split('#')[0]}#avisar=${encodeURIComponent(plate)}`;
}

/** Lee el fragmento de la URL: { action: 'avisar' | 'pegatina' | 'pedido' | 'gracias', ... } o null. */
export function parseHash(hash) {
  const params = new URLSearchParams(String(hash || '').replace(/^#/, ''));
  if (params.has('gracias')) return { action: 'gracias' };
  if (params.has('pedido')) {
    const m = /^([A-Z0-9]{4,10})-(50|70|90)-([01])$/.exec(String(params.get('pedido')).toUpperCase());
    return m ? { action: 'pedido', plate: m[1], size: Number(m[2]), showPlate: m[3] === '1' } : null;
  }
  for (const action of ['avisar', 'pegatina']) {
    const raw = params.get(action);
    if (raw != null) {
      const plate = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (/^[A-Z0-9]{4,10}$/.test(plate)) return { action, plate };
    }
  }
  return null;
}

/** Trazado SVG del QR (en unidades de módulo), uniendo módulos contiguos por filas. */
export function qrPath(qrcode, text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (!qr.isDark(r, c)) continue;
      let run = 1;
      while (c + run < n && qr.isDark(r, c + run)) run++;
      d += `M${c} ${r}h${run}v1h-${run}z`;
      c += run - 1;
    }
  }
  return { d, size: n };
}

const FONT = 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function formatPlate(p) {
  return /^\d{4}[A-Z]{3}$/.test(p) ? `${p.slice(0, 4)} ${p.slice(4)}` : p;
}

/**
 * SVG de una pegatina. Proporción 100×130; `widthMm` fija el tamaño físico.
 * @param {{ qrcode: Function, url: string, plate: string, showPlate?: boolean, widthMm?: number }} o
 */
export function stickerSvg({ qrcode, url, plate, showPlate = true, widthMm = 70 }) {
  const { d, size } = qrPath(qrcode, url);
  const qrBox = 64, qrX = 18, qrY = 29;
  const quiet = 2;                                  // margen blanco en módulos
  const scale = qrBox / (size + quiet * 2);
  const blue = '#0b3d91';
  const bottom = showPlate
    ? `<g transform="translate(29 115)">
        <rect x="0" y="0" width="42" height="11" rx="1.6" fill="#fff" stroke="#111" stroke-width="0.8"/>
        <rect x="0.4" y="0.4" width="6" height="10.2" rx="1.2" fill="#039"/>
        <text x="3.4" y="9" font-size="3.4" font-weight="700" fill="#fd0" text-anchor="middle" font-family="${FONT}">E</text>
        <text x="24.5" y="8.3" font-size="6.6" font-weight="800" fill="#111" text-anchor="middle" letter-spacing="0.3" font-family="${FONT}">${esc(formatPlate(plate))}</text>
      </g>`
    : `<text x="50" y="123" font-size="4.6" font-weight="700" fill="${blue}" text-anchor="middle" font-family="${FONT}">Matrícula Chat</text>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 130" width="${widthMm}mm" height="${(widthMm * 1.3).toFixed(1)}mm">
  <!-- Sin clipPath ni ids: varias pegatinas en la misma página no deben chocar -->
  <rect width="100" height="130" rx="6" fill="#fff"/>
  <path d="M0 24V6a6 6 0 0 1 6-6h88a6 6 0 0 1 6 6v18z" fill="${blue}"/>
  <rect x="0.6" y="0.6" width="98.8" height="128.8" rx="5.6" fill="none" stroke="${blue}" stroke-width="1.2"/>
  <text x="50" y="11" font-size="7.4" font-weight="800" fill="#fff" text-anchor="middle" font-family="${FONT}">¿PASA ALGO CON</text>
  <text x="50" y="19.6" font-size="7.4" font-weight="800" fill="#fff" text-anchor="middle" font-family="${FONT}">MI COCHE?</text>
  <g transform="translate(${qrX + quiet * scale} ${qrY + quiet * scale}) scale(${scale})">
    <path d="${d}" fill="#000" shape-rendering="crispEdges"/>
  </g>
  <text x="50" y="102.5" font-size="7" font-weight="800" fill="#16202e" text-anchor="middle" font-family="${FONT}">Escanéalo y avísame</text>
  <text x="50" y="109.6" font-size="4.1" fill="#56657a" text-anchor="middle" font-family="${FONT}">Sin apps · sin registro · anónimo</text>
  ${bottom}
</svg>`;
}
