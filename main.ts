// Pump.fun Replay Sprint — momentum paper bot (fresh build for @sausage-sosis).
//
// Strategy, in one paragraph: watch every new pump.fun curve's tape in batches; when a
// curve that is a few hundred slots old shows real, broad buy pressure — several distinct
// buyers, net SOL flowing in, price climbing and holding near its recent high — buy a
// modest stake, add once if it keeps running, and exit on a stop loss, a take-profit, a
// trailing stop, fading flow, or a hold-time limit. Small probes keep the round-trip
// guardrail (20 distinct mints) on pace through the 24h window. Everything is
// deterministic: float64 math on event data only, no clock, no randomness, no network.
//
// Run by the grader as `node /bot/main.ts` (Node 22 strip-types). The wire protocol
// lives in the vendored shim (vendor/makefun-bot.ts, a copy of the kit SDK).

import { LAMPORTS_PER_SOL, runBot, type BotState, type Batch, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const LAM = 1e9;
const TX_SOL = 105000 / LAM; // base 5000 + priority 100000 lamports per tx
const CURVE_FEE = 0.0125; // 95 bps protocol + 30 bps creator

// ---- tunables ----
const WINDOW = 40; // entry lookback, slots
const MIN_AGE = 400; // mature curves only: fresh launches are mostly bundled dumps
const MAX_AGE = 1e12; // no upper age bound for mature-momentum entries
const MIN_BUYS = 5;
const MIN_BUYERS = 8;
const MAX_BUYERS = 1e9; // no upper bound on buyers for mature curves
const MIN_NET_SOL = 2.0; // net SOL inflow over the window
const MIN_UP = 0.2; // price rise over the window
const MAX_UP = 0.8; // skip curves that already ran too far in one window
const NEAR_HIGH = 0.95; // price now vs window high
const MIN_RQ = 2; // real SOL bounds at entry
const MAX_RQ = 60;
const STAKE = 0.012; // SOL per position (initial buy — small, false starts cost little)
const ADD_SOL = 0; // pyramid adds off: adding to a 10%-win-rate signal only enlarges losers
const MAX_PER_COIN = 0.012;
const MIN_BUY = 0.01; // matches the guardrail's minimum round-trip buy
const BUY_SLIP = 1500;
const STOP_LOSS = 0.08;
const TAKE_PROFIT = 1.0; // let runners run; the trailing stop does the selling
const TRAIL = 0.25;
const TRAIL_ARM = 0.3;
const MAX_HOLD = 1000; // slots
const FADE_WINDOW = 20;
const FADE_NET = -2.0; // exit only on strong net selling over the fade window (SOL)
const BIG_SELL_SOL = 0.3; // exit at once when one recorded sell is this big (whale dumping)
const RIDE_RQ = 60; // once real SOL passes this, completion is near: hold, skip fade/trail exits
const COOLDOWN = 100;
const MAX_ENTRIES = 2;
const ENTRY_CUTOFF_SECS = 72000; // stop opening new positions in the last ~4h of the window
const PROBE_SOL = 0.02;
const TARGET_COINS = 25;
const PACE_SECS = 14400;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peak: number;
  invested: number;
  exiting: boolean;
  filled: boolean;
  entryPrice: number;
  added: boolean;
  lastValue: number;
}

const tapes = new Map<Pubkey, Tape>();
const held = new Map<Pubkey, Held>();
const probes = new Map<Pubkey, boolean>(); // mint -> true once its sell is queued
let myFills = 0;
const myCoins = new Set<Pubkey>();
let firstTime: number | null = null;
let lastTime: number | null = null;
let saidHello = false;

function tapeOf(mint: Pubkey): Tape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
    tapes.set(mint, t);
  }
  return t;
}

function netFlow(t: Tape, now: number, w: number): number {
  let net = 0;
  for (let i = t.trades.length - 1; i >= 0; i--) {
    const tr = t.trades[i]!;
    if (tr.slot <= now - w) break;
    net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
}

function entryOk(t: Tape, now: number, rqSol: number): boolean {
  if (rqSol < MIN_RQ || rqSol > MAX_RQ) return false;
  if (t.created === null || now - t.created < MIN_AGE || now - t.created > MAX_AGE) return false;
  const from = now - WINDOW;
  const mid = now - WINDOW / 2;
  let buySol = 0;
  let sellSol = 0;
  let buys = 0;
  let netOld = 0;
  let netNew = 0;
  let startPrice = -1;
  let high = 0;
  let last = 0;
  const buyers = new Set<string>();
  for (const tr of t.trades) {
    if (tr.slot <= from) {
      startPrice = tr.price;
      continue;
    }
    if (startPrice < 0) startPrice = tr.price;
    const signed = tr.buy ? tr.sol : -tr.sol;
    if (tr.slot <= mid) netOld += signed;
    else netNew += signed;
    if (tr.buy) {
      buySol += tr.sol;
      buys++;
      buyers.add(tr.user);
    } else {
      sellSol += tr.sol;
    }
    if (tr.price > high) high = tr.price;
    last = tr.price;
  }
  if (buys < MIN_BUYS || buyers.size < MIN_BUYERS || buyers.size > MAX_BUYERS) return false;
  if (buySol - sellSol < MIN_NET_SOL) return false;
  // Acceleration: the newer half of the window must inflow at least 1.5x the older half.
  if (netNew <= 0 || netNew < 1.5 * netOld) return false;
  if (startPrice <= 0 || last <= 0) return false;
  const up = last / startPrice - 1;
  if (up < MIN_UP || up > MAX_UP) return false;
  if (last < high * NEAR_HIGH) return false;
  return true;
}

/** Mark-to-market sell value of a position in SOL, curve + tx fees deducted. */
function closeValue(state: BotState, mint: Pubkey, tokens: number): number {
  const curve = state.curves.get(mint);
  if (curve === undefined) return 0;
  const vq = Number(curve.virtual_quote_reserves);
  const vt = Number(curve.virtual_token_reserves);
  return ((tokens * vq) / (vt + tokens) / LAM) * (1 - CURVE_FEE) - TX_SOL;
}

await runBot({
  onHello(state) {
    if (!saidHello) {
      console.error('hello: pump-fun replay bot up, capital ' + (Number(state.hello.capital.lamports) / LAM) + ' SOL');
      saidHello = true;
    }
  },
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    const traded = new Set<Pubkey>();
    const bigSell = new Set<Pubkey>();
    for (const f of batch.fills) {
      if (f.status === 'filled' && !f.client_id.startsWith('_')) {
        myFills++;
        myCoins.add(f.mint);
      }
    }
    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (firstTime === null) firstTime = e.block_time;
        if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        tapeOf(e.mint).created = e.slot;
      } else if (e.event === 'TradeEvent') {
        const t = tapeOf(e.mint);
        const sol = Number(e.sol_amount) / LAM;
        t.trades.push({
          slot: e.slot,
          buy: e.is_buy,
          sol,
          user: e.user,
          price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
        });
        traded.add(e.mint);
        if (!e.is_buy && sol >= BIG_SELL_SOL) bigSell.add(e.mint);
      }
    }
    // Prune old tape entries per traded mint.
    const keep = WINDOW + 5;
    for (const mint of traded) {
      const t = tapes.get(mint)!;
      let cut = 0;
      while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
      if (cut > 0) t.trades.splice(0, cut);
    }

    const pendingByMint = new Map<Pubkey, number>();
    for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
    const orders: OrderInput[] = [];
    const cap = state.hello.caps.max_orders_per_batch;
    const elapsed = firstTime !== null && lastTime !== null ? lastTime - firstTime : 0;
    const lateWindow = elapsed > ENTRY_CUTOFF_SECS;

    // ---- exits first ----
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) {
          held.delete(mint);
          if (h.filled) tapeOf(mint).lastExit = now;
          else tapeOf(mint).entries--;
        }
        continue;
      }
      h.filled = true;
      if (curve === undefined || curve.complete) continue;
      const value = closeValue(state, mint, Number(pos.token_amount));
      if (value > h.peak) h.peak = value;
      h.lastValue = value;
      const cost = Number(pos.cost_lamports) / LAM;
      const rqSol = Number(curve.real_quote_reserves) / LAM;
      const riding = rqSol >= RIDE_RQ;
      let exit = h.exiting;
      if (!exit && value < cost * (1 - STOP_LOSS)) exit = true;
      if (!exit && value >= cost * (1 + TAKE_PROFIT)) exit = true;
      if (!exit && !riding && h.peak >= cost * (1 + TRAIL_ARM) && value < h.peak * (1 - TRAIL)) exit = true;
      if (!exit && !riding && netFlow(tapeOf(mint), now, FADE_WINDOW) < FADE_NET) exit = true;
      if (!exit && !riding && bigSell.has(mint)) exit = true;
      if (!exit && now - h.opened > MAX_HOLD && value < cost) exit = true;
      if (!exit) continue;
      h.exiting = true;
      let sellPending = false;
      for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
      if (sellPending) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
    }

    // ---- probe sells: sell the whole probe as soon as its buy landed ----
    for (const [mint, selling] of probes) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) probes.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
      if (orders.length >= cap) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      if (!selling) probes.set(mint, true);
    }

    // ---- entries and pyramid adds ----
    let free = Number(state.freeCashLamports()) / LAM;
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    for (const mint of traded) {
      if (orders.length >= cap) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingByMint.has(mint) || probes.has(mint)) continue;
      const t = tapes.get(mint)!;
      const h = held.get(mint);
      const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
      const rqSol = Number(curve.real_quote_reserves) / LAM;
      let want: number;
      if (h === undefined) {
        if (lateWindow || slotsLeft <= 0) continue;
        if (t.entries >= MAX_ENTRIES || now - t.lastExit < COOLDOWN) continue;
        if (!entryOk(t, now, rqSol)) continue;
        want = STAKE;
      } else {
        if (h.exiting || !h.filled || h.added || h.invested >= MAX_PER_COIN - MIN_BUY) continue;
        if (price < h.entryPrice * 1.15) continue;
        if (h.lastValue < Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAM) continue;
        if (netFlow(t, now, WINDOW) < MIN_NET_SOL) continue;
        if (rqSol > MAX_RQ) continue;
        want = ADD_SOL;
      }
      const capSol = Number(state.maxBuyLamports(mint)) / LAM;
      let amount = Math.min(capSol, want);
      if (amount > free - TX_SOL) amount = free - TX_SOL;
      if (amount < MIN_BUY) continue;
      orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAM)), max_slippage_bps: BUY_SLIP });
      free -= amount + TX_SOL;
      if (h === undefined) {
        held.set(mint, { opened: now, peak: 0, invested: amount, exiting: false, filled: false, entryPrice: price, added: false, lastValue: 0 });
        t.entries++;
        slotsLeft--;
      } else {
        h.invested += amount;
        h.added = true;
      }
    }

    // ---- guardrail pacing: probe round trips when coins/fills lag the pace ----
    if (probes.size === 0 && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
      const pace = Math.min(1, elapsed / PACE_SECS);
      const needCoins = myCoins.size < Math.ceil(TARGET_COINS * pace);
      const needFills = myFills < Math.ceil(TARGET_COINS * 2 * pace);
      if (needCoins || needFills) {
        for (const mint of traded) {
          if (orders.length >= cap || probes.size >= 1) break;
          if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
          if (needCoins && !needFills && myCoins.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (Number(curve.real_quote_reserves) / LAM < 1) continue;
          if (free < PROBE_SOL + 2 * TX_SOL) break;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(PROBE_SOL * LAM)), max_slippage_bps: BUY_SLIP });
          probes.set(mint, false);
          free -= PROBE_SOL + TX_SOL;
        }
      }
    }
    return orders;
  },
});
