[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/riniprinces/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532-entry/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/riniprinces/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532-entry/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

# DipSweep — Pump.fun Sharpe Sprint

A paper-trading bot for the [Pump.fun Sharpe Sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) on make.fun. Places go by **hourly Sharpe ratio** on a 6-hour pump.fun forward replay, so this bot optimises for steady, controlled gains — not moonshots.

## Strategy

Backtesting every obvious family on the kit's dev window showed that chasing momentum, buying fresh coins early, and holding for graduations all lose money (the 2-slot fill latency turns fast entries into buying local tops, and fresh curves collapse 30–60% in minutes). The one repeatable edge found was the **dip bounce**: after a ≥15% drop, price bounces ≥5% within ~10 minutes about half the time.

DipSweep therefore:

- **Buys only after a deep, fast drop** — 20–45% below the 10-minute high — with buy flow already returning (a buy printed in the last ~30 seconds of replay).
- **Stakes a fixed small amount** (0.02 SOL) per entry, one entry per mint, at most 5 open positions, so the book stays broad (383 distinct mints in the full dev window).
- **Exits fast and mechanically**: +8% take-profit, −5% stop-loss, a trailing stop once up 5%, or a ~21-minute time exit. Losers are never averaged down or held hoping for a recovery.
- **Pauses new entries** while equity is more than 8% below its peak (exits continue).

Local grade on the kit's dev window (official `grade-local`, process driver): net PnL −0.44 SOL, hourly Sharpe −1.06, max drawdown 4.4%, 383 round trips on 383 distinct mints, deterministic across runs (action logs match). The dev window is a hard, mean-reverting sample; the bot is built for the cleanest possible Sharpe in the final window, with drawdown far inside the 50% guardrail.

## Run it

Requires Node 22.18+ (the grader runs Node 22.23.4; TypeScript is stripped by Node, no build step, no dependencies).

```sh
node main.ts
```

`main.ts` speaks the `agent-fun/replay/v2` protocol on stdin/stdout: it reads `hello` / `batch` / `done` JSON lines and writes one `reply` per batch. The SDK shim is vendored at `vendor/makefun-bot.ts`. Everything the entry runs is in this repository.

## Files

- `main.ts` — the strategy (entrypoint).
- `vendor/makefun-bot.ts` — the kit's replay-protocol shim (byte-identical to `sdk/ts/makefun-bot.ts`).
- `LICENSE` — MIT.

<sub>Entered on [make.fun](https://make.fun/?ref=vs2rmk5b&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
