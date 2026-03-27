const express = require('express');
const cors = require('cors');
const { WebSocket } = require('ws');

const app = express();
const PORT = process.env.PORT || 3001;

const HELIUS_KEY = '5ee0718b-a8f2-423a-87c1-d12bd872b9ee';
const HELIUS_API = 'https://api.helius.xyz/v0';

app.use(cors());
app.use(express.json());

// КЭШ
const cache = {
  new:      { data: [], updatedAt: 0 },
  trending: { data: [], updatedAt: 0 },
  migrated: { data: [], updatedAt: 0 },
  solPrice: { data: { price: 145 }, updatedAt: 0 }
};

// ── HELIUS metadata ──
async function getTokenMetadata(mints) {
  try {
    const res = await fetch(HELIUS_API + '/token-metadata?api-key=' + HELIUS_KEY, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mintAccounts: mints, includeOffChain: true, disableCache: false })
    });
    return await res.json() || [];
  } catch(e) { return []; }
}

// ── SOL price ──
async function refreshSolPrice() {
  try {
    const res = await fetch('https://price.jup.ag/v6/price?ids=SOL');
    const data = await res.json();
    if (data.data && data.data.SOL) {
      cache.solPrice.data = { price: data.data.SOL.price };
      cache.solPrice.updatedAt = Date.now();
    }
  } catch(e) {
    try {
      const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
      const data = await res.json();
      if (data.solana) cache.solPrice.data = { price: data.solana.usd };
    } catch(e2) {}
  }
}

// ── PUMP.FUN WebSocket ──
// Подключаемся к pump.fun через WebSocket — это не блокируется
let wsConnected = false;
const recentTokens = new Map(); // mint -> token data

function connectPumpFunWS() {
  console.log('Connecting to pump.fun WebSocket...');
  
  const ws = new WebSocket('wss://frontend-api.pump.fun/socket.io/?EIO=4&transport=websocket', {
    headers: {
      'Origin': 'https://pump.fun',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    }
  });

  ws.on('open', function() {
    wsConnected = true;
    console.log('pump.fun WS connected!');
    // Subscribe to new tokens
    ws.send('40');
    setTimeout(() => {
      ws.send('42["subscribeNewToken"]');
    }, 500);
  });

  ws.on('message', function(raw) {
    try {
      const msg = raw.toString();
      // Parse socket.io messages
      if (msg.startsWith('42')) {
        const json = JSON.parse(msg.slice(2));
        const event = json[0];
        const data  = json[1];

        if (event === 'newToken' && data) {
          const token = normalizeWSToken(data);
          if (token) {
            recentTokens.set(data.mint, { token, ts: Date.now() });
            updateCacheFromWS();
          }
        }
        if (event === 'tradeCreated' && data && data.mint) {
          // Update existing token with trade data
          if (recentTokens.has(data.mint)) {
            const entry = recentTokens.get(data.mint);
            entry.token.volume = { h24: (entry.token.volume?.h24 || 0) + (data.sol_amount / 1e9) * cache.solPrice.data.price };
            if (data.usd_market_cap) entry.token.marketCap = data.usd_market_cap;
            updateCacheFromWS();
          }
        }
      }
      // Keep-alive
      if (msg === '2') ws.send('3');
    } catch(e) {}
  });

  ws.on('close', function() {
    wsConnected = false;
    console.log('pump.fun WS disconnected, reconnecting in 3s...');
    setTimeout(connectPumpFunWS, 3000);
  });

  ws.on('error', function(e) {
    console.error('pump.fun WS error:', e.message);
  });
}

function normalizeWSToken(d) {
  if (!d || !d.mint) return null;
  return {
    source: 'pumpfun',
    baseToken: {
      name:    d.name   || 'Unknown',
      symbol:  d.symbol || '???',
      address: d.mint   || ''
    },
    priceUsd:    String(d.usd_market_cap && d.total_supply ? d.usd_market_cap / d.total_supply : 0),
    priceChange: { h24: 0 },
    volume:      { h24: 0 },
    liquidity:   { usd: 0 },
    marketCap:   parseFloat(d.usd_market_cap || 0),
    fdv:         parseFloat(d.usd_market_cap || 0),
    pairAddress: d.bonding_curve || d.mint || '',
    pairCreatedAt: Date.now(),
    imageUrl:    d.image_uri || null,
    description: d.description || '',
    twitter:     d.twitter  || null,
    telegram:    d.telegram || null,
    website:     d.website  || null,
    complete:    false,
    bondingPct:  0,
    txns:        { h24: { buys: 0, sells: 0 } },
    dexId:       'pumpfun',
    url:         'https://pump.fun/' + d.mint
  };
}

function updateCacheFromWS() {
  const now = Date.now();
  // Keep only last 10 minutes of tokens
  for (const [mint, entry] of recentTokens.entries()) {
    if (now - entry.ts > 10 * 60 * 1000) recentTokens.delete(mint);
  }
  const tokens = Array.from(recentTokens.values())
    .sort((a, b) => b.ts - a.ts)
    .map(e => e.token);
  
  cache.new.data      = tokens.slice(0, 30);
  cache.new.updatedAt = now;
}

// ── Fallback: DexScreener (если WS не работает) ──
async function fetchFromDexScreener() {
  try {
    const res = await fetch('https://api.dexscreener.com/token-boosts/top/v1');
    const boosts = await res.json();
    const solBoosts = (Array.isArray(boosts) ? boosts : [])
      .filter(b => b.chainId === 'solana').slice(0, 20);
    
    if (!solBoosts.length) throw new Error('no boosts');
    
    const addresses = solBoosts.map(b => b.tokenAddress).filter(Boolean).join(',');
    const pRes = await fetch('https://api.dexscreener.com/latest/dex/tokens/' + addresses);
    const pData = await pRes.json();
    const pairs = (pData.pairs || [])
      .filter(p => p.chainId === 'solana' && parseFloat(p.priceUsd) > 0)
      .sort((a,b) => (parseFloat(b.volume?.h24)||0) - (parseFloat(a.volume?.h24)||0));

    if (pairs.length > 0) {
      cache.new.data      = pairs.slice(0, 15).map(p => normDex(p, false));
      cache.trending.data = pairs.slice(0, 20).map(p => normDex(p, false));
      cache.migrated.data = pairs.slice(20, 35).map(p => normDex(p, true));
      const now = Date.now();
      cache.new.updatedAt = cache.trending.updatedAt = cache.migrated.updatedAt = now;
      console.log('DexScreener fallback: ' + pairs.length + ' pairs loaded');
    }
  } catch(e) {
    console.error('DexScreener fallback failed:', e.message);
  }
}

function normDex(p, migrated) {
  return {
    source: 'dexscreener',
    baseToken: {
      name:    p.baseToken?.name   || 'Unknown',
      symbol:  p.baseToken?.symbol || '???',
      address: p.baseToken?.address || ''
    },
    priceUsd:    p.priceUsd || '0',
    priceChange: { h24: parseFloat(p.priceChange?.h24 || 0) },
    volume:      { h24: parseFloat(p.volume?.h24 || 0) },
    liquidity:   { usd: parseFloat(p.liquidity?.usd || 0) },
    marketCap:   parseFloat(p.marketCap || p.fdv || 0),
    fdv:         parseFloat(p.fdv || 0),
    pairAddress: p.pairAddress || '',
    pairCreatedAt: p.pairCreatedAt || Date.now(),
    imageUrl:    p.info?.imageUrl || null,
    complete:    migrated,
    bondingPct:  migrated ? 100 : 50,
    txns:        p.txns || { h24: { buys: 0, sells: 0 } },
    dexId:       p.dexId || 'raydium',
    url:         p.url || ''
  };
}

// ── ENDPOINTS ──
app.get('/api/pumpfun/new',      (req, res) => res.json(cache.new.data));
app.get('/api/pumpfun/trending', (req, res) => res.json(cache.trending.data));
app.get('/api/pumpfun/migrated', (req, res) => res.json(cache.migrated.data));
app.get('/api/sol/price',        (req, res) => res.json(cache.solPrice.data));

app.get('/api/pumpfun/trades/:mint', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 30;
    const r = await fetch(
      HELIUS_API + '/addresses/' + req.params.mint + '/transactions?api-key=' + HELIUS_KEY + '&limit=' + limit + '&type=SWAP'
    );
    const txs = await r.json();
    if (Array.isArray(txs) && txs.length > 0) {
      return res.json(txs.map(tx => {
        const swap = tx.events?.swap || {};
        const isBuy = swap.nativeInput != null;
        const sol = isBuy ? (swap.nativeInput?.amount||0)/1e9 : (swap.nativeOutput?.amount||0)/1e9;
        return {
          type: isBuy ? 'buy' : 'sell',
          solAmount: sol.toFixed(4),
          user: tx.feePayer ? tx.feePayer.slice(0,4)+'...'+tx.feePayer.slice(-4) : '???',
          timestamp: tx.timestamp ? tx.timestamp*1000 : Date.now()
        };
      }));
    }
    res.json([]);
  } catch(e) { res.status(502).json({ error: e.message }); }
});

app.get('/health', (req, res) => res.json({
  status: 'ok',
  wsConnected,
  cache: {
    new:      cache.new.data.length + ' tokens',
    trending: cache.trending.data.length + ' tokens',
    migrated: cache.migrated.data.length + ' tokens',
  }
}));

// ── СТАРТ ──
app.listen(PORT, async () => {
  console.log('TALENTRE Proxy -> port ' + PORT);
  
  // Сначала загружаем из DexScreener (мгновенно)
  await fetchFromDexScreener();
  
  // Потом подключаем pump.fun WebSocket для новых токенов
  connectPumpFunWS();
  
  // Обновляем DexScreener каждые 5 секунд как основной источник
  setInterval(fetchFromDexScreener, 5000);
  setInterval(refreshSolPrice, 30000);
  refreshSolPrice();
  
  console.log('Ready!');
});
