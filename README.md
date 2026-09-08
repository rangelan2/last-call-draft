# Last Call — fantasy draft guide

A draft board that scores every player under your own league's rules, then ranks
them against the expert consensus. Runs entirely in the browser: no accounts, no
server, nothing uploaded. Settings and picks are saved on your device only.

**Use it:** https://rangelan2.github.io/last-call-draft/

Paste a Sleeper league ID to pull your scoring, roster and live picks, or set the
league up by hand for ESPN, Yahoo, or anywhere else.

Projections are from Sleeper and ESPN; the consensus rankings are from FantasyPros.
Data is a snapshot, not a live feed.

## GSB High Stakes board

`gsb/` is a preconfigured board for the GSB High Stakes league (12 team, half PPR,
pick 3, 1QB/2RB/2WR/TE/FLEX/K/DST, 7 bench, 2 IR), at
https://rangelan2.github.io/last-call-draft/gsb/

It differs from the general board in two ways. The draft policy is enforced rather
than displayed: a player who breaks a rule is never recommended, whatever his
numbers say. And marking picks is name-first, because the person running the draft
should not need to know what position anyone plays.

Policy lives at the top of `gsb/app.js` in `RULES`:

- `eliteTE` / `eliteQB` — the only names exempt from the positional holds
- `qbHoldUntilRound` — no QB before this unless an elite one falls `eliteFallBy` picks
- `teStreamRound` — a non-elite TE is a commodity until here
- `maxQB` / `maxTE` — hard caps; `maxTE` lifts to 2 only when both are elite
- `alsoOut` — players known to be unavailable that the data still lists as healthy

`alsoOut` exists because Sleeper reports both Isiah Pacheco and Josh Jacobs as
merely Questionable. Jacobs is caught automatically by the ADP-to-consensus gap
(47 to 155); Pacheco is not, because the market already repriced him, so there is
no divergence left to detect. Edit that list as news changes.

## Survivor auction board

`survivor/` is for the 19-team Survivor League auction, at
https://rangelan2.github.io/last-call-draft/survivor/

Format: 19 teams, $200 auction, half PPR, 12 roster spots of which ELEVEN start and
exactly one is a bench. Each week the lowest scorer in the league is eliminated
outright, so there are no matchups and a single bad week ends the season.

Two things follow from that and drive the whole board.

**Prices, not ranks.** Value over replacement is converted to dollars by giving each
player the share of the league's spendable money that his value above a floor
represents. Only value beyond `vorFloor` (35 points over replacement) earns money,
which is what makes the curve steep at the top and flat at the bottom. It was fitted
to two anchors from experience: about $105 at the top and high 60s for the Saquon
tier. An earlier version priced a fixed top 70 and left every quarterback but Josh
Allen at $1, which was an artifact of the cutoff rather than real value.

**A missed week is not a discount, it is a way to lose.** With one bench spot and
weekly elimination, a player who sits even once is a week you can be eliminated.
Anyone expected to miss time is priced at 30% of value and anyone carrying an injury
tag at 82%, both shown as a struck-through healthy price so the haircut is visible.
Those factors are `CONFIG.discount` at the top of `survivor/app.js`.

Replacement is very deep here: 47 running backs and 75 receivers start league-wide
once the flex slots fill, which is why players nobody has heard of still carry value.

The board tracks budget, spots left, and the most you can bid without stranding a
roster spot, and reprices everything left if the room is paying over or under.
