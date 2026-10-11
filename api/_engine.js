// The engine. It is custodial, and says so: every coin launched on FUNDED has its own wallet, derived on this server from
// one master secret, and that wallet is the coin's pump.fun creator. The engine claims the coin's creator fees into it and,
// once enough has built up, sends them to the Solana deposit address Polymarket's own bridge assigned to the trader the
// coin is about. Polymarket swaps that SOL and credits it to the trader's Polymarket balance. Every move is a public
// Solana transaction, linked from the coin's page. There is no sell action and no withdraw action.
const crypto = require('crypto');
const L = require('./_lib');
const P = require('./_poly');

let web3 = null, spl = null;
const w3 = () => web3 || (web3 = require('@solana/web3.js'));
const sp = () => spl || (spl = require('@solana/spl-token'));

const LAMPORTS = 1e9;
const RESERVE = 0.015 * LAMPORTS;          // stays in every coin wallet for gas and token-account rent
const CREATE_COST = 0.03 * LAMPORTS;       // pump.fun rent for a new coin, plus margin; whatever is unused goes back
const MIN_DEV = 0.01, MAX_DEV = 10;
const CLAIM_MIN = 0.003 * LAMPORTS;        // claim when at least this much is waiting
const PAY_MIN_USD = Math.max(3, Number(process.env.PAY_MIN_USD || 6));   // Polymarket's bridge ignores deposits under $2; we wait for $6
const PAY_MIN_SOL_FLOOR = 0.02 * LAMPORTS;
const PORTAL = 'https://pumpportal.fun/api/trade-local';
const PRIORITY = Number(process.env.PRIORITY_FEE || 0.0002);
const need = devBuy => Math.ceil((CREATE_COST + devBuy * 1.02 * LAMPORTS + RESERVE) / 1e6) * 1e6;   // rounded up to 0.001 SOL

// ---------- keys: derived, never stored ----------
let MASTER = null;
async function master() {
  if (MASTER) return MASTER;
  if (process.env.FUNDED_MASTER && process.env.FUNDED_MASTER.length >= 32) return (MASTER = process.env.FUNDED_MASTER);
  await L.ready();
  await L.q(`INSERT INTO fu_meta (k, v) VALUES ('master', $1) ON CONFLICT (k) DO NOTHING`, [crypto.randomBytes(32).toString('hex')]);
  const r = await L.q(`SELECT v FROM fu_meta WHERE k='master'`);
  return (MASTER = r[0].v);
}
async function keys(id) {
  const m = await master(); const { Keypair } = w3();
  const seed = tag => crypto.createHmac('sha256', m).update('funded:' + tag + ':' + id).digest();
  return { wallet: Keypair.fromSeed(seed('wallet')), mint: Keypair.fromSeed(seed('mint')) };
}
const newId = () => crypto.randomBytes(9).toString('base64url');

// ---------- prices ----------
async function solUsd() {
  return L.remember('solusd', 60000, async () => {
    if (L.MOCK && L.MOCK.solUsd) return L.MOCK.solUsd();
    try { const r = await L.getJson('https://api.coinbase.com/v2/prices/SOL-USD/spot', {}, 6000); const v = Number(r.json && r.json.data && r.json.data.amount); if (v > 0) return v; } catch {}
    const r = await L.getJson('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd', {}, 6000); const v = Number(r.json && r.json.solana && r.json.solana.usd);
    if (v > 0) return v; throw new Error('no SOL price');
  });
}
async function payMin() {
  try { const p = await solUsd(); return { lamports: Math.max(PAY_MIN_SOL_FLOOR, Math.ceil(PAY_MIN_USD / p * LAMPORTS)), usd: PAY_MIN_USD, solUsd: p }; }
  catch { return { lamports: 0.05 * LAMPORTS, usd: null, solUsd: null }; }
}
async function coinMarket(mint) {
  if (!L.isAddr(mint)) return { ok: false };
  return L.remember('cm:' + mint, 60000, async () => {
    try {
      const r = await L.getJson(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, {}, 7000);
      const ps = ((r.json && r.json.pairs) || []).filter(p => p.chainId === 'solana').sort((a, b) => ((b.liquidity || {}).usd || 0) - ((a.liquidity || {}).usd || 0));
      if (ps.length) { const p = ps[0]; return { ok: true, mcapUsd: Number(p.marketCap || p.fdv || 0) || null, priceUsd: Number(p.priceUsd) || null, complete: p.dexId !== 'pumpfun', ch1h: (p.priceChange || {}).h1 ?? null, ch24h: (p.priceChange || {}).h24 ?? null, vol24: (p.volume || {}).h24 ?? null }; }
    } catch {}
    try {
      const [bc] = await L.accounts([L.bondingCurveOf(mint)]);
      if (bc && bc.data.length >= 49) {
        const vTok = Number(bc.data.readBigUInt64LE(8)), vSol = Number(bc.data.readBigUInt64LE(16)), rTok = Number(bc.data.readBigUInt64LE(24)), supply = Number(bc.data.readBigUInt64LE(40)), complete = bc.data[48] === 1;
        const s = await solUsd().catch(() => null);
        const mcapSol = vTok ? (vSol / 1e9) * (supply / vTok) : null;
        return { ok: true, mcapUsd: mcapSol && s ? mcapSol * s : null, mcapSol, complete, progress: complete ? 1 : Math.max(0, Math.min(1, (793100000e6 - rTok) / 793100000e6)) };
      }
    } catch {}
    return { ok: false };
  });
}

// ---------- sending ----------
async function blockhash() { const r = await L.rpc('getLatestBlockhash', [{ commitment: 'confirmed' }]); return r.value; }
async function confirm(sig, ms = 40000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await L.rpc('getSignatureStatuses', [[sig], { searchTransactionHistory: false }]);
      const s = r.value && r.value[0];
      if (s) { if (s.err) return { ok: false, err: JSON.stringify(s.err) }; if (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized') return { ok: true }; }
    } catch {}
    await new Promise(r => setTimeout(r, 1500));
  }
  return { ok: false, err: 'not confirmed in time' };
}
async function sendRaw(bytes, skipPreflight = false) {
  const b64 = Buffer.from(bytes).toString('base64');
  const j = await L.rpcRaw('sendTransaction', [b64, { encoding: 'base64', skipPreflight, maxRetries: 3, preflightCommitment: 'confirmed' }], 20000);
  if (j.error) { const logs = j.error.data && j.error.data.logs; throw new Error((j.error.message || 'send failed') + (logs ? ' | ' + logs.slice(-3).join(' | ') : '')); }
  return j.result;
}
async function sendAndConfirm(bytes) { const sig = await sendRaw(bytes); const c = await confirm(sig); if (!c.ok) { const e = new Error(c.err); e.sig = sig; throw e; } return sig; }
async function sendIxs(payer, ixs) {
  const { Transaction, ComputeBudgetProgram } = w3();
  const bh = await blockhash();
  const tx = new Transaction({ feePayer: payer.publicKey, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight });
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50000 }), ...ixs); tx.sign(payer);
  return sendAndConfirm(tx.serialize());
}
// PumpPortal's local API writes the pump.fun transaction; we sign it here with the coin's own keys
async function portal(args, signers) {
  if (L.MOCK && L.MOCK.portal) return L.MOCK.portal(args, signers);
  const r = await fetch(PORTAL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(args), signal: AbortSignal.timeout(15000) });
  if (r.status !== 200) throw new Error('pumpportal ' + r.status + ': ' + (await r.text().catch(() => '')).slice(0, 160));
  const { VersionedTransaction } = w3();
  const tx = VersionedTransaction.deserialize(new Uint8Array(await r.arrayBuffer()));
  tx.sign(signers); return tx;
}

// ---------- reading a coin wallet ----------
async function mintInfo(mint) {
  return L.remember('mi:' + mint, 36e5, async () => { const [m] = await L.accounts([mint]); if (!m) throw new Error('mint not found'); return { program: m.owner, decimals: m.data[44] }; });
}
async function tokenBal(owner, mint) {
  const { program } = await mintInfo(mint); const [a] = await L.accounts([L.ataOf(owner, mint, program)]);
  return L.tokenAmount(a);
}
async function waiting(wallet) {   // creator fees waiting to be claimed, in lamports
  const v1 = L.creatorVaultOf(wallet), v2 = L.ammVaultOf(wallet);
  const [a, b] = await L.accounts([v1, L.ataOf(v2, L.SOL, L.TOKEN)]);
  return Math.max(0, (a ? a.lamports - L.RENT0 : 0)) + Number(L.tokenAmount(b));
}
async function chest(c) { return Math.max(0, (await L.balance(c.wallet)) - RESERVE); }

// ---------- the launch ----------
async function create(c) {
  const k = await keys(c.id);
  await L.log(c.id, 'launch', `deposit in. creating $${c.symbol} on pump.fun`);
  let sig;
  try {
    const tx = await portal({ publicKey: k.wallet.publicKey.toBase58(), action: 'create', tokenMetadata: { name: c.name, symbol: c.symbol, uri: c.meta_uri },
      mint: k.mint.publicKey.toBase58(), denominatedInSol: 'true', amount: c.dev_buy, slippage: 10, priorityFee: PRIORITY, pool: 'pump' }, [k.mint, k.wallet]);
    sig = await sendAndConfirm(tx.serialize());
  } catch (e) {
    const [bc] = await L.accounts([L.bondingCurveOf(c.mint)]).catch(() => [null]);
    if (!bc) {
      await L.q(`UPDATE fu_coins SET state='failed', err=$2 WHERE id=$1`, [c.id, String(e.message).slice(0, 300)]);
      await L.log(c.id, 'error', 'launch failed: ' + String(e.message).slice(0, 200), { sig: e.sig });
      await refund(c, 'launch failed, deposit returned');
      return { ok: false, error: String(e.message) };
    }
    sig = e.sig || null;
  }
  await L.q(`UPDATE fu_coins SET state='live', live_at=now(), create_sig=$2, err=NULL WHERE id=$1`, [c.id, sig]);
  await L.log(c.id, 'launch', `$${c.symbol} is live on pump.fun. its fees now fund @${c.trader}`, { sig });
  await handOut(c, k).catch(e => L.log(c.id, 'error', 'sending the first buy back failed: ' + String(e.message).slice(0, 160)));
  return { ok: true, sig };
}
// after launch: the launcher's first-buy tokens and any SOL beyond the reserve go back to the launcher's wallet
async function handOut(c, k) {
  k = k || await keys(c.id);
  const { PublicKey, SystemProgram } = w3(); const S = sp();
  const owner = k.wallet.publicKey, to = new PublicKey(c.launcher), mint = new PublicKey(c.mint);
  const { program, decimals } = await mintInfo(c.mint); const prog = new PublicKey(program);
  const ixs = [];
  const amt = await tokenBal(owner.toBase58(), c.mint);
  if (amt > 0n) {
    const src = new PublicKey(L.ataOf(owner.toBase58(), c.mint, program)), dst = new PublicKey(L.ataOf(c.launcher, c.mint, program));
    ixs.push(S.createAssociatedTokenAccountIdempotentInstruction(owner, dst, to, mint, prog), S.createTransferCheckedInstruction(src, mint, dst, owner, amt, decimals, [], prog));
  }
  const bal = await L.balance(owner.toBase58());
  const extra = bal - RESERVE - 0.0025 * LAMPORTS;
  if (extra > 0.002 * LAMPORTS) ixs.push(SystemProgram.transfer({ fromPubkey: owner, toPubkey: to, lamports: Math.floor(extra) }));
  if (!ixs.length) return null;
  const sig = await sendIxs(k.wallet, ixs);
  await L.q(`UPDATE fu_coins SET out_sig=$2 WHERE id=$1`, [c.id, sig]);
  await L.log(c.id, 'launch', `first buy${extra > 0.002 * LAMPORTS ? ' and unused SOL' : ''} sent back to the launcher`, { sig, sol: extra > 0 ? extra / LAMPORTS : null });
  return sig;
}
async function refund(c, why) {
  const k = await keys(c.id); const { SystemProgram, PublicKey } = w3();
  const bal = await L.balance(k.wallet.publicKey.toBase58());
  const amt = bal - 10000;
  if (amt <= 0) return null;
  try {
    const sig = await sendIxs(k.wallet, [SystemProgram.transfer({ fromPubkey: k.wallet.publicKey, toPubkey: new PublicKey(c.launcher), lamports: amt })]);
    await L.q(`UPDATE fu_coins SET refund_sig=$2, state=CASE WHEN state='live' THEN state ELSE 'refunded' END WHERE id=$1`, [c.id, sig]);
    await L.log(c.id, 'refund', why, { sig, sol: amt / LAMPORTS });
    return sig;
  } catch (e) { await L.log(c.id, 'error', 'refund failed, will retry: ' + String(e.message).slice(0, 160)); return null; }
}
// one coin per trader: the first launch that is funded takes the trader; a later one is refunded
async function takenBy(c) {
  const r = await L.q(`SELECT id, symbol, mint FROM fu_coins WHERE trader_key=$1 AND id<>$2 AND state IN ('creating','live') LIMIT 1`, [c.trader_key, c.id]);
  return r[0] || null;
}
async function advance(c) {
  if (c.state === 'waiting') {
    const bal = await L.balance(c.wallet);
    if (bal >= Number(c.need) * 0.995) {
      const other = await takenBy(c);
      if (other) {
        await L.q(`UPDATE fu_coins SET state='failed', err=$2 WHERE id=$1 AND state='waiting'`, [c.id, `@${c.trader} was funded first by $${other.symbol}`]);
        await refund(c, `@${c.trader} already has a coin ($${other.symbol}); deposit returned`);
        return { ok: true, state: 'failed' };
      }
      const got = await L.q(`UPDATE fu_coins SET state='creating', ticked_at=now() WHERE id=$1 AND state='waiting' RETURNING *`, [c.id]);
      if (got.length) return create(got[0]);
    } else if (Date.now() - new Date(c.created_at) > 3 * 36e5) {
      await L.q(`UPDATE fu_coins SET state='expired' WHERE id=$1 AND state='waiting'`, [c.id]);
      if (bal > 10000) await refund({ ...c, state: 'expired' }, 'never fully funded, deposit returned');
    }
    return { ok: true, state: 'waiting', balance: bal };
  }
  if (c.state === 'creating' && Date.now() - new Date(c.ticked_at || c.created_at) > 4 * 6e4) {
    const [bc] = await L.accounts([L.bondingCurveOf(c.mint)]);
    if (bc) await L.q(`UPDATE fu_coins SET state='live', live_at=COALESCE(live_at, now()) WHERE id=$1`, [c.id]);
    else { await L.q(`UPDATE fu_coins SET state='failed', err='creation did not land' WHERE id=$1`, [c.id]); await refund(c, 'launch did not land, deposit returned'); }
  }
  if ((c.state === 'expired' || c.state === 'failed') && !c.refund_sig) { const bal = await L.balance(c.wallet); if (bal > 10000) await refund(c, 'deposit returned'); }
  return { ok: true, state: c.state };
}

// ---------- fees ----------
async function claim(c, k) {
  const w = await waiting(c.wallet);
  if (w < CLAIM_MIN) return 0;
  const before = await L.balance(c.wallet);
  const tx = await portal({ publicKey: c.wallet, action: 'collectCreatorFee', priorityFee: 0.00001, pool: 'pump' }, [k.wallet]);
  const sig = await sendAndConfirm(tx.serialize());
  const got = Math.max(0, (await L.balance(c.wallet)) - before);
  if (got <= 0) return 0;
  await L.q(`UPDATE fu_coins SET claimed = claimed + $2 WHERE id=$1`, [c.id, got]);
  await L.log(c.id, 'claim', `claimed ${(got / LAMPORTS).toFixed(4)} SOL of creator fees`, { sig, sol: got / LAMPORTS });
  return got;
}

// ---------- the payout: to the trader's Polymarket deposit address (and 10% to the $FUNDED treasury) ----------
async function payout(c, k, min) {
  const pot = await chest(c);
  if (pot < min.lamports) return { paid: false, pot };
  const svm = await P.depositAddress(c.trader_wallet);           // asked fresh from Polymarket's bridge before every payout
  if (svm !== c.deposit_svm) { await L.q(`UPDATE fu_coins SET deposit_svm=$2 WHERE id=$1`, [c.id, svm]); if (c.deposit_svm) await L.log(c.id, 'note', `Polymarket's bridge now gives @${c.trader} the deposit address ${svm}`); }
  const { PublicKey, SystemProgram } = w3();
  const cut = L.TREASURY && L.isAddr(L.TREASURY) ? Math.floor(pot * L.CUT_BPS / 1e4) : 0;
  const toTrader = pot - cut;
  const ixs = [SystemProgram.transfer({ fromPubkey: k.wallet.publicKey, toPubkey: new PublicKey(svm), lamports: toTrader })];
  if (cut > 0) ixs.push(SystemProgram.transfer({ fromPubkey: k.wallet.publicKey, toPubkey: new PublicKey(L.TREASURY), lamports: cut }));
  const sig = await sendIxs(k.wallet, ixs);
  await L.q(`INSERT INTO fu_pay (id, to_addr, lamports, cut, sig, sol_usd) VALUES ($1,$2,$3,$4,$5,$6)`, [c.id, svm, toTrader, cut, sig, min.solUsd]);
  await L.q(`UPDATE fu_coins SET paid = paid + $2, cut = cut + $3, payouts = payouts + 1, last_pay_at = now() WHERE id=$1`, [c.id, toTrader, cut]);
  const usd = min.solUsd ? ` (~$${(toTrader / LAMPORTS * min.solUsd).toFixed(2)})` : '';
  await L.log(c.id, 'pay', `sent ${(toTrader / LAMPORTS).toFixed(4)} SOL${usd} to @${c.trader}'s Polymarket deposit address${cut ? `; ${(cut / LAMPORTS).toFixed(4)} SOL to the $FUNDED treasury` : ''}`, { sig, sol: toTrader / LAMPORTS });
  return { paid: true, sig, lamports: toTrader, cut };
}
// a trader who asked to be left out: their coin's fees buy that coin back and burn it instead
async function burnOut(c, k) {
  const pot = await chest(c);
  if (pot < 0.01 * LAMPORTS) return null;
  const before = await tokenBal(c.wallet, c.mint).catch(() => 0n);
  const tx = await portal({ publicKey: c.wallet, action: 'buy', mint: c.mint, denominatedInSol: 'true', amount: +(pot / LAMPORTS).toFixed(6), slippage: 15, priorityFee: PRIORITY, pool: 'auto' }, [k.wallet]);
  const sig = await sendAndConfirm(tx.serialize());
  const got = (await tokenBal(c.wallet, c.mint)) - before;
  if (got <= 0n) return sig;
  const { PublicKey } = w3(); const S = sp(); const { program, decimals } = await mintInfo(c.mint);
  const s2 = await sendIxs(k.wallet, [S.createBurnCheckedInstruction(new PublicKey(L.ataOf(c.wallet, c.mint, program)), new PublicKey(c.mint), k.wallet.publicKey, got, decimals, [], new PublicKey(program))]);
  await L.q(`UPDATE fu_coins SET burned = burned + $2 WHERE id=$1`, [c.id, pot]);
  await L.log(c.id, 'burn', `@${c.trader} opted out, so ${(pot / LAMPORTS).toFixed(4)} SOL bought $${c.symbol} back and burned it`, { sig: s2, sol: pot / LAMPORTS });
  return s2;
}

async function tickCoin(c, min) {
  const k = await keys(c.id);
  if (k.wallet.publicKey.toBase58() !== c.wallet) throw new Error('key mismatch');
  try { await claim(c, k); } catch (e) { await L.log(c.id, 'error', 'claim failed: ' + String(e.message).slice(0, 160)); }
  const m = await coinMarket(c.mint).catch(() => ({ ok: false }));
  if (m.ok) await L.q(`UPDATE fu_coins SET mcap_usd=$2, complete=$3 WHERE id=$1`, [c.id, m.mcapUsd, !!m.complete]);
  if (L.OPTED_OUT.has(c.trader_key)) { try { await burnOut(c, k); } catch (e) { await L.log(c.id, 'error', 'buyback failed: ' + String(e.message).slice(0, 160)); } }
  else { try { await payout(c, k, min); } catch (e) { await L.log(c.id, 'error', 'payout waits: ' + String(e.message).slice(0, 160), { sig: e.sig }); } }
  await L.q(`UPDATE fu_coins SET ticked_at=now() WHERE id=$1`, [c.id]);
}

async function tick(budgetMs = 40000) {
  await L.ready();
  const lock = await L.q(`INSERT INTO fu_meta (k, v) VALUES ('tick', $1) ON CONFLICT (k) DO UPDATE SET v=EXCLUDED.v WHERE fu_meta.v::bigint < $2 RETURNING v`, [String(Date.now()), Date.now() - 50000]);
  if (!lock.length) return { ok: true, skipped: 'another tick is running or ran under a minute ago' };
  const deadline = Date.now() + budgetMs; const done = { launches: 0, coins: 0, errors: 0 };
  const pend = await L.q(`SELECT * FROM fu_coins WHERE state IN ('waiting','creating') OR (state IN ('expired','failed') AND refund_sig IS NULL) ORDER BY created_at LIMIT 20`);
  for (const c of pend) { if (Date.now() > deadline) break; try { await advance(c); done.launches++; } catch { done.errors++; } }
  const min = await payMin();
  const live = await L.q(`SELECT * FROM fu_coins WHERE state='live' ORDER BY ticked_at NULLS FIRST LIMIT 30`);
  for (const c of live) { if (Date.now() > deadline - 8000) break; try { await tickCoin(c, min); done.coins++; } catch (e) { done.errors++; await L.log(c.id, 'error', 'tick: ' + String(e.message).slice(0, 160)); } }
  return { ok: true, ...done, payMinSol: +(min.lamports / LAMPORTS).toFixed(4), at: new Date().toISOString() };
}

module.exports = { keys, newId, need, advance, tick, blockhash, sendRaw, confirm, portal, waiting, chest, coinMarket, solUsd, payMin, RESERVE, CREATE_COST, MIN_DEV, MAX_DEV, LAMPORTS, PAY_MIN_USD };
