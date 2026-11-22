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

export { GameRoom, Matchmaker } from './game.js';
export { Profiles } from './profiles.js';

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, GET, OPTIONS', 'access-control-allow-headers': 'content-type', 'cache-control': 'no-store' };

// 🔒 Only the real game page may play online or touch accounts. A copy of the game on any other site
// (or opened from a file / a link to an altered page) is turned away here, before it reaches a game.
const ALLOWED = new Set(['https://buckets19.github.io']);
const okOrigin = (req, env) => { const o = req.headers.get('Origin') || ''; return ALLOWED.has(o) || (env && env.DEV === '1' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o)); };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/ping') return new Response('ok', { headers: CORS });
    if ((url.pathname.startsWith('/api/') || url.pathname.startsWith('/g/') || url.pathname === '/mm' || url.pathname.startsWith('/room/')) && req.method !== 'OPTIONS' && !okOrigin(req, env))
      return new Response('unofficial copy of the game', { status: 403, headers: CORS });
    // accounts: unique names + cloud saves (one Durable Object holds them all)
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
      if (url.pathname.startsWith('/api/rk/')) { const res = await env.PROFILES.get(env.PROFILES.idFromName('global')).fetch(req); const h = new Headers(res.headers); for (const k in CORS) h.set(k, CORS[k]); return new Response(res.body, { status: res.status, headers: h }); }
      const stub = env.ACCOUNTS.get(env.ACCOUNTS.idFromName('global'));
      const res = await stub.fetch(req);
      const h = new Headers(res.headers); for (const k in CORS) h.set(k, CORS[k]);
      return new Response(res.body, { status: res.status, headers: h });
    }
    // 🏟️ server-run games + matchmaking
    const g = url.pathname.match(/^\/g\/([A-Za-z0-9]{1,16})$/);
    if (g) return env.GAMES.get(env.GAMES.idFromName(g[1].toUpperCase())).fetch(req);
    if (url.pathname === '/mm') return env.MM.get(env.MM.idFromName('mm')).fetch(req);
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

// ---------------------------------------------------------------- ACCOUNTS
// One global Durable Object. Each device has a secret account code (only its SHA-256 is stored here).
//   names: "n:<name>" -> owner id        (one name per account; changing your name frees the old one)
//   saves: "s:<owner id>" -> {save, t}   (cloud backup of the whole save file)
const okKey = k => typeof k === 'string' && /^[A-Z0-9-]{12,40}$/.test(k);
const normName = n => String(n || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16);
async function sha(s) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('bk19acct|' + s)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join(''); }
const J = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });

export class Accounts {
  constructor(state) { this.state = state; this.st = state.storage; }
  async fetch(req) {
    if (req.method !== 'POST') return J({ error: 'post only' }, 405);
    const path = new URL(req.url).pathname;
    let b; try { b = await req.json(); } catch (e) { return J({ error: 'bad json' }, 400); }
    if (!b || !okKey(b.key)) return J({ error: 'bad key' }, 400);
    const id = await sha(b.key);

    if (path === '/api/name/claim' || path === '/api/name/check') {
      const n = normName(b.name);
      if (n.length < 2) return J({ ok: false, error: 'short' });
      const owner = await this.st.get('n:' + n);
      if (owner && owner !== id) return J({ ok: false, taken: true });
      if (path === '/api/name/check') return J({ ok: true, mine: owner === id });
      const old = await this.st.get('k:' + id + ':name');
      if (old && old !== n) await this.st.delete('n:' + old);
      await this.st.put({ ['n:' + n]: id, ['k:' + id + ':name']: n });
      return J({ ok: true });
    }
    if (path === '/api/save/put') {
      const s = JSON.stringify(b.save || null);
      if (s.length > 120000) return J({ error: 'too big' }, 413);
      const t = Date.now();
      await this.st.put('s:' + id, { save: b.save, t });
      return J({ ok: true, t });
    }
    if (path === '/api/save/get') {
      const v = await this.st.get('s:' + id);
      const name = await this.st.get('k:' + id + ':name');
      return J({ ok: true, save: v ? v.save : null, t: v ? v.t : 0, name: name || null });
    }
    return J({ error: 'unknown' }, 404);
  }
}
