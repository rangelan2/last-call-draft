/* GSB High Stakes draft board.
 *
 * Same value engine as the other boards, with this league's rules baked in and
 * Anthony's draft policy encoded as hard constraints on what gets recommended.
 * Built to be run by someone who does not know which position a player plays.
 */
(function () {
"use strict";

var P = window.PAYLOAD;
var ORDER = ["QB", "RB", "WR", "TE", "K", "DEF"];
var FLEXP = {FLEX:["RB","WR","TE"], SUPER_FLEX:["QB","RB","WR","TE"]};
var KEY = "gsb.highstakes.v1";
var LONG = {QB:"quarterback", RB:"running back", WR:"receiver", TE:"tight end",
            K:"kicker", DEF:"defense"};
// A defense is stored as its nickname ("Broncos") but ESPN shows the city, so a
// search for "denver" found nothing and told her he was already taken.
var CITY = {ARI:"arizona", ATL:"atlanta", BAL:"baltimore", BUF:"buffalo", CAR:"carolina",
  CHI:"chicago", CIN:"cincinnati", CLE:"cleveland", DAL:"dallas", DEN:"denver",
  DET:"detroit", GB:"green bay", HOU:"houston", IND:"indianapolis", JAX:"jacksonville",
  KC:"kansas city", LAC:"los angeles chargers", LAR:"los angeles rams", LV:"las vegas",
  MIA:"miami", MIN:"minnesota", NE:"new england", NO:"new orleans", NYG:"new york giants",
  NYJ:"new york jets", PHI:"philadelphia", PIT:"pittsburgh", SEA:"seattle",
  SF:"san francisco", TB:"tampa bay", TEN:"tennessee", WAS:"washington"};
function normTxt(x) {
  return String(x).toLowerCase()
    .replace(/[.'\u2019`]/g, "")          // Ja'Marr -> jamarr, A.J. -> aj
    .replace(/[-\/]/g, " ")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "")
    .replace(/\s+/g, " ").trim();
}
function searchText(p) {
  var t = normTxt(p.name);
  if (p.pos === "DEF" && CITY[p.team]) t += " " + CITY[p.team] + " defense dst d st";
  return t + " " + (p.team || "").toLowerCase();
}

var CONFIG = {
  name: "GSB High Stakes",  // ESPN league
  teams: 12, slot: 3, rounds: 16, budget: 200, fmt: "HALF",
  label: "12 team, half PPR, pick 3",
  roster: ["QB","RB","RB","WR","WR","TE","FLEX","K","DEF",
           "BN","BN","BN","BN","BN","BN","BN"],
  irSlots: 2,
  scoring: {pass_yd:0.04, pass_td:4, pass_int:-2, pass_2pt:2,
            rush_yd:0.1, rush_td:6, rush_2pt:2,
            rec:0.5, rec_yd:0.1, rec_td:6, rec_2pt:2, fum_lost:-2}
};

// Anthony's policy. These are constraints, not suggestions: a player who fails
// one is never recommended, however good the numbers look.
var RULES = {
  eliteTE: ["Brock Bowers", "Trey McBride", "Colston Loveland", "Tyler Warren"],
  eliteQB: ["Josh Allen", "Lamar Jackson", "Drake Maye"],
  qbHoldUntilRound: 8,   // no quarterback before here unless an elite one falls
  eliteFallBy: 12,       // "way below ADP" means this many picks past it
  teStreamRound: 12,     // a non-elite tight end is a last-rounds commodity
  maxQB: 2, maxTE: 1,    // one tight end. No exception, elite or not.
  // Players Anthony knows are not playing soon. The data cannot see this: Sleeper
  // still lists both as merely Questionable.
  alsoOut: ["Isiah Pacheco", "Josh Jacobs"]
};

var draft = null, board = null, sel = 0, results = [], pickOffset = 0, lastPickTap = 0;

/* ---------- state ---------- */
function save() {
  try { localStorage.setItem(KEY, JSON.stringify({
    d: Array.from(draft.drafted), m: Array.from(draft.mine), o: draft.order, off: pickOffset
  })); } catch (e) {}
}
function restore() {
  var d = {d:[], m:[], o:[]};
  try { var raw = localStorage.getItem(KEY); if (raw) d = JSON.parse(raw); } catch (e) {}
  draft = {drafted: new Set(d.d || []), mine: new Set(d.m || []), order: d.o || []};
  pickOffset = d.off || 0;
}

/* ---------- engine ---------- */
function scoreOf(stats, scoring, pos) {
  var pts = 0;
  for (var k in stats) { var w = scoring[k]; if (w) pts += stats[k] * w; }
  var b = scoring["bonus_rec_" + pos.toLowerCase()];
  if (b && stats.rec) pts += stats.rec * b;
  return pts;
}
function parseRoster(rp) {
  var ded = {}, flex = [];
  rp.forEach(function (s) {
    if (s === "BN" || s === "IR") return;
    if (FLEXP[s]) flex.push(s); else ded[s] = (ded[s] || 0) + 1;
  });
  return {ded: ded, flex: flex};
}
function replacement(players, teams, ded, flex) {
  var byPos = {};
  players.forEach(function (p) { (byPos[p.pos] = byPos[p.pos] || []).push(p); });
  for (var k in byPos) byPos[k].sort(function (a, b) { return b.pts - a.pts; });
  var counts = {};
  for (var pos in ded) counts[pos] = teams * ded[pos];
  flex.forEach(function (slot) {
    for (var i = 0; i < teams; i++) {
      var best = null, bp = null;
      FLEXP[slot].forEach(function (ps) {
        var pool = byPos[ps] || [], at = counts[ps] || 0;
        if (at < pool.length && (!best || pool[at].pts > best.pts)) { best = pool[at]; bp = ps; }
      });
      if (bp) counts[bp] = (counts[bp] || 0) + 1;
    }
  });
  var repl = {};
  for (var pz in byPos) {
    var pool = byPos[pz], idx = counts[pz] || 0;
    var band = pool.slice(Math.max(0, idx - 1), Math.min(pool.length, idx + 2));
    if (!band.length) band = [pool[pool.length - 1]];
    repl[pz] = band.reduce(function (t, x) { return t + x.pts; }, 0) / band.length;
  }
  return {repl: repl, counts: counts};
}
function tierize(pool, depth, field, out, maxTiers) {
  maxTiers = maxTiers || 10;
  if (!pool.length) return;
  pool.sort(function (a, b) { return b[field] - a[field]; });
  var core = pool.slice(0, Math.max(depth, 2)), rest = pool.slice(core.length), gaps = [];
  for (var i = 0; i < core.length - 1; i++) gaps.push(core[i][field] - core[i + 1][field]);
  var wall = Infinity;
  if (gaps.length) {
    var k = Math.min(maxTiers - 1, gaps.length);
    wall = k > 0 ? gaps.slice().sort(function (a, b) { return b - a; })[k - 1] : Infinity;
  }
  var t = 1;
  core[0][out] = 1;
  for (var j = 0; j < gaps.length; j++) {
    if (gaps[j] >= wall && t < maxTiers) t++;
    core[j + 1][out] = t;
  }
  rest.forEach(function (p) { p[out] = Math.min(t + 1, maxTiers + 1); });
}
function build() {
  var pr = parseRoster(CONFIG.roster), active = {};
  for (var d in pr.ded) if (ORDER.indexOf(d) >= 0) active[d] = 1;
  pr.flex.forEach(function (s) { FLEXP[s].forEach(function (p) { active[p] = 1; }); });
  var fmt = CONFIG.fmt, players = [];

  P.pl.forEach(function (raw) {
    if (!active[raw.p]) return;
    var pos = raw.p, pts;
    if (pos === "K" || pos === "DEF") {
      pts = raw.s.pts_std;
      if (pts == null) return;
    } else {
      var a = scoreOf(raw.s, CONFIG.scoring, pos);
      var b = Object.keys(raw.e).length ? scoreOf(raw.e, CONFIG.scoring, pos) : null;
      pts = b == null ? a : (a + b) / 2;
    }
    var e = raw.r[fmt] || null;
    var forcedOut = RULES.alsoOut.indexOf(raw.n) >= 0;
    players.push({
      name: raw.n, pos: pos, team: raw.t, bye: raw.b, sid: raw.id,
      pts: Math.round(pts * 10) / 10,
      // This is an ESPN league, so plan against ESPN's board. Their drafters follow
      // ESPN's own rankings and go materially earlier on QB and TE than mock crowds.
      adp: raw.ea != null ? raw.ea : (raw.a[fmt] != null ? raw.a[fmt] : raw.a.PPR),
      ecr: e ? e[0] : null, ecrBest: e ? e[1] : null, ecrWorst: e ? e[2] : null,
      ecrTierRaw: e ? e[4] : null,
      // Raw ESPN ADP only. build() otherwise substitutes Sleeper ADP for the 74
      // players ESPN has no number for, which is a different scale entirely.
      ea: raw.ea != null ? raw.ea : null,
      // 217 of 365 ESPN ADPs pile into a saturated 160-172 band (152 share the
      // single value 170). Past 160 there is no read, so we say nothing.
      eaOk: raw.ea != null && raw.ea <= 160,
      sdx: e ? e[3] : null,   // FantasyPros stdev of expert rank; already parsed, was discarded
      rookie: raw.k, inj: raw.i,
      avail: forcedOut ? "out" : (raw.av || "ok"),
      irOk: raw.ir === 1 || forcedOut,
      eliteTE: RULES.eliteTE.indexOf(raw.n) >= 0,
      eliteQB: RULES.eliteQB.indexOf(raw.n) >= 0,
      late: pos === "K" || pos === "DEF"
    });
  });

  var rl = replacement(players, CONFIG.teams, pr.ded, pr.flex);
  players.forEach(function (p) { p.vor = Math.round((p.pts - (rl.repl[p.pos] || 0)) * 10) / 10; });

  var ranked = players.filter(function (p) { return p.ecr != null; });
  ranked.slice().sort(function (a, b) { return (a.late - b.late) || (a.ecr - b.ecr); })
        .forEach(function (p, i) { p.ecrRank = i + 1; });
  players.forEach(function (p) { if (p.ecr == null) p.ecrRank = ranked.length + 1; });

  // Consensus translated into this league's points, then blended with projection.
  //
  // Two consensus views, because they answer different questions and a board needs
  // both. The POSITIONAL view ("they call him RB3, so credit him with the value of
  // the third-best RB under these rules") keeps league-specific scoring intact but
  // says nothing about whether an RB3 outranks a WR1. The OVERALL view ("they call
  // him the 7th best player alive, so credit him with the value of the 7th pick on
  // this board") is what actually orders positions against each other. Using only
  // the positional view left cross-position order driven purely by projections,
  // which is how a 30-year-old running back ended up ranked over the consensus WR1.
  var curve = {}, all = [];
  players.forEach(function (p) {
    (curve[p.pos] = curve[p.pos] || []).push(p.vor);
    if (!p.late) all.push(p.vor);
  });
  for (var cp in curve) curve[cp].sort(function (a, b) { return b - a; });
  all.sort(function (a, b) { return b - a; });

  Object.keys(active).forEach(function (pos) {
    var pool = players.filter(function (p) { return p.pos === pos; });
    var rk = pool.filter(function (p) { return p.ecr != null; })
                 .sort(function (a, b) { return a.ecr - b.ecr; });
    rk.forEach(function (p, i) { p.ecrPos = i + 1; });
    var cv = curve[pos], fl = Math.min(rk.length, cv.length - 1);
    pool.forEach(function (p) {
      var pi = p.ecrPos ? Math.min(p.ecrPos - 1, cv.length - 1) : fl;
      var byPos = cv[pi];
      var oi = p.ecrRank ? Math.min(p.ecrRank - 1, all.length - 1) : all.length - 1;
      var byAll = p.late ? byPos : all[oi];
      var consensus = 0.5 * byAll + 0.5 * byPos;
      p.blendVor = 0.6 * consensus + 0.4 * p.vor;
    });
  });

  players.sort(function (a, b) { return (a.late - b.late) || (b.blendVor - a.blendVor); });
  players.forEach(function (p, i) { p.rank = i + 1; });
  Object.keys(active).forEach(function (pos) {
    var pool = players.filter(function (p) { return p.pos === pos; });
    var st = rl.counts[pos] || CONFIG.teams;
    var depth = (pos === "K" || pos === "DEF") ? CONFIG.teams + 8
              : Math.max(Math.round(st * 2.2) + CONFIG.teams, 20);
    tierize(pool, depth, "blendVor", "tier");
  });
  var byPos = {};
  players.forEach(function (p) { (byPos[p.pos] = byPos[p.pos] || []).push(p); });
  for (var q in byPos) byPos[q].forEach(function (p, i) { p.posRank = i + 1; });

  return {players: players, repl: rl.repl, positions: ORDER.filter(function (p) { return active[p]; })};
}

/* ---------- market model ---------- */
//
// How likely is a player to still be on the board at a later pick.
//
// The first version of this used a normal CDF around ADP, conditioned on the player
// being available now. It was wrong in the one case that matters most: for a man who
// has ALREADY outlasted his ADP, both the numerator and the denominator sit 25-plus
// sigma into a Gaussian tail, underflow, and the function returns 0.0%. It told us a
// player who had survived 25 picks past his ADP would certainly not survive five
// more, which is exactly backwards and exactly the "he fell to us" moment this board
// exists to catch. The replacement is a logistic with a small exponential offset, so
// a fallen player keeps real mass, and it is calibrated to the size of the window.

function clampN(x, a, c) { return x < a ? a : x > c ? c : x; }

// Analysts who disagree about a player also draft him over a wider range. The
// FantasyPros stdev of expert rank regresses on ECR as sd = 1.339 + 0.1607*ecr
// (R2 = 0.77), so the ratio is a per-player width multiplier.
// Width comes straight from what Fantasy Football Calculator measured across 1,837
// real 12-team half-PPR drafts: sd = 0.79 + 0.105 * ADP. An earlier version used
// 2.5 + 0.18 * ADP, about 2.5x too wide at the top of the board, which made
// everything look safe to wait on. The per-player multiplier that stood here has
// been dropped: expert-rank disagreement explained about 6% of the variance and
// pointed the wrong way on the elite tight ends.
function sdOf(p) { return Math.max(1.5, 0.79 + 0.105 * p.ea); }

function sCurve(p, x) {
  var s = 0.5513 * sdOf(p);
  var mkt = 1 / (1 + Math.exp((x - p.ea) / s));
  var off = Math.exp(-Math.max(0, x - p.ea) / 55);   // the tail that saves fallen players
  return 0.93 * mkt + 0.07 * off;
}
function keepRaw(p, now, target) {
  if (!p.eaOk) return null;
  var a = sCurve(p, target), b = sCurve(p, now);
  return b > 1e-9 ? clampN(a / b, 0, 1) : 0;
}

// Tilt every probability by a single exponential factor until the expected number of
// departures equals the number of picks that will actually happen. Untilted, the
// model under-predicts departures by 18-36% from the third round on, which is the
// dangerous direction: it says wait, and she loses the player.
function tiltTo(qs, T) {
  function tot(l) {
    var e = Math.exp(l), s = 0;
    for (var i = 0; i < qs.length; i++) { var q = qs[i]; s += q * e / (1 - q + q * e); }
    return s;
  }
  var lo = -8, hi = 8, lam;
  if (tot(lo) >= T) lam = lo;
  else if (tot(hi) <= T) lam = hi;
  else {
    for (var i = 0; i < 40; i++) { var mid = (lo + hi) / 2; if (tot(mid) < T) lo = mid; else hi = mid; }
    lam = (lo + hi) / 2;
  }
  var e = Math.exp(lam);
  return qs.map(function (q) { return clampN(q * e / (1 - q + q * e), 0, 1); });
}

var BYID = {};
// What share of picks are coming out of the pool we can actually model.
function poolShare() {
  var made = draft.order.length;
  if (!made) return 1;
  var n = 0;
  draft.order.forEach(function (sid) { var p = BYID[sid]; if (p && p.eaOk && !p.late) n++; });
  return (n + 8) / (made + 8);
}

// The map every surface reads, so no two panels can disagree. Returns null rather
// than a guess whenever the read is not there.
function keepMap(avail, now, target) {
  if (target <= now) return null;
  var pool = avail.filter(function (p) { return p.eaOk && !p.late; });
  if (pool.length < 25) return null;                       // silence rule
  var others = 0;
  for (var k = now; k < target; k++) if (MY.indexOf(k) < 0) others++;   // her own picks are not a risk
  var T = Math.min(others * poolShare(), pool.length * 0.95);
  var qs = pool.map(function (p) { return 1 - keepRaw(p, now, target); });
  var tq = tiltTo(qs, T);
  var out = {};
  pool.forEach(function (p, i) { out[p.sid] = 1 - tq[i]; });
  return out;
}

// Bands, deliberately pessimistic, and deliberately wordless about the exact number.
//
// Backtested against simulated drafts the model over-predicts survival by 12 to 25
// points through the 30-70% range, which is exactly where the wait-or-take decision
// lives, and it errs in the direction that costs her the player. So the thresholds
// are raised well above their nominal values, and no percentage is printed: the
// ordering is trustworthy, the second decimal is not, and "54%" reads as a precision
// this model has not earned. She needs to know whether to wait, not a number.
function bandOf(k) {
  return k >= 0.90 ? "wait" : k >= 0.74 ? "wait" : k >= 0.55 ? "risk" : "now";
}
function bandWords(k, nextPick) {
  if (k >= 0.90) return "Safe to wait &mdash; he should still be there at your pick " + nextPick;
  if (k >= 0.74) return "Probably still there at your pick " + nextPick;
  if (k >= 0.55) return "Might not last to your pick " + nextPick;
  if (k >= 0.30) return "Likely gone before your pick " + nextPick + " &mdash; take him here if you want him";
  return "He will be gone. This is your last realistic shot at him";
}

/* ---------- helpers ---------- */
function myPicks() {
  var out = [];
  for (var r = 1; r <= CONFIG.rounds; r++) {
    var back = r % 2 === 0;
    out.push((r - 1) * CONFIG.teams + (back ? CONFIG.teams - CONFIG.slot + 1 : CONFIG.slot));
  }
  return out;
}
var MY = myPicks();
// Every round gate and every survival window keys off this. One un-logged pick
// shifts all of them silently, so it has to be correctable by hand in two seconds.
function pickNow() { return Math.max(1, draft.order.length + 1 + pickOffset); }
// Must derive from pickNow(), not from order.length: otherwise correcting the pick
// number moves the survival windows but leaves every policy gate a round behind, and
// the draft can end with an unfilled defense slot.
function roundNow() { return Math.floor((pickNow() - 1) / CONFIG.teams) + 1; }
// How many of HER picks are left, counting this one. Policy gates key off this
// rather than the round, because it is derived from her own roster and an un-logged
// opponent pick cannot corrupt it. Three missed logs used to end the draft with an
// empty defense slot while the ledger still asked for one.
function myPicksLeft() {
  var byRoster = CONFIG.roster.filter(function (x) { return x !== "IR"; }).length
    - lineupCount();
  var byClock = MY.filter(function (x) { return x >= pickNow(); }).length;
  return Math.max(Math.min(byRoster, byClock), byRoster > 0 ? 1 : 0);
}
function lineupCount() { return draft.mine.size; }
function open_() { return board.players.filter(function (p) { return !draft.drafted.has(p.sid); }); }
function mine_() { return board.players.filter(function (p) { return draft.mine.has(p.sid); }); }
function tv(t) { return "var(--t" + Math.min(t || 11, 11) + ")"; }
function esc(s) { return String(s).replace(/[&<>"]/g, function (c) {
  return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]; }); }

function lineup() {
  var mine = mine_().slice().sort(function (a, b) { return a.rank - b.rank; });
  var need = {};
  CONFIG.roster.forEach(function (s) { if (s !== "BN") need[s] = (need[s] || 0) + 1; });
  var byPos = {};
  mine.forEach(function (p) { (byPos[p.pos] = byPos[p.pos] || []).push(p); });
  var used = {}, filled = [];
  Object.keys(need).forEach(function (sl) {
    if (FLEXP[sl]) return;
    for (var i = 0; i < need[sl]; i++) {
      var pool = byPos[sl] || [], at = used[sl] || 0;
      if (pool[at]) { used[sl] = at + 1; filled.push({sl: sl, p: pool[at]}); }
      else filled.push({sl: sl, p: null});
    }
  });
  Object.keys(need).forEach(function (sl) {
    if (!FLEXP[sl]) return;
    for (var i = 0; i < need[sl]; i++) {
      var best = null, bp = null;
      FLEXP[sl].forEach(function (ps) {
        var pool = byPos[ps] || [], at = used[ps] || 0;
        if (pool[at] && (!best || pool[at].rank < best.rank)) { best = pool[at]; bp = ps; }
      });
      if (best) { used[bp] = (used[bp] || 0) + 1; filled.push({sl: sl, p: best}); }
      else filled.push({sl: sl, p: null});
    }
  });
  var starters = {};
  filled.forEach(function (f) { if (f.p) starters[f.p.sid] = 1; });
  var counts = {};
  mine.forEach(function (p) { counts[p.pos] = (counts[p.pos] || 0) + 1; });
  return {mine: mine, filled: filled, counts: counts,
          bench: mine.filter(function (p) { return !starters[p.sid]; })};
}

/* ---------- the policy ---------- */
// Returns null if the player is draftable right now, or a string saying why not.
function blockedReason(p, lu) {
  var round = roundNow(), have = lu.counts, last = CONFIG.rounds;
  if (p.pos === "QB") {
    if ((have.QB || 0) >= RULES.maxQB) return "we already have two quarterbacks";
    if ((have.QB || 0) >= 1 && round < last - 3) return "one quarterback is enough for now";
    if ((have.QB || 0) === 0 && round < RULES.qbHoldUntilRound) {
      var fell = p.adp && (pickNow() - p.adp) >= RULES.eliteFallBy;
      if (!(p.eliteQB && fell)) return "too early for a quarterback";
    }
  }
  // One tight end, full stop. There used to be an exception allowing a second when
  // both were elite, and it was a trap: Bowers and McBride share an ESPN ADP of 24,
  // so in any draft where they reach picks 22 and 27 the board would happily spend
  // both on a position that starts one.
  if (p.pos === "TE") {
    if ((have.TE || 0) >= 1) return "we already have our tight end";
    if (!p.eliteTE && round < RULES.teStreamRound)
      return "not an elite tight end, and those are a late-round commodity";
  }
  if (p.late && myPicksLeft() > 2) return "kickers and defenses come last";
  if (p.avail === "out" && myPicksLeft() > 3) return "he is not playing any time soon";
  return null;
}

function advise() {
  var lu = lineup(), all = open_(), round = roundNow(), last = CONFIG.rounds;

  // At the very end, fill the two mandatory slots nobody wants to spend on early.
  var missingLate = [];
  lu.filled.forEach(function (f) {
    if (!f.p && (f.sl === "K" || f.sl === "DEF")) missingLate.push(f.sl);
  });
  if (myPicksLeft() <= 2 && missingLate.length) {
    return missingLate.map(function (sl) {
      var best = all.filter(function (p) { return p.pos === sl; })[0];
      return best ? {p: best, why: "The draft is almost over and we still need a "
        + LONG[sl] + ". Any of the top few is fine."} : null;
    }).filter(Boolean);
  }

  var gap = {};
  lu.filled.forEach(function (f) {
    if (f.p || f.sl === "K" || f.sl === "DEF") return;
    (FLEXP[f.sl] || [f.sl]).forEach(function (ps) { gap[ps] = (gap[ps] || 0) + 1; });
  });

  var ok = all.filter(function (p) { return !blockedReason(p, lu); });
  if (!ok.length) return [];
  // Scale the roster-need bonus by what a round of players is worth: best available
  // minus the twelfth-best. The old scale was |blendVor| of the best man left, which
  // collapsed to 0.07 around round 8 (exactly when holes start to matter) and then
  // CLIMBED back to 9.7 by round 16 off the absolute value of an increasingly
  // negative number. This one stays positive and keeps a sane magnitude throughout.
  var floorIdx = Math.min(CONFIG.teams - 1, ok.length - 1);
  var unit = Math.max(ok[0].blendVor - ok[floorIdx].blendVor, 1);

  var scored = ok.slice(0, 50).map(function (p) {
    var score = p.blendVor, best = ok[0] === p;
    var samePos = ok.filter(function (x) { return x.pos === p.pos; });
    var bestAtPos = samePos[0] === p;
    var mates = samePos.filter(function (x) { return x.tier === p.tier; });
    // Scale the need by how many slots it actually fills. A flat bonus treated an
    // empty backfield with three open spots the same as a position already covered,
    // which let two elite tight ends crowd out the running backs entirely.
    if (gap[p.pos]) score += unit * 0.14 * gap[p.pos];
    if (mates.length <= 2 && mates[0] === p) score += unit * 0.10;
    if (p.eliteTE && (lineup().counts.TE || 0) === 0) score += unit * 0.08;
    if (p.eliteQB && p.adp && (pickNow() - p.adp) >= RULES.eliteFallBy) score += unit * 0.30;

    var lead = best ? "The best player left, at any position"
             : bestAtPos ? "The best " + LONG[p.pos] + " left"
             : "Still one of the best available";
    if (gap[p.pos]) lead += ", and we still need a " + LONG[p.pos];
    var tail = "";
    if (p.eliteQB && p.adp && (pickNow() - p.adp) >= RULES.eliteFallBy)
      tail = " He has fallen " + Math.round(pickNow() - p.adp) + " picks past where he usually goes, "
           + "which is the only reason to take a quarterback this early.";
    else if (p.eliteTE && (lineup().counts.TE || 0) === 0)
      tail = " One of the four tight ends worth a real pick.";
    else if (mates.length === 1) tail = " He is the last one at this level before a real drop.";
    else if (mates.length === 2) tail = " Only two are left at this level.";
    if (p.avail === "watch") tail += " Listed " + String(p.inj).toLowerCase() + ".";
    return {p: p, score: score, why: lead + "." + tail};
  });
  scored.sort(function (a, b) { return b.score - a.score; });
  return scored.slice(0, 3);
}

// Late-round stashes: two IR slots mean a hurt player with real upside is free value.
function stashes() {
  var lu = lineup();
  if (myPicksLeft() > 4) return [];
  var used = lu.mine.filter(function (p) { return p.irOk; }).length;
  if (used >= CONFIG.irSlots) return [];
  return open_().filter(function (p) { return p.irOk && !p.late; })
                .sort(function (a, b) { return a.rank - b.rank; }).slice(0, 3);
}

// One shared read per render. A null keep is rendered as nothing, never as a dash
// or a 50% guess: silence is the honest output when there is no signal.
function lastsLine(p, km, nextPick) {
  if (!km || !nextPick) return null;
  var k = km[p.sid];
  if (k == null) return null;
  return {cls: bandOf(k), txt: bandWords(k, nextPick)};
}

// What deferring actually costs: the drop from the best man at a position now to the
// best one likely to survive to the next turn. This is the exploitation, phrased as
// a consequence rather than a statistic.
function waitCost(pos, km, nextPick) {
  if (!km || !nextPick) return null;
  var lu = lineup();
  var pool = open_().filter(function (p) {
    return p.pos === pos && !p.late && !blockedReason(p, lu); });
  if (pool.length < 2) return null;
  var now = pool[0];
  if (km[now.sid] != null && km[now.sid] >= 0.74) return {now: now, free: true};
  var later = pool.filter(function (p) { return km[p.sid] != null && km[p.sid] >= 0.74; })[0];
  if (!later || later.sid === now.sid) return null;
  return {now: now, later: later, drop: Math.round(now.blendVor - later.blendVor)};
}

/* ---------- render ---------- */
function flags(p) {
  var s = "";
  if (p.avail === "out") s += '<span class="flag out">OUT A WHILE</span>';
  else if (p.avail === "watch") s += '<span class="flag watch">' + esc(String(p.inj).toUpperCase().slice(0,4)) + '</span>';
  if (p.irOk) s += '<span class="flag ir">IR STASH</span>';
  if (p.eliteTE || p.eliteQB) s += '<span class="flag elite">ELITE</span>';
  if (p.rookie) s += '<span class="flag rk">ROOKIE</span>';
  return s;
}

function renderTurn() {
  var n = pickNow(), up = MY.filter(function (x) { return x >= n; });
  var next = up[0], away = next != null ? next - n : null;
  var el = document.getElementById("turn");
  el.className = "turn" + (away === 0 ? " up" : "");
  var status = away == null ? '<span class="pill">Draft done</span>'
    : away === 0 ? '<span class="pill">YOUR PICK NOW</span>'
    : '<span class="pill">Pick ' + next + '</span><span><b>' + away
      + '</b> pick' + (away === 1 ? "" : "s") + " away</span>";
  el.innerHTML = '<button class="fix" id="fixPick" title="Correct this if a pick was '
    + 'missed">on pick ' + n + "</button>" + status;
  document.getElementById("fmtLine").textContent =
    CONFIG.label + " \u00b7 round " + Math.min(roundNow(), CONFIG.rounds)
    + " of " + CONFIG.rounds;
}

function renderTake() {
  var recs = advise(), st = stashes();
  var n = pickNow(), ours = MY.indexOf(n) >= 0;
  var nextPick = MY.filter(function (x) { return x > n; })[0] || null;
  var km = nextPick ? keepMap(open_(), n, nextPick) : null;
  var html = "<h2>" + (ours ? "Your pick &mdash; take one of these"
                             : "Best on the board right now") + "</h2>";
  if (!ours) html += '<div class="notyet">Not your pick yet. If another team takes '
    + "one of these, tap <b>Someone took him</b> so the board stays right.</div>";
  if (!recs.length) html += '<div class="in"><span class="muted">Nothing left to suggest.</span></div>';
  recs.forEach(function (r, i) {
    html += '<div class="pick ' + (i === 0 ? "top" : "alt") + '" data-sid="' + esc(r.p.sid) + '">'
      + '<span class="pos ' + r.p.pos + '">' + (r.p.pos === "DEF" ? "DST" : r.p.pos) + "</span>"
      + '<span><span class="nm">' + esc(r.p.name) + "</span>" + flags(r.p)
      + '<div class="why">' + esc(r.p.team) + " · bye " + (r.p.bye || "?") + " — "
      + esc(r.why) + "</div>"
      + (function () { var l = lastsLine(r.p, km, nextPick);
          return l ? '<div class="lasts ' + l.cls + '">' + l.txt + "</div>" : ""; })()
      + "</span>"
      + '<span class="acts">'
      + '<button class="mini' + (ours ? "" : " lead") + '" data-act="taken" data-sid="'
      + esc(r.p.sid) + '">Someone took him</button>'
      + '<button class="mini' + (ours ? " lead" : "") + '" data-act="ours" data-sid="'
      + esc(r.p.sid) + '">We got him</button></span></div>';
  });
  // One line on what waiting costs at the position we are being pointed at.
  if (recs.length && nextPick && km) {
    var wc = waitCost(recs[0].p.pos, km, nextPick);
    if (wc && wc.free) {
      html += '<div class="waitcost"><b>No rush on ' + LONG[recs[0].p.pos] + ".</b> "
        + esc(wc.now.name) + " should still be there at your pick " + nextPick
        + ", so spend this pick on a position that will not keep.</div>";
    } else if (wc && wc.drop > 0) {
      html += '<div class="waitcost">' + (ours
        ? "<b>If you pass on " + LONG[recs[0].p.pos] + " here:</b> the best one likely to "
          + "reach your next pick (" + nextPick + ") is " + esc(wc.later.name) + ", about "
          + wc.drop + " points worse over the season than " + esc(wc.now.name) + "."
        : "<b>By the time you pick:</b> " + esc(wc.now.name) + " may be gone. The best "
          + LONG[recs[0].p.pos] + " likely to still be there is " + esc(wc.later.name)
          + ", about " + wc.drop + " points worse over the season.") + "</div>";
    }
  }
  if (st.length) {
    html += '<div class="in" style="border-top:1px solid var(--line)">'
      + '<div style="font-size:12px;color:var(--ink-2);line-height:1.5">'
      + "<b>Injury stash idea.</b> We have two IR spots. "
      + st.map(function (p) { return esc(p.name); }).join(", ")
      + " are hurt now but worth a late flier.</div></div>";
  }
  document.getElementById("takeCard").innerHTML = html;
}

// The one bit of whole-draft arithmetic a novice reliably gets wrong: how many
// picks are left against how many holes remain.
function ledgerLine(lu) {
  var left = MY.filter(function (x) { return x >= pickNow(); }).length;
  var todo = {};
  lu.filled.forEach(function (f) {
    if (f.p) return;
    var k = FLEXP[f.sl] ? "flex" : LONG[f.sl] || f.sl;
    todo[k] = (todo[k] || 0) + 1;
  });
  var ks = Object.keys(todo);
  return '<div class="ledger">' + (ks.length
    ? "Still to fill: " + ks.map(function (k) {
        return "<b>" + todo[k] + " " + k + (todo[k] > 1 && k !== "flex" ? "s" : "") + "</b>";
      }).join(", ") + ". <b>" + left + "</b> pick" + (left === 1 ? "" : "s") + " left."
    : "<b>Starting lineup is full.</b> " + left + " pick"
      + (left === 1 ? "" : "s") + " left for bench and upside.") + "</div>";
}

function renderRoster() {
  var lu = lineup();
  var html = "<h2>Our team · " + lu.mine.length + "</h2>" + ledgerLine(lu);
  lu.filled.forEach(function (f) {
    html += '<div class="slot ' + (f.p ? "on" : "") + '"><i>'
      + (f.sl === "DEF" ? "DST" : f.sl) + "</i>"
      + (f.p ? "<b>" + esc(f.p.name) + "</b><em>" + esc(f.p.team) + " · bye " + (f.p.bye || "?") + "</em>"
             : '<span class="mt">empty</span><em></em>') + "</div>";
  });
  if (lu.bench.length) {
    html += '<div class="bench-h">Bench</div>';
    lu.bench.forEach(function (p) {
      html += '<div class="slot"><i>BN</i><b>' + esc(p.name) + "</b><em>"
        + p.pos + " · bye " + (p.bye || "?") + "</em></div>";
    });
  }
  document.getElementById("rosterCard").innerHTML = html;
}

function renderRules() {
  var lu = lineup(), c = lu.counts, round = roundNow();
  var r = [];
  r.push({on: (c.QB || 0) >= 1, hit: (c.QB || 0) > RULES.maxQB, ic: "QB",
    t: "<b>" + (c.QB || 0) + " of max 2.</b> No quarterback before round "
       + RULES.qbHoldUntilRound + " unless Allen, Lamar or Maye falls "
       + RULES.eliteFallBy + "+ picks."});
  r.push({on: (c.TE || 0) >= 1, hit: (c.TE || 0) > RULES.maxTE, ic: "TE",
    t: "<b>" + (c.TE || 0) + " of 1.</b> One tight end only. Bowers, McBride, Loveland "
       + "or Warren are worth an early pick; any other waits until round "
       + RULES.teStreamRound + "."});
  r.push({on: (c.K || 0) + (c.DEF || 0) > 0, ic: "K/D",
    t: "<b>Last two rounds only.</b> Kicker and defense are never worth an early pick."});
  r.push({on: lu.mine.some(function (p) { return p.irOk; }), ic: "IR",
    t: "<b>Two IR spots.</b> Hurt players with upside are worth a late flier."});
  document.getElementById("rules").innerHTML = r.map(function (x) {
    return '<div class="rule ' + (x.hit ? "hit" : x.on ? "on" : "") + '">'
      + '<span class="ic">' + x.ic + "</span><span>" + x.t + "</span></div>"; }).join("");
}

function renderAlerts() {
  var lu = lineup(), a = [], open = open_();
  var hurt = lu.mine.filter(function (p) { return p.avail === "out"; });
  if (hurt.length) a.push('<div class="rule hit"><span class="ic">!</span><span><b>'
    + hurt.map(function (p) { return esc(p.name); }).join(", ")
    + "</b> may not play for a while. Fine as a stash, not as a starter.</span></div>");
  var byes = {};
  lu.filled.forEach(function (f) { if (f.p && f.p.bye) byes[f.p.bye] = (byes[f.p.bye] || 0) + 1; });
  Object.keys(byes).forEach(function (w) {
    if (byes[w] >= 3) a.push('<div class="rule hit"><span class="ic">BYE</span><span><b>'
      + byes[w] + "</b> starters are off in week " + w + ".</span></div>");
  });
  board.positions.forEach(function (pos) {
    var pool = open.filter(function (p) { return p.pos === pos; });
    if (!pool.length || pos === "K" || pos === "DEF") return;
    var left = pool.filter(function (p) { return p.tier === pool[0].tier; }).length;
    if (left <= 2) a.push('<div class="rule"><span class="ic">' + pos + "</span><span>Only <b>"
      + left + "</b> left at this level. Best: " + esc(pool[0].name) + ".</span></div>");
  });
  document.getElementById("alerts").innerHTML = a.join("")
    || '<span class="muted">Nothing to flag right now.</span>';
}

function renderCols() {
  var open = open_(), html = "";
  board.positions.forEach(function (pos) {
    var all = board.players.filter(function (p) { return p.pos === pos; }).slice(0, 60);
    var left = all.filter(function (p) { return !draft.drafted.has(p.sid); }).length;
    var rows = "", lastTier = null;
    all.forEach(function (p) {
      if (draft.drafted.has(p.sid)) return;
      if (p.tier !== lastTier) {
        rows += '<div class="tsep"><span>Tier ' + p.tier + '</span><i class="ln"></i></div>';
        lastTier = p.tier;
      }
      rows += '<div class="pr' + (draft.mine.has(p.sid) ? " mine" : "") + '" data-sid="'
        + esc(p.sid) + '"><i class="band" style="background:' + tv(p.tier) + '"></i>'
        + '<span class="n">' + esc(p.name)
        + (p.avail === "out" ? ' <span class="flag out">OUT</span>' : "")
        + (p.eliteTE || p.eliteQB ? ' <span class="flag elite">E</span>' : "") + "</span>"
        + '<span class="tm">' + esc(p.team) + "·" + (p.bye || "?") + "</span>"
        + '<span class="v">' + Math.round(p.blendVor) + "</span></div>";
    });
    html += '<section class="col"><div class="col-h"><span class="t">'
      + (pos === "DEF" ? "DST" : pos) + '</span><span class="n">' + left + " left</span></div>"
      + '<div class="rows">' + rows + "</div></section>";
  });
  document.getElementById("cols").innerHTML = html;
}

function render() {
  renderTurn(); renderTake(); renderRoster(); renderRules(); renderAlerts(); renderCols();
  document.getElementById("foot").innerHTML =
    "<b>How this ranks.</b> Two projection sources re-scored for half PPR and averaged, "
    + "measured against the replacement player at each position for a 12 team lineup, then "
    + "blended 60/40 with the consensus of " + ((P.em[CONFIG.fmt] || {}).x || "~100")
    + " analysts. <b>Our rules are enforced, not suggested:</b> a player who breaks one is "
    + "never recommended, whatever his numbers say. Kickers and defenses use default scoring, "
    + "which no source projects properly. Data pulled " + esc(P.gen) + ". "
    + "Everything is saved on this device only.";
}

/* ---------- marking ---------- */
// Additive unless undoing is asked for explicitly. It used to be a bare toggle, so a
// repeat tap on someone already drafted quietly returned him to the board.
function mark(sid, isOurs, undo) {
  if (draft.drafted.has(sid)) {
    if (!undo) return;
    draft.drafted.delete(sid); draft.mine.delete(sid);
    draft.order = draft.order.filter(function (x) { return x !== sid; });
  } else {
    if (undo) return;
    draft.drafted.add(sid); draft.order.push(sid);
    if (isOurs) draft.mine.add(sid);
  }
  save(); render();
}

var qEl = document.getElementById("q"), resEl = document.getElementById("res");
function search() {
  var t = normTxt(qEl.value);
  if (t.length < 2) { resEl.hidden = true; results = []; return; }
  var starts = [], contains = [], already = [];
  board.players.forEach(function (p) {
    var hay = searchText(p);
    var hit = hay.indexOf(t) === 0 || hay.split(" ").some(function (w) { return w.indexOf(t) === 0; })
      ? 1 : hay.indexOf(t) >= 0 ? 2 : 0;
    if (!hit) return;
    // Already-marked players stay findable. Tapping "Taken" when she meant "We got
    // him" used to remove a player from every panel with no way back short of
    // undoing everything after him.
    if (draft.drafted.has(p.sid)) already.push(p);
    else if (hit === 1) starts.push(p);
    else contains.push(p);
  });
  results = starts.concat(contains).slice(0, 6).concat(already.slice(0, 2));
  var openCount = Math.min(starts.length + contains.length, 6);
  sel = 0;
  if (!results.length) {
    resEl.innerHTML = '<div class="none">Nothing matched that. Try just the last name, '
      + "or the city for a defense. This does not mean he is taken.</div>";
    resEl.hidden = false; return;
  }
  resEl.innerHTML = results.map(function (p, i) {
    var gone = i >= openCount;
    var mine = draft.mine.has(p.sid);
    return '<div class="row' + (i === sel ? " sel" : "") + (gone ? " gone" : "")
      + '" data-i="' + i + '">'
      + '<span class="pos ' + p.pos + '">' + (p.pos === "DEF" ? "DST" : p.pos) + "</span>"
      + '<span><span class="nm">' + esc(p.name) + "</span>" + (gone ? "" : flags(p))
      + '<div class="sub">' + LONG[p.pos] + " \u00b7 " + esc(p.team) + " \u00b7 bye "
      + (p.bye || "?") + (gone ? (mine ? " \u00b7 on our team" : " \u00b7 already marked taken") : "")
      + "</div></span>"
      + (gone
        ? '<span class="take" data-act="undo" data-i="' + i + '">Put him back</span>'
          + (mine ? "" : '<span class="take" data-act="ours" data-i="' + i + '">Actually ours</span>')
        : '<span class="take" data-act="taken" data-i="' + i + '">Taken</span>'
          + '<span class="take" data-act="ours" data-i="' + i + '">We got him</span>')
      + "</div>";
  }).join("");
  resEl.hidden = false;
}

function choose(i, ours, undo) {
  var p = results[i];
  if (!p) return;
  var now = Date.now();
  if (now - lastPickTap < 400) return;    // same redraw-window guard as the pick card
  lastPickTap = now;
  // A bare tap on an already-marked row used to fall through to mark(), which is a
  // toggle, silently returning a player to the board — including one on her roster.
  if (draft.drafted.has(p.sid) && !undo && !ours) { resEl.hidden = true; return; }
  if (undo) {                       // put a mis-marked player back on the board
    if (draft.drafted.has(p.sid)) mark(p.sid, false, true);
  } else if (draft.drafted.has(p.sid) && ours && !draft.mine.has(p.sid)) {
    draft.mine.add(p.sid); save(); render();   // "Taken" should have been "We got him"
  } else {
    mark(p.sid, ours);
  }
  qEl.value = ""; resEl.hidden = true; results = []; qEl.focus();
}
qEl.addEventListener("input", search);
qEl.addEventListener("keydown", function (e) {
  if (resEl.hidden) return;
  if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(sel + 1, results.length - 1); paint(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(sel - 1, 0); paint(); }
  else if (e.key === "Enter") { e.preventDefault(); choose(sel, e.metaKey || e.ctrlKey); }
  else if (e.key === "Escape") { resEl.hidden = true; }
});
function paint() {
  Array.prototype.forEach.call(resEl.children, function (c, i) {
    c.classList.toggle("sel", i === sel); });
}
resEl.addEventListener("click", function (e) {
  var b = e.target.closest("[data-act]");
  if (b) { choose(+b.dataset.i, b.dataset.act === "ours", b.dataset.act === "undo"); return; }
  var row = e.target.closest(".row");
  if (row) choose(+row.dataset.i, false);
});
document.addEventListener("click", function (e) {
  if (!e.target.closest(".mark")) resEl.hidden = true;
  var act = e.target.closest("[data-act]");
  if (act && act.closest(".pick")) {
    // The card re-renders on every mark, so a fast double tap would land on whoever
    // moved into that row. Ignore a second press inside the redraw window.
    var t = Date.now();
    if (t - lastPickTap < 450) return;
    lastPickTap = t;
    mark(act.dataset.sid, act.dataset.act === "ours");
    return;
  }
  if (e.target.closest(".pick")) return;   // the row is not a button; use one
  var pr = e.target.closest(".pr");
  if (pr) { mark(pr.dataset.sid, e.metaKey || e.ctrlKey || e.shiftKey); }
});
document.addEventListener("click", function (e) {
  if (!e.target.closest("#fixPick")) return;
  var cur = pickNow();
  var v = prompt("Which pick is the draft actually on right now?\n\n"
    + "The board thinks it is pick " + cur + ".\n\n"
    + "Use this only for picks you are NOT going to log. If you are about to catch "
    + "up by marking those players, do that instead and leave this alone, or the "
    + "board will count them twice. You can always correct it again.", String(cur));
  if (v == null) return;
  var want = parseInt(v, 10);
  if (!want || want < 1) return;
  pickOffset += want - cur;
  save(); render();
});
document.getElementById("undo").addEventListener("click", function () {
  var last = draft.order[draft.order.length - 1];
  if (last) mark(last, false, true);
});
document.getElementById("reset").addEventListener("click", function () {
  if (!confirm("Clear every pick and start the draft over?")) return;
  try { localStorage.removeItem(KEY); } catch (e) {}
  restore(); render();
});

restore();
board = build();
board.players.forEach(function (p) { BYID[p.sid] = p; });
render();
qEl.focus();
})();
