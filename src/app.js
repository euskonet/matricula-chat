import {
  SimplePool, finalizeEvent, generateSecretKey, getPublicKey, nip44, minePow,
  scryptAsync, bytesToHex, hexToBytes, Capacitor, LocalNotifications, registerPlugin,
  qrcode, Share, Filesystem, Directory,
} from './vendor.js';
import {
  KIND_CLAIM, KIND_MSG, PARAMS, PLATE_KDF, PRESETS, presetText,
  normalizePlate, isValidPlate, isModernSpanishPlate, resolveClaims, validateMessage,
  sendWait, inboundAllowed,
} from './protocol.js';
import { analyze, checkOutgoing } from './moderation.js';
import { WEB_URL, quickLink, parseHash, stickerSvg } from './sticker.js';

// ---------- Configuración ----------

const DEFAULT_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://offchain.pub',
];
const STORE_KEY = 'mc:v1';

function getRelays() {
  const fromUrl = new URLSearchParams(location.search).get('relays');
  if (fromUrl) return fromUrl.split(',').map(s => s.trim()).filter(Boolean);
  try {
    const saved = JSON.parse(localStorage.getItem('mc:relays'));
    if (Array.isArray(saved) && saved.length) return saved;
  } catch {}
  return DEFAULT_RELAYS;
}

const relays = getRelays();
// En móvil el sistema corta los WebSockets al pasar a segundo plano: reconectar.
const pool = new SimplePool({ enablePing: true, enableReconnect: true });
const isNative = Capacitor.isNativePlatform();
// Plugin nativo propio (android/.../BackgroundCheckPlugin.java). Solo existe en la app.
const BackgroundCheck = isNative && Capacitor.getPlatform() === 'android' ? registerPlugin('BackgroundCheck') : null;
const now = () => Math.floor(Date.now() / 1000);

// ---------- Almacenamiento local (solo en este dispositivo) ----------

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && typeof s === 'object') return { plate: null, threads: {}, seen: [], blocked: [], ...s };
  } catch {}
  return { plate: null, threads: {}, seen: [], blocked: [] };
}
const store = load();
const seen = new Set(store.seen);
function save() {
  store.seen = [...seen].slice(-3000);
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch {}
}

// ---------- Criptografía ----------

const tagCache = new Map();
async function plateTag(plate) {
  if (!tagCache.has(plate)) {
    const { N, r, p, dkLen, salt } = PLATE_KDF;
    tagCache.set(plate, bytesToHex(await scryptAsync(plate, salt, { N, r, p, dkLen })));
  }
  return tagCache.get(plate);
}
const pubOf = skHex => getPublicKey(hexToBytes(skHex));
const convKey = (skHex, peer) => nip44.getConversationKey(hexToBytes(skHex), peer);
const encryptFor = (skHex, peer, obj) => nip44.encrypt(JSON.stringify(obj), convKey(skHex, peer));
function decryptFrom(skHex, peer, payload) {
  try { return JSON.parse(nip44.decrypt(payload, convKey(skHex, peer))); } catch { return null; }
}

// ---------- Red ----------

async function publish(ev) {
  const results = await Promise.allSettled(pool.publish(relays, ev));
  const ok = results.filter(r => r.status === 'fulfilled').length;
  if (!ok) throw new Error('Ningún relay ha aceptado el evento. Revisa tu conexión.');
  return ok;
}

async function fetchClaims(tag) {
  return pool.querySync(relays, { kinds: [KIND_CLAIM], '#x': [tag] }, { maxWait: 4000 });
}

async function resolvePlate(plate) {
  const tag = await plateTag(plate);
  const events = await fetchClaims(tag);
  for (const ev of events) claimEvents.set(ev.id, ev); // resolveClaims filtra por matrícula
  return { tag, ...resolveClaims(events, tag, now()) };
}

// Fecha más reciente de las reclamaciones conocidas de una matrícula (sin contar
// las fechadas demasiado en el futuro, que el protocolo ignora).
function latestClaimAt(tag) {
  let max = 0;
  for (const ev of claimEvents.values()) {
    if (ev.tags.some(t => t[0] === 'x' && t[1] === tag) && ev.created_at <= now() + PARAMS.maxFutureSkew) {
      max = Math.max(max, ev.created_at);
    }
  }
  return max;
}

const tick = () => new Promise(r => setTimeout(r, 30));

async function publishClaim(action, tag, skHex) {
  // Siempre posterior a la última reclamación conocida: si dos reclamaciones
  // cayeran en el mismo segundo, el desempate podría ordenarlas al revés.
  const unsigned = {
    kind: KIND_CLAIM, created_at: Math.max(now(), latestClaimAt(tag) + 1), pubkey: pubOf(skHex),
    tags: [['x', tag]], content: JSON.stringify({ action }),
  };
  await tick(); // deja que se pinte el "trabajando…"
  // keepCreatedAt: si no, minePow sustituye la fecha por "ahora" y se pierde el ajuste de arriba.
  const mined = minePow(unsigned, PARAMS.claimPow, { keepCreatedAt: true });
  const ev = finalizeEvent(mined, hexToBytes(skHex));
  await publish(ev);
  claimEvents.set(ev.id, ev);
  return ev;
}

// Máximo 5 mensajes por minuto desde este dispositivo, sumando todas las conversaciones.
function assertCanSend() {
  const mine = Object.values(store.threads).flatMap(t => t.messages.filter(m => m.from === 'me').map(m => m.at));
  const wait = sendWait(mine, now());
  if (wait) throw new Error(`Has enviado 5 mensajes en el último minuto. Espera ${wait} s.`);
}

async function sendRaw(thread, payload) {
  assertCanSend();
  const ev = finalizeEvent({
    kind: KIND_MSG, created_at: now(),
    tags: [['p', thread.peer], ['expiration', String(now() + PARAMS.msgTtl)]],
    content: encryptFor(thread.sk, thread.peer, { v: 1, ...payload }),
  }, hexToBytes(thread.sk));
  await publish(ev);
  thread.messages.push({ id: ev.id, from: 'me', ...payload, at: ev.created_at });
  thread.updated = ev.created_at;
  save();
}

// ---------- Mi matrícula: reclamar, liberar, detectar expulsión ----------

let claimEvents = new Map();
let claimsReady = false;
let claimSub = null;
let mine = { status: 'none' }; // none | active | lost | disputed | free
let pendingMsgs = [];

function recomputeMine() {
  if (!store.plate) { mine = { status: 'none' }; return; }
  const r = resolveClaims([...claimEvents.values()], store.plate.tag, now());
  const myPub = pubOf(store.plate.sk);
  const prev = mine.status;
  if (r.status === 'held' && r.holder === myPub) mine = { ...r, status: 'active' };
  else if (r.status === 'disputed') mine = { ...r, status: 'disputed' };
  else if (r.status === 'held') mine = { ...r, status: 'lost' };
  else mine = { ...r, status: 'free' };

  if (prev === 'active' && mine.status !== 'active') {
    closeThreads(t => t.role === 'holder', mine.status === 'disputed' ? 'disputed' : 'kicked');
    notify(mine.status === 'disputed'
      ? `La matrícula ${store.plate.plate} está en disputa`
      : `Otro dispositivo ha reclamado ${store.plate.plate}`,
    'Has dejado de recibir mensajes en este dispositivo.');
  }
  if (mine.status === 'active' && now() - mine.lastSeen > PARAMS.claimRefresh) {
    publishClaim('claim', store.plate.tag, store.plate.sk).then(recomputeMine).catch(() => {});
  }
}

function watchMyPlate() {
  claimSub?.close();
  claimEvents = new Map();
  claimsReady = false;
  if (!store.plate) { recomputeMine(); render(); return; }
  claimSub = pool.subscribe(relays, { kinds: [KIND_CLAIM], '#x': [store.plate.tag] }, {
    onevent(ev) {
      claimEvents.set(ev.id, ev);
      if (claimsReady) { recomputeMine(); render(); }
    },
    oneose() {
      if (claimsReady) return;
      claimsReady = true;
      recomputeMine();
      const queued = pendingMsgs; pendingMsgs = [];
      queued.forEach(handleMsg);
      render();
    },
  });
}

async function claimPlate(input) {
  const plate = normalizePlate(input);
  if (!isValidPlate(plate)) throw new Error('Matrícula no válida.');
  setBusy('Comprobando matrícula…');
  const r = await resolvePlate(plate);
  if (r.status === 'disputed') {
    throw new Error(`Esta matrícula está en disputa hasta ${fmtDate(r.frozenUntil)}. Inténtalo después.`);
  }
  // Misma matrícula en este dispositivo: reutiliza la clave. Otra: clave nueva.
  const sk = store.plate?.plate === plate ? store.plate.sk : bytesToHex(generateSecretKey());
  if (store.plate && store.plate.plate !== plate) await releasePlate(false);
  setBusy('Generando prueba de trabajo…');
  store.plate = { plate, tag: r.tag, sk };
  save();
  await publishClaim('claim', r.tag, sk);
  watchMyPlate();
}

async function releasePlate(rerender = true) {
  if (!store.plate) return;
  const { tag, sk } = store.plate;
  if (mine.status === 'active') {
    setBusy('Liberando…');
    try { await publishClaim('release', tag, sk); } catch {}
  }
  closeThreads(t => t.role === 'holder', 'released');
  store.plate = null;
  save();
  if (rerender) watchMyPlate();
}

function closeThreads(pred, reason) {
  for (const t of Object.values(store.threads)) if (pred(t) && !t.closed) t.closed = reason;
  save();
}

// ---------- Mensajes ----------

let msgSub = null;
let msgSubKeys = '';

function myInboxKeys() {
  const keys = [];
  if (store.plate) keys.push(pubOf(store.plate.sk));
  for (const t of Object.values(store.threads)) if (t.role === 'sender' && !t.closed) keys.push(t.myPub);
  return [...new Set(keys)].sort();
}

function watchInbox() {
  const keys = myInboxKeys();
  const sig = keys.join(',');
  if (sig === msgSubKeys) return;
  msgSubKeys = sig;
  msgSub?.close();
  msgSub = null;
  if (!keys.length) return;
  msgSub = pool.subscribe(relays, { kinds: [KIND_MSG], '#p': keys, since: now() - PARAMS.msgTtl }, {
    onevent: handleMsg,
  });
}

function handleMsg(ev) {
  if (seen.has(ev.id)) return;
  const p = ev.tags.find(t => t[0] === 'p')?.[1];
  if (ev.created_at > now() + PARAMS.maxFutureSkew) return;
  if (store.blocked.includes(ev.pubkey)) { seen.add(ev.id); save(); return; }
  const peerTimes = t => (t ? t.messages.filter(m => m.from === 'peer').map(m => m.at) : []);

  // 1) Mensaje para mi matrícula
  if (store.plate && p === pubOf(store.plate.sk)) {
    if (!claimsReady) { pendingMsgs.push(ev); return; }
    seen.add(ev.id);
    if (mine.status !== 'active') { save(); return; } // ya no soy el titular
    const id = 'in:' + ev.pubkey;
    let t = store.threads[id];
    if (t?.closed) { save(); return; }
    const starts = Object.values(store.threads).filter(x => x.role === 'holder').map(x => x.created);
    if (!inboundAllowed({ times: peerTimes(t), t: ev.created_at, replied: !!t?.meReplied, newThread: !t, threadStarts: starts })) {
      save(); return; // demasiados mensajes: se descarta
    }
    const msg = validateMessage(decryptFrom(store.plate.sk, ev.pubkey, ev.content), {
      allowText: !!t?.meReplied,
    });
    if (!msg) { save(); return; } // texto libre antes de contestar, o basura: se descarta
    if (!t) {
      t = store.threads[id] = {
        id, role: 'holder', plate: store.plate.plate, sk: store.plate.sk,
        myPub: pubOf(store.plate.sk), peer: ev.pubkey, messages: [], created: ev.created_at,
      };
    }
    t.messages.push({ id: ev.id, from: 'peer', ...msg, at: ev.created_at });
    t.messages.sort((a, b) => a.at - b.at);
    t.updated = Math.max(t.updated || 0, ev.created_at);
    t.unread = (t.unread || 0) + 1;
    save();
    notify(`Mensaje para ${t.plate}`, notifText(msg));
    render();
    return;
  }

  // 2) Respuesta del titular a una conversación que inicié yo
  const t = Object.values(store.threads).find(x => x.role === 'sender' && x.myPub === p);
  seen.add(ev.id);
  if (!t || t.closed || ev.pubkey !== t.peer) { save(); return; }
  if (!inboundAllowed({ times: peerTimes(t), t: ev.created_at, replied: true, newThread: false })) { save(); return; }
  const msg = validateMessage(decryptFrom(t.sk, ev.pubkey, ev.content), { allowText: true });
  if (!msg) { save(); return; }
  t.messages.push({ id: ev.id, from: 'peer', ...msg, at: ev.created_at });
  t.messages.sort((a, b) => a.at - b.at);
  t.peerReplied = true;
  t.updated = Math.max(t.updated || 0, ev.created_at);
  t.unread = (t.unread || 0) + 1;
  save();
  notify(`Respuesta de ${t.plate}`, notifText(msg));
  render();
}

async function startConversation(input, presetId) {
  const plate = normalizePlate(input);
  if (!isValidPlate(plate)) throw new Error('Matrícula no válida.');
  assertCanSend();
  setBusy('Buscando matrícula…');
  const r = await resolvePlate(plate);
  if (r.status === 'disputed') throw new Error('Esa matrícula está en disputa y no recibe mensajes ahora mismo.');
  if (r.status !== 'held') throw new Error('Esa matrícula no está recibiendo mensajes.');
  if (store.plate && r.holder === pubOf(store.plate.sk)) throw new Error('Es tu propia matrícula.');
  // Una clave efímera nueva por conversación: el remitente es anónimo y
  // sus conversaciones no se pueden relacionar entre sí.
  const sk = bytesToHex(generateSecretKey());
  const id = 'out:' + pubOf(sk);
  const t = store.threads[id] = {
    id, role: 'sender', plate, tag: r.tag, sk, myPub: pubOf(sk), peer: r.holder,
    messages: [], created: now(),
  };
  setBusy('Enviando…');
  try {
    await sendRaw(t, { type: 'preset', preset: presetId });
  } catch (e) {
    delete store.threads[id]; save(); throw e;
  }
  watchInbox();
  return id;
}

async function sendInThread(id, payload) {
  const t = store.threads[id];
  if (!t || t.closed) throw new Error('Esta conversación está cerrada.');
  if (payload.type === 'text' && t.role === 'sender' && !t.peerReplied) {
    throw new Error('Podrás escribir texto libre cuando el titular conteste.');
  }
  if (payload.type === 'text') {
    const check = checkOutgoing(payload.text);
    if (!check.ok) throw new Error(`No se puede enviar: contiene lenguaje no permitido («${check.masked}»).`);
  }
  assertCanSend();
  setBusy('Enviando…');
  if (t.role === 'sender') {
    // Antes de cada envío se comprueba que el titular sigue siendo el mismo
    // dispositivo. Si ha cambiado, la conversación se cierra: el nuevo
    // titular no puede continuar una conversación ajena.
    const r = await resolvePlate(t.plate);
    if (r.status !== 'held' || r.holder !== t.peer) {
      t.closed = r.status === 'disputed' ? 'disputed' : 'changed';
      save();
      throw new Error(closedReason(t.closed));
    }
  } else if (mine.status !== 'active' || store.plate?.sk !== t.sk) {
    t.closed = 'kicked'; save();
    throw new Error(closedReason('kicked'));
  }
  await sendRaw(t, payload);
  if (t.role === 'holder') { t.meReplied = true; save(); }
}

// ---------- Avisos ----------

// 'granted' | 'denied' | 'prompt' | 'unsupported'
let notifPerm = 'unsupported';
let notifId = 1;

async function checkNotifPerm() {
  try {
    if (isNative) notifPerm = (await LocalNotifications.checkPermissions()).display;
    else if ('Notification' in window) notifPerm = Notification.permission === 'default' ? 'prompt' : Notification.permission;
  } catch { notifPerm = 'unsupported'; }
  if (notifPerm.startsWith('prompt')) notifPerm = 'prompt';
}

async function requestNotifPerm() {
  try {
    if (isNative) await LocalNotifications.requestPermissions();
    else await Notification.requestPermission();
  } catch {}
  await checkNotifPerm();
}

function notify(title, body) {
  if (!document.hidden) return;
  document.title = '● Matrícula Chat';
  if (notifPerm !== 'granted') return;
  try {
    if (isNative) {
      LocalNotifications.schedule({ notifications: [{ id: notifId++, title, body }] });
    } else {
      new Notification(title, { body, icon: 'icon.svg' });
    }
  } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) document.title = 'Matrícula Chat';
  markSeen();
});

// ---------- Comprobación en segundo plano (Android) ----------
// La tarea nativa solo recibe claves PÚBLICAS: puede contar mensajes nuevos
// y detectar reclamaciones de mi matrícula, pero no leer nada.

let bgSig = '';
function syncBackground() {
  if (!BackgroundCheck || (store.plate && !claimsReady)) return;
  const active = !!store.plate && mine.status === 'active';
  const pubkeys = Object.values(store.threads)
    .filter(t => t.role === 'sender' && !t.closed).map(t => t.myPub);
  if (active) pubkeys.push(pubOf(store.plate.sk));
  const cfg = {
    pubkeys: [...new Set(pubkeys)].sort(),
    relays,
    blocked: [...store.blocked].sort(),
    plateTag: active ? store.plate.tag : null,
    myPub: active ? pubOf(store.plate.sk) : null,
  };
  const sig = JSON.stringify(cfg);
  if (sig === bgSig) return;
  bgSig = sig;
  BackgroundCheck.configure(cfg).catch(() => { bgSig = ''; });
}

// La app está a la vista y ya ha mostrado lo recibido: que la tarea no lo repita.
function markSeen() {
  if (BackgroundCheck && !document.hidden) BackgroundCheck.markSeen({ at: now() }).catch(() => {});
}

// ---------- Interfaz ----------

const $ = sel => document.querySelector(sel);
const app = $('#app');
let view = 'home';
let busy = '';
let error = '';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtPlate = p => esc(isModernSpanishPlate(p) ? `${p.slice(0, 4)} ${p.slice(4)}` : p);
const fmtDate = t => new Date(t * 1000).toLocaleString('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const fmtTime = t => {
  const d = new Date(t * 1000);
  return d.toDateString() === new Date().toDateString()
    ? d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
    : fmtDate(t);
};
const plateBadge = (p, cls = '') => `<span class="plate ${cls}"><span class="eu">E</span><span class="num">${fmtPlate(p)}</span></span>`;
// Los mensajes se guardan tal cual y se censuran al mostrarlos: así las
// mejoras de la lista se aplican también a lo ya recibido.
const modCache = new Map();
function moderated(text) {
  if (!modCache.has(text)) modCache.set(text, analyze(text));
  return modCache.get(text);
}
const msgText = m => m.type === 'preset' ? esc(presetText(m.preset)) : esc(moderated(m.text).masked);
function previewText(m) {
  if (m.type === 'text' && m.from === 'peer' && moderated(m.text).level === 'severe') return 'Mensaje ocultado';
  return msgText(m);
}
function notifText(msg) {
  if (msg.type === 'preset') return presetText(msg.preset);
  const a = moderated(msg.text);
  return a.level === 'severe' ? 'Mensaje ocultado por lenguaje ofensivo' : a.masked;
}
const revealed = new Set();

function msgHtml(m) {
  const peer = m.from === 'peer' && m.type === 'text';
  const a = peer ? moderated(m.text) : null;
  const hidden = peer && a.level === 'severe' && !revealed.has(m.id);
  const bubble = hidden
    ? `<button class="bubble hidden-msg" data-reveal="${esc(m.id)}">Mensaje ocultado por lenguaje ofensivo · <u>Ver</u></button>`
    : `<div class="bubble ${m.type}">${msgText(m)}</div>`;
  const threat = peer && a.threat
    ? `<div class="threat">⚠ Este mensaje puede ser una amenaza. Si estás en peligro, llama al <a href="tel:112">112</a>.
         <button class="link" data-action="export">Guardar la conversación como prueba</button></div>`
    : '';
  return `<div class="msg ${m.from}">${bubble}<time>${fmtTime(m.at)}</time>${threat}</div>`;
}
const shortId = pub => '#' + pub.slice(0, 4);

function closedReason(r) {
  return {
    changed: 'El destinatario ha cambiado de dispositivo. Esta conversación se ha cerrado.',
    disputed: 'La matrícula está en disputa. Esta conversación se ha cerrado.',
    kicked: 'Otro dispositivo ha reclamado tu matrícula. Esta conversación se ha cerrado.',
    released: 'Liberaste la matrícula. Esta conversación se ha cerrado.',
    blocked: 'Has bloqueado esta conversación. No recibirás más mensajes de esta persona.',
  }[r] || 'Conversación cerrada.';
}

function setBusy(msg) { busy = msg; error = ''; render(); }

async function run(fn) {
  try { await fn(); error = ''; } catch (e) { error = e?.message || String(e); }
  busy = '';
  render();
}

function renderMyPlate() {
  if (!store.plate) {
    return `
      <section class="card">
        <h2>Mi matrícula</h2>
        <p class="muted">Regístrala para que otros conductores puedan avisarte. No pedimos nombre, teléfono ni email.</p>
        <form data-action="claim" class="row">
          <input name="plate" placeholder="1234 BCD" autocomplete="off" autocapitalize="characters" maxlength="12" required>
          <button>Registrar</button>
        </form>
      </section>`;
  }
  const p = store.plate.plate;
  let status;
  if (!claimsReady) status = `<p class="status">Comprobando estado…</p>`;
  else if (mine.status === 'active') status = `<p class="status ok">● Recibiendo mensajes desde ${fmtDate(mine.since)}</p>
      <button class="secondary wide" data-action="sticker">Crear pegatina QR para el coche</button>`;
  else if (mine.status === 'disputed') status = `
      <div class="banner warn"><strong>Matrícula en disputa</strong>
      Ha cambiado de dispositivo demasiadas veces en 24 h. Nadie recibe mensajes hasta ${fmtDate(mine.frozenUntil)}.</div>`;
  else if (mine.status === 'lost') status = `
      <div class="banner danger"><strong>Otro dispositivo ha reclamado esta matrícula</strong>
      Has dejado de recibir mensajes. Si no has sido tú, recupérala. Si vuelve a pasar, la matrícula quedará en disputa.</div>
      <button data-action="reclaim">Recuperar matrícula</button>`;
  else status = `<div class="banner">Esta matrícula ya no está activa.</div><button data-action="reclaim">Volver a registrarla</button>`;
  return `
    <section class="card">
      <div class="between"><h2>Mi matrícula</h2><button class="link" data-action="release">Liberar</button></div>
      <div class="center">${plateBadge(p, 'big')}</div>
      ${status}
    </section>`;
}

function renderCompose() {
  return `
    <section class="card">
      <h2>Avisar a un coche</h2>
      <form data-action="compose">
        <button type="submit" disabled hidden aria-hidden="true"></button>
        <input name="plate" placeholder="Matrícula del otro coche" autocomplete="off" autocapitalize="characters" maxlength="12" required>
        <p class="muted small">El primer mensaje es siempre un aviso predefinido. Si el titular contesta, podréis escribir libremente.</p>
        <div class="presets">
          ${PRESETS.filter(x => !['thanks', 'onmyway'].includes(x.id)).map(x => `<button name="preset" value="${x.id}">${esc(x.es)}</button>`).join('')}
        </div>
      </form>
    </section>`;
}

function renderThreads() {
  const list = Object.values(store.threads).sort((a, b) => (b.updated || 0) - (a.updated || 0));
  if (!list.length) return '';
  return `
    <section class="card">
      <h2>Conversaciones</h2>
      <ul class="threads">
        ${list.map(t => {
          const last = t.messages[t.messages.length - 1];
          const who = t.role === 'sender'
            ? `Para ${plateBadge(t.plate, 'small')}`
            : `Conductor ${shortId(t.peer)} → ${plateBadge(t.plate, 'small')}`;
          return `<li><button class="thread" data-open="${esc(t.id)}">
            <span class="who">${who}${t.unread ? `<span class="dot">${t.unread}</span>` : ''}</span>
            <span class="last ${t.closed ? 'muted' : ''}">${t.closed ? 'Cerrada · ' : ''}${last ? (last.from === 'me' ? 'Tú: ' : '') + previewText(last) : ''}</span>
            <span class="time">${last ? fmtTime(last.at) : ''}</span>
          </button></li>`;
        }).join('')}
      </ul>
    </section>`;
}

function renderThread(t) {
  const canText = t.role === 'holder' || t.peerReplied;
  const quick = t.role === 'holder'
    ? PRESETS.filter(x => ['thanks', 'onmyway'].includes(x.id))
    : PRESETS.filter(x => x.id === 'thanks');
  const title = t.role === 'sender'
    ? `Para ${plateBadge(t.plate, 'small')}`
    : `Conductor ${shortId(t.peer)} <span class="muted small">a tu matrícula</span>`;
  return `
    <header class="thread-head">
      <div class="between">
        <button class="link" data-action="back">‹ Volver</button>
        <div class="thread-actions">
          <button class="link" data-action="export">Guardar copia</button>
          ${t.closed === 'blocked'
            ? '<button class="link" data-action="unblock">Desbloquear</button>'
            : t.closed ? '' : '<button class="link danger" data-action="block">Bloquear</button>'}
        </div>
      </div>
      <div>${title}</div>
    </header>
    <section class="messages">
      ${t.role === 'holder' && !t.meReplied ? `<p class="hint">Este conductor solo puede enviarte avisos predefinidos hasta que le contestes.</p>` : ''}
      ${t.messages.map(msgHtml).join('')}
      ${t.closed ? `<p class="hint danger">${esc(closedReason(t.closed))}</p>` : ''}
    </section>
    ${t.closed ? '' : `
    <footer class="composer">
      <div class="presets inline">${quick.map(x => `<button data-preset="${x.id}">${esc(x.es)}</button>`).join('')}</div>
      <form data-action="text" class="row">
        <input name="text" maxlength="${PARAMS.maxText}" autocomplete="off" ${canText ? 'placeholder="Escribe un mensaje…"' : 'disabled placeholder="Podrás escribir cuando conteste"'}>
        <button ${canText ? '' : 'disabled'}>Enviar</button>
      </form>
    </footer>`}`;
}

// ---------- Bloquear ----------

function blockThread(t) {
  if (!store.blocked.includes(t.peer)) store.blocked.push(t.peer);
  t.closed = 'blocked';
  save();
}

function unblockThread(t) {
  store.blocked = store.blocked.filter(k => k !== t.peer);
  if (t.closed === 'blocked') t.closed = null;
  save();
}

// ---------- Guardar la conversación como prueba ----------

function exportText(t) {
  const iso = s => new Date(s * 1000).toISOString();
  const who = m => (m.from === 'me' ? 'Yo' : t.role === 'holder' ? `Conductor ${shortId(t.peer)}` : `Titular de ${t.plate}`);
  const body = t.messages.map(m =>
    `[${iso(m.at)}] ${who(m)}: ${m.type === 'preset' ? `[aviso] ${presetText(m.preset)}` : m.text}\n    id del evento: ${m.id}`);
  return [
    'Matrícula Chat · copia de una conversación',
    `Generada: ${new Date().toISOString()}`,
    `Matrícula: ${t.plate}`,
    `Papel: ${t.role === 'holder' ? 'titular de la matrícula (receptor)' : 'remitente'}`,
    `Mi clave pública: ${t.myPub}`,
    `Clave pública del otro: ${t.peer}`,
    '',
    'Los mensajes se muestran sin censura. Cada mensaje es un evento firmado en la red Nostr;',
    'su id permite comprobar que existió en los relays mientras no haya caducado (72 h).',
    '',
    ...body,
    '',
  ].join('\n');
}

async function exportThread(t) {
  const name = `conversacion-${t.plate}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.txt`;
  const text = exportText(t);
  if (isNative) {
    const file = await Filesystem.writeFile({ path: name, data: text, directory: Directory.Cache, encoding: 'utf8' });
    try { await Share.share({ title: 'Conversación de Matrícula Chat', files: [file.uri] }); } catch (e) { if (!isCancel(e)) throw e; }
    return;
  }
  const a = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' })), download: name,
  });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  flash('Copia guardada');
}

// ---------- Aviso rápido (al escanear una pegatina) ----------

function renderQuick(plate) {
  return `
    <header class="thread-head"><button class="link" data-action="back">‹ Inicio</button></header>
    <section class="card quick">
      <p class="muted center">Vas a avisar al conductor de</p>
      <div class="center">${plateBadge(plate, 'big')}</div>
      <div class="presets">
        ${PRESETS.filter(x => !['thanks', 'onmyway'].includes(x.id)).map(x => `<button data-quick="${x.id}">${esc(x.es)}</button>`).join('')}
      </div>
      <p class="muted small center quick-foot">Sin registro. El conductor no sabrá quién eres. Si te contesta, podréis escribiros.</p>
    </section>`;
}

// ---------- Pegatinas QR ----------

const stickerOpts = { size: 70, copies: 6, showPlate: true };
// En la app nativa el QR apunta a la web pública; en la web, a donde se esté sirviendo.
const stickerUrl = plate => quickLink(isNative ? WEB_URL : location.href, plate);
const currentSticker = (plate, widthMm = stickerOpts.size) =>
  stickerSvg({ qrcode, url: stickerUrl(plate), plate, showPlate: stickerOpts.showPlate, widthMm });

function renderSticker(plate) {
  const opt = (v, cur, label = v) => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${label}</option>`;
  const preview = currentSticker(plate).replace(/width="[^"]+" height="[^"]+"/, 'class="sticker-svg" role="img" aria-label="Vista previa de la pegatina"');
  return `
    <header class="thread-head"><button class="link" data-action="back">‹ Volver</button><div><strong>Pegatina QR</strong></div></header>
    <section class="sticker-preview">${preview}</section>
    <section class="card">
      <form data-action="sticker-opts" class="opts">
        <label>Tamaño <select name="size">${opt(50, stickerOpts.size, '5 cm')}${opt(70, stickerOpts.size, '7 cm')}${opt(90, stickerOpts.size, '9 cm')}</select></label>
        ${isNative ? '' : `<label>Copias <select name="copies">${[1, 2, 4, 6, 9, 12].map(n => opt(n, stickerOpts.copies)).join('')}</select></label>`}
        <label class="check"><input type="checkbox" name="showPlate" ${stickerOpts.showPlate ? 'checked' : ''}> Mostrar la matrícula</label>
      </form>
      <div class="actions">
        ${isNative
          ? `<button data-action="sticker-share">Compartir imagen</button>
             <a class="btn secondary" href="${esc(WEB_URL)}#pegatina=${esc(plate)}" target="_blank" rel="noopener">Imprimir desde la web</a>`
          : `<button data-action="sticker-print">Imprimir</button>
             <button class="secondary" data-action="sticker-png">Descargar PNG</button>`}
        <button class="secondary" data-action="sticker-link">Compartir enlace</button>
      </div>
      <p class="muted small">Pégala en el cristal mirando hacia fuera. Quien la escanee podrá avisarte desde el navegador, sin instalar nada. El enlace solo contiene tu matrícula, que de todas formas se ve en el coche.</p>
    </section>`;
}

function printStickers(plate) {
  let sheet = document.getElementById('print-sheet');
  if (!sheet) {
    sheet = document.createElement('div');
    sheet.id = 'print-sheet';
    document.body.appendChild(sheet);
  }
  sheet.innerHTML = Array.from({ length: stickerOpts.copies }, () => currentSticker(plate)).join('');
  window.print();
}

async function stickerPng(plate) {
  const px = Math.round(stickerOpts.size / 25.4 * 300);  // 300 ppp
  const h = Math.round(px * 1.3);
  const svg = currentSticker(plate).replace(/width="[^"]+" height="[^"]+"/, `width="${px}" height="${h}"`);
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  await img.decode();
  const canvas = Object.assign(document.createElement('canvas'), { width: px, height: h });
  canvas.getContext('2d').drawImage(img, 0, 0, px, h);
  return new Promise((res, rej) => canvas.toBlob(b => (b ? res(b) : rej(new Error('No se pudo generar la imagen.'))), 'image/png'));
}

const blobToBase64 = blob => new Promise((res, rej) => {
  const r = new FileReader();
  r.onload = () => res(String(r.result).split(',')[1]);
  r.onerror = rej;
  r.readAsDataURL(blob);
});

const isCancel = e => /cancel/i.test(e?.message || '') || e?.name === 'AbortError';

async function shareStickerImage(plate) {
  setBusy('Generando imagen…');
  const blob = await stickerPng(plate);
  const file = await Filesystem.writeFile({
    path: `pegatina-${plate}.png`, data: await blobToBase64(blob), directory: Directory.Cache,
  });
  busy = ''; render();
  try { await Share.share({ title: 'Pegatina Matrícula Chat', files: [file.uri] }); } catch (e) { if (!isCancel(e)) throw e; }
}

async function downloadStickerPng(plate) {
  setBusy('Generando imagen…');
  const blob = await stickerPng(plate);
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `pegatina-${plate}.png` });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

async function shareStickerLink(plate) {
  const url = stickerUrl(plate);
  const title = 'Avísame por Matrícula Chat';
  try {
    if (isNative) return void await Share.share({ title, url });
    if (navigator.share) return void await navigator.share({ title, url });
  } catch (e) { if (isCancel(e)) return; }
  await navigator.clipboard.writeText(url);
  flash('Enlace copiado');
}

let notice = '';
function flash(msg) {
  notice = msg; render();
  setTimeout(() => { if (notice === msg) { notice = ''; render(); } }, 2500);
}

// ---------- Rutas por fragmento (#avisar=…, #pegatina=…) ----------

function applyHash() {
  const h = parseHash(location.hash);
  if (!h) return false;
  view = (h.action === 'avisar' ? 'quick:' : 'sticker:') + h.plate;
  error = '';
  return true;
}
window.addEventListener('hashchange', () => { if (applyHash()) render(); });

function goHome() {
  view = 'home'; error = '';
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
  render();
}

function render() {
  const t = view.startsWith('thread:') ? store.threads[view.slice(7)] : null;
  if (t && t.unread) { t.unread = 0; save(); }
  const focusedName = document.activeElement?.name;
  const keep = {};
  app.querySelectorAll('input').forEach(i => { if (i.name) keep[i.closest('form')?.dataset.action + i.name] = i.value; });

  const quickPlate = view.startsWith('quick:') ? view.slice(6) : null;
  const stickerPlate = view.startsWith('sticker:') ? view.slice(8) : null;
  app.innerHTML = `
    ${t ? renderThread(t) : quickPlate ? renderQuick(quickPlate) : stickerPlate ? renderSticker(stickerPlate) : `
      <header class="top">
        <h1>Matrícula Chat</h1>
        <p class="muted small">Sin servidor · cifrado de extremo a extremo · ${relays.length} ${relays.length === 1 ? 'relay público' : 'relays públicos'}</p>
      </header>
      ${renderMyPlate()}
      ${renderCompose()}
      ${renderThreads()}
      <footer class="foot">
        ${notifPerm === 'prompt' ? '<button class="link" data-action="notif">Activar notificaciones</button> · ' : ''}
        <button class="link" data-action="about">Cómo funciona</button>
      </footer>`}
    ${busy ? `<div class="toast">${esc(busy)}</div>` : ''}
    ${error ? `<div class="toast error" data-action="dismiss">${esc(error)}</div>` : ''}
    ${notice && !busy && !error ? `<div class="toast">${esc(notice)}</div>` : ''}`;

  app.querySelectorAll('input').forEach(i => {
    const k = i.closest('form')?.dataset.action + i.name;
    if (k in keep) i.value = keep[k];
    if (focusedName && i.name === focusedName) i.focus();
  });
  if (t) app.querySelector('.messages')?.scrollTo(0, 1e9);
  watchInbox();
  syncBackground();
}

app.addEventListener('submit', e => {
  e.preventDefault();
  const form = e.target;
  const action = form.dataset.action;
  const data = new FormData(form, e.submitter);
  if (action === 'claim') run(() => claimPlate(data.get('plate')));
  if (action === 'compose') {
    const preset = e.submitter?.value;
    if (!preset) { error = 'Elige un aviso.'; render(); return; }
    run(async () => { view = 'thread:' + await startConversation(data.get('plate'), preset); });
  }
  if (action === 'text') {
    const text = String(data.get('text') || '').trim();
    if (!text) return;
    run(async () => {
      await sendInThread(view.slice(7), { type: 'text', text });
      const live = app.querySelector('form[data-action=text] input');
      if (live) live.value = '';
    });
  }
});

app.addEventListener('click', e => {
  const el = e.target.closest('[data-action],[data-open],[data-preset],[data-quick],[data-reveal]');
  if (!el) return;
  if (el.dataset.open) { view = 'thread:' + el.dataset.open; error = ''; render(); return; }
  if (el.dataset.reveal) { revealed.add(el.dataset.reveal); render(); return; }
  if (el.dataset.quick) {
    const plate = view.slice(6), preset = el.dataset.quick;
    run(async () => {
      const id = await startConversation(plate, preset);
      if (location.hash) history.replaceState(null, '', location.pathname + location.search);
      view = 'thread:' + id;
    });
    return;
  }
  if (el.dataset.preset) { run(() => sendInThread(view.slice(7), { type: 'preset', preset: el.dataset.preset })); return; }
  switch (el.dataset.action) {
    case 'back': goHome(); break;
    case 'block': {
      const t = store.threads[view.slice(7)];
      if (t && confirm('¿Bloquear esta conversación? No recibirás más mensajes de esta persona.')) { blockThread(t); render(); }
      break;
    }
    case 'unblock': { const t = store.threads[view.slice(7)]; if (t) { unblockThread(t); render(); } break; }
    case 'export': { const t = store.threads[view.slice(7)]; if (t) run(() => exportThread(t)); break; }
    case 'sticker': view = 'sticker:' + store.plate.plate; error = ''; render(); window.scrollTo(0, 0); break;
    case 'sticker-print': printStickers(view.slice(8)); break;
    case 'sticker-png': run(() => downloadStickerPng(view.slice(8))); break;
    case 'sticker-share': run(() => shareStickerImage(view.slice(8))); break;
    case 'sticker-link': run(() => shareStickerLink(view.slice(8))); break;
    case 'dismiss': error = ''; render(); break;
    case 'reclaim': run(() => claimPlate(store.plate.plate)); break;
    case 'release':
      if (confirm('¿Liberar la matrícula? Dejarás de recibir mensajes en este dispositivo.')) run(() => releasePlate());
      break;
    case 'notif': requestNotifPerm().then(render); break;
    case 'about': $('#about').showModal(); break;
  }
});

app.addEventListener('change', e => {
  const form = e.target.closest('form[data-action=sticker-opts]');
  if (!form) return;
  stickerOpts.size = Number(form.size.value);
  if (form.copies) stickerOpts.copies = Number(form.copies.value);
  stickerOpts.showPlate = form.showPlate.checked;
  render();
});

// ---------- Arranque ----------

applyHash();
watchMyPlate();
render();
checkNotifPerm().then(render);
setInterval(() => { if (claimsReady) { recomputeMine(); render(); } markSeen(); }, 60_000);
markSeen();

// Para tests y depuración
window.__mc = { store, get mine() { return mine; }, relays };
