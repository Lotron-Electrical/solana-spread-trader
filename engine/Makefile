# Solana Spread Trader — WASM Build
# Requires: Emscripten SDK (https://emscripten.org/docs/getting_started/)
#
# Install Emscripten:
#   git clone https://github.com/emscripten-core/emsdk.git
#   cd emsdk && ./emsdk install latest && ./emsdk activate latest
#   source ./emsdk_env.sh
#
# Then run: make

CC = emcc
CFLAGS = -O2 -s WASM=1 -s EXPORTED_RUNTIME_METHODS='["cwrap","ccall"]' \
         -s ALLOW_MEMORY_GROWTH=1 -s MODULARIZE=1 -s EXPORT_NAME='TradingEngine' \
         -s EXPORTED_FUNCTIONS='["_engine_init","_engine_update_prices","_engine_calculate_spread","_engine_calculate_spread_pct","_engine_should_trade","_engine_execute_buy","_engine_execute_sell","_engine_update_pnl","_engine_run_simulation","_engine_calculate_sharpe","_engine_calculate_max_drawdown","_malloc","_free"]'

SRC = trading_engine.c
OUT = ../trading_engine.js

.PHONY: all clean

all: $(OUT)

$(OUT): $(SRC) trading_engine.h
	$(CC) $(CFLAGS) $(SRC) -o $(OUT) -lm

clean:
	rm -f $(OUT) ../trading_engine.wasm
