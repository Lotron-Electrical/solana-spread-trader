# Solana Spread Trader — SOL/AUD

A browser-based Solana trading bot using a spread-based strategy, with Australian Dollar pricing.

## How It Works

The bot monitors the bid-ask spread on SOL/AUD. When your **threshold parameter is greater than the current spread**, conditions are favorable and a trade signal fires. This means the market is liquid enough (tight spread) for profitable entry.

**Strategy:** Buy SOL when the spread is tight (favorable), sell when it widens (unfavorable).

## Features

- **Paper Trading** — Practice with A$10,000 virtual balance, live prices from CoinGecko
- **Simulation** — Backtest the spread strategy over custom date ranges with historical data
- **Live Trading** — Connect Phantom wallet to trade real SOL on Solana mainnet via Jupiter DEX
- **Spread Monitor** — Real-time bid/ask spread visualization with threshold comparison
- **Auto-Trade** — Toggle automatic execution when spread conditions are met
- **Portfolio Tracking** — P&L, win rate, max drawdown, trade history
- **Modern UI** — Dark theme with responsive design, canvas charts, glass effects

## Quick Start

1. Open `index.html` in a browser
2. The app loads live SOL/AUD prices from CoinGecko automatically
3. Set your spread threshold (default 0.50%)
4. Use Paper Trading mode to practice — no wallet needed

## Modes

| Mode | Description | Wallet Required |
|------|-------------|----------------|
| Paper Trading | Virtual A$10,000 balance, real prices, fake trades | No |
| Simulation | Backtest on historical data with custom date ranges | No |
| Live Trading | Real SOL trades via Phantom + Jupiter DEX | Yes |

## Spread Strategy Explained

```
spread = (ask_price - bid_price) / mid_price × 100%

if your_threshold > spread:
    → FAVORABLE: spread is tight, good time to trade
    → BUY signal (if not holding SOL)

if your_threshold <= spread:
    → UNFAVORABLE: spread is wide, market is thin
    → SELL signal (if holding SOL)
```

**Example:** If you set threshold to 0.50% and the current spread is 0.12%, the bot signals BUY because 0.50 > 0.12 — the spread is well within your acceptable range.

## C Trading Engine (Optional WASM Build)

The core trading logic is written in C (`engine/trading_engine.c`) and can be compiled to WebAssembly for better performance during backtesting.

### Build WASM (requires Emscripten):

```bash
cd engine
make
```

The app works without WASM — it uses an identical JavaScript engine as a fallback.

## Tech Stack

- **C** — Core trading engine (spread calc, simulation, P&L)
- **JavaScript** — UI, API integration, wallet, charts
- **CoinGecko API** — Live SOL/AUD prices + historical data
- **Phantom Wallet** — Solana wallet connection
- **Jupiter DEX** — On-chain swap execution
- **Canvas API** — Price and equity curve charts

## Files

```
solana-spread-trader/
├── index.html              # Main app
├── style.css               # Dark theme UI
├── app.js                  # All JS logic
├── engine/
│   ├── trading_engine.c    # C trading engine
│   ├── trading_engine.h    # Header
│   └── Makefile            # WASM build config
└── README.md
```

## Important Notes

- **Live trading uses real money.** Start with small amounts.
- CoinGecko free API has rate limits (~10-30 requests/minute). The app polls every 10 seconds.
- Price data is in AUD (Australian Dollars) throughout.
- Paper trading state persists in localStorage.
- The simulated spread uses a 0.15% estimate from CoinGecko mid-price. Real DEX spreads vary.
