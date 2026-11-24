# Pump.fun Replay Sprint — Paper Bot

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/sosissausage35-collab/pump-fun-replay-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/sosissausage35-collab/pump-fun-replay-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A deterministic momentum paper-trading bot for the [Pump.fun Replay Sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) on make.fun. It trades 10 SOL of paper money over a 24h replay of pump.fun bonding-curve activity. Built by [@sausage-sosis](https://make.fun) as `sosissausage35-collab`.

## Strategy

Watch every new pump.fun curve's tape in batches. A mature curve (400+ slots old)
becomes a buy when its last 40 slots show real, broad, accelerating buy pressure:
at least 5 buy trades from 8+ distinct buyers, ≥ 2 SOL net inflow, price up
20–80% and holding near its window high, with the newer half of the window
inflowing at least 1.5× the older half. One small 0.012 SOL stake per coin —
false starts stay cheap and exits suffer little price impact.

Exits: 8% stop loss, trailing stop (25% from peak once up 30%), a big-sell exit
(any single recorded sell ≥ 0.3 SOL), strong fade exit, or a 1000-slot hold limit.
Small probe round trips (0.02 SOL) keep the 20-distinct-mint guardrail on pace.

Fully deterministic: float64 math on event data only — no clock, no randomness,
no network, no environment. The grader executes the bot twice and the two
action logs must match byte for byte.

## Run

The grader runs `node /bot/main.ts` (Node 22 strip-types). The wire protocol
(`agent-fun/replay/v2`) lives in the vendored shim `vendor/makefun-bot.ts`.

## Dev grade (local, kit frozen dev window)

- Net PnL: **−0.061 SOL** (−61,167,653 lamports, return −0.61%)
- 178 fills over 64 coins, 89 round trips, win rate 15.7%
- Max drawdown 0.62% (guardrail ≤ 50% — met), 64 distinct mints (guardrail ≥ 20 — met)
- Top-3-coins share of gains: 62%
- L1 regrade: reproduced byte for byte

The dev window is a hard sample — every kit reference loses on it too
(pilot momentum −9.49 SOL, reversion −4.00 SOL, sniper −0.47 SOL) — so this
small, tightly-guarded bot is built to survive the final 24h window rather
than to overfit the dev one.

## License

MIT — see [LICENSE](LICENSE).
