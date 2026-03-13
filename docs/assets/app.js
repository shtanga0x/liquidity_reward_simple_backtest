'use strict';

const WORKER   = 'https://polymarket-proxy.bobrovnikovstepan.workers.dev';
const GAMMA_API = `${WORKER}/api/gamma`;
const CLOB_API  = `${WORKER}/api/clob`;
const C = 3.0; // single-side penalty factor per Polymarket docs

// ─── State ───────────────────────────────────────────────────────────────────
const state = {
  marketQuestion: '',
  conditionId: null,
  tokenId: null,
  midpoint: null,
  maxSpreadCents: null, // raw from API (in "cents", i.e. percent × 1)
  minSize: null,
  orderbook: null,
};

// ─── URL Parsing ──────────────────────────────────────────────────────────────
function parsePolymarketURL(url) {
  // https://polymarket.com/event/{event-slug}/{market-slug}
  const m = url.trim().match(/polymarket\.com\/event\/[^\/]+\/([^\/\?#]+)/);
  return m ? m[1] : null;
}

// ─── Market Loader ────────────────────────────────────────────────────────────
async function loadMarket() {
  const url = document.getElementById('marketUrl').value.trim();
  const slug = parsePolymarketURL(url);

  if (!slug) {
    setStatus('Invalid Polymarket URL. Expected: polymarket.com/event/{event}/{market}', 'error');
    return;
  }

  setStatus('Loading market…', 'loading');
  document.getElementById('loadBtn').disabled = true;

  try {
    // 1. Fetch market metadata from gamma API
    const metaRes = await fetch(`${GAMMA_API}/markets?slug=${encodeURIComponent(slug)}`);
    if (!metaRes.ok) throw new Error(`Gamma API ${metaRes.status}`);
    const markets = await metaRes.json();
    const market  = Array.isArray(markets) ? markets[0] : markets;
    if (!market) throw new Error('Market not found');

    state.marketQuestion = market.question || slug;
    state.conditionId    = market.conditionId;

    // clobTokenIds[0] = YES, [1] = NO
    const tokenIds = market.clobTokenIds || [];
    state.tokenId  = tokenIds[0] || null;

    // Rewards config
    state.maxSpreadCents = market.rewardsMaxSpread != null ? market.rewardsMaxSpread : 5;
    state.minSize        = market.rewardsMinSize   != null ? market.rewardsMinSize   : 25;

    // Midpoint from API fields
    const bestBid = parseFloat(market.bestBid);
    const bestAsk = parseFloat(market.bestAsk);
    if (!isNaN(bestBid) && !isNaN(bestAsk)) {
      state.midpoint = (bestBid + bestAsk) / 2;
    } else if (market.outcomePrices) {
      state.midpoint = parseFloat(market.outcomePrices[0]) || 0.5;
    }

    // 2. Fetch orderbook for YES token
    if (state.tokenId) {
      const bookRes = await fetch(`${CLOB_API}/book?token_id=${state.tokenId}`);
      if (bookRes.ok) {
        state.orderbook = await bookRes.json();
        // Refine midpoint from live book if available
        const bids = state.orderbook.bids || [];
        const asks = state.orderbook.asks || [];
        if (bids.length && asks.length) {
          const liveBestBid = parseFloat(bids[0].price);
          const liveBestAsk = parseFloat(asks[0].price);
          if (!isNaN(liveBestBid) && !isNaN(liveBestAsk)) {
            state.midpoint = (liveBestBid + liveBestAsk) / 2;
          }
        }
      }
    }

    // Populate UI fields
    document.getElementById('marketName').textContent     = state.marketQuestion;
    document.getElementById('midpointInput').value        = state.midpoint != null ? state.midpoint.toFixed(4) : '';
    document.getElementById('maxSpreadInput').value       = state.maxSpreadCents;
    document.getElementById('minSizeInput').value         = state.minSize;

    // Suggest default order prices around midpoint
    if (state.midpoint != null) {
      const v   = state.maxSpreadCents / 100;
      const mid = state.midpoint;
      const suggestBidPrice = Math.max(0.001, +(mid - v * 0.5).toFixed(3));
      const suggestAskPrice = Math.min(0.999, +(mid + v * 0.5).toFixed(3));
      document.getElementById('bidPrice').placeholder = suggestBidPrice.toFixed(3);
      document.getElementById('askPrice').placeholder = suggestAskPrice.toFixed(3);
    }

    // Show two-sided warning for extreme markets
    const twoSidedBadge = document.getElementById('twoSidedBadge');
    if (state.midpoint != null && (state.midpoint < 0.10 || state.midpoint > 0.90)) {
      twoSidedBadge.style.display = 'inline-block';
    } else {
      twoSidedBadge.style.display = 'none';
    }

    document.getElementById('marketInfoCard').style.display = 'block';
    document.getElementById('ordersCard').style.display     = 'block';
    setStatus(`Loaded — ${tokenIds.length ? `${state.orderbook?.bids?.length || 0} bids, ${state.orderbook?.asks?.length || 0} asks` : 'no orderbook'}`, 'success');

  } catch (err) {
    setStatus(`Error: ${err.message}`, 'error');
  } finally {
    document.getElementById('loadBtn').disabled = false;
  }
}

// ─── Score Formula ────────────────────────────────────────────────────────────
// S(v, s) = ((v − s) / v)² × size
// v = max spread in price units (0–1), s = distance from midpoint
function orderScore(price, size, midpoint, v) {
  if (size <= 0) return 0;
  const s = Math.abs(price - midpoint);
  if (s >= v) return 0;
  return Math.pow((v - s) / v, 2) * size;
}

// Q_eff per Polymarket rules
function effectiveQ(qOne, qTwo, midpoint) {
  if (midpoint < 0.10 || midpoint > 0.90) {
    // Extreme market: MUST be two-sided
    return Math.min(qOne, qTwo);
  }
  // Normal: single side allowed but penalised by factor c
  return Math.max(Math.min(qOne, qTwo), Math.max(qOne / C, qTwo / C));
}

// ─── Calculate ────────────────────────────────────────────────────────────────
function calculate() {
  const midpoint   = parseFloat(document.getElementById('midpointInput').value);
  const maxSpreadC = parseFloat(document.getElementById('maxSpreadInput').value);
  const dailyPool  = parseFloat(document.getElementById('dailyPool').value);
  const bidPrice   = parseFloat(document.getElementById('bidPrice').value) || 0;
  const bidSize    = parseFloat(document.getElementById('bidSize').value)  || 0;
  const askPrice   = parseFloat(document.getElementById('askPrice').value) || 0;
  const askSize    = parseFloat(document.getElementById('askSize').value)  || 0;

  // Validation
  const warnings = [];
  const infos    = [];

  if (isNaN(midpoint) || isNaN(maxSpreadC)) {
    alert('Please load a market first (midpoint and max spread are required).');
    return;
  }
  if (isNaN(dailyPool) || dailyPool <= 0) {
    alert('Please enter the Daily Reward Pool amount (from polymarket.com/rewards).');
    return;
  }

  const v = maxSpreadC / 100; // convert from "cents" (percentage points) to price units

  // ── User order scores ──
  const userBidScore = bidSize > 0 ? orderScore(bidPrice, bidSize, midpoint, v) : 0;
  const userAskScore = askSize > 0 ? orderScore(askPrice, askSize, midpoint, v) : 0;

  // ── Market orderbook totals ──
  let mktQOne = 0, mktQTwo = 0;

  if (state.orderbook) {
    for (const b of (state.orderbook.bids || [])) {
      mktQOne += orderScore(parseFloat(b.price), parseFloat(b.size), midpoint, v);
    }
    for (const a of (state.orderbook.asks || [])) {
      mktQTwo += orderScore(parseFloat(a.price), parseFloat(a.size), midpoint, v);
    }
  }

  // Add user's orders into market totals
  const totalQOne = mktQOne + userBidScore;
  const totalQTwo = mktQTwo + userAskScore;

  // ── User effective Q ──
  const userQ   = effectiveQ(userBidScore, userAskScore, midpoint);
  // ── Total market effective Q (approximation: one aggregate maker per side) ──
  const totalQ  = effectiveQ(totalQOne, totalQTwo, midpoint);

  // ── Share & reward ──
  const share       = totalQ > 0 ? userQ / totalQ : 0;
  const dailyReward = share * dailyPool;
  const capital     = bidSize + askSize;
  const returnPct   = capital > 0 ? (dailyReward / capital) * 100 : 0;
  const apr         = returnPct * 365;

  // ── Minimum capital for $1 reward ──
  let minCapital1 = null;
  if (userQ > 0 && dailyPool > 1) {
    // Solve: k × userQ / (k × userQ + mktEffQ) × dailyPool = 1
    // where mktEffQ = effectiveQ(mktQOne, mktQTwo, midpoint) (market without user)
    const mktEffQ = effectiveQ(mktQOne, mktQTwo, midpoint);
    const target  = 1 / dailyPool; // desired share for $1
    // k × userQ_norm × (1 − target) = target × mktEffQ
    const userQPerDollar = capital > 0 ? userQ / capital : 0;
    if (userQPerDollar > 0) {
      const k     = (target * mktEffQ) / (userQPerDollar * capital * (1 - target));
      minCapital1 = k * capital;
    }
  } else if (userQ === 0) {
    minCapital1 = Infinity;
  }

  // ── Warnings ──
  const minSize = parseFloat(document.getElementById('minSizeInput').value) || 0;
  if (bidSize > 0 && bidSize < minSize) warnings.push(`Bid size $${bidSize} is below min incentive size $${minSize} — this order may not qualify.`);
  if (askSize > 0 && askSize < minSize) warnings.push(`Ask size $${askSize} is below min incentive size $${minSize} — this order may not qualify.`);
  if (bidSize > 0 && userBidScore === 0) warnings.push(`Bid at ${bidPrice} is outside max spread (mid ± ${maxSpreadC}¢) — score is zero.`);
  if (askSize > 0 && userAskScore === 0) warnings.push(`Ask at ${askPrice} is outside max spread (mid ± ${maxSpreadC}¢) — score is zero.`);
  if ((midpoint < 0.10 || midpoint > 0.90) && (userBidScore === 0 || userAskScore === 0)) {
    warnings.push(`This is an extreme market (mid = ${(midpoint * 100).toFixed(1)}%). Two-sided orders required — single-side earns nothing.`);
  }
  if (!state.orderbook || !(state.orderbook.bids?.length) && !(state.orderbook.asks?.length)) {
    infos.push('No live orderbook loaded — market total Q estimated from your orders only. Load a market to include competitor liquidity.');
  }
  if (dailyPool < 1) {
    infos.push('Minimum Polymarket payout is $1/day. Rewards below $1 are not distributed.');
  }

  // ── Render ──
  document.getElementById('rDailyReward').textContent = `$${dailyReward.toFixed(4)}`;
  document.getElementById('rReturn').textContent      = `${returnPct.toFixed(3)}%`;
  document.getElementById('rApr').textContent         = `${apr.toFixed(1)}%`;
  document.getElementById('rMinSize').textContent     =
    minCapital1 == null ? '—' :
    minCapital1 === Infinity ? '∞ (score=0)' :
    `$${minCapital1.toFixed(2)}`;

  document.getElementById('bkBidScore').textContent  = userBidScore.toFixed(4);
  document.getElementById('bkAskScore').textContent  = userAskScore.toFixed(4);
  document.getElementById('bkQone').textContent      = userBidScore.toFixed(4);
  document.getElementById('bkQtwo').textContent      = userAskScore.toFixed(4);
  document.getElementById('bkUserQ').textContent     = userQ.toFixed(4);
  document.getElementById('bkMarketQ').textContent   = totalQ.toFixed(4);
  document.getElementById('bkShare').textContent     = `${(share * 100).toFixed(4)}%`;

  const warnBox = document.getElementById('warningBox');
  const infoBox = document.getElementById('infoBox');
  warnBox.style.display = warnings.length ? 'block' : 'none';
  warnBox.innerHTML     = warnings.map(w => `⚠ ${w}`).join('<br>');
  infoBox.style.display = infos.length ? 'block' : 'none';
  infoBox.innerHTML     = infos.map(i => `ℹ ${i}`).join('<br>');

  document.getElementById('resultsCard').style.display = 'block';
  document.getElementById('resultsCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  // Live score previews
  updateScorePreviews(midpoint, v);
}

// ─── Live previews while typing ───────────────────────────────────────────────
function updateScorePreviews(mid, v) {
  const bidPrice = parseFloat(document.getElementById('bidPrice').value);
  const bidSize  = parseFloat(document.getElementById('bidSize').value);
  const askPrice = parseFloat(document.getElementById('askPrice').value);
  const askSize  = parseFloat(document.getElementById('askSize').value);

  const bprev = document.getElementById('bidScorePreview');
  const aprev = document.getElementById('askScorePreview');

  if (!isNaN(bidPrice) && !isNaN(bidSize) && mid != null) {
    const sc = orderScore(bidPrice, bidSize, mid, v);
    const s  = Math.abs(bidPrice - mid);
    bprev.textContent = sc > 0
      ? `spread ${(s * 100).toFixed(2)}¢ → score ${sc.toFixed(4)}`
      : `spread ${(s * 100).toFixed(2)}¢ → outside max (${(v * 100).toFixed(2)}¢), score 0`;
    bprev.style.color = sc > 0 ? '#34d399' : '#f87171';
  } else {
    bprev.textContent = '';
  }

  if (!isNaN(askPrice) && !isNaN(askSize) && mid != null) {
    const sc = orderScore(askPrice, askSize, mid, v);
    const s  = Math.abs(askPrice - mid);
    aprev.textContent = sc > 0
      ? `spread ${(s * 100).toFixed(2)}¢ → score ${sc.toFixed(4)}`
      : `spread ${(s * 100).toFixed(2)}¢ → outside max (${(v * 100).toFixed(2)}¢), score 0`;
    aprev.style.color = sc > 0 ? '#34d399' : '#f87171';
  } else {
    aprev.textContent = '';
  }
}

// ─── Live preview on input ────────────────────────────────────────────────────
['bidPrice','bidSize','askPrice','askSize'].forEach(id => {
  document.getElementById(id).addEventListener('input', () => {
    const mid = parseFloat(document.getElementById('midpointInput').value);
    const v   = parseFloat(document.getElementById('maxSpreadInput').value) / 100;
    if (!isNaN(mid) && !isNaN(v)) updateScorePreviews(mid, v);
  });
});

document.getElementById('marketUrl').addEventListener('keydown', e => {
  if (e.key === 'Enter') loadMarket();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
function setStatus(msg, type) {
  const el = document.getElementById('marketStatus');
  el.textContent  = msg;
  el.className    = `status-msg ${type}`;
}
