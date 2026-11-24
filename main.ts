// Pump.fun Paper Sprint entry: an early-flow sniper.
//
// The bot watches every new coin's first minutes, buys only the few whose
// early buying is broad and strong, and rides them with a trailing stop.
// See strategy.ts for the full design and the dev-window numbers behind it.
//
// Wired to the replay protocol through the kit's SDK shim: the harness sends
// a hello, then one batch per slot, and this bot answers each batch with its
// The bot answers each batch with its orders: buys on coins whose early
// flow cleared the bar, sells when a stop, a take-profit, or the clock says
// so, and nothing at all on batches where every coin is still being watched.
// A quiet batch is a decision too — most coins are not worth a trade.

import { runBot } from './vendor/makefun-bot.ts';
import { createBot } from './strategy.ts';

await runBot(createBot());
