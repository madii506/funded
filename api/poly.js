// GET /api/poly?op=top&period=DAY|WEEK|MONTH|ALL&cat=OVERALL|POLITICS|…&order=PNL|VOL   Polymarket's leaderboard, marked with FUNDED coins
// GET /api/poly?op=trader&u=<username>                                             one trader: numbers by period, open positions, deposit route, coin
// GET /api/poly?op=status&svm=<address>                                            Polymarket's bridge: deposits it has seen at an address
const L = require('./_lib');
const P = require('./_poly');
async function coinsFor(keys) {
  if (!L.dbReady() || !keys.length) return {};
  try { await L.ready(); const r = await L.q(`SELECT trader_key, symbol, mint FROM fu_coins WHERE trader_key = ANY($1) AND state IN ('creating','live')`, [keys]); return Object.fromEntries(r.map(x => [x.trader_key, { symbol: x.symbol, mint: x.mint }])); }
  catch { return {}; }
}
module.exports = async (req, res) => {
  const qy = L.query(req); const op = String(qy.op || 'top');
  try {
    if (op === 'top') {
      const list = await P.leaderboard({ period: qy.period, cat: qy.cat, order: qy.order, limit: Math.min(50, Number(qy.limit) || 25) });
      const coins = await coinsFor(list.map(x => String(x.user || '').toLowerCase()).filter(Boolean));
      return L.send(res, 200, { ok: true, period: String(qy.period || 'DAY').toUpperCase(), cat: String(qy.cat || 'OVERALL').toUpperCase(), list: list.map(x => ({ ...x, coin: coins[String(x.user || '').toLowerCase()] || null })) }, L.CACHE(45));
    }
    if (op === 'trader') {
      const u = String(qy.u || '').trim().replace(/^@/, '');
      if (!P.isName(u)) return L.send(res, 200, { ok: false, error: 'Type a Polymarket username.' });
      const t = await P.trader(u);
      if (!t) return L.send(res, 200, { ok: false, error: `No Polymarket trader is called @${u}.` }, L.CACHE(60));
      const [pos, svm, coins] = await Promise.all([P.positions(t.wallet).catch(() => null), P.depositAddress(t.wallet).catch(() => null), coinsFor([t.key])]);
      return L.send(res, 200, { ok: true, trader: { ...t, optedOut: L.OPTED_OUT.has(t.key) }, positions: pos, deposit: svm, coin: coins[t.key] || null }, L.CACHE(45));
    }
    if (op === 'status') {
      const svm = String(qy.svm || '');
      if (!L.isAddr(svm)) return L.send(res, 200, { ok: false, error: 'bad address' });
      return L.send(res, 200, { ok: true, deposits: await P.bridgeStatus(svm) }, L.CACHE(30));
    }
    L.send(res, 200, { ok: false, error: 'unknown op' });
  } catch (e) { L.send(res, 200, { ok: false, error: String(e && e.message || 'Polymarket didn’t answer').slice(0, 160) }); }
};
