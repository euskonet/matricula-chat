import {
  SimplePool, finalizeEvent, generateSecretKey, getPublicKey, nip44, minePow,
  scryptAsync, bytesToHex, hexToBytes, Capacitor, LocalNotifications, registerPlugin,
  qrcode, Share, Filesystem, Directory, sha256, jsQR,
} from './vendor.js';
import {
  KIND_CLAIM, KIND_MSG, PARAMS, PLATE_KDF, PRESETS, presetText,
  normalizePlate, isValidPlate, isModernSpanishPlate, resolveClaims, validateMessage,
  sendWait, inboundAllowed, bucketTag, proofInput, parseClaim, leadingZeroBits,
} from './protocol.js';
import { analyze, checkOutgoing } from './moderation.js';
import { WEB_URL, quickLink, parseHash, stickerSvg, qrPath, THEMES, HEADLINES } from './sticker.js';
import { SHOP, activePacks, orderRef, checkoutUrl } from './shop.js';
import { PRO, encodePairing, decodePairing, validateReply } from './pro.js';

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
// Plugin nativo propio (android/.../BillingPlugin.java): compras de Google Play.
const Billing = isNative && Capacitor.getPlatform() === 'android' ? registerPlugin('Billing') : null;
const now = () => Math.floor(Date.now() / 1000);

// ---------- Almacenamiento local (solo en este dispositivo) ----------

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY));
    if (s && typeof s === 'object') {
      const st = { plates: [], threads: {}, seen: [], blocked: [], replies: [], pro: false, ...s };
      if (s.plate && !s.plates) st.plates = [s.plate]; // formato con una sola matrícula
      delete st.plate;
      return st;
    }
  } catch {}
  return { plates: [], threads: {}, seen: [], blocked: [], replies: [], pro: false };
}
const store = load();
const seen = new Set(store.seen);
function save() {
  store.seen = [...seen].slice(-3000);
  try { localStorage.setItem(STORE_KEY, JSON.stringify(store)); } catch {}
}

// ---------- Criptografía ----------

const bucketOf = plate => bucketTag(sha256, plate);
const randomHex = n => bytesToHex(crypto.getRandomValues(new Uint8Array(n)));

// Prueba scrypt(matrícula, sal). En caché: varias reclamaciones del mismo
// dispositivo comparten sal y solo se calcula una vez.
const proofCache = new Map();
function proofFor(plate, salt) {
  const k = `${plate}|${salt}`;
  if (!proofCache.has(k)) {
    const { N, r, p, dkLen } = PLATE_KDF;
    proofCache.set(k, scryptAsync(...proofInput(plate, salt), { N, r, p, dkLen }).then(bytesToHex));
  }
  return proofCache.get(k);
}

// ¿Es esta reclamación de esta matrícula? Los filtros baratos van primero,
// para no gastar scrypt en eventos que el protocolo ignoraría igualmente.
const verdicts = new Map();
async function claimBelongs(plate, ev) {
  const k = `${plate}|${ev.id}`;
  if (verdicts.has(k)) return verdicts.get(k);
  const c = parseClaim(ev);
  const ok = !!c
    && ev.kind === KIND_CLAIM
    && ev.tags.some(t => t[0] === 'x' && t[1] === bucketOf(plate))
    && leadingZeroBits(ev.id) >= PARAMS.claimPow
    && ev.created_at <= now() + PARAMS.maxFutureSkew
    && (await proofFor(plate, c.s)) === c.p;
  verdicts.set(k, ok);
  return ok;
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

const latestOf = evs => evs.reduce((m, ev) => (ev.created_at <= now() + PARAMS.maxFutureSkew ? Math.max(m, ev.created_at) : m), 0);

async function resolvePlate(plate) {
  const tag = bucketOf(plate);
  const events = await fetchClaims(tag);
  const mineEvs = [];
  for (const ev of events) if (await claimBelongs(plate, ev)) mineEvs.push(ev); // en serie: scrypt usa 32 MB
  return { tag, latest: latestOf(mineEvs), ...resolveClaims(mineEvs, () => true, now()) };
}

// Fecha más reciente de las reclamaciones conocidas de una de mis matrículas.
const latestClaimAt = plate => latestOf([...(rt(plate)?.events.values() || [])]);

const tick = () => new Promise(r => setTimeout(r, 30));

async function publishClaim(action, { plate, sk: skHex, salt, proof }, after = latestClaimAt(plate)) {
  // Siempre posterior a la última reclamación conocida: si dos reclamaciones
  // cayeran en el mismo segundo, el desempate podría ordenarlas al revés.
  const unsigned = {
    kind: KIND_CLAIM, created_at: Math.max(now(), after + 1), pubkey: pubOf(skHex),
    tags: [['x', bucketOf(plate)]], content: JSON.stringify({ v: 2, action, s: salt, p: proof }),
  };
  await tick(); // deja que se pinte el "trabajando…"
  // keepCreatedAt: si no, minePow sustituye la fecha por "ahora" y se pierde el ajuste de arriba.
  const mined = minePow(unsigned, PARAMS.claimPow, { keepCreatedAt: true });
  const ev = finalizeEvent(mined, hexToBytes(skHex));
  await publish(ev);
  verdicts.set(`${plate}|${ev.id}`, true);
  rt(plate)?.events.set(ev.id, ev);
  return ev;
}

// Avisos a una matrícula sin titular (o en disputa): se comportan igual que
// los de una matrícula cuyo dueño no contesta, para que la app no sirva para
// averiguar qué matrículas están registradas.
async function sendPhantom(thread, payload) {
  assertCanSend();
  await new Promise(r => setTimeout(r, 300 + Math.random() * 500)); // como un envío real
  const at = now();
  thread.messages.push({ id: randomHex(32), from: 'me', ...payload, at });
  thread.updated = at;
  save();
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
  // Mis matrículas reciben su propio eco (para sincronizar dispositivos vinculados):
  // aquí ya lo tengo, así que se marca como visto antes de publicar.
  seen.add(ev.id);
  await publish(ev);
  if (!thread.messages.some(m => m.id === ev.id)) thread.messages.push({ id: ev.id, from: 'me', ...payload, at: ev.created_at });
  thread.updated = ev.created_at;
  save();
}

// ---------- Mis matrículas: reclamar, liberar, detectar expulsión ----------
// Cada matrícula tiene su propio estado (reclamaciones verificadas, suscripción,
// situación). Versión gratuita: 1 matrícula; Pro: hasta PRO.maxPlatesPro.

const plateRt = new Map(); // matrícula → { obj, events, ready, sub, mine, pending }
const rt = plate => plateRt.get(plate);
const findPlate = plate => store.plates.find(p => p.plate === plate);
const findPlateByPub = pub => store.plates.find(p => pubOf(p.sk) === pub);
const myPlatePubs = () => store.plates.map(p => pubOf(p.sk));
const isPro = () => store.pro === true;
const maxPlates = () => (isPro() ? PRO.maxPlatesPro : PRO.maxPlatesFree);
const plateStatus = plate => rt(plate)?.mine.status ?? 'none'; // none | active | lost | disputed | free
const allPlatesReady = () => store.plates.every(p => rt(p.plate)?.ready);

function recomputePlate(p) {
  const s = rt(p.plate);
  if (!s) return;
  const r = resolveClaims([...s.events.values()], () => true, now());
  const myPub = pubOf(p.sk);
  const prev = s.mine.status;
  if (r.status === 'held' && r.holder === myPub) s.mine = { ...r, status: 'active' };
  else if (r.status === 'disputed') s.mine = { ...r, status: 'disputed' };
  else if (r.status === 'held') s.mine = { ...r, status: 'lost' };
  else s.mine = { ...r, status: 'free' };

  if (prev === 'active' && s.mine.status !== 'active') {
    closeThreads(t => t.role === 'holder' && t.plate === p.plate, s.mine.status === 'disputed' ? 'disputed' : 'kicked');
    notify(s.mine.status === 'disputed'
      ? `La matrícula ${p.plate} está en disputa`
      : `Otro dispositivo ha reclamado ${p.plate}`,
    'Has dejado de recibir sus mensajes en este dispositivo.');
  }
  if (s.mine.status === 'active' && now() - s.mine.lastSeen > PARAMS.claimRefresh) {
    publishClaim('claim', p).then(() => recomputePlate(p)).catch(() => {});
  }
}
const recomputeAll = () => store.plates.forEach(recomputePlate);

// Matrículas registradas con el formato anterior: se les genera sal y prueba
// y, al terminar de cargar, se vuelven a reclamar con la misma clave.
async function upgradePlates() {
  for (const p of store.plates) {
    if (p.v === 2 && p.salt && p.proof) continue;
    p.salt = randomHex(16);
    p.proof = await proofFor(p.plate, p.salt);
    p.tag = bucketOf(p.plate);
    p.v = 2;
    p.migrate = true;
  }
  save();
}

function startPlate(p) {
  const s = { obj: p, events: new Map(), ready: false, sub: null, mine: { status: 'none' }, pending: [] };
  plateRt.set(p.plate, s);
  // Los eventos del cubo se verifican en serie (scrypt), en orden de llegada.
  let queue = Promise.resolve();
  const later = fn => { queue = queue.then(fn).catch(() => {}); };
  const alive = () => rt(p.plate) === s;
  s.sub = pool.subscribe(relays, { kinds: [KIND_CLAIM], '#x': [bucketOf(p.plate)] }, {
    onevent(ev) {
      later(async () => {
        if (!alive() || !(await claimBelongs(p.plate, ev))) return;
        s.events.set(ev.id, ev);
        if (s.ready) { recomputePlate(p); render(); }
      });
    },
    oneose() {
      later(async () => {
        if (s.ready || !alive()) return;
        if (p.migrate) {
          delete p.migrate; save();
          try { await publishClaim('claim', p); } catch {}
        }
        s.ready = true;
        recomputePlate(p);
        const queued = s.pending; s.pending = [];
        queued.forEach(handleMsg);
        render();
      });
    },
  });
}

function stopPlate(plate) {
  rt(plate)?.sub?.close();
  plateRt.delete(plate);
}

/** Arranca o para las suscripciones según store.plates. */
function watchPlates() {
  for (const plate of [...plateRt.keys()]) {
    const s = rt(plate);
    if (!store.plates.includes(s.obj)) stopPlate(plate);
  }
  for (const p of store.plates) if (!rt(p.plate)) startPlate(p);
  render();
}

function restartPlate(plate) { stopPlate(plate); watchPlates(); }

async function claimPlate(input) {
  const plate = normalizePlate(input);
  if (!isValidPlate(plate)) throw new Error('Matrícula no válida.');
  const existing = findPlate(plate);
  if (!existing && store.plates.length >= maxPlates()) {
    throw new Error(isPro()
      ? `Puedes tener hasta ${PRO.maxPlatesPro} matrículas.`
      : 'Con la versión gratuita puedes registrar una matrícula. Hazte Pro para añadir más.');
  }
  setBusy('Comprobando matrícula…');
  const r = await resolvePlate(plate);
  if (r.status === 'disputed') {
    throw new Error(`Esta matrícula está en disputa hasta ${fmtDate(r.frozenUntil)}. Inténtalo después.`);
  }
  // Misma matrícula: reutiliza clave y sal (también si viene de otro dispositivo vinculado).
  const sk = existing?.salt ? existing.sk : bytesToHex(generateSecretKey());
  const salt = existing?.salt || randomHex(16);
  setBusy('Generando prueba de trabajo…');
  const proof = await proofFor(plate, salt);
  const obj = { plate, tag: r.tag, sk, salt, proof, v: 2 };
  if (existing) Object.assign(existing, obj); else store.plates.push(obj);
  save();
  await publishClaim('claim', existing || obj, r.latest);
  restartPlate(plate);
}

async function releasePlate(p) {
  if (!p) return;
  if (plateStatus(p.plate) === 'active') {
    setBusy('Liberando…');
    try { await publishClaim('release', p); } catch {}
  }
  closeThreads(t => t.role === 'holder' && t.plate === p.plate, 'released');
  store.plates = store.plates.filter(x => x !== p);
  save();
  watchPlates();
}

/** Añade una matrícula desde el código de vinculación de otro dispositivo. */
async function linkPlate(pairing) {
  if (findPlate(pairing.plate)) throw new Error('Esa matrícula ya está en este dispositivo.');
  if (store.plates.length >= maxPlates()) {
    throw new Error(isPro()
      ? `Puedes tener hasta ${PRO.maxPlatesPro} matrículas.`
      : 'Con la versión gratuita puedes tener una matrícula. Libera la actual o hazte Pro.');
  }
  // Misma clave que el otro dispositivo: para el protocolo son el mismo titular,
  // así que no hace falta publicar ninguna reclamación nueva.
  setBusy('Vinculando…');
  const proof = await proofFor(pairing.plate, pairing.salt);
  store.plates.push({ plate: pairing.plate, tag: bucketOf(pairing.plate), sk: pairing.sk, salt: pairing.salt, proof, v: 2, linked: true });
  save();
  watchPlates();
}

function closeThreads(pred, reason) {
  for (const t of Object.values(store.threads)) if (pred(t) && !t.closed) t.closed = reason;
  save();
}

// ---------- Mensajes ----------

let msgSub = null;
let msgSubKeys = '';

function myInboxKeys() {
  const keys = myPlatePubs();
  for (const t of Object.values(store.threads)) if (t.role === 'sender' && !t.closed) keys.push(t.myPub);
  return [...new Set(keys)].sort();
}

// Dos suscripciones: lo que me envían (#p) y lo que envían mis matrículas desde
// otro dispositivo vinculado (authors), para ver sus respuestas aquí también.
let ownSub = null;
let ownSubKeys = '';

function watchInbox() {
  const keys = myInboxKeys();
  const sig = keys.join(',');
  if (sig !== msgSubKeys) {
    msgSubKeys = sig;
    msgSub?.close();
    msgSub = null;
    if (keys.length) {
      msgSub = pool.subscribe(relays, { kinds: [KIND_MSG], '#p': keys, since: now() - PARAMS.msgTtl }, { onevent: handleMsg });
    }
  }
  const own = myPlatePubs().sort();
  const ownSig = own.join(',');
  if (ownSig !== ownSubKeys) {
    ownSubKeys = ownSig;
    ownSub?.close();
    ownSub = null;
    if (own.length) {
      ownSub = pool.subscribe(relays, { kinds: [KIND_MSG], authors: own, since: now() - PARAMS.msgTtl }, { onevent: handleMsg });
    }
  }
}

function handleMsg(ev) {
  if (seen.has(ev.id)) return;
  const p = ev.tags.find(t => t[0] === 'p')?.[1];
  if (ev.created_at > now() + PARAMS.maxFutureSkew) return;
  const peerTimes = t => (t ? t.messages.filter(m => m.from === 'peer').map(m => m.at) : []);

  // 0) Lo que ha contestado una de mis matrículas (desde este u otro dispositivo vinculado)
  const author = findPlateByPub(ev.pubkey);
  if (author) {
    seen.add(ev.id);
    const s = rt(author.plate);
    if (!s?.ready || s.mine.status !== 'active' || !p || store.blocked.includes(p)) { save(); return; }
    const msg = validateMessage(decryptFrom(author.sk, p, ev.content), { allowText: true });
    if (!msg) { save(); return; }
    const id = 'in:' + p;
    let t = store.threads[id];
    if (t?.closed) { save(); return; }
    if (!t) {
      t = store.threads[id] = {
        id, role: 'holder', plate: author.plate, sk: author.sk, myPub: ev.pubkey, peer: p, messages: [], created: ev.created_at,
      };
    }
    if (!t.messages.some(m => m.id === ev.id)) {
      t.messages.push({ id: ev.id, from: 'me', ...msg, at: ev.created_at });
      t.messages.sort((a, b) => a.at - b.at);
      t.updated = Math.max(t.updated || 0, ev.created_at);
    }
    t.meReplied = true;
    save();
    render();
    return;
  }

  if (store.blocked.includes(ev.pubkey)) { seen.add(ev.id); save(); return; }

  // 1) Mensaje para una de mis matrículas
  const target = findPlateByPub(p);
  if (target) {
    const s = rt(target.plate);
    if (!s?.ready) { s?.pending.push(ev); return; }
    seen.add(ev.id);
    if (s.mine.status !== 'active') { save(); return; } // ya no soy el titular
    const id = 'in:' + ev.pubkey;
    let t = store.threads[id];
    if (t?.closed) { save(); return; }
    const starts = Object.values(store.threads).filter(x => x.role === 'holder' && x.plate === target.plate).map(x => x.created);
    if (!inboundAllowed({ times: peerTimes(t), t: ev.created_at, replied: !!t?.meReplied, newThread: !t, threadStarts: starts })) {
      save(); return; // demasiados mensajes: se descarta
    }
    const msg = validateMessage(decryptFrom(target.sk, ev.pubkey, ev.content), {
      allowText: !!t?.meReplied,
    });
    if (!msg) { save(); return; } // texto libre antes de contestar, o basura: se descarta
    if (!t) {
      t = store.threads[id] = {
        id, role: 'holder', plate: target.plate, sk: target.sk,
        myPub: p, peer: ev.pubkey, messages: [], created: ev.created_at,
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
  if (findPlate(plate)) throw new Error('Es tu propia matrícula.');
  setBusy('Buscando matrícula…');
  const r = await resolvePlate(plate);
  if (myPlatePubs().includes(r.holder)) throw new Error('Es tu propia matrícula.');
  // Una clave efímera nueva por conversación: el remitente es anónimo y
  // sus conversaciones no se pueden relacionar entre sí.
  const sk = bytesToHex(generateSecretKey());
  const id = 'out:' + pubOf(sk);
  const t = store.threads[id] = {
    id, role: 'sender', plate, tag: r.tag, sk, myPub: pubOf(sk), peer: r.status === 'held' ? r.holder : null,
    messages: [], created: now(),
  };
  setBusy('Enviando…');
  try {
    if (t.peer) await sendRaw(t, { type: 'preset', preset: presetId });
    else await sendPhantom(t, { type: 'preset', preset: presetId });
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
    if (!t.peer) {
      // Conversación con una matrícula sin titular: si ahora lo tiene, se le empieza a entregar.
      if (r.status === 'held' && !myPlatePubs().includes(r.holder)) { t.peer = r.holder; save(); }
    } else if (r.status !== 'held' || r.holder !== t.peer) {
      t.closed = r.status === 'disputed' ? 'disputed' : 'changed';
      save();
      throw new Error(closedReason(t.closed));
    }
    if (!t.peer) { await sendPhantom(t, payload); return; }
  } else {
    const mineP = store.plates.find(p => p.sk === t.sk);
    if (!mineP || plateStatus(mineP.plate) !== 'active') {
      t.closed = 'kicked'; save();
      throw new Error(closedReason('kicked'));
    }
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
  if (!BackgroundCheck || !allPlatesReady()) return;
  const active = store.plates.filter(p => plateStatus(p.plate) === 'active');
  const pubkeys = Object.values(store.threads)
    .filter(t => t.role === 'sender' && !t.closed).map(t => t.myPub);
  pubkeys.push(...active.map(p => pubOf(p.sk)));
  const cfg = {
    pubkeys: [...new Set(pubkeys)].sort(),
    relays,
    blocked: [...store.blocked].sort(),
    plates: active.map(p => ({ tag: bucketOf(p.plate), plate: p.plate, myPub: pubOf(p.sk) })),
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
    rekeyed: 'Cambiaste la clave de la matrícula. Esta conversación se ha cerrado.',
  }[r] || 'Conversación cerrada.';
}

function setBusy(msg) { busy = msg; error = ''; render(); }

async function run(fn) {
  try { await fn(); error = ''; } catch (e) { error = e?.message || String(e); }
  busy = '';
  render();
}

function plateCard(p, single) {
  const s = rt(p.plate);
  const m = s?.mine || { status: 'none' };
  const attr = `data-plate="${esc(p.plate)}"`;
  let status;
  if (!s?.ready) status = `<p class="status">Comprobando estado…</p>`;
  else if (m.status === 'active') status = `<p class="status ok">● Recibiendo mensajes desde ${fmtDate(m.since)}</p>
      <div class="actions plate-actions">
        <button class="secondary" data-action="sticker" ${attr}>Pegatina QR</button>
        <button class="secondary" data-action="pair" ${attr}>Vincular dispositivo${isPro() ? '' : ' · Pro'}</button>
      </div>`;
  else if (m.status === 'disputed') status = `
      <div class="banner warn"><strong>Matrícula en disputa</strong>
      Ha cambiado de dispositivo demasiadas veces en 24 h. Nadie recibe mensajes hasta ${fmtDate(m.frozenUntil)}.</div>`;
  else if (m.status === 'lost') status = `
      <div class="banner danger"><strong>Otro dispositivo ha reclamado esta matrícula</strong>
      Has dejado de recibir mensajes. Si no has sido tú, recupérala. Si vuelve a pasar, la matrícula quedará en disputa.</div>
      <button data-action="reclaim" ${attr}>Recuperar matrícula</button>`;
  else status = `<div class="banner">Esta matrícula ya no está activa.</div><button data-action="reclaim" ${attr}>Volver a registrarla</button>`;
  return `
    <section class="card plate-card">
      <div class="between">
        <h2>${single ? 'Mi matrícula' : ''}${p.linked ? ' <span class="pill">Vinculada</span>' : ''}</h2>
        <button class="link" data-action="release" ${attr}>Liberar</button>
      </div>
      <div class="center">${plateBadge(p.plate, 'big')}</div>
      ${status}
    </section>`;
}

function renderMyPlates() {
  const linkBtn = '<button class="link small-link" data-action="link">¿Ya la tienes en otro móvil? Vincular este dispositivo</button>';
  if (!store.plates.length) {
    return `
      <section class="card">
        <h2>Mi matrícula</h2>
        <p class="muted">Regístrala para que otros conductores puedan avisarte. No pedimos nombre, teléfono ni email.</p>
        <form data-action="claim" class="row">
          <input name="plate" placeholder="1234 BCD" autocomplete="off" autocapitalize="characters" maxlength="12" required>
          <button>Registrar</button>
        </form>
        ${linkBtn}
      </section>`;
  }
  const single = store.plates.length === 1;
  const cards = store.plates.map(p => plateCard(p, single)).join('');
  let add = '';
  if (store.plates.length < maxPlates()) {
    add = `
      <section class="card">
        <h2>Añadir otra matrícula</h2>
        <form data-action="claim" class="row">
          <input name="plate" placeholder="5678 FGH" autocomplete="off" autocapitalize="characters" maxlength="12" required>
          <button>Añadir</button>
        </form>
        ${linkBtn}
      </section>`;
  } else if (!isPro()) {
    add = '<button class="secondary wide upsell" data-action="pro">＋ Añadir otra matrícula · Pro</button>';
  }
  return (single ? '' : '<h2 class="section-title">Mis matrículas</h2>') + cards + add;
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
      <div class="presets inline">${quick.map(x => `<button data-preset="${x.id}">${esc(x.es)}</button>`).join('')}${
        isPro() && canText ? store.replies.map((r, i) => `<button class="mine" data-reply="${i}">${esc(r)}</button>`).join('') : ''}</div>
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

const stickerOpts = { size: 70, copies: 6, showPlate: true, theme: 'a', headline: '0', fromOrder: false };
// Diseño efectivo: los de pago solo con Pro (o al abrir un pedido ya pagado).
const stickerDesign = () => (isPro() || stickerOpts.fromOrder ? { theme: stickerOpts.theme, headline: stickerOpts.headline } : { theme: 'a', headline: '0' });
// En la app nativa el QR apunta a la web pública; en la web, a donde se esté sirviendo.
const stickerUrl = plate => quickLink(isNative ? WEB_URL : location.href, plate);
const currentSticker = (plate, widthMm = stickerOpts.size) =>
  stickerSvg({ qrcode, url: stickerUrl(plate), plate, showPlate: stickerOpts.showPlate, widthMm, ...stickerDesign() });

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
        <label>Color <select name="theme" ${isPro() || stickerOpts.fromOrder ? '' : 'disabled'}>${THEMES.map(x => opt(x.id, stickerDesign().theme, x.name)).join('')}</select></label>
        <label>Frase <select name="headline" ${isPro() || stickerOpts.fromOrder ? '' : 'disabled'}>${HEADLINES.map(x => opt(x.id, stickerDesign().headline, esc(x.lines.join(' ')))).join('')}</select></label>
        ${isPro() || stickerOpts.fromOrder ? '' : '<button type="button" class="link small-link" data-action="pro">Más colores y frases con Pro</button>'}
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
    </section>
    ${renderShop(plate)}`;
}

// ---------- Encargar pegatinas ----------

let orderPack = null;

function renderShop(plate) {
  const packs = activePacks();
  if (!packs.length) return '';
  const pack = packs.find(p => p.id === orderPack);
  if (pack) {
    const d = stickerDesign();
    const href = checkoutUrl(pack, orderRef(plate, stickerOpts.size, stickerOpts.showPlate, d.theme, d.headline));
    return `
      <section class="card shop">
        <h2>Confirmar pedido</h2>
        <dl class="summary">
          <dt>Pegatinas</dt><dd>${pack.units} de vinilo, ${stickerOpts.size / 10} cm</dd>
          <dt>Matrícula impresa</dt><dd>${stickerOpts.showPlate ? 'Sí' : 'No'}</dd>
          <dt>Precio</dt><dd>${esc(pack.price)} · ${esc(SHOP.shipping)}</dd>
        </dl>
        <p class="muted small">El pago y la dirección de envío se gestionan en Stripe. Solo usamos esos datos para enviarte el pedido.</p>
        <div class="actions">
          <a class="btn" href="${esc(href)}" target="_blank" rel="noopener" data-action="order-go">Ir a pagar</a>
          <button class="secondary" data-action="order-cancel">Cancelar</button>
        </div>
      </section>`;
  }
  return `
    <section class="card shop">
      <h2>Pegatinas de vinilo</h2>
      <p class="muted small">Resistentes al sol y a la lluvia, con este mismo diseño. Te las enviamos a casa.</p>
      <div class="packs">
        ${packs.map(p => `<button class="pack" data-order="${esc(p.id)}"><strong>${p.units} pegatinas</strong><span>${esc(p.price)}</span></button>`).join('')}
      </div>
      <p class="muted small">${esc(SHOP.shipping)}</p>
    </section>`;
}

// ---------- Vincular un segundo dispositivo ----------

function qrSvg(text, px = 220) {
  const { d, size } = qrPath(qrcode, text);
  const q = 2;
  return `<svg class="qr" xmlns="http://www.w3.org/2000/svg" viewBox="${-q} ${-q} ${size + 2 * q} ${size + 2 * q}" width="${px}" height="${px}" role="img" aria-label="Código QR"><rect x="${-q}" y="${-q}" width="${size + 2 * q}" height="${size + 2 * q}" fill="#fff"/><path d="${d}" fill="#000" shape-rendering="crispEdges"/></svg>`;
}

let pairShown = false;

function renderPair(plate) {
  const p = findPlate(plate);
  const head = `<header class="thread-head"><button class="link" data-action="back">‹ Volver</button><div><strong>Vincular dispositivo</strong> ${p ? plateBadge(p.plate, 'small') : ''}</div></header>`;
  if (!p) return head + '<p class="hint">Esa matrícula ya no está en este dispositivo.</p>';
  if (!isPro()) return head + renderProCard('Vincular otro dispositivo es una función Pro.');
  const code = encodePairing(p);
  return `${head}
    <section class="card">
      <p>Comparte esta matrícula con otro móvil (por ejemplo, el de tu pareja) para que los avisos os lleguen a los dos.</p>
      <ol class="steps">
        <li>En el otro móvil, abre Matrícula Chat y pulsa <strong>«Vincular este dispositivo»</strong>.</li>
        <li>Escanea este código o pega el texto.</li>
      </ol>
      <div class="banner warn"><strong>Solo para tus dispositivos</strong>
        Este código da acceso completo a los avisos de la matrícula: no lo compartas con nadie más.</div>
      ${pairShown
        ? `<div class="center pair-qr">${qrSvg(code)}</div>
           <div class="actions"><button class="secondary" data-action="pair-copy" data-code="${esc(code)}">Copiar código</button>
           <button class="secondary" data-action="pair-hide">Ocultar</button></div>`
        : '<button class="wide" data-action="pair-show">Mostrar código</button>'}
    </section>
    <section class="card">
      <h2>¿Has perdido el otro dispositivo?</h2>
      <p class="muted small">Cambia la clave de la matrícula: los dispositivos vinculados dejarán de recibir avisos y las conversaciones abiertas se cerrarán.</p>
      <button class="secondary danger-text" data-action="rekey" data-plate="${esc(p.plate)}">Cambiar clave</button>
    </section>`;
}

function renderLink() {
  return `
    <header class="thread-head"><button class="link" data-action="back">‹ Volver</button><div><strong>Vincular este dispositivo</strong></div></header>
    <section class="card">
      <p>En el móvil que ya tiene la matrícula, entra en <strong>Vincular dispositivo</strong> y pulsa «Mostrar código». Después escanéalo aquí o pega el texto.</p>
      ${navigator.mediaDevices?.getUserMedia ? '<button class="wide" data-action="scan">Escanear con la cámara</button>' : ''}
      <form data-action="link-code" class="link-form">
        <textarea name="code" rows="3" placeholder="MCV1.…" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>
        <button>Vincular</button>
      </form>
    </section>`;
}

async function rekeyPlate(p) {
  const old = p.sk;
  setBusy('Cambiando la clave…');
  const r = await resolvePlate(p.plate);
  p.sk = bytesToHex(generateSecretKey());
  p.salt = randomHex(16);
  p.proof = await proofFor(p.plate, p.salt);
  delete p.linked;
  save();
  await publishClaim('claim', p, r.latest);
  closeThreads(t => t.role === 'holder' && t.sk === old, 'rekeyed');
  restartPlate(p.plate);
  flash('Clave cambiada');
}

// Escáner QR con la cámara: va en una capa propia, fuera de #app, para que los
// repintados de la interfaz no lo interrumpan.
let scanStop = null;
async function startScan() {
  const layer = document.createElement('div');
  layer.className = 'scan-layer';
  layer.innerHTML = '<video playsinline muted></video><p>Apunta al código QR</p><button class="secondary">Cancelar</button>';
  document.body.appendChild(layer);
  const video = layer.querySelector('video');
  let stream, raf, done = false;
  const stop = () => { done = true; cancelAnimationFrame(raf); stream?.getTracks().forEach(t => t.stop()); layer.remove(); scanStop = null; };
  scanStop = stop;
  layer.querySelector('button').onclick = stop;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch {
    stop();
    throw new Error('No se ha podido abrir la cámara. Pega el código en su lugar.');
  }
  video.srcObject = stream;
  await video.play();
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  await new Promise((resolve, reject) => {
    const tick = () => {
      if (done) return resolve();
      if (video.readyState >= 2) {
        canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        const qr = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
        const pairing = qr && decodePairing(qr.data);
        if (pairing) {
          stop();
          linkPlate(pairing).then(() => { goHome(); flash(`Matrícula ${pairing.plate} vinculada`); resolve(); }, reject);
          return;
        }
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
  });
}

// ---------- Pro ----------

let products = {}; // id → { id, price, title }

async function syncPurchases() {
  if (!Billing) return;
  try {
    const { owned } = await Billing.restore();
    const pro = owned.includes(PRO.productId);
    if (store.pro !== pro) { store.pro = pro; save(); render(); }
  } catch {} // sin conexión con Google Play: se mantiene lo que había
}

async function loadProducts() {
  if (!Billing) return;
  try {
    const { products: list } = await Billing.getProducts({ ids: [PRO.productId] });
    products = Object.fromEntries(list.map(x => [x.id, x]));
    render();
  } catch {}
}

async function buy(productId) {
  if (!Billing) throw new Error('La compra está disponible en la app de Android.');
  setBusy('Abriendo Google Play…');
  const r = await Billing.purchase({ productId });
  busy = '';
  if (r.state === 'purchased') {
    store.pro = true; save(); flash('¡Ya tienes Pro!');
  } else if (r.state === 'pending') {
    flash('Pago pendiente: se activará cuando Google Play lo confirme.');
  }
}

function renderProCard(intro = '') {
  const price = products[PRO.productId]?.price;
  return `
    <section class="card pro-card">
      <h2>Matrícula Chat Pro</h2>
      ${intro ? `<p>${esc(intro)}</p>` : ''}
      <ul class="pro-list">
        <li><strong>Hasta ${PRO.maxPlatesPro} matrículas</strong> en el mismo móvil: coche, moto, el de la familia…</li>
        <li><strong>Vincular otro dispositivo</strong> para que los avisos os lleguen a los dos.</li>
        <li><strong>Tus propias respuestas rápidas.</strong></li>
        <li><strong>Más colores y frases</strong> para tus pegatinas.</li>
      </ul>
      ${isPro()
        ? '<p class="status ok">✓ Ya tienes Pro. ¡Gracias por apoyar el proyecto!</p>'
        : Billing
          ? `<button class="wide" data-action="buy" data-product="${PRO.productId}">Hazte Pro${price ? ` · ${esc(price)}` : ''}</button>
             <p class="muted small center">Pago único. <button class="link small-link" data-action="restore">Restaurar compra</button></p>`
          : '<p class="muted small">Disponible en la app de Android.</p>'}
    </section>`;
}

function renderPro() {
  const head = '<header class="thread-head"><button class="link" data-action="back">‹ Volver</button><div><strong>Pro</strong></div></header>';
  const replies = isPro() ? `
    <section class="card">
      <h2>Respuestas rápidas</h2>
      <p class="muted small">Aparecen como botones en tus conversaciones cuando puedes escribir libremente.</p>
      <ul class="reply-list">
        ${store.replies.map((r, i) => `<li><span>${esc(r)}</span><button class="link danger" data-action="reply-del" data-index="${i}" aria-label="Borrar">Borrar</button></li>`).join('') || '<li class="muted small">Todavía no tienes ninguna.</li>'}
      </ul>
      ${store.replies.length < PRO.maxReplies ? `
        <form data-action="reply-add" class="row">
          <input name="reply" maxlength="${PRO.maxReplyLength}" placeholder="Ej.: Llego en 5 minutos" autocomplete="off">
          <button>Añadir</button>
        </form>` : ''}
    </section>` : '';
  return head + renderProCard() + replies;
}

function renderThanks() {
  return `
    <header class="thread-head"><button class="link" data-action="back">‹ Inicio</button></header>
    <section class="card thanks">
      <h2>¡Gracias por tu pedido!</h2>
      <p>Recibirás un email de confirmación del pago. Preparamos tus pegatinas y te las enviamos en unos días.</p>
      <p class="muted small">Si tienes cualquier duda, escríbenos a la dirección que aparece en ese email.</p>
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
  orderPack = null;
  if (h.action === 'gracias') view = 'thanks';
  else if (h.action === 'avisar') view = 'quick:' + h.plate;
  else {
    stickerOpts.fromOrder = h.action === 'pedido';
    if (h.action === 'pedido') Object.assign(stickerOpts, { size: h.size, showPlate: h.showPlate, theme: h.theme, headline: h.headline });
    view = 'sticker:' + h.plate;
  }
  error = '';
  return true;
}
window.addEventListener('hashchange', () => { if (applyHash()) render(); });

function goHome() {
  scanStop?.();
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
    ${t ? renderThread(t) : quickPlate ? renderQuick(quickPlate) : stickerPlate ? renderSticker(stickerPlate)
      : view === 'thanks' ? renderThanks() : view === 'pro' ? renderPro() : view === 'link' ? renderLink()
      : view.startsWith('pair:') ? renderPair(view.slice(5)) : `
      <header class="top">
        <h1>Matrícula Chat</h1>
        <p class="muted small">Sin servidor · cifrado de extremo a extremo · ${relays.length} ${relays.length === 1 ? 'relay público' : 'relays públicos'}</p>
      </header>
      ${renderMyPlates()}
      ${renderCompose()}
      ${renderThreads()}
      <footer class="foot">
        ${notifPerm === 'prompt' ? '<button class="link" data-action="notif">Activar notificaciones</button> · ' : ''}
        <button class="link" data-action="pro">${isPro() ? 'Pro ✓' : 'Hazte Pro'}</button> ·
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
  if (action === 'claim') {
    run(async () => {
      await claimPlate(data.get('plate'));
      app.querySelectorAll('form[data-action=claim] input').forEach(i => { i.value = ''; });
    });
  }
  if (action === 'link-code') {
    const pairing = decodePairing(data.get('code'));
    if (!pairing) { error = 'El código no es válido. Cópialo entero desde el otro dispositivo.'; render(); return; }
    run(async () => { await linkPlate(pairing); goHome(); flash(`Matrícula ${pairing.plate} vinculada`); });
  }
  if (action === 'reply-add') {
    const v = validateReply(data.get('reply'), store.replies);
    if (!v.ok) { error = v.error; render(); return; }
    store.replies.push(v.text); save();
    const live = app.querySelector('form[data-action=reply-add] input');
    if (live) live.value = '';
    render();
  }
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
  const el = e.target.closest('[data-action],[data-open],[data-preset],[data-quick],[data-reveal],[data-order],[data-reply]');
  if (!el) return;
  if (el.dataset.open) { view = 'thread:' + el.dataset.open; error = ''; render(); return; }
  if (el.dataset.reply) {
    const text = store.replies[Number(el.dataset.reply)];
    if (text) run(() => sendInThread(view.slice(7), { type: 'text', text }));
    return;
  }
  if (el.dataset.order) {
    orderPack = el.dataset.order; render();
    app.querySelector('.shop')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return;
  }
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
    case 'back': orderPack = null; goHome(); break;
    case 'order-cancel': orderPack = null; render(); break;
    case 'order-go': setTimeout(() => { orderPack = null; render(); }, 800); break; // el enlace se abre solo
    case 'block': {
      const t = store.threads[view.slice(7)];
      if (t && confirm('¿Bloquear esta conversación? No recibirás más mensajes de esta persona.')) { blockThread(t); render(); }
      break;
    }
    case 'unblock': { const t = store.threads[view.slice(7)]; if (t) { unblockThread(t); render(); } break; }
    case 'export': { const t = store.threads[view.slice(7)]; if (t) run(() => exportThread(t)); break; }
    case 'sticker': stickerOpts.fromOrder = false; view = 'sticker:' + el.dataset.plate; error = ''; render(); window.scrollTo(0, 0); break;
    case 'pair': pairShown = false; view = 'pair:' + el.dataset.plate; error = ''; render(); window.scrollTo(0, 0); break;
    case 'pair-show': pairShown = true; render(); break;
    case 'pair-hide': pairShown = false; render(); break;
    case 'pair-copy': run(async () => { await navigator.clipboard.writeText(el.dataset.code); flash('Código copiado'); }); break;
    case 'rekey': {
      const p = findPlate(el.dataset.plate);
      if (p && confirm('¿Cambiar la clave? Los demás dispositivos dejarán de recibir avisos de esta matrícula.')) run(() => rekeyPlate(p));
      break;
    }
    case 'link': view = 'link'; error = ''; render(); window.scrollTo(0, 0); break;
    case 'scan': run(startScan); break;
    case 'pro': view = 'pro'; error = ''; render(); window.scrollTo(0, 0); loadProducts(); break;
    case 'buy': run(() => buy(el.dataset.product)); break;
    case 'restore': run(async () => { await syncPurchases(); flash(isPro() ? 'Compra restaurada' : 'No hay compras que restaurar'); }); break;
    case 'reply-del': store.replies.splice(Number(el.dataset.index), 1); save(); render(); break;
    case 'sticker-print': printStickers(view.slice(8)); break;
    case 'sticker-png': run(() => downloadStickerPng(view.slice(8))); break;
    case 'sticker-share': run(() => shareStickerImage(view.slice(8))); break;
    case 'sticker-link': run(() => shareStickerLink(view.slice(8))); break;
    case 'dismiss': error = ''; render(); break;
    case 'reclaim': run(() => claimPlate(el.dataset.plate)); break;
    case 'release':
      if (confirm('¿Liberar la matrícula? Dejarás de recibir sus mensajes en este dispositivo.')) run(() => releasePlate(findPlate(el.dataset.plate)));
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
  if (!form.theme.disabled) stickerOpts.theme = form.theme.value;
  if (!form.headline.disabled) stickerOpts.headline = form.headline.value;
  render();
});

// ---------- Arranque ----------

applyHash();
render();
upgradePlates().catch(() => {}).finally(watchPlates);
syncPurchases();
Billing?.addListener('purchasesUpdated', () => syncPurchases());
checkNotifPerm().then(render);
setInterval(() => { recomputeAll(); render(); markSeen(); }, 60_000);
markSeen();

// Para tests y depuración
window.__mc = { store, relays, plateStatus };
