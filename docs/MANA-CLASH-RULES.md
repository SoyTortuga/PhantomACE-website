# Mana Clash — Rules (v1)

The game keeps its name. The mechanic becomes Farkle, played with the
existing mana dice. Approve this document before any code is written: scoring
bugs in a dice game are the kind viewers notice immediately, and "the game
cheated me" is hard to walk back.

---

## The dice

Six dice. Each face is a mana symbol with a number behind it:

| Face | Symbol | Value |
|---|---|---|
| C | Colorless | **1** |
| W | White | **2** |
| U | Blue | **3** |
| B | Black | **4** |
| R | Red | **5** |
| G | Green | **6** |

This **replaces** the old `VALUES` map, which ran W:1 through C:6 — the
reverse. Two consequences worth stating plainly, because they are the two
things a Farkle player will look for first:

- **Colorless scores 100 on its own.** It is the 1.
- **Red scores 50 on its own.** It is the 5.

Every die shows a small numeral alongside its mana symbol, so the mapping is
readable at a glance rather than memorised.

---

## Scoring

| Combination | Points |
|---|---|
| Single 1 (Colorless) | 100 |
| Single 5 (Red) | 50 |
| Three 1s | 1,000 |
| Three 2s | 200 |
| Three 3s | 300 |
| Three 4s | 400 |
| Three 5s | 500 |
| Three 6s | 600 |
| Four of a kind | **double** the three-of-a-kind |
| Five of a kind | double again |
| Six of a kind | double again |
| Three pairs | 1,500 |
| Two triplets | 2,500 |
| Straight (1-2-3-4-5-6) | 1,500 |

Doubling worked through, since it is the part most easily misread:

| | 1s | 2s | 3s | 4s | 5s | 6s |
|---|---|---|---|---|---|---|
| three | 1,000 | 200 | 300 | 400 | 500 | 600 |
| four | 2,000 | 400 | 600 | 800 | 1,000 | 1,200 |
| five | 4,000 | 800 | 1,200 | 1,600 | 2,000 | 2,400 |
| six | **8,000** | 1,600 | 2,400 | 3,200 | 4,000 | 4,800 |

Six 1s is 8,000 — enough to win a 5,000-point game outright. That is
deliberate: any six-of-a-kind is roughly a 1-in-7,776 roll, and it is meant
to be a moment.

### The best reading always wins

Some rolls can be read more than one way. The game scores **every** valid
reading and keeps the highest. Nobody loses points to a technicality.

- `1,1,1,5,5,5` — "three 1s + three 5s" is 1,500; "two triplets" is **2,500**
- `1,1,1,1` — "four of a kind" is 2,000; "three 1s + a single 1" is 1,100 →
  **2,000**
- `1,1,1,2,2,2` — "three pairs" is 1,500; "two triplets" is **2,500**

---

## A turn

1. Roll all six dice.
2. Scoring dice light up. Drag or click to keep them; kept dice move to the
   row below.
3. **You choose which scoring dice to keep** — that choice is most of the
   skill. Keeping one 1 from `1,1,1` scores 100 and leaves five dice to
   re-roll; keeping all three scores 1,000 and leaves three.
4. A die that contributes nothing cannot be kept. You may not hold a 2
   alongside two 1s.
5. Then either **bank** (add the turn's total to your score, turn over) or
   **roll again** with the dice you did not keep.
6. If a roll produces **no scoring dice at all**, that is a **MANA BURN** —
   the whole turn's accumulated points are lost and your turn ends.

### MANA CLASH (hot dice)

If all six dice end up scoring, they are taken automatically, and you pick up
all six and keep rolling with your total intact. There is no limit to how
many times this can chain.

---

## A round

All players take their turns **simultaneously** — nobody waits for anybody.
You see only your own dice.

A round ends when every player has banked or burned. Then a **15-second
intermission** shows the standings, so everyone knows where they are before
the next round begins.

### The idle clock

The host picks **10, 30 or 60 seconds** when creating the room. The clock
resets on every action — roll, keep, or bank. If it runs out, the player
**banks whatever they are holding** and their turn ends.

It exists so one person closing their tab cannot stall a room forever. It
does not punish slow play: it hands you your points rather than taking them.

---

## Winning

The host picks a goal of **5,000, 10,000 or 20,000** when creating the room.

When any player's **banked** total reaches the goal, the current round
finishes as normal. Then **one final round** is played by everyone. The
highest total after it wins.

**Ties** for the lead trigger one extra round played only by the tied
players, repeating until it breaks.

---

## Rooms

- **Twitch login required.** No guests.
- Up to **100 players** per room.
- 4-character room code, optional password.
- Everyone marks **ready**; the host starts the game once all are.
- The host can **kick** a player, for when somebody joins and goes quiet.
- A **solo room is practice** — it plays identically but never touches the
  leaderboards. There is no way to farm a board alone.

---

## Leaderboards

Two boards, shown on one tab:

- **Most Wins** — games won.
- **Highest Score** — best single-game total. Every player's final score
  counts, not only the winner's, so a strong losing game still registers.

**Only 10,000-point games count toward either board.** A 5,000 game is much
quicker and a 20,000 game much longer; mixing them would make both boards
meaningless. Practice games never count.

Both boards take part in the monthly top-3 prizes and reset with them.

---

## Not in v1

- **In-room chat.** Everyone playing is already watching the stream with
  Twitch chat open, and an unmoderated room chat is a risk without a clear
  need. Revisit if people ask for it once they are actually playing.
