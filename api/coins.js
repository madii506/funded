// GET /api/coins                 every coin on FUNDED (live first)
// GET /api/coins?m=<mint>|id=    one coin: its trader, its chest, every payout and the engine log
// GET /api/coins?op=log          the latest engine actions across every coin
// GET /api/coins?op=ledger       every payout ever sent to a trader
// GET /api/coins?op=stats        totals
// GET /api/coins?op=trader&u=    the coin for one trader, if there is one
const L = require('./_lib');
const E = require('./_engine');
const S = n => (n == null ? null : +(Number(n) / 1e9).toFixed(4));
const pub = (c, site) => ({ id: c.id, n: c.n, mint: c.mint, name: c.name, symbol: c.symbol, state: c.state, img: site + '/i/' + c.id,
  trader: c.trader, traderKey: c.trader_key, traderWallet: c.trader_wallet, mcapUsd: c.mcap_usd, complete: c.complete,
  claimedSol: S(c.claimed), paidSol: S(c.paid), cutSol: S(c.cut), burnedSol: S(c.burned), payouts: c.payouts, lastPayAt: c.last_pay_at, liveAt: c.live_at, createdAt: c.created_at,
  optedOut: L.OPTED_OUT.has(c.trader_key) });

module.exports = async (req, res) => {
  const qy = L.query(req);
  if (!L.dbReady()) return L.send(res, 200, { ok: true, offline: true, coins: [], log: [], ledger: [] });
  try {
    await L.ready(); const site = L.origin(req);
    if (qy.op === 'log') {
      const r = await L.q(`SELECT l.kind, l.text, l.sig, l.sol, l.at, c.symbol, c.mint, c.trader FROM fu_log l JOIN fu_coins c ON c.id = l.id
        WHERE l.kind IN ('pay','claim','launch','burn','refund') AND c.state IN ('live','refunded','failed') ORDER BY l.n DESC LIMIT 40`);
      return L.send(res, 200, { ok: true, log: r }, L.CACHE(10));
    }
    if (qy.op === 'ledger') {
      const r = await L.q(`SELECT p.n, p.to_addr, p.lamports, p.cut, p.sig, p.sol_usd, p.at, c.symbol, c.mint, c.trader FROM fu_pay p JOIN fu_coins c ON c.id = p.id ORDER BY p.n DESC LIMIT 100`);
      return L.send(res, 200, { ok: true, ledger: r.map(p => ({ n: Number(p.n), to: p.to_addr, sol: S(p.lamports), cutSol: S(p.cut), usd: p.sol_usd ? +(Number(p.lamports) / 1e9 * p.sol_usd).toFixed(2) : null, sig: p.sig, at: p.at, symbol: p.symbol, mint: p.mint, trader: p.trader })) }, L.CACHE(10));
    }
    if (qy.op === 'stats') {
      const r = await L.q(`SELECT count(*) FILTER (WHERE state='live')::int AS live, count(DISTINCT trader_key) FILTER (WHERE state='live')::int AS traders,
        COALESCE(sum(claimed),0)::bigint AS claimed, COALESCE(sum(paid),0)::bigint AS paid, COALESCE(sum(cut),0)::bigint AS cut, COALESCE(sum(payouts),0)::int AS payouts FROM fu_coins`);
      const t = await L.q(`SELECT v FROM fu_meta WHERE k='tick'`).catch(() => []);
      return L.send(res, 200, { ok: true, live: r[0].live, traders: r[0].traders, payouts: r[0].payouts, claimedSol: S(r[0].claimed), paidSol: S(r[0].paid), cutSol: S(r[0].cut),
        lastTick: t.length ? new Date(Number(t[0].v)).toISOString() : null }, L.CACHE(15));
    }
    if (qy.op === 'trader') {
      const key = String(qy.u || '').toLowerCase().replace(/^@/, '').slice(0, 64);
      const r = await L.q(`SELECT * FROM fu_coins WHERE trader_key=$1 AND state IN ('creating','live') ORDER BY n LIMIT 1`, [key]);
      return L.send(res, 200, { ok: true, coin: r.length ? pub(r[0], site) : null }, L.CACHE(15));
    }
    const key = String(qy.m || qy.mint || qy.id || '');
    if (key) {
      const r = await L.q(`SELECT * FROM fu_coins WHERE mint=$1 OR id=$1`, [key]);
      if (!r.length) return L.send(res, 200, { ok: false, error: 'No coin with that address on FUNDED.' });
      const c = r[0];
      const pays = await L.q(`SELECT n, to_addr, lamports, cut, sig, sol_usd, at FROM fu_pay WHERE id=$1 ORDER BY n DESC LIMIT 50`, [c.id]);
      const log = await L.q(`SELECT kind, text, sig, sol, at FROM fu_log WHERE id=$1 ORDER BY n DESC LIMIT 60`, [c.id]);
      let chest = null, waiting = null, market = null;
      if (c.state === 'live') [chest, waiting, market] = await Promise.all([E.chest(c).catch(() => null), E.waiting(c.wallet).catch(() => null), E.coinMarket(c.mint).catch(() => null)]);
      const pm = await E.payMin();
      return L.send(res, 200, { ok: true, coin: { ...pub(c, site), wallet: c.wallet, launcher: c.launcher, description: c.description, twitter: c.twitter, website: c.website,
        createSig: c.create_sig, metaUri: c.meta_uri, depositSvm: c.deposit_svm, chestSol: S(chest), waitingSol: S(waiting), reserveSol: E.RESERVE / 1e9,
        payMinSol: +(pm.lamports / 1e9).toFixed(4), market: market && market.ok ? market : null, err: c.err },
        payouts: pays.map(p => ({ n: Number(p.n), to: p.to_addr, sol: S(p.lamports), cutSol: S(p.cut), usd: p.sol_usd ? +(Number(p.lamports) / 1e9 * p.sol_usd).toFixed(2) : null, sig: p.sig, at: p.at })), log }, L.CACHE(8));
    }
    const r = await L.q(`SELECT * FROM fu_coins WHERE state IN ('live','creating') ORDER BY (state='live') DESC, n DESC LIMIT 200`);
    L.send(res, 200, { ok: true, coins: r.map(c => pub(c, site)) }, L.CACHE(15));
  } catch (e) { L.send(res, 200, { ok: false, error: 'The records didn’t answer just now.' }); }
};
