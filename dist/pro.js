// Matrícula Chat Pro: límites, código de vinculación de dispositivos y
// respuestas propias. Módulo puro (test/pro.test.mjs).

import { checkOutgoing } from './moderation.js';

export const PRO = {
  productId: 'pro',                          // producto de compra única en Google Play
  maxPlatesFree: 1,
  maxPlatesPro: 5,
  maxReplies: 10,
  maxReplyLength: 80,
};

// ---------- Vinculación de un segundo dispositivo ----------
// El código contiene la clave de la matrícula: quien lo tenga puede leer y
// responder sus avisos. Por eso solo se muestra a petición y con aviso.

const b64url = s => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = s => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));
const PREFIX = 'MCV1.';

// La prueba scrypt no viaja: el otro dispositivo la recalcula con la matrícula
// y la sal. Así el código (y el QR) es más corto.
export function encodePairing({ plate, sk, salt }, now = Math.floor(Date.now() / 1000)) {
  return PREFIX + b64url(JSON.stringify({ v: 1, plate, sk, salt, t: now }));
}

/** Devuelve { plate, sk, salt, t } o null si el código no es válido. */
export function decodePairing(code) {
  try {
    const s = String(code || '').trim();
    if (!s.startsWith(PREFIX)) return null;
    const o = JSON.parse(unb64url(s.slice(PREFIX.length)));
    if (o?.v !== 1) return null;
    if (!/^[A-Z0-9]{4,10}$/.test(o.plate)) return null;
    if (!/^[0-9a-f]{64}$/.test(o.sk) || !/^[0-9a-f]{32}$/.test(o.salt)) return null;
    return { plate: o.plate, sk: o.sk, salt: o.salt, t: Number(o.t) || 0 };
  } catch {
    return null;
  }
}

// ---------- Respuestas propias ----------

/** Valida una respuesta nueva. Devuelve { ok: true, text } o { ok: false, error }. */
export function validateReply(text, existing = []) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return { ok: false, error: 'Escribe la respuesta.' };
  if (t.length > PRO.maxReplyLength) return { ok: false, error: `Máximo ${PRO.maxReplyLength} caracteres.` };
  if (existing.length >= PRO.maxReplies) return { ok: false, error: `Máximo ${PRO.maxReplies} respuestas.` };
  if (existing.some(r => r.toLowerCase() === t.toLowerCase())) return { ok: false, error: 'Ya tienes esa respuesta.' };
  const check = checkOutgoing(t);
  if (!check.ok) return { ok: false, error: `Contiene lenguaje no permitido («${check.masked}»).` };
  return { ok: true, text: t };
}
