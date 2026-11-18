// 🏟️ Buckets game server: the SERVER runs every online game (not a player's iPad).
// Every iPad is just a player: one trip to the server and back, the same for red and blue.
// The rules/physics/bots are the game's own code (sim.js is built from index.html by build.mjs).
//
// GameRoom (one per room code):  /g/<CODE>   messages are the same ones a host iPad used to send,
//   so the game on the iPads barely changes: welcome, roster, s (snapshot), ev, pong, migrate...
// Matchmaker (one for everyone):  /mm        ranked 1v1 queue, 2v2 queue, team-up duo search.
import { makeSim } from './sim.js';
const S = makeSim();
const TICK_MS = 1000 / 30;                 // 30 updates a second to every player
const GRACE_MS = 15000;                    // a player whose Wi-Fi drops keeps their spot this long
const NO_GEAR = new Set(['t','name','pk','duo','r2','q','exp','create','party','rr','id','rejoin','c']);
const rid = n => { const A = 'abcdefghjkmnpqrstuvwxyz23456789'; let s = ''; for (let i = 0; i < n; i++) s += A[Math.floor(Math.random() * A.length)]; return s; };

export class GameRoom {
  constructor(state, env) { this.state = state; this.env = env; this.reset(); }
  reset() {
    this.G = { phase: 'lobby', players: new Map(), toWin: 11, diff: 'pro', winBy2: false, ranked: false, ranked2: false, party: false, srch: false };
    this.socks = new Map();      // id -> { ws, away }
    this.owner = null; this.RM = null; this.q = null; this.code = ''; this.emAt = new Map();
    if (this.loop) clearInterval(this.loop); this.loop = null;
    if (this.qTimer) clearTimeout(this.qTimer); this.qTimer = null;
  }
  async fetch(req) {
    if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return new Response('websocket only', { status: 426 });
    this.code = decodeURIComponent(new URL(req.url).pathname.split('/').pop() || '').slice(0, 16);
    const [client, ws] = Object.values(new WebSocketPair());
    ws.accept();
    let id = null;
    ws.addEventListener('message', ev => {
      let d; try { d = JSON.parse(ev.data); } catch (e) { return; }
      if (!d || typeof d !== 'object') return;
      try { if (!id) id = this.hello(ws, d); else this.onMsg(id, d, ws); } catch (e) { console.log('room error', e && e.stack); }
    });
    const gone = () => { if (id) this.lost(id, ws); };
    ws.addEventListener('close', gone); ws.addEventListener('error', gone);
    return new Response(null, { status: 101, webSocket: client });
  }

  // ---------------------------------------------------------------- helpers
  humans(team) { let n = 0; for (const p of this.G.players.values()) if (!p.bot && (team === undefined || p.team === team)) n++; return n; }
  count(team) { let n = 0; for (const p of this.G.players.values()) if (p.team === team) n++; return n; }
  send(ws, o) { try { ws.send(JSON.stringify(o)); } catch (e) {} }
  to(id, o) { const s = this.socks.get(id); if (s && !s.away) this.send(s.ws, o); }
  all(o) { const str = JSON.stringify(o); for (const s of this.socks.values()) if (!s.away) { try { s.ws.send(str); } catch (e) {} } }
  roster() {
    const G = this.G;
    return { t: 'roster', code: this.code, phase: G.phase, toWin: G.toWin, diff: G.diff, winBy2: !!G.winBy2, ranked: !!G.ranked, ranked2: !!G.ranked2,
      party: !!G.party, srch: !!G.srch, owner: this.owner, players: [...G.players.values()] };
  }
  pushRoster() { this.all(this.roster()); }
  newNum() { const used = new Set([...this.G.players.values()].map(p => p.num)); let n; do { n = 1 + Math.floor(Math.random() * 45); } while (used.has(n)); return n; }
  addPlayer(id, name, bot, team) {
    if (team === undefined) team = this.count(0) <= this.count(1) ? 0 : 1;
    const r = { id, name: S.cleanName(name), team, bot: !!bot, num: this.newNum() };
    this.G.players.set(id, r); return r;
  }
  setGear(r, d) { for (const k in d) if (!NO_GEAR.has(k) && /^[a-z][a-zA-Z0-9]{0,11}$/.test(k) && typeof d[k] === 'string' && d[k].length <= 64) r[k] = d[k]; }
  addBot(team) {
    if (this.count(team) >= S.MAX_PER_TEAM) return;
    const used = new Set([...this.G.players.values()].map(p => p.name)); const nm = S.BOT_NAMES.find(n => !used.has(S.cleanName(n + ' 🤖'))) || 'Bot';
    this.addPlayer('bot-' + rid(6), nm + ' 🤖', true, team);
  }
  addRival(R, team) { const b = this.addPlayer('rv-' + R.k, R.n, true, team); b.rv = R.k; b.rr = S.rivalRR(R); b.num = R.num; return b; }
  // fill empty spots with Ranked Rivals near a rating
  fillRivals(near) {
    const used = new Set([...this.G.players.keys()]);
    const pool = S.RIVALS.filter(R => !used.has('rv-' + R.k)).map(R => ({ R, rr: S.rivalRR(R) })).sort((a, b) => Math.abs(a.rr - near) - Math.abs(b.rr - near)).slice(0, 6);
    for (const t of [0, 1]) while (this.count(t) < 2 && pool.length) { const o = pool.splice(Math.floor(Math.random() * pool.length), 1)[0]; this.addRival(o.R, t); }
  }
  clearBots() { for (const [id, r] of [...this.G.players]) if (r.bot) this.G.players.delete(id); }

  // ---------------------------------------------------------------- joining
  hello(ws, d) {
    let G = this.G;
    if (d.t !== 'hello') { ws.close(1000); return null; }
    const empty = this.humans() === 0;
    // coming back after a Wi-Fi drop: same id, same spot
    if (d.rejoin && typeof d.id === 'string' && G.players.has(d.id) && !G.players.get(d.id).bot) {
      const old = this.socks.get(d.id); if (old && old.ws !== ws) { try { old.ws.close(1000); } catch (e) {} }
      this.socks.set(d.id, { ws, away: 0 }); this.send(ws, { t: 'welcome', id: d.id, re: 1 }); this.send(ws, this.roster()); return d.id;
    }
    if (empty && !d.create && !d.q) { this.send(ws, { t: 'none' }); ws.close(1000); return null; }       // no such room here
    if (!empty && d.create) { this.send(ws, { t: 'taken' }); ws.close(1000); return null; }               // code already in use
    if (empty) { const code = this.code; this.reset(); this.code = code; G = this.G; if (d.create) G.party = !!d.party; if (d.q) this.q = { mode: d.q === '2v2' ? '2v2' : '1v1', exp: Math.max(2, Math.min(4, +d.exp || 2)), t0: Date.now() }; }
    // who may join
    if ((d.duo || d.r2) && !(G.party && G.phase === 'lobby' && this.humans(1) < 2)) { this.send(ws, { t: 'busy' }); ws.close(1000); return null; }
    if (G.players.size >= S.MAX_PER_TEAM * 2) {
      const bot = [...G.players.values()].find(p => p.bot);
      if (bot && G.phase === 'lobby') G.players.delete(bot.id); else { this.send(ws, { t: 'full' }); ws.close(1000); return null; }
    }
    let id = typeof d.id === 'string' && /^[a-z0-9]{6,16}$/.test(d.id) && !G.players.has(d.id) ? d.id : 'u' + rid(9);
    let team;
    if (d.duo || d.r2) team = this.count(1) < S.MAX_PER_TEAM ? 1 : 0;
    else if (G.party) team = this.count(0) < 2 ? 0 : 1;
    const r = this.addPlayer(id, d.name, false, team);
    this.setGear(r, d); r.rr = Math.max(0, Math.min(9999, Math.round(+d.rr || 0))); if (typeof d.pk === 'string' && d.pk) r.pk = d.pk.slice(0, 80);
    this.socks.set(id, { ws, away: 0 });
    if (!this.owner || !G.players.has(this.owner)) this.owner = id;
    this.send(ws, { t: 'welcome', id });
    this.pushRoster();
    this.afterJoin();
    return id;
  }
  afterJoin() {
    const G = this.G;
    // team-up room: the other side has 2 real players (a duo, or solo queuers) -> ranked 2v2 starts
    if (G.party && G.phase === 'lobby' && this.humans(1) >= 2 && this.humans(0) >= 1) { G.srch = false; this.startRanked2(Math.max(0, ...[...G.players.values()].filter(p => !p.bot).map(p => p.rr || 0)), 'pro'); return; }
    // queue rooms: start when everyone's here, or after a short wait with whoever made it
    if (this.q && G.phase === 'lobby') {
      if (this.humans() >= this.q.exp) return this.startQueue();
      if (!this.qTimer) this.qTimer = setTimeout(() => { this.qTimer = null; if (G.phase !== 'lobby' || !this.q) return;
        if (this.humans() >= 2) this.startQueue();
        else { this.all({ t: 'qnone' }); for (const s of this.socks.values()) try { s.ws.close(1000); } catch (e) {} this.reset(); } }, 10000);
    }
  }
  startQueue() {
    const G = this.G; if (this.qTimer) { clearTimeout(this.qTimer); this.qTimer = null; }
    this.clearBots();
    if (this.q.mode === '1v1') {
      const hum = [...G.players.values()]; hum.forEach((p, i) => p.team = i % 2);
      G.ranked = true; G.toWin = 11; G.winBy2 = true; G.diff = 'pro';
      this.startMatch(3.6);
    } else {
      // fair teams: snake draft by rating, Ranked Rivals fill the rest
      const hum = [...G.players.values()].sort((a, b) => (b.rr || 0) - (a.rr || 0)), pattern = [0, 1, 1, 0];
      hum.forEach((p, i) => p.team = pattern[i % 4]);
      const avg = hum.reduce((s, p) => s + (p.rr || 0), 0) / Math.max(1, hum.length);
      this.startRanked2(avg, S.diffForRR(avg));
    }
  }
  startRanked2(near, diff) {
    const G = this.G; this.fillRivals(near);
    G.ranked2 = true; G.toWin = 21; G.winBy2 = true; G.diff = diff || S.diffForRR(near);
    this.startMatch(3.6);
  }

  // ---------------------------------------------------------------- the match
  startMatch(wait) {
    const G = this.G; if (G.phase !== 'lobby') return;
    const ro = [...G.players.values()]; if (!ro.some(p => p.team === 0) || !ro.some(p => p.team === 1)) return;
    this.RM = S.newMatch(ro, G.toWin, false, G.diff, G.winBy2); if (wait) this.RM.phaseT = Math.max(this.RM.phaseT, wait);
    this.RM.hum0 = this.humans(0) > 0; this.RM.hum1 = this.humans(1) > 0; this.overSeen = false;
    G.phase = 'game'; this.pushRoster();
    if (this.loop) clearInterval(this.loop);
    this.last = Date.now(); this.acc = 0;
    this.loop = setInterval(() => this.tick(), TICK_MS);
  }
  tick() {
    const RM = this.RM; if (!RM) { clearInterval(this.loop); this.loop = null; return; }
    const now = Date.now(); this.acc += Math.min(250, now - this.last) / 1000; this.last = now;
    try { while (this.acc >= 1 / 60) { this.acc -= 1 / 60; S.stepMatch(RM, 1 / 60); } } catch (e) { console.log('sim error', e && e.stack); }
    if (RM.phase === 'over' && !this.overSeen) { this.overSeen = true; if (this.q) RM.phaseT = 1e6; }    // ranked queue games stay on the results
    this.all(S.makeSnap(RM, true)); RM.events = [];
    if (RM.phase === 'over' && RM.phaseT <= 0) this.toLobby();
  }
  toLobby() {
    const G = this.G; this.RM = null; if (this.loop) clearInterval(this.loop); this.loop = null;
    G.phase = 'lobby'; G.ranked2 = false;
    if (G.party) this.clearBots();                       // team-up: rivals leave after the game
    this.pushRoster();
  }
  // a player is gone for good: take them out of the roster and the match
  remove(id) {
    const G = this.G, r = G.players.get(id); if (!r) return;
    G.players.delete(id); this.socks.delete(id);
    const RM = this.RM;
    if (RM) {
      const i = RM.players.findIndex(p => p.id === id);
      if (i >= 0) { RM.players.splice(i, 1); if (RM.ball.holder === id) S.looseBall(RM, RM.ball.x, 80, RM.ball.z, 0, 100, 0, r.team); }
      // a whole side of real players left a ranked game: the other side wins (counts for rank)
      if ((G.ranked || G.ranked2 || this.q) && RM.phase !== 'over') {
        const left0 = RM.hum0 && this.humans(0) === 0, left1 = RM.hum1 && this.humans(1) === 0;
        if ((left0 || left1) && this.humans() > 0) { const w = left0 ? 1 : 0; RM.winner = w; RM.phase = 'over'; RM.phaseT = this.q ? 1e6 : 15; RM.events.push({ k: 'over', w, forfeit: 1 }); this.overSeen = true; }
      }
    }
    if (this.owner === id) { const h = [...G.players.values()].find(p => !p.bot); this.owner = h ? h.id : null; }
    if (this.humans() === 0) { this.reset(); return; }
    this.pushRoster();
  }
  lost(id, ws) {
    const s = this.socks.get(id); if (!s || s.ws !== ws) return;
    s.away = Date.now();
    setTimeout(() => { const t = this.socks.get(id); if (t && t.away && Date.now() - t.away >= GRACE_MS - 50) this.remove(id); }, GRACE_MS);
  }

  // ---------------------------------------------------------------- messages from players
  onMsg(id, d, ws) {
    const G = this.G, r = G.players.get(id); if (!r) return;
    const s = this.socks.get(id); if (s && s.ws !== ws) return;
    switch (d.t) {
      case 'ping': this.send(ws, { t: 'pong', ts: d.ts }); return;
      case 'bye': this.remove(id); try { ws.close(1000); } catch (e) {} return;
      case 'gear': this.setGear(r, d); this.pushRoster(); return;
      case 'team': if (G.phase !== 'lobby') return; { const t = 1 - r.team; if (this.count(t) < S.MAX_PER_TEAM) { r.team = t; this.pushRoster(); } } return;
      case 'emote': { const e = d.e | 0, now = Date.now(); if (e < 0 || e > 7 || now - (this.emAt.get(id) || 0) < 600) return; this.emAt.set(id, now);
        const ev = { k: 'emote', id, e }; if (this.RM) this.RM.events.push(ev); else this.all({ t: 'ev', e: ev }); } return;
      case 'cmd': return this.cmd(id, d);
    }
    const RM = this.RM; if (!RM) return;
    const p = S.findP(RM, id); if (!p) return;
    const cl = (v, a, b) => Math.max(a, Math.min(b, v));
    if (d.t === 'in') { p.inX = cl(+d.x || 0, -1, 1); p.inZ = cl(+d.z || 0, -1, 1);
      if (Number.isFinite(+d.px) && Number.isFinite(+d.pz)) { p.authX = cl(+d.px, 60, 1740); p.authZ = cl(+d.pz, -188, 188); p.authAt = performance.now(); } }
    else if (d.t === 'a') { if (d.d) p.wantA = true; else p.relA = cl(+d.m || 0, 0, 1.5); }
    else if (d.t === 'b') p.wantB = true;
    else if (d.t === 'c') p.wantC = true;
  }
  // room owner's buttons (start, bots, settings...)
  cmd(id, d) {
    const G = this.G, c = d.c, own = id === this.owner;
    if (c === 'migrate') { if (!own || typeof d.code !== 'string') return; const tag = rid(6); this.all({ t: 'migrate', code: d.code.slice(0, 16), tag }); return; }
    if (!own) return;
    switch (c) {
      case 'start': return this.startMatch();
      case 'addbot': if (G.phase === 'lobby') { this.addBot(d.team === 1 ? 1 : 0); this.pushRoster(); } return;
      case 'rmbot': { const b = G.players.get(String(d.id)); if (b && b.bot && G.phase === 'lobby') { G.players.delete(b.id); this.pushRoster(); } } return;
      case 'towin': if ([11, 15, 21].includes(+d.v) && G.phase === 'lobby') { G.toWin = +d.v; this.pushRoster(); } return;
      case 'diff': if (['rookie', 'pro', 'legend'].includes(d.d) && G.phase === 'lobby') { G.diff = d.d; this.pushRoster(); } return;
      case 'wb2': if (G.phase === 'lobby') { G.winBy2 = !G.winBy2; this.pushRoster(); } return;
      case 'ranked': if (G.phase === 'lobby') { G.ranked = !G.ranked; this.pushRoster(); } return;
      case 'rematch': if (this.RM && this.RM.phase === 'over') { this.toLobby(); this.startMatch(); } return;
      case 'tolobby': if (this.RM && this.RM.phase === 'over') this.toLobby(); return;
      case 'srch': G.srch = !!d.on; this.pushRoster(); return;
      case 'p2bots': if (G.party && G.phase === 'lobby' && this.humans(0) >= 2) {   // ranked 2v2 needs a real teammate G.srch = false; this.clearBots();
        const near = Math.max(0, ...[...G.players.values()].filter(p => !p.bot && p.team === 0).map(p => p.rr || 0)); this.startRanked2(near); } return;
    }
  }
}

// ---------------------------------------------------------------- MATCHMAKER
// q1 = ranked 1v1 searchers, q2 = ranked 2v2 solo searchers, qd = team-up duos looking for opponents
export class Matchmaker {
  constructor(state, env) { this.q1 = []; this.q2 = []; this.qd = []; this.t2 = null; }
  async fetch(req) {
    if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') {
      return new Response(JSON.stringify({ q1: this.q1.length, q2: this.q2.length, duos: this.qd.length }), { headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' } });
    }
    const [client, ws] = Object.values(new WebSocketPair()); ws.accept();
    const me = { ws, mode: null, t: Date.now(), sent: 0 };
    ws.addEventListener('message', ev => { let d; try { d = JSON.parse(ev.data); } catch (e) { return; } if (!d) return;
      try { if (d.t === 'q') this.join(me, d); else if (d.t === 'cancel') this.drop(me); } catch (e) { console.log('mm error', e && e.stack); } });
    const gone = () => this.drop(me); ws.addEventListener('close', gone); ws.addEventListener('error', gone);
    return new Response(null, { status: 101, webSocket: client });
  }
  send(e, o) { try { e.ws.send(JSON.stringify(o)); } catch (x) {} }
  drop(e) { for (const k of ['q1', 'q2', 'qd']) { const i = this[k].indexOf(e); if (i >= 0) this[k].splice(i, 1); } clearTimeout(e.timer); this.arm2(); this.wait2(); }
  // the 2v2 queue waits up to 20s from the first searcher, then plays with whoever is there
  arm2() { if (this.q2.length && !this.t2) this.t2 = setTimeout(() => { this.t2 = null; this.timeout2(); }, 20000); if (!this.q2.length && this.t2) { clearTimeout(this.t2); this.t2 = null; } }
  wait2() { for (const e of this.q2) this.send(e, { t: 'wait', n: this.q2.length }); }
  join(e, d) {
    this.drop(e); e.mode = d.mode; e.rr = +d.rr || 0; e.t = Date.now();
    if (d.mode === '1v1') {
      const other = this.q1.shift();
      if (other) { clearTimeout(other.timer); const code = 'Q' + rid(7); for (const x of [other, e]) this.send(x, { t: 'go', code, mode: '1v1', exp: 2 }); return; }
      this.q1.push(e);
      e.timer = setTimeout(() => { const i = this.q1.indexOf(e); if (i >= 0) { this.q1.splice(i, 1); this.send(e, { t: 'none' }); } }, 15000);
    } else if (d.mode === '2v2') {
      // a team-up duo is waiting for opponents: go play them
      const duo = this.qd.find(x => x.sent < 2);
      if (duo) { duo.sent++; this.send(e, { t: 'go', code: duo.code, mode: 'duo-solo' }); this.send(duo, { t: 'filled', n: duo.sent }); if (duo.sent >= 2) this.qd.splice(this.qd.indexOf(duo), 1); return; }
      this.q2.push(e); this.wait2();
      if (this.q2.length >= 4) return this.launch2(this.q2.splice(0, 4));
      this.arm2();
    } else if (d.mode === 'duo' && typeof d.code === 'string') {
      e.code = d.code.slice(0, 16);
      const other = this.qd.find(x => x.sent === 0 && x !== e);
      if (other) { this.qd.splice(this.qd.indexOf(other), 1); this.send(other, { t: 'filled', n: 2 }); this.send(e, { t: 'go', code: other.code, mode: 'duo-migrate' }); return; }
      while (e.sent < 2 && this.q2.length) { const s = this.q2.shift(); e.sent++; this.send(s, { t: 'go', code: e.code, mode: 'duo-solo' }); this.send(e, { t: 'filled', n: e.sent }); }
      this.arm2(); this.wait2();
      if (e.sent < 2) this.qd.push(e);
    }
  }
  timeout2() {
    if (this.q2.length >= 2) return this.launch2(this.q2.splice(0, 4));
    const e = this.q2.shift(); if (e) this.send(e, { t: 'none' });
    this.arm2();
  }
  launch2(list) { const code = 'Q' + rid(7); for (const x of list) this.send(x, { t: 'go', code, mode: '2v2', exp: list.length }); if (this.t2) { clearTimeout(this.t2); this.t2 = null; } this.arm2(); this.wait2(); }
}
