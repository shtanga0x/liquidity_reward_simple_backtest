'use strict';

const WORKER    = 'https://polymarket-proxy.bobrovnikovstepan.workers.dev';
const GAMMA_API = `${WORKER}/api/gamma`;
const CLOB_API  = `${WORKER}/api/clob`;
const C = 3.0; // single-side penalty factor per Polymarket docs

// ─── State ───────────────────────────────────────────────────────────────────
const state = {
  marketQuestion: '',
  slug: null,
  conditionId: null,
  tokenId: null,
  midpoint: null,
  maxSpreadCents: null,
  minSize: null,
  orderbook: null,
};

// ─── URL Parsing ──────────────────────────────────────────────────────────────
function parsePolymarketURL(url) {
  const m = url.trim().match(/polymarket\.com\/event\/[^\/]+\/([^\/\?#]+)/);
  return m ? m[1] : null;
}

// ─── Market Loader ────────────────────────────────────────────────────────────
async function loadMarket() {
  const url  = document.getElementById('marketUrl').value.trim();
  const slug = parsePolymarketURL(url);

  if (!slug) {
    setStatus('Invalid Polymarket URL. Expected: polymarket.com/event/{event}/{market}', 'error');
    return;
  }

  setStatus('Loading market…', 'loading');
  document.getElementById('loadBtn').disabled = true;

  try {
    // 1. Market metadata
    const metaRes = await fetch(`${GAMMA_API}/markets?slug=${encodeURIComponent(slug)}`);
    if (!metaRes.ok) throw new Error(`Gamma API ${metaRes.status}`);
    const markets = await metaRes.json();
    const market  = Array.isArray(markets) ? markets[0] : markets;
    if (!market) throw new Error('Market not found');

    state.marketQuestion = market.question || slug;
    state.slug           = slug;
    state.conditionId    = market.conditionId;

    // clobTokenIds is a JSON-encoded string in gamma API
    const tokenIds   = typeof market.clobTokenIds === 'string'
      ? JSON.parse(market.clobTokenIds)
      : (market.clobTokenIds || []);
    state.tokenId    = tokenIds[0] || null;

    state.maxSpreadCents = market.rewardsMaxSpread != null ? Math.floor(market.rewardsMaxSpread) : 5;
    state.minSize        = market.rewardsMinSize   != null ? market.rewardsMinSize   : 25;

    // Midpoint
    const bestBid = parseFloat(market.bestBid);
    const bestAsk = parseFloat(market.bestAsk);
    if (!isNaN(bestBid) && !isNaN(bestAsk)) {
      state.midpoint = (bestBid + bestAsk) / 2;
    } else if (market.outcomePrices) {
      state.midpoint = parseFloat(market.outcomePrices[0]) || 0.5;
    }

    // 2. Orderbook
    if (state.tokenId) {
      const bookRes = await fetch(`${CLOB_API}/book?token_id=${state.tokenId}`);
      if (bookRes.ok) {
        state.orderbook = await bookRes.json();
        const bids = state.orderbook.bids || [];
        const asks = state.orderbook.asks || [];
        if (bids.length && asks.length) {
          // Bids: descending → best bid = bids[0]
          // Asks: descending (0.999 first) → best ask = minimum price
          const lb = Math.max(...bids.map(b => parseFloat(b.price)));
          const la = Math.min(...asks.map(a => parseFloat(a.price)));
          if (!isNaN(lb) && !isNaN(la)) state.midpoint = (lb + la) / 2;
        }
      }
    }

    // Populate fields
    document.getElementById('marketName').textContent  = state.marketQuestion;
    document.getElementById('midpointInput').value     = state.midpoint != null ? state.midpoint.toFixed(4) : '';
    document.getElementById('maxSpreadInput').value    = state.maxSpreadCents;
    document.getElementById('minSizeInput').value      = state.minSize;
    document.getElementById('dailyPool').value         = '';

    // Update betmoar link
    const betmoarBtn = document.getElementById('betmoarBtn');
    betmoarBtn.href = `https://www.betmoar.fun/market/${encodeURIComponent(slug)}`;
    betmoarBtn.style.display = 'inline-block';

    // Suggest default bid/ask prices
    if (state.midpoint != null) {
      const v   = state.maxSpreadCents / 100;
      const mid = state.midpoint;
      document.getElementById('bidPrice').placeholder = Math.max(0.001, +(mid - v * 0.4).toFixed(3)).toFixed(3);
      document.getElementById('askPrice').placeholder = Math.min(0.999, +(mid + v * 0.4).toFixed(3)).toFixed(3);
    }

    const twoSidedBadge = document.getElementById('twoSidedBadge');
    twoSidedBadge.style.display =
      state.midpoint != null && (state.midpoint < 0.10 || state.midpoint > 0.90)
        ? 'inline-block' : 'none';

    document.getElementById('marketInfoCard').style.display = 'block';
    document.getElementById('ordersCard').style.display     = 'block';

    let bookInfo = 'no orderbook';
    if (state.orderbook) {
      const v   = state.maxSpreadCents / 100;
      const mid = state.midpoint;
      const eligBids = (state.orderbook.bids || []).filter(b => Math.abs(parseFloat(b.price) - mid) < v).length;
      const eligAsks = (state.orderbook.asks || []).filter(a => Math.abs(parseFloat(a.price) - mid) < v).length;
      const total    = (state.orderbook.bids?.length || 0) + (state.orderbook.asks?.length || 0);
      bookInfo = `${eligBids} eligible bids, ${eligAsks} eligible asks (${total} total)`;
    }
    setStatus(`Loaded — ${bookInfo}`, 'success');

  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error');
  } finally {
    document.getElementById('loadBtn').disabled = false;
  }
}

// ─── Score Formula ────────────────────────────────────────────────────────────
// S(v, s) = ((v − s) / v)² × size_usd
// size_usd = shares × price  (USDC committed)
function orderScore(price, sizeUsd, midpoint, v) {
  if (sizeUsd <= 0) return 0;
  const s = Math.abs(price - midpoint);
  if (s >= v) return 0;
  return Math.pow((v - s) / v, 2) * sizeUsd;
}

function effectiveQ(qOne, qTwo, midpoint) {
  if (midpoint < 0.10 || midpoint > 0.90) return Math.min(qOne, qTwo);
  return Math.max(Math.min(qOne, qTwo), Math.max(qOne / C, qTwo / C));
}

// shares → USDC committed
function sharesToUsd(shares, price) { return shares * price; }

// ─── Calculate ────────────────────────────────────────────────────────────────
function calculate() {
  const midpoint   = parseFloat(document.getElementById('midpointInput').value);
  const maxSpreadC = parseFloat(document.getElementById('maxSpreadInput').value);
  const dailyPool  = parseFloat(document.getElementById('dailyPool').value);
  const bidPrice   = parseFloat(document.getElementById('bidPrice').value) || 0;
  const bidShares  = parseFloat(document.getElementById('bidShares').value) || 0;
  const askPrice   = parseFloat(document.getElementById('askPrice').value) || 0;
  const askShares  = parseFloat(document.getElementById('askShares').value) || 0;

  const warnings = [], infos = [];

  if (isNaN(midpoint) || isNaN(maxSpreadC)) {
    alert('Please load a market first.');
    return;
  }
  if (isNaN(dailyPool) || dailyPool <= 0) {
    alert('Daily Reward Pool is required.');
    return;
  }

  const v = maxSpreadC / 100;

  // USDC committed per side (shares × price)
  const bidUsd = sharesToUsd(bidShares, bidPrice);
  const askUsd = sharesToUsd(askShares, askPrice);

  // User scores
  const userBidScore = bidShares > 0 ? orderScore(bidPrice, bidUsd, midpoint, v) : 0;
  const userAskScore = askShares > 0 ? orderScore(askPrice, askUsd, midpoint, v) : 0;

  // Market orderbook scores (sizes in book are already in shares → convert to USD)
  let mktQOne = 0, mktQTwo = 0;
  if (state.orderbook) {
    for (const b of (state.orderbook.bids || [])) {
      const p = parseFloat(b.price), sz = parseFloat(b.size);
      mktQOne += orderScore(p, sz * p, midpoint, v);
    }
    for (const a of (state.orderbook.asks || [])) {
      const p = parseFloat(a.price), sz = parseFloat(a.size);
      mktQTwo += orderScore(p, sz * p, midpoint, v);
    }
  }

  const totalQOne = mktQOne + userBidScore;
  const totalQTwo = mktQTwo + userAskScore;
  const userQ     = effectiveQ(userBidScore, userAskScore, midpoint);
  const totalQ    = effectiveQ(totalQOne, totalQTwo, midpoint);

  const share       = totalQ > 0 ? userQ / totalQ : 0;
  const dailyReward = share * dailyPool;
  const capitalUsd  = bidUsd + askUsd;
  const returnPct   = capitalUsd > 0 ? (dailyReward / capitalUsd) * 100 : 0;
  const apr         = returnPct * 365;

  // Min shares for $1 reward (scales both sides proportionally)
  let minShares1 = null;
  if (userQ > 0 && dailyPool > 1) {
    const mktEffQ      = effectiveQ(mktQOne, mktQTwo, midpoint);
    const target       = 1 / dailyPool;
    const userQPerSh   = (bidShares + askShares) > 0 ? userQ / (bidShares + askShares) : 0;
    const capitalPerSh = (bidShares + askShares) > 0 ? capitalUsd / (bidShares + askShares) : 0;
    if (userQPerSh > 0 && capitalPerSh > 0) {
      const k    = (target * mktEffQ) / (userQPerSh * (bidShares + askShares) * (1 - target));
      minShares1 = k * (bidShares + askShares);
    }
  } else if (userQ === 0) {
    minShares1 = Infinity;
  }

  // Warnings
  const minSize = parseFloat(document.getElementById('minSizeInput').value) || 0;
  if (bidShares > 0 && bidUsd < minSize)
    warnings.push(`Bid value $${bidUsd.toFixed(2)} is below min incentive size $${minSize} — order may not qualify.`);
  if (askShares > 0 && askUsd < minSize)
    warnings.push(`Ask value $${askUsd.toFixed(2)} is below min incentive size $${minSize} — order may not qualify.`);
  if (bidShares > 0 && userBidScore === 0)
    warnings.push(`Bid at ${bidPrice} is outside max spread (mid ± ${maxSpreadC}¢) — score is zero.`);
  if (askShares > 0 && userAskScore === 0)
    warnings.push(`Ask at ${askPrice} is outside max spread (mid ± ${maxSpreadC}¢) — score is zero.`);
  if ((midpoint < 0.10 || midpoint > 0.90) && (userBidScore === 0 || userAskScore === 0))
    warnings.push(`Extreme market (mid = ${(midpoint*100).toFixed(1)}%) — two-sided orders required.`);
  if (!state.orderbook?.bids?.length && !state.orderbook?.asks?.length)
    infos.push('No live orderbook — competitor liquidity not included in market total Q.');
  if (dailyPool < 1)
    infos.push('Polymarket minimum payout is $1/day. Smaller amounts are not distributed.');

  // Render
  document.getElementById('rDailyReward').textContent = `$${dailyReward.toFixed(4)}`;
  document.getElementById('rReturn').textContent      = `${returnPct.toFixed(3)}%`;
  document.getElementById('rApr').textContent         = `${apr.toFixed(1)}%`;
  document.getElementById('rMinSize').textContent     =
    minShares1 == null    ? '—' :
    minShares1 === Infinity ? '∞ (score=0)' :
    `${minShares1.toFixed(0)} shares`;

  document.getElementById('bkBidScore').textContent = userBidScore.toFixed(4);
  document.getElementById('bkAskScore').textContent = userAskScore.toFixed(4);
  document.getElementById('bkQone').textContent     = userBidScore.toFixed(4);
  document.getElementById('bkQtwo').textContent     = userAskScore.toFixed(4);
  document.getElementById('bkUserQ').textContent    = userQ.toFixed(4);
  document.getElementById('bkMarketQ').textContent  = totalQ.toFixed(4);
  document.getElementById('bkShare').textContent    = `${(share * 100).toFixed(4)}%`;

  const warnBox = document.getElementById('warningBox');
  const infoBox = document.getElementById('infoBox');
  warnBox.style.display = warnings.length ? 'block' : 'none';
  warnBox.innerHTML     = warnings.map(w => `⚠ ${w}`).join('<br>');
  infoBox.style.display = infos.length ? 'block' : 'none';
  infoBox.innerHTML     = infos.map(i => `ℹ ${i}`).join('<br>');

  document.getElementById('resultsCard').style.display = 'block';
  document.getElementById('resultsCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  updateScorePreviews(midpoint, v);
}

// ─── Live previews ────────────────────────────────────────────────────────────
function updateScorePreviews(mid, v) {
  const bidPrice  = parseFloat(document.getElementById('bidPrice').value);
  const bidShares = parseFloat(document.getElementById('bidShares').value);
  const askPrice  = parseFloat(document.getElementById('askPrice').value);
  const askShares = parseFloat(document.getElementById('askShares').value);

  function preview(elId, price, shares) {
    const el = document.getElementById(elId);
    if (!isNaN(price) && !isNaN(shares) && shares > 0 && mid != null) {
      const usd = shares * price;
      const sc  = orderScore(price, usd, mid, v);
      const s   = Math.abs(price - mid);
      el.textContent = sc > 0
        ? `$${usd.toFixed(2)} notional | spread ${(s*100).toFixed(2)}¢ → score ${sc.toFixed(4)}`
        : `$${usd.toFixed(2)} notional | spread ${(s*100).toFixed(2)}¢ → outside max (${(v*100).toFixed(2)}¢), score 0`;
      el.style.color = sc > 0 ? '#34d399' : '#f87171';
    } else {
      el.textContent = '';
    }
  }

  preview('bidScorePreview', bidPrice, bidShares);
  preview('askScorePreview', askPrice, askShares);
}

['bidPrice','bidShares','askPrice','askShares'].forEach(id => {
  document.getElementById(id).addEventListener('input', () => {
    const mid = parseFloat(document.getElementById('midpointInput').value);
    const v   = parseFloat(document.getElementById('maxSpreadInput').value) / 100;
    if (!isNaN(mid) && !isNaN(v)) updateScorePreviews(mid, v);
  });
});

document.getElementById('marketUrl').addEventListener('keydown', e => {
  if (e.key === 'Enter') loadMarket();
});

function setStatus(msg, type) {
  const el = document.getElementById('marketStatus');
  el.textContent = msg;
  el.className   = `status-msg ${type}`;
}
