// Polymarket, read-only: who a trader is, how they're doing, and where their deposits go.
// Every number here comes from Polymarket's own public APIs; nothing is estimated.
const L = require('./_lib');
const DATA = 'https://data-api.polymarket.com';
const BRIDGE = 'https://bridge.polymarket.com';
const PERIODS = ['DAY', 'WEEK', 'MONTH', 'ALL'];
const CATS = ['OVERALL', 'POLITICS', 'SPORTS', 'CRYPTO', 'CULTURE', 'MENTIONS', 'WEATHER', 'ECONOMICS', 'TECH', 'FINANCE'];
const NAME_RE = /^[A-Za-z0-9._-]{1,48}$/;
const isName = s => typeof s === 'string' && NAME_RE.test(s);
const isEvm = s => typeof s === 'string' && /^0x[0-9a-fA-F]{40}$/.test(s);

const row = x => ({
  rank: Number(x.rank) || null, user: String(x.userName || '').slice(0, 64) || null, wallet: String(x.proxyWallet || '').toLowerCase(),
  x: String(x.xUsername || '').replace(/^@/, '').slice(0, 32) || null, verified: !!x.verifiedBadge,
  pnl: Number.isFinite(+x.pnl) ? +x.pnl : null, vol: Number.isFinite(+x.vol) ? +x.vol : null,
  image: /^https:\/\//.test(String(x.profileImage || '')) ? String(x.profileImage) : null,
});

async function leaderboard({ period = 'DAY', cat = 'OVERALL', order = 'PNL', limit = 25, offset = 0, userName, user } = {}) {
  period = PERIODS.includes(String(period).toUpperCase()) ? String(period).toUpperCase() : 'DAY';
  cat = CATS.includes(String(cat).toUpperCase()) ? String(cat).toUpperCase() : 'OVERALL';
  order = String(order).toUpperCase() === 'VOL' ? 'VOL' : 'PNL';
  const u = new URL(DATA + '/v1/leaderboard');
  u.searchParams.set('timePeriod', period); u.searchParams.set('category', cat); u.searchParams.set('orderBy', order);
  u.searchParams.set('limit', String(Math.max(1, Math.min(50, limit | 0 || 25)))); u.searchParams.set('offset', String(Math.max(0, Math.min(1000, offset | 0))));
  if (userName) u.searchParams.set('userName', userName);
  if (user) u.searchParams.set('user', user);
  return L.remember('lb:' + u.search, 45000, async () => {
    const r = await L.getJson(u.toString(), {}, 8000);
    if (!r.ok || !Array.isArray(r.json)) throw new Error('Polymarket leaderboard didn’t answer (' + r.status + ')');
    return r.json.map(row).filter(x => x.wallet);
  });
}

// a trader by username: the profile Polymarket returns, plus their numbers for each period
async function trader(name) {
  if (!isName(name)) return null;
  return L.remember('tr:' + name.toLowerCase(), 60000, async () => {
    const all = await leaderboard({ period: 'ALL', userName: name, limit: 1 });
    const me = all[0];
    if (!me || !isEvm(me.wallet)) return null;
    const per = { ALL: me };
    await Promise.all(['DAY', 'WEEK', 'MONTH'].map(async p => { try { const r = await leaderboard({ period: p, user: me.wallet, limit: 1 }); per[p] = r[0] || null; } catch { per[p] = undefined; } }));
    const pick = k => Object.fromEntries(PERIODS.map(p => [p.toLowerCase(), per[p] === undefined ? undefined : per[p] ? per[p][k] : null]));
    return { user: me.user, key: me.user.toLowerCase(), wallet: me.wallet, x: me.x, verified: me.verified, image: me.image,
      pnl: pick('pnl'), vol: pick('vol'), rank: pick('rank'), url: 'https://polymarket.com/@' + encodeURIComponent(me.user) };
  });
}

async function positions(wallet, limit = 8) {
  if (!isEvm(wallet)) return [];
  return L.remember('pos:' + wallet, 60000, async () => {
    const r = await L.getJson(`${DATA}/positions?user=${wallet}&limit=${limit}&sortBy=CURRENT&sizeThreshold=1`, {}, 8000);
    if (!r.ok || !Array.isArray(r.json)) throw new Error('positions didn’t answer');
    return r.json.map(p => ({ title: String(p.title || '').slice(0, 140), outcome: String(p.outcome || '').slice(0, 40), size: +p.size || 0, avg: +p.avgPrice || 0, cur: +p.curPrice || 0,
      value: +p.currentValue || 0, pnl: +p.cashPnl || 0, pct: +p.percentPnl || 0, slug: String(p.eventSlug || p.slug || ''), end: p.endDate || null, redeemable: !!p.redeemable }));
  });
}

// Polymarket's bridge gives every Polymarket wallet a Solana deposit address; anything supported sent there is swapped and
// credited to that wallet's balance. It is the same address every time for the same wallet.
async function depositAddress(wallet) {
  if (!isEvm(wallet)) throw new Error('not a Polymarket wallet');
  return L.remember('dep:' + wallet.toLowerCase(), 10 * 60000, async () => {
    const headers = { 'content-type': 'application/json' };
    if ((process.env.POLY_BUILDER_CODE || '').trim()) headers['X-Builder-Code'] = process.env.POLY_BUILDER_CODE.trim();
    const r = await L.getJson(BRIDGE + '/deposit', { method: 'POST', headers, body: JSON.stringify({ address: wallet }) }, 10000);
    const svm = r.json && r.json.address && r.json.address.svm;
    if (!(r.status === 200 || r.status === 201) || !L.isAddr(svm)) throw new Error('Polymarket’s deposit bridge didn’t answer (' + r.status + ')');
    return svm;
  });
}
async function bridgeStatus(svm) {
  if (!L.isAddr(svm)) return null;
  return L.remember('bs:' + svm, 30000, async () => {
    const r = await L.getJson(BRIDGE + '/status/' + svm, {}, 8000);
    if (!r.ok || !r.json) throw new Error('bridge status didn’t answer');
    const tx = Array.isArray(r.json.transactions) ? r.json.transactions : [];
    return tx.slice(0, 20).map(t => ({ status: String(t.status || t.state || '').slice(0, 40) || null, from: t.fromChainId || t.sourceChainId || null,
      token: t.fromTokenAddress || t.token || null, amount: t.fromAmountBaseUnit || t.amount || null, hash: t.txHash || t.sourceTxHash || t.fromTxHash || null,
      at: t.createdTimeMs || t.createdAt || t.timestamp || null, raw: Object.keys(t).slice(0, 12) }));
  });
}


const GAMMA = 'https://gamma-api.polymarket.com';
const TAGS = { all: null, politics: 'politics', sports: 'sports', crypto: 'crypto', economy: 'economy', tech: 'tech', culture: 'pop-culture', world: 'geopolitics' };
const num = v => (Number.isFinite(+v) ? +v : null);
const arr = v => { try { return Array.isArray(v) ? v : JSON.parse(v || '[]'); } catch { return []; } };
// the markets with the most money moving through them right now (one market per event: the busiest one)
async function markets(tag = 'all', limit = 12) {
  const t = Object.prototype.hasOwnProperty.call(TAGS, tag) ? TAGS[tag] : null;
  return L.remember('mk:' + tag + ':' + limit, 60000, async () => {
    const u = new URL(GAMMA + '/events'); u.searchParams.set('active', 'true'); u.searchParams.set('closed', 'false'); u.searchParams.set('order', 'volume24hr');
    u.searchParams.set('ascending', 'false'); u.searchParams.set('limit', String(Math.min(40, limit * 2))); if (t) u.searchParams.set('tag_slug', t);
    const r = await L.getJson(u.toString(), {}, 9000);
    if (!r.ok || !Array.isArray(r.json)) throw new Error('Polymarket markets didn’t answer (' + r.status + ')');
    const out = [];
    for (const e of r.json) {
      const ms = (e.markets || []).filter(m => m.active && !m.closed && m.conditionId).sort((a, b) => (num(b.volume24hr) || 0) - (num(a.volume24hr) || 0));
      const m = ms[0]; if (!m) continue;
      const outcomes = arr(m.outcomes).map(String), prices = arr(m.outcomePrices).map(Number);
      if (!outcomes.length || prices.length !== outcomes.length) continue;
      out.push({ event: String(e.title || '').slice(0, 160), question: String(m.question || e.title || '').slice(0, 200), slug: String(e.slug || ''), cond: String(m.conditionId),
        outcomes: outcomes.slice(0, 2), prices: prices.slice(0, 2), vol24: num(e.volume24hr), vol: num(e.volume), liq: num(e.liquidity), end: e.endDate || m.endDate || null, n: (e.markets || []).length });
      if (out.length >= limit) break;
    }
    return out;
  });
}
// the biggest holders on each side of one market
async function holders(cond) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(cond || ''))) return [];
  return L.remember('ho:' + cond, 60000, async () => {
    const r = await L.getJson(`${DATA}/holders?market=${cond}&limit=6`, {}, 8000);
    if (!r.ok) throw new Error('holders didn’t answer');
    if (!Array.isArray(r.json)) return [];                     // polymarket answers null for markets it has no holder list for
    return r.json.map(t => ({ holders: (t.holders || []).filter(h => h.displayUsernamePublic !== false && h.name).slice(0, 6).map(h => ({ user: String(h.name).slice(0, 64), wallet: String(h.proxyWallet || '').toLowerCase(), amount: num(h.amount), side: h.outcomeIndex, verified: !!h.verified })) }));
  });
}
async function trades(wallet, limit = 10) {
  if (!isEvm(wallet)) return [];
  return L.remember('trd:' + wallet, 45000, async () => {
    const r = await L.getJson(`${DATA}/trades?user=${wallet}&limit=${limit}`, {}, 8000);
    if (!r.ok || !Array.isArray(r.json)) throw new Error('trades didn’t answer');
    return r.json.map(t => ({ side: String(t.side || ''), outcome: String(t.outcome || '').slice(0, 40), title: String(t.title || '').slice(0, 140), slug: String(t.eventSlug || t.slug || ''),
      size: num(t.size), price: num(t.price), usd: num(t.size) != null && num(t.price) != null ? +(t.size * t.price).toFixed(2) : null, at: t.timestamp ? new Date(t.timestamp * 1000).toISOString() : null }));
  });
}
async function value(wallet) {
  if (!isEvm(wallet)) return null;
  return L.remember('val:' + wallet, 60000, async () => { const r = await L.getJson(`${DATA}/value?user=${wallet}`, {}, 7000); const v = Array.isArray(r.json) && r.json[0] ? num(r.json[0].value) : null; return v; });
}
// today's #1 in every category
async function leaders(period = 'DAY') {
  return L.remember('cats:' + period, 60000, async () => {
    const cats = CATS.filter(c => c !== 'OVERALL' && c !== 'MENTIONS');
    const out = await Promise.all(cats.map(async c => { try { const r = await leaderboard({ period, cat: c, limit: 1 }); return r[0] ? { cat: c, ...r[0] } : { cat: c, user: null }; } catch { return { cat: c, user: null, error: true }; } }));
    return out;
  });
}

module.exports = { leaderboard, trader, positions, depositAddress, bridgeStatus, markets, holders, trades, value, leaders, isName, isEvm, PERIODS, CATS, TAGS };
