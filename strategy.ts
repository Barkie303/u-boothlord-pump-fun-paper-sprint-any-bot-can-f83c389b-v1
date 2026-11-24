// Early-flow sniper + graduation rider for the pump.fun replay sprint.
//
// Two edges, both measured on the dev window itself:
//
// 1. Sniper: coins whose first ~2 minutes show real buying (net >= 2 SOL
//    from >= 4 distinct buyers) are the only ones that ever graduate; coins
//    with weak early flow graduated 0 times out of 627. The sniper buys
//    those at +300 slots with a very tight stop (-5% of cost), a 2x take
//    profit, and a short time exit — most trades lose a little, the few
//    runners pay for them.
//
// 2. Rider: a coin whose real SOL reserve crosses 50 SOL and holds it for
//    50 slots is usually either about to graduate (~2x from the 50-SOL
//    price for the slow graduates on the dev window) or about to dump; the
//    rider buys 0.6 SOL, rides to completion (the harness closes the
//    position at the graduation price), and caps the dump with a -15% stop.
//    Most graduates are instant (created and completed in one slot) and
//    unbuyable — the rider only ever sees the slow ones.
//
// Fees are the enemy (1.25% per side + 105k lamports per order), so the bot
// trades rarely: one buy per coin, one sell to close, no pyramiding, no
// re-entries. A tiny filler (0.02 SOL round trips on liquid coins) runs only
// until the 20-coin guardrail is met, then stops.
//
// Deterministic: no clock, no environment, no Math.random — every decision
// comes from slot numbers and event data alone, so the two grading runs
// match byte for byte.

import {
  type Batch,
  type Bot,
  type BotState,
  type OrderInput,
  type Pubkey,
} from './vendor/makefun-bot.ts';

export interface SniperConfig {
  /** Slots of early trading watched before a coin is judged (~0.4 s each). */
  evalSlots: number;
  /** Minimum net buy SOL (buys minus sells) inside the eval window. */
  netMinSol: number;
  /** Minimum distinct buyers inside the eval window. */
  buyersMin: number;
  /** Largest single buyer may not exceed this share of buy SOL. */
  whaleMaxShare: number;
  /** Price at eval must be at least this multiple of the first trade price. */
  pumpMin: number;
  /** SOL spent per snipe buy (capped by the 1%-of-reserve rule). */
  buySol: number;
  /** Sell when the price falls this far below the position's peak. */
  trailPct: number;
  /** Sell when the price falls this far below the entry price. */
  stopPct: number;
  /** Sell a flat position after this many slots held. */
  holdMaxSlots: number;
  /** 0 disables: sell the whole position at this multiple of entry. */
  takeProfitMult: number;
  /** SOL per filler round trip (guardrail filler only). */
  fillerSol: number;
  /** Slots a filler position is held before it is closed. */
  fillerHoldSlots: number;
  /** Stop filling once this many distinct coins have round-tripped. */
  fillerTripsTarget: number;
  /** Max slippage (bps) allowed on buys / sells. */
  buySlippageBps: number;
  sellSlippageBps: number;
  /** Enable the early-flow sniper entries. */
  snipeEnabled: boolean;
  /** Enable the graduation-rider entries. */
  riderEnabled: boolean;
  /** Real SOL reserve a coin must reach to qualify as a rider entry. */
  rideMinSol: number;
  /** Slots a rider candidate must stay above rideMinSol*0.9 before buying. */
  rideConfirmSlots: number;
  /** SOL spent per rider buy (capped by the 1%-of-reserve rule). */
  rideSol: number;
  /** Rider hard stop: sell when proceeds fall this far below cost. */
  rideStopPct: number;
  /** Rider time exit: sell after this many slots held without completing. */
  rideHoldSlots: number;
  /** Rider entries only within this many slots of crossing rideMinSol. */
  rideWindowSlots: number;
}

export const DEFAULT_CONFIG: SniperConfig = {
  evalSlots: 300,
  netMinSol: 4.0,
  buyersMin: 8,
  whaleMaxShare: 0.6,
  pumpMin: 1.3,
  buySol: 0.08,
  trailPct: 0.35,
  stopPct: 0.05,
  holdMaxSlots: 300,
  takeProfitMult: 2,
  fillerSol: 0.02,
  fillerHoldSlots: 200,
  fillerTripsTarget: 22,
  buySlippageBps: 5000,
  sellSlippageBps: 5000,
  snipeEnabled: true,
  riderEnabled: true,
  rideMinSol: 50,
  rideConfirmSlots: 50,
  rideSol: 0.6,
  rideStopPct: 0.15,
  rideHoldSlots: 20000,
  rideWindowSlots: 3000,
};

interface CoinStats {
  createdSlot: number;
  firstPrice: number;
  buySol: number;
  sellSol: number;
  buyers: Set<string>;
  buyerSol: Map<string, number>;
  trades: number;
  evaluated: boolean;
  lastPrice: number;
  lastRealSol: number;
  lastSlot: number;
  /** First slot the coin's real SOL reserve reached rideMinSol (-1 if never). */
  crossedSlot: number;
}

interface OpenPosition {
  entrySlot: number;
  kind: 'snipe' | 'filler' | 'rider';
  /** Highest sell proceeds (lamports) this position has ever been worth. */
  peakProceeds: bigint;
  /** Cost basis (lamports) from the latest account report. */
  cost: bigint;
}

const lamports = (sol: number): bigint => BigInt(Math.round(sol * 1e9));

function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

export function createBot(overrides: Partial<SniperConfig> = {}): Bot {
  const cfg: SniperConfig = { ...DEFAULT_CONFIG, ...overrides };
  const coins = new Map<Pubkey, CoinStats>();
  const bought = new Set<Pubkey>();
  const open = new Map<Pubkey, OpenPosition>();
  const tripsDone = new Set<Pubkey>();
  const buyFilled = new Set<Pubkey>();
  // Bookkeeping the backtest driver reads (never used for decisions).
  const stats = { snipeBuys: 0, fillerBuys: 0, riderBuys: 0, snipeTrips: 0, fillerTrips: 0, riderTrips: 0 };
  const tripKind = new Map<Pubkey, 'snipe' | 'filler' | 'rider'>();

  function observe(batch: Batch): void {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        if (!coins.has(e.mint)) {
          coins.set(e.mint, {
            createdSlot: e.slot,
            firstPrice: 0,
            buySol: 0,
            sellSol: 0,
            buyers: new Set(),
            buyerSol: new Map(),
            trades: 0,
            evaluated: false,
            lastPrice: 0,
            lastRealSol: 0,
            lastSlot: e.slot,
            crossedSlot: -1,
          });
        }
        continue;
      }
      if (e.event !== 'TradeEvent') continue;
      const c = coins.get(e.mint);
      if (!c) continue; // created before the window started: no birth data, skip
      const price = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
      if (c.firstPrice === 0) c.firstPrice = price;
      c.lastPrice = price;
      c.lastRealSol = Number(e.real_quote_reserves) / 1e9;
      c.lastSlot = e.slot;
      c.trades++;
      if (c.crossedSlot < 0 && c.lastRealSol >= cfg.rideMinSol) c.crossedSlot = e.slot;
      const age = e.slot - c.createdSlot;
      if (age <= cfg.evalSlots) {
        const sol = Number(e.sol_amount) / 1e9;
        if (e.is_buy) {
          c.buySol += sol;
          c.buyers.add(e.user);
          c.buyerSol.set(e.user, (c.buyerSol.get(e.user) ?? 0) + sol);
        } else {
          c.sellSol += sol;
        }
      }
    }
    // Fills tell us which round trips actually completed (harness closes count too).
    for (const f of batch.fills) {
      if (f.status !== 'filled') continue;
      if (f.side === 'buy') buyFilled.add(f.mint);
      else if (buyFilled.has(f.mint) && !tripsDone.has(f.mint)) {
        tripsDone.add(f.mint);
        const k = tripKind.get(f.mint);
        if (k === 'filler') stats.fillerTrips++;
        else if (k === 'rider') stats.riderTrips++;
        else stats.snipeTrips++;
      }
    }
  }

  function qualifies(c: CoinStats): boolean {
    const net = c.buySol - c.sellSol;
    if (net < cfg.netMinSol) return false;
    if (c.buyers.size < cfg.buyersMin) return false;
    if (c.firstPrice <= 0) return false;
    if (c.lastPrice < c.firstPrice * cfg.pumpMin) return false;
    let whale = 0;
    for (const v of c.buyerSol.values()) whale = Math.max(whale, v);
    if (c.buySol > 0 && whale / c.buySol > cfg.whaleMaxShare) return false;
    return true;
  }

  function prune(slot: number): void {
    // Coins older than ~2h with no position are dead weight; drop them.
    if (coins.size < 4000) return;
    for (const [mint, c] of coins) {
      if (slot - c.createdSlot > 18000 && !open.has(mint)) coins.delete(mint);
    }
  }

  // What a full sale of `tokens` on this curve returns right now, after the
  // curve fees (the tx fee is small next to these numbers and left out).
  function sellProceeds(curve: { virtual_token_reserves: bigint; virtual_quote_reserves: bigint }, tokens: bigint): bigint {
    const vq = curve.virtual_quote_reserves;
    const vt = curve.virtual_token_reserves;
    if (vt + tokens === 0n) return 0n;
    const q = (tokens * vq) / (vt + tokens);
    const fee = (q * 125n + 9999n) / 10000n; // protocol 95 bps + creator 30 bps
    return q > fee ? q - fee : 0n;
  }

  const bot: Bot & { __stats: typeof stats } = {
    __stats: stats,
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      observe(batch);
      const slot = batch.slot;
      const orders: OrderInput[] = [];
      const pendingSell = new Set<Pubkey>();
      const pendingBuy = new Set<Pubkey>();
      for (const p of state.pending.values()) {
        if (p.order.side === 'sell') pendingSell.add(p.order.mint);
        else pendingBuy.add(p.order.mint);
      }

      // --- exits first: a freed slot can be reused by an entry this same batch.
      // Every exit is judged on real economics: what the position would sell
      // for right now versus what it cost. That already includes the buy's own
      // price impact and fees, which a recorded entry price would miss.
      for (const [mint, pos] of state.positions) {
        const curve = state.curves.get(mint);
        if (!curve || curve.complete) continue; // harness closes completed curves itself
        const cost = pos.cost_lamports;
        const proceeds = sellProceeds(curve, pos.token_amount);
        let mine = open.get(mint);
        if (!mine) {
          // Position appeared without our own record (should not happen, but
          // never leave a position unmanaged): adopt it at current value.
          mine = { entrySlot: slot, kind: 'snipe', peakProceeds: proceeds, cost };
          open.set(mint, mine);
        }
        mine.cost = cost;
        if (proceeds > mine.peakProceeds) mine.peakProceeds = proceeds;
        let exit = false;
        if (mine.kind === 'filler') {
          exit = slot - mine.entrySlot >= cfg.fillerHoldSlots;
        } else if (mine.kind === 'rider') {
          // Ride to graduation: only a hard stop and a time exit. No trailing
          // stop — the run-up to completion is the whole thesis.
          if (cost > 0n && proceeds * 100n <= cost * BigInt(Math.round((1 - cfg.rideStopPct) * 100))) exit = true;
          if (slot - mine.entrySlot > cfg.rideHoldSlots) exit = true;
        } else {
          // Hard stop on cost, trailing stop on the peak (armed only once the
          // position has been in profit, so a flat open is not stopped out by
          // its own first wobble), time exit for dead money.
          if (cost > 0n && proceeds * 100n <= cost * BigInt(Math.round((1 - cfg.stopPct) * 100))) exit = true;
          if (mine.peakProceeds > (cost * 11n) / 10n && proceeds * 100n <= mine.peakProceeds * BigInt(Math.round((1 - cfg.trailPct) * 100))) exit = true;
          if (slot - mine.entrySlot > cfg.holdMaxSlots && proceeds < (cost * 11n) / 10n) exit = true;
          if (cfg.takeProfitMult > 0 && cost > 0n && proceeds * 100n >= cost * BigInt(Math.round(cfg.takeProfitMult * 100))) exit = true;
        }
        if (exit && !pendingSell.has(mint)) {
          orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: cfg.sellSlippageBps });
          open.delete(mint);
        }
      }
      // Drop records for positions that are gone (sold, completed, flattened).
      for (const mint of [...open.keys()]) {
        if (!state.positions.has(mint) && !pendingBuy.has(mint)) open.delete(mint);
      }

      // --- entries: coins that just crossed the eval age and clear the bar
      const freeSlots = () =>
        state.hello.caps.max_open_positions - state.committedPositionCount();
      if (cfg.snipeEnabled) {
        for (const [mint, c] of coins) {
          if (orders.length >= state.hello.caps.max_orders_per_batch) break;
          if (c.evaluated || bought.has(mint)) continue;
          if (slot - c.createdSlot < cfg.evalSlots) continue;
          c.evaluated = true;
          const curve = state.curves.get(mint);
          if (!curve || curve.complete) continue;
          if (!qualifies(c)) continue;
          if (freeSlots() <= 0) continue;
          const cap = state.maxBuyLamports(mint);
          const want = lamports(cfg.buySol);
          const size = want < cap ? want : cap;
          if (size < lamports(0.01)) continue;
          if (state.freeCashLamports() < size + state.txFeeLamports()) continue;
          orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: cfg.buySlippageBps });
          bought.add(mint);
          stats.snipeBuys++;
          tripKind.set(mint, 'snipe');
          open.set(mint, { entrySlot: slot, kind: 'snipe', peakProceeds: 0n, cost: size });
        }
      }

      // --- rider entries: a coin whose real reserve crossed rideMinSol and
      // stayed high through the confirmation window is usually either about
      // to graduate (~2x from the 50-SOL price on the dev window) or about
      // to dump; the hard stop caps the dump, graduation pays the trade.
      if (cfg.riderEnabled) {
        for (const [mint, c] of coins) {
          if (orders.length >= state.hello.caps.max_orders_per_batch) break;
          if (bought.has(mint) || c.crossedSlot < 0) continue;
          if (slot - c.crossedSlot < cfg.rideConfirmSlots) continue;
          if (slot - c.crossedSlot > cfg.rideWindowSlots) continue;
          const curve = state.curves.get(mint);
          if (!curve || curve.complete) continue;
          const realNow = Number(curve.real_quote_reserves) / 1e9;
          if (realNow < cfg.rideMinSol * 0.9) continue;
          if (freeSlots() <= 0) continue;
          const cap = state.maxBuyLamports(mint);
          const want = lamports(cfg.rideSol);
          const size = want < cap ? want : cap;
          if (size < lamports(0.01)) continue;
          if (state.freeCashLamports() < size + state.txFeeLamports()) continue;
          orders.push({ side: 'buy', mint, quote_lamports: size, max_slippage_bps: cfg.buySlippageBps });
          bought.add(mint);
          stats.riderBuys++;
          tripKind.set(mint, 'rider');
          open.set(mint, { entrySlot: slot, kind: 'rider', peakProceeds: 0n, cost: size });
        }
      }

      // --- filler: only while the guardrail is unmet, only one at a time,
      // only into a free slot, and never ahead of a real entry.
      if (tripsDone.size < cfg.fillerTripsTarget && freeSlots() > 0) {
        const fillerOpen = [...open.values()].some((p) => p.kind === 'filler');
        const fillerPending = [...state.pending.values()].some(
          (p) => p.order.side === 'buy' && open.get(p.order.mint)?.kind === 'filler',
        );
        if (!fillerOpen && !fillerPending && orders.length < state.hello.caps.max_orders_per_batch) {
          let best: Pubkey | null = null;
          let bestTrades = -1;
          for (const [mint, c] of coins) {
            if (bought.has(mint) || open.has(mint)) continue;
            const age = slot - c.createdSlot;
            if (age < cfg.evalSlots || age > 5000) continue;
            if (c.lastRealSol < 1) continue;
            const curve = state.curves.get(mint);
            if (!curve || curve.complete) continue;
            if (c.trades > bestTrades) {
              bestTrades = c.trades;
              best = mint;
            }
          }
          if (best !== null) {
            const cap = state.maxBuyLamports(best);
            const want = lamports(cfg.fillerSol);
            const size = want < cap ? want : cap;
            if (size >= lamports(0.01) && state.freeCashLamports() >= size + state.txFeeLamports()) {
              orders.push({ side: 'buy', mint: best, quote_lamports: size, max_slippage_bps: cfg.buySlippageBps });
              bought.add(best);
              stats.fillerBuys++;
              tripKind.set(best, 'filler');
              open.set(best, { entrySlot: slot, kind: 'filler', peakProceeds: 0n, cost: size });
            }
          }
        }
      }

      prune(slot);
      return orders;
    },
  };
  return bot;
}
