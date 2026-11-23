// 💰 Server-owned wallets. Coins, gems, packs and every item a player owns live HERE, not on the iPad:
// a hacked copy of the game can show itself anything, but it can't buy, open or wear anything online
// that this wallet doesn't hold. Everything is checked against catalog.js (built from the game itself).
//
//   earning:  match rewards are added by the game server itself (it saw the game); everything else
//             (quests, login, pass, codes, trophies...) is a claim that's checked and capped here.
//   spending: packs are rolled here, shop items are priced here.
import CAT from './catalog.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const nyDay = (o = 0) => new Date(Date.now() - 5 * 3600e3 + o * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
// a save from before wallets existed can be brought over (once per player) until this date
export const IMPORT_UNTIL = Date.UTC(2026, 11, 8);
export const DIAMOND = CAT.tiers[6];

const ITEM = {}; for (const k in CAT.kinds) ITEM[k] = new Map(CAT.kinds[k].list.map(i => [i.id, i]));
const PACK = new Map(CAT.packs.map(p => [p.id, p]));
const RO = r => CAT.rorder.indexOf(r);
const isXmas = () => { const d = new Date(Date.now() - 5 * 3600e3), m = d.getUTCMonth(), day = d.getUTCDate(); return (m === 10 && day >= 20) || m === 11 || (m === 0 && day <= 6); };
export function packId(id) { id = String(id || ''); if (id === 'season' || id === 'secret' || id === 'xmas' || id === 'feat' || PACK.has(id)) return id; if (/-elite$/.test(id)) return 'legends'; return 'pro'; }
function packOf(id) {
  id = packId(id);
  if (id === 'feat') { const L = isXmas() ? CAT.featSets.filter(k => k !== 'spooky') : CAT.featSets, k = L[Math.floor((Date.now() / 864e5 + 3) / 7) % L.length];
    return { id: 'feat', set: k, gems: 250, price: 0, cards: 4, guar: 'epic', odds: { rare: 44, epic: 33, legendary: 15, mythic: 6, exclusive: 1.6, secret: .4 } }; }
  return PACK.get(id) || null;
}
const cosPriceOf = (pi, oi) => { const P = CAT.cos[pi]; if (!P || !Number.isInteger(oi) || oi < 0 || oi >= P.r.length) return -1; return CAT.cosPrice[P.r[oi]] || 0; };
const cosKey = (pi, oi) => CAT.cos[pi].k + '.' + oi;
const setPool = k => { const a = []; for (const kind in CAT.kinds) for (const i of CAT.kinds[kind].list) if (i.s === k && !i.nc && i.id !== CAT.kinds[kind].def) a.push([kind, i.id]); return a; };

export function walNew() {
  const own = {}; for (const k in CAT.kinds) own[k] = [CAT.kinds[k].def];
  return { c: 150, g: 150, own, cos: {}, fc: {}, d: '', dc: {}, once: {}, login: {}, pass: { s: 0, got: [] }, feat: {}, ws: 0, fw: '', tk: [], t: Date.now() };
}
function today(W) { const d = nyDay(); if (W.d !== d) { W.d = d; W.dc = {}; } return d; }
function use(W, key, n, cap) { today(W); if ((W.dc[key] || 0) + n > cap) return false; W.dc[key] = (W.dc[key] || 0) + n; return true; }
const once = (W, key) => (W.once[key] = W.once[key] || {});
function addItem(W, kind, id) { if (!ITEM[kind] || !ITEM[kind].has(id)) return false; const a = W.own[kind] = W.own[kind] || []; if (a.includes(id)) return false; a.push(id); return true; }
function addPack(W, id, n = 1) { id = packId(id); if (!packOf(id)) return; W.fc[id] = clamp((W.fc[id] || 0) + n, 0, 99); }
export const itemCount = W => Object.values(W.own).reduce((t, a) => t + a.length, 0) - Object.keys(CAT.kinds).length;
export const ALL_ITEMS = Object.values(CAT.kinds).reduce((t, k) => t + k.list.length - 1, 0);
// a moved-over save that can't be real: hacked money (a million coins) or nearly the whole game unlocked.
// Nobody gets near these by playing, so such a save simply starts over as a new player. [] = it's fine
export function walImpossible(W) {
  const I = W.imp; if (!I) return [];
  const f = [], rc = I.rc !== undefined ? I.rc : I.c, rg = I.rg !== undefined ? I.rg : I.g;
  if (I.rc !== undefined ? rc >= 1000000 : false) f.push('had ' + rc.toLocaleString('en-US') + ' coins');
  if (I.rg !== undefined ? rg >= 100000 : false) f.push('had ' + rg.toLocaleString('en-US') + ' gems');
  if (I.items >= ALL_ITEMS * 0.95) f.push('owned ' + I.items + ' of ' + ALL_ITEMS + ' items');
  let top = 0; for (const k in W.own) for (const id of W.own[k]) { const it = ITEM[k] && ITEM[k].get(id); if (it && (it.r === 'icon' || it.r === 'secret')) top++; }
  if (top >= 10) f.push(top + ' Icon/Secret items');
  return f;
}
// start over as a new player (codes, gifts and pass levels already used stay used)
export function walRestart(old, why) { const W = walNew(); if (old) { W.once = old.once || {}; W.cid = old.cid || []; W.pass = old.pass || W.pass; W.imp = old.imp; } W.wreset = Date.now(); W.why = why || ''; W.ck = 1; if (old) { const { bak, ...keep } = old; W.bak = keep; } return W; }   // (bak: the admin can undo it)

// ---- one-time import of an old save (capped money; items as they were, scored for the admin to review)
export function walImport(s, season) {
  const W = walNew(); s = s && typeof s === 'object' ? s : {};
  W.c = clamp(Math.round(+s.coins || 0), 0, 100000); W.g = clamp(Math.round(+s.gems || 0), 0, 25000);
  const ow = s.owned && typeof s.owned === 'object' ? s.owned : {};
  for (const k in CAT.kinds) for (const id of (Array.isArray(ow[k]) ? ow[k] : []).slice(0, 500)) addItem(W, k, String(id));
  if (s.cos && typeof s.cos === 'object') for (const key of Object.keys(s.cos).slice(0, 600)) { const [k, oi] = key.split('.'), pi = CAT.cos.findIndex(P => P.k === k); if (pi >= 0 && cosPriceOf(pi, +oi) > 0) W.cos[cosKey(pi, +oi)] = 1; }
  if (s.freeCrates && typeof s.freeCrates === 'object') { let tot = 0; for (const id in s.freeCrates) { const n = clamp(+s.freeCrates[id] | 0, 0, 20); if (n && tot + n <= 60 && packOf(id)) { addPack(W, id, n); tot += n; } } }
  for (const f of CAT.feats) W.feat[f.id] = clamp(+((s.feat || {})[f.id]) | 0, 0, f.goal);
  if (s.pass && +s.pass.s === season) W.pass = { s: season, got: Array.from({ length: clamp(+s.pass.lvl | 0, 0, CAT.passMax) }, (_, i) => i + 1) };
  if (Array.isArray(s.tkUnl)) W.tk = s.tkUnl.filter(t => ['lock', 'handles', 'play', 'slash', 'shot'].includes(t)).slice(0, 5);
  if (s.loginToday) W.login = { last: nyDay(), streak: clamp(+s.loginStreak | 0, 1, 7) };
  if (s.fwToday) W.fw = nyDay();
  W.ws = clamp(+s.wstreak | 0, 0, 50);
  const ids = new Set(Object.values(CAT.codes).map(c => c.id)); for (const r of (Array.isArray(s.redeemed) ? s.redeemed : []).slice(0, 50)) if (ids.has(r)) once(W, 'code')[r] = 1;
  if (s.setClaim && typeof s.setClaim === 'object') for (const k in s.setClaim) for (const p in s.setClaim[k] || {}) once(W, 'sm')[k + ':' + p] = 1;
  if (s.tutDone) once(W, 'tut').x = 1;
  for (const id of (Array.isArray(s.gifts) ? s.gifts : []).slice(0, 1000)) if (typeof id === 'string') once(W, 'gift')[id.slice(0, 40)] = 1;
  if (s.evp && s.evp.claimed && typeof s.evp.id === 'string') once(W, 'ev')[s.evp.id.slice(0, 40)] = 1;
  if (Number.isInteger(s.season) && s.season > 0) for (let n = 1; n < s.season; n++) once(W, 'season')[n] = 1;   // already paid on the iPad
  // how believable is this save? lots of items with few games played = worth a look (admin panel)
  const items = itemCount(W), games = clamp(+s.games | 0, 0, 100000);
  W.imp = { t: Date.now(), items, cos: Object.keys(W.cos).length, games, c: W.c, g: W.g, rc: Math.max(0, Math.round(+s.coins || 0)), rg: Math.max(0, Math.round(+s.gems || 0)) };
  W.ck = 1; const bad = walImpossible(W);
  return bad.length ? walRestart(W, bad.join(', ')) : W;
}

export function walView(W) { return { c: W.c, g: W.g, own: W.own, cos: Object.keys(W.cos), fc: W.fc, tk: W.tk, pass: W.pass, feat: W.feat, login: W.login }; }

// ---- 📦 open a pack: paid for and rolled here
function rollRarity(odds, items, minR) {
  const lo = minR ? RO(minR) : 0, avail = CAT.rorder.filter((r, i) => i >= lo && odds[r] && items.some(x => x.r === r));
  if (!avail.length) return null; const tot = avail.reduce((t, r) => t + odds[r], 0); let x = Math.random() * tot;
  for (const r of avail) { x -= odds[r]; if (x < 0) return r; } return avail[avail.length - 1];
}
export function walPack(W, id, mode) {
  let pk = packOf(id); if (!pk) return { err: 'no such pack' };
  if (mode === 'daily') { const d = today(W); if (once(W, 'daily').d === d) return { err: 'already opened today' }; W.once.daily.d = d; pk = packOf('street'); }
  else if ((W.fc[pk.id] || 0) > 0) W.fc[pk.id]--;
  else if (pk.freeOnly) return { err: 'no free ' + pk.id + ' packs' };
  else if (pk.gems) { if (W.g < pk.gems) return { err: 'gems' }; W.g -= pk.gems; }
  else { if (W.c < pk.price) return { err: 'coins' }; W.c -= pk.price; }
  const items = []; for (const kind in CAT.kinds) for (const i of CAT.kinds[kind].list) if (!i.nc && i.id !== CAT.kinds[kind].def && (!pk.set || i.s === pk.set)) items.push({ ...i, kind });
  const out = [];
  for (let n = 0; n < pk.cards; n++) {
    const need = n === pk.cards - 1 && pk.guar && !out.some(c => RO(c.r) >= RO(pk.guar));
    const r = rollRarity(pk.odds, items, need ? pk.guar : null) || rollRarity(pk.odds, items), pool = items.filter(x => x.r === r);
    if (pool.length) out.push(pool[Math.floor(Math.random() * pool.length)]);
  }
  out.sort((a, b) => RO(a.r) - RO(b.r));
  const cards = out.map(it => { const isNew = addItem(W, it.kind, it.id), refund = isNew ? 0 : (CAT.rar[it.r] || {}).refund || 0; W.c += refund; return { kind: it.kind, id: it.id, r: it.r, isNew, refund }; });
  return { ok: true, pk: pk.id, cards };
}

// ---- 🛍️ buy shop items (priced here; sets 30% off, today's fit 35% off)
export function walBuy(W, list, setName) {
  if (!Array.isArray(list) || !list.length || list.length > 12) return { err: 'bad list' };
  const L = []; for (const x of list) { const pi = +(x || [])[0], oi = +(x || [])[1]; const pr = cosPriceOf(pi, oi); if (pr <= 0) return { err: 'not for sale' }; if (!W.cos[cosKey(pi, oi)] && !L.some(y => y[0] === pi && y[1] === oi)) L.push([pi, oi, pr]); }
  if (!L.length) return { err: 'already yours' };
  let off = 0;
  const S = setName && CAT.styleSets.find(S => S.n === setName);
  if (S && L.every(([pi, oi]) => S.list.some(([a, b]) => a === pi && b === oi))) off = .3;
  else if (setName === 'fit' && L.length <= 4 && new Set(L.map(x => x[0])).size === L.length && L.every(([pi, oi]) => CAT.cos[pi].r[oi] !== 'legendary')) off = .35;
  const full = L.reduce((t, x) => t + x[2], 0), price = off ? Math.round(full * (1 - off) / 50) * 50 : full;
  if (W.c < price) return { err: 'coins', price };
  W.c -= price; for (const [pi, oi] of L) W.cos[cosKey(pi, oi)] = 1;
  return { ok: true, price, n: L.length };
}

// ---- 🎁 claims (everything that isn't a match or a purchase). ctx: {season, prof, cfg}
export function walClaim(W, x, ctx) {
  const d = today(W), G = { c: 0, g: 0, items: [], packs: [] };
  const give = (c, g) => { c = Math.round(+c || 0); g = Math.round(+g || 0); W.c = Math.max(0, W.c + c); W.g = Math.max(0, W.g + g); G.c += c; G.g += g; };
  const item = v => { const [k, id] = String(v || '').includes(':') ? String(v).split(':') : ['trail', String(v || '')]; if (addItem(W, k, id)) G.items.push(k + ':' + id); };
  const pack = id => { if (packOf(id)) { addPack(W, id); G.packs.push(packId(id)); } };
  const no = why => ({ err: why });
  switch (x && x.k) {
    case 'quest': if (!use(W, 'quest', 1, 3)) return no('quests done today'); give(clamp(+x.r | 0, 0, CAT.questMax), 0); break;
    case 'qbonus': if (!use(W, 'qbonus', 1, 1)) return no('bonus done today'); give(CAT.questBonus, 60); break;
    case 'login': { const L = W.login || {}; if (L.last === d) return no('already claimed today');
      const streak = L.last === nyDay(-1) ? (L.streak || 0) % 7 + 1 : 1, rw = CAT.login[streak - 1] || {}; W.login = { last: d, streak };
      give(0, rw.gems || 0); if (rw.pack) pack(rw.pack); G.streak = streak; break; }
    case 'pass': { const L = +x.L | 0; if (L < 1 || L > CAT.passMax) return no('bad level');
      if (W.pass.s !== ctx.season) W.pass = { s: ctx.season, got: [] };
      if (W.pass.got.includes(L)) return no('already claimed'); if (!use(W, 'pass', 1, 25)) return no('too many levels today');
      W.pass.got.push(L); const r = CAT.passRew[L] || { coins: 500 + Math.floor(L / 5) * 250 };
      give(r.coins || 0, 30); if (r.crate) pack(r.crate); if (r.item) item('trail:' + r.item); if (r.tk && !W.tk.includes(r.tk)) W.tk.push(r.tk); break; }
    case 'season': { const n = +x.n | 0, P = ctx.prof && ctx.prof.prev; if (!P || P.n !== n || (P.g | 0) < 3) return no('no season reward');
      if (once(W, 'season')[n]) return no('already claimed'); W.once.season[n] = 1;
      let ti = 0; CAT.tiers.forEach((m, i) => { if ((P.peak | 0) >= m) ti = i; }); give(CAT.seasonCoins[ti] || 0, 0);
      for (const [t, id] of CAT.seasonItems) if (ti >= t) item('trail:' + id); break; }
    case 'trophy': { const f = CAT.feats.find(f => f.id === x.id); if (!f) return no('bad trophy'); if ((W.own[f.kind] || []).includes(f.item)) return no('already yours');
      const ok = f.id === 'rank' ? !!ctx.prof && Math.max(ctx.prof.b | 0, ctx.prof.rr | 0) >= DIAMOND : (W.feat[f.id] | 0) >= f.goal; if (!ok) return no('not earned yet');
      item(f.kind + ':' + f.item); give(0, 250); break; }
    case 'tut': if (once(W, 'tut').x) return no('already claimed'); W.once.tut.x = 1; give(0, 100); break;
    case 'setmile': { const k = String(x.set || ''), m = CAT.setMiles.find(m => m.p === +x.p); if (!CAT.sets.includes(k) || !m) return no('bad set');
      const key = k + ':' + m.p; if (once(W, 'sm')[key]) return no('already claimed'); const a = setPool(k); if (!a.length) return no('bad set');
      const pc = Math.floor(a.filter(([kind, id]) => (W.own[kind] || []).includes(id)).length / a.length * 100); if (pc < m.p) return no('not there yet');
      W.once.sm[key] = 1; if (m.pack) pack(m.pack); break; }
    case 'event': { const e = ctx.cfg && ctx.cfg.event; if (!e || e.id !== x.id || !(+e.end > Date.now()) || !e.goal) return no('no such event');
      const id = String(e.id).slice(0, 40); if (once(W, 'ev')[id]) return no('already claimed'); W.once.ev[id] = 1;
      const rw = e.reward || {}; give(clamp(+rw.coins || 0, 0, 100000), clamp(+rw.gems || 0, 0, 20000)); if (rw.item) item(rw.item); if (rw.crate) pack(rw.crate); break; }
    case 'gift': { const gifts = ctx.cfg && ctx.cfg.gifts, key = String(x.key || ''), id = String(x.id || '').slice(0, 40);
      const okKey = key === '*' || (ctx.pk && key === 'p' + ctx.pk.slice(0, 16)) || (ctx.nk && key === 'n' + ctx.nk);
      const g = okKey && gifts && gifts[key] && gifts[key][id]; if (!g || typeof g !== 'object') return no('no such gift');
      if (once(W, 'gift')[id]) return no('already claimed'); W.once.gift[id] = 1;
      give(clamp(+g.coins || 0, -1e6, 1e6), clamp(+g.gems || 0, -1e5, 1e5)); if (g.item) item(g.item); if (g.crate) pack(g.crate); break; }
    case 'code': { const rw = CAT.codes[String(x.h || '')]; if (!rw) return no('not a code'); if (once(W, 'code')[rw.id]) return no('already redeemed'); W.once.code[rw.id] = 1;
      give(rw.coins || 0, rw.gems || 0); if (rw.freeCrate) pack(rw.freeCrate); break; }
    default: return no('unknown claim');
  }
  return { ok: true, grant: G };
}

// ---- 🏀 match rewards, added by the game server (x: what it saw this player do)
export function walGame(W, x, mult) {
  const d = today(W), cm = clamp(Math.round(+mult || 1), 1, 5);
  let c = clamp(Math.round(+x.c || 0), 0, 2000) * cm + clamp(Math.round(+x.rc || 0), 0, 1000), g = clamp(Math.round(+x.g || 0), 0, 300);
  const packs = [];
  if (x.played) { if (x.win) {
      if (W.fw !== d) { W.fw = d; g += 50; addPack(W, 'street'); packs.push('street'); }
      W.ws = (W.ws | 0) + 1; if (W.ws % 3 === 0) { const id = W.ws >= 9 ? 'allstar' : W.ws >= 6 ? 'pro' : 'street'; addPack(W, id); packs.push(id); }
    } else W.ws = 0; }
  const capC = 40000 - (W.dc.gc || 0), capG = 4000 - (W.dc.gg || 0); c = clamp(c, 0, Math.max(0, capC)); g = clamp(g, 0, Math.max(0, capG));   // safety cap per day
  W.dc.gc = (W.dc.gc || 0) + c; W.dc.gg = (W.dc.gg || 0) + g; W.c += c; W.g += g;
  for (const f of ['greens', 'wins', 'ankles', 'lock']) W.feat[f] = clamp((W.feat[f] | 0) + clamp(+((x.feat || {})[f]) | 0, 0, 100), 0, 100000);
  if (x.zero) W.feat.zero = 1;
  return { c, g, packs };
}

// ---- 👕 what this player may wear online (everything else is shown as the default)
export function walGear(W, gear) {
  const out = {};
  for (const k in CAT.kinds) if (typeof gear[k] === 'string') out[k] = W && (W.own[k] || []).includes(gear[k]) ? gear[k] : CAT.kinds[k].def;
  if (typeof gear.lk === 'string' && /^\d{1,2}(\.\d{1,2}){5,24}$/.test(gear.lk)) out.lk = gear.lk.split('.').map((v, pi) => { const oi = +v, pr = cosPriceOf(pi, oi); return pr < 0 ? 0 : pr === 0 || (W && W.cos[cosKey(pi, oi)]) ? oi : 0; }).join('.');
  if (typeof gear.tk === 'string') out.tk = W && W.tk.includes(gear.tk) ? gear.tk : '';
  if (typeof gear.ct === 'string') { const a = setPool(gear.ct); out.ct = W && a.length && a.every(([k, id]) => (W.own[k] || []).includes(id)) ? gear.ct : ''; }
  return out;
}
