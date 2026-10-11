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

module.exports = { leaderboard, trader, positions, depositAddress, bridgeStatus, isName, isEvm, PERIODS, CATS };
