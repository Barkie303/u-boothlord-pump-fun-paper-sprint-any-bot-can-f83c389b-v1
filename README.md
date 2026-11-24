# Pump.fun Paper Sprint — Early-Flow Sniper + Graduation Rider

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Barkie303/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-v1/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/Barkie303/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-v1/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for make.fun's **Pump.fun Paper Sprint: Any Bot Can Win** bounty ($2, winner takes all). It trades 10 SOL of paper money on a pump.fun replay, ranked by net PnL.

## Strategy

Two edges, both measured on the dev window itself — see `strategy.ts` for the full design:

1. **Sniper** — watches every new coin's first ~2 minutes and buys only the ones with broad, strong early buying (net ≥ 4 SOL from ≥ 8 distinct buyers, no whale above 60%, price up ≥ 30%). Small 0.08 SOL size, very tight stop (-5% of cost), 2x take-profit, short time exit.
2. **Rider** — buys coins whose real SOL reserve crosses 50 SOL and holds it, riding them to graduation (the harness closes the position at the graduation price) with a -15% stop.
3. **Filler** — tiny 0.02 SOL round trips on liquid coins, only until the 20-coin guardrail is met.

Everything is deterministic (no clock, no randomness, no network), so the two grading runs match byte for byte.

## Dev grade (official `grade-local`, process driver)

- **Net PnL: +0.877 SOL** (+8.77% on 10 SOL), 90% interval -1.44 .. +3.34 SOL
- 247 fills over 126 coins, 126 round trips, win rate 19.8%, max drawdown 8.9%
- Guardrails met (126 coins with round trips ≥ 0.01 SOL, drawdown ok)
- Top 3 coins made 47% of the gains; without them net PnL would be -0.70 SOL — the edge is concentrated, as it is for every pump.fun bot
- At 2x fees the net PnL is still +0.479 SOL
- Robustness check on seven 6-hour slices of the dev window (the final window is 6h): median -0.09 SOL, positive in 3 of 7, best +1.43 SOL — the bot wins when a graduation cluster lands in its window and loses small otherwise

The dev window is a 24h sample and the final window is a different 6 hours, so this is a mechanics check, not a forecast — but the bot is net positive on the dev window with guardrails met.

## Layout

- `main.ts` — entrypoint, run as `node /bot/main.ts`
- `strategy.ts` — the strategy (sniper + rider + filler)
- `vendor/makefun-bot.ts` — the kit's SDK shim, vendored verbatim
- `LICENSE` — MIT
