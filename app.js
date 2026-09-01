/* Last Call — client-side draft board.
 *
 * Everything the Python pipeline does at build time happens here instead, so the
 * league rules can change without rebuilding anything: re-score projections under
 * the league's own scoring, derive replacement level from its actual lineup, blend
 * against expert consensus, tier, price, and rank.
 */
(function () {
"use strict";

var P = window.PAYLOAD;
var ORDER = ["QB", "RB", "WR", "TE", "K", "DEF"];
var FLEXP = {FLEX:["RB","WR","TE"], WRRB_FLEX:["RB","WR"], REC_FLEX:["WR","TE"],
             SUPER_FLEX:["QB","RB","WR","TE"]};
var SLOT_ORDER = ["QB","RB","WR","TE","FLEX","SUPER_FLEX","K","DEF","BN"];
var KEY = "lastcall.guide.v1";

var cfg = null, board = null, draft = null;
var basis = "blend", query = "", hideGone = false, expert = false;

/* ---------------- persistence ---------------- */
function save() {
  try { localStorage.setItem(KEY, JSON.stringify({cfg: cfg, draft: {
    drafted: Array.from(draft.drafted), mine: Array.from(draft.mine), order: draft.order
  }})); } catch (e) {}
}
function restore() {
  try {
    var raw = localStorage.getItem(KEY);
    if (!raw) return false;
    var d = JSON.parse(raw);
    if (!d || !d.cfg) return false;
    cfg = d.cfg;
    draft = {drafted: new Set((d.draft||{}).drafted || []),
             mine: new Set((d.draft||{}).mine || []),
             order: (d.draft||{}).order || []};
    return true;
  } catch (e) { return false; }
}

/* ---------------- scoring ---------------- */
function preset(fmt, passTd, tePrem) {
  return {pass_yd:0.04, pass_td:passTd, pass_int:-2, pass_2pt:2,
          rush_yd:0.1, rush_td:6, rush_2pt:2,
          rec: fmt === "PPR" ? 1 : fmt === "HALF" ? 0.5 : 0,
          rec_yd:0.1, rec_td:6, rec_2pt:2, fum_lost:-2,
          bonus_rec_te: tePrem || 0};
}
function scoreOf(stats, scoring, pos) {
  var pts = 0;
  for (var k in stats) { var w = scoring[k]; if (w) pts += stats[k] * w; }
  var b = scoring["bonus_rec_" + pos.toLowerCase()];
  if (b && stats.rec) pts += stats.rec * b;
  return pts;
}
// Which published consensus matches this scoring
function ecrFormat(scoring, roster) {
  if (roster.indexOf("SUPER_FLEX") >= 0) return "2QB";
  var r = scoring.rec || 0;
  return r >= 0.75 ? "PPR" : r >= 0.25 ? "HALF" : "STD";
}

/* ---------------- replacement level ---------------- */
function parseRoster(rp) {
  var ded = {}, flex = [];
  rp.forEach(function (s) {
    if (s === "BN" || s === "IR" || s === "TAXI") return;
    if (FLEXP[s]) flex.push(s); else ded[s] = (ded[s] || 0) + 1;
  });
  return {ded: ded, flex: flex};
}
// Dedicated slots fill first; each flex then takes the best player left anywhere.
// The next man past the last starter sets replacement.
function replacement(players, teams, ded, flex) {
  var byPos = {};
  players.forEach(function (p) { (byPos[p.pos] = byPos[p.pos] || []).push(p); });
  for (var k in byPos) byPos[k].sort(function (a, b) { return b.pts - a.pts; });
  var counts = {};
  for (var pos in ded) counts[pos] = teams * ded[pos];
  flex.forEach(function (slot) {
    for (var i = 0; i < teams; i++) {
      var best = null, bp = null;
      FLEXP[slot].forEach(function (pos) {
        var pool = byPos[pos] || [], at = counts[pos] || 0;
        if (at < pool.length && (!best || pool[at].pts > best.pts)) { best = pool[at]; bp = pos; }
      });
      if (bp) counts[bp] = (counts[bp] || 0) + 1;
    }
  });
  var repl = {};
  for (var pz in byPos) {
    var pool = byPos[pz], idx = counts[pz] || 0;
    var lo = Math.max(0, idx - 1), hi = Math.min(pool.length, idx + 2);
    var band = pool.slice(lo, hi);
    if (!band.length) band = [pool[pool.length - 1]];
    repl[pz] = band.reduce(function (t, x) { return t + x.pts; }, 0) / band.length;
  }
  return {repl: repl, counts: counts};
}

/* ---------------- tiers ---------------- */
// Cut at the largest real drops inside the draftable range; everything past that
// range is one depth bucket. A single global threshold cannot work because the
// gaps are enormous at the top of a position and vanishing in the tail.
function tierize(pool, depth, field, out, maxTiers) {
  maxTiers = maxTiers || 10;
  if (!pool.length) return;
  pool.sort(function (a, b) { return b[field] - a[field]; });
  var core = pool.slice(0, Math.max(depth, 2)), rest = pool.slice(core.length);
  var gaps = [];
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

/* ---------------- build ---------------- */
function build(c) {
  var scoring = c.scoring, teams = c.teams, rp = c.roster;
  var pr = parseRoster(rp);
  var active = {};
  for (var d in pr.ded) if (ORDER.indexOf(d) >= 0) active[d] = 1;
  pr.flex.forEach(function (s) { FLEXP[s].forEach(function (p) { active[p] = 1; }); });
  var fmt = ecrFormat(scoring, rp);

  var players = [];
  P.pl.forEach(function (raw) {
    if (!active[raw.p]) return;
    var pos = raw.p, pts, exact = true;
    if (pos === "K" || pos === "DEF") {
      // Nobody projects points-allowed or field-goal-distance tiers, so these use
      // the published default rather than this league's rules.
      pts = raw.s.pts_std; exact = false;
      if (pts == null) return;
    } else {
      var a = scoreOf(raw.s, scoring, pos);
      var b = Object.keys(raw.e).length ? scoreOf(raw.e, scoring, pos) : null;
      pts = b == null ? a : (a + b) / 2;
    }
    var ecr = raw.r[fmt] || null;
    players.push({
      name: raw.n, pos: pos, team: raw.t, bye: raw.b, sid: raw.id,
      pts: Math.round(pts * 10) / 10, exact: exact,
      adp: raw.a[fmt] != null ? raw.a[fmt] : raw.a.PPR,
      ecr: ecr ? ecr[0] : null, ecrBest: ecr ? ecr[1] : null,
      ecrWorst: ecr ? ecr[2] : null, ecrSD: ecr ? ecr[3] : null,
      ecrTierRaw: ecr ? ecr[4] : null,
      rookie: raw.k, inj: raw.i, late: pos === "K" || pos === "DEF"
    });
  });

  var rl = replacement(players, teams, pr.ded, pr.flex);
  players.forEach(function (p) { p.vor = Math.round((p.pts - (rl.repl[p.pos] || 0)) * 10) / 10; });

  // Ranks: projection, consensus, then a blend struck on the value scale.
  players.slice().sort(function (a, b) { return (a.late - b.late) || (b.vor - a.vor); })
    .forEach(function (p, i) { p.vorRank = i + 1; });
  var ranked = players.filter(function (p) { return p.ecr != null; });
  ranked.slice().sort(function (a, b) { return (a.late - b.late) || (a.ecr - b.ecr); })
    .forEach(function (p, i) { p.ecrRank = i + 1; });
  var floor = ranked.length + 1;
  players.forEach(function (p) { if (p.ecr == null) p.ecrRank = floor; });

  // An expert rank is an opinion about order, not points. Translate it into this
  // league's own currency: if the analysts call a man RB5, credit him with the
  // value of the fifth-best RB under these rules.
  var W = c.ecrWeight == null ? 0.6 : c.ecrWeight;
  var curve = {};
  players.forEach(function (p) { (curve[p.pos] = curve[p.pos] || []).push(p.vor); });
  for (var cp in curve) curve[cp].sort(function (a, b) { return b - a; });
  Object.keys(active).concat(["K","DEF"]).forEach(function (pos) {
    var pool = players.filter(function (p) { return p.pos === pos; });
    if (!pool.length) return;
    var rk = pool.filter(function (p) { return p.ecr != null; })
                 .sort(function (a, b) { return a.ecr - b.ecr; });
    rk.forEach(function (p, i) { p.ecrPos = i + 1; });
    var cv = curve[pos], fl = Math.min(rk.length, cv.length - 1);
    pool.forEach(function (p) {
      var idx = p.ecrPos ? Math.min(p.ecrPos - 1, cv.length - 1) : fl;
      p.blendVor = W * cv[idx] + (1 - W) * p.vor;
      p.leagueShift = p.ecr != null ? p.ecrRank - p.vorRank : null;
    });
  });

  players.sort(function (a, b) { return (a.late - b.late) || (b.blendVor - a.blendVor); });
  players.filter(function (p) { return !p.late; }).forEach(function (p, i) { p.blendRank = i + 1; });
  players.filter(function (p) { return p.late; }).forEach(function (p, i) { p.blendRank = 10000 + i; });

  // Three coherent tier sets, one per ranking basis, so bands never run backwards.
  Object.keys(active).forEach(function (pos) {
    var pool = players.filter(function (p) { return p.pos === pos; });
    var starters = rl.counts[pos] || teams;
    var depth = (pos === "K" || pos === "DEF") ? teams + 8
              : Math.max(Math.round(starters * 2.2) + teams, 20);
    tierize(pool, depth, "vor", "tier");
    tierize(pool, depth, "blendVor", "bTier");
    var seen = [];
    pool.forEach(function (p) {
      if (p.ecrTierRaw && seen.indexOf(p.ecrTierRaw) < 0) seen.push(p.ecrTierRaw);
    });
    seen.sort(function (a, b) { return a - b; });
    pool.forEach(function (p) {
      var i = seen.indexOf(p.ecrTierRaw);
      p.cTier = i >= 0 ? i + 1 : seen.length + 1;
    });
  });

  // Auction dollars price the blended value.
  var spots = teams * rp.filter(function (s) { return s !== "IR" && s !== "TAXI"; }).length;
  var pool = players.slice().sort(function (a, b) { return (a.late - b.late) || (b.blendVor - a.blendVor); })
                    .slice(0, spots);
  var tot = pool.reduce(function (t, p) { return t + Math.max(p.blendVor, 0); }, 0);
  var surplus = teams * (c.budget || 200) - spots;
  players.forEach(function (p) { p.auction = 0; });
  if (tot > 0) pool.forEach(function (p) {
    p.auction = Math.round(1 + Math.max(p.blendVor, 0) / tot * surplus);
  });

  return {players: players, repl: rl.repl, counts: rl.counts, fmt: fmt,
          positions: ORDER.filter(function (p) { return active[p]; }),
          ded: pr.ded, flex: pr.flex};
}

/* ---------------- view helpers ---------------- */
function rankKey(p) { return basis === "ecr" ? p.ecrRank : basis === "vor" ? p.vorRank : p.blendRank; }
function tierOf(p) { return basis === "vor" ? p.tier : basis === "ecr" ? p.cTier : p.bTier; }
function tv(t) { return "var(--t" + Math.min(t || 11, 11) + ")"; }
function esc(s) { return String(s).replace(/[&<>"]/g, function (c) {
  return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]; }); }
function shortName(n) {
  if (n.length <= 13) return n;
  var p = n.split(" ");
  return p.length < 2 ? n : p[0][0] + ". " + p.slice(1).join(" ");
}
function ordered() {
  var a = board.players.slice().sort(function (x, y) {
    return (x.late - y.late) || (rankKey(x) - rankKey(y)); });
  var c = {};
  a.forEach(function (p) { c[p.pos] = (c[p.pos] || 0) + 1; p._pr = c[p.pos]; });
  return a;
}
function openPlayers(seq) { return seq.filter(function (p) { return !draft.drafted.has(p.sid); }); }

/* ---------------- roster + recommendation ---------------- */
function lineup(seq) {
  var mine = seq.filter(function (p) { return draft.mine.has(p.sid); });
  var need = {};
  cfg.roster.forEach(function (s) { if (s !== "BN" && s !== "IR") need[s] = (need[s] || 0) + 1; });
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
      FLEXP[sl].forEach(function (pos) {
        var pool = byPos[pos] || [], at = used[pos] || 0;
        if (pool[at] && (!best || rankKey(pool[at]) < rankKey(best))) { best = pool[at]; bp = pos; }
      });
      if (best) { used[bp] = (used[bp] || 0) + 1; filled.push({sl: sl, p: best}); }
      else filled.push({sl: sl, p: null});
    }
  });
  var starters = {};
  filled.forEach(function (f) { if (f.p) starters[f.p.sid] = 1; });
  return {mine: mine, filled: filled, bench: mine.filter(function (p) { return !starters[p.sid]; }),
          need: need};
}

// Who to take now. Value leads, nudged by what the roster still needs and by tiers
// about to empty. Reasons are written for someone who does not follow football, and
// are shown so the call can be overruled.
function advise(seq, lu) {
  var all = openPlayers(seq);
  var round = Math.floor(draft.order.length / cfg.teams) + 1;
  var totalRounds = cfg.rounds || 16;
  var lateEnough = round >= totalRounds - 1;

  // Kickers and defenses are the classic beginner trap: they look draftable on
  // value long before anyone should spend a pick on one. Hold them until the end,
  // then insist on them so she does not finish the draft without either.
  var needKD = [];
  lu.filled.forEach(function (f) {
    if (f.p) return;
    if (f.sl === "K" || f.sl === "DEF") needKD.push(f.sl);
  });
  if (lateEnough && needKD.length) {
    return needKD.slice(0, 2).map(function (sl) {
      var best = all.filter(function (p) { return p.pos === sl; })[0];
      if (!best) return null;
      return {p: best, why: sl === "K"
        ? "The draft is nearly over and you have no kicker. Any of the top few is fine."
        : "The draft is nearly over and you have no defense. Take the best one left."};
    }).filter(Boolean);
  }

  var open = all.filter(function (p) { return !p.late; });
  if (!open.length) return [];
  var top = open[0].blendVor, unit = Math.max(Math.abs(top), 1);

  var gap = {};
  lu.filled.forEach(function (f) {
    if (f.p || f.sl === "K" || f.sl === "DEF") return;
    (FLEXP[f.sl] || [f.sl]).forEach(function (pos) { gap[pos] = (gap[pos] || 0) + 1; });
  });

  var scored = open.slice(0, 45).map(function (p) {
    var score = p.blendVor, why = [], best = open[0] === p;
    var samePos = open.filter(function (x) { return x.pos === p.pos; });
    var bestAtPos = samePos[0] === p;
    var tierMates = samePos.filter(function (x) { return tierOf(x) === tierOf(p); });

    if (gap[p.pos]) score += unit * 0.14;
    if (tierMates.length <= 2 && tierMates[0] === p) score += unit * 0.10;
    if (p.adp && p.adp - (draft.order.length + 1) >= 10) score += unit * 0.05;

    // Two short sentences that read like a person wrote them. No counts here: a
    // flex slot can be filled by three different positions, so "you need 3 running
    // backs" would contradict the roster panel and confuse rather than help.
    var lead = best ? "The best player left, at any position"
             : bestAtPos ? "The best " + LONGPOS[p.pos] + " left"
             : "Still one of the best available";
    if (gap[p.pos]) lead += ", and you still need a " + LONGPOS[p.pos];
    var tail = "";
    if (tierMates.length === 1) tail = " He is the last one at this level before a real drop.";
    else if (tierMates.length === 2) tail = " Only two are left at this level.";
    var flag = p.inj ? " Listed " + String(p.inj).toLowerCase() + "." : "";
    return {p: p, score: score, why: lead + "." + tail + flag};
  });
  scored.sort(function (a, b) { return b.score - a.score; });
  return scored.slice(0, 3);
}
var LONGPOS = {QB:"quarterback", RB:"running back", WR:"receiver", TE:"tight end",
               K:"kicker", DEF:"defense"};

/* ---------------- render ---------------- */
function render() {
  if (!board) return;
  var seq = ordered();
  renderStrip();
  renderCols(seq);
  renderRail(seq);
  renderFoot();
}

function renderStrip() {
  var em = P.em[board.fmt] || {};
  var lu = cfg.roster.filter(function (s) { return s !== "BN" && s !== "IR"; }).join(" ");
  var bn = cfg.roster.filter(function (s) { return s === "BN"; }).length;
  document.getElementById("strip").innerHTML =
    '<span><i class="k">League</i><b>' + esc(cfg.name || "My league") + '</b></span>'
    + '<span><i class="k">Format</i>' + cfg.teams + " teams · " + esc(cfg.label) + "</span>"
    + '<span><i class="k">Lineup</i>' + esc(lu)
    + ' <span style="color:var(--ink-3)">+' + bn + " bench</span></span>"
    + '<span><i class="k">Consensus</i>' + (em.x || "?") + " experts · " + board.fmt
    + " · updated " + esc(em.u || "?") + "</span>";
}

function renderCols(seq) {
  var q = query.trim().toLowerCase(), html = "";
  board.positions.forEach(function (pos) {
    var all = seq.filter(function (p) { return p.pos === pos; });
    var left = all.filter(function (p) { return !draft.drafted.has(p.sid); }).length;
    var rows = "", lastTier = null;
    all.forEach(function (p) {
      var gone = draft.drafted.has(p.sid);
      if (gone && hideGone) return;
      var hit = q && p.name.toLowerCase().indexOf(q) >= 0;
      if (q && !hit) return;
      var tr = tierOf(p);
      if (!q && tr !== lastTier) {
        var n = all.filter(function (x) {
          return tierOf(x) === tr && !draft.drafted.has(x.sid); }).length;
        rows += '<div class="tsep' + (n ? "" : " spent") + '"><span>Tier ' + tr
              + '</span><i class="ln"></i><span>' + (n ? n + " left" : "gone") + "</span></div>";
        lastTier = tr;
      }
      var tags = (p.rookie ? '<i class="tag rk">R</i>' : "")
        + (p.inj ? '<i class="tag inj">' + esc(String(p.inj).slice(0, 3).toUpperCase()) + "</i>" : "");
      rows += '<div class="r ' + (gone ? "gone " : "") + (draft.mine.has(p.sid) ? "mine" : "")
        + '" data-sid="' + esc(p.sid) + '">'
        + '<i class="band" style="background:' + tv(tierOf(p)) + '"></i>'
        + '<span class="pr">' + p.pos + p._pr + "</span>"
        + '<span class="nm">' + esc(shortName(p.name)) + tags + "</span>"
        + '<span class="tm">' + esc(p.team || "") + (p.bye ? "·" + p.bye : "") + "</span>"
        + '<span class="m1">' + (p.auction ? "$" + p.auction : "–") + "</span>"
        + '<span class="m2">' + (p.ecr ? Math.round(p.ecr) : "–") + "</span></div>";
    });
    html += '<section class="col"><div class="col-h"><span class="pos">' + pos + "</span>"
      + '<span class="repl">repl ' + Math.round(board.repl[pos] || 0) + "</span>"
      + '<span class="meta">' + left + "/" + all.length + " left</span></div>"
      + '<div class="col-sub"><i></i><span>#</span><span>Player</span><span>Tm·Bye</span>'
      + "<span>" + (expert ? "$" : "Value") + "</span><span>"
      + (expert ? "ECR" : "Experts") + "</span></div>"
      + '<div class="rows">' + (rows || '<div class="empty" style="padding:10px">No match.</div>')
      + "</div></section>";
  });
  document.getElementById("cols").innerHTML = html;
}

function renderRail(seq) {
  var lu = lineup(seq), recs = advise(seq, lu), open = openPlayers(seq);
  var n = draft.order.length + 1, rd = Math.floor((n - 1) / cfg.teams) + 1;

  var pickHtml = recs.map(function (r, i) {
    return '<div class="rec" data-sid="' + esc(r.p.sid) + '">'
      + '<i class="band" style="background:' + tv(tierOf(r.p)) + '"></i>'
      + '<span><span class="nm">' + esc(r.p.name) + "</span>"
      + '<div class="why">' + (i === 0 ? "" : esc(LONGPOS[r.p.pos]) + ", " + esc(r.p.team) + " — ")
      + esc(i === 0 ? r.why : r.why.split(".")[0] + ".") + "</div></span>"
      + '<span class="v">' + (r.p.auction ? "$" + r.p.auction : Math.round(r.p.blendVor))
      + "</span></div>";
  }).join("") || '<div class="body"><div class="empty">Board is empty.</div></div>';

  // What the lineup is still missing, said plainly.
  var missing = {};
  lu.filled.forEach(function (f) {
    if (f.p) return;
    var label = FLEXP[f.sl] ? "flex" : LONGPOS[f.sl] || f.sl;
    missing[label] = (missing[label] || 0) + 1;
  });
  var mk = Object.keys(missing);
  var needHtml = mk.length
    ? "You still need " + mk.map(function (k) {
        var n = missing[k];
        return "<b>" + n + " " + k + (n > 1 && k !== "flex" ? "s" : "") + "</b>";
      }).join(", ") + ". Anything after that is bench depth."
    : '<span class="done">Your starting lineup is full.</span> Everything from here is bench depth.';

  var watch = board.positions.map(function (pos) {
    var pool = open.filter(function (p) { return p.pos === pos; });
    if (!pool.length) return "";
    var deep = Math.max.apply(null, board.players.filter(function (p) {
      return p.pos === pos; }).map(tierOf));
    var top = pool[0], lft = pool.filter(function (p) { return tierOf(p) === tierOf(top); }).length;
    if (tierOf(top) >= deep)
      return '<div class="alert warn"><i class="pip">' + pos + "</i><span>"
        + "The good ones are gone. Best left: " + esc(shortName(top.name)) + ".</span></div>";
    var cls = lft <= 2 ? "warn" : lft <= 4 ? "info" : "ok";
    return '<div class="alert ' + cls + '"><i class="pip">' + pos + "</i><span><b>"
      + lft + "</b> left at this level. Best: " + esc(shortName(top.name))
      + ".</span></div>";
  }).join("");

  var recent = draft.order.slice(-10).map(function (sid) {
    return board.players.filter(function (p) { return p.sid === sid; })[0]; }).filter(Boolean);
  var tally = {};
  recent.forEach(function (p) { tally[p.pos] = (tally[p.pos] || 0) + 1; });
  var run = Object.keys(tally).filter(function (k) { return tally[k] >= 5; }).map(function (pos) {
    return '<div class="alert warn"><i class="pip">RUN</i><span><b>' + tally[pos] + " of the last "
      + recent.length + "</b> picks were " + pos + ". That tier will thin out fast.</span></div>";
  }).join("");

  var rosterHtml = lu.filled.map(function (f) {
    return '<div class="sl ' + (f.p ? "on" : "") + '"><i>' + f.sl + "</i>"
      + (f.p ? "<b>" + esc(shortName(f.p.name)) + "</b><em>" + f.p.pos + f.p._pr
               + " · bye " + (f.p.bye || "?") + "</em>"
             : '<span class="mt">open</span>') + "</div>";
  }).join("") + (lu.bench.length
    ? lu.bench.map(function (p) {
        return '<div class="sl"><i>BN</i><b>' + esc(shortName(p.name)) + "</b><em>"
          + p.pos + p._pr + " · bye " + (p.bye || "?") + "</em></div>"; }).join("")
    : "");

  var byes = {};
  lu.filled.forEach(function (f) { if (f.p && f.p.bye) byes[f.p.bye] = (byes[f.p.bye] || 0) + 1; });
  var clash = Object.keys(byes).filter(function (w) { return byes[w] >= 3; }).map(function (w) {
    return '<div class="alert warn"><i class="pip">BYE</i><span><b>' + byes[w]
      + "</b> starters are off in week " + w + ".</span></div>"; }).join("");

  document.getElementById("rail").innerHTML =
    '<div class="card pick"><h2>Take one of these</h2>' + pickHtml + "</div>"
    + '<div class="card"><h2>What you still need</h2>'
    + '<div class="needline">' + needHtml + "</div></div>"
    + '<div class="card"><h2>Round ' + rd + " · pick " + n + "</h2>"
    + '<div class="body"><div class="empty">' + draft.order.length
    + " players off the board. Click a name to mark him taken, or type it in the search "
    + "box and press Enter. Use <b>I drafted him</b> for your own picks.</div></div></div>"
    + (run ? '<div class="card"><h2>Right now</h2><div class="body">' + run + "</div></div>" : "")
    + '<div class="card"><h2>Getting thin</h2><div class="body">' + watch + "</div></div>"
    + (clash ? '<div class="card"><h2>Bye conflict</h2><div class="body">' + clash + "</div></div>" : "")
    + '<div class="card"><h2>My team · ' + lu.mine.length + "</h2>" + rosterHtml + "</div>";
}

function renderFoot() {
  var em = P.em[board.fmt] || {};
  var kd = board.positions.indexOf("K") >= 0 || board.positions.indexOf("DEF") >= 0;
  document.getElementById("foot").innerHTML =
    "<b>How this ranks players.</b> Two independent projection sets are re-scored under "
    + "your league's exact rules and averaged, then measured against the replacement player "
    + "at each position, where replacement is set by how deep your lineup actually drafts "
    + "each position, flex included. That is the <b>Projection</b> ranking. <b>Consensus</b> "
    + "is FantasyPros ECR, the average draft rank of " + (em.x || "~100") + " analysts for "
    + board.fmt + " scoring. <b>Blend</b> converts each expert rank into your league's own "
    + "points and weights consensus 60% against projection 40%.<br><br>"
    + "<b>Take one of these</b> starts from that value and nudges it for what your roster "
    + "still needs and for tiers about to empty. The reason is always shown, so you can "
    + "disagree with it.<br><br>"
    + "<b>Flags.</b> <code>R</code> is a rookie, where projections run low and draft rooms run "
    + "high. Injury tags come from Sleeper."
    + (kd ? " Kickers and defenses use default scoring rather than your points-allowed and "
          + "field-goal tiers, which no source projects. Wait on both." : "")
    + "<br><br>Projections and rankings pulled " + esc(P.gen) + ". Everything is computed in "
    + "your browser; your picks are saved on this device only.";
}

/* ---------------- interaction ---------------- */
function toggle(sid, mine) {
  if (draft.drafted.has(sid)) {
    draft.drafted.delete(sid); draft.mine.delete(sid);
    draft.order = draft.order.filter(function (x) { return x !== sid; });
  } else {
    draft.drafted.add(sid); draft.order.push(sid);
    if (mine) draft.mine.add(sid);
  }
  save(); render();
}
document.addEventListener("click", function (e) {
  var pop = document.getElementById("pop");
  var act = e.target.closest("[data-act]");
  if (act) { toggle(act.dataset.sid, act.dataset.act === "mine"); pop.classList.remove("on"); return; }
  var row = e.target.closest(".r,.rec");
  if (!row) { if (!e.target.closest(".pop")) pop.classList.remove("on"); return; }
  var sid = row.dataset.sid;
  if (e.metaKey || e.ctrlKey || e.shiftKey) { toggle(sid, true); return; }
  if (e.altKey) { toggle(sid, false); return; }
  showPop(row, sid);
});
function showPop(el, sid) {
  var p = board.players.filter(function (x) { return x.sid === sid; })[0];
  if (!p) return;
  var pop = document.getElementById("pop"), gone = draft.drafted.has(sid);
  var notes = [];
  if (p.leagueShift != null && Math.abs(p.leagueShift) >= 15)
    notes.push(p.leagueShift > 0
      ? "Your scoring lifts him " + p.leagueShift + " spots above the consensus."
      : "Your scoring drops him " + (-p.leagueShift) + " spots below the consensus.");
  if (p.ecrSD != null && p.ecrSD >= 12)
    notes.push("Experts are split: ranked as high as " + p.ecrBest + ", as low as " + p.ecrWorst + ".");
  if (p.rookie) notes.push("Rookie. Projections run low, draft rooms run high.");
  if (p.inj) notes.push("Listed " + p.inj + ".");
  if (!p.exact) notes.push("Scored with default rules, not your K/DST tiers.");
  pop.innerHTML = '<div class="pn">' + esc(p.name) + "</div>"
    + '<div class="ps">' + p.pos + p._pr + " · " + esc(p.team || "FA") + " · bye "
    + (p.bye || "–") + " · tier " + tierOf(p) + "</div>"
    + "<dl><dt>Projected</dt><dd>" + p.pts + "</dd>"
    + "<dt>Value over repl.</dt><dd>" + p.vor + "</dd>"
    + "<dt>Auction</dt><dd>$" + p.auction + "</dd>"
    + "<dt>ADP</dt><dd>" + (p.adp ? p.adp.toFixed(1) : "–") + "</dd>"
    + (p.ecr != null ? "<dt>Consensus</dt><dd>" + Math.round(p.ecr) + "</dd>"
        + "<dt>Expert range</dt><dd>" + p.ecrBest + "–" + p.ecrWorst + "</dd>" : "")
    + "</dl>"
    + (notes.length ? '<div class="note">' + notes.map(esc).join("<br>") + "</div>" : "")
    + '<div class="acts"><button data-act="gone" data-sid="' + esc(sid) + '">'
    + (gone ? "Undo" : "Someone took him") + "</button>"
    + '<button data-act="mine" data-sid="' + esc(sid) + '">'
    + (draft.mine.has(sid) ? "Not mine" : "I drafted him") + "</button></div>";
  var r = el.getBoundingClientRect();
  pop.style.left = Math.min(r.left, innerWidth - 260) + "px";
  pop.style.top = Math.min(r.bottom + 5, innerHeight - 250) + "px";
  pop.classList.add("on");
}

/* ---------------- setup screen ---------------- */
function slotInputs() {
  var host = document.getElementById("slotGrid"), def = {QB:1,RB:2,WR:2,TE:1,FLEX:1,SUPER_FLEX:0,K:1,DEF:1,BN:6};
  host.innerHTML = SLOT_ORDER.map(function (s) {
    return '<div class="fld"><label>' + (s === "SUPER_FLEX" ? "SFLEX" : s) + "</label>"
      + '<input type="number" data-slot="' + s + '" value="' + def[s] + '" min="0" max="9"></div>';
  }).join("");
}
function readManual() {
  var fmt = document.querySelector("#fmtSeg button[aria-pressed=true]").dataset.f;
  var teams = +document.getElementById("mTeams").value || 12;
  var ptd = +document.getElementById("mPtd").value || 4;
  var tep = +document.getElementById("mTep").value || 0;
  var roster = [];
  document.querySelectorAll("#slotGrid input").forEach(function (i) {
    for (var k = 0; k < (+i.value || 0); k++) roster.push(i.dataset.slot);
  });
  if (!roster.filter(function (s) { return s !== "BN"; }).length) return null;
  var label = (fmt === "PPR" ? "Full PPR" : fmt === "HALF" ? "Half PPR" : "Standard")
    + ", " + ptd + "pt PaTD" + (tep ? ", TE +" + tep : "");
  return {name: "My league", teams: teams, roster: roster, scoring: preset(fmt, ptd, tep),
          label: label, rounds: +document.getElementById("mRounds").value || 16, budget: 200};
}
function msg(el, cls, text) {
  document.getElementById(el).innerHTML = '<div class="msg ' + cls + '">' + text + "</div>";
}

var pendingLeague = null;
async function loadSleeper() {
  var id = document.getElementById("lgId").value.trim().replace(/\D/g, "");
  if (!id) { msg("lgMsg", "err", "Paste the league ID first."); return; }
  msg("lgMsg", "work", "Looking up your league…");
  document.getElementById("lgGo").disabled = true;
  try {
    var base = "https://api.sleeper.app/v1/league/" + id;
    var lg = await (await fetch(base)).json();
    if (!lg || !lg.roster_positions) throw new Error("no league");
    var users = await (await fetch(base + "/users")).json();
    var draftInfo = {}, picks = [];
    if (lg.draft_id) {
      draftInfo = await (await fetch("https://api.sleeper.app/v1/draft/" + lg.draft_id)).json();
      picks = await (await fetch("https://api.sleeper.app/v1/draft/" + lg.draft_id + "/picks")).json();
      if (!Array.isArray(picks)) picks = [];
    }
    pendingLeague = {lg: lg, users: users || [], draft: draftInfo, picks: picks};
    var sc = lg.scoring_settings || {};
    var rec = sc.rec || 0;
    var label = (rec >= 0.75 ? "Full PPR" : rec >= 0.25 ? "Half PPR" : "Standard")
      + ", " + (sc.pass_td || 4) + "pt PaTD" + (sc.bonus_rec_te ? ", TE +" + sc.bonus_rec_te : "");
    msg("lgMsg", "ok", "Found <b>" + esc(lg.name) + "</b> — " + lg.total_rosters
      + " teams, " + esc(label) + (picks.length ? ", " + picks.length + " picks already made" : "")
      + ".");
    var sel = document.getElementById("whoSel");
    sel.innerHTML = '<option value="">I\'ll track my own picks</option>'
      + (users || []).map(function (u) {
          return '<option value="' + esc(u.user_id) + '">' + esc(u.display_name || u.user_id)
            + "</option>"; }).join("");
    document.getElementById("whoBox").hidden = false;
  } catch (err) {
    msg("lgMsg", "err", "Could not load that league. Check the ID is the long number from the "
      + "league web address, and that the league is on Sleeper for the 2026 season.");
  }
  document.getElementById("lgGo").disabled = false;
}
function commitSleeper() {
  if (!pendingLeague) return;
  var lg = pendingLeague.lg, me = document.getElementById("whoSel").value;
  var sc = lg.scoring_settings || {}, rec = sc.rec || 0;
  cfg = {
    name: lg.name, teams: lg.total_rosters, roster: lg.roster_positions,
    scoring: sc, budget: (pendingLeague.draft.settings || {}).budget || 200,
    rounds: (pendingLeague.draft.settings || {}).rounds || 16,
    label: (rec >= 0.75 ? "Full PPR" : rec >= 0.25 ? "Half PPR" : "Standard")
      + ", " + (sc.pass_td || 4) + "pt PaTD" + (sc.bonus_rec_te ? ", TE +" + sc.bonus_rec_te : ""),
    leagueId: lg.league_id, me: me || null
  };
  var prior = draft || {drafted: new Set(), mine: new Set(), order: []};
  var same = cfg && cfg.leagueId === lg.league_id;
  draft = same
    ? {drafted: new Set(prior.drafted), mine: new Set(prior.mine), order: prior.order.slice()}
    : {drafted: new Set(), mine: new Set(), order: []};
  pendingLeague.picks.forEach(function (p) {
    if (!p.player_id) return;
    if (!draft.drafted.has(p.player_id)) draft.order.push(p.player_id);
    draft.drafted.add(p.player_id);
    if (me && p.picked_by === me) draft.mine.add(p.player_id);
  });
  start();
}

function start() {
  board = build(cfg);
  hideGone = draft.order.length > 0;
  document.getElementById("hide").textContent = hideGone ? "Show drafted" : "Hide drafted";
  document.getElementById("setup").hidden = true;
  document.getElementById("app").hidden = false;
  save(); render();
}

/* ---------------- wiring ---------------- */
document.getElementById("genAt").textContent = (P.gen || "").slice(0, 10);
slotInputs();
document.getElementById("fmtSeg").addEventListener("click", function (e) {
  var b = e.target.closest("button"); if (!b) return;
  Array.prototype.forEach.call(this.children, function (c) {
    c.setAttribute("aria-pressed", String(c === b)); });
});
document.getElementById("lgGo").addEventListener("click", loadSleeper);
document.getElementById("lgId").addEventListener("keydown", function (e) {
  if (e.key === "Enter") loadSleeper(); });
document.getElementById("whoGo").addEventListener("click", commitSleeper);
document.getElementById("mGo").addEventListener("click", function () {
  var c = readManual();
  if (!c) { msg("mMsg", "err", "Give yourself at least one starting spot."); return; }
  // Player ids are stable, so a rules change re-scores the same board without
  // forgetting who has already been taken.
  c.leagueId = cfg && cfg.leagueId;
  c.me = cfg && cfg.me;
  c.name = (cfg && cfg.leagueId) ? cfg.name : c.name;
  cfg = c;
  if (!draft) draft = {drafted: new Set(), mine: new Set(), order: []};
  start();
});
document.getElementById("expert").addEventListener("click", function () {
  expert = !expert;
  this.textContent = expert ? "Simple view" : "Expert view";
  document.getElementById("basisSeg").hidden = !expert;
  if (!expert) {
    basis = "blend";
    Array.prototype.forEach.call(document.querySelectorAll("#basisSeg button"), function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.b === "blend")); });
  }
  render();
});
document.getElementById("basisSeg").addEventListener("click", function (e) {
  var b = e.target.closest("button"); if (!b) return;
  basis = b.dataset.b;
  Array.prototype.forEach.call(this.children, function (c) {
    c.setAttribute("aria-pressed", String(c === b)); });
  document.getElementById("pop").classList.remove("on");
  render();
});
var qBox = document.getElementById("q");
qBox.addEventListener("input", function (e) { query = e.target.value; renderCols(ordered()); });
// Typing a name and pressing Enter marks the top match as taken. Between her own
// picks she may have eleven names to log, and clicking each one is too slow.
qBox.addEventListener("keydown", function (e) {
  if (e.key !== "Enter") return;
  var t = query.trim().toLowerCase();
  if (!t) return;
  var hit = ordered().filter(function (p) {
    return !draft.drafted.has(p.sid) && p.name.toLowerCase().indexOf(t) >= 0; })[0];
  if (!hit) return;
  toggle(hit.sid, e.metaKey || e.ctrlKey || e.shiftKey);
  query = ""; qBox.value = "";
  renderCols(ordered());
});
document.getElementById("hide").addEventListener("click", function () {
  hideGone = !hideGone;
  this.textContent = hideGone ? "Show drafted" : "Hide drafted";
  renderCols(ordered());
});
document.getElementById("undo").addEventListener("click", function () {
  var last = draft.order[draft.order.length - 1];
  if (last) toggle(last, false);
});
// Settings opens prefilled with what is already set, and is escapable. Nothing is
// destroyed by looking: picks survive a settings change, and wiping is its own button.
function openSetup() {
  if (cfg) {
    var rec = (cfg.scoring || {}).rec || 0;
    var f = rec >= 0.75 ? "PPR" : rec >= 0.25 ? "HALF" : "STD";
    Array.prototype.forEach.call(document.querySelectorAll("#fmtSeg button"), function (b) {
      b.setAttribute("aria-pressed", String(b.dataset.f === f));
    });
    document.getElementById("mTeams").value = cfg.teams || 12;
    document.getElementById("mRounds").value = cfg.rounds || 16;
    document.getElementById("mPtd").value = (cfg.scoring || {}).pass_td || 4;
    document.getElementById("mTep").value = (cfg.scoring || {}).bonus_rec_te || 0;
    var counts = {};
    (cfg.roster || []).forEach(function (sl) { counts[sl] = (counts[sl] || 0) + 1; });
    document.querySelectorAll("#slotGrid input").forEach(function (i) {
      i.value = counts[i.dataset.slot] || 0;
    });
    if (cfg.leagueId) {
      document.getElementById("lgId").value = cfg.leagueId;
      document.getElementById("reSyncName").textContent = cfg.name || "my league";
      document.getElementById("reSync").hidden = false;
    }
  }
  document.getElementById("setupTop").hidden = !board;
  document.getElementById("app").hidden = true;
  document.getElementById("setup").hidden = false;
  document.getElementById("whoBox").hidden = true;
  document.getElementById("lgMsg").innerHTML = "";
  document.getElementById("mMsg").innerHTML = "";
  window.scrollTo(0, 0);
}
function closeSetup() {
  if (!board) return;
  document.getElementById("setup").hidden = true;
  document.getElementById("app").hidden = false;
  window.scrollTo(0, 0);
}
document.getElementById("cfg").addEventListener("click", openSetup);
document.getElementById("backBtn").addEventListener("click", closeSetup);
document.getElementById("startOver").addEventListener("click", function () {
  if (!confirm("Clear your league settings AND every player you have marked? "
    + "This cannot be undone.")) return;
  try { localStorage.removeItem(KEY); } catch (e) {}
  location.reload();
});
document.getElementById("reSyncGo").addEventListener("click", function () {
  document.getElementById("lgId").value = cfg.leagueId;
  loadSleeper();
});
addEventListener("keydown", function (e) {
  if (e.key === "Escape") {
    document.getElementById("pop").classList.remove("on");
    if (!document.getElementById("setup").hidden) closeSetup();
  }
});

document.getElementById("htToggle").addEventListener("click", function () {
  var b = document.getElementById("htBody"), open = !b.hidden;
  b.hidden = open;
  this.setAttribute("aria-expanded", String(!open));
  this.innerHTML = "How to use this &nbsp;" + (open ? "\u2193" : "\u2191");
  if (!open && !b.innerHTML) b.innerHTML = HELP;
});
var HELP = ''
  + "<h3>The short version</h3>"
  + "When it is your turn, take the top name under <b>Take one of these</b>. It is "
  + "already weighing who is best, what your roster is missing, and who is about to "
  + "run out. If you do nothing else, that will give you a solid team."
  + "<h3>Keeping the board honest</h3>"
  + "The board is only right if it knows who is gone. Every time anyone drafts "
  + "someone, mark him: click his name, or type it in the search box and press "
  + "Enter. When <b>you</b> draft someone, open him and hit <b>I drafted him</b> so "
  + "he lands on your team. If your league is on Sleeper, this happens by itself."
  + "<h3>What the numbers mean</h3>"
  + "<b>Value</b> is what the player is worth in a $200 auction. It is there to "
  + "compare two players, not because you are spending money. <b>Experts</b> is where "
  + "roughly 100 analysts rank him overall. A player with a good value and a worse "
  + "expert rank is one this board likes more than the crowd does."
  + "<h3>Colours and tags</h3>"
  + "The coloured bar is his tier: players in the same tier are close enough that "
  + "you should not agonise. When a tier is nearly empty, that position is about to "
  + "get much worse, which is what <b>Getting thin</b> is telling you. "
  + "<b>R</b> means rookie. Red tags are injuries."
  + "<h3>Two traps</h3>"
  + "Do not draft a kicker or a defense until the last two rounds, however tempting "
  + "the numbers look. This board will tell you when. And watch <b>bye weeks</b>: if "
  + "too many of your starters are off in the same week, you will be short that week."
  + "<h3>If it goes wrong</h3>"
  + "<b>Undo</b> reverses the last thing you marked. <b>Settings</b> lets you fix your "
  + "league setup without losing your picks.";

if (restore()) start();
})();
