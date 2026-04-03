#include "trading_engine.h"
#include <math.h>
#include <string.h>

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define EXPORT
#endif

/* ── Initialization ── */

EXPORT void engine_init(TradingState *state, double initial_aud, double threshold) {
    memset(state, 0, sizeof(TradingState));
    state->balance_aud = initial_aud;
    state->initial_aud = initial_aud;
    state->threshold = threshold;
    state->peak_balance = initial_aud;
    state->balance_sol = 0.0;
    state->total_pnl = 0.0;
    state->total_pnl_pct = 0.0;
    state->max_drawdown = 0.0;
    state->trade_count = 0;
    state->total_trades = 0;
    state->winning_trades = 0;
    state->losing_trades = 0;
    state->cost_basis_total = 0.0;
    state->cost_basis_sol = 0.0;
}

/* ── Price Updates ── */

EXPORT void engine_update_prices(TradingState *state, double buy_price, double sell_price) {
    state->buy_price = buy_price;
    state->sell_price = sell_price;
    state->spread = engine_calculate_spread(buy_price, sell_price);
    state->spread_pct = engine_calculate_spread_pct(buy_price, sell_price);
    engine_update_pnl(state);
}

/* ── Spread Calculations ── */

EXPORT double engine_calculate_spread(double buy_price, double sell_price) {
    return sell_price - buy_price;
}

EXPORT double engine_calculate_spread_pct(double buy_price, double sell_price) {
    if (buy_price <= 0.0) return 0.0;
    double mid = (buy_price + sell_price) / 2.0;
    if (mid <= 0.0) return 0.0;
    return ((sell_price - buy_price) / mid) * 100.0;
}

/* ── Trading Signal ──
 * The user's parameter (threshold) must be BIGGER than the spread.
 * When threshold > spread, conditions are favorable — the spread is
 * tight enough relative to the user's acceptable cost.
 */

EXPORT bool engine_should_trade(const TradingState *state) {
    if (state->buy_price <= 0.0 || state->sell_price <= 0.0) return false;
    return state->threshold > state->spread_pct;
}

/* ── Trade Execution ── */

EXPORT bool engine_execute_buy(TradingState *state, double amount_aud) {
    if (amount_aud <= 0.0 || amount_aud > state->balance_aud) return false;
    if (state->sell_price <= 0.0) return false;
    if (state->trade_count >= MAX_TRADES) return false;

    double sol_received = amount_aud / state->sell_price;
    state->balance_aud -= amount_aud;
    state->balance_sol += sol_received;

    /* Update cost basis for current position */
    state->cost_basis_total += amount_aud;
    state->cost_basis_sol += sol_received;

    Trade *t = &state->trades[state->trade_count];
    t->timestamp = 0; /* Set by caller */
    t->is_buy = true;
    t->price = state->sell_price;
    t->amount_sol = sol_received;
    t->amount_aud = amount_aud;
    t->spread_at_trade = state->spread_pct;
    t->pnl = 0.0;

    state->trade_count++;
    state->total_trades++;
    engine_update_pnl(state);
    return true;
}

EXPORT bool engine_execute_sell(TradingState *state, double amount_sol) {
    if (amount_sol <= 0.0 || amount_sol > state->balance_sol) return false;
    if (state->buy_price <= 0.0) return false;
    if (state->trade_count >= MAX_TRADES) return false;

    double aud_received = amount_sol * state->buy_price;
    state->balance_sol -= amount_sol;
    state->balance_aud += aud_received;

    /* P&L vs average buy price for current position */
    double avg_price = (state->cost_basis_sol > 0.0)
        ? (state->cost_basis_total / state->cost_basis_sol) : 0.0;
    double trade_pnl = (state->buy_price - avg_price) * amount_sol;

    /* Reset or reduce cost basis */
    if (state->balance_sol < 0.000001) {
        state->cost_basis_total = 0.0;
        state->cost_basis_sol = 0.0;
    } else {
        double ratio = amount_sol / (amount_sol + state->balance_sol);
        state->cost_basis_total *= (1.0 - ratio);
        state->cost_basis_sol -= amount_sol;
    }

    Trade *t = &state->trades[state->trade_count];
    t->timestamp = 0;
    t->is_buy = false;
    t->price = state->buy_price;
    t->amount_sol = amount_sol;
    t->amount_aud = aud_received;
    t->spread_at_trade = state->spread_pct;
    t->pnl = trade_pnl;

    state->trade_count++;
    state->total_trades++;

    if (trade_pnl > 0.0) {
        state->winning_trades++;
    } else {
        state->losing_trades++;
    }

    engine_update_pnl(state);
    return true;
}

/* ── P&L Tracking ── */

EXPORT void engine_update_pnl(TradingState *state) {
    double current_value = state->balance_aud + (state->balance_sol * state->buy_price);
    state->total_pnl = current_value - state->initial_aud;
    state->total_pnl_pct = (state->initial_aud > 0.0)
        ? (state->total_pnl / state->initial_aud) * 100.0
        : 0.0;

    if (current_value > state->peak_balance) {
        state->peak_balance = current_value;
    }

    if (state->peak_balance > 0.0) {
        double drawdown = (state->peak_balance - current_value) / state->peak_balance * 100.0;
        if (drawdown > state->max_drawdown) {
            state->max_drawdown = drawdown;
        }
    }

    state->win_rate = (state->total_trades > 0)
        ? ((double)state->winning_trades / (double)state->total_trades) * 100.0
        : 0.0;
}

/* ── Simulation Engine ──
 * Runs a spread-based strategy over historical candle data.
 * Strategy:
 *   - At each candle, estimate spread from high-low range
 *   - If threshold > spread_pct → BUY (if holding AUD)
 *   - If threshold <= spread_pct → SELL (if holding SOL)
 *   - trade_amount_pct = percentage of balance to use per trade
 */

EXPORT SimulationResult engine_run_simulation(
    const Candle *candles,
    int candle_count,
    double initial_aud,
    double threshold,
    double trade_amount_pct
) {
    SimulationResult result;
    memset(&result, 0, sizeof(SimulationResult));

    if (candle_count <= 0 || initial_aud <= 0.0) return result;
    if (trade_amount_pct <= 0.0 || trade_amount_pct > 100.0) {
        trade_amount_pct = 10.0; /* Default 10% per trade */
    }

    TradingState state;
    engine_init(&state, initial_aud, threshold);

    bool holding_sol = false;

    for (int i = 0; i < candle_count; i++) {
        const Candle *c = &candles[i];

        /* Estimate bid/ask from candle data:
         * buy_price (bid) ≈ close - half the range spread
         * sell_price (ask) ≈ close + half the range spread
         * Minimum spread of 0.1% to be realistic */
        double range = c->high - c->low;
        double min_spread = c->close * 0.001;
        if (range < min_spread) range = min_spread;

        double half_spread = range * 0.25; /* Use quarter of range as bid-ask */
        double bid = c->close - half_spread;
        double ask = c->close + half_spread;

        if (bid <= 0.0) bid = c->close * 0.999;
        if (ask <= 0.0) ask = c->close * 1.001;

        engine_update_prices(&state, bid, ask);

        bool signal = engine_should_trade(&state);

        if (signal && !holding_sol && state.balance_aud > 0.0) {
            /* Favorable spread — buy SOL */
            double amount = state.balance_aud * (trade_amount_pct / 100.0);
            if (amount < 1.0) amount = state.balance_aud; /* Go all-in if remainder is tiny */
            if (engine_execute_buy(&state, amount)) {
                state.trades[state.trade_count - 1].timestamp = c->timestamp;
                holding_sol = true;
            }
        } else if (!signal && holding_sol && state.balance_sol > 0.0) {
            /* Spread widened — sell SOL to lock in profit/cut loss */
            if (engine_execute_sell(&state, state.balance_sol)) {
                state.trades[state.trade_count - 1].timestamp = c->timestamp;
                holding_sol = false;
            }
        }
    }

    /* Close any remaining position at the last candle price */
    if (holding_sol && state.balance_sol > 0.0 && candle_count > 0) {
        const Candle *last = &candles[candle_count - 1];
        engine_update_prices(&state, last->close * 0.999, last->close * 1.001);
        if (engine_execute_sell(&state, state.balance_sol)) {
            state.trades[state.trade_count - 1].timestamp = last->timestamp;
        }
    }

    engine_update_pnl(&state);

    result.final_balance_aud = state.balance_aud;
    result.total_pnl = state.total_pnl;
    result.total_pnl_pct = state.total_pnl_pct;
    result.max_drawdown = state.max_drawdown;
    result.win_rate = state.win_rate;
    result.total_trades = state.total_trades;
    result.winning_trades = state.winning_trades;
    result.losing_trades = state.losing_trades;
    result.trade_count = state.trade_count;
    result.sharpe_ratio = engine_calculate_sharpe(state.trades, state.trade_count);

    /* Copy trades */
    int copy_count = state.trade_count;
    if (copy_count > MAX_TRADES) copy_count = MAX_TRADES;
    memcpy(result.trades, state.trades, copy_count * sizeof(Trade));

    /* Best/worst trade */
    result.best_trade = 0.0;
    result.worst_trade = 0.0;
    for (int i = 0; i < state.trade_count; i++) {
        if (!state.trades[i].is_buy) {
            if (state.trades[i].pnl > result.best_trade) result.best_trade = state.trades[i].pnl;
            if (state.trades[i].pnl < result.worst_trade) result.worst_trade = state.trades[i].pnl;
        }
    }

    result.avg_trade_pnl = (state.total_trades > 0)
        ? result.total_pnl / state.total_trades
        : 0.0;

    return result;
}

/* ── Sharpe Ratio ── */

EXPORT double engine_calculate_sharpe(const Trade *trades, int count) {
    if (count < 2) return 0.0;

    /* Collect sell-trade returns */
    double returns[MAX_TRADES];
    int n = 0;
    for (int i = 0; i < count && n < MAX_TRADES; i++) {
        if (!trades[i].is_buy && trades[i].amount_aud > 0.0) {
            returns[n++] = trades[i].pnl / trades[i].amount_aud;
        }
    }

    if (n < 2) return 0.0;

    double sum = 0.0;
    for (int i = 0; i < n; i++) sum += returns[i];
    double mean = sum / n;

    double var_sum = 0.0;
    for (int i = 0; i < n; i++) {
        double diff = returns[i] - mean;
        var_sum += diff * diff;
    }
    double stddev = sqrt(var_sum / (n - 1));

    if (stddev < 1e-10) return 0.0;
    return mean / stddev;
}

/* ── Max Drawdown ── */

EXPORT double engine_calculate_max_drawdown(const Trade *trades, int count, double initial_balance) {
    double peak = initial_balance;
    double max_dd = 0.0;
    double balance = initial_balance;

    for (int i = 0; i < count; i++) {
        if (trades[i].is_buy) {
            balance -= trades[i].amount_aud;
        } else {
            balance += trades[i].amount_aud;
        }
        if (balance > peak) peak = balance;
        if (peak > 0.0) {
            double dd = (peak - balance) / peak * 100.0;
            if (dd > max_dd) max_dd = dd;
        }
    }

    return max_dd;
}
