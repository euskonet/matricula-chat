// Reglas del protocolo Matrícula Chat sobre Nostr.
// Este módulo es puro (sin red ni criptografía) para poder testearlo:
// todos los clientes aplican las mismas reglas sobre el mismo historial
// público de eventos y llegan al mismo estado, sin servidor que arbitre.

export const PROTOCOL = 'matricula-chat/v1';

// Kinds "regulares" (1000-9999): los relays los guardan y no los reemplazan,
// así el historial de reclamaciones no se puede reescribir sustituyendo eventos.
export const KIND_CLAIM = 7151;
export const KIND_MSG = 7152;

export const PARAMS = {
  claimPow: 16,                 // bits de prueba de trabajo exigidos a cada reclamación
  maxFutureSkew: 5 * 60,        // se ignoran eventos fechados más de 5 min en el futuro
  disputeWindow: 24 * 3600,     // ventana para contar cambios de titular
  disputeChanges: 3,            // nº de cambios en la ventana que congela la matrícula
  freeze: 24 * 3600,            // duración de la congelación
  claimTtl: 30 * 24 * 3600,     // una reclamación sin renovar caduca a los 30 días
  claimRefresh: 7 * 24 * 3600,  // el titular la renueva automáticamente cada 7 días
  msgTtl: 72 * 3600,            // los mensajes llevan expiración (NIP-40) de 72 h
  maxText: 500,
};

// Parámetros scrypt para convertir la matrícula en una etiqueta pública.
// El espacio de matrículas es pequeño (~80 M), así que un hash rápido se
// recorrería entero en segundos; scrypt lo encarece mucho, aunque no lo impide.
export const PLATE_KDF = { N: 2 ** 15, r: 8, p: 1, dkLen: 32, salt: PROTOCOL };

export const PRESETS = [
  { id: 'lights', es: 'Te has dejado las luces encendidas' },
  { id: 'blocking', es: 'Tu coche me está bloqueando la salida' },
  { id: 'tyre', es: 'Tienes una rueda baja o pinchada' },
  { id: 'window', es: 'Te has dejado una ventanilla abierta' },
  { id: 'damage', es: 'Tu coche ha sufrido un golpe, revísalo' },
  { id: 'tow', es: 'La grúa está retirando coches en la zona' },
  { id: 'alarm', es: 'Está sonando la alarma de tu coche' },
  { id: 'thanks', es: '¡Gracias!' },
  { id: 'onmyway', es: 'Voy enseguida' },
];
const PRESET_IDS = new Set(PRESETS.map(p => p.id));
export const presetText = id => PRESETS.find(p => p.id === id)?.es ?? '';

export function normalizePlate(input) {
  return String(input ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function isValidPlate(plate) {
  return /^[A-Z0-9]{4,10}$/.test(plate);
}

// Formato actual español (desde 2000): 4 dígitos + 3 consonantes sin vocales, Ñ ni Q.
export function isModernSpanishPlate(plate) {
  return /^\d{4}[BCDFGHJKLMNPRSTVWXYZ]{3}$/.test(plate);
}

export function leadingZeroBits(hex) {
  let bits = 0;
  for (const ch of hex) {
    const n = parseInt(ch, 16);
    if (n === 0) { bits += 4; continue; }
    bits += Math.clz32(n) - 28;
    break;
  }
  return bits;
}

function tagValue(ev, name) {
  return ev.tags?.find(t => t[0] === name)?.[1];
}

function claimAction(ev) {
  try {
    const c = JSON.parse(ev.content);
    return c?.action === 'release' ? 'release' : 'claim';
  } catch {
    return 'claim';
  }
}

export function isValidClaimEvent(ev, plateTag, now, params = PARAMS) {
  return ev.kind === KIND_CLAIM
    && tagValue(ev, 'x') === plateTag
    && ev.created_at <= now + params.maxFutureSkew
    && leadingZeroBits(ev.id) >= params.claimPow;
}

/**
 * Calcula quién es el titular de una matrícula a partir de su historial
 * público de reclamaciones. La firma de cada evento debe haberse verificado antes.
 *
 * Reglas:
 *  - Gana la última reclamación (sesiones que se invalidan).
 *  - La misma clave volviendo a reclamar es una renovación, no un cambio.
 *  - "release" del titular libera la matrícula sin contar como cambio.
 *  - N cambios de titular en la ventana congelan la matrícula: nadie recibe
 *    mensajes hasta que pasa la congelación, que después queda libre.
 *  - Sin renovación en claimTtl, la reclamación caduca.
 *
 * @returns {{status:'free'|'held'|'disputed', holder:string|null, since:number|null,
 *            lastSeen:number|null, frozenUntil:number|null, changes:number}}
 */
export function resolveClaims(events, plateTag, now, params = PARAMS) {
  const valid = events
    .filter(ev => isValidClaimEvent(ev, plateTag, now, params))
    .sort((a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : 1));

  let holder = null, since = null, lastSeen = null;
  let frozenUntil = 0;
  let changes = [];

  for (const ev of valid) {
    const t = ev.created_at;
    if (frozenUntil) {
      if (t < frozenUntil) continue;          // durante la congelación no cuenta nada
      frozenUntil = 0; changes = []; holder = null;
    }
    const action = claimAction(ev);

    if (holder && t - lastSeen > params.claimTtl) holder = null; // caducada

    if (action === 'release') {
      if (ev.pubkey === holder) { holder = null; since = null; lastSeen = null; }
      continue;
    }
    if (holder === ev.pubkey) { lastSeen = t; continue; }
    if (holder === null) { holder = ev.pubkey; since = t; lastSeen = t; continue; }

    changes = changes.filter(c => c > t - params.disputeWindow);
    changes.push(t);
    if (changes.length >= params.disputeChanges) {
      holder = null; since = null; lastSeen = null;
      frozenUntil = t + params.freeze;
    } else {
      holder = ev.pubkey; since = t; lastSeen = t;
    }
  }

  if (frozenUntil && frozenUntil > now) {
    return { status: 'disputed', holder: null, since: null, lastSeen: null, frozenUntil, changes: changes.length };
  }
  if (frozenUntil) { holder = null; changes = []; }
  if (holder && now - lastSeen > params.claimTtl) holder = null;
  return holder
    ? { status: 'held', holder, since, lastSeen, frozenUntil: null, changes: changes.length }
    : { status: 'free', holder: null, since: null, lastSeen: null, frozenUntil: null, changes: changes.length };
}

/**
 * Valida un mensaje ya descifrado. Lo aplica el cliente del receptor, que
 * es quien debe protegerse: aunque alguien modifique su app, el texto libre
 * no se muestra hasta que el titular ha contestado en esa conversación.
 */
export function validateMessage(msg, { allowText }) {
  if (!msg || msg.v !== 1) return null;
  if (msg.type === 'preset' && PRESET_IDS.has(msg.preset)) {
    return { type: 'preset', preset: msg.preset };
  }
  if (msg.type === 'text' && allowText && typeof msg.text === 'string') {
    const text = msg.text.trim().slice(0, PARAMS.maxText);
    if (text) return { type: 'text', text };
  }
  return null;
}

// ---------- Límite de ritmo ----------
// El remitente no puede enviar más de 5 mensajes por minuto (lo aplica su app),
// y el receptor descarta lo que se pase (por si la app del otro está modificada).

export const RATE = {
  perWindow: 5,          // mensajes…
  window: 60,            // …por minuto
  maxUnanswered: 10,     // un desconocido sin respuesta no puede mandar más de 10 avisos
  maxNewThreads: 10,     // conversaciones nuevas hacia mi matrícula…
  newThreadsWindow: 600, // …cada 10 minutos (contra quien abre muchas con claves distintas)
};

/** Segundos que hay que esperar para poder enviar (0 = se puede ya). */
export function sendWait(myTimes, now, rate = RATE) {
  const recent = myTimes.filter(t => t > now - rate.window).sort((a, b) => a - b);
  if (recent.length < rate.perWindow) return 0;
  return Math.max(1, recent[recent.length - rate.perWindow] + rate.window - now);
}

/**
 * ¿Se acepta un mensaje entrante?
 * La ventana es simétrica alrededor de created_at: los mensajes antiguos
 * pueden llegar desordenados al abrir la app, y así ninguna ventana de 60 s
 * acaba con más de 5 mensajes aceptados.
 */
export function inboundAllowed({ times, t, replied, newThread, threadStarts = [] }, rate = RATE) {
  if (times.filter(x => Math.abs(x - t) < rate.window).length >= rate.perWindow) return false;
  if (!replied && times.length >= rate.maxUnanswered) return false;
  if (newThread && threadStarts.filter(x => Math.abs(x - t) < rate.newThreadsWindow).length >= rate.maxNewThreads) return false;
  return true;
}
