// Buckets game server (Cloudflare Worker + Durable Object).
// One Durable Object per room code. The host's browser still runs the game; this just passes
// messages between the host and the players instantly over normal secure websockets (port 443),
// which school Wi-Fi allows. No public relays, no throttling.
//
// Wire format (text frames):
//   host  -> server : "<to>|<json>"   to = player id, or "*" for everyone
//   server-> host   : "<from>|<json>"
//   player<-> server: "<json>"
// Server-only notices: {"t":"_hosthere"} {"t":"_nohost"} {"t":"_hostgone"} {"t":"_taken"} {"t":"_left"}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/ping') return new Response('ok', { headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' } });
    const m = url.pathname.match(/^\/room\/([A-Za-z0-9_.-]{1,48})$/);
    if (!m) return new Response('buckets game server', { status: 200 });
    if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return new Response('websocket only', { status: 426 });
    const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1]));
    return stub.fetch(req);
  },
};

export class Room {
  constructor(state) { this.state = state; }

  async fetch(req) {
    const url = new URL(req.url);
    const role = url.searchParams.get('role') === 'host' ? 'host' : 'c';
    const id = (url.searchParams.get('id') || '').replace(/[^a-z0-9]/gi, '').slice(0, 16) || Math.random().toString(36).slice(2, 10);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const hosts = this.state.getWebSockets('host');

    if (role === 'host') {
      // the same host reconnecting after a Wi-Fi blip (same key) takes its room back; anyone else is turned away
      const key = (url.searchParams.get('key') || '').slice(0, 32);
      const mine = hosts.filter(h => (h.deserializeAttachment() || {}).key === key && key);
      const other = hosts.filter(h => !mine.includes(h));
      if (other.length) {
        this.state.acceptWebSocket(server, ['reject']); server.serializeAttachment({ role: 'reject' });
        server.send('{"t":"_taken"}'); server.close(4001, 'taken');
      } else {
        for (const h of mine) { try { h.serializeAttachment({ role: 'old' }); h.close(4004, 'replaced'); } catch (e) {} }
        this.state.acceptWebSocket(server, ['host']);
        server.serializeAttachment({ role: 'host', id: 'host', key });
        server.send('{"t":"_ok"}');
        // players who were waiting on a dropped host: it's back
        for (const w of this.state.getWebSockets('c')) { try { w.send('{"t":"_hostback"}'); } catch (e) {} }
      }
    } else {
      this.state.acceptWebSocket(server, ['c', 'c:' + id]);
      server.serializeAttachment({ role: 'c', id });
      if (hosts.length) server.send('{"t":"_hosthere"}');
      else { server.send('{"t":"_nohost"}'); server.close(4002, 'no host'); }
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, msg) {
    if (typeof msg !== 'string' || msg.length > 64000) return;
    if (msg === 'ping|') { try { ws.send('{"t":"_pong"}'); } catch (e) {} return; }   // liveness check for the host
    const a = ws.deserializeAttachment() || {};
    if (a.role === 'host') {
      const i = msg.indexOf('|'); if (i < 1) return;
      const to = msg.slice(0, i), body = msg.slice(i + 1);
      const targets = to === '*' ? this.state.getWebSockets('c') : this.state.getWebSockets('c:' + to);
      for (const w of targets) { try { w.send(body); } catch (e) {} }
    } else if (a.role === 'c') {
      for (const h of this.state.getWebSockets('host')) { try { h.send(a.id + '|' + msg); } catch (e) {} }
    }
  }

  // finish the close handshake so the other end gets its close event right away
  webSocketClose(ws) { try { ws.close(1000, 'bye'); } catch (e) {} this.gone(ws); }
  webSocketError(ws) { this.gone(ws); }

  gone(ws) {
    const a = ws.deserializeAttachment() || {};
    if (a.role === 'host') {
      // only tell players if no other host connection is still alive
      if (this.state.getWebSockets('host').some(h => h !== ws && h.readyState === 1)) return;
      // don't close anyone: the host may just be reconnecting after a Wi-Fi blip. Players wait (15s) for _hostback.
      // A host that really leaves sends "bye" to everyone first, which ends the game for them right away.
      for (const w of this.state.getWebSockets('c')) { try { w.send('{"t":"_hostgone"}'); } catch (e) {} }
    } else if (a.role === 'c') {
      for (const h of this.state.getWebSockets('host')) { try { h.send(a.id + '|{"t":"_left"}'); } catch (e) {} }
    }
  }
}
