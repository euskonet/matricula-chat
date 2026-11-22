// Relay Nostr mínimo en memoria, SOLO para pruebas locales.
// En producción la app usa relays públicos de terceros.
import { WebSocketServer } from 'ws';
import { matchFilter } from 'nostr-tools/filter';
import { verifyEvent } from 'nostr-tools/pure';

const port = Number(process.env.PORT || 7777);
const wss = new WebSocketServer({ port });
const events = [];
const subs = new Map(); // ws -> Map(subId -> filters)

wss.on('connection', ws => {
  subs.set(ws, new Map());
  ws.on('close', () => subs.delete(ws));
  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const [type, ...rest] = msg;
    if (type === 'EVENT') {
      const ev = rest[0];
      if (!verifyEvent(ev)) return ws.send(JSON.stringify(['OK', ev.id, false, 'invalid: bad signature']));
      if (!events.some(e => e.id === ev.id)) {
        events.push(ev);
        for (const [client, m] of subs) for (const [id, filters] of m)
          if (filters.some(f => matchFilter(f, ev))) client.send(JSON.stringify(['EVENT', id, ev]));
      }
      ws.send(JSON.stringify(['OK', ev.id, true, '']));
    } else if (type === 'REQ') {
      const [id, ...filters] = rest;
      subs.get(ws).set(id, filters);
      for (const ev of events) if (filters.some(f => matchFilter(f, ev))) ws.send(JSON.stringify(['EVENT', id, ev]));
      ws.send(JSON.stringify(['EOSE', id]));
    } else if (type === 'CLOSE') {
      subs.get(ws)?.delete(rest[0]);
    }
  });
});
console.log(`relay de pruebas en ws://localhost:${port}`);
