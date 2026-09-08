/* Survivor League auction board.
 *
 * Two things make this league unlike the others. It is an auction, so the output is
 * a price rather than a rank. And the lowest scorer each week is eliminated outright
 * with only ONE bench spot to cover an absence, so a player who misses a single early
 * week is not a discount, he is a way to lose the season.
 */
(function () {
"use strict";

var P = window.PAYLOAD;
var ORDER = ["QB", "RB", "WR", "TE", "K", "DEF"];
var FLEXP = {FLEX: ["RB", "WR", "TE"]};
var KEY = "survivor.auction.v1";
var LONG = {QB:"quarterback", RB:"running back", WR:"receiver", TE:"tight end",
            K:"kicker", DEF:"defense"};
var CITY = {ARI:"arizona",ATL:"atlanta",BAL:"baltimore",BUF:"buffalo",CAR:"carolina",
  CHI:"chicago",CIN:"cincinnati",CLE:"cleveland",DAL:"dallas",DEN:"denver",DET:"detroit",
  GB:"green bay",HOU:"houston",IND:"indianapolis",JAX:"jacksonville",KC:"kansas city",
  LAC:"los angeles chargers",LAR:"los angeles rams",LV:"las vegas",MIA:"miami",
  MIN:"minnesota",NE:"new england",NO:"new orleans",NYG:"new york giants",
  NYJ:"new york jets",PHI:"philadelphia",PIT:"pittsburgh",SEA:"seattle",
  SF:"san francisco",TB:"tampa bay",TEN:"tennessee",WAS:"washington"};

var CONFIG = {
  teams: 19, budget: 200, spots: 12, fmt: "HALF",
  label: "19 teams, $200, half PPR, one bench spot",
  roster: ["QB","RB","RB","WR","WR","WR","TE","FLEX","FLEX","K","DEF","BN"],
  // Only value ABOVE this bar earns auction money. Real auctions do not spread cash
  // evenly: the back of every roster goes for a dollar and the surplus piles onto the
  // top. An earlier version did that by pricing a fixed top N, which put a cliff in
  // the middle of the board and left every quarterback but Josh Allen at $1. A
  // threshold fades the tail smoothly instead. 35 was fitted to two anchors the owner
  // gave from experience: about $105 at the top, high 60s for the Saquon tier.
  vorFloor: 35,
  scoring: {pass_yd:0.04, pass_td:4, pass_int:-1, pass_2pt:2,
            rush_yd:0.1, rush_td:6, rush_2pt:2,
            rec:0.5, rec_yd:0.1, rec_td:6, rec_2pt:2, fum_lost:-2},
  // Missing a week is not a small haircut here. One bench spot means an absence is
  // covered by whoever is left, and the lowest score in the league is eliminated, so
  // a single bad week can end the season. OUT is priced as a flier, not a starter.
  // OUT players are mostly $1 anyway, so the discount that actually bites is on the
  // questionable group, and several of them sit at the very top of the board. In a
  // normal league an 18% haircut on a maybe would be too harsh. Here it is not: the
  // single bench spot means one absence is already awkward and two is unsurvivable.
  discount: {out: 0.30, watch: 0.82}
};

var draft = null, board = null, sel = 0, results = [], lastTap = 0;

/* ---------- state ---------- */
// gone: sid -> price paid. mine: sid -> price I paid.
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(
    {g: draft.gone, m: draft.mine, o: draft.order})); } catch (e) {}
}
function restore() {
  var d = {g: {}, m: {}, o: []};
  try { var r = localStorage.getItem(KEY); if (r) d = JSON.parse(r); } catch (e) {}
  draft = {gone: d.g || {}, mine: d.m || {}, order: d.o || []};
}

/* ---------- engine ---------- */
function scoreOf(st, pos) {
  var pts = 0;
  for (var k in st) { var w = CONFIG.scoring[k]; if (w) pts += st[k] * w; }
  return pts;
}
function build() {
  var players = [];
  P.pl.forEach(function (raw) {
    var pos = raw.p, pts;
    if (pos === "K" || pos === "DEF") {
      pts = raw.s.pts_std;
      if (pts == null) return;
    } else {
      var a = scoreOf(raw.s, pos);
      var b = Object.keys(raw.e).length ? scoreOf(raw.e, pos) : null;
      pts = b == null ? a : (a + b) / 2;
    }
    var e = raw.r[CONFIG.fmt] || null;
    players.push({name: raw.n, pos: pos, team: raw.t, bye: raw.b, sid: raw.id,
      pts: Math.round(pts * 10) / 10, ecr: e ? e[0] : null,
      adp: raw.ea != null ? raw.ea : null,
      rookie: raw.k, inj: raw.i, avail: raw.av || "ok",
      late: pos === "K" || pos === "DEF"});
  });

  // Replacement with 19 teams is DEEP: 47 running backs and 75 receivers start
  // league-wide once the two flex slots are filled, which is why players nobody has
  // heard of still carry real value here.
  var ded = {}, flex = [];
  CONFIG.roster.forEach(function (s) {
    if (s === "BN") return;
    if (FLEXP[s]) flex.push(s); else ded[s] = (ded[s] || 0) + 1;
  });
  var byPos = {};
  players.forEach(function (p) { (byPos[p.pos] = byPos[p.pos] || []).push(p); });
  for (var k in byPos) byPos[k].sort(function (a, b) { return b.pts - a.pts; });
  var counts = {};
  for (var pz in ded) counts[pz] = CONFIG.teams * ded[pz];
  flex.forEach(function (slot) {
    for (var i = 0; i < CONFIG.teams; i++) {
      var best = null, bp = null;
      FLEXP[slot].forEach(function (ps) {
        var pool = byPos[ps] || [], at = counts[ps] || 0;
        if (at < pool.length && (!best || pool[at].pts > best.pts)) { best = pool[at]; bp = ps; }
      });
      if (bp) counts[bp] = (counts[bp] || 0) + 1;
    }
  });
  var repl = {};
  for (var pq in byPos) {
    var pool = byPos[pq], idx = counts[pq] || 0;
    var band = pool.slice(Math.max(0, idx - 1), Math.min(pool.length, idx + 2));
    if (!band.length) band = [pool[pool.length - 1]];
    repl[pq] = band.reduce(function (t, x) { return t + x.pts; }, 0) / band.length;
  }
  players.forEach(function (p) { p.vor = Math.max(p.pts - (repl[p.pos] || 0), 0); });

  players.sort(function (a, b) { return b.vor - a.vor; });
  var surplus = CONFIG.teams * CONFIG.budget - CONFIG.teams * CONFIG.spots;
  var tot = players.reduce(function (t, p) {
    return t + Math.max(p.vor - CONFIG.vorFloor, 0); }, 0);
  players.forEach(function (p) {
    var eff = Math.max(p.vor - CONFIG.vorFloor, 0);
    p.raw = tot > 0 ? Math.round(1 + eff / tot * surplus) : 1;
    var d = CONFIG.discount[p.avail];
    p.val = Math.max(1, Math.round(p.raw * (d == null ? 1 : d)));
    p.cut = p.raw - p.val;
  });
  players.forEach(function (p, i) { p.rank = i + 1; });
  var bp2 = {};
  players.forEach(function (p) { (bp2[p.pos] = bp2[p.pos] || []).push(p); });
  for (var q in bp2) bp2[q].forEach(function (p, i) { p.posRank = i + 1; });
  return {players: players, repl: repl, counts: counts,
          positions: ORDER.filter(function (x) { return byPos[x] && byPos[x].length; })};
}

/* ---------- money ---------- */
function spent() {
  var t = 0;
  for (var s in draft.mine) t += draft.mine[s];
  return t;
}
function owned() { return Object.keys(draft.mine).length; }
function left() { return CONFIG.budget - spent(); }
function spotsLeft() { return CONFIG.spots - owned(); }
// Must keep $1 back for every other slot still to fill.
function maxBid() { return Math.max(0, left() - (spotsLeft() - 1)); }

// Are players going over or under what this board thinks? Everything still on the
// board reprices by that factor, so late value is not judged against stale numbers.
function inflation() {
  var paid = 0, worth = 0;
  board.players.forEach(function (p) {
    var pr = draft.gone[p.sid];
    if (pr == null || p.raw <= 1) return;
    paid += pr; worth += p.val;
  });
  if (worth < 40) return 1;
  return Math.max(0.6, Math.min(1.6, paid / worth));
}
function target(p) { return Math.max(1, Math.round(p.val * inflation())); }

/* ---------- helpers ---------- */
function open_() { return board.players.filter(function (p) { return draft.gone[p.sid] == null; }); }
function mine_() { return board.players.filter(function (p) { return draft.mine[p.sid] != null; }); }
function tv(t) { return "var(--t" + Math.min(t || 11, 11) + ")"; }
function esc(s) { return String(s).replace(/[&<>"]/g, function (c) {
  return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]; }); }
function normTxt(x) {
  return String(x).toLowerCase().replace(/[.'’`]/g, "").replace(/[-\/]/g, " ")
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "").replace(/\s+/g, " ").trim();
}
function searchText(p) {
  var t = normTxt(p.name);
  if (p.pos === "DEF" && CITY[p.team]) t += " " + CITY[p.team] + " defense dst";
  return t + " " + (p.team || "").toLowerCase();
}
function flags(p) {
  var s = "";
  if (p.avail === "out") s += '<span class="flag out">OUT A WHILE</span>';
  else if (p.avail === "watch") s += '<span class="flag watch">'
    + esc(String(p.inj).toUpperCase().slice(0, 4)) + "</span>";
  if (p.rookie) s += '<span class="flag rk">RK</span>';
  return s;
}

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
  return {mine: mine, filled: filled,
          bench: mine.filter(function (p) { return !starters[p.sid]; })};
}

/* ---------- render ---------- */
function renderMoney() {
  var mb = maxBid(), lo = spotsLeft() > 0 && mb <= 5;
  document.getElementById("fmtLine").textContent = CONFIG.label;
  document.getElementById("money").innerHTML =
    '<div class="mo"><b class="tnum">$' + left() + "</b><span>left</span></div>"
    + '<div class="mo"><b class="tnum">' + spotsLeft() + "</b><span>spots to fill</span></div>"
    + '<div class="mo max' + (lo ? " warn" : "") + '"><b class="tnum">$' + mb
    + "</b><span>most you can bid</span></div>";
}

function renderCols() {
  var infl = inflation(), html = "";
  board.positions.forEach(function (pos) {
    var all = board.players.filter(function (p) { return p.pos === pos; });
    var live = all.filter(function (p) { return draft.gone[p.sid] == null; });
    // No cap. 19 teams start 47 running backs and 75 receivers, and this format
    // rewards knowing the deep end, so the whole pool is listed and scrolls.
    var rows = live.map(function (p) {
      return '<div class="pr' + (draft.mine[p.sid] != null ? " mine" : "") + '" data-sid="'
        + esc(p.sid) + '"><i class="band" style="background:' + tv(Math.ceil(p.posRank / 6))
        + '"></i><span class="n">' + esc(p.name) + flags(p) + "</span>"
        + '<span class="tm">' + esc(p.team) + "</span>"
        + '<span class="v">$' + target(p)
        + (p.cut > 0 ? '<s>$' + p.raw + "</s>" : "") + "</span></div>";
    }).join("");
    html += '<section class="col"><div class="col-h"><span class="t">'
      + (pos === "DEF" ? "DST" : pos) + '</span><span class="n">' + live.length
      + " left</span></div><div class=\"rows\">" + rows + "</div></section>";
  });
  document.getElementById("cols").innerHTML = html;
  var pct = Math.round((infl - 1) * 100);
  document.getElementById("legend").innerHTML =
    "The number is <b>what he is worth to you</b>, not what he will go for. Never bid past "
    + "it unless you have a reason. Prices already include the survivor discount for "
    + "anyone carrying an injury tag. A struck-through number is what he would be "
    + "worth if he were fully healthy."
    + (Math.abs(pct) >= 4
        ? " <b>The room is paying " + Math.abs(pct) + "% " + (pct > 0 ? "over" : "under")
          + "</b> these numbers so far, and everything below is adjusted for that."
        : "");
}

function renderRoster() {
  var lu = lineup();
  var html = "<h2>My team &middot; " + lu.mine.length + " of " + CONFIG.spots + "</h2>";
  html += lu.filled.map(function (f) {
    return '<div class="slot ' + (f.p ? "on" : "") + '"><i>'
      + (f.sl === "DEF" ? "DST" : f.sl) + "</i>"
      + (f.p ? "<b>" + esc(f.p.name) + "</b><em>$" + draft.mine[f.p.sid] + "</em>"
             : '<span class="mt">empty</span><em></em>') + "</div>";
  }).join("");
  var bn = lu.bench[0];
  html += '<div class="slot ' + (bn ? "on" : "") + '"><i>BENCH</i>'
    + (bn ? "<b>" + esc(bn.name) + "</b><em>$" + draft.mine[bn.sid] + "</em>"
          : '<span class="mt">empty &mdash; your only one</span><em></em>') + "</div>";
  document.getElementById("rosterCard").innerHTML = html;
}

function renderNotes() {
  var lu = lineup(), n = [], mb = maxBid(), open = open_();
  var hurt = lu.mine.filter(function (p) { return p.avail !== "ok"; });
  if (hurt.length >= 2) n.push('<div class="note hot"><span class="ic">!</span><span>You have <b>'
    + hurt.length + " players</b> who may miss time and <b>one bench spot</b>. "
    + "A second absence in the same week means starting nobody.</span></div>");
  if (spotsLeft() > 0 && mb <= 3) n.push('<div class="note hot"><span class="ic">$</span><span>'
    + "You are down to <b>$" + mb + "</b> of room. Everything left is a dollar "
    + "player.</span></div>");
  var gaps = lu.filled.filter(function (f) { return !f.p; }).length;
  if (gaps > 0 && spotsLeft() <= gaps) n.push('<div class="note hot"><span class="ic">FIT</span>'
    + "<span>Every remaining dollar has to fill a starting slot. No room for a bench "
    + "flier.</span></div>");
  var bestOut = open.filter(function (p) { return p.avail === "out" && p.raw >= 25; })
    .sort(function (a, b) { return b.raw - a.raw; })[0];
  if (bestOut) n.push('<div class="note"><span class="ic">CUT</span><span><b>'
    + esc(bestOut.name) + "</b> would be $" + bestOut.raw + " if healthy. He is $"
    + target(bestOut) + " here because a missed week in this league is a week you can "
    + "be eliminated.</span></div>");
  var deals = open.filter(function (p) { return p.raw >= 15 && p.avail === "ok"; })
    .sort(function (a, b) { return b.val - a.val; }).slice(0, 3);
  if (deals.length) n.push('<div class="note ok"><span class="ic">BUY</span><span>Best value '
    + "still on the board: " + deals.map(function (p) {
        return "<b>" + esc(p.name) + "</b> $" + target(p); }).join(", ") + ".</span></div>");
  document.getElementById("notes").innerHTML = n.join("")
    || '<span style="color:var(--ink-3);font-size:12.5px">Nothing to flag yet.</span>';
}

function renderFoot() {
  document.getElementById("foot").innerHTML =
    "<b>How the prices are set.</b> Two projection sources are re-scored for this "
    + "league's rules and averaged, measured against the replacement player at each "
    + "position for a 19 team lineup, then blended with the consensus of "
    + ((P.em[CONFIG.fmt] || {}).x || "~100") + " analysts. The top " + CONFIG.priced
    + " players share the money that is not committed to $1 roster spots, which "
    + "reproduces how this league actually bids. <b>The survivor discount</b> prices "
    + "anyone expected to miss time at " + Math.round(CONFIG.discount.out * 100)
    + "% of value, because with one bench spot and the low scorer eliminated, a missed "
    + "week is a week you can lose the season. Data pulled " + esc(P.gen) + ".";
}

function render() { renderMoney(); renderCols(); renderRoster(); renderNotes(); renderFoot(); }

/* ---------- marking ---------- */
function buy(sid, price, isMine) {
  draft.gone[sid] = price;
  if (isMine) draft.mine[sid] = price;
  if (draft.order.indexOf(sid) < 0) draft.order.push(sid);
  save(); render();
}
function unbuy(sid) {
  delete draft.gone[sid]; delete draft.mine[sid];
  draft.order = draft.order.filter(function (x) { return x !== sid; });
  save(); render();
}

var qEl = document.getElementById("q"), resEl = document.getElementById("res");
function search() {
  var t = normTxt(qEl.value);
  if (t.length < 2) { resEl.hidden = true; results = []; return; }
  var starts = [], has = [], gone = [];
  board.players.forEach(function (p) {
    var hay = searchText(p);
    var hit = hay.indexOf(t) === 0 || hay.split(" ").some(function (w) { return w.indexOf(t) === 0; })
      ? 1 : hay.indexOf(t) >= 0 ? 2 : 0;
    if (!hit) return;
    if (draft.gone[p.sid] != null) gone.push(p);
    else if (hit === 1) starts.push(p); else has.push(p);
  });
  results = starts.concat(has).slice(0, 6).concat(gone.slice(0, 2));
  var openN = Math.min(starts.length + has.length, 6);
  sel = 0;
  if (!results.length) {
    resEl.innerHTML = '<div class="none">Nothing matched. Try the last name, or the city '
      + "for a defense.</div>";
    resEl.hidden = false; return;
  }
  resEl.innerHTML = results.map(function (p, i) {
    var isGone = i >= openN;
    return '<div class="row' + (i === sel ? " sel" : "") + (isGone ? " gone" : "")
      + '" data-i="' + i + '">'
      + '<span class="pos ' + p.pos + '">' + (p.pos === "DEF" ? "DST" : p.pos) + "</span>"
      + '<span><span class="nm">' + esc(p.name) + "</span>" + (isGone ? "" : flags(p))
      + '<div class="sub">' + LONG[p.pos] + " · " + esc(p.team)
      + (isGone ? " · went for $" + draft.gone[p.sid]
                  + (draft.mine[p.sid] != null ? " (yours)" : "") : "") + "</div></span>"
      + (isGone ? '<span></span><span class="take" data-act="undo" data-i="' + i + '">Undo</span>'
                : '<span class="val">$' + target(p)
                  + (p.cut > 0 ? '<s>$' + p.raw + "</s>" : "") + "</span>"
                  + '<span class="take" data-act="them" data-i="' + i + '">Someone else</span>'
                  + '<span class="take" data-act="me" data-i="' + i + '">I won him</span>')
      + "</div>";
  }).join("");
  resEl.hidden = false;
}
function choose(i, act) {
  var p = results[i];
  if (!p) return;
  var now = Date.now();
  if (now - lastTap < 400) return;
  lastTap = now;
  if (act === "undo") { unbuy(p.sid); qEl.value = ""; resEl.hidden = true; qEl.focus(); return; }
  var suggested = act === "me" ? Math.min(target(p), maxBid()) : target(p);
  var v = prompt("What did " + p.name + " go for?\n\nYour value on him is $" + target(p)
    + (act === "me" ? ". Most you can bid is $" + maxBid() + "." : "."), String(suggested));
  if (v == null) return;
  var price = parseInt(v, 10);
  if (isNaN(price) || price < 1) return;
  if (act === "me" && price > maxBid()) {
    alert("That leaves you unable to fill your roster. Most you can spend is $" + maxBid() + ".");
    return;
  }
  buy(p.sid, price, act === "me");
  qEl.value = ""; resEl.hidden = true; results = []; qEl.focus();
}
qEl.addEventListener("input", search);
qEl.addEventListener("keydown", function (e) {
  if (resEl.hidden) return;
  if (e.key === "ArrowDown") { e.preventDefault(); sel = Math.min(sel + 1, results.length - 1); search2(); }
  else if (e.key === "ArrowUp") { e.preventDefault(); sel = Math.max(sel - 1, 0); search2(); }
  else if (e.key === "Enter") { e.preventDefault(); choose(sel, "them"); }
  else if (e.key === "Escape") resEl.hidden = true;
});
function search2() {
  Array.prototype.forEach.call(resEl.children, function (c, i) {
    c.classList.toggle("sel", i === sel); });
}
resEl.addEventListener("click", function (e) {
  var b = e.target.closest("[data-act]");
  if (b) { choose(+b.dataset.i, b.dataset.act); return; }
  var row = e.target.closest(".row");
  if (row) choose(+row.dataset.i, "them");
});
document.addEventListener("click", function (e) {
  if (!e.target.closest(".mark")) resEl.hidden = true;
  var pr = e.target.closest(".pr");
  if (pr && !e.target.closest(".res")) {
    var p = board.players.filter(function (x) { return x.sid === pr.dataset.sid; })[0];
    if (!p) return;
    results = [p]; sel = 0;
    choose(0, e.metaKey || e.ctrlKey ? "me" : "them");
  }
});
document.getElementById("undo").addEventListener("click", function () {
  var last = draft.order[draft.order.length - 1];
  if (last) unbuy(last);
});
document.getElementById("reset").addEventListener("click", function () {
  if (!confirm("Clear the whole auction and start over?")) return;
  try { localStorage.removeItem(KEY); } catch (e) {}
  restore(); render();
});

restore();
board = build();
render();
qEl.focus();
})();
