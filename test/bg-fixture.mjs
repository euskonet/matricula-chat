// Publica eventos de prueba en el relay local para el test JUnit de RelayChecker.
// Escribe en stdout un JSON con lo que el test debe esperar.
import { Relay } from 'nostr-tools/relay';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { minePow } from 'nostr-tools/nip13';
import { WebSocket } from 'ws';
import { useWebSocketImplementation } from 'nostr-tools/relay';
useWebSocketImplementation(WebSocket);

const url = process.env.RELAY_URL || 'ws://localhost:7777';
const relay = await Relay.connect(url);
const now = Math.floor(Date.now() / 1000);
const since = now - 600;

const me = generateSecretKey(), mePub = getPublicKey(me);
const thread = generateSecretKey(), threadPub = getPublicKey(thread);
const other = generateSecretKey();
const tag = 'f'.repeat(56) + Math.random().toString(16).slice(2, 10).padEnd(8, '0');

const msg = (to, t, sk = generateSecretKey()) => finalizeEvent({ kind: 7152, created_at: t, tags: [['p', to]], content: 'x' }, sk);
const blockedSk = generateSecretKey();
const claim = (sk, t, pow) => {
  const u = { kind: 7151, created_at: t, pubkey: getPublicKey(sk), tags: [['x', tag]], content: '{"action":"claim"}' };
  return finalizeEvent(pow ? minePow(u, 16) : u, sk);
};

const expectedMsgs = [msg(mePub, now - 60), msg(threadPub, now - 30)];
const ignored = [
  msg(getPublicKey(generateSecretKey()), now - 20), // para otra persona
  msg(mePub, since - 100),                          // anterior a "since"
  claim(me, now - 10, true),                        // reclamación mía
  claim(generateSecretKey(), now - 5, false),       // sin prueba de trabajo
  msg(mePub, now - 15, blockedSk),                  // de un remitente bloqueado
];
const foreign = claim(other, now - 40, true);
for (const ev of [...expectedMsgs, ...ignored, foreign]) await relay.publish(ev);
relay.close();

console.log(JSON.stringify({
  relay: url, since, tag, myPub: mePub, pubkeys: [mePub, threadPub], blocked: [getPublicKey(blockedSk)],
  expectedMessageIds: expectedMsgs.map(e => e.id), expectedForeignClaim: foreign.id,
}));
process.exit(0);
