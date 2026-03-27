const express = require('express');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

const HELIUS_KEY = '5ee0718b-a8f2-423a-87c1-d12bd872b9ee';
const HELIUS_API = 'https://api.helius.xyz/v0';
const HELIUS_RPC = 'https://mainnet.helius-rpc.com/?api-key=' + HELIUS_KEY;

app.use(cors());
app.use(express.json());

// КЭШ
const cache = {
  new:      { data: [], updatedAt: 0 },
  trending: { data: [], updatedAt: 0 },
  migrated: { data: [], updatedAt: 0 },
  solPrice: { data: { price: 145 }, updatedAt: 0 }
};

async function apiFetch(url, opts) {
  opts = opts || {};
  const res = await fetch(url, {
    method: opts.method || 'GET',
    headers: Object.assign({
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0'
    }, opts.headers || {}),
    body: opts.body || undefined
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function getTokenMetadata(mints) {
  try {
    return await apiFetch(HELIUS_API + '/token-metadata?api-key=' + HELIUS_KEY, {
      method: 'POST',
      body: JSON.stringify({ mintAccounts: mints, includeOffChain: true, disableCache: false })
    }) || [];
  } catch(e) { return []; }
}

async function getTokenHolders(mint) {
  try {
    const res = await apiFetch(HELIUS_RPC, {
      method: 'POST',
      body: JSON.stringify({ jsonrpc:'2.0', id:1, method:'getTokenLargestAccounts', params:[mint] })
    });
    return res.result && res.result.value ? res.result.value : [];
  } catch(e) { return []; }
}

async function getTokenTransactions(mint, limit) {
  limit = limit || 20;
  try {
    const data = await apiFetch(
      HELIUS_API + '/addresses/' + mint + '/transactions?api-key=' + HELIUS_KEY + '&limit=' + limit + '&type=SWAP'
    );
    return Array.isArray(data) ? data : [];
  } catch(e) { return []; }
}

function normalizePumpFun(c, heliusMeta) {
  if (!c) return null;
  var imageUrl = c.image_uri || null;
  if (heliusMeta && heliusMeta.offChainMetadata && heliusMeta.offChainMetadata.metadata && heliusMeta.offChainMetadata.metadata.image) {
    imageUrl = heliusMeta.offChainMetadata.metadata.image;
  }
  var mc = parseFloat(c.usd_market_cap || 0);
  var solReserves = parseFloat(c.virtual_sol_reserves || 0) / 1e9;
  var bondingPct = Math.min(99, Math.max(0, Math.floor((solReserves / 85) * 100)));
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
    imageUrl:    imageUrl,
    description: c.description || '',
    twitter:     c.twitter  || null,
    telegram:    c.telegram || null,
    website:     c.website  || null,
    complete:    c.complete || false,
    bondingPct:  bondingPct,
    txns: { h24: { buys: Math.floor((c.volume_24h||0)/400), sells: Math.floor((c.volume_24h||0)/600) } },
    dexId: 'pumpfun',
    url: 'https://pump.fun/' + c.mint
  };
}

function normalizeTrades(trades) {
  if (!Array.isArray(trades)) return [];
  return trades.map(function(t) {
    return {
      type:        t.is_buy ? 'buy' : 'sell',
      solAmount:   parseFloat((t.sol_amount || 0) / 1e9).toFixed(4),
      tokenAmount: parseFloat(t.token_amount || 0),
      user:        t.user ? t.user.slice(0,4)+'...'+t.user.slice(-4) : 'Unknown',
      timestamp:   t.timestamp ? t.timestamp * 1000 : Date.now(),
      signature:   t.signature || ''
    };
  });
}

async function refreshNew() {
  try {
    var data = await apiFetch('https://frontend-api.pump.fun/coins?offset=0&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false');
    var coins = Array.isArray(data) ? data : [];
    var mints = coins.slice(0,20).map(function(c){ return c.mint; }).filter(Boolean);
    var meta = mints.length ? await getTokenMetadata(mints) : [];
    var metaMap = {};
    meta.forEach(function(m){ if(m.mint) metaMap[m.mint] = m; });
    cache.new.data = coins.map(function(c){ return normalizePumpFun(c, metaMap[c.mint]); }).filter(Boolean);
    cache.new.updatedAt = Date.now();
    console.log('[' + new Date().toLocaleTimeString() + '] NEW: ' + cache.new.data.length + ' tokens');
  } catch(e) { console.error('refresh new:', e.message); }
}

async function refreshTrending() {
  try {
    var data = await apiFetch('https://frontend-api.pump.fun/coins?offset=0&limit=50&sort=market_cap&order=DESC&includeNsfw=false');
    var coins = Array.isArray(data) ? data : [];
    var mints = coins.slice(0,20).map(function(c){ return c.mint; }).filter(Boolean);
    var meta = mints.length ? await getTokenMetadata(mints) : [];
    var metaMap = {};
    meta.forEach(function(m){ if(m.mint) metaMap[m.mint] = m; });
    var normalized = coins.map(function(c){ return normalizePumpFun(c, metaMap[c.mint]); }).filter(Boolean);
    cache.trending.data = normalized.filter(function(t){ return !t.complete; });
    cache.migrated.data = normalized.filter(function(t){ return t.complete; });
    cache.trending.updatedAt = Date.now();
    cache.migrated.updatedAt = Date.now();
    console.log('[' + new Date().toLocaleTimeString() + '] TRENDING: ' + cache.trending.data.length + ' MIGRATED: ' + cache.migrated.data.length);
  } catch(e) { console.error('refresh trending:', e.message); }
}

async function refreshSolPrice() {
  try {
    var data = await apiFetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    cache.solPrice.data = { price: (data.solana && data.solana.usd) ? data.solana.usd : 145 };
    cache.solPrice.updatedAt = Date.now();
  } catch(e) {
    try {
      var jup = await apiFetch('https://price.jup.ag/v6/price?ids=SOL');
      cache.solPrice.data = { price: (jup.data && jup.data.SOL) ? jup.data.SOL.price : 145 };
    } catch(e2) {}
  }
}

// ENDPOINTS
app.get('/api/pumpfun/new',      function(req, res){ res.json(cache.new.data); });
app.get('/api/pumpfun/trending', function(req, res){ res.json(cache.trending.data); });
app.get('/api/pumpfun/migrated', function(req, res){ res.json(cache.migrated.data); });
app.get('/api/sol/price',        function(req, res){ res.json(cache.solPrice.data); });

app.get('/api/pumpfun/trades/:mint', async function(req, res) {
  try {
    var limit = parseInt(req.query.limit) || 30;
    var txs = await getTokenTransactions(req.params.mint, limit);
    if (txs.length > 0) {
      return res.json(txs.map(function(tx) {
        var swap = (tx.events && tx.events.swap) ? tx.events.swap : {};
        var isBuy = swap.nativeInput != null;
        var solAmt = isBuy ? (swap.nativeInput.amount || 0) / 1e9 : (swap.nativeOutput ? swap.nativeOutput.amount || 0 : 0) / 1e9;
        return {
          type: isBuy ? 'buy' : 'sell',
          solAmount: parseFloat(solAmt.toFixed(4)),
          user: tx.feePayer ? tx.feePayer.slice(0,4)+'...'+tx.feePayer.slice(-4) : 'Unknown',
          timestamp: tx.timestamp ? tx.timestamp * 1000 : Date.now()
        };
      }));
    }
    var data = await apiFetch('https://frontend-api.pump.fun/trades/latest/' + req.params.mint + '?limit=' + limit);
    res.json(normalizeTrades(data));
  } catch(e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/pumpfun/token/:mint', async function(req, res) {
  try {
    var coin = await apiFetch('https://frontend-api.pump.fun/coins/' + req.params.mint);
    var meta = await getTokenMetadata([req.params.mint]);
    res.json(normalizePumpFun(coin, meta[0] || null));
  } catch(e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/helius/holders/:mint', async function(req, res) {
  try { res.json(await getTokenHolders(req.params.mint)); }
  catch(e) { res.status(502).json({ error: e.message }); }
});

app.get('/health', function(req, res) {
  res.json({
    status: 'ok',
    cache: {
      new:      cache.new.data.length + ' tokens',
      trending: cache.trending.data.length + ' tokens',
      migrated: cache.migrated.data.length + ' tokens'
    }
  });
});

// СТАРТ
app.listen(PORT, async function() {
  console.log('TALENTRE Proxy -> http://localhost:' + PORT);
  console.log('Helius: ' + HELIUS_KEY.slice(0,8) + '...');

  await Promise.all([refreshNew(), refreshTrending(), refreshSolPrice()]);

  setInterval(refreshNew,      3000);
  setInterval(refreshTrending, 5000);
  setInterval(refreshSolPrice, 30000);

  console.log('Cache running: NEW=3s TRENDING/MIGRATED=5s SOL=30s');
});
