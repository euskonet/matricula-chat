// Moderación en el dispositivo. Los mensajes van cifrados de extremo a
// extremo y no hay servidor, así que todo se decide aquí:
//  - al ENVIAR: un mensaje con palabras prohibidas no sale del móvil;
//  - al RECIBIR: se censuran igualmente (por si el otro usa una app modificada)
//    y se detectan amenazas.
// Módulo puro y testeable (test/moderation.test.mjs).

// ---------- Listas ----------
// Se escriben en minúsculas y sin tildes. A cada palabra se le añaden
// automáticamente femenino y plural (ver variants()). Las entradas con
// espacios son frases que se buscan palabra a palabra.

// Insultos: se censuran y no se pueden enviar.
const INSULT = [
  'gilipollas', 'gilipolla', 'cabron', 'capullo', 'imbecil', 'idiota', 'estupido', 'cretino',
  'mamon', 'pringado', 'soplapollas', 'mierda', 'puto', 'hijoputa', 'hijueputa', 'hdp', 'malparido',
  'pendejo', 'cabronazo', 'gilipuertas', 'tontolaba', 'tontopollas', 'mongolo',
  // Fuera a propósito: 'anormal' ("algo anormal en tu coche"), 'tonto', 'joder', 'cono'.
  'hijo de puta', 'hija de puta', 'hijos de puta', 'hijas de puta', 'hijo puta',
  'me cago en tu madre', 'me cago en tus muertos', 'me cago en tu puta madre', 'tu puta madre',
  'concha de tu madre', 'la concha de tu madre', 'vete a la mierda', 'a tomar por culo',
];

// Graves: discriminatorios, sexuales o de acoso. Se censuran, el mensaje se
// oculta en destino hasta que se pulse "Ver", y no se pueden enviar.
const SEVERE = [
  // Fuera a propósito: 'perra' ("se te ha escapado la perra"), 'retrasado' ("voy retrasado").
  'puta', 'zorra', 'guarra', 'furcia', 'golfa', 'ramera',
  'maricon', 'marica', 'bollera', 'tortillera', 'travelo', 'mariconazo',
  'subnormal', 'mongolico', 'retrasado mental', 'retrasada mental',
  'sudaca', 'panchito', 'negrata', 'moro de mierda', 'gitano de mierda', 'negro de mierda',
  'polla', 'chupapollas', 'comepollas', 'chupamela', 'mamamela', 'follar', 'follarte', 'follarme',
  'te follo', 'te voy a follar', 'tetas', 'enseñame las tetas', 'putita', 'zorrita',
];

// Amenazas: no son palabras sueltas sino frases. Se buscan sobre el texto
// normalizado (sin tildes, leet traducido, palabras separadas por un espacio).
const THREATS = [
  /\b(te|os) (voy|vamos) a (matar|rajar|reventar|apunalar|pegar|partir la cara|romper las piernas|violar|quemar|encontrar|pillar)\b/,
  /\b(te|os) (mato|rajo|reviento|apunalo|violo|parto la cara|rompo las piernas|quemo)\b/,
  /\b(te|os) (voy|vamos) a (rayar|destrozar|quemar|romper|joder) el coche\b/,
  /\b(te|os) (voy|vamos) a (pinchar|rajar) las ruedas\b/,
  /\b(te|os) (rayo|destrozo|quemo|rompo) el coche\b/,
  /\b(te|os) (pincho|rajo) las ruedas\b/,
  /\b(se|sabemos|se muy bien|ya se) donde vives\b/,
  /\bte (estoy|estamos) (esperando|vigilando|siguiendo)\b/,
  /\bvas a (morir|pagarla|pagarlo|arrepentirte|acabar mal)\b/,
  /\b(te )?(encontrare|pillare|cogere)\b/,
  /\bcuidado con lo que haces\b/,
  /\bno sabes con quien (te )?(estas metiendo|hablas)\b/,
];

// ---------- Normalización ----------

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '€': 'e' };

function baseNormalize(s) {
  return s
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // quita tildes (y la virgulilla de la ñ)
    .replace(/[01345780@$€]/g, c => LEET[c] ?? c);
}
// Letras repetidas: se prueban las dos reducciones, porque algunas palabras
// tienen dobles legítimas ("polla", "gilipollas").
const collapse3 = s => s.replace(/(.)\1{2,}/g, '$1');      // "putaaaa" → "puta", "pollaaa" → "polla"
const collapse3to2 = s => s.replace(/(.)\1{2,}/g, '$1$1'); // "gilipolllas" → "gilipollas"
const collapseAll = s => s.replace(/(.)\1+/g, '$1');        // "puttaa" → "puta"

function variants(word) {
  const out = new Set([word, word + 's', word + 'es']);
  if (word.endsWith('o')) { const f = word.slice(0, -1) + 'a'; out.add(f); out.add(f + 's'); }
  if (/[^aeiou]$/.test(word)) { out.add(word + 'a'); out.add(word + 'as'); }
  return out;
}

function compile(list, level) {
  const words = new Map();      // forma exacta (tras collapse3) → nivel
  const loose = new Map();      // forma sin dobles (solo palabras sin letras dobles legítimas)
  const phrases = [];
  for (const raw of list) {
    const entry = baseNormalize(raw);
    if (entry.includes(' ')) { phrases.push({ tokens: entry.split(' '), level }); continue; }
    for (const v of variants(entry)) {
      words.set(v, level);
      if (collapseAll(v) === v) loose.set(v, level);
    }
  }
  return { words, loose, phrases };
}

const RANK = { clean: 0, insult: 1, severe: 2 };
const compiled = [compile(INSULT, 'insult'), compile(SEVERE, 'severe')];
const WORDS = new Map(), LOOSE = new Map(), PHRASES = [];
for (const c of compiled) {
  for (const [k, v] of c.words) if (!WORDS.has(k) || RANK[v] > RANK[WORDS.get(k)]) WORDS.set(k, v);
  for (const [k, v] of c.loose) if (!LOOSE.has(k) || RANK[v] > RANK[LOOSE.get(k)]) LOOSE.set(k, v);
  PHRASES.push(...c.phrases);
}
// Para comodines tipo "p*ta" o "gil1p*llas"
const ALL_WORDS = [...WORDS.keys()];

function lookupWord(norm) {
  if (!norm) return null;
  const c3 = collapse3(norm);
  if (WORDS.has(c3)) return WORDS.get(c3);
  const c32 = collapse3to2(norm);
  if (WORDS.has(c32)) return WORDS.get(c32);
  const ca = collapseAll(norm);
  if (LOOSE.has(ca)) return LOOSE.get(ca);
  if (norm.includes('*') && norm.replace(/\*/g, '').length >= 2) {
    const re = new RegExp('^' + c3.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.') + '$');
    let best = null;
    for (const w of ALL_WORDS) if (re.test(w) && (!best || RANK[WORDS.get(w)] > RANK[best])) best = WORDS.get(w);
    return best;
  }
  return null;
}

// ---------- Tokenización con posiciones ----------

function tokenize(text) {
  const tokens = [];
  for (const m of text.matchAll(/[\p{L}\p{N}@$€*]+/gu)) {
    const norm = baseNormalize(m[0]);
    if (/^\d+$/.test(m[0])) continue;                    // números puros: no son palabras
    tokens.push({ start: m.index, end: m.index + m[0].length, norm });
  }
  // Letras sueltas seguidas ("p u t a", "p.u.t.a") → una sola palabra
  const merged = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].norm.length === 1) {
      let j = i;
      while (j + 1 < tokens.length && tokens[j + 1].norm.length === 1 && tokens[j + 1].start - tokens[j].end <= 3) j++;
      if (j - i >= 2) {
        merged.push({ start: tokens[i].start, end: tokens[j].end, norm: tokens.slice(i, j + 1).map(t => t.norm).join('') });
        i = j;
        continue;
      }
    }
    merged.push(tokens[i]);
  }
  return merged;
}

// ---------- Análisis ----------

/**
 * @returns {{ level: 'clean'|'insult'|'severe', threat: boolean,
 *             spans: {start:number,end:number,level:string}[], masked: string }}
 */
export function analyze(text) {
  text = String(text ?? '');
  const tokens = tokenize(text);
  const spans = [];
  const add = (a, b, level) => spans.push({ start: tokens[a].start, end: tokens[b].end, level });

  for (let i = 0; i < tokens.length; i++) {
    // frases
    for (const ph of PHRASES) {
      const n = ph.tokens.length;
      if (i + n > tokens.length) continue;
      let ok = true;
      for (let k = 0; k < n && ok; k++) {
        const t = tokens[i + k].norm;
        ok = collapse3(t) === ph.tokens[k] || collapse3to2(t) === ph.tokens[k];
      }
      if (ok) add(i, i + n - 1, ph.level);
    }
    // palabra suelta
    const lvl = lookupWord(tokens[i].norm);
    if (lvl) { add(i, i, lvl); continue; }
    // palabra partida en dos ("gili pollas", "hijo puta")
    if (i + 1 < tokens.length) {
      const lvl2 = lookupWord(tokens[i].norm + tokens[i + 1].norm);
      if (lvl2) add(i, i + 1, lvl2);
    }
  }

  let level = 'clean';
  for (const s of spans) if (RANK[s.level] > RANK[level]) level = s.level;

  const normText = tokens.map(t => collapse3(t.norm)).join(' ');
  const threat = THREATS.some(re => re.test(normText));

  return { level, threat, spans, masked: mask(text, spans) };
}

/** Censura: deja la primera letra y cambia el resto por asteriscos. */
function mask(text, spans) {
  if (!spans.length) return text;
  const chars = [...text];
  // posiciones en code units → índices de chars (por si hay emojis)
  const idx = [];
  let u = 0;
  for (let i = 0; i < chars.length; i++) { idx.push(u); u += chars[i].length; }
  const hidden = new Set();
  for (const s of spans) {
    let first = true;
    for (let i = 0; i < chars.length; i++) {
      if (idx[i] < s.start || idx[i] >= s.end) continue;
      if (/\s/.test(chars[i])) continue;
      if (first) { first = false; continue; }
      hidden.add(i);
    }
  }
  return chars.map((c, i) => (hidden.has(i) ? '*' : c)).join('');
}

/** Para el remitente: ¿se puede enviar? Si no, devuelve el texto censurado para enseñarlo. */
export function checkOutgoing(text) {
  const a = analyze(text);
  return a.level === 'clean' ? { ok: true } : { ok: false, masked: a.masked, level: a.level };
}
