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
