# Moon Sweepers — Custom Bits Power-ups

Canonical list for the Moon Sweepers Twitch integration. **This file is the source of
truth** for the bot's `!powerups` menu and the on-site list — update it here first.

## Why these are created by hand

Twitch exposes **no API to create, enable, or disable custom Power-ups** — third-party
apps can only *read* available Power-ups and *receive* redemption events
(`channel.bits.use` → `custom_power_up`). Management is "under consideration" with no
timeline. There is also no native way to gate Power-ups by category.

So: create these **once, by hand, in the Creator Dashboard**. They stay buyable in every
category. The bot can't switch them on or off — it can only *announce* when they're
relevant (see "What the bot does" below).

## Title matching — the thing that breaks it

Each title must match `PowerUpMappings` in the mod's config.
**Capitals don't matter. Spaces and punctuation DO.** Copy the titles exactly —
note the hyphen in `Shrink-Flation`, the capital T in `Spill The Dust`, and that the
gravity ones are `2x` / `4x` / `8x` (lowercase x, no space).

## The 21 Power-ups

| # | Title (copy exactly) | Bits | Effect |
|---|---|---|---|
| 1 | `Lights Out` | 250 | Everyone's helmet lamp switches off and stays off for 15 minutes. |
| 2 | `Half Reach` | 500 | Everyone's reach for picking up dust canisters is cut in half for 10 minutes. |
| 3 | `Refill a Sector` | 500 | A random sector the crew already cleared fills back up with dust. |
| 4 | `2x Gravity` | 750 | Gravity doubles for 15 min: falling twice as strong; running, jumping and vehicles at half speed. Buying it again restarts the timer. **Does nothing while 4x or 8x Gravity is running.** |
| 5 | `Spill The Dust` | 1,000 | Everyone drops all the dust they're carrying, scattered on the ground as 1 kg canisters to pick back up. |
| 6 | `Fisheye Filter` | 1,000 | Everyone's field of view widens to 140° for 15 minutes. |
| 7 | `Tunnel Vision` | 1,000 | Everyone's field of view narrows to 30° for 15 minutes. |
| 8 | `Moon Fog` | 1,000 | A grey fog rolls in for 10 minutes, cutting visibility to about 35 m. |
| 9 | `Tiny Pockets` | 1,250 | Everyone can carry only half as much dust, on foot and in vehicles, for 15 minutes. Dust already carried is kept. |
| 10 | `4x Gravity` | 1,500 | Gravity 4x stronger for 15 min: running, jumping and vehicles at quarter speed. Replaces 2x and restarts the timer. **Does nothing while 8x Gravity is running.** |
| 11 | `Potato Mode` | 1,500 | The game renders at a quarter of its resolution for 15 minutes. |
| 12 | `Roomba Shutdown` | 2,000 | Every Roomba switches off and heads back to its dock until someone switches it back on. |
| 13 | `Back to Square One` | 2,500 | Everyone's brush is swapped for the starter toothbrush for 15 minutes, then given back. |
| 14 | `Australian Moon` | 2,500 | Everyone's view turns upside down for 10 minutes. The HUD stays upright. |
| 15 | `8x Gravity` | 3,000 | Gravity 8x stronger for 15 min: running, jumping and vehicles at an eighth speed. Replaces any weaker gravity and restarts the timer. |
| 16 | `JOONAS Shutdown` | 3,000 | J.O.O.N.A.S. switches off. Someone has to find it and switch it back on. |
| 17 | `Shrink-Flation` | 3,000 | Pay for every kg of dust and every finished sector is cut in half for 30 minutes. |
| 18 | `Inverted Controls` | 3,000 | Movement and camera controls are reversed for 10 minutes. |
| 19 | `Vehicle Breakdown` | 5,000 | Everyone is thrown out of their vehicle and can't get back in for 15 minutes. |
| 20 | `Mercy` | 5,000 | Ends every active timed effect right away. |
| 21 | `Bankruptcy` | 10,000 | The crew's shared money drains to $0. |

### Titles only, for fast copy-paste

```
Lights Out
Half Reach
Refill a Sector
2x Gravity
Spill The Dust
Fisheye Filter
Tunnel Vision
Moon Fog
Tiny Pockets
4x Gravity
Potato Mode
Roomba Shutdown
Back to Square One
Australian Moon
8x Gravity
JOONAS Shutdown
Shrink-Flation
Inverted Controls
Vehicle Breakdown
Mercy
Bankruptcy
```

## Gravity descriptions — paste these into the dashboard

The stacking rule is baked into the three gravity descriptions above so it's visible
**at the point of purchase**, not just in chat. A mistimed `2x` is 750 Bits wasted, so
it has to be readable on the buy screen. Plain text, no markdown — paste as-is:

**2x Gravity (750)**
```
Gravity doubles for 15 min: falling twice as strong; running, jumping and vehicles at half speed. Buying it again restarts the timer. Does nothing while 4x or 8x Gravity is running.
```

**4x Gravity (1,500)**
```
Gravity 4x stronger for 15 min: running, jumping and vehicles at quarter speed. Replaces 2x and restarts the timer. Does nothing while 8x Gravity is running.
```

**8x Gravity (3,000)**
```
Gravity 8x stronger for 15 min: running, jumping and vehicles at an eighth speed. Replaces any weaker gravity and restarts the timer.
```

Each is kept under ~200 characters in case the dashboard truncates long descriptions —
if yours allows more, the fuller wording from the table is fine. The **warning sits at
the end** of 2x and 4x deliberately: it's the last thing read before buying.

## Behaviour notes (worth telling chat)

- **Gravity stacks by strength, not by order.** A stronger gravity Power-up replaces a
  weaker one and restarts the 15 minutes; the same one again restarts the timer. A
  *weaker* one bought while a stronger one is running **does nothing** — so viewers
  should know before spending Bits on it. (This is now in the descriptions themselves.)
- `Roomba Shutdown` and `JOONAS Shutdown` are **untested** in a save with robots.
- Effects hit **every player in the lobby** who runs the mod, not just the broadcaster.

## What the bot does

The bot cannot enable/disable these. It provides a *soft* gate off the category:

- `channel.update` → when the category becomes **Moon Sweepers**, announce in chat that
  the Power-ups are live; when it leaves, announce they're closed so nobody wastes Bits.
- `!powerups` — posts whether they're currently live plus a link to the on-site list.
- Current category comes from `getStreamCategory(env)` in `functions/api/channel-update.js`
  (stored under the `stream_category` key).
