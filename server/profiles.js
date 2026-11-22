// 🏆 Server-owned ranked profiles. The game server decides every ranked result (a player's iPad can't
// give itself RR), and the leaderboard is built from here (nobody can post a fake row).
//   p:<id>   -> { n, rr, g, w, st, b, sn, pk, card, t }       id = hash of the player's secret token
//   k:<pk>   -> id                                            one leaderboard identity per player
const FB = 'https://buckets-37d04-default-rtdb.firebaseio.com';
const SEASON_START = Date.UTC(2026, 10, 18), SEASON_LEN = 14 * 86400000;
const seasonN = () => Math.max(1, Math.floor((Date.now() - SEASON_START) / SEASON_LEN) + 1);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v)), lerp = (a, b, k) => a + (b - a) * k;
const J = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const okTok = t => typeof t === 'string' && /^[0-9a-f]{32,64}$/.test(t);
async function sha(s) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('bk19rank|' + s)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 32); }
const cleanN = n => String(n || 'Player').replace(/[^\p{L}\p{N} _.'-]/gu, '').trim().slice(0, 12) || 'Player';
// the same rating math the game always used: even gains/losses, a little more for beating better players
export function rrDelta(win, myRR, oppRR, margin, streak, perf) {
  const exp = 1 / (1 + Math.pow(10, (oppRR - myRR) / 400)), adj = Math.round(16 * (0.5 - exp));
  let d = win ? 25 + adj : -(25 - adj);
  if (win) { d += Math.min(4, Math.max(0, margin - 2)); d += Math.min(4, streak); } else if (margin <= 2) d += 3;
  d += perf;
  const k = lerp(1, 0.6, clamp(myRR / 4200, 0, 1));
  return win ? clamp(Math.round(d * k), 14, 45) : clamp(Math.round(d * k), -36, -10);
}
export class Profiles {
  constructor(state) { this.st = state.storage; this.lb = null; this.lbAt = 0; this.ev = null; this.evAt = 0; }
  season(p) { const n = seasonN(); if (!p.sn) p.sn = n; if (p.sn < n) { p.rr = Math.round(p.rr * 0.7); p.st = 0; p.sn = n; } return p; }
  async event() { if (Date.now() - this.evAt > 60000) { this.evAt = Date.now(); try { const r = await fetch(FB + '/cfg/event.json'); this.ev = r.ok ? await r.json() : null; } catch (e) {} } const e = this.ev; return e && e.id && +e.end > Date.now() ? e : null; }
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/api/rk/lb') {   // the leaderboard: top 200
      if (!this.lb || Date.now() - this.lbAt > 20000) {
        const all = await this.st.list({ prefix: 'p:' }), rows = [];
        for (const [, p] of all) { this.season(p); if ((p.g | 0) >= 1 && !p.hide) rows.push({ pk: p.pk || '', n: p.n, rr: p.rr, g: p.g, w: p.w, b: p.b, t: p.t, card: p.card || null }); }
        rows.sort((a, b) => b.rr - a.rr || b.g - a.g); this.lb = rows.slice(0, 200); this.lbAt = Date.now();
      }
      return J({ ok: true, rows: this.lb });
    }
    if (req.method !== 'POST') return J({ error: 'post only' }, 405);
    let b; try { b = await req.json(); } catch (e) { return J({ error: 'bad json' }, 400); }
    // ---- a player checks in: create (one-time import, capped) or return their server profile
    if (path === '/api/rk/me') {
      if (!okTok(b.tok)) return J({ error: 'bad token' }, 400);
      const id = await sha(b.tok); let p = await this.st.get('p:' + id), dirty = false;
      if (!p) {
        const c = b.claim || {}, g = clamp(c.g | 0, 0, 3000);
        p = { n: cleanN(b.name), rr: clamp(Math.round(+c.rr || 0), 0, g >= 25 ? 2600 : g >= 5 ? 1500 : 600), g, w: clamp(c.w | 0, 0, g), st: 0, b: 0, sn: seasonN(), t: Date.now() };
        p.b = Math.max(p.rr, clamp(Math.round(+c.b || 0), 0, p.rr + 300)); dirty = true;
      }
      this.season(p);
      if (typeof b.pk === 'string' && /^[0-9a-f]{64}$/.test(b.pk) && p.pk !== b.pk) { const owner = await this.st.get('k:' + b.pk); if (!owner || owner === id) { p.pk = b.pk; await this.st.put('k:' + b.pk, id); dirty = true; } }
      if (b.name && cleanN(b.name) !== p.n) { p.n = cleanN(b.name); dirty = true; }
      if (b.card && typeof b.card === 'object') { const s = JSON.stringify(b.card); if (s.length < 4000) { p.card = b.card; dirty = true; } }
      if (dirty) await this.st.put('p:' + id, p);
      return J({ ok: true, rr: p.rr, g: p.g, w: p.w, st: p.st, b: p.b, sn: p.sn });
    }
    // ---- admin: set someone's RR (the code's fingerprint is checked by Google, same as every admin change)
    if (path === '/api/rk/admin') {
      if (typeof b.akey !== 'string' || !/^[0-9a-f]{64}$/.test(b.akey)) return J({ error: 'no' }, 403);
      const ok = await fetch(FB + '/akey.json', { method: 'PATCH', body: JSON.stringify({ [b.akey]: { '.sv': 'timestamp' } }) }).then(r => r.ok).catch(() => false);
      if (!ok) return J({ error: 'no' }, 403);
      const id = typeof b.pk === 'string' ? await this.st.get('k:' + b.pk) : null; if (!id) return J({ error: 'player not found' }, 404);
      const p = await this.st.get('p:' + id); if (!p) return J({ error: 'player not found' }, 404);
      if (b.rr !== undefined) { p.rr = clamp(Math.round(+b.rr || 0), 0, 9999); p.b = Math.max(p.b, p.rr); }
      if (b.hide !== undefined) p.hide = !!b.hide;
      if (b.reset) { p.rr = 0; p.g = 0; p.w = 0; p.st = 0; p.b = 0; }
      await this.st.put('p:' + id, p); this.lb = null; return J({ ok: true, rr: p.rr });
    }
    // ---- internal (game server only; not reachable from outside): look up / record ranked results
    if (path === '/rk/get') {
      const out = {}; for (const t of (b.toks || []).slice(0, 8)) if (okTok(t)) { const p = await this.st.get('p:' + await sha(t)); if (p) out[t] = this.season(p).rr; }
      return J({ ok: true, rr: out });
    }
    if (path === '/rk/res') {
      const ev = await this.event(), out = {};
      for (const x of (b.list || []).slice(0, 8)) {
        if (!okTok(x.tok)) continue; const id = await sha(x.tok); let p = await this.st.get('p:' + id);
        if (!p) { const c = clamp(Math.round(+x.claim || 0), 0, 1500); p = { n: cleanN(x.name), rr: c, g: 0, w: 0, st: 0, b: c, sn: seasonN(), t: Date.now() }; }   // never checked in yet: start from their (capped) rank
        this.season(p);
        let d = rrDelta(!!x.win, p.rr, clamp(+x.opp || 0, 0, 9999), clamp(x.margin | 0, 0, 50), p.st, clamp(x.perf | 0, -2, 6));
        if (x.win && ev && ev.kind === 'rr2') d *= 2;
        p.rr = Math.max(0, p.rr + d); p.g++; if (x.win) { p.w++; p.st++; } else p.st = 0; p.b = Math.max(p.b, p.rr); p.t = Date.now();
        if (x.name) p.n = cleanN(x.name);
        await this.st.put('p:' + id, p); out[x.tok] = { d, rr: p.rr, g: p.g, w: p.w, st: p.st, b: p.b };
      }
      this.lb = null; return J({ ok: true, res: out });
    }
    return J({ error: 'unknown' }, 404);
  }
}
