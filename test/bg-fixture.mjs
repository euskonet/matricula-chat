// Publica eventos de prueba (protocolo v2) en el relay local para los tests
// JUnit de RelayChecker y Scrypt. Escribe en stdout lo que el test debe esperar.
import { Relay, useWebSocketImplementation } from 'nostr-tools/relay';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { minePow } from 'nostr-tools/nip13';
import { sha256 } from '@noble/hashes/sha2.js';
import { scrypt } from '@noble/hashes/scrypt.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { WebSocket } from 'ws';
import { bucketTag, proofInput, PLATE_KDF } from '../src/protocol.js';
useWebSocketImplementation(WebSocket);

const url = process.env.RELAY_URL || 'ws://localhost:7777';
const relay = await Relay.connect(url);
const now = Math.floor(Date.now() / 1000);
const since = now - 600;

// 1003BCD y 1016BCD comparten cubo
const PLATE = '1003BCD', NEIGHBOUR = '1016BCD';
const tag = bucketTag(sha256, PLATE);
const { N, r, p, dkLen } = PLATE_KDF;
const proof = (plate, s) => bytesToHex(scrypt(...proofInput(plate, s), { N, r, p, dkLen }));
const salt = () => bytesToHex(generateSecretKey()).slice(0, 32);

const me = generateSecretKey(), mePub = getPublicKey(me);
const thread = generateSecretKey(), threadPub = getPublicKey(thread);
const blockedSk = generateSecretKey();

const msg = (to, t, sk = generateSecretKey()) => finalizeEvent({ kind: 7152, created_at: t, tags: [['p', to]], content: 'x' }, sk);
const claim = (sk, t, plate, { pow = true, s = salt(), action = 'claim' } = {}) => {
  const u = { kind: 7151, created_at: t, pubkey: getPublicKey(sk), tags: [['x', tag]],
    content: JSON.stringify({ v: 2, action, s, p: proof(plate, s) }) };
  return finalizeEvent(pow ? minePow(u, 16, { keepCreatedAt: true }) : u, sk);
};

const expectedMsgs = [msg(mePub, now - 60), msg(threadPub, now - 30)];
const foreign = claim(generateSecretKey(), now - 40, PLATE);           // otra clave, MI matrícula
const ignored = [
  msg(getPublicKey(generateSecretKey()), now - 20),                     // para otra persona
  msg(mePub, since - 100),                                              // anterior a "since"
  msg(mePub, now - 15, blockedSk),                                      // remitente bloqueado
  claim(me, now - 10, PLATE),                                           // reclamación mía
  claim(generateSecretKey(), now - 5, PLATE, { pow: false }),           // sin prueba de trabajo
  claim(generateSecretKey(), now - 3, NEIGHBOUR),                       // mismo cubo, OTRA matrícula (más reciente)
];
for (const ev of [...expectedMsgs, ...ignored, foreign]) await relay.publish(ev);
relay.close();

const vs = 'ab'.repeat(16);
console.log(JSON.stringify({
  relay: url, since, tag, plate: PLATE, myPub: mePub, pubkeys: [mePub, threadPub], blocked: [getPublicKey(blockedSk)],
  expectedMessageIds: expectedMsgs.map(e => e.id), expectedForeignClaim: foreign.id,
  scryptVector: { plate: PLATE, salt: vs, proof: proof(PLATE, vs) },
}));
process.exit(0);
