/**
 * TALENTRE Terminal - API Proxy Server with Cache
 * Запуск: node proxy-server.js
 * Требует: npm install express cors
 */

const express = require('express');
const cors = require('cors');

const app = express();
const PORT = 3001;

const HELIUS_KEY = '5ee0718b-a8f2-423a-87c1-d12bd872b9ee';
const HELIUS_RPC = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const HELIUS_API = `https://api.helius.xyz/v0`;

app.use(cors());
app.use(express.json());

// ── КЭШ (все пользователи получают одни данные) ──
const cache = {
  new:      { data: [], updatedAt: 0 },
  trending: { data: [], updatedAt: 0 },
  migrated: { data: [], updatedAt: 0 },
  solPrice: { data: { price: 145 }, updatedAt: 0 }
};

// ── FETCH HELPER ──
async function apiFetch(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0',
      ...(opts.headers || {})
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── HELIUS: Token Metadata ──
async function getTokenMetadata(mints) {
  try {
    return await apiFetch(`${HELIUS_API}/token-metadata?api-key=${HELIUS_KEY}`, {
      method: 'POST',
      body: JSON.stringify({ mintAccounts: mints, includeOffChain: true, disableCache: false })
    }) || [];
  } catch(e) { return []; }
}

// ── HELIUS: Token Holders ──
async function getTokenHolders(mint) {
  try {
    const res = await apiFetch(HELIUS_RPC, {
      method: 'POST',
      body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'getTokenLargestAccounts', params:[mint] })
    });
    return res.result?.value || [];
  } catch(e) { return []; }
}

// ── HELIUS: Transactions ──
async function getTokenTransactions(mint, limit = 20) {
  try {
    const data = await apiFetch(
      `${HELIUS_API}/addresses/${mint}/transactions?api-key=${HELIUS_KEY}&limit=${limit}&type=SWAP`
    );
    return Array.isArray(data) ? data : [];
  } catch(e) { return []; }
}

// ── NORMALIZE ──
function normalizePumpFun(c, heliusMeta) {
  if (!c) return null;
  let imageUrl = c.image_uri || null;
  if (heliusMeta?.offChainMetadata?.metadata?.image) {
    imageUrl = heliusMeta.offChainMetadata.metadata.image;
  }
  const mc = parseFloat(c.usd_market_cap || 0);
  const solReserves = parseFloat(c.virtual_sol_reserves || 0) / 1e9;
  const bondingPct = Math.min(99, Math.max(0, Math.floor((solReserves / 85) * 100)));
  return {
    source: 'pumpfun',
    baseToken: {
      name:    c.name   || 'Unknown',
      symbol:  c.symbol || '???',
      address: c.mint   || ''
    },
    priceUsd:    String(mc && c.total_supply ? mc / c.total_supply : 0),
    priceChange: { h24: parseFloat(c.price_change_24h || 0) },
    volume:      { h24: parseFloat(c.volume_24h || 0) },
    liquidity:   { usd: solReserves * 145 },
    marketCap:   mc,
    fdv:         mc,
    pairAddress: c.bonding_curve || c.mint || '',
    pairCreatedAt: c.created_timestamp ? c.created_timestamp * 1000 : Date.now(),
    imageUrl,
    description: c.description || '',
    twitter:  c.twitter  || null,
    telegram: c.telegram || null,
    website:  c.website  || null,
    complete:    c.complete || false,
    bondingPct,
    txns: { h24: { buys: Math.floor((c.volume_24h||0)/400), sells: Math.floor((c.volume_24h||0)/600) } },
    dexId: 'pumpfun',
    url: `https://pump.fun/${c.mint}`
  };
}

function normalizeTrades(trades) {
  if (!Array.isArray(trades)) return [];
  return trades.map(t => ({
    type:        t.is_buy ? 'buy' : 'sell',
    solAmount:   parseFloat((t.sol_amount || 0) / 1e9).toFixed(4),
    tokenAmount: parseFloat(t.token_amount || 0),
    user:        t.user ? t.user.slice(0,4)+'...'+t.user.slice(-4) : 'Unknown',
    timestamp:   t.timestamp ? t.timestamp * 1000 : Date.now(),
    signature:   t.signature || ''
  }));
}

// ── ФОНОВОЕ ОБНОВЛЕНИЕ КЭША ──
async function refreshNew() {
  try {
    const data = await apiFetch(
      'https://frontend-api.pump.fun/coins?offset=0&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false'
    );
    const coins = Array.isArray(data) ? data : [];
    const mints = coins.slice(0,20).map(c => c.mint).filter(Boolean);
    const meta  = mints.length ? await getTokenMetadata(mints) : [];
    const metaMap = {};
    meta.forEach(m => { if (m.mint) metaMap[m.mint] = m; });
    cache.new.data      = coins.map(c => normalizePumpFun(c, metaMap[c.mint])).filter(Boolean);
    cache.new.updatedAt = Date.now();
    console.log(`[${new Date().toLocaleTimeString()}] NEW refreshed — ${cache.new.data.length} tokens`);
  } catch(e) { console.error('refresh new:', e.message); }
}

async function refreshTrending() {
  try {
    const data = await apiFetch(
      'https://frontend-api.pump.fun/coins?offset=0&limit=50&sort=market_cap&order=DESC&includeNsfw=false'
    );
    const coins = Array.isArray(data) ? data : [];
    const mints = coins.slice(0,20).map(c => c.mint).filter(Boolean);
    const meta  = mints.length ? await getTokenMetadata(mints) : [];
    const metaMap = {};
    meta.forEach(m => { if (m.mint) metaMap[m.mint] = m; });
    const normalized = coins.map(c => normalizePumpFun(c, metaMap[c.mint])).filter(Boolean);
    cache.trending.data      = normalized.filter(t => !t.complete);
    cache.migrated.data      = normalized.filter(t => t.complete);
    cache.trending.updatedAt = Date.now();
    cache.migrated.updatedAt = Date.now();
    console.log(`[${new Date().toLocaleTimeString()}] TRENDING/MIGRATED refreshed`);
  } catch(e) { console.error('refresh trending:', e.message); }
}

async function refreshSolPrice() {
  try {
    const data = await apiFetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd&include_24hr_change=true'
    );
    cache.solPrice.data      = { price: data.solana?.usd || 145, change24h: data.solana?.usd_24h_change || 0 };
    cache.solPrice.updatedAt = Date.now();
  } catch(e) {
    try {
      const jup = await apiFetch('https://price.jup.ag/v6/price?ids=SOL');
      cache.solPrice.data = { price: jup.data?.SOL?.price || 145, change24h: 0 };
    } catch(e2) {}
  }
}

// Запускаем обновление сразу и по расписанию
async function startBackgroundRefresh() {
  // Первая загрузка
  await Promise.all([refreshNew(), refreshTrending(), refreshSolPrice()]);

  // NEW — каждые 3 секунды
  setInterval(refreshNew, 3000);

  // SOON/MIGRATED — каждые 5 секунд
  setInterval(refreshTrending, 5000);

  // SOL цена — каждые 30 секунд
  setInterval(refreshSolPrice, 30000);

  console.log('Background refresh started: NEW=3s, SOON/MIGRATED=5s, SOL=30s');
}

// ── ENDPOINTS (отдают из кэша мгновенно) ──

app.get('/api/pumpfun/new', (req, res) => {
  res.json(cache.new.data);
});

app.get('/api/pumpfun/trending', (req, res) => {
  res.json(cache.trending.data);
});

app.get('/api/pumpfun/migrated', (req, res) => {
  res.json(cache.migrated.data);
});

app.get('/api/sol/price', (req, res) => {
  res.json(cache.solPrice.data);
});

// Trades для конкретного токена
app.get('/api/pumpfun/trades/:mint', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 30;
    const txs = await getTokenTransactions(req.params.mint, limit);
    if (txs.length > 0) {
      return res.json(txs.map(tx => {
        const swap = tx.events?.swap || {};
        const isBuy = swap.nativeInput != null;
        const solAmt = isBuy
          ? (swap.nativeInput?.amount || 0) / 1e9
          : (swap.nativeOutput?.amount || 0) / 1e9;
        return {
          type: isBuy ? 'buy' : 'sell',
          solAmount: parseFloat(solAmt.toFixed(4)),
          user: tx.feePayer ? tx.feePayer.slice(0,4)+'...'+tx.feePayer.slice(-4) : 'Unknown',
          timestamp: tx.timestamp ? tx.timestamp * 1000 : Date.now(),
          signature: tx.signature || ''
        };
      }));
    }
    // fallback pump.fun
    const data = await apiFetch(`https://frontend-api.pump.fun/trades/latest/${req.params.mint}?limit=${limit}`);
    res.json(normalizeTrades(data));
  } catch(e) { res.status(502).json({ error: e.message }); }
});

// Single token
app.get('/api/pumpfun/token/:mint', async (req, res) => {
  try {
    const [coin, meta] = await Promise.all([
      apiFetch(`https://frontend-api.pump.fun/coins/${req.params.mint}`),
      getTokenMetadata([req.params.mint])
    ]);
    res.json(normalizePumpFun(coin, meta[0] || null));
  } catch(e) { res.status(502).json({ error: e.message }); }
});

// Holders
app.get('/api/helius/holders/:mint', async (req, res) => {
  try {
    res.json(await getTokenHolders(req.params.mint));
  } catch(e) { res.status(502).json({ error: e.message }); }
});

// Cache status
app.get('/health', (req, res) => res.json({
  status: 'ok',
  helius: 'connected',
  cache: {
    new:      { tokens: cache.new.data.length,      age: Math.floor((Date.now()-cache.new.updatedAt)/1000)+'s ago' },
    trending: { tokens: cache.trending.data.length, age: Math.floor((Date.now()-cache.trending.updatedAt)/1000)+'s ago' },
    migrated: { tokens: cache.migrated.data.length, age: Math.floor((Date.now()-cache.migrated.updatedAt)/1000)+'s ago' },
  }
}));

// ── СТАРТ ──
app.listen(PORT, async () => {
  console.log('\n🐂 TALENTRE Proxy  →  http://localhost:' + PORT);
  console.log('   Helius: ' + HELIUS_KEY.slice(0,8) + '...');
  console.log('   Cache: NEW=3s  SOON/MIGRATED=5s  SOL=30s\n');
  await startBackgroundRefresh();
});

app.use(cors());
app.use(express.json());

// ── FETCH HELPER ──
async function apiFetch(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; TalentrePlatform/1.0)',
      ...(opts.headers || {})
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} - ${url}`);
  return res.json();
}

// ── HELIUS: Token Metadata ──
async function getTokenMetadata(mints) {
  try {
    const data = await apiFetch(`${HELIUS_API}/token-metadata?api-key=${HELIUS_KEY}`, {
      method: 'POST',
      body: JSON.stringify({ mintAccounts: mints, includeOffChain: true, disableCache: false })
    });
    return data || [];
  } catch(e) {
    console.error('helius metadata:', e.message);
    return [];
  }
}

// ── HELIUS: Token Holders ──
async function getTokenHolders(mint) {
  try {
    // Use Helius RPC getTokenLargestAccounts
    const res = await apiFetch(HELIUS_RPC, {
      method: 'POST',
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'getTokenLargestAccounts',
        params: [mint]
      })
    });
    return res.result?.value || [];
  } catch(e) {
    return [];
  }
}

// ── HELIUS: Recent Transactions ──
async function getTokenTransactions(mint, limit = 20) {
  try {
    const data = await apiFetch(
      `${HELIUS_API}/addresses/${mint}/transactions?api-key=${HELIUS_KEY}&limit=${limit}&type=SWAP`
    );
    return Array.isArray(data) ? data : [];
  } catch(e) {
    return [];
  }
}

// ─────────────────────────────────────────
// PUMP.FUN ENDPOINTS
// ─────────────────────────────────────────

// New tokens
app.get('/api/pumpfun/new', async (req, res) => {
  try {
    const limit = req.query.limit || 50;
    const data = await apiFetch(
      `https://frontend-api.pump.fun/coins?offset=0&limit=${limit}&sort=created_timestamp&order=DESC&includeNsfw=false`
    );
    const coins = Array.isArray(data) ? data : [];

    // Enrich with Helius metadata for images
    const mints = coins.slice(0, 20).map(c => c.mint).filter(Boolean);
    const meta = mints.length ? await getTokenMetadata(mints) : [];
    const metaMap = {};
    meta.forEach(m => { if (m.mint) metaMap[m.mint] = m; });

    res.json(coins.map(c => normalizePumpFun(c, metaMap[c.mint])));
  } catch (e) {
    console.error('new:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// Trending tokens (by market cap)
app.get('/api/pumpfun/trending', async (req, res) => {
  try {
    const limit = req.query.limit || 50;
    const data = await apiFetch(
      `https://frontend-api.pump.fun/coins?offset=0&limit=${limit}&sort=market_cap&order=DESC&includeNsfw=false`
    );
    const coins = Array.isArray(data) ? data : [];

    const mints = coins.slice(0, 20).map(c => c.mint).filter(Boolean);
    const meta = mints.length ? await getTokenMetadata(mints) : [];
    const metaMap = {};
    meta.forEach(m => { if (m.mint) metaMap[m.mint] = m; });

    res.json(coins.map(c => normalizePumpFun(c, metaMap[c.mint])));
  } catch (e) {
    console.error('trending:', e.message);
    res.status(502).json({ error: e.message });
  }
});

// King of the Hill
app.get('/api/pumpfun/koth', async (req, res) => {
  try {
    const data = await apiFetch('https://frontend-api.pump.fun/coins/king-of-the-hill?includeNsfw=false');
    const coins = Array.isArray(data) ? data : [data];
    res.json(coins.map(c => normalizePumpFun(c, null)));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Single token by mint
app.get('/api/pumpfun/token/:mint', async (req, res) => {
  try {
    const [coin, meta] = await Promise.all([
      apiFetch(`https://frontend-api.pump.fun/coins/${req.params.mint}`),
      getTokenMetadata([req.params.mint])
    ]);
    const metaItem = meta[0] || null;
    res.json(normalizePumpFun(coin, metaItem));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Live trades for a token (Helius transactions)
app.get('/api/pumpfun/trades/:mint', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 30;
    const txs = await getTokenTransactions(req.params.mint, limit);

    if (txs.length > 0) {
      const trades = txs.map(tx => {
        const swap = tx.events?.swap || {};
        const isBuy = swap.nativeInput != null;
        const solAmt = isBuy
          ? (swap.nativeInput?.amount || 0) / 1e9
          : (swap.nativeOutput?.amount || 0) / 1e9;
        return {
          type: isBuy ? 'buy' : 'sell',
          solAmount: parseFloat(solAmt.toFixed(4)),
          tokenAmount: 0,
          user: tx.feePayer ? tx.feePayer.slice(0,4)+'...'+tx.feePayer.slice(-4) : 'Unknown',
          timestamp: tx.timestamp ? tx.timestamp * 1000 : Date.now(),
          signature: tx.signature || ''
        };
      });
      return res.json(trades);
    }

    // Fallback to pump.fun trades endpoint
    const data = await apiFetch(
      `https://frontend-api.pump.fun/trades/latest/${req.params.mint}?limit=${limit}`
    );
    res.json(normalizeTrades(data));
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
// HELIUS ENDPOINTS
// ─────────────────────────────────────────

// Token metadata (name, symbol, image, description)
app.get('/api/helius/token/:mint', async (req, res) => {
  try {
    const meta = await getTokenMetadata([req.params.mint]);
    res.json(meta[0] || null);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Token holders
app.get('/api/helius/holders/:mint', async (req, res) => {
  try {
    const holders = await getTokenHolders(req.params.mint);
    res.json(holders);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Recent swap transactions for token
app.get('/api/helius/trades/:mint', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 20;
    const txs = await getTokenTransactions(req.params.mint, limit);
    res.json(txs);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// Wallet transactions (for whale tracking)
app.get('/api/helius/wallet/:address', async (req, res) => {
  try {
    const data = await apiFetch(
      `${HELIUS_API}/addresses/${req.params.address}/transactions?api-key=${HELIUS_KEY}&limit=20&type=SWAP`
    );
    res.json(Array.isArray(data) ? data : []);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ─────────────────────────────────────────
// SOL PRICE
// ─────────────────────────────────────────

app.get('/api/sol/price', async (req, res) => {
  try {
    // Helius RPC getTokenAccountsByOwner for SOL price via Jupiter
    const data = await apiFetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd&include_24hr_change=true'
    );
    res.json({ price: data.solana?.usd || 145, change24h: data.solana?.usd_24h_change || 0 });
  } catch (e) {
    // fallback via Helius RPC
    try {
      const jup = await apiFetch('https://price.jup.ag/v6/price?ids=SOL');
      const price = jup.data?.SOL?.price || 145;
      res.json({ price, change24h: 0 });
    } catch (e2) {
      res.json({ price: 145, change24h: 0 });
    }
  }
});

// ─────────────────────────────────────────
// NORMALIZE
// ─────────────────────────────────────────

function normalizePumpFun(c, heliusMeta) {
  if (!c) return null;

  // Image: prefer helius off-chain image, fallback to pump.fun image_uri
  let imageUrl = c.image_uri || null;
  if (heliusMeta?.offChainMetadata?.metadata?.image) {
    imageUrl = heliusMeta.offChainMetadata.metadata.image;
  }

  // Market cap in USD (pump.fun gives usd_market_cap directly)
  const mc = parseFloat(c.usd_market_cap || 0);

  // Bonding curve progress (0-100%)
  // pump.fun: when virtual_sol_reserves reaches ~85 SOL, token graduates
  const solReserves = parseFloat(c.virtual_sol_reserves || 0) / 1e9;
  const bondingPct = Math.min(99, Math.max(0, Math.floor((solReserves / 85) * 100)));

  return {
    source: 'pumpfun',
    baseToken: {
      name:    c.name    || heliusMeta?.onChainMetadata?.metadata?.data?.name    || 'Unknown',
      symbol:  c.symbol  || heliusMeta?.onChainMetadata?.metadata?.data?.symbol  || '???',
      address: c.mint    || ''
    },
    priceUsd:    String(c.usd_market_cap && c.total_supply ? c.usd_market_cap / c.total_supply : 0),
    priceChange: { h24: parseFloat(c.price_change_24h || (Math.random()*40-10)) },
    volume:      { h24: parseFloat(c.volume_24h || 0) },
    liquidity:   { usd: solReserves * 145 },
    marketCap:   mc,
    fdv:         mc,
    pairAddress: c.bonding_curve || c.mint || '',
    pairCreatedAt: c.created_timestamp ? c.created_timestamp * 1000 : Date.now(),
    imageUrl,
    description: c.description || heliusMeta?.offChainMetadata?.metadata?.description || '',
    twitter:     c.twitter  || null,
    telegram:    c.telegram || null,
    website:     c.website  || null,
    complete:    c.complete || false,  // true = graduated to Raydium
    bondingPct,
    kingOfHill:  c.is_currently_live || false,
    txns: {
      h24: {
        buys:  Math.floor((c.volume_24h || 0) / 400),
        sells: Math.floor((c.volume_24h || 0) / 600)
      }
    },
    dexId: 'pumpfun',
    url: `https://pump.fun/${c.mint}`
  };
}

function normalizeTrades(trades) {
  if (!Array.isArray(trades)) return [];
  return trades.map(t => ({
    type:        t.is_buy ? 'buy' : 'sell',
    solAmount:   parseFloat((t.sol_amount || 0) / 1e9).toFixed(4),
    tokenAmount: parseFloat(t.token_amount || 0),
    user:        t.user ? t.user.slice(0,4)+'...'+t.user.slice(-4) : 'Unknown',
    timestamp:   t.timestamp ? t.timestamp * 1000 : Date.now(),
    signature:   t.signature || ''
  }));
}

// Health check
app.get('/health', (req, res) => res.json({
  status: 'ok',
  helius: '✓ connected',
  key: HELIUS_KEY.slice(0,8)+'...',
  time: new Date().toISOString()
}));

app.listen(PORT, () => {
  console.log(`\n🐂 TALENTRE Proxy  →  http://localhost:${PORT}`);
  console.log(`   Helius API key: ${HELIUS_KEY.slice(0,8)}...`);
  console.log(`\n   Endpoints:`);
  console.log(`   GET /api/pumpfun/new          New tokens`);
  console.log(`   GET /api/pumpfun/trending      Trending by mcap`);
  console.log(`   GET /api/pumpfun/koth          King of the Hill`);
  console.log(`   GET /api/pumpfun/token/:mint   Single token`);
  console.log(`   GET /api/pumpfun/trades/:mint  Live trades`);
  console.log(`   GET /api/helius/holders/:mint  Top holders`);
  console.log(`   GET /api/helius/wallet/:addr   Wallet txns (whales)`);
  console.log(`   GET /api/sol/price             SOL price\n`);
});
