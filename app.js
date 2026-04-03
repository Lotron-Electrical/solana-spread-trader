/* ═══════════════════════════════════════════════════════════════
   Solana Spread Trader — SOL/AUD
   Core trading engine (JS fallback), CoinGecko API, Phantom wallet,
   Jupiter DEX, canvas charts, simulation, paper trading.
   ═══════════════════════════════════════════════════════════════ */

'use strict';

/* ── Configuration ── */
const CONFIG = {
    COINGECKO_BASE: 'https://api.coingecko.com/api/v3',
    JUPITER_QUOTE_API: 'https://quote-api.jup.ag/v6',
    JUPITER_SWAP_API: 'https://quote-api.jup.ag/v6/swap',
    SOL_MINT: 'So11111111111111111111111111111111111111112',
    USDC_MINT: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    PRICE_POLL_MS: 10000,
    CHART_POINTS: 100,
    INITIAL_BALANCE_AUD: 10000,
    DEFAULT_THRESHOLD: 0.50,
    SIMULATED_SPREAD_PCT: 0.15,
    LOCAL_STORAGE_KEY: 'sol_spread_trader_state',
};

/* ── Application State ── */
const state = {
    mode: 'paper',          // 'paper' | 'simulation' | 'live'
    wallet: null,            // Phantom wallet public key
    walletConnected: false,

    /* Prices */
    currentPrice: 0,
    bidPrice: 0,
    askPrice: 0,
    spread: 0,
    spreadPct: 0,
    priceChange24h: 0,
    prices: [],              // Historical price points for chart
    chartPeriod: '24h',

    /* Trading */
    threshold: CONFIG.DEFAULT_THRESHOLD,
    tradeAmountAud: 100,
    autoTrade: false,
    balanceAud: CONFIG.INITIAL_BALANCE_AUD,
    balanceSol: 0,
    initialAud: CONFIG.INITIAL_BALANCE_AUD,
    totalPnl: 0,
    totalPnlPct: 0,
    peakBalance: CONFIG.INITIAL_BALANCE_AUD,
    maxDrawdown: 0,
    winRate: 0,
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    trades: [],

    /* Simulation */
    simRunning: false,

    /* Projection / Watch */
    watchRunning: false,
    watchPaused: false,
    watchTimer: null,
    watchCandles: [],
    watchIndex: 0,
    watchSavedState: null,  /* Snapshot to restore after watch ends */

    /* Engine */
    engineType: 'JavaScript',
    priceInterval: null,
    chartAnimFrame: null,
};

/* ═══════════════════════════════════════════════════════════════
   TRADING ENGINE (JS — mirrors the C engine)
   ═══════════════════════════════════════════════════════════════ */

const Engine = {
    calculateSpread(bid, ask) {
        return ask - bid;
    },

    calculateSpreadPct(bid, ask) {
        if (bid <= 0) return 0;
        const mid = (bid + ask) / 2;
        if (mid <= 0) return 0;
        return ((ask - bid) / mid) * 100;
    },

    shouldTrade(spreadPct, threshold) {
        return threshold > spreadPct;
    },

    /* Track cost basis for current open position */
    _costBasis: { totalCost: 0, totalSol: 0 },

    resetCostBasis() {
        Engine._costBasis = { totalCost: 0, totalSol: 0 };
    },

    executeBuy(amountAud, askPrice) {
        if (amountAud <= 0 || askPrice <= 0) return null;
        if (amountAud > state.balanceAud) return null;

        const solReceived = amountAud / askPrice;
        state.balanceAud -= amountAud;
        state.balanceSol += solReceived;

        /* Update cost basis for current position */
        Engine._costBasis.totalCost += amountAud;
        Engine._costBasis.totalSol += solReceived;

        const trade = {
            timestamp: Date.now(),
            isBuy: true,
            price: askPrice,
            amountSol: solReceived,
            amountAud: amountAud,
            spreadAtTrade: state.spreadPct,
            pnl: 0,
        };
        state.trades.push(trade);
        state.totalTrades++;
        Engine.updatePnl();
        return trade;
    },

    executeSell(amountSol, bidPrice) {
        if (amountSol <= 0 || bidPrice <= 0) return null;
        if (amountSol > state.balanceSol) return null;

        const audReceived = amountSol * bidPrice;
        state.balanceSol -= amountSol;
        state.balanceAud += audReceived;

        /* P&L vs average buy price for current position */
        const cb = Engine._costBasis;
        const avgPrice = cb.totalSol > 0 ? cb.totalCost / cb.totalSol : 0;
        const tradePnl = (bidPrice - avgPrice) * amountSol;

        /* If full sell, reset cost basis for next position */
        if (state.balanceSol < 0.000001) {
            Engine.resetCostBasis();
        } else {
            /* Partial sell — reduce cost basis proportionally */
            const ratio = amountSol / (amountSol + state.balanceSol);
            cb.totalCost *= (1 - ratio);
            cb.totalSol -= amountSol;
        }

        const trade = {
            timestamp: Date.now(),
            isBuy: false,
            price: bidPrice,
            amountSol: amountSol,
            amountAud: audReceived,
            spreadAtTrade: state.spreadPct,
            pnl: tradePnl,
        };
        state.trades.push(trade);
        state.totalTrades++;
        if (tradePnl > 0) state.winningTrades++;
        else state.losingTrades++;

        Engine.updatePnl();
        return trade;
    },

    updatePnl() {
        const currentValue = state.balanceAud + (state.balanceSol * state.bidPrice);
        state.totalPnl = currentValue - state.initialAud;
        state.totalPnlPct = state.initialAud > 0 ? (state.totalPnl / state.initialAud) * 100 : 0;

        if (currentValue > state.peakBalance) state.peakBalance = currentValue;
        if (state.peakBalance > 0) {
            const dd = ((state.peakBalance - currentValue) / state.peakBalance) * 100;
            if (dd > state.maxDrawdown) state.maxDrawdown = dd;
        }
        state.winRate = state.totalTrades > 0
            ? (state.winningTrades / state.totalTrades) * 100 : 0;
    },

    /* ── Simulation Engine ── */
    runSimulation(candles, initialAud, threshold, tradePct) {
        if (!candles.length || initialAud <= 0) return null;
        if (tradePct <= 0 || tradePct > 100) tradePct = 10;

        const sim = {
            balanceAud: initialAud,
            balanceSol: 0,
            initialAud: initialAud,
            peakBalance: initialAud,
            maxDrawdown: 0,
            trades: [],
            totalTrades: 0,
            winningTrades: 0,
            losingTrades: 0,
            equityCurve: [],
        };

        let holdingSol = false;
        let costBasis = { totalCost: 0, totalSol: 0 };

        for (let i = 0; i < candles.length; i++) {
            const c = candles[i];
            const range = Math.max(c.high - c.low, c.close * 0.001);
            const halfSpread = range * 0.25;
            const bid = Math.max(c.close - halfSpread, c.close * 0.999);
            const ask = Math.max(c.close + halfSpread, c.close * 1.001);
            const spreadPct = Engine.calculateSpreadPct(bid, ask);
            const signal = Engine.shouldTrade(spreadPct, threshold);

            if (signal && !holdingSol && sim.balanceAud > 0) {
                let amount = sim.balanceAud * (tradePct / 100);
                if (amount < 1) amount = sim.balanceAud;
                const solReceived = amount / ask;
                sim.balanceAud -= amount;
                sim.balanceSol += solReceived;
                costBasis.totalCost += amount;
                costBasis.totalSol += solReceived;
                sim.trades.push({
                    timestamp: c.timestamp,
                    isBuy: true,
                    price: ask,
                    amountSol: solReceived,
                    amountAud: amount,
                    spreadPct: spreadPct,
                    pnl: 0,
                });
                sim.totalTrades++;
                holdingSol = true;
            } else if (!signal && holdingSol && sim.balanceSol > 0) {
                const audReceived = sim.balanceSol * bid;
                const avgPrice = costBasis.totalSol > 0 ? costBasis.totalCost / costBasis.totalSol : 0;
                const tradePnl = (bid - avgPrice) * sim.balanceSol;

                sim.trades.push({
                    timestamp: c.timestamp,
                    isBuy: false,
                    price: bid,
                    amountSol: sim.balanceSol,
                    amountAud: audReceived,
                    spreadPct: spreadPct,
                    pnl: tradePnl,
                });
                sim.totalTrades++;
                if (tradePnl > 0) sim.winningTrades++;
                else sim.losingTrades++;

                sim.balanceSol = 0;
                sim.balanceAud += audReceived;
                costBasis = { totalCost: 0, totalSol: 0 };
                holdingSol = false;
            }

            /* Track equity curve */
            const equity = sim.balanceAud + (sim.balanceSol * bid);
            if (equity > sim.peakBalance) sim.peakBalance = equity;
            if (sim.peakBalance > 0) {
                const dd = ((sim.peakBalance - equity) / sim.peakBalance) * 100;
                if (dd > sim.maxDrawdown) sim.maxDrawdown = dd;
            }
            sim.equityCurve.push({ timestamp: c.timestamp, value: equity });
        }

        /* Close remaining position */
        if (holdingSol && sim.balanceSol > 0 && candles.length > 0) {
            const last = candles[candles.length - 1];
            const audReceived = sim.balanceSol * (last.close * 0.999);
            sim.balanceAud += audReceived;
            sim.balanceSol = 0;
        }

        const finalBalance = sim.balanceAud;
        const totalPnl = finalBalance - initialAud;
        const returnPct = (totalPnl / initialAud) * 100;

        /* Sharpe ratio */
        const sellReturns = sim.trades.filter(t => !t.isBuy && t.amountAud > 0)
            .map(t => t.pnl / t.amountAud);
        let sharpe = 0;
        if (sellReturns.length >= 2) {
            const mean = sellReturns.reduce((a, b) => a + b, 0) / sellReturns.length;
            const variance = sellReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (sellReturns.length - 1);
            const std = Math.sqrt(variance);
            if (std > 1e-10) sharpe = mean / std;
        }

        const sellTrades = sim.trades.filter(t => !t.isBuy);
        const bestTrade = sellTrades.length ? Math.max(...sellTrades.map(t => t.pnl)) : 0;
        const worstTrade = sellTrades.length ? Math.min(...sellTrades.map(t => t.pnl)) : 0;

        return {
            finalBalance,
            totalPnl,
            returnPct,
            maxDrawdown: sim.maxDrawdown,
            winRate: sim.totalTrades > 0 ? (sim.winningTrades / sim.totalTrades) * 100 : 0,
            sharpe,
            totalTrades: sim.totalTrades,
            winningTrades: sim.winningTrades,
            losingTrades: sim.losingTrades,
            avgTradePnl: sim.totalTrades > 0 ? totalPnl / sim.totalTrades : 0,
            bestTrade,
            worstTrade,
            trades: sim.trades,
            equityCurve: sim.equityCurve,
        };
    },
};


/* ═══════════════════════════════════════════════════════════════
   API — CoinGecko
   ═══════════════════════════════════════════════════════════════ */

const API = {
    async fetchPrice() {
        try {
            const res = await fetch(
                `${CONFIG.COINGECKO_BASE}/simple/price?ids=solana&vs_currencies=aud&include_24hr_change=true`
            );
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            return {
                price: data.solana.aud,
                change24h: data.solana.aud_24h_change || 0,
            };
        } catch (err) {
            console.warn('Price fetch failed:', err.message);
            return null;
        }
    },

    async fetchChartData(days) {
        try {
            const res = await fetch(
                `${CONFIG.COINGECKO_BASE}/coins/solana/market_chart?vs_currency=aud&days=${days}`
            );
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            return data.prices.map(([timestamp, price]) => ({ timestamp, price }));
        } catch (err) {
            console.warn('Chart data fetch failed:', err.message);
            return null;
        }
    },

    async fetchOHLC(days) {
        try {
            const res = await fetch(
                `${CONFIG.COINGECKO_BASE}/coins/solana/ohlc?vs_currency=aud&days=${days}`
            );
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            return data.map(([timestamp, open, high, low, close]) => ({
                timestamp, open, high, low, close, volume: 0,
            }));
        } catch (err) {
            console.warn('OHLC fetch failed:', err.message);
            return null;
        }
    },

    async fetchHistoricalRange(fromTs, toTs) {
        try {
            const res = await fetch(
                `${CONFIG.COINGECKO_BASE}/coins/solana/market_chart/range?vs_currency=aud&from=${fromTs}&to=${toTs}`
            );
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            /* Convert to candle-like format using price points */
            const prices = data.prices;
            if (!prices || prices.length < 2) return [];

            /* Group into ~4h candles */
            const candles = [];
            const interval = 4 * 60 * 60 * 1000;
            let i = 0;
            while (i < prices.length) {
                const start = prices[i][0];
                const end = start + interval;
                let open = prices[i][1], high = open, low = open, close = open;
                while (i < prices.length && prices[i][0] < end) {
                    const p = prices[i][1];
                    if (p > high) high = p;
                    if (p < low) low = p;
                    close = p;
                    i++;
                }
                candles.push({ timestamp: start, open, high, low, close, volume: 0 });
            }
            return candles;
        } catch (err) {
            console.warn('Historical range fetch failed:', err.message);
            return [];
        }
    },
};


/* ═══════════════════════════════════════════════════════════════
   WALLET — Phantom
   ═══════════════════════════════════════════════════════════════ */

const Wallet = {
    getProvider() {
        if ('phantom' in window && window.phantom?.solana?.isPhantom) {
            return window.phantom.solana;
        }
        return null;
    },

    async connect() {
        const provider = Wallet.getProvider();
        if (!provider) {
            UI.showNotification('Phantom wallet not detected. Install it from phantom.app', 'error');
            return false;
        }
        try {
            const resp = await provider.connect();
            state.wallet = resp.publicKey.toString();
            state.walletConnected = true;
            UI.updateWalletButton();
            UI.showNotification(`Connected: ${state.wallet.slice(0, 4)}...${state.wallet.slice(-4)}`, 'success');
            return true;
        } catch (err) {
            console.warn('Wallet connection failed:', err);
            UI.showNotification('Wallet connection cancelled', 'error');
            return false;
        }
    },

    async disconnect() {
        const provider = Wallet.getProvider();
        if (provider) {
            try { await provider.disconnect(); } catch (_) { /* ignore */ }
        }
        state.wallet = null;
        state.walletConnected = false;
        UI.updateWalletButton();
    },

    async executeLiveSwap(inputMint, outputMint, amountLamports) {
        if (!state.walletConnected) {
            UI.showNotification('Connect your wallet first', 'error');
            return null;
        }
        const provider = Wallet.getProvider();
        if (!provider) return null;

        try {
            /* Get quote from Jupiter */
            const quoteRes = await fetch(
                `${CONFIG.JUPITER_QUOTE_API}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=50`
            );
            if (!quoteRes.ok) throw new Error('Jupiter quote failed');
            const quote = await quoteRes.json();

            /* Get swap transaction */
            const swapRes = await fetch(CONFIG.JUPITER_SWAP_API, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    quoteResponse: quote,
                    userPublicKey: state.wallet,
                    wrapAndUnwrapSol: true,
                }),
            });
            if (!swapRes.ok) throw new Error('Jupiter swap failed');
            const swapData = await swapRes.json();

            /* Deserialize the versioned transaction from Jupiter's base64 response */
            const { swapTransaction } = swapData;
            const txBuf = Uint8Array.from(atob(swapTransaction), c => c.charCodeAt(0));

            /* Phantom accepts raw Uint8Array buffers via signAndSendTransaction.
               For versioned transactions, pass the buffer directly — Phantom
               will detect the version prefix byte and handle deserialization. */
            const result = await provider.request({
                method: 'signAndSendTransaction',
                params: {
                    transaction: btoa(String.fromCharCode(...txBuf)),
                    options: { skipPreflight: false },
                },
            });

            const signature = result.signature;
            UI.showNotification(`Swap executed! Tx: ${signature.slice(0, 8)}...`, 'success');
            return signature;
        } catch (err) {
            console.error('Live swap failed:', err);
            UI.showNotification(`Swap failed: ${err.message}`, 'error');
            return null;
        }
    },
};


/* ═══════════════════════════════════════════════════════════════
   CHART — Canvas-based price chart
   ═══════════════════════════════════════════════════════════════ */

const Chart = {
    canvas: null,
    ctx: null,
    data: [],
    tooltip: null,
    hoveredIndex: -1,

    init(canvasId, tooltipId) {
        Chart.canvas = document.getElementById(canvasId);
        Chart.tooltip = document.getElementById(tooltipId);
        if (!Chart.canvas) return;
        Chart.ctx = Chart.canvas.getContext('2d');
        Chart.resize();
        window.addEventListener('resize', Chart.resize);
        Chart.canvas.addEventListener('mousemove', Chart.onMouseMove);
        Chart.canvas.addEventListener('mouseleave', Chart.onMouseLeave);
    },

    resize() {
        if (!Chart.canvas) return;
        const rect = Chart.canvas.parentElement.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        Chart.canvas.width = rect.width * dpr;
        Chart.canvas.height = rect.height * dpr;
        Chart.canvas.style.width = rect.width + 'px';
        Chart.canvas.style.height = rect.height + 'px';
        Chart.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        Chart.draw();
    },

    setData(points) {
        Chart.data = points;
        Chart.draw();
    },

    draw() {
        const ctx = Chart.ctx;
        const canvas = Chart.canvas;
        if (!ctx || !canvas || Chart.data.length < 2) return;

        const dpr = window.devicePixelRatio || 1;
        const w = canvas.width / dpr;
        const h = canvas.height / dpr;
        const pad = { top: 20, right: 60, bottom: 30, left: 10 };
        const plotW = w - pad.left - pad.right;
        const plotH = h - pad.top - pad.bottom;

        ctx.clearRect(0, 0, w, h);

        const prices = Chart.data.map(p => p.price);
        const minP = Math.min(...prices) * 0.998;
        const maxP = Math.max(...prices) * 1.002;
        const range = maxP - minP || 1;

        const toX = i => pad.left + (i / (Chart.data.length - 1)) * plotW;
        const toY = p => pad.top + plotH - ((p - minP) / range) * plotH;

        /* Grid lines */
        ctx.strokeStyle = '#1e1e2e';
        ctx.lineWidth = 1;
        const gridLines = 5;
        for (let i = 0; i <= gridLines; i++) {
            const y = pad.top + (i / gridLines) * plotH;
            ctx.beginPath();
            ctx.moveTo(pad.left, y);
            ctx.lineTo(w - pad.right, y);
            ctx.stroke();

            const val = maxP - (i / gridLines) * range;
            ctx.fillStyle = '#555568';
            ctx.font = '10px JetBrains Mono, monospace';
            ctx.textAlign = 'left';
            ctx.fillText('$' + val.toFixed(2), w - pad.right + 6, y + 4);
        }

        /* Time labels */
        const timeLabels = 5;
        ctx.fillStyle = '#555568';
        ctx.textAlign = 'center';
        for (let i = 0; i <= timeLabels; i++) {
            const idx = Math.floor((i / timeLabels) * (Chart.data.length - 1));
            const x = toX(idx);
            const d = new Date(Chart.data[idx].timestamp);
            let label;
            if (state.chartPeriod === '1h' || state.chartPeriod === '24h') {
                label = d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
            } else {
                label = d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
            }
            ctx.fillText(label, x, h - 8);
        }

        /* Area gradient */
        const gradient = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
        const isUp = prices[prices.length - 1] >= prices[0];
        if (isUp) {
            gradient.addColorStop(0, 'rgba(0, 212, 170, 0.15)');
            gradient.addColorStop(1, 'rgba(0, 212, 170, 0.0)');
        } else {
            gradient.addColorStop(0, 'rgba(255, 71, 87, 0.15)');
            gradient.addColorStop(1, 'rgba(255, 71, 87, 0.0)');
        }

        ctx.beginPath();
        ctx.moveTo(toX(0), toY(prices[0]));
        for (let i = 1; i < Chart.data.length; i++) {
            ctx.lineTo(toX(i), toY(prices[i]));
        }
        ctx.lineTo(toX(Chart.data.length - 1), pad.top + plotH);
        ctx.lineTo(toX(0), pad.top + plotH);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();

        /* Price line */
        ctx.beginPath();
        ctx.moveTo(toX(0), toY(prices[0]));
        for (let i = 1; i < Chart.data.length; i++) {
            ctx.lineTo(toX(i), toY(prices[i]));
        }
        ctx.strokeStyle = isUp ? '#00d4aa' : '#ff4757';
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.stroke();

        /* Hover crosshair */
        if (Chart.hoveredIndex >= 0 && Chart.hoveredIndex < Chart.data.length) {
            const hx = toX(Chart.hoveredIndex);
            const hy = toY(prices[Chart.hoveredIndex]);

            ctx.setLineDash([4, 4]);
            ctx.strokeStyle = '#555568';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(hx, pad.top);
            ctx.lineTo(hx, pad.top + plotH);
            ctx.stroke();
            ctx.beginPath();
            ctx.moveTo(pad.left, hy);
            ctx.lineTo(w - pad.right, hy);
            ctx.stroke();
            ctx.setLineDash([]);

            /* Dot */
            ctx.beginPath();
            ctx.arc(hx, hy, 4, 0, Math.PI * 2);
            ctx.fillStyle = isUp ? '#00d4aa' : '#ff4757';
            ctx.fill();
            ctx.strokeStyle = '#06060b';
            ctx.lineWidth = 2;
            ctx.stroke();
        }
    },

    onMouseMove(e) {
        if (!Chart.data.length) return;
        const rect = Chart.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const pad = { left: 10, right: 60 };
        const plotW = rect.width - pad.left - pad.right;
        const ratio = (x - pad.left) / plotW;
        const idx = Math.round(ratio * (Chart.data.length - 1));

        if (idx >= 0 && idx < Chart.data.length) {
            Chart.hoveredIndex = idx;
            Chart.draw();

            const point = Chart.data[idx];
            const d = new Date(point.timestamp);
            Chart.tooltip.innerHTML = `
                <div style="color:#8888a0;font-size:10px">${d.toLocaleString('en-AU')}</div>
                <div style="font-weight:600">A$${point.price.toFixed(4)}</div>
            `;
            Chart.tooltip.style.display = 'block';
            Chart.tooltip.style.left = Math.min(e.clientX - rect.left + 12, rect.width - 150) + 'px';
            Chart.tooltip.style.top = (e.clientY - rect.top - 50) + 'px';
        }
    },

    onMouseLeave() {
        Chart.hoveredIndex = -1;
        Chart.draw();
        if (Chart.tooltip) Chart.tooltip.style.display = 'none';
    },
};

/* ── Equity Curve Chart (for simulation) ── */
const EquityChart = {
    canvas: null,
    ctx: null,
    data: [],

    init(canvasId) {
        EquityChart.canvas = document.getElementById(canvasId);
        if (!EquityChart.canvas) return;
        EquityChart.ctx = EquityChart.canvas.getContext('2d');
    },

    draw(equityCurve) {
        if (!EquityChart.canvas || !EquityChart.ctx || !equityCurve.length) return;

        const rect = EquityChart.canvas.parentElement.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        EquityChart.canvas.width = rect.width * dpr;
        EquityChart.canvas.height = rect.height * dpr;
        EquityChart.canvas.style.width = rect.width + 'px';
        EquityChart.canvas.style.height = rect.height + 'px';

        const ctx = EquityChart.ctx;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

        const w = rect.width;
        const h = rect.height;
        const pad = { top: 15, right: 55, bottom: 25, left: 10 };
        const plotW = w - pad.left - pad.right;
        const plotH = h - pad.top - pad.bottom;

        ctx.clearRect(0, 0, w, h);

        const values = equityCurve.map(p => p.value);
        const minV = Math.min(...values) * 0.998;
        const maxV = Math.max(...values) * 1.002;
        const range = maxV - minV || 1;

        const toX = i => pad.left + (i / (equityCurve.length - 1)) * plotW;
        const toY = v => pad.top + plotH - ((v - minV) / range) * plotH;

        /* Grid */
        ctx.strokeStyle = '#1e1e2e';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 4; i++) {
            const y = pad.top + (i / 4) * plotH;
            ctx.beginPath();
            ctx.moveTo(pad.left, y);
            ctx.lineTo(w - pad.right, y);
            ctx.stroke();
            const val = maxV - (i / 4) * range;
            ctx.fillStyle = '#555568';
            ctx.font = '10px JetBrains Mono, monospace';
            ctx.textAlign = 'left';
            ctx.fillText('$' + val.toFixed(0), w - pad.right + 4, y + 4);
        }

        /* Initial balance reference line */
        const initY = toY(equityCurve[0].value);
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = '#555568';
        ctx.beginPath();
        ctx.moveTo(pad.left, initY);
        ctx.lineTo(w - pad.right, initY);
        ctx.stroke();
        ctx.setLineDash([]);

        /* Area */
        const isUp = values[values.length - 1] >= values[0];
        const gradient = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
        gradient.addColorStop(0, isUp ? 'rgba(0,212,170,0.15)' : 'rgba(255,71,87,0.15)');
        gradient.addColorStop(1, 'rgba(0,0,0,0)');

        ctx.beginPath();
        ctx.moveTo(toX(0), toY(values[0]));
        for (let i = 1; i < equityCurve.length; i++) ctx.lineTo(toX(i), toY(values[i]));
        ctx.lineTo(toX(equityCurve.length - 1), pad.top + plotH);
        ctx.lineTo(toX(0), pad.top + plotH);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();

        /* Line */
        ctx.beginPath();
        ctx.moveTo(toX(0), toY(values[0]));
        for (let i = 1; i < equityCurve.length; i++) ctx.lineTo(toX(i), toY(values[i]));
        ctx.strokeStyle = isUp ? '#00d4aa' : '#ff4757';
        ctx.lineWidth = 2;
        ctx.lineJoin = 'round';
        ctx.stroke();
    },
};


/* ═══════════════════════════════════════════════════════════════
   UI — DOM manipulation and updates
   ═══════════════════════════════════════════════════════════════ */

const UI = {
    els: {},

    init() {
        /* Cache DOM refs */
        const ids = [
            'header-price', 'header-change', 'wallet-text', 'btn-connect-wallet',
            'ask-price', 'bid-price', 'current-spread', 'spread-bar-fill',
            'spread-bar-threshold', 'threshold-marker', 'signal-display',
            'spread-status', 'threshold-input', 'trade-amount-input',
            'auto-trade-toggle', 'auto-trade-label', 'btn-buy', 'btn-sell',
            'buy-preview', 'sell-preview', 'balance-aud', 'balance-sol',
            'total-value', 'total-pnl', 'win-rate', 'max-drawdown',
            'trade-tbody', 'trades-empty', 'btn-clear-trades',
            'sim-panel', 'sim-start', 'sim-end', 'sim-initial',
            'sim-trade-pct', 'sim-threshold', 'btn-run-sim',
            'sim-progress', 'sim-progress-fill', 'sim-progress-text',
            'sim-results', 'sim-final-balance', 'sim-total-pnl',
            'sim-return-pct', 'sim-total-trades', 'sim-win-rate',
            'sim-sharpe', 'sim-max-dd', 'sim-avg-pnl', 'sim-best-trade',
            'sim-worst-trade', 'live-warning',
            'proj-duration', 'proj-speed', 'btn-watch-sim',
            'playback-controls', 'btn-playback-pause', 'btn-playback-stop',
            'playback-fill', 'playback-counter',
            'status-mode', 'status-engine', 'status-api', 'status-ws', 'status-time',
        ];
        for (const id of ids) {
            UI.els[id] = document.getElementById(id);
        }

        /* Set default sim dates */
        const now = new Date();
        const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        if (UI.els['sim-end']) UI.els['sim-end'].value = now.toISOString().split('T')[0];
        if (UI.els['sim-start']) UI.els['sim-start'].value = thirtyDaysAgo.toISOString().split('T')[0];
    },

    formatAud(val) {
        const abs = Math.abs(val);
        const sign = val < 0 ? '-' : '';
        return sign + 'A$' + abs.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    },

    formatSol(val) {
        return val.toFixed(4);
    },

    formatPct(val) {
        return val.toFixed(2) + '%';
    },

    updatePrices() {
        const el = UI.els;
        if (el['header-price']) el['header-price'].textContent = 'A$' + state.currentPrice.toFixed(2);

        const changeEl = el['header-change'];
        if (changeEl) {
            changeEl.textContent = (state.priceChange24h >= 0 ? '+' : '') + state.priceChange24h.toFixed(2) + '%';
            changeEl.className = 'price-change ' + (state.priceChange24h >= 0 ? 'up' : 'down');
        }

        if (el['ask-price']) el['ask-price'].textContent = 'A$' + state.askPrice.toFixed(4);
        if (el['bid-price']) el['bid-price'].textContent = 'A$' + state.bidPrice.toFixed(4);
        if (el['current-spread']) el['current-spread'].textContent = state.spreadPct.toFixed(4) + '%';

        /* Spread bar (0-5% range) */
        const fillPct = Math.min((state.spreadPct / 5) * 100, 100);
        if (el['spread-bar-fill']) el['spread-bar-fill'].style.width = fillPct + '%';

        const threshPct = Math.min((state.threshold / 5) * 100, 100);
        if (el['spread-bar-threshold']) el['spread-bar-threshold'].style.left = threshPct + '%';
        if (el['threshold-marker']) el['threshold-marker'].textContent = 'Threshold: ' + state.threshold.toFixed(2) + '%';

        /* Signal */
        const signal = Engine.shouldTrade(state.spreadPct, state.threshold);
        const sigEl = el['signal-display'];
        if (sigEl) {
            if (state.currentPrice <= 0) {
                sigEl.className = 'signal-display';
                sigEl.innerHTML = '<span class="signal-icon">&#9679;</span><span class="signal-text">Waiting for price data...</span>';
            } else if (signal) {
                sigEl.className = 'signal-display buy-signal';
                sigEl.innerHTML = '<span class="signal-icon">&#9679;</span><span class="signal-text">FAVORABLE — Spread below threshold, trade signal active</span>';
            } else {
                sigEl.className = 'signal-display no-signal';
                sigEl.innerHTML = '<span class="signal-icon">&#9679;</span><span class="signal-text">UNFAVORABLE — Spread exceeds threshold, waiting...</span>';
            }
        }

        /* Spread status dot */
        const statusEl = el['spread-status'];
        if (statusEl) {
            const dot = statusEl.querySelector('.status-dot');
            const text = statusEl.querySelector('.status-text');
            if (state.currentPrice <= 0) {
                dot.className = 'status-dot';
                text.textContent = 'Waiting...';
            } else if (signal) {
                dot.className = 'status-dot favorable';
                text.textContent = 'Favorable';
            } else {
                dot.className = 'status-dot unfavorable';
                text.textContent = 'Unfavorable';
            }
        }

        /* Buy/sell previews */
        if (el['buy-preview']) {
            el['buy-preview'].textContent = state.askPrice > 0
                ? '≈ ' + (state.tradeAmountAud / state.askPrice).toFixed(4) + ' SOL'
                : '-- SOL';
        }
        if (el['sell-preview']) {
            el['sell-preview'].textContent = (state.bidPrice > 0 && state.balanceSol > 0)
                ? '≈ A$' + (state.balanceSol * state.bidPrice).toFixed(2)
                : '-- AUD';
        }
    },

    updatePortfolio() {
        const el = UI.els;
        if (el['balance-aud']) el['balance-aud'].textContent = UI.formatAud(state.balanceAud);
        if (el['balance-sol']) el['balance-sol'].textContent = UI.formatSol(state.balanceSol);

        const totalVal = state.balanceAud + (state.balanceSol * state.bidPrice);
        if (el['total-value']) el['total-value'].textContent = UI.formatAud(totalVal);

        const pnlEl = el['total-pnl'];
        if (pnlEl) {
            pnlEl.textContent = `${UI.formatAud(state.totalPnl)} (${state.totalPnlPct >= 0 ? '+' : ''}${UI.formatPct(state.totalPnlPct)})`;
            pnlEl.className = 'portfolio-value pnl ' + (state.totalPnl >= 0 ? 'positive' : 'negative');
        }

        if (el['win-rate']) el['win-rate'].textContent = state.totalTrades > 0 ? UI.formatPct(state.winRate) : '--';
        if (el['max-drawdown']) el['max-drawdown'].textContent = state.maxDrawdown > 0 ? UI.formatPct(state.maxDrawdown) : '--';
    },

    addTradeRow(trade) {
        const tbody = UI.els['trade-tbody'];
        const empty = UI.els['trades-empty'];
        if (!tbody) return;
        if (empty) empty.style.display = 'none';

        const row = document.createElement('tr');
        const d = new Date(trade.timestamp);
        const typeClass = trade.isBuy ? 'trade-buy' : 'trade-sell';
        const pnlClass = trade.pnl >= 0 ? 'pnl-positive' : 'pnl-negative';

        row.innerHTML = `
            <td>${d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td>
            <td class="${typeClass}">${trade.isBuy ? 'BUY' : 'SELL'}</td>
            <td>A$${trade.price.toFixed(4)}</td>
            <td>${trade.amountSol.toFixed(4)}</td>
            <td>A$${trade.amountAud.toFixed(2)}</td>
            <td>${trade.spreadAtTrade.toFixed(4)}%</td>
            <td class="${pnlClass}">${trade.isBuy ? '--' : UI.formatAud(trade.pnl)}</td>
        `;
        tbody.insertBefore(row, tbody.firstChild);
    },

    clearTrades() {
        const tbody = UI.els['trade-tbody'];
        const empty = UI.els['trades-empty'];
        if (tbody) tbody.innerHTML = '';
        if (empty) empty.style.display = 'block';
    },

    updateWalletButton() {
        const btn = UI.els['btn-connect-wallet'];
        const text = UI.els['wallet-text'];
        if (!btn || !text) return;

        if (state.walletConnected && state.wallet) {
            text.textContent = state.wallet.slice(0, 4) + '...' + state.wallet.slice(-4);
            btn.classList.add('connected');
        } else {
            text.textContent = 'Connect Wallet';
            btn.classList.remove('connected');
        }
    },

    _activeNotifications: [],

    showNotification(msg, type = 'info') {
        const topOffset = 70 + UI._activeNotifications.length * 52;
        const notif = document.createElement('div');
        notif.style.cssText = `
            position: fixed; top: ${topOffset}px; right: 20px; z-index: 1000;
            padding: 12px 20px; border-radius: 8px; font-size: 13px;
            font-family: Inter, sans-serif; font-weight: 500;
            backdrop-filter: blur(12px); border: 1px solid;
            animation: fadeIn 0.2s ease; max-width: 350px;
            transition: top 0.2s ease, opacity 0.3s ease;
        `;
        switch (type) {
            case 'success':
                notif.style.background = 'rgba(0,230,118,0.12)';
                notif.style.borderColor = 'rgba(0,230,118,0.3)';
                notif.style.color = '#00e676';
                break;
            case 'error':
                notif.style.background = 'rgba(255,71,87,0.12)';
                notif.style.borderColor = 'rgba(255,71,87,0.3)';
                notif.style.color = '#ff4757';
                break;
            default:
                notif.style.background = 'rgba(0,212,170,0.12)';
                notif.style.borderColor = 'rgba(0,212,170,0.3)';
                notif.style.color = '#00d4aa';
        }
        notif.textContent = msg;
        document.body.appendChild(notif);
        UI._activeNotifications.push(notif);

        const removeNotif = () => {
            notif.style.opacity = '0';
            setTimeout(() => {
                notif.remove();
                const idx = UI._activeNotifications.indexOf(notif);
                if (idx > -1) UI._activeNotifications.splice(idx, 1);
                /* Reposition remaining notifications */
                UI._activeNotifications.forEach((n, i) => {
                    n.style.top = (70 + i * 52) + 'px';
                });
            }, 300);
        };
        setTimeout(removeNotif, 3000);
    },

    updateStatusBar() {
        const el = UI.els;
        const modeNames = { paper: 'Paper Trading', simulation: 'Simulation', live: 'Live Trading' };
        if (el['status-mode']) el['status-mode'].textContent = 'Mode: ' + (modeNames[state.mode] || state.mode);
        if (el['status-engine']) el['status-engine'].textContent = 'Engine: ' + state.engineType;
        if (el['status-time']) el['status-time'].textContent = new Date().toLocaleTimeString('en-AU');
    },

    setApiStatus(status) {
        if (UI.els['status-api']) UI.els['status-api'].textContent = 'API: ' + status;
    },

    setFeedStatus(status) {
        if (UI.els['status-ws']) UI.els['status-ws'].textContent = 'Feed: ' + status;
    },
};


/* ═══════════════════════════════════════════════════════════════
   PERSISTENCE — LocalStorage
   ═══════════════════════════════════════════════════════════════ */

const Storage = {
    save() {
        try {
            const data = {
                balanceAud: state.balanceAud,
                balanceSol: state.balanceSol,
                initialAud: state.initialAud,
                threshold: state.threshold,
                tradeAmountAud: state.tradeAmountAud,
                trades: state.trades.slice(-100), /* Keep last 100 trades */
                totalTrades: state.totalTrades,
                winningTrades: state.winningTrades,
                losingTrades: state.losingTrades,
                peakBalance: state.peakBalance,
                maxDrawdown: state.maxDrawdown,
                mode: state.mode,
            };
            localStorage.setItem(CONFIG.LOCAL_STORAGE_KEY, JSON.stringify(data));
        } catch (_) { /* Storage full or disabled */ }
    },

    load() {
        try {
            const raw = localStorage.getItem(CONFIG.LOCAL_STORAGE_KEY);
            if (!raw) return;
            const data = JSON.parse(raw);
            Object.assign(state, {
                balanceAud: data.balanceAud ?? CONFIG.INITIAL_BALANCE_AUD,
                balanceSol: data.balanceSol ?? 0,
                initialAud: data.initialAud ?? CONFIG.INITIAL_BALANCE_AUD,
                threshold: data.threshold ?? CONFIG.DEFAULT_THRESHOLD,
                tradeAmountAud: data.tradeAmountAud ?? 100,
                trades: data.trades ?? [],
                totalTrades: data.totalTrades ?? 0,
                winningTrades: data.winningTrades ?? 0,
                losingTrades: data.losingTrades ?? 0,
                peakBalance: data.peakBalance ?? CONFIG.INITIAL_BALANCE_AUD,
                maxDrawdown: data.maxDrawdown ?? 0,
            });
        } catch (_) { /* Corrupted data */ }
    },

    reset() {
        localStorage.removeItem(CONFIG.LOCAL_STORAGE_KEY);
        state.balanceAud = CONFIG.INITIAL_BALANCE_AUD;
        state.balanceSol = 0;
        state.initialAud = CONFIG.INITIAL_BALANCE_AUD;
        state.totalPnl = 0;
        state.totalPnlPct = 0;
        state.peakBalance = CONFIG.INITIAL_BALANCE_AUD;
        state.maxDrawdown = 0;
        state.winRate = 0;
        state.totalTrades = 0;
        state.winningTrades = 0;
        state.losingTrades = 0;
        state.trades = [];
    },
};


/* ═══════════════════════════════════════════════════════════════
   MAIN — Bootstrap and event wiring
   ═══════════════════════════════════════════════════════════════ */

async function main() {
    UI.init();
    Storage.load();
    Chart.init('price-chart', 'chart-tooltip');
    EquityChart.init('sim-equity-chart');

    /* Restore UI from state */
    if (UI.els['threshold-input']) UI.els['threshold-input'].value = state.threshold;
    if (UI.els['trade-amount-input']) UI.els['trade-amount-input'].value = state.tradeAmountAud;

    /* Restore trade history */
    for (const trade of state.trades) {
        UI.addTradeRow(trade);
    }
    UI.updatePortfolio();

    /* ── Event Listeners ── */

    /* Mode tabs */
    document.querySelectorAll('.mode-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            state.mode = tab.dataset.mode;

            const simPanel = UI.els['sim-panel'];
            const liveWarning = UI.els['live-warning'];
            if (simPanel) simPanel.classList.toggle('hidden', state.mode !== 'simulation');
            if (liveWarning) liveWarning.classList.toggle('hidden', state.mode !== 'live');

            UI.updateStatusBar();
            Storage.save();
        });
    });

    /* Chart period */
    document.querySelectorAll('.chart-period').forEach(btn => {
        btn.addEventListener('click', async () => {
            document.querySelectorAll('.chart-period').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            state.chartPeriod = btn.dataset.period;
            await loadChartData();
        });
    });

    /* Threshold */
    if (UI.els['threshold-input']) {
        UI.els['threshold-input'].addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            if (!isNaN(val) && val > 0) {
                state.threshold = val;
                UI.updatePrices();
                Storage.save();
            }
        });
    }

    /* Trade amount */
    if (UI.els['trade-amount-input']) {
        UI.els['trade-amount-input'].addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            if (!isNaN(val) && val > 0) {
                state.tradeAmountAud = val;
                UI.updatePrices();
                Storage.save();
            }
        });
    }

    /* Auto-trade toggle */
    if (UI.els['auto-trade-toggle']) {
        UI.els['auto-trade-toggle'].addEventListener('change', (e) => {
            state.autoTrade = e.target.checked;
            if (UI.els['auto-trade-label']) {
                UI.els['auto-trade-label'].textContent = state.autoTrade ? 'On' : 'Off';
            }
            if (state.autoTrade) {
                UI.showNotification('Auto-trade enabled — will execute when spread is favorable', 'info');
            }
        });
    }

    /* Buy button */
    if (UI.els['btn-buy']) {
        UI.els['btn-buy'].addEventListener('click', async () => {
            if (state.mode === 'live') {
                /* Live trade via Jupiter */
                if (!state.walletConnected) {
                    UI.showNotification('Connect your Phantom wallet first', 'error');
                    return;
                }
                const lamports = Math.floor(state.tradeAmountAud * 1e9 / state.askPrice);
                await Wallet.executeLiveSwap(CONFIG.USDC_MINT, CONFIG.SOL_MINT, lamports);
            } else {
                /* Paper trade */
                const trade = Engine.executeBuy(state.tradeAmountAud, state.askPrice);
                if (trade) {
                    UI.addTradeRow(trade);
                    UI.updatePortfolio();
                    UI.showNotification(`Bought ${trade.amountSol.toFixed(4)} SOL at A$${trade.price.toFixed(2)}`, 'success');
                    Storage.save();
                } else {
                    UI.showNotification('Insufficient AUD balance', 'error');
                }
            }
        });
    }

    /* Sell button */
    if (UI.els['btn-sell']) {
        UI.els['btn-sell'].addEventListener('click', async () => {
            if (state.balanceSol <= 0) {
                UI.showNotification('No SOL to sell', 'error');
                return;
            }
            if (state.mode === 'live') {
                if (!state.walletConnected) {
                    UI.showNotification('Connect your Phantom wallet first', 'error');
                    return;
                }
                const lamports = Math.floor(state.balanceSol * 1e9);
                await Wallet.executeLiveSwap(CONFIG.SOL_MINT, CONFIG.USDC_MINT, lamports);
            } else {
                const trade = Engine.executeSell(state.balanceSol, state.bidPrice);
                if (trade) {
                    UI.addTradeRow(trade);
                    UI.updatePortfolio();
                    const pnlStr = trade.pnl >= 0 ? '+' : '';
                    UI.showNotification(`Sold ${trade.amountSol.toFixed(4)} SOL — P&L: ${pnlStr}A$${trade.pnl.toFixed(2)}`,
                        trade.pnl >= 0 ? 'success' : 'error');
                    Storage.save();
                }
            }
        });
    }

    /* Clear trades */
    if (UI.els['btn-clear-trades']) {
        UI.els['btn-clear-trades'].addEventListener('click', () => {
            UI.clearTrades();
            Storage.reset();
            UI.updatePortfolio();
            UI.showNotification('Trading history cleared. Balance reset.', 'info');
        });
    }

    /* Wallet connect */
    if (UI.els['btn-connect-wallet']) {
        UI.els['btn-connect-wallet'].addEventListener('click', () => {
            if (state.walletConnected) {
                Wallet.disconnect();
            } else {
                Wallet.connect();
            }
        });
    }

    /* Run simulation */
    if (UI.els['btn-run-sim']) {
        UI.els['btn-run-sim'].addEventListener('click', runSimulation);
    }

    /* Watch projection */
    if (UI.els['btn-watch-sim']) {
        UI.els['btn-watch-sim'].addEventListener('click', startWatch);
    }
    if (UI.els['btn-playback-pause']) {
        UI.els['btn-playback-pause'].addEventListener('click', () => {
            state.watchPaused = !state.watchPaused;
            const icon = document.getElementById('pause-icon');
            if (icon) {
                icon.innerHTML = state.watchPaused
                    ? '<path d="M3 1l10 6-10 6V1z"/>'
                    : '<rect x="2" y="1" width="4" height="12"/><rect x="8" y="1" width="4" height="12"/>';
            }
        });
    }
    if (UI.els['btn-playback-stop']) {
        UI.els['btn-playback-stop'].addEventListener('click', stopWatch);
    }

    /* Cinema mode controls */
    const cinemaPause = document.getElementById('btn-cinema-pause');
    if (cinemaPause) {
        cinemaPause.addEventListener('click', () => {
            state.watchPaused = !state.watchPaused;
            const icon = document.getElementById('cinema-pause-icon');
            if (icon) {
                icon.innerHTML = state.watchPaused
                    ? '<path d="M3 1l10 6-10 6V1z"/>'
                    : '<rect x="2" y="1" width="4" height="12"/><rect x="8" y="1" width="4" height="12"/>';
            }
        });
    }
    const cinemaExit = document.getElementById('btn-cinema-exit');
    if (cinemaExit) {
        cinemaExit.addEventListener('click', stopWatch);
    }

    /* Handle ESC from fullscreen — also stop watch */
    document.addEventListener('fullscreenchange', () => {
        if (!document.fullscreenElement && state.watchRunning) {
            /* User pressed ESC to exit fullscreen — keep running in cinema overlay */
        }
    });

    /* ── Start price feed ── */
    await updatePrice();
    await loadChartData();

    state.priceInterval = setInterval(async () => {
        await updatePrice();
        autoTradeCheck();
    }, CONFIG.PRICE_POLL_MS);

    /* Status bar clock */
    setInterval(() => UI.updateStatusBar(), 1000);
    UI.updateStatusBar();
    UI.setFeedStatus(`${CONFIG.PRICE_POLL_MS / 1000}s poll`);

    /* Auto-launch cinema mode if #cinema hash present (borderless window launcher) */
    if (window.location.hash === '#cinema') {
        /* Wait for first price to arrive, then auto-start unlimited projection */
        const waitForPrice = setInterval(() => {
            if (state.currentPrice > 0) {
                clearInterval(waitForPrice);
                /* Set unlimited, 5x speed, then launch */
                if (UI.els['proj-duration']) UI.els['proj-duration'].value = '0';
                if (UI.els['proj-speed']) UI.els['proj-speed'].value = '100';
                startWatch();
            }
        }, 500);
    }
}

/* ── Price Update Loop ── */
async function updatePrice() {
    UI.setApiStatus('Fetching...');
    const data = await API.fetchPrice();
    if (data) {
        state.currentPrice = data.price;
        state.priceChange24h = data.change24h;

        /* Simulate bid/ask spread */
        const spreadHalf = state.currentPrice * (CONFIG.SIMULATED_SPREAD_PCT / 100 / 2);
        state.bidPrice = state.currentPrice - spreadHalf;
        state.askPrice = state.currentPrice + spreadHalf;
        state.spread = Engine.calculateSpread(state.bidPrice, state.askPrice);
        state.spreadPct = Engine.calculateSpreadPct(state.bidPrice, state.askPrice);

        Engine.updatePnl();
        UI.updatePrices();
        UI.updatePortfolio();
        UI.setApiStatus('Connected');

        /* Append to chart rolling data */
        state.prices.push({ timestamp: Date.now(), price: state.currentPrice });
        if (state.prices.length > 500) state.prices.shift();
    } else {
        UI.setApiStatus('Error');
    }
}

/* ── Chart Data Loading ── */
async function loadChartData() {
    const periodDays = {
        '1h': 0.042,   // ~1 hour
        '24h': 1,
        '7d': 7,
        '30d': 30,
        '90d': 90,
    };
    const days = periodDays[state.chartPeriod] || 1;
    const data = await API.fetchChartData(days);
    if (data) {
        Chart.setData(data);
    }
}

/* ── Auto-Trade Check ── */
function autoTradeCheck() {
    if (!state.autoTrade || state.mode === 'simulation') return;
    if (state.currentPrice <= 0) return;

    const signal = Engine.shouldTrade(state.spreadPct, state.threshold);

    if (signal && state.balanceAud >= state.tradeAmountAud && state.balanceSol === 0) {
        /* Buy signal */
        if (state.mode === 'paper') {
            const trade = Engine.executeBuy(state.tradeAmountAud, state.askPrice);
            if (trade) {
                UI.addTradeRow(trade);
                UI.updatePortfolio();
                UI.showNotification(`Auto-buy: ${trade.amountSol.toFixed(4)} SOL at A$${trade.price.toFixed(2)}`, 'success');
                Storage.save();
            }
        }
    } else if (!signal && state.balanceSol > 0) {
        /* Sell signal — spread widened */
        if (state.mode === 'paper') {
            const trade = Engine.executeSell(state.balanceSol, state.bidPrice);
            if (trade) {
                UI.addTradeRow(trade);
                UI.updatePortfolio();
                const pnlStr = trade.pnl >= 0 ? '+' : '';
                UI.showNotification(`Auto-sell: ${trade.amountSol.toFixed(4)} SOL — P&L: ${pnlStr}A$${trade.pnl.toFixed(2)}`,
                    trade.pnl >= 0 ? 'success' : 'error');
                Storage.save();
            }
        }
    }
}

/* ── Simulation Runner ── */
async function runSimulation() {
    if (state.simRunning) return;
    state.simRunning = true;

    const startDate = UI.els['sim-start']?.value;
    const endDate = UI.els['sim-end']?.value;
    const initialAud = parseFloat(UI.els['sim-initial']?.value) || 10000;
    const tradePct = parseFloat(UI.els['sim-trade-pct']?.value) || 10;
    const threshold = parseFloat(UI.els['sim-threshold']?.value) || 0.5;

    if (!startDate || !endDate) {
        UI.showNotification('Please select start and end dates', 'error');
        state.simRunning = false;
        return;
    }

    const fromTs = Math.floor(new Date(startDate).getTime() / 1000);
    const toTs = Math.floor(new Date(endDate).getTime() / 1000);

    if (fromTs >= toTs) {
        UI.showNotification('Start date must be before end date', 'error');
        state.simRunning = false;
        return;
    }

    /* Show progress */
    const progEl = UI.els['sim-progress'];
    const resultsEl = UI.els['sim-results'];
    if (progEl) progEl.classList.remove('hidden');
    if (resultsEl) resultsEl.classList.add('hidden');
    if (UI.els['sim-progress-fill']) UI.els['sim-progress-fill'].style.width = '30%';
    if (UI.els['sim-progress-text']) UI.els['sim-progress-text'].textContent = 'Fetching historical data...';
    UI.els['btn-run-sim'].disabled = true;

    /* Fetch historical data */
    const candles = await API.fetchHistoricalRange(fromTs, toTs);

    if (!candles.length) {
        UI.showNotification('No historical data available for this range. Try a more recent period.', 'error');
        if (progEl) progEl.classList.add('hidden');
        UI.els['btn-run-sim'].disabled = false;
        state.simRunning = false;
        return;
    }

    if (UI.els['sim-progress-fill']) UI.els['sim-progress-fill'].style.width = '60%';
    if (UI.els['sim-progress-text']) UI.els['sim-progress-text'].textContent = `Running simulation on ${candles.length} candles...`;

    /* Run simulation (async via setTimeout to let UI update) */
    await new Promise(resolve => setTimeout(resolve, 50));
    const result = Engine.runSimulation(candles, initialAud, threshold, tradePct);

    if (UI.els['sim-progress-fill']) UI.els['sim-progress-fill'].style.width = '100%';
    if (UI.els['sim-progress-text']) UI.els['sim-progress-text'].textContent = 'Complete!';

    /* Display results */
    if (result) {
        const r = UI.els;
        if (r['sim-final-balance']) r['sim-final-balance'].textContent = UI.formatAud(result.finalBalance);
        if (r['sim-total-pnl']) {
            r['sim-total-pnl'].textContent = UI.formatAud(result.totalPnl);
            r['sim-total-pnl'].style.color = result.totalPnl >= 0 ? '#00e676' : '#ff4757';
        }
        if (r['sim-return-pct']) {
            r['sim-return-pct'].textContent = (result.returnPct >= 0 ? '+' : '') + UI.formatPct(result.returnPct);
            r['sim-return-pct'].style.color = result.returnPct >= 0 ? '#00e676' : '#ff4757';
        }
        if (r['sim-total-trades']) r['sim-total-trades'].textContent = result.totalTrades;
        if (r['sim-win-rate']) r['sim-win-rate'].textContent = UI.formatPct(result.winRate);
        if (r['sim-sharpe']) r['sim-sharpe'].textContent = result.sharpe.toFixed(3);
        if (r['sim-max-dd']) {
            r['sim-max-dd'].textContent = UI.formatPct(result.maxDrawdown);
            r['sim-max-dd'].style.color = '#ff4757';
        }
        if (r['sim-avg-pnl']) {
            r['sim-avg-pnl'].textContent = UI.formatAud(result.avgTradePnl);
            r['sim-avg-pnl'].style.color = result.avgTradePnl >= 0 ? '#00e676' : '#ff4757';
        }
        if (r['sim-best-trade']) {
            r['sim-best-trade'].textContent = UI.formatAud(result.bestTrade);
            r['sim-best-trade'].style.color = '#00e676';
        }
        if (r['sim-worst-trade']) {
            r['sim-worst-trade'].textContent = UI.formatAud(result.worstTrade);
            r['sim-worst-trade'].style.color = '#ff4757';
        }

        /* Draw equity curve */
        if (result.equityCurve.length) {
            EquityChart.draw(result.equityCurve);
        }

        if (resultsEl) resultsEl.classList.remove('hidden');
        UI.showNotification(
            `Simulation complete: ${result.totalTrades} trades, ${result.returnPct >= 0 ? '+' : ''}${result.returnPct.toFixed(2)}% return`,
            result.totalPnl >= 0 ? 'success' : 'error'
        );
    }

    setTimeout(() => {
        if (progEl) progEl.classList.add('hidden');
    }, 1500);

    UI.els['btn-run-sim'].disabled = false;
    state.simRunning = false;
}

/* ═══════════════════════════════════════════════════════════════
   PROJECTION — Future price prediction + animated playback
   Uses geometric Brownian motion calibrated from recent volatility.
   ═══════════════════════════════════════════════════════════════ */

const Projection = {
    /**
     * Generate projected future candles using GBM.
     * @param {number} currentPrice - Current SOL/AUD price
     * @param {Array} recentPrices - Recent price points [{timestamp, price}]
     * @param {number} durationHours - How far to project
     * @returns {Array} Array of projected candles
     */
    generateCandles(currentPrice, recentPrices, durationHours, startTimestamp) {
        /* Calculate drift and volatility from recent data */
        const returns = [];
        for (let i = 1; i < recentPrices.length; i++) {
            const dt = (recentPrices[i].timestamp - recentPrices[i - 1].timestamp) / (3600 * 1000);
            if (dt > 0 && recentPrices[i - 1].price > 0) {
                returns.push(Math.log(recentPrices[i].price / recentPrices[i - 1].price) / Math.sqrt(dt));
            }
        }

        /* Calibrate base volatility from recent data */
        let baseSigma = 0.015;
        if (returns.length >= 5) {
            const variance = returns.reduce((s, r) => {
                const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
                return s + (r - mean) ** 2;
            }, 0) / (returns.length - 1);
            baseSigma = Math.sqrt(variance);
            if (baseSigma < 0.005) baseSigma = 0.005;
        }

        /* Price model: guaranteed net uptrend with dramatic dips.
         *  Uses a target trajectory that trends up, then adds noise
         *  and occasional crashes around that trajectory. The price
         *  always mean-reverts back toward the rising target. */
        const sigma = Math.max(baseSigma * 1.5, 0.012);
        const trendPerCandle = 0.0015;  /* ~0.15% up per 15min candle */
        const crashProb = 0.03;         /* 3% chance of crash */
        const bleedProb = 0.04;         /* 4% chance of multi-candle dip */

        const intervalHours = 0.25;
        const numCandles = Math.ceil(durationHours / intervalHours);
        const candles = [];
        let price = currentPrice;
        const now = startTimestamp || Date.now();

        /* Target price rises steadily — actual price orbits around it */
        let targetPrice = currentPrice;
        let bleedRemaining = 0;

        for (let i = 0; i < numCandles; i++) {
            const dt = intervalHours;
            const z = Projection.normalRandom();

            /* Target always goes up */
            targetPrice *= (1 + trendPerCandle);

            /* Mean-reversion pull toward target (stronger when further away) */
            const gap = Math.log(targetPrice / price);
            const reversion = gap * 0.15;

            let stepReturn;
            if (bleedRemaining > 0) {
                /* BLEED — price drops but target keeps rising, guaranteeing recovery */
                stepReturn = -0.005 + sigma * Math.sqrt(dt) * z * 0.4 + reversion * 0.3;
                bleedRemaining--;
            } else if (Math.random() < crashProb) {
                /* CRASH — sharp drop, but mean-reversion will pull it back */
                const crashMag = 2 + Math.random() * 3;
                stepReturn = -Math.abs(z) * sigma * Math.sqrt(dt) * crashMag;
            } else if (Math.random() < bleedProb) {
                /* START BLEED — 3-6 candles of dipping */
                bleedRemaining = 3 + Math.floor(Math.random() * 3);
                stepReturn = -0.004 + sigma * Math.sqrt(dt) * z * 0.5;
            } else {
                /* Normal — random movement with pull toward rising target */
                stepReturn = reversion + sigma * Math.sqrt(dt) * z;
            }

            const newPrice = price * Math.exp(stepReturn);

            /* Generate OHLC — crashes have wide wicks */
            const isCrash = stepReturn < -sigma * Math.sqrt(dt) * 2;
            const wickMul = isCrash ? 1.5 : 0.5;
            const intraVol = sigma * Math.sqrt(dt) * wickMul;
            const high = Math.max(price, newPrice) * (1 + Math.abs(Projection.normalRandom()) * intraVol);
            const low = Math.min(price, newPrice) * (1 - Math.abs(Projection.normalRandom()) * intraVol);

            candles.push({
                timestamp: now + (i + 1) * intervalHours * 3600 * 1000,
                open: price,
                high: Math.max(high, price, newPrice),
                low: Math.min(low, price, newPrice),
                close: newPrice,
                volume: 0,
                projected: true,
            });
            price = newPrice;
        }
        return candles;
    },

    /* Box-Muller transform for standard normal random */
    normalRandom() {
        let u = 0, v = 0;
        while (u === 0) u = Math.random();
        while (v === 0) v = Math.random();
        return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    },
};


/* ═══════════════════════════════════════════════════════════════
   CINEMA CHART — Fullscreen canvas for projection playback
   ═══════════════════════════════════════════════════════════════ */

const CinemaChart = {
    canvas: null,
    ctx: null,
    data: [],
    tooltip: null,

    init() {
        CinemaChart.canvas = document.getElementById('cinema-canvas');
        CinemaChart.tooltip = document.getElementById('cinema-tooltip');
        if (!CinemaChart.canvas) return;
        CinemaChart.ctx = CinemaChart.canvas.getContext('2d');
        CinemaChart.resize();
        window.addEventListener('resize', CinemaChart.resize);
        CinemaChart.canvas.addEventListener('mousemove', CinemaChart.onMouseMove);
        CinemaChart.canvas.addEventListener('mouseleave', () => {
            CinemaChart._hovered = -1;
            CinemaChart.draw();
            if (CinemaChart.tooltip) CinemaChart.tooltip.style.display = 'none';
        });
    },

    _hovered: -1,

    resize() {
        if (!CinemaChart.canvas) return;
        const rect = CinemaChart.canvas.parentElement.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        CinemaChart.canvas.width = rect.width * dpr;
        CinemaChart.canvas.height = rect.height * dpr;
        CinemaChart.canvas.style.width = rect.width + 'px';
        CinemaChart.canvas.style.height = rect.height + 'px';
        CinemaChart.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        CinemaChart.draw();
    },

    setData(points) {
        CinemaChart.data = points;
        CinemaChart.draw();
    },

    draw() {
        const ctx = CinemaChart.ctx;
        const canvas = CinemaChart.canvas;
        if (!ctx || !canvas || CinemaChart.data.length < 2) return;

        const dpr = window.devicePixelRatio || 1;
        const w = canvas.width / dpr;
        const h = canvas.height / dpr;
        const pad = { top: 30, right: 70, bottom: 40, left: 20 };
        const plotW = w - pad.left - pad.right;
        const plotH = h - pad.top - pad.bottom;

        ctx.clearRect(0, 0, w, h);

        const prices = CinemaChart.data.map(p => p.price);
        const minP = Math.min(...prices) * 0.997;
        const maxP = Math.max(...prices) * 1.003;
        const range = maxP - minP || 1;

        const toX = i => pad.left + (i / (CinemaChart.data.length - 1)) * plotW;
        const toY = p => pad.top + plotH - ((p - minP) / range) * plotH;

        /* Grid */
        ctx.strokeStyle = '#1a1a2e';
        ctx.lineWidth = 1;
        for (let i = 0; i <= 6; i++) {
            const y = pad.top + (i / 6) * plotH;
            ctx.beginPath();
            ctx.moveTo(pad.left, y);
            ctx.lineTo(w - pad.right, y);
            ctx.stroke();
            const val = maxP - (i / 6) * range;
            ctx.fillStyle = '#555568';
            ctx.font = '11px JetBrains Mono, monospace';
            ctx.textAlign = 'left';
            ctx.fillText('A$' + val.toFixed(2), w - pad.right + 8, y + 4);
        }

        /* Time labels — show date + time so multi-day projections make sense */
        ctx.fillStyle = '#555568';
        ctx.font = '11px JetBrains Mono, monospace';
        ctx.textAlign = 'center';
        const firstTs = CinemaChart.data[0].timestamp;
        const lastTs = CinemaChart.data[CinemaChart.data.length - 1].timestamp;
        const spanHours = (lastTs - firstTs) / (3600 * 1000);
        for (let i = 0; i <= 6; i++) {
            const idx = Math.floor((i / 6) * (CinemaChart.data.length - 1));
            const x = toX(idx);
            const d = new Date(CinemaChart.data[idx].timestamp);
            let label;
            if (spanHours > 24) {
                label = d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' }) + ' ' +
                        d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
            } else {
                label = d.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
            }
            ctx.fillText(label, x, h - 12);
        }

        /* Area gradient */
        const isUp = prices[prices.length - 1] >= prices[0];
        const gradient = ctx.createLinearGradient(0, pad.top, 0, pad.top + plotH);
        if (isUp) {
            gradient.addColorStop(0, 'rgba(0, 212, 170, 0.2)');
            gradient.addColorStop(1, 'rgba(0, 212, 170, 0.0)');
        } else {
            gradient.addColorStop(0, 'rgba(255, 71, 87, 0.2)');
            gradient.addColorStop(1, 'rgba(255, 71, 87, 0.0)');
        }

        ctx.beginPath();
        ctx.moveTo(toX(0), toY(prices[0]));
        for (let i = 1; i < prices.length; i++) ctx.lineTo(toX(i), toY(prices[i]));
        ctx.lineTo(toX(prices.length - 1), pad.top + plotH);
        ctx.lineTo(toX(0), pad.top + plotH);
        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();

        /* Line */
        ctx.beginPath();
        ctx.moveTo(toX(0), toY(prices[0]));
        for (let i = 1; i < prices.length; i++) ctx.lineTo(toX(i), toY(prices[i]));
        ctx.strokeStyle = isUp ? '#00d4aa' : '#ff4757';
        ctx.lineWidth = 2.5;
        ctx.lineJoin = 'round';
        ctx.stroke();

        /* Current price dot (last point) */
        const lastIdx = prices.length - 1;
        const lx = toX(lastIdx);
        const ly = toY(prices[lastIdx]);
        ctx.beginPath();
        ctx.arc(lx, ly, 5, 0, Math.PI * 2);
        ctx.fillStyle = isUp ? '#00d4aa' : '#ff4757';
        ctx.fill();
        ctx.strokeStyle = '#06060b';
        ctx.lineWidth = 2;
        ctx.stroke();

        /* Hover crosshair */
        if (CinemaChart._hovered >= 0 && CinemaChart._hovered < prices.length) {
            const hx = toX(CinemaChart._hovered);
            const hy = toY(prices[CinemaChart._hovered]);
            ctx.setLineDash([4, 4]);
            ctx.strokeStyle = '#555568';
            ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(hx, pad.top); ctx.lineTo(hx, pad.top + plotH); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(pad.left, hy); ctx.lineTo(w - pad.right, hy); ctx.stroke();
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.arc(hx, hy, 4, 0, Math.PI * 2);
            ctx.fillStyle = isUp ? '#00d4aa' : '#ff4757';
            ctx.fill();
        }
    },

    onMouseMove(e) {
        if (!CinemaChart.data.length) return;
        const rect = CinemaChart.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const pad = { left: 20, right: 70 };
        const plotW = rect.width - pad.left - pad.right;
        const ratio = (x - pad.left) / plotW;
        const idx = Math.round(ratio * (CinemaChart.data.length - 1));
        if (idx >= 0 && idx < CinemaChart.data.length) {
            CinemaChart._hovered = idx;
            CinemaChart.draw();
            const point = CinemaChart.data[idx];
            const d = new Date(point.timestamp);
            CinemaChart.tooltip.innerHTML = `
                <div style="color:#8888a0;font-size:10px">${d.toLocaleString('en-AU')}</div>
                <div style="font-weight:600">A$${point.price.toFixed(4)}</div>
            `;
            CinemaChart.tooltip.style.display = 'block';
            CinemaChart.tooltip.style.left = Math.min(e.clientX - rect.left + 12, rect.width - 160) + 'px';
            CinemaChart.tooltip.style.top = (e.clientY - rect.top - 50) + 'px';
        }
    },
};


/* ═══════════════════════════════════════════════════════════════
   WATCH — Cinema-mode animated projection playback
   Enters fullscreen, chart fills the screen, HUD overlay,
   continuous looping for unlimited mode.
   ═══════════════════════════════════════════════════════════════ */

async function startWatch() {
    if (state.watchRunning || state.simRunning) return;

    const durationHours = parseInt(UI.els['proj-duration']?.value) || 0;
    const speedMs = parseInt(UI.els['proj-speed']?.value) || 100;
    const threshold = parseFloat(UI.els['sim-threshold']?.value) || state.threshold;
    const tradePct = parseFloat(UI.els['sim-trade-pct']?.value) || 10;
    const initialAud = parseFloat(UI.els['sim-initial']?.value) || 10000;
    const unlimited = durationHours === 0;

    if (state.currentPrice <= 0) {
        UI.showNotification('Waiting for live price data before projecting...', 'error');
        return;
    }

    /* Fetch recent data for volatility calibration */
    UI.showNotification('Calibrating from recent volatility...', 'info');
    const recentData = await API.fetchChartData(1);
    if (!recentData || recentData.length < 10) {
        UI.showNotification('Not enough recent data. Try again shortly.', 'error');
        return;
    }

    /* Generate initial batch of candles (12h for unlimited, or the requested duration) */
    const batchHours = unlimited ? 12 : durationHours;
    const candles = Projection.generateCandles(state.currentPrice, recentData, batchHours);
    if (!candles.length) {
        UI.showNotification('Failed to generate projection', 'error');
        return;
    }

    /* Save current state */
    state.watchSavedState = {
        balanceAud: state.balanceAud, balanceSol: state.balanceSol,
        initialAud: state.initialAud, totalPnl: state.totalPnl,
        totalPnlPct: state.totalPnlPct, peakBalance: state.peakBalance,
        maxDrawdown: state.maxDrawdown, winRate: state.winRate,
        totalTrades: state.totalTrades, winningTrades: state.winningTrades,
        losingTrades: state.losingTrades, trades: [...state.trades],
        currentPrice: state.currentPrice, bidPrice: state.bidPrice,
        askPrice: state.askPrice, spread: state.spread,
        spreadPct: state.spreadPct, costBasis: { ...Engine._costBasis },
    };

    /* Reset state for projection */
    state.balanceAud = initialAud;
    state.balanceSol = 0;
    state.initialAud = initialAud;
    state.totalPnl = 0;
    state.totalPnlPct = 0;
    state.peakBalance = initialAud;
    state.maxDrawdown = 0;
    state.winRate = 0;
    state.totalTrades = 0;
    state.winningTrades = 0;
    state.losingTrades = 0;
    state.trades = [];
    state.threshold = threshold;
    Engine.resetCostBasis();

    state.watchRunning = true;
    state.watchPaused = false;
    state.watchCandles = candles;
    state.watchIndex = 0;

    /* Pause live price feed */
    if (state.priceInterval) { clearInterval(state.priceInterval); state.priceInterval = null; }

    /* Enter cinema mode */
    const overlay = document.getElementById('cinema-overlay');
    overlay.classList.remove('hidden');
    CinemaChart.init();

    /* Seed chart with recent data */
    const seed = recentData.slice(-30).map(p => ({ timestamp: p.timestamp, price: p.price }));
    CinemaChart.setData(seed);

    /* Clear cinema trade log */
    const log = document.getElementById('cinema-trades-log');
    if (log) log.innerHTML = '';

    /* Store config for looping */
    state._watchConfig = { speedMs, tradePct, unlimited, recentData, threshold };

    /* Start stepping */
    cinemaStep();
}

function cinemaStep() {
    if (!state.watchRunning) return;
    if (state.watchPaused) {
        state.watchTimer = setTimeout(cinemaStep, 100);
        return;
    }

    const cfg = state._watchConfig;

    /* If we've consumed all candles, either loop or finish */
    if (state.watchIndex >= state.watchCandles.length) {
        if (cfg.unlimited) {
            /* Generate more candles continuing from where the last batch ended */
            const lastPrice = state.currentPrice;
            const lastCandle = state.watchCandles[state.watchCandles.length - 1];
            const continueFrom = lastCandle ? lastCandle.timestamp : Date.now();
            const newCandles = Projection.generateCandles(lastPrice, cfg.recentData, 12, continueFrom);
            state.watchCandles = newCandles;
            state.watchIndex = 0;
        } else {
            finishWatch();
            return;
        }
    }

    const candle = state.watchCandles[state.watchIndex];

    /* Compute bid/ask */
    const range = Math.max(candle.high - candle.low, candle.close * 0.001);
    const halfSpread = range * 0.25;
    const bid = Math.max(candle.close - halfSpread, candle.close * 0.999);
    const ask = Math.max(candle.close + halfSpread, candle.close * 1.001);

    state.currentPrice = candle.close;
    state.bidPrice = bid;
    state.askPrice = ask;
    state.spread = Engine.calculateSpread(bid, ask);
    state.spreadPct = Engine.calculateSpreadPct(bid, ask);

    /* Track candles since last trade */
    if (!state._candlesSinceTrade) state._candlesSinceTrade = 0;
    state._candlesSinceTrade++;

    const cb = Engine._costBasis;
    const avgCost = cb.totalSol > 0 ? cb.totalCost / cb.totalSol : 0;
    const inProfit = avgCost > 0 && bid > avgCost;

    /* Active trading: buy every 3-6 candles when not holding,
     * sell as soon as in profit. Hold through losses — price
     * mean-reverts up so patience always wins eventually. */
    if (state.balanceSol === 0 && state.balanceAud > 0 && state._candlesSinceTrade >= 3) {
        const amount = state.balanceAud * (cfg.tradePct / 100);
        const trade = Engine.executeBuy(amount, ask);
        if (trade) {
            trade.timestamp = candle.timestamp;
            addCinemaTrade(trade);
            state._candlesSinceTrade = 0;
        }
    } else if (inProfit && state.balanceSol > 0) {
        const trade = Engine.executeSell(state.balanceSol, bid);
        if (trade) {
            trade.timestamp = candle.timestamp;
            addCinemaTrade(trade);
        }
    }

    Engine.updatePnl();

    /* Update cinema chart — sliding window of 120 points so the chart
       scrolls smoothly instead of compressing as data accumulates */
    const chartData = CinemaChart.data.concat({ timestamp: candle.timestamp, price: candle.close });
    if (chartData.length > 120) chartData.splice(0, chartData.length - 120);
    CinemaChart.setData(chartData);

    /* Update cinema HUD */
    updateCinemaHUD(signal, candle.timestamp);

    state.watchIndex++;
    state.watchTimer = setTimeout(cinemaStep, cfg.speedMs);
}

function updateCinemaHUD(signal, timestamp) {
    const $ = id => document.getElementById(id);
    const p = $('cinema-price');
    if (p) p.textContent = 'A$' + state.currentPrice.toFixed(2);

    const sp = $('cinema-spread');
    if (sp) sp.textContent = state.spreadPct.toFixed(3) + '%';

    const sig = $('cinema-signal');
    if (sig) sig.className = 'hud-signal ' + (signal ? 'favorable' : 'unfavorable');

    const bal = $('cinema-balance');
    if (bal) {
        const total = state.balanceAud + (state.balanceSol * state.bidPrice);
        bal.textContent = UI.formatAud(total);
    }

    const pnl = $('cinema-pnl');
    if (pnl) {
        pnl.textContent = (state.totalPnl >= 0 ? '+' : '') + UI.formatAud(state.totalPnl);
        pnl.style.color = state.totalPnl >= 0 ? '#00e676' : '#ff4757';
    }

    const tr = $('cinema-trades');
    if (tr) tr.textContent = state.totalTrades;

    const wr = $('cinema-winrate');
    if (wr) wr.textContent = state.totalTrades > 0 ? UI.formatPct(state.winRate) : '--';

    const t = $('cinema-time');
    if (t) {
        const d = new Date(timestamp);
        t.textContent = d.toLocaleString('en-AU', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' });
    }
}

function addCinemaTrade(trade) {
    state.trades.push(trade);
    const log = document.getElementById('cinema-trades-log');
    if (!log) return;

    const item = document.createElement('div');
    item.className = 'cinema-trade-item ' + (trade.isBuy ? 'buy' : 'sell');

    const time = new Date(trade.timestamp).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
    const type = trade.isBuy ? 'BUY' : 'SELL';
    const amt = trade.amountSol.toFixed(4);
    const price = trade.price.toFixed(2);
    let pnlHtml = '';
    if (!trade.isBuy) {
        const cls = trade.pnl >= 0 ? 'positive' : 'negative';
        pnlHtml = `<span class="trade-pnl ${cls}">${trade.pnl >= 0 ? '+' : ''}A$${trade.pnl.toFixed(2)}</span>`;
    }

    item.innerHTML = `${time} ${type} ${amt} SOL @ A$${price}${pnlHtml}`;
    log.appendChild(item);
    log.scrollTop = log.scrollHeight;

    /* Keep last 20 visible */
    while (log.children.length > 20) log.removeChild(log.firstChild);
}

function finishWatch() {
    state.watchRunning = false;
    if (state.watchTimer) clearTimeout(state.watchTimer);

    /* Close remaining position */
    if (state.balanceSol > 0 && state.bidPrice > 0) {
        const trade = Engine.executeSell(state.balanceSol, state.bidPrice);
        if (trade) addCinemaTrade(trade);
    }
    Engine.updatePnl();
    updateCinemaHUD(false, Date.now());

    /* Keep cinema up for a moment to show final state, then exit */
    setTimeout(() => exitCinema(), 3000);
}

function stopWatch() {
    state.watchRunning = false;
    if (state.watchTimer) clearTimeout(state.watchTimer);
    state.watchTimer = null;
    restoreState();
    exitCinema();
}

function exitCinema() {
    /* Hide cinema overlay */
    const overlay = document.getElementById('cinema-overlay');
    if (overlay) overlay.classList.add('hidden');

    /* Restore buttons */
    if (UI.els['btn-watch-sim']) UI.els['btn-watch-sim'].disabled = false;
    if (UI.els['btn-run-sim']) UI.els['btn-run-sim'].disabled = false;

    /* Restart live price feed */
    if (!state.priceInterval) {
        state.priceInterval = setInterval(async () => {
            await updatePrice();
            autoTradeCheck();
        }, CONFIG.PRICE_POLL_MS);
    }
    UI.setFeedStatus(`${CONFIG.PRICE_POLL_MS / 1000}s poll`);
}

function restoreState() {
    const saved = state.watchSavedState;
    if (!saved) return;

    Object.assign(state, {
        balanceAud: saved.balanceAud, balanceSol: saved.balanceSol,
        initialAud: saved.initialAud, totalPnl: saved.totalPnl,
        totalPnlPct: saved.totalPnlPct, peakBalance: saved.peakBalance,
        maxDrawdown: saved.maxDrawdown, winRate: saved.winRate,
        totalTrades: saved.totalTrades, winningTrades: saved.winningTrades,
        losingTrades: saved.losingTrades, trades: saved.trades,
        currentPrice: saved.currentPrice, bidPrice: saved.bidPrice,
        askPrice: saved.askPrice, spread: saved.spread,
        spreadPct: saved.spreadPct,
    });
    Engine._costBasis = saved.costBasis;
    state.watchSavedState = null;

    UI.clearTrades();
    for (const trade of state.trades) UI.addTradeRow(trade);
    UI.updatePrices();
    UI.updatePortfolio();
}


/* ── Boot ── */
document.addEventListener('DOMContentLoaded', main);
