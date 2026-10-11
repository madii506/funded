/* FUNDED: one terminal, many screens. Every number on it is read live from Polymarket, Solana or the engine's own records. */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const REDUCE = matchMedia('(prefers-reduced-motion: reduce)').matches;

async function api(path, opt = {}) {
  try { const r = await fetch(path, { ...opt, signal: AbortSignal.timeout(opt.ms || 20000) }); return await r.json(); }
  catch (e) { return { ok: false, error: 'The server didn’t answer. Check your connection and try again.' }; }
}
const post = (path, body) => api(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ms: 60000 });

// ---------- formatting ----------
const usd = (n, sign = false) => {
  if (n == null || !Number.isFinite(+n)) return '—';
  n = +n; const a = Math.abs(n), s = n < 0 ? '-' : sign ? '+' : '';
  if (a >= 1e9) return s + '$' + (a / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return s + '$' + (a / 1e6).toFixed(2) + 'M';
  if (a >= 1e4) return s + '$' + Math.round(a).toLocaleString('en-US');
  return s + '$' + a.toLocaleString('en-US', { maximumFractionDigits: a < 10 ? 2 : 0, minimumFractionDigits: a < 10 && a > 0 ? 2 : 0 });
};
const pnl = n => n == null ? '<span class="mute">—</span>' : `<span class="${n >= 0 ? 'g' : 'r'}">${usd(n, true)}</span>`;
const sol = n => n == null ? '—' : (+n).toFixed(+n >= 100 ? 1 : 4) + ' SOL';
const short = (a, n = 4) => a ? String(a).slice(0, n) + '…' + String(a).slice(-n) : '';
function ago(t) {
  if (!t) return '—'; const s = Math.max(0, (Date.now() - new Date(t).getTime()) / 1000);
  if (s < 60) return Math.floor(s) + 's'; if (s < 3600) return Math.floor(s / 60) + 'm'; if (s < 86400) return Math.floor(s / 3600) + 'h'; return Math.floor(s / 86400) + 'd';
}
const tx = s => 'https://solscan.io/tx/' + s;
const acct = a => 'https://solscan.io/account/' + a;
const poly = u => 'https://polymarket.com/@' + encodeURIComponent(u);
const ext = (href, label, cls = 'b sm') => `<a class="${cls}" href="${esc(href)}" target="_blank" rel="noopener">${label}</a>`;
function bar(v, max, w = 18) {
  if (!(v > 0) || !(max > 0)) return `<span class="barc"><i>${'░'.repeat(w)}</i></span>`;
  const k = Math.max(1, Math.round(Math.min(1, v / max) * w));
  return `<span class="barc">${'█'.repeat(k)}<i>${'░'.repeat(w - k)}</i></span>`;
}
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('on'), 2200); }
async function copy(text, what = 'Copied') { try { await navigator.clipboard.writeText(text); toast(what); } catch { toast('Copy failed'); } }
document.addEventListener('click', e => { const b = e.target.closest('[data-copy]'); if (b) { e.preventDefault(); copy(b.dataset.copy, b.dataset.what || 'Copied'); } });
const win = (title, inner, cls = '') => `<div class="win ${cls}"><span class="t">${esc(title)}</span><span class="c1">+</span><span class="c2">+</span>${inner}</div>`;

const LOGO = `███████╗██╗   ██╗███╗   ██╗██████╗ ███████╗██████╗
██╔════╝██║   ██║████╗  ██║██╔══██╗██╔════╝██╔══██╗
█████╗  ██║   ██║██╔██╗ ██║██║  ██║█████╗  ██║  ██║
██╔══╝  ██║   ██║██║╚██╗██║██║  ██║██╔══╝  ██║  ██║
██║     ╚██████╔╝██║ ╚████║██████╔╝███████╗██████╔╝
╚═╝      ╚═════╝ ╚═╝  ╚═══╝╚═════╝ ╚══════╝╚═════╝`;

// ---------- shared reads ----------
let CONFIG = null;
const config = async () => CONFIG || (CONFIG = await api('/api/launch?op=config').then(j => (j && j.ok ? j : { ok: false })));
const stats = () => api('/api/coins?op=stats');

// pictures as ascii: sample the image into a grid and map brightness onto characters
async function asciiArt(src, cols = 40) {
  const rows = Math.round(cols * 0.55);
  const img = new Image(); img.crossOrigin = 'anonymous'; img.src = src;
  await img.decode();
  const c = document.createElement('canvas'); c.width = cols; c.height = rows;
  const x = c.getContext('2d', { willReadFrequently: true });
  x.drawImage(img, 0, 0, cols, rows);
  const d = x.getImageData(0, 0, cols, rows).data, ramp = ' .:-=+*#%@';
  let out = '';
  for (let y = 0; y < rows; y++) { for (let i = 0; i < cols; i++) { const k = (y * cols + i) * 4; const l = (0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2]) / 255; out += ramp[Math.min(ramp.length - 1, Math.floor(l * ramp.length))]; } out += '\n'; }
  return out;
}
function paintArt(root = document) {
  $$('[data-art]', root).forEach(async el => { if (el.dataset.done) return; el.dataset.done = 1; try { el.textContent = await asciiArt(el.dataset.art, +el.dataset.cols || 40); } catch { el.textContent = ''; } });
}

// ---------- wallets ----------
const wallets = () => [
  { id: 'phantom', name: 'Phantom', p: (window.phantom && window.phantom.solana) || (window.solana && window.solana.isPhantom ? window.solana : null) },
  { id: 'solflare', name: 'Solflare', p: window.solflare && window.solflare.isSolflare ? window.solflare : null },
  { id: 'backpack', name: 'Backpack', p: window.backpack && (window.backpack.solana || window.backpack) },
].filter(w => w.p);
let WAL = null;
async function connect() {
  const ws = wallets();
  if (!ws.length) { toast('No Solana wallet found in this browser'); return null; }
  const w = ws[0];
  try { const r = await w.p.connect(); const pk = (r && r.publicKey) || w.p.publicKey; WAL = { ...w, pk: pk.toString() }; try { localStorage.setItem('funded:w', w.id); } catch {} paintWallet(); return WAL; }
  catch { toast('Wallet connection was cancelled'); return null; }
}
function paintWallet() {
  $$('[data-connect]').forEach(b => { b.innerHTML = WAL ? '<span class="dot"></span>&nbsp;' + short(WAL.pk) : 'connect'; });
  const f = $('#launcher'); if (f && WAL && !f.value) f.value = WAL.pk;
}
document.addEventListener('click', e => { const b = e.target.closest('[data-connect]'); if (b) { e.preventDefault(); if (WAL) copy(WAL.pk, 'Address copied'); else connect(); } });
(async () => { await sleep(400); try { const id = localStorage.getItem('funded:w'); const w = wallets().find(x => x.id === id); if (w) { const r = await w.p.connect({ onlyIfTrusted: true }); const pk = (r && r.publicKey) || w.p.publicKey; if (pk) { WAL = { ...w, pk: pk.toString() }; paintWallet(); } } } catch {} })();

// ---------- the engine: every visit nudges it, at most once a minute per browser ----------
(function nudge() { try { const t = +localStorage.getItem('funded:nudge') || 0; if (Date.now() - t < 60000) return; localStorage.setItem('funded:nudge', String(Date.now())); } catch {} fetch('/api/tick', { keepalive: true }).catch(() => {}); })();

// ---------- the tape: today's leaderboard ----------
async function tape() {
  const j = await api('/api/poly?op=top&period=DAY&limit=25');
  const run = $('#tapeRun');
  if (!j.ok || !j.list.length) { run.innerHTML = '<span class="mute">polymarket’s leaderboard didn’t answer. it will be back.</span>'; return; }
  const items = j.list.map(x => `<span><a href="/t/${encodeURIComponent(x.user)}" data-go>#${x.rank} @${esc(x.user)}</a> ${pnl(x.pnl)}${x.coin ? ` <a href="/c/${esc(x.coin.mint)}" data-go class="g">$${esc(x.coin.symbol)}</a>` : ''}</span>`).join('');
  run.innerHTML = `<span class="mute">polymarket today ›</span>` + items + items;
}

// ---------- router ----------
const ROUTES = [
  [/^\/$/, () => home()],
  [/^\/top$/, (m, q) => top(q)],
  [/^\/markets$/, (m, q) => markets(q)],
  [/^\/t\/([^/]+)$/, m => trader(decodeURIComponent(m[1]))],
  [/^\/launch$/, (m, q) => launch(q)],
  [/^\/c\/([1-9A-HJ-NP-Za-km-z]{32,44})$/, m => coin(m[1])],
  [/^\/coins$/, () => coins()],
  [/^\/ledger$/, () => ledger()],
  [/^\/how$/, () => how()],
  [/^\/token$/, () => token()],
];
let VIEW = 0;
async function route() {
  const path = location.pathname.replace(/\/+$/, '') || '/', q = new URLSearchParams(location.search);
  const mine = ++VIEW; stopTimers();
  $$('#menu a').forEach(a => a.classList.toggle('on', path === '/' + a.dataset.r || (a.dataset.r === 'top' && path.startsWith('/t/')) || (a.dataset.r === 'coins' && path.startsWith('/c/'))));
  const hit = ROUTES.find(([re]) => re.test(path));
  const screen = $('#screen');
  if (!hit) { screen.innerHTML = notFound(); return; }
  screen.innerHTML = '<div class="boot"><div>&gt; loading<span class="cur"></span></div></div>';
  try { await hit[1](path.match(hit[0]), q, () => mine === VIEW); }
  catch (e) { if (mine === VIEW) screen.innerHTML = `<div class="msg bad">this screen broke: ${esc(e && e.message)}. <a class="u" href="/" data-go>go home</a></div>`; }
  window.scrollTo(0, 0);
}
function go(href) { if (href === location.pathname + location.search) return route(); history.pushState(null, '', href); route(); }
document.addEventListener('click', e => {
  const a = e.target.closest('a[href]'); if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || a.target === '_blank') return;
  const href = a.getAttribute('href'); if (!href || !href.startsWith('/') || href.startsWith('//') || /^\/(api|m|i|assets)\//.test(href)) return;
  e.preventDefault(); closeOut(); go(href);
});
document.addEventListener('click', e => { const r = e.target.closest('tr[data-href],.ld[data-href]'); if (r && !e.target.closest('a,button')) { closeOut(); go(r.dataset.href); } });
addEventListener('popstate', route);
let TIMERS = [];
const every = (fn, ms) => { TIMERS.push(setInterval(fn, ms)); };
function stopTimers() { TIMERS.forEach(clearInterval); TIMERS = []; }
const set = html => { const s = $('#screen'); s.innerHTML = `<div class="in">${html}</div>`; paintArt(s); return s; };

// ---------- 1. home ----------
async function home() {
  set(`<pre class="big" aria-label="FUNDED">${LOGO}</pre>
  <p class="lead">launch a pump.fun coin on any polymarket trader.<br>its fees land in their polymarket balance, ready for the next bet. nothing to claim.</p>
  <div class="boot" id="boot"></div>
  ${win('fund a trader', `<form id="fundForm" class="big-in" autocomplete="off"><span class="ps">$ fund @</span><input id="fundIn" placeholder="username" spellcheck="false" autocapitalize="off" aria-label="Polymarket username"><button class="b p" type="submit">look up</button></form>
    <div class="sugg" id="sugg"><span class="mute">reading today’s leaderboard…</span></div>`, 'solid')}
  <div class="strip" id="strip">${['coins live', 'paid to traders', 'payouts', 'traders funded', 'sol price', 'payout at'].map(l => `<div><span class="l">${l}</span><span class="v mute">…</span></div>`).join('')}</div>
  <section class="sec"><div class="hd"><h2>how it works</h2><a class="b sm" href="/how" data-go>the full manual</a></div>
    <div class="hsteps">
      <div><span class="no">01</span><span class="ti">pick a trader</span><p>anyone on polymarket. browse the leaderboards, the markets, or type a username.</p><pre>$ fund @username</pre></div>
      <div><span class="no">02</span><span class="ti">launch their coin</span><p>name it, add a picture, put in a first buy. the engine creates it on pump.fun. one coin per trader.</p><pre>[x] coin created</pre></div>
      <div><span class="no">03</span><span class="ti">people trade it</span><p>every trade pays pump.fun’s creator fee into the coin’s wallet. the engine claims it.</p><pre>fees ▸ coin wallet</pre></div>
      <div><span class="no">04</span><span class="ti">the trader gets paid</span><p>at about $6 the fees go to polymarket’s deposit address for that trader and land in their balance.</p><pre>▸ polymarket balance</pre></div>
    </div></section>
  <section class="sec"><div class="hd"><h2>the money path</h2><span class="mute">every arrow is a public transaction</span></div><pre class="path" id="path"></pre></section>
  <section class="sec"><div class="hd"><h2>who’s winning where</h2><span class="mute">today’s #1 in every polymarket category</span></div><div class="leaders" id="leaders"><div class="empty">reading the category boards…</div></div></section>
  <section class="sec grid2">
    <div><div class="hd"><h2>top today</h2><a class="b sm" href="/top" data-go>full board</a></div><div class="tw" id="topMini"><div class="empty">reading polymarket…</div></div></div>
    <div><div class="hd"><h2>latest payouts</h2><a class="b sm" href="/ledger" data-go>ledger</a></div><div id="pays"><div class="empty">reading the ledger…</div></div>
      <div class="hd" style="margin-top:28px"><h2>whales by volume</h2><a class="b sm" href="/top?p=DAY&c=OVERALL&o=VOL" data-go>by volume</a></div><div class="tw" id="whales"><div class="empty">reading…</div></div></div>
  </section>
  <section class="sec"><div class="hd"><h2>hot markets</h2><a class="b sm" href="/markets" data-go>all markets</a></div><div class="mks" id="mksHome"><div class="empty">reading polymarket’s busiest markets…</div></div></section>
  <section class="sec"><div class="hd"><h2>coins on funded</h2><a class="b sm" href="/coins" data-go>all coins</a></div><div id="cardsHome"><div class="empty">reading the coins…</div></div></section>
  <section class="sec"><div class="hd"><h2>why funded</h2></div><div class="why">
    <div>${win('nothing to claim', `<p>other fee pads pay a wallet, an x account or a telegram username, and someone has to claim it. funded pays polymarket’s own deposit address for the trader. it lands in their balance. they don’t sign up, they don’t click anything.</p>`)}</div>
    <div>${win('one coin per trader', `<p>the first funded launch takes the trader, and the trader is written into the coin’s description where nobody can change it. a second coin for the same trader is refunded. no copies.</p>`)}</div>
    <div>${win('every lamport on-chain', `<p>every fee claim and every payout is a solana transaction linked from the coin’s page and the ledger. the engine has no sell action and no withdraw action.</p>`)}</div>
  </div></section>
  <section class="sec"><div class="hd"><h2>questions</h2><a class="b sm" href="/how" data-go>all answers</a></div>
    <details class="q" style="margin-left:0"><summary>does the trader have to do anything?</summary><p>no. the payout goes to the solana deposit address polymarket’s own bridge gives their wallet. polymarket swaps it and credits it to their balance.</p></details>
    <details class="q" style="margin-left:0"><summary>who gets what?</summary><p id="qSplit">the trader gets the coin’s creator fees. the launcher gets the first-buy tokens.</p></details>
    <details class="q" style="margin-left:0"><summary>what if a trader doesn’t want it?</summary><p>one message and their payouts stop for good. from then on that coin’s fees buy it back and burn it.</p></details>
    <details class="q" style="margin-left:0"><summary>is this polymarket or pump.fun?</summary><p>neither. funded uses their public apis and programs like anyone can. no trader on this site has endorsed anything.</p></details>
  </section>`);
  $('#fundForm').addEventListener('submit', e => { e.preventDefault(); const u = $('#fundIn').value.trim().replace(/^@/, ''); if (u) go('/t/' + encodeURIComponent(u)); });

  const cfg = await config();
  $('#path').innerHTML = moneyPath(cfg);
  if (cfg.ok) $('#qSplit').textContent = cfg.cutTaken ? 'the trader gets 90% of the coin’s creator fees, the $FUNDED treasury 10%. the launcher gets the first-buy tokens.' : 'the trader gets 100% of the coin’s creator fees while no treasury is set. the launcher gets the first-buy tokens.';
  const lines = [];
  const boot = $('#boot');
  const line = (k, v, cls = 'v') => { const dots = '.'.repeat(Math.max(2, (innerWidth < 600 ? 26 : 34) - k.length)); const d = document.createElement('div'); d.innerHTML = `&gt; ${esc(k)} <span class="mute">${dots}</span> <span class="${cls}">${v}</span>`; if (!REDUCE) d.style.visibility = 'hidden'; boot.appendChild(d); lines.push(d); };
  const [top, st, led, cs, vol] = await Promise.all([api('/api/poly?op=top&period=DAY&limit=10'), stats(), api('/api/coins?op=ledger'), api('/api/coins'), api('/api/poly?op=top&period=DAY&order=VOL&limit=5')]);
  const strip = vals => { $('#strip').innerHTML = vals.map(([l, v, c]) => `<div><span class="l">${l}</span><span class="v ${c || ''}">${v}</span></div>`).join(''); };
  const live = st.ok && !st.offline;
  strip([['coins live', live ? st.live : '—'], ['paid to traders', live ? sol(st.paidSol) : '—', live && st.paidSol > 0 ? 'g' : ''], ['payouts', live ? st.payouts : '—'], ['traders funded', live ? st.traders : '—'],
    ['sol price', cfg.solUsd ? '$' + (+cfg.solUsd).toFixed(2) : '—'], ['payout at', cfg.payMinSol ? cfg.payMinSol + ' SOL' : '—']]);
  if (top.ok && top.list.length) {
    line('polymarket leaderboard', `ok <span class="dim">(${top.list.length} traders read)</span>`, 'ok');
    const t0 = top.list[0]; line('top trader today', `<a href="/t/${encodeURIComponent(t0.user)}" data-go>@${esc(t0.user)}</a> ${pnl(t0.pnl)}`);
    $('#sugg').innerHTML = '<span class="mute">today’s top:</span> ' + top.list.slice(0, 8).map(x => `<a href="/t/${encodeURIComponent(x.user)}" data-go>@${esc(x.user)}</a>`).join(' ');
    const max = Math.max(...top.list.map(x => x.pnl || 0));
    $('#topMini').innerHTML = `<table class="t"><thead><tr><th>#</th><th>trader</th><th class="n">p&amp;l today</th><th></th></tr></thead><tbody>${top.list.map(x => `<tr class="click" data-href="/t/${encodeURIComponent(x.user)}"><td class="mute">${x.rank}</td><td>@${esc(x.user)}${x.coin ? ` <span class="g">$${esc(x.coin.symbol)}</span>` : ''}</td><td class="n">${pnl(x.pnl)}</td><td>${bar(x.pnl, max, 12)}</td></tr>`).join('')}</tbody></table>`;
  } else { line('polymarket leaderboard', 'offline right now', 'r'); $('#sugg').innerHTML = '<span class="mute">the leaderboard didn’t answer. type any username.</span>'; $('#topMini').innerHTML = '<div class="empty">polymarket didn’t answer just now.</div>'; }
  if (vol.ok && vol.list.length) { const mv = Math.max(...vol.list.map(x => x.vol || 0)); $('#whales').innerHTML = `<table class="t"><tbody>${vol.list.map(x => `<tr class="click" data-href="/t/${encodeURIComponent(x.user)}"><td>@${esc(x.user)}</td><td class="n">${usd(x.vol)}</td><td>${bar(x.vol, mv, 10)}</td></tr>`).join('')}</tbody></table>`; }
  else $('#whales').innerHTML = '<div class="empty">didn’t load.</div>';
  if (live) {
    line('coins on funded', String(st.live));
    line('paid to traders', `${sol(st.paidSol)} <span class="dim">in ${st.payouts} payout${st.payouts === 1 ? '' : 's'}</span>`);
    line('engine', st.lastTick ? `last pass ${ago(st.lastTick)} ago` : 'waiting for its first pass');
  } else line('engine records', st.offline ? 'not connected yet' : 'didn’t answer', 'r');
  if (top.ok && top.list.length) {
    const t = await api('/api/poly?op=trader&u=' + encodeURIComponent(top.list[0].user));
    if (t.ok && t.deposit) line('polymarket deposit bridge', `ok <span class="dim">(@${esc(t.trader.user)} → ${short(t.deposit)})</span>`, 'ok');
    else line('polymarket deposit bridge', 'didn’t answer', 'r');
  }
  const cur = document.createElement('div'); cur.innerHTML = '&gt; <span class="cur"></span>'; boot.appendChild(cur);
  const reveal = (async () => { if (!REDUCE) for (const d of lines) { d.style.visibility = ''; d.classList.add('in'); await sleep(110); } })();

  const L = (led.ok && led.ledger) || [];
  $('#pays').innerHTML = L.length ? `<div class="feed">${L.slice(0, 6).map(p => `<div class="it"><span class="at">${ago(p.at)}</span><span><a href="/c/${esc(p.mint)}" data-go>$${esc(p.symbol)}</a> → <a href="/t/${encodeURIComponent(p.trader)}" data-go>@${esc(p.trader)}</a> <span class="g">${sol(p.sol)}</span>${p.usd ? ` <span class="dim">~${usd(p.usd)}</span>` : ''}</span><a class="tx" href="${tx(p.sig)}" target="_blank" rel="noopener">tx ↗</a></div>`).join('')}</div>`
    : `<div class="empty"><b>no payouts yet.</b> the first one goes out when a coin’s fees reach ${cfg.payMinSol ? cfg.payMinSol + ' SOL' : 'the payout minimum'}.</div>`;
  const C = (cs.ok && cs.coins) || [];
  $('#cardsHome').innerHTML = C.length ? cards(C.slice(0, 6)) : `<div class="empty"><b>no coins yet.</b> the first trader to be funded is whoever you pick. <a class="b sm" href="/launch" data-go>launch one</a></div>`;
  paintArt($('#cardsHome'));
  api('/api/poly?op=cats').then(j => {
    const el = $('#leaders'); if (!el) return;
    if (!j.ok) { el.innerHTML = '<div class="empty">the category boards didn’t answer.</div>'; return; }
    el.innerHTML = j.list.map(x => x.user ? `<div class="ld" data-href="/t/${encodeURIComponent(x.user)}"><span class="c">${esc(x.cat.toLowerCase())}</span><span class="u">@${esc(x.user)}</span><span>${pnl(x.pnl)} <span class="mute">today</span></span><span>${x.coin ? `<a class="g" href="/c/${esc(x.coin.mint)}" data-go>$${esc(x.coin.symbol)}</a>` : `<a class="b sm" href="/launch?u=${encodeURIComponent(x.user)}" data-go>fund</a>`}</span></div>`
      : `<div class="ld"><span class="c">${esc(x.cat.toLowerCase())}</span><span class="mute">nobody yet today</span></div>`).join('');
  });
  api('/api/poly?op=markets&limit=4').then(j => { const el = $('#mksHome'); if (!el) return; el.innerHTML = j.ok && j.list.length ? j.list.map(marketCard).join('') : '<div class="empty">polymarket’s markets didn’t answer just now.</div>'; });
  await reveal;
}
function oddsBar(p, w = innerWidth < 600 ? 18 : 40) { const k = Math.max(0, Math.min(w, Math.round(p * w))); return `<span class="oddsbar">${'█'.repeat(k)}<i>${'░'.repeat(w - k)}</i></span>`; }
function marketCard(m) {
  const end = m.end ? new Date(m.end) : null;
  return `<div class="mk" data-cond="${esc(m.cond)}"><div class="q"><a class="u" href="https://polymarket.com/event/${esc(m.slug)}" target="_blank" rel="noopener">${esc(m.question)}</a></div>
    <div class="meta"><span>24h volume ${usd(m.vol24)}</span><span>total ${usd(m.vol)}</span>${end && !isNaN(end) ? `<span>ends ${end.toISOString().slice(0, 10)}</span>` : ''}${m.n > 1 ? `<span>${m.n} markets in this event</span>` : ''}</div>
    <div class="odds">${m.outcomes.map((o, i) => `<span class="o">${esc(o)}</span>${oddsBar(m.prices[i])}<span class="p">${Math.round(m.prices[i] * 100)}¢</span>`).join('')}</div>
    <div class="cta" style="margin-top:10px"><button class="b sm" type="button" data-holders="${esc(m.cond)}" data-outs="${esc(JSON.stringify(m.outcomes))}">who’s betting big</button></div><div class="holdbox"></div></div>`;
}
document.addEventListener('click', async e => {
  const b = e.target.closest('[data-holders]'); if (!b) return;
  const box = b.closest('.mk').querySelector('.holdbox'); if (box.dataset.open) { box.innerHTML = ''; delete box.dataset.open; b.textContent = 'who’s betting big'; return; }
  box.dataset.open = 1; b.textContent = 'hide'; box.innerHTML = '<div class="hint">reading the biggest holders…</div>';
  const outs = JSON.parse(b.dataset.outs || '[]');
  const j = await api('/api/poly?op=holders&cond=' + encodeURIComponent(b.dataset.holders));
  if (!j.ok) { box.innerHTML = `<div class="hint r">${esc(j.error || 'didn’t load')}</div>`; return; }
  const by = [0, 1].map(i => j.sides.flatMap(s => s.holders).filter(h => h.side === i).sort((a, c) => (c.amount || 0) - (a.amount || 0)).slice(0, 5));
  box.innerHTML = `<div class="hold">${by.map((hs, i) => `<div><div class="hint" style="margin:0 0 4px">biggest on ${esc(outs[i] || (i ? 'no' : 'yes'))}</div>${hs.length ? hs.map(h => `<div class="h"><a href="/t/${encodeURIComponent(h.user)}" data-go>@${esc(h.user)}</a><span class="a">${Math.round(h.amount || 0).toLocaleString('en-US')} shares</span>${h.coin ? `<a class="g" href="/c/${esc(h.coin.mint)}" data-go>$${esc(h.coin.symbol)}</a>` : `<a class="b sm" href="/launch?u=${encodeURIComponent(h.user)}" data-go>fund</a>`}</div>`).join('') : '<div class="hint">nobody public</div>'}</div>`).join('')}</div>`;
});
function moneyPath(cfg) {
  const cut = cfg && cfg.cutTaken;
  return `  people trade <span class="h">$COIN</span> on pump.fun
        │
        ▼  <span class="dim">creator fees, paid by pump.fun to the coin's creator wallet</span>
  ┌─────────────────────────────┐
  │ <span class="h">FUNDED engine</span>               │  claims the fees and waits until there's
  │ <span class="dim">holds the creator wallet</span>    │  at least ${cfg && cfg.payMinSol ? cfg.payMinSol + ' SOL (~$' + (cfg.payMinUsd || 6) + ')' : '~$6'} to send
  └─────────────────────────────┘
        │ <span class="m">${cut ? '90%' : '100%'}</span>${cut ? `                          │ <span class="h">10%</span>
        ▼                              ▼
  <span class="h">@trader's</span> solana deposit        <span class="h">$FUNDED</span> treasury
  address, from polymarket's     <span class="dim">(buybacks, posted with tx links)</span>
  own bridge` : `
        ▼
  <span class="h">@trader's</span> solana deposit address,
  from polymarket's own bridge`}
        │
        ▼  <span class="dim">polymarket swaps it and credits it</span>
  <span class="m">@trader's polymarket balance</span>  ──►  their next bet`;
}
function cards(list) {
  return `<div class="cards">${list.map(c => `<a class="card" href="/c/${esc(c.mint)}" data-go>
    <pre class="art" data-art="${esc(c.img)}" data-cols="44"></pre>
    <div><span class="sym">$${esc(c.symbol)}</span> <span class="dim">${esc(c.name)}</span></div>
    <div class="who">funds <span style="color:var(--fg)">@${esc(c.trader)}</span>${c.state !== 'live' ? ' <span class="mute">(creating)</span>' : ''}</div>
    <div class="kv" style="grid-template-columns:auto 1fr;font-size:12.5px"><dt>market cap</dt><dd>${usd(c.mcapUsd)}</dd><dt>paid to trader</dt><dd class="${c.paidSol > 0 ? 'g' : ''}">${sol(c.paidSol)}</dd><dt>payouts</dt><dd>${c.payouts}</dd></div>
  </a>`).join('')}</div>`;
}

// ---------- 2. the board: polymarket's leaderboard ----------
const PER = ['DAY', 'WEEK', 'MONTH', 'ALL'], CATS = ['OVERALL', 'POLITICS', 'SPORTS', 'CRYPTO', 'CULTURE', 'ECONOMICS', 'TECH', 'FINANCE', 'WEATHER', 'MENTIONS'];
async function top(q) {
  const p = PER.includes((q.get('p') || '').toUpperCase()) ? q.get('p').toUpperCase() : 'DAY';
  const c = CATS.includes((q.get('c') || '').toUpperCase()) ? q.get('c').toUpperCase() : 'OVERALL';
  const o = (q.get('o') || '').toUpperCase() === 'VOL' ? 'VOL' : 'PNL';
  const link = (pp, cc, oo) => `/top?p=${pp}&c=${cc}&o=${oo}`;
  set(`<div class="crumbs"><a href="/" data-go>funded</a> / top traders</div>
  <h1>top traders on polymarket</h1>
  <p class="sub">polymarket’s own leaderboard, read live. pick anyone on it (or anyone else) and launch the coin that funds them.</p>
  <form class="search-mini" id="qf" autocomplete="off"><span>$ fund @</span><input id="qi" placeholder="any polymarket username" spellcheck="false" autocapitalize="off"><button class="b sm" type="submit">go</button></form>
  <div class="sec" style="margin-top:22px;display:flex;flex-direction:column;gap:10px">
    <div class="tabs">${PER.map(x => `<a href="${link(x, c, o)}" data-go class="${x === p ? 'on' : ''}">${x.toLowerCase()}</a>`).join('')}<span class="mute" style="padding:3px 8px">|</span>${['PNL', 'VOL'].map(x => `<a href="${link(p, c, x)}" data-go class="${x === o ? 'on' : ''}">by ${x === 'PNL' ? 'profit' : 'volume'}</a>`).join('')}</div>
    <div class="tabs">${CATS.map(x => `<a href="${link(p, x, o)}" data-go class="${x === c ? 'on' : ''}">${x.toLowerCase()}</a>`).join('')}</div>
  </div>
  <div class="tw" id="board" style="margin-top:14px"><div class="empty">reading polymarket…</div></div>`);
  $('#qf').addEventListener('submit', e => { e.preventDefault(); const u = $('#qi').value.trim().replace(/^@/, ''); if (u) go('/t/' + encodeURIComponent(u)); });
  const j = await api(`/api/poly?op=top&period=${p}&cat=${c}&order=${o}&limit=50`);
  if (!j.ok) { $('#board').innerHTML = `<div class="msg bad">${esc(j.error || 'polymarket didn’t answer')}</div>`; return; }
  if (!j.list.length) { $('#board').innerHTML = '<div class="empty">nobody on this board yet.</div>'; return; }
  const key = o === 'VOL' ? 'vol' : 'pnl', max = Math.max(...j.list.map(x => x[key] || 0));
  $('#board').innerHTML = `<table class="t"><thead><tr><th>#</th><th>trader</th><th class="n">p&amp;l</th><th class="n">volume</th><th></th><th>coin</th><th></th></tr></thead><tbody>
  ${j.list.map(x => `<tr class="click" data-href="/t/${encodeURIComponent(x.user)}"><td class="mute">${x.rank}</td><td>@${esc(x.user)}${x.verified ? ' <span class="dim">✓</span>' : ''}${x.x ? ` <span class="mute">x/${esc(x.x)}</span>` : ''}</td>
  <td class="n">${pnl(x.pnl)}</td><td class="n">${usd(x.vol)}</td><td>${bar(x[key], max, 16)}</td>
  <td>${x.coin ? `<a class="g" href="/c/${esc(x.coin.mint)}" data-go>$${esc(x.coin.symbol)}</a>` : '<span class="mute">—</span>'}</td>
  <td>${x.coin ? '' : `<a class="b sm" href="/launch?u=${encodeURIComponent(x.user)}" data-go>fund</a>`}</td></tr>`).join('')}</tbody></table>
  <p class="hint">source: polymarket data api · ${p.toLowerCase()} · ${c.toLowerCase()} · refreshed every minute</p>`;
}


// ---------- markets: where the money is ----------
const TAGS = ['all', 'politics', 'sports', 'crypto', 'economy', 'tech', 'culture', 'world'];
async function markets(q) {
  const tag = TAGS.includes((q.get('tag') || '').toLowerCase()) ? q.get('tag').toLowerCase() : 'all';
  set(`<div class="crumbs"><a href="/" data-go>funded</a> / markets</div>
  <h1>markets: where the money is</h1>
  <p class="sub">polymarket’s busiest markets right now, by 24-hour volume, with live odds. open one to see who’s betting big on each side, and fund them.</p>
  <div class="tabs" style="margin-top:18px">${TAGS.map(t => `<a href="/markets?tag=${t}" data-go class="${t === tag ? 'on' : ''}">${t}</a>`).join('')}</div>
  <div class="mks sec" id="mkl" style="margin-top:18px"><div class="empty">reading polymarket…</div></div>`);
  const j = await api(`/api/poly?op=markets&tag=${tag}&limit=16`);
  $('#mkl').innerHTML = !j.ok ? `<div class="msg bad">${esc(j.error || 'polymarket didn’t answer')}</div>` : !j.list.length ? '<div class="empty">no open markets here right now.</div>' : j.list.map(marketCard).join('') + '<p class="hint">source: polymarket gamma api · refreshed every minute · prices are the last traded odds</p>';
}

// ---------- 3. a trader ----------
async function trader(name) {
  set(`<div class="crumbs"><a href="/" data-go>funded</a> / <a href="/top" data-go>top traders</a> / @${esc(name)}</div><div id="tr"><div class="boot"><div>&gt; looking up @${esc(name)} on polymarket<span class="cur"></span></div></div></div>`);
  const j = await api('/api/poly?op=trader&u=' + encodeURIComponent(name));
  if (!j.ok) { $('#tr').innerHTML = `<div class="msg bad">${esc(j.error)}</div><div class="cta"><a class="b" href="/top" data-go>browse the leaderboard</a></div>`; return; }
  const t = j.trader, P = ['day', 'week', 'month', 'all'];
  const maxAbs = Math.max(1, ...P.map(k => Math.abs(t.pnl[k] || 0)));
  const coinBox = j.coin ? win('funded by', `<div style="font-size:18px;font-weight:800"><a href="/c/${esc(j.coin.mint)}" data-go>$${esc(j.coin.symbol)}</a></div><p class="dim">this trader already has their coin. there is one per trader.</p><div class="cta"><a class="b p" href="/c/${esc(j.coin.mint)}" data-go>open $${esc(j.coin.symbol)}</a></div>`)
    : t.optedOut ? win('not fundable', `<p>@${esc(t.user)} asked not to be funded. no coin can be launched for them.</p>`)
    : win('no coin yet', `<p>nobody has launched @${esc(t.user)}’s coin. the first funded launch takes it: there is one coin per trader.</p><div class="cta"><a class="b p" href="/launch?u=${encodeURIComponent(t.user)}" data-go>launch a coin for @${esc(t.user)}</a></div>`, 'solid');
  const pos = j.positions;
  $('#tr').innerHTML = `<div class="in">
    <div class="tcard">${t.image ? `<img src="${esc(t.image)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}<div><h1>@${esc(t.user)}${t.verified ? ' <span class="dim" style="font-size:14px">✓ verified</span>' : ''}</h1>
      <div class="dim" style="margin-top:4px">${j.value != null ? 'portfolio ' + usd(j.value) + ' · ' : ''}${j.positions ? j.positions.length + ' open position' + (j.positions.length === 1 ? '' : 's') + ' shown' : ''}</div>
      <div class="cta" style="margin-top:8px">${ext(t.url, 'polymarket ↗')}${t.x ? ext('https://x.com/' + t.x, 'x/' + esc(t.x) + ' ↗') : ''}<a class="b sm" href="https://x.com/intent/post?text=${encodeURIComponent(`@${t.user} on Polymarket: ${t.pnl.all != null ? (t.pnl.all >= 0 ? '+' : '') + Math.round(t.pnl.all).toLocaleString('en-US') + ' all time.' : ''} Their coin's fees would land in their Polymarket balance.\n\n${location.origin}/t/${encodeURIComponent(t.user)}`)}" target="_blank" rel="noopener">share ↗</a></div></div></div>
    <div class="stats" style="margin-top:26px">${P.map(k => `<div class="stat"><span class="l">p&amp;l ${k === 'all' ? 'all time' : k}</span><span class="v">${pnl(t.pnl[k])}</span><span class="mute" style="font-size:12px">${t.rank[k] ? 'rank #' + t.rank[k] : t.pnl[k] === null ? 'no trades' : ''}</span></div>`).join('')}</div>
    <div class="grid2 sec">
      <div>${win('profit by period', `<div class="tw"><table class="t"><tbody>${P.map(k => `<tr><td class="dim">${k}</td><td class="n">${pnl(t.pnl[k])}</td><td>${bar(Math.abs(t.pnl[k] || 0), maxAbs, 16)}</td><td class="n dim">vol ${usd(t.vol[k])}</td></tr>`).join('')}</tbody></table></div>`)}</div>
      <div>${coinBox}</div>
    </div>
    <section class="sec">${win('where the fees would go', `<p>polymarket’s own bridge gives @${esc(t.user)}’s polymarket wallet this solana deposit address. sol sent there is swapped and credited to their polymarket balance. it is the same address every time it’s asked.</p>
      <div class="addr"><code>${esc(j.deposit || 'the bridge didn’t answer just now')}</code>${j.deposit ? `<button class="b sm" type="button" data-copy="${esc(j.deposit)}" data-what="Address copied">copy</button>${ext(acct(j.deposit), 'solscan ↗')}` : ''}</div>
      <p class="hint">polymarket wallet: <span class="dim">${esc(t.wallet)}</span></p>`)}</section>
    <section class="sec"><div class="hd"><h2>open positions</h2><span class="mute">largest first</span></div><div class="tw">${pos && pos.length ? `<table class="t"><thead><tr><th>market</th><th>side</th><th class="n">value</th><th class="n">p&amp;l</th><th class="n">price</th></tr></thead><tbody>
      ${pos.map(p => `<tr><td class="w">${p.slug ? `<a class="u" href="https://polymarket.com/event/${esc(p.slug)}" target="_blank" rel="noopener">${esc(p.title)}</a>` : esc(p.title)}</td><td>${esc(p.outcome)}</td><td class="n">${usd(p.value)}</td><td class="n">${pnl(p.pnl)}</td><td class="n dim">${(p.cur * 100).toFixed(0)}¢</td></tr>`).join('')}</tbody></table>` : `<div class="empty">${pos ? 'no open positions right now.' : 'positions didn’t load.'}</div>`}</div></section>
    <section class="sec"><div class="hd"><h2>latest trades</h2><span class="mute">newest first</span></div><div class="tw">${j.trades && j.trades.length ? `<table class="t"><thead><tr><th>when</th><th>side</th><th>market</th><th>outcome</th><th class="n">size</th><th class="n">price</th><th class="n">usd</th></tr></thead><tbody>
      ${j.trades.map(x => `<tr><td class="dim">${ago(x.at)} ago</td><td class="${x.side === 'BUY' ? 'g' : 'r'}">${esc(x.side.toLowerCase())}</td><td class="w">${x.slug ? `<a class="u" href="https://polymarket.com/event/${esc(x.slug)}" target="_blank" rel="noopener">${esc(x.title)}</a>` : esc(x.title)}</td><td>${esc(x.outcome)}</td><td class="n">${x.size != null ? Math.round(x.size).toLocaleString('en-US') : '—'}</td><td class="n dim">${x.price != null ? Math.round(x.price * 100) + '¢' : '—'}</td><td class="n">${usd(x.usd)}</td></tr>`).join('')}</tbody></table>` : `<div class="empty">${j.trades ? 'no recent trades.' : 'trades didn’t load.'}</div>`}</div></section>
  </div>`;
}

// ---------- 4. launch ----------
async function launch(q) {
  const cfg = await config();
  set(`<div class="crumbs"><a href="/" data-go>funded</a> / launch</div>
  <h1>launch a coin that funds a trader</h1>
  <p class="sub">pick a polymarket trader, make their coin, put in the first buy. the engine creates it on pump.fun and from then on sends its creator fees to the trader’s polymarket balance.</p>
  ${cfg.ok && !cfg.open ? '<div class="msg bad">launching is paused: the engine’s records aren’t connected yet.</div>' : ''}
  <form id="lf" class="steps sec" autocomplete="off">
    <div class="step"><div class="n">step 1/4<b>trader</b></div><div>
      <div class="f"><span class="lb">polymarket</span><span class="pre">@</span><input id="tu" placeholder="username" spellcheck="false" autocapitalize="off" value="${esc(q.get('u') || '')}"><button class="b sm" type="button" id="tuGo">check</button></div>
      <div id="tuOut" class="hint">the coin’s fees go to this trader. the trader can’t be changed after launch.</div></div></div>
    <div class="step"><div class="n">step 2/4<b>the coin</b></div><div>
      <div class="pic"><label class="drop" id="drop" for="pic"><span>add a picture<br><span class="mute">png · jpg · webp</span></span></label><input type="file" id="pic" accept="image/png,image/jpeg,image/webp,image/gif" hidden><pre class="art" id="picArt" style="font-size:6px;line-height:6px"></pre></div>
      <div class="f"><label for="nm">name</label><input id="nm" maxlength="32" placeholder="up to 32 characters"></div>
      <div class="f"><label for="sy">ticker</label><span class="pre">$</span><input id="sy" maxlength="10" placeholder="1–10 letters or numbers" style="text-transform:uppercase"></div>
      <div class="f"><label for="ds">story</label><textarea id="ds" maxlength="400" rows="2" placeholder="optional. the line naming the trader is added for you"></textarea></div>
      <div class="f"><label for="xl">x link</label><input id="xl" placeholder="optional · https://x.com/yourcoin"></div>
      <div class="f"><label for="wl">website</label><input id="wl" placeholder="optional · the coin’s page here is used if empty"></div></div></div>
    <div class="step"><div class="n">step 3/4<b>first buy</b></div><div>
      <div class="f"><label for="dv">first buy</label><input id="dv" type="number" min="${cfg.minDev || 0.01}" max="${cfg.maxDev || 10}" step="0.01" value="0.05"><span class="dim">SOL</span></div>
      <div class="tabs" style="margin-top:8px">${[0.01, 0.05, 0.1, 0.25, 0.5, 1].map(v => `<button type="button" data-dv="${v}">${v}</button>`).join('')}</div>
      <div class="hint">bought right as the coin is created; the tokens are sent to your wallet.</div></div></div>
    <div class="step"><div class="n">step 4/4<b>launch</b></div><div>
      <div class="f"><label for="launcher">your wallet</label><input id="launcher" placeholder="connect, or paste your solana address" spellcheck="false"><button class="b sm" type="button" data-connect>connect</button></div>
      <div class="hint">the first-buy tokens, unused sol and any refund go here.</div>
      <div id="sum" class="win" style="margin-top:22px"></div>
      <div class="cta"><button class="b p" type="submit" id="go">launch</button><span class="dim" id="goMsg"></span></div>
      <div id="err" class="msg bad" hidden></div></div></div>
  </form>
  <div id="flow" hidden></div>`);
  paintWallet();
  const S = { img: null, t: null, tFor: '' };
  const sum = () => {
    const dev = Math.max(0, +$('#dv').value || 0);
    const need = (cfg.createSol || 0.03) + dev * 1.02 + (cfg.reserveSol || 0.015);
    $('#sum').innerHTML = `<span class="t">what happens</span><span class="c1">+</span><span class="c2">+</span><dl class="kv">
      <dt>you send</dt><dd><b>${need.toFixed(3)} SOL</b> <span class="dim">= ${(cfg.createSol || 0.03)} to create + ${dev} first buy (+2%) + ${(cfg.reserveSol || 0.015)} reserve for gas. unused sol comes back.</span></dd>
      <dt>the coin’s fees</dt><dd>${cfg.cutTaken ? '<b>90%</b> to' : '<b>100%</b> to'} ${S.t ? '@' + esc(S.t.user) + '’s' : 'the trader’s'} polymarket balance${cfg.cutTaken ? ', <b>10%</b> to the $FUNDED treasury' : ''}, in payouts of at least ${cfg.payMinSol || '~0.03'} SOL</dd>
      <dt>custody</dt><dd>the engine holds the coin’s creator wallet. it can only claim fees and pay them to the trader; it never sells.</dd>
      <dt>if it fails</dt><dd>not funded in 3 hours, or the trader got a coin first: everything you sent is returned.</dd></dl>`;
  };
  sum();
  $$('[data-dv]').forEach(b => b.addEventListener('click', () => { $('#dv').value = b.dataset.dv; sum(); }));
  $('#dv').addEventListener('input', sum);
  async function check() {
    const u = $('#tu').value.trim().replace(/^@/, ''); if (!u) { $('#tuOut').innerHTML = 'type a polymarket username.'; return null; }
    if (S.tFor === u.toLowerCase() && S.t) return S.t;
    $('#tuOut').innerHTML = `looking up @${esc(u)}<span class="cur"></span>`;
    const j = await api('/api/poly?op=trader&u=' + encodeURIComponent(u));
    if (!j.ok) { S.t = null; $('#tuOut').innerHTML = `<span class="r">${esc(j.error)}</span>`; sum(); return null; }
    if (j.coin) { S.t = null; $('#tuOut').innerHTML = `<span class="r">@${esc(j.trader.user)} is already funded by</span> <a class="u" href="/c/${esc(j.coin.mint)}" data-go>$${esc(j.coin.symbol)}</a>. one coin per trader.`; sum(); return null; }
    if (j.trader.optedOut) { S.t = null; $('#tuOut').innerHTML = `<span class="r">@${esc(j.trader.user)} asked not to be funded.</span>`; sum(); return null; }
    if (!j.deposit) { S.t = null; $('#tuOut').innerHTML = '<span class="r">polymarket’s deposit bridge didn’t answer for this trader. try again in a minute.</span>'; sum(); return null; }
    S.t = j.trader; S.tFor = u.toLowerCase();
    $('#tuOut').innerHTML = `<span class="g">✓ found</span> <a class="u" href="/t/${encodeURIComponent(S.t.user)}" data-go>@${esc(S.t.user)}</a> · all-time ${pnl(S.t.pnl.all)} · today ${pnl(S.t.pnl.day)} · deposit route <span class="dim">${short(j.deposit)}</span>`;
    if (!$('#nm').value) $('#nm').value = (S.t.user + ' fund').slice(0, 32);
    if (!$('#sy').value) $('#sy').value = S.t.user.replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 10) || 'FUNDED';
    sum(); return S.t;
  }
  $('#tuGo').addEventListener('click', check);
  $('#tu').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); check(); } });
  $('#tu').addEventListener('change', check);
  if (q.get('u')) check();
  $('#pic').addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0]; if (!f) return;
    if (!/^image\//.test(f.type)) return toast('That isn’t a picture');
    try {
      const bmp = await createImageBitmap(f); const c = document.createElement('canvas'); const s = Math.min(bmp.width, bmp.height);
      c.width = c.height = 512; c.getContext('2d').drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, 512, 512);
      S.img = c.toDataURL('image/jpeg', 0.9);
      $('#drop').innerHTML = `<img src="${S.img}" alt="">`;
      $('#picArt').textContent = await asciiArt(S.img, 46);
    } catch { toast('That picture couldn’t be read'); }
  });
  const err = m => { const e = $('#err'); e.textContent = m || ''; e.hidden = !m; if (m) e.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); };
  $('#lf').addEventListener('submit', async e => {
    e.preventDefault(); err('');
    const t = await check(); if (!t) return err('Pick a trader first (step 1).');
    if (!S.img) return err('Add a picture for the coin (step 2).');
    let launcher = $('#launcher').value.trim();
    if (!launcher) { const w = await connect(); if (w) launcher = w.pk; }
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(launcher)) return err('Connect a wallet or paste your Solana address (step 4).');
    $('#go').disabled = true; $('#goMsg').textContent = 'recording the launch…';
    const r = await post('/api/launch?op=prepare', { launcher, trader: t.user, name: $('#nm').value, symbol: $('#sy').value, description: $('#ds').value, twitter: $('#xl').value.trim(), website: $('#wl').value.trim(), devBuy: +$('#dv').value, image: S.img });
    $('#go').disabled = false; $('#goMsg').textContent = '';
    if (!r.ok) return err(r.error || 'The launch didn’t save.');
    track(r);
  });
  try { const s = JSON.parse(localStorage.getItem('funded:launch') || 'null'); if (s && s.id) { track(s); toast('Picking up your launch where it left off'); } } catch {}
}
const STEPS = [['rec', 'launch recorded'], ['dep', 'deposit received'], ['make', 'coin created on pump.fun'], ['back', 'first buy sent to you'], ['live', 'fees now fund the trader']];
let LAUNCH = null;
function track(d) {
  LAUNCH = d; const f = $('#flow'); if (!f) return;
  $('#lf').hidden = true; f.hidden = false;
  f.innerHTML = win(`launch · $${d.symbol || ''}`, `<div class="prog" id="prog"></div><div id="dep"></div><div class="feed" id="llog" style="margin-top:12px"></div>`, 'solid');
  prog('waiting'); depositBox(d);
  try { localStorage.setItem('funded:launch', JSON.stringify({ id: d.id, wallet: d.wallet, need: d.need, needSol: d.needSol, mint: d.mint, symbol: d.symbol, trader: d.trader })); } catch {}
  every(checkLaunch, 3500); checkLaunch();
}
function prog(state) {
  const bad = ['failed', 'refunded', 'expired'].includes(state);
  const at = { waiting: 1, creating: 2, live: 5 }[state] || 1;
  const el = $('#prog'); if (!el) return;
  el.innerHTML = STEPS.map(([k, t], i) => `<div class="s ${bad ? (i === 0 ? 'ok' : i === 1 ? 'bad' : '') : i < at ? 'ok' : i === at ? 'on' : ''}">${esc(t)}</div>`).join('');
}
function depositBox(d) {
  const el = $('#dep'); if (!el) return;
  el.innerHTML = `<p>send exactly <b>${d.needSol} SOL</b> to this coin’s wallet:</p>
    <div class="addr"><code>${esc(d.wallet)}</code><button class="b sm" type="button" data-copy="${esc(d.wallet)}" data-what="Wallet copied">copy</button><button class="b sm" type="button" data-copy="${d.needSol}" data-what="Amount copied">copy amount</button></div>
    <div class="cta"><button class="b p" type="button" id="sendDep">send it with my wallet</button></div>
    <p class="hint" id="depMsg">this page checks every few seconds. the engine checks too, so you can close it once the transfer is sent.</p>
    <p class="hint">the coin’s address will be <span class="dim">${esc(d.mint)}</span>. not funded within 3 hours: cancelled, and anything sent comes back.</p>`;
  $('#sendDep').addEventListener('click', sendDeposit);
}
async function sendDeposit() {
  const w = WAL || await connect(); if (!w || !LAUNCH) return;
  const msg = $('#depMsg');
  try {
    if (!window.solanaWeb3) await new Promise((ok, no) => { const s = document.createElement('script'); s.src = '/assets/js/web3.min.js'; s.onload = ok; s.onerror = no; document.head.appendChild(s); });
    const { Transaction, SystemProgram, PublicKey } = window.solanaWeb3;
    const bh = await api('/api/launch?op=blockhash'); if (!bh || !bh.ok) throw new Error('Solana didn’t answer. Try again.');
    const from = new PublicKey(w.pk);
    const t = new Transaction({ feePayer: from, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }).add(SystemProgram.transfer({ fromPubkey: from, toPubkey: new PublicKey(LAUNCH.wallet), lamports: LAUNCH.need }));
    msg.textContent = 'approve the transfer in your wallet…';
    let sig = null;
    if (w.p.signAndSendTransaction) { const r = await w.p.signAndSendTransaction(t); sig = r && (r.signature || r); }
    else { const s = await w.p.signTransaction(t); const r = await post('/api/launch?op=relay', { tx: btoa(String.fromCharCode(...s.serialize())) }); if (!r.ok) throw new Error(r.error); sig = r.sig; }
    msg.innerHTML = `sent: <a class="u" href="${tx(String(sig))}" target="_blank" rel="noopener">${esc(short(String(sig), 6))}</a>. waiting for it to land…`;
  } catch (e) { msg.innerHTML = `<span class="r">${esc((e && e.message) || 'The transfer was cancelled.')}</span> you can also send it from any wallet.`; }
}
async function checkLaunch() {
  if (!LAUNCH) return;
  const d = await api('/api/launch?op=status&id=' + encodeURIComponent(LAUNCH.id)); if (!d || !d.ok) return;
  prog(d.state);
  const log = $('#llog'); if (log && d.logs) log.innerHTML = d.logs.map(l => `<div class="it"><span class="at">${ago(l.at)}</span><span>${esc(l.text)}</span>${l.sig ? `<a class="tx" href="${tx(l.sig)}" target="_blank" rel="noopener">tx ↗</a>` : ''}</div>`).join('');
  const dep = $('#dep'); if (!dep) return;
  if (d.state === 'waiting' && !$('#sendDep')) depositBox(d);
  if (d.state === 'waiting' && d.balance > 0 && $('#depMsg')) $('#depMsg').textContent = `${(d.balance / 1e9).toFixed(4)} of ${d.needSol} SOL arrived.`;
  if (d.state === 'creating') dep.innerHTML = '<div class="msg ok">deposit in. creating the coin on pump.fun…</div>';
  if (d.state === 'live') { stopTimers(); try { localStorage.removeItem('funded:launch'); } catch {}
    dep.innerHTML = `<div class="msg ok"><b>$${esc(d.symbol)} is live.</b> its fees now fund @${esc(d.trader)}.<div class="cta"><a class="b p" href="/c/${esc(d.mint)}" data-go>open the coin</a>${ext('https://pump.fun/coin/' + d.mint, 'pump.fun ↗')}${d.create_sig ? ext(tx(d.create_sig), 'creation tx ↗') : ''}<a class="b sm" href="https://x.com/intent/post?text=${encodeURIComponent(`I just funded @${d.trader} on Polymarket. Every trade of $${d.symbol} pays their next bet.\n\n${location.origin}/c/${d.mint}`)}" target="_blank" rel="noopener">share on x ↗</a></div></div>`; }
  if (['failed', 'expired', 'refunded'].includes(d.state)) { stopTimers(); try { localStorage.removeItem('funded:launch'); } catch {}
    dep.innerHTML = `<div class="msg bad">the launch ${d.state === 'expired' ? 'expired' : 'didn’t go through'}${d.err ? ': ' + esc(d.err.slice(0, 160)) : ''}. ${d.refund_sig ? `your deposit came back: <a class="u" href="${tx(d.refund_sig)}" target="_blank" rel="noopener">refund tx</a>` : 'anything you sent is being returned automatically.'}<div class="cta"><a class="b" href="/launch" data-go>start again</a></div></div>`; }
}

// ---------- 5. a coin ----------
async function coin(mint) {
  set(`<div class="crumbs"><a href="/" data-go>funded</a> / <a href="/coins" data-go>coins</a> / ${short(mint)}</div><div id="cn"><div class="boot"><div>&gt; reading the coin<span class="cur"></span></div></div></div>`);
  const paint = async () => {
    const j = await api('/api/coins?m=' + encodeURIComponent(mint));
    if (!j.ok) { $('#cn').innerHTML = `<div class="msg bad">${esc(j.error || 'not found')}</div>`; return false; }
    const c = j.coin, mk = c.market || {};
    const toNext = c.payMinSol && c.chestSol != null ? Math.min(1, c.chestSol / c.payMinSol) : 0;
    $('#cn').innerHTML = `<div class="in">
      <div class="coinhd">
        <pre class="art lg" data-art="${esc(c.img)}" data-cols="44"></pre>
        <div><h1 style="font-size:30px">$${esc(c.symbol)}</h1><div class="dim" style="margin-top:4px">${esc(c.name)}</div>
          <p class="lead" style="font-size:15px">every trade of $${esc(c.symbol)} funds <a class="u" href="/t/${encodeURIComponent(c.trader)}" data-go>@${esc(c.trader)}</a> on polymarket.</p>
          ${c.optedOut ? `<div class="msg bad">@${esc(c.trader)} asked not to be funded. from now on this coin’s fees buy $${esc(c.symbol)} back and burn it.</div>` : ''}
          ${c.state !== 'live' ? `<div class="msg">state: ${esc(c.state)}${c.err ? ' · ' + esc(c.err) : ''}</div>` : ''}
          <div class="dim" id="tsnap" style="margin-top:6px"></div>
          <div class="cta">${ext('https://pump.fun/coin/' + c.mint, 'buy on pump.fun ↗', 'b p')}${ext('https://dexscreener.com/solana/' + c.mint, 'chart ↗')}${ext(poly(c.trader), '@' + esc(c.trader) + ' on polymarket ↗')}<button class="b sm" type="button" data-copy="${esc(c.mint)}" data-what="Address copied">copy ca</button><a class="b sm" href="https://x.com/intent/post?text=${encodeURIComponent(`Every trade of $${c.symbol} funds @${c.trader}'s next Polymarket bet.\n\n${location.origin}/c/${c.mint}`)}" target="_blank" rel="noopener">share ↗</a></div></div></div>
      <div class="stats sec">
        <div class="stat"><span class="l">market cap</span><span class="v">${usd(c.mcapUsd || mk.mcapUsd)}</span><span class="mute" style="font-size:12px">${mk.complete ? 'graduated' : mk.progress != null ? Math.round(mk.progress * 100) + '% of the curve' : ''}</span></div>
        <div class="stat"><span class="l">paid to @${esc(c.trader)}</span><span class="v g">${sol(c.paidSol)}</span><span class="mute" style="font-size:12px">${c.payouts} payout${c.payouts === 1 ? '' : 's'}</span></div>
        <div class="stat"><span class="l">fees claimed</span><span class="v">${sol(c.claimedSol)}</span><span class="mute" style="font-size:12px">${c.waitingSol ? sol(c.waitingSol) + ' waiting to claim' : ''}</span></div>
        <div class="stat"><span class="l">next payout</span><span class="v" style="font-size:16px">${bar(toNext, 1, 14)}</span><span class="mute" style="font-size:12px">${sol(c.chestSol)} of ${c.payMinSol} SOL</span></div>
      </div>
      <section class="sec">${win('where the money goes', `<pre class="path">  creator fees ──► coin wallet <a class="u" href="${acct(c.wallet)}" target="_blank" rel="noopener">${short(c.wallet)}</a> <span class="dim">(held by the engine)</span>
        │  <span class="dim">at ≥ ${c.payMinSol} SOL</span>
        ▼
  polymarket deposit address <a class="u" href="${acct(c.depositSvm || '')}" target="_blank" rel="noopener">${short(c.depositSvm || '')}</a> <span class="dim">(polymarket’s bridge, for @${esc(c.trader)})</span>
        │  <span class="dim">swapped and credited by polymarket</span>
        ▼
  <span class="m">@${esc(c.trader)}’s polymarket balance</span></pre>
        <div id="bridge" class="hint">asking polymarket’s bridge what it has seen at that address…</div>`)}</section>
      <section class="sec"><div class="hd"><h2>payouts</h2><span class="mute">every one is a solana transaction</span></div>${j.payouts.length ? `<div class="tw"><table class="t"><thead><tr><th>when</th><th class="n">to @${esc(c.trader)}</th><th class="n">~usd</th><th class="n">treasury</th><th>tx</th></tr></thead><tbody>${j.payouts.map(p => `<tr><td class="dim">${ago(p.at)} ago</td><td class="n g">${sol(p.sol)}</td><td class="n">${p.usd ? usd(p.usd) : '—'}</td><td class="n dim">${p.cutSol ? sol(p.cutSol) : '—'}</td><td><a class="u" href="${tx(p.sig)}" target="_blank" rel="noopener">${short(p.sig, 6)} ↗</a></td></tr>`).join('')}</tbody></table></div>` : `<div class="empty"><b>no payouts yet.</b> the first one goes out when the coin wallet holds ${c.payMinSol} SOL of fees.</div>`}</section>
      <section class="sec"><div class="hd"><h2>engine log</h2></div><div class="feed">${j.log.map(l => `<div class="it"><span class="at">${ago(l.at)}</span><span class="${l.kind === 'error' ? 'r' : l.kind === 'pay' ? 'g' : ''}">${esc(l.text)}</span>${l.sig ? `<a class="tx" href="${tx(l.sig)}" target="_blank" rel="noopener">tx ↗</a>` : ''}</div>`).join('') || '<div class="empty">nothing yet.</div>'}</div></section>
      <section class="sec">${win('the record', `<dl class="kv"><dt>contract</dt><dd>${esc(c.mint)}</dd><dt>coin wallet</dt><dd>${esc(c.wallet)}</dd><dt>launched by</dt><dd>${esc(c.launcher)}</dd><dt>created</dt><dd>${c.createSig ? `<a class="u" href="${tx(c.createSig)}" target="_blank" rel="noopener">${short(c.createSig, 6)} ↗</a>` : '—'}</dd><dt>description</dt><dd class="dim" style="white-space:pre-wrap">${esc(c.description)}</dd></dl>`)}</section>
    </div>`;
    paintArt($('#cn'));
    api('/api/poly?op=trader&u=' + encodeURIComponent(c.trader)).then(t => { const el = $('#tsnap'); if (el && t.ok) el.innerHTML = `@${esc(t.trader.user)} on polymarket: today ${pnl(t.trader.pnl.day)} · all time ${pnl(t.trader.pnl.all)}${t.value != null ? ' · portfolio ' + usd(t.value) : ''}`; });
    if (c.depositSvm) api('/api/poly?op=status&svm=' + c.depositSvm).then(s => { const b = $('#bridge'); if (!b) return; if (!s.ok) { b.textContent = 'polymarket’s bridge didn’t answer just now.'; return; } b.innerHTML = s.deposits.length ? 'polymarket’s bridge has seen ' + s.deposits.length + ' deposit' + (s.deposits.length === 1 ? '' : 's') + ' here: ' + s.deposits.slice(0, 5).map(x => esc(x.status || 'seen')).join(', ') : 'polymarket’s bridge hasn’t seen a deposit at this address yet.'; });
    return true;
  };
  if (await paint()) every(paint, 30000);
}

// ---------- 6. coins ----------
async function coins() {
  set(`<div class="crumbs"><a href="/" data-go>funded</a> / coins</div><h1>every coin on funded</h1><p class="sub">one per trader. each picture is drawn in ascii from the coin’s own image.</p><div id="cl" class="sec"><div class="empty">reading the coins…</div></div>`);
  const j = await api('/api/coins');
  $('#cl').innerHTML = !j.ok ? `<div class="msg bad">${esc(j.error)}</div>` : !j.coins.length ? `<div class="empty"><b>no coins yet.</b> the first one is yours to launch. <a class="b sm" href="/launch" data-go>launch</a></div>` : cards(j.coins);
  paintArt($('#cl'));
}

// ---------- 7. the ledger ----------
async function ledger() {
  set(`<div class="crumbs"><a href="/" data-go>funded</a> / ledger</div><h1>the ledger</h1><p class="sub">every payout the engine has sent to a trader’s polymarket deposit address, newest first. each line is a solana transaction you can open.</p><div id="lg" class="sec"><div class="empty">reading the ledger…</div></div>`);
  const [j, st] = await Promise.all([api('/api/coins?op=ledger'), stats()]);
  const head = st.ok && !st.offline ? `<div class="stats"><div class="stat"><span class="l">paid to traders</span><span class="v g">${sol(st.paidSol)}</span></div><div class="stat"><span class="l">payouts</span><span class="v">${st.payouts}</span></div><div class="stat"><span class="l">traders funded</span><span class="v">${st.traders}</span></div><div class="stat"><span class="l">fees claimed</span><span class="v">${sol(st.claimedSol)}</span></div></div>` : '';
  $('#lg').innerHTML = head + (!j.ok ? `<div class="msg bad">${esc(j.error)}</div>` : !j.ledger.length ? `<div class="empty sec"><b>no payouts yet.</b> the first line appears here the moment it’s sent.</div>`
    : `<div class="tw sec"><table class="t"><thead><tr><th>when</th><th>coin</th><th>trader</th><th class="n">sol</th><th class="n">~usd</th><th>to</th><th>tx</th></tr></thead><tbody>${j.ledger.map(p => `<tr><td class="dim">${ago(p.at)} ago</td><td><a href="/c/${esc(p.mint)}" data-go>$${esc(p.symbol)}</a></td><td><a href="/t/${encodeURIComponent(p.trader)}" data-go>@${esc(p.trader)}</a></td><td class="n g">${sol(p.sol)}</td><td class="n">${p.usd ? usd(p.usd) : '—'}</td><td class="dim">${short(p.to)}</td><td><a class="u" href="${tx(p.sig)}" target="_blank" rel="noopener">${short(p.sig, 6)} ↗</a></td></tr>`).join('')}</tbody></table></div>`);
}

// ---------- 8. the manual ----------
async function how() {
  const cfg = await config();
  set(`<div class="man">
  <div class="mh"><span>FUNDED(1)</span><span>funded manual</span><span>FUNDED(1)</span></div>
  <h3>NAME</h3><p>funded — launch a pump.fun coin on any polymarket trader; its creator fees land in their polymarket balance.</p>
  <h3>SYNOPSIS</h3><p class="cmd">fund @trader --name NAME --ticker TICKER --first-buy SOL</p>
  <h3>DESCRIPTION</h3>
  <p>every coin on funded is about one polymarket trader, named in the coin’s description and fixed at launch. the coin’s creator wallet is held by the funded engine. pump.fun pays the coin’s creator fees into it; the engine claims them and, once at least ${cfg.payMinSol || '~0.03'} SOL (about $${cfg.payMinUsd || 6}) has built up, sends them to the solana deposit address polymarket’s own bridge assigns to that trader. polymarket swaps it and credits it to their balance. the trader has nothing to claim and doesn’t have to know.</p>
  <h3>THE MONEY PATH</h3><pre class="path" style="margin-left:4ch">${moneyPath(cfg)}</pre>
  <h3>THE SPLIT</h3><ul><li>${cfg.cutTaken ? '90% of every payout goes to the trader; 10% goes to the $FUNDED treasury.' : 'while no treasury address is set, 100% of every payout goes to the trader.'}</li><li>the launcher gets the first-buy tokens and nothing else.</li><li>pump.fun keeps its own trading fee; funded only moves the creator fee.</li></ul>
  <h3>CUSTODY</h3><p>custodial, said plainly: each coin’s wallet is derived on the server from one master secret. the engine can do exactly two things with it: claim the coin’s creator fees and pay them out as described here. there is no sell action and no withdraw action in its code. every claim and payout is a public solana transaction, linked from the coin’s page.</p>
  <h3>IT CANNOT / SO IT</h3><div class="tw" style="margin-left:4ch"><table class="t" style="margin-left:0;width:100%"><thead><tr><th>it cannot</th><th>so it</th></tr></thead><tbody>
    <tr><td class="w">send less than ~$2 into polymarket’s bridge (smaller deposits aren’t processed)</td><td class="w">waits until a coin has at least ${cfg.payMinSol || '~0.03'} SOL of fees, then sends it in one go</td></tr>
    <tr><td class="w">know a trader’s deposit address forever</td><td class="w">asks polymarket’s bridge for it fresh before every payout</td></tr>
    <tr><td class="w">change the trader after launch</td><td class="w">puts the trader in the coin’s description, which pump.fun can’t edit</td></tr>
    <tr><td class="w">let two coins fund one trader</td><td class="w">gives the trader to the first funded launch and refunds any later one</td></tr>
    <tr><td class="w">ask the trader’s permission first</td><td class="w">ends payouts for any trader who asks, permanently (see OPTING OUT)</td></tr></tbody></table></div>
  <h3>EXIT STATUS</h3><ul><li><b>expired</b> — not funded within 3 hours: everything sent is returned.</li><li><b>failed</b> — pump.fun didn’t take the coin, or the trader was funded first: everything sent is returned.</li><li><b>bridge down</b> — the payout waits and retries on the next pass; nothing is sent anywhere else.</li></ul>
  <h3>OPTING OUT</h3><p>a trader who doesn’t want this sends one message to ${cfg.x ? `<a class="u" href="${esc(cfg.x)}" target="_blank" rel="noopener">funded on x</a>` : 'funded on x'}. their coin’s payouts stop for good, with no appeal and no weighing it against the balance. from then on the coin’s fees buy the coin back and burn it; nothing is kept.</p>
  <h3>GLOSSARY</h3><div class="tw" style="margin-left:4ch"><table class="t" style="margin-left:0;width:100%"><tbody>
    <tr><td><b>funded</b></td><td class="w">a trader with a live coin.</td></tr><tr><td><b>the coin wallet</b></td><td class="w">the creator wallet the engine holds for one coin.</td></tr>
    <tr><td><b>the chest</b></td><td class="w">claimed fees sitting in the coin wallet, waiting for the payout minimum.</td></tr><tr><td><b>the route</b></td><td class="w">the solana deposit address polymarket’s bridge gives a trader.</td></tr>
    <tr><td><b>a pass</b></td><td class="w">one run of the engine: launches, claims, payouts. every visit to this site nudges one.</td></tr><tr><td><b>—</b></td><td class="w">a dash means there is no number. a zero means we measured and found nothing.</td></tr></tbody></table></div>
  <h3>FAQ</h3>
  <details class="q"><summary>does the trader have to sign up or claim?</summary><p>no. the money lands in their polymarket balance through polymarket’s own deposit bridge.</p></details>
  <details class="q"><summary>is funded part of polymarket or pump.fun?</summary><p>no. it uses polymarket’s public data and deposit bridge and pump.fun’s public programs like anyone else. traders on this site haven’t endorsed anything.</p></details>
  <details class="q"><summary>what if polymarket changes its bridge?</summary><p>payouts pause, the pause is shown on the coin’s page, and they resume when a route works again. the money is never sent anywhere else.</p></details>
  <details class="q"><summary>can the launcher take the fees?</summary><p>no. the launcher never holds the coin wallet. they get the first-buy tokens only.</p></details>
  <h3>SELF-TEST</h3><p>builds a launch, a claim and a payout with throwaway keys and simulates them on solana mainnet. nothing is sent.</p>
  <div style="margin-left:4ch"><button class="b" type="button" id="st">run the self-test</button><pre id="stOut" class="dim" style="white-space:pre-wrap;margin-top:10px"></pre></div>
  <h3>SEE ALSO</h3><p><a class="u" href="/top" data-go>top traders</a>, <a class="u" href="/ledger" data-go>the ledger</a>, <a class="u" href="/token" data-go>$FUNDED</a></p>
  </div>`);
  $('#st').addEventListener('click', async () => {
    $('#st').disabled = true; $('#stOut').textContent = 'running…';
    const j = await api('/api/launch?op=selftest', { ms: 60000 });
    $('#st').disabled = false;
    if (!j.ok) { $('#stOut').textContent = j.error || 'failed'; return; }
    const ln = (k, v) => `${k.padEnd(12, ' ')} ${v}`;
    const sim = s => !s ? '' : s.err ? ('simulated: ' + (typeof s.err === 'string' ? s.err : JSON.stringify(s.err)).slice(0, 90)) : 'simulated: ok';
    $('#stOut').textContent = [
      ln('polymarket', j.polymarket.ok ? `ok · top today @${j.polymarket.topToday}` : 'failed: ' + j.polymarket.error),
      ln('bridge', j.bridge.ok ? `ok · ${short(j.bridge.svm)} · same address twice: ${j.bridge.stable}` : 'failed: ' + j.bridge.error),
      ln('create', j.create.ok ? `${j.create.bytes} bytes · ${sim(j.create.sim)}` : 'failed: ' + j.create.error),
      ln('claim', j.claim.ok ? `${j.claim.bytes} bytes · ${sim(j.claim.sim)}` : 'failed: ' + j.claim.error),
      ln('payout', j.payout.ok ? `to ${short(j.payout.to)} · ${sim(j.payout.sim)}` : 'failed: ' + j.payout.error),
      ln('keys', j.keys.ok ? (j.keys.db === false ? 'no database' : `stable: ${j.keys.stable}`) : 'failed: ' + j.keys.error),
      ln('price', j.price.ok ? `SOL $${(+j.price.solUsd).toFixed(2)}` : 'failed'),
      '', j.note].join('\n');
  });
}

// ---------- 9. $FUNDED ----------
async function token() {
  const cfg = await config();
  set(`<div class="crumbs"><a href="/" data-go>funded</a> / $FUNDED</div><h1>$FUNDED</h1>
  <p class="sub">the token of the pad. ${cfg.cutTaken ? '10% of every payout to a trader goes to the $FUNDED treasury, and every buyback from it is posted with its transaction.' : 'while no treasury address is set, funded takes nothing: traders get 100%.'}</p>
  <div class="grid2 sec">
    ${win('contract', cfg.ca ? `<div class="addr"><code>${esc(cfg.ca)}</code><button class="b sm" type="button" data-copy="${esc(cfg.ca)}" data-what="CA copied">copy</button></div><div class="cta">${ext('https://pump.fun/coin/' + cfg.ca, 'buy on pump.fun ↗', 'b p')}${ext('https://dexscreener.com/solana/' + cfg.ca, 'chart ↗')}</div>`
      : `<p><b>not launched yet.</b></p><p class="dim">the address appears here and in the pinned post on x at the same moment. anyone posting one before that is not us.</p>`, 'solid')}
    ${win('treasury', cfg.treasury ? `<div class="addr"><code>${esc(cfg.treasury)}</code>${ext(acct(cfg.treasury), 'solscan ↗')}</div><p class="dim">receives 10% of every payout. open it on solscan to see every lamport in and out.</p>` : `<p class="dim">no treasury address is set, so nothing is taken from payouts.</p>`)}
  </div>
  <section class="sec">${win('what holding it means', `<ul style="margin:0;padding-left:2ch"><li>every coin launched on funded pays into the treasury, once its trader is paid.</li><li>the treasury buys $FUNDED back. each buyback is posted with its transaction.</li><li>$FUNDED is a memecoin. it doesn’t promise anything, and nothing here is advice.</li></ul>`)}</section>`);
}

function notFound() { return `<div class="in"><pre class="big">404</pre><p class="lead">this screen doesn’t exist.</p><div class="cta"><a class="b p" href="/" data-go>go home</a><a class="b" href="/top" data-go>top traders</a></div></div>`; }

// ---------- the command line ----------
const HELP = `<b>commands</b>
  fund &lt;username&gt;     open a polymarket trader          e.g. fund HomeRunHazard
  launch [username]    launch a coin for a trader
  top [day|week|month|all] [politics|sports|crypto|…] [vol]
  markets [politics|sports|crypto|economy|tech|culture|world]
  coin &lt;address|$TICKER&gt;
  coins · ledger · how · token · home
  connect              connect a solana wallet
  clear                close this panel
<span class="mute">keys: / focuses the command line · 1–7 open the menu · esc closes this</span>`;
const hist = []; let hi = -1;
function out(html) { const o = $('#out'); o.innerHTML = `<div class="l">${html}</div>`; o.hidden = false; }
function closeOut() { $('#out').hidden = true; }
async function run(line) {
  const raw = line.trim(); if (!raw) return; hist.unshift(raw); hi = -1;
  const [cmd, ...args] = raw.split(/\s+/); const a = args.join(' ').trim(), c = cmd.toLowerCase();
  if (['help', '?', 'h', 'man'].includes(c)) return out(HELP);
  if (c === 'clear' || c === 'cls') return closeOut();
  closeOut();
  if (['fund', 't', 'trader', 'who'].includes(c)) { if (!a) return out('usage: fund &lt;polymarket username&gt;'); return go('/t/' + encodeURIComponent(a.replace(/^@/, ''))); }
  if (c === 'launch') return go('/launch' + (a ? '?u=' + encodeURIComponent(a.replace(/^@/, '')) : ''));
  if (c === 'top' || c === 'board') {
    const w = args.map(x => x.toUpperCase()); const p = w.find(x => PER.includes(x)) || 'DAY', ca = w.find(x => CATS.includes(x)) || 'OVERALL', o = w.includes('VOL') ? 'VOL' : 'PNL';
    return go(`/top?p=${p}&c=${ca}&o=${o}`);
  }
  if (c === 'coin' || c === 'c') {
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return go('/c/' + a);
    const sym = a.replace(/^\$/, '').toUpperCase(); if (!sym) return out('usage: coin &lt;address or $TICKER&gt;');
    const j = await api('/api/coins'); const hit = j.ok && j.coins.find(x => x.symbol === sym);
    return hit ? go('/c/' + hit.mint) : out(`no coin called $${esc(sym)} on funded.`);
  }
  if (c === 'markets' || c === 'm') return go('/markets' + (a ? '?tag=' + encodeURIComponent(a.toLowerCase()) : ''));
  if (['coins', 'ledger', 'how', 'token'].includes(c)) return go('/' + c);
  if (c === 'home' || c === 'cd' || c === '~') return go('/');
  if (c === 'connect' || c === 'wallet') return connect();
  if (c.startsWith('@')) return go('/t/' + encodeURIComponent(c.slice(1)));
  out(`command not found: ${esc(cmd)}. type <b>help</b>.`);
}
$('#cmd').addEventListener('keydown', e => {
  if (e.key === 'Enter') { const v = e.target.value; e.target.value = ''; run(v); }
  else if (e.key === 'ArrowUp') { if (hist.length) { hi = Math.min(hist.length - 1, hi + 1); e.target.value = hist[hi]; e.preventDefault(); } }
  else if (e.key === 'ArrowDown') { hi = Math.max(-1, hi - 1); e.target.value = hi >= 0 ? hist[hi] : ''; }
  else if (e.key === 'Escape') { closeOut(); e.target.blur(); }
});
document.addEventListener('keydown', e => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
  if (e.key === 'Escape') closeOut();
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '/') { e.preventDefault(); $('#cmd').focus(); }
  const m = { 1: '/top', 2: '/markets', 3: '/launch', 4: '/coins', 5: '/ledger', 6: '/how', 7: '/token' }[e.key];
  if (m) { closeOut(); go(m); }
});

async function foot() {
  const cfg = await config(); const f = $('#foot'); if (!f) return;
  f.innerHTML = `<span>FUNDED · launch a coin on any polymarket trader · not affiliated with polymarket or pump.fun · nothing here is financial advice</span>
  <span class="links"><a href="/how" data-go>manual</a><a href="/ledger" data-go>ledger</a><a href="/token" data-go>$FUNDED</a>${cfg.x ? `<a href="${esc(cfg.x)}" target="_blank" rel="noopener">x ↗</a>` : ''}${cfg.ca ? `<a href="https://pump.fun/coin/${esc(cfg.ca)}" target="_blank" rel="noopener">pump.fun ↗</a>` : ''}</span>`;
}
tape(); route(); foot();
