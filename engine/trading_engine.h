#ifndef TRADING_ENGINE_H
#define TRADING_ENGINE_H

#include <stdint.h>
#include <stdbool.h>

#define MAX_TRADES 10000
#define MAX_CANDLES 5000

typedef struct {
    double timestamp;
    double open;
    double high;
    double low;
    double close;
    double volume;
} Candle;

typedef struct {
    double timestamp;
    bool is_buy;
    double price;
    double amount_sol;
    double amount_aud;
    double spread_at_trade;
    double pnl;
} Trade;

typedef struct {
    double buy_price;
    double sell_price;
    double spread;
    double spread_pct;
    double threshold;
    double balance_sol;
    double balance_aud;
    double initial_aud;
    double total_pnl;
    double total_pnl_pct;
    double max_drawdown;
    double peak_balance;
    double win_rate;
    int total_trades;
    int winning_trades;
    int losing_trades;
    Trade trades[MAX_TRADES];
    int trade_count;
    /* Cost basis tracking for current open position */
    double cost_basis_total;
    double cost_basis_sol;
} TradingState;

typedef struct {
    double final_balance_aud;
    double total_pnl;
    double total_pnl_pct;
    double max_drawdown;
    double win_rate;
    double sharpe_ratio;
    double avg_trade_pnl;
    int total_trades;
    int winning_trades;
    int losing_trades;
    double best_trade;
    double worst_trade;
    Trade trades[MAX_TRADES];
    int trade_count;
} SimulationResult;

/* Core engine functions */
void engine_init(TradingState *state, double initial_aud, double threshold);
void engine_update_prices(TradingState *state, double buy_price, double sell_price);
double engine_calculate_spread(double buy_price, double sell_price);
double engine_calculate_spread_pct(double buy_price, double sell_price);
bool engine_should_trade(const TradingState *state);
bool engine_execute_buy(TradingState *state, double amount_aud);
bool engine_execute_sell(TradingState *state, double amount_sol);
void engine_update_pnl(TradingState *state);

/* Simulation */
SimulationResult engine_run_simulation(
    const Candle *candles,
    int candle_count,
    double initial_aud,
    double threshold,
    double trade_amount_pct
);

/* Utility */
double engine_calculate_sharpe(const Trade *trades, int count);
double engine_calculate_max_drawdown(const Trade *trades, int count, double initial_balance);

#endif /* TRADING_ENGINE_H */
