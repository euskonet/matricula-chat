// Tienda de pegatinas. El cobro y la dirección de envío los gestiona Stripe
// (Payment Links): la app no ve ni guarda datos de pago ni direcciones.
//
// Para activarla, crea en Stripe un Payment Link por pack (con "Recoger
// dirección de envío" y, tras el pago, redirección a WEB_URL#gracias) y pega
// aquí su URL. Mientras `url` esté vacío, el pack no se muestra.
//
// Las URLs van fijas aquí a propósito: nunca se aceptan por parámetro, para que
// nadie pueda compartir un enlace de la app que lleve a un pago falso.

export const SHOP = {
  packs: [
    { id: 'p2', units: 2, price: '6,90 €', url: '' },
    { id: 'p4', units: 4, price: '9,90 €', url: '' },
  ],
  shipping: 'Envío a España incluido',
};

const ALLOWED_CHECKOUT = /^https:\/\/(buy\.stripe\.com|checkout\.stripe\.com)\//;

export const activePacks = (shop = SHOP) => shop.packs.filter(p => ALLOWED_CHECKOUT.test(p.url));

/** Código de pedido que viaja a Stripe: matrícula, tamaño (mm), matrícula impresa, diseño (color + frase). */
export function orderRef(plate, sizeMm, showPlate, theme = 'a', headline = '0') {
  return `${plate}-${sizeMm}-${showPlate ? 1 : 0}-${theme.toUpperCase()}${headline}`;
}

export function parseOrderRef(ref) {
  const m = /^([A-Z0-9]{4,10})-(50|70|90)-([01])(?:-([ANRVY])([0-2]))?$/.exec(String(ref || '').toUpperCase());
  return m ? {
    plate: m[1], size: Number(m[2]), showPlate: m[3] === '1',
    theme: (m[4] || 'A').toLowerCase(), headline: m[5] || '0',
  } : null;
}

/** URL de pago de Stripe con el código de pedido y la página en español. */
export function checkoutUrl(pack, ref) {
  if (!ALLOWED_CHECKOUT.test(pack.url)) throw new Error('Pack sin enlace de pago');
  const u = new URL(pack.url);
  u.searchParams.set('client_reference_id', ref);
  u.searchParams.set('locale', 'es');
  return u.toString();
}
