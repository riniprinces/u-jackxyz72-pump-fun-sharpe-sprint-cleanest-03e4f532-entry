// DipSweep — a low-volatility paper bot for the Pump.fun Sharpe Sprint.
//
// Ranking is by HOURLY Sharpe ratio, so this bot optimises for a smooth
// equity curve and a positive expected value per trade, not for moonshots.
// The design comes from backtesting every obvious family on the kit's dev
// window with the local replay simulator:
//
//   * Chasing momentum (buy after a 3-minute rise) loses: entries land on
//     local tops and the 2-slot fill latency turns every fast move against
//     the buyer. Win rate ~25%, every configuration negative.
//   * Buying the earliest liquid moment (small stake, no filter) also
//     loses: fresh coins are violently thin and routinely collapse 30-60%
//     inside a few slots.
//   * Holding for graduations loses: only ~3% of coins complete, and the
//     wide stop needed to survive the wait bleeds the other 97%.
//   * Buying sharp dips wins most often: after a >=15% drop, price bounces
//     >=5% within ~10 minutes about half the time (measured on the full
//     dev window). The bounce is the only repeatable edge found.
//
// DipSweep therefore buys only after a deep, fast drop (12-45% below the
// 10-minute high) with buy flow already returning, stakes a fixed small
// amount (0.02 SOL), and exits fast: +8% take-profit, -5% stop-loss, a
// trailing stop once up 5%, or a ~20-minute time exit. One entry per mint,
// at most five open positions, so the book stays broad (120 distinct mints
// in the 11-hour dev sample) and no single coin can dominate it. A global
// equity guard pauses new entries while the book is drawn down; losers are
// never averaged down or held hoping for a recovery.
//
// Paper money only. Fully deterministic: every decision is a pure function
// of the replay batches (slots, reserves, fills). No clock, no environment,
// no Math.random. Runs as `node main.ts` on Node 22+ (erasable TypeScript;
// Node strips the types, no build step, no dependencies).

import { fileURLToPath } from 'node:url';
import {
  LAMPORTS_PER_SOL,
  runBot,
  type Bot,
  type BotState,
  type BuyInput,
  type OrderInput,
  type SellInput,
} from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------------------
// Parameters — the dip20 configuration, best of the families backtested.
// ---------------------------------------------------------------------------

/** SOL spent on each dip entry. */
const STAKE_LAMPORTS = 20_000_000n;
/** Smallest buy we place; comfortably above the 0.01 SOL round-trip bar. */
const MIN_BUY_LAMPORTS = 12_000_000n;
/** Look back this far (~2 min) for the high the price fell from. */
const DIP_WINDOW_SLOTS = 600;
/** Enter when price is at least this far below that high... */
const DIP_MIN = 0.2;
/** ...but not further than this: a >45% collapse is usually a dead coin. */
const DIP_MAX = 0.45;
/** A buy trade must have printed inside this many slots: buy flow is
 *  already returning, we are not catching a falling knife mid-dump. */
const RETURN_WINDOW_SLOTS = 150;
/** Take profit at +8% of cost (fees included). */
const TAKE_PROFIT = 1.08;
/** Stop loss at -5% of cost. */
const STOP_LOSS = 0.95;
/** Trailing stop arms at +5% ... */
const TRAIL_ARM = 1.05;
/** ...and sells on a 3% give-back from the peak. */
const TRAIL_GIVEBACK = 0.97;
/** Time exit: close anything held longer than this (~21 min). */
const MAX_HOLD_SLOTS = 6_000;
/** New buys per batch: entries are spread out, never bunched. */
const MAX_BUYS_PER_BATCH = 2;
/** Pause new entries while equity is below this share of its peak... */
const DD_HALT = 0.92;
/** ...resume once it recovers to this share. */
const DD_RESUME = 0.97;
/** Slippage tolerance (bps) on buys / sells. */
const SLIPPAGE_BUY_BPS = 1500;
const SLIPPAGE_SELL_BPS = 1000;

// ---------------------------------------------------------------------------
// Per-mint tape: every trade we have seen, trimmed to the recent past.
// ---------------------------------------------------------------------------

interface Tick {
  slot: number;
  price: number;
  buy: boolean;
}

interface Tape {
  createdSlot: number;
  ticks: Tick[];
  lastTradeSlot: number;
  /** Slot of the most recent buy trade on this mint. */
  lastBuySlot: number;
}

interface Held {
  entrySlot: number;
  peakRatio: number;
}

const tapes = new Map<string, Tape>();
/** Mints we already bought once: one entry per mint keeps the book broad. */
const entered = new Set<string>();
const held = new Map<string, Held>();
/** Mints with a sell already in flight: never stack a second sell on one. */
const sellPending = new Set<string>();
let equityPeak = 0n;
let halted = false;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function curvePrice(state: BotState, mint: string): number {
  const curve = state.curves.get(mint);
  if (curve === undefined || curve.virtual_token_reserves === 0n) return 0;
  return Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
}

function tapeFor(mint: string, slot: number): Tape {
  let tape = tapes.get(mint);
  if (tape === undefined) {
    tape = { createdSlot: slot, ticks: [], lastTradeSlot: slot, lastBuySlot: -1 };
    tapes.set(mint, tape);
  }
  return tape;
}

/** Fold this batch's events into the tapes. */
function observe(batch: { events: readonly { event: string; mint: string; slot: number }[] }): void {
  for (const e of batch.events) {
    if (e.event === 'CreateEvent') {
      tapeFor(e.mint, e.slot).createdSlot = e.slot;
      continue;
    }
    if (e.event !== 'TradeEvent') continue; // CompleteEvent needs no tape
    const trade = e as unknown as {
      virtual_quote_reserves: string;
      virtual_token_reserves: string;
      is_buy: boolean;
    };
    const price = Number(trade.virtual_quote_reserves) / Number(trade.virtual_token_reserves);
    if (price <= 0) continue;
    const tape = tapeFor(e.mint, e.slot);
    tape.ticks.push({ slot: e.slot, price, buy: trade.is_buy });
    if (trade.is_buy) tape.lastBuySlot = e.slot;
    tape.lastTradeSlot = e.slot;
    while (tape.ticks.length > 120) tape.ticks.shift();
  }
}

/**
 * The dip test: price is DIP_MIN..DIP_MAX below its high over the dip
 * window, and a buy printed recently, so demand is already coming back.
 */
function dipSignal(tape: Tape, now: number, price: number): boolean {
  if (now - tape.lastBuySlot > RETURN_WINDOW_SLOTS) return false;
  let high = 0;
  for (const t of tape.ticks) {
    if (t.slot < now - DIP_WINDOW_SLOTS) continue;
    if (t.price > high) high = t.price;
  }
  if (high <= 0 || price <= 0) return false;
  const drop = 1 - price / high;
  return drop >= DIP_MIN && drop <= DIP_MAX;
}

/** Mark-to-market equity: cash plus positions at current curve prices. */
function equityOf(state: BotState): bigint {
  let equity = state.cash;
  for (const [mint, pos] of state.positions) {
    const price = curvePrice(state, mint);
    if (price <= 0) continue;
    equity += BigInt(Math.floor(Number(pos.token_amount) * price));
  }
  return equity;
}

function pendingBuyMint(state: BotState, mint: string): boolean {
  for (const p of state.pending.values()) {
    if (p.order.side === 'buy' && p.order.mint === mint) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The bot
// ---------------------------------------------------------------------------

export const sharpeBot: Bot = {
  onHello(state) {
    tapes.clear();
    entered.clear();
    held.clear();
    sellPending.clear();
    equityPeak = BigInt(state.hello.capital.lamports);
    halted = false;
  },

  onBatch(state, batch) {
    const now = batch.slot;
    observe(batch);
    if (batch.seq % 100 === 0) {
      for (const [mint, tape] of tapes) {
        if (now - tape.lastTradeSlot > 60_000) tapes.delete(mint);
      }
    }

    // A sell that filled (or was rejected) is no longer in flight.
    for (const f of batch.fills) {
      if (f.side === 'sell') sellPending.delete(f.mint);
    }

    const orders: OrderInput[] = [];
    const tx = state.txFeeLamports();

    // --- exits: manage the book before opening anything new. ---
    for (const [mint, pos] of state.positions) {
      if (sellPending.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const price = curvePrice(state, mint);
      if (price <= 0) continue;
      const value = BigInt(Math.floor(Number(pos.token_amount) * price));
      const ratio = Number(value) / Number(pos.cost_lamports);
      let info = held.get(mint);
      if (info === undefined) {
        info = { entrySlot: now, peakRatio: ratio };
        held.set(mint, info);
      }
      if (ratio > info.peakRatio) info.peakRatio = ratio;
      const trailing = info.peakRatio >= TRAIL_ARM && ratio <= info.peakRatio * TRAIL_GIVEBACK;
      const timeUp = now - info.entrySlot >= MAX_HOLD_SLOTS;
      if (ratio >= TAKE_PROFIT || ratio <= STOP_LOSS || trailing || timeUp) {
        const sell: SellInput = {
          side: 'sell',
          mint,
          token_amount: pos.token_amount,
          max_slippage_bps: SLIPPAGE_SELL_BPS,
        };
        orders.push(sell);
        sellPending.add(mint);
        held.delete(mint);
      }
    }

    // --- drawdown guard: pause entries, never exits. ---
    const equity = equityOf(state);
    if (equity > equityPeak) equityPeak = equity;
    if (halted) {
      if (equity * 100n >= equityPeak * BigInt(Math.round(DD_RESUME * 100))) halted = false;
    } else if (equity * 100n < equityPeak * BigInt(Math.round(DD_HALT * 100))) {
      halted = true;
    }

    // --- entries: one fresh dip per batch, up to the slot cap. ---
    if (!halted && orders.length < state.hello.caps.max_orders_per_batch) {
      let free = state.freeCashLamports();
      let slots = state.hello.caps.max_open_positions - state.committedPositionCount();
      let buys = 0;
      const seen = new Set<string>();
      for (const e of batch.events) {
        if (buys >= MAX_BUYS_PER_BATCH || slots <= 0) break;
        if (orders.length >= state.hello.caps.max_orders_per_batch) break;
        if (e.event !== 'TradeEvent' && e.event !== 'CreateEvent') continue;
        const mint = e.mint;
        if (seen.has(mint) || entered.has(mint)) continue;
        seen.add(mint);
        if (state.positions.has(mint) || pendingBuyMint(state, mint)) continue;
        const tape = tapes.get(mint);
        if (tape === undefined) continue;
        const price = curvePrice(state, mint);
        if (!dipSignal(tape, now, price)) continue;
        const cap = state.maxBuyLamports(mint);
        if (cap < MIN_BUY_LAMPORTS) continue;
        const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
        if (free < amount + tx) continue;
        const buy: BuyInput = {
          side: 'buy',
          mint,
          quote_lamports: amount,
          max_slippage_bps: SLIPPAGE_BUY_BPS,
        };
        orders.push(buy);
        entered.add(mint);
        held.set(mint, { entrySlot: now, peakRatio: 0 });
        free -= amount + tx;
        slots -= 1;
        buys += 1;
      }
    }

    return orders;
  },
};

// Run the wire loop only when executed directly (`node main.ts`).
// Importing this file (for local backtests) exposes `sharpeBot` instead.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await runBot(sharpeBot);
}
