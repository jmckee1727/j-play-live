// wagers.js -- how the simulated contestants wager.
//
// Final Jeopardy! follows the textbook game theory that regular viewers know:
//
//   Leader (L) vs second (S):
//     * L > 2S  ("lock" / runaway): the leader cannot be caught. Wager up to
//       L - 2S - 1 and keep the guarantee.
//     * L == 2S: wager $1 (a correct response wins outright; a tie is avoided).
//     * otherwise: the "shore-up" wager 2S - L + 1, which beats a doubled
//       second place by $1. Nothing more -- more only adds risk.
//   Second place:
//     * leader has a lock: can't win; protect second place from third
//       (wager S - 2T - 1 when that is possible, otherwise everything).
//     * S > 3/4 L: wager L - S + 1 -- beats the leader by $1 if the leader
//       stands pat, and still beats a leader who shores up and misses.
//     * 2/3 L < S <= 3/4 L: the "cover" wager, a small amount (<= 3S - 2L)
//       that wins whenever the leader shores up and misses, regardless of
//       your own response -- as long as third can't catch you (S > 2T).
//     * S <= 2/3 L: go for it -- L - S + 1 if that is affordable, else all in.
//   Everyone else: all in.
//
// Daily Doubles are less formulaic on the show; the heuristic here aims for
// "what a sensible contestant does": small when far ahead, the maximum
// allowed when the score is small, enough to take the lead when behind,
// and a moderate fraction of the score otherwise.

var JPWagers = (function() {
    'use strict';

    function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
    function money(n) {
        let s = String(Math.abs(Math.round(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        return (n < 0 ? '-$' : '$') + s;
    }

    // scores: { name: score } for all players. who: the contestant wagering.
    // Returns { wager, why } -- why is a short explanation for the reveal.
    function finalWager(who, scores) {
        let me = scores[who] || 0;
        if (me <= 0) return { wager: 0, why: 'not eligible for Final Jeopardy!' };

        // Standings among eligible players (score > 0), highest first.
        let names = Object.keys(scores).filter(function(n) { return scores[n] > 0; });
        names.sort(function(a, b) { return scores[b] - scores[a] || a.localeCompare(b); });
        let rank = names.indexOf(who);
        let others = names.filter(function(n) { return n != who; });
        if (!others.length) return { wager: 0, why: 'no one else can play; nothing to gain' };

        let L = scores[names[0]], S = names.length > 1 ? scores[names[1]] : 0, T = names.length > 2 ? scores[names[2]] : 0;
        let leaderName = names[0], secondName = names.length > 1 ? names[1] : null, thirdName = names.length > 2 ? names[2] : null;

        if (rank == 0) {
            // I'm the leader.
            if (me > 2 * S) {
                let w = me - 2 * S - 1;
                return { wager: w, why: 'a runaway: a doubled ' + secondName + ' still falls short, so ' + money(w) + ' keeps the win locked' };
            }
            if (me == 2 * S)
                return { wager: 1, why: 'exactly double ' + secondName + '; $1 wins outright with a correct response and avoids a tie' };
            let w = 2 * S - me + 1;
            return { wager: w, why: 'the shore-up: $1 more than a doubled ' + secondName + ', and no more' };
        }

        if (rank == 1) {
            // I'm in second. L is the leader's score.
            let third = T;
            if (L > 2 * me) {
                // Leader has a lock.
                if (thirdName && me > 2 * third) {
                    let w = me - 2 * third - 1;
                    return { wager: w, why: leaderName + ' has a runaway; ' + money(w) + ' keeps second place safe from a doubled ' + thirdName };
                }
                return { wager: me, why: leaderName + ' has a runaway and second place isn\'t safe either; all in' };
            }
            let beatByOne = L - me + 1;
            if (me * 4 > L * 3) {
                return { wager: beatByOne, why: '$1 past ' + leaderName + '\'s ' + money(L) + ' in case the leader stands pat; still wins if the leader shores up and misses' };
            }
            if (me * 3 > L * 2 && (!thirdName || me > 2 * third)) {
                let cover = 3 * me - 2 * L;                       // max small wager that still beats a leader who shores up and misses
                if (thirdName) cover = Math.min(cover, me - 2 * third - 1);
                cover = clamp(cover, 0, me);
                return { wager: cover, why: 'above two-thirds of ' + leaderName + '\'s score: a small wager wins whenever the leader misses, right or wrong' };
            }
            if (beatByOne <= me)
                return { wager: beatByOne, why: 'needs ' + leaderName + ' to miss; enough to pass ' + money(L) + ' by $1' };
            return { wager: me, why: 'needs ' + leaderName + ' to miss and can\'t reach the lead otherwise; all in' };
        }

        // Third or lower: all in.
        return { wager: me, why: 'in ' + (rank == 2 ? 'third' : 'fourth') + ' place; only a big wager and misses above can win, so all in' };
    }

    // Daily Double wager for a contestant.
    //   score:  their current score
    //   others: array of the other players' scores
    //   base:   the round's top clue value ($1,000 / $2,000)
    //   cluesLeft: clues still on the board in this round (0..30)
    // Returns { wager, why }.
    function dailyDoubleWager(score, others, base, cluesLeft) {
        let allowedMax = Math.max(score, base);
        let top = others.length ? Math.max.apply(null, others) : 0;
        let round100 = function(x) { return Math.max(100, Math.round(x / 100) * 100); };

        if (score <= 0)
            return { wager: base, why: 'nothing to lose; wagers the maximum allowed' };

        if (score < base)
            return { wager: allowedMax, why: 'a small score, so the maximum allowed: ' + money(allowedMax) };

        if (score <= 2 * base) {
            let w = clamp(round100(score * 0.6), base, score);
            return w == score ? { wager: w, why: 'makes it a true Daily Double' }
                              : { wager: w, why: 'a small score, so a big swing: ' + money(w) };
        }

        if (score > 2 * top + 2 * base) {
            let w = round100(Math.min(base, score * 0.15));
            return { wager: w, why: 'far ahead; a modest ' + money(w) + ' keeps the lead safe' };
        }

        if (score < top) {
            // Behind: try to take the lead, but not by risking a hopeless hole.
            let need = top - score + 200;
            if (need <= score) {
                let w = clamp(round100(Math.max(need, base / 2)), base / 2, score);
                return { wager: w, why: 'behind ' + money(top) + '; wagers ' + money(w) + ' to take the lead' };
            }
            return { wager: score, why: 'well behind; a true Daily Double is the only way back' };
        }

        // Leading modestly.
        let frac = cluesLeft > 15 ? 0.25 : 0.3;
        let w = clamp(round100(score * frac), base / 2, Math.min(base * 2, score));
        return { wager: w, why: 'in the lead; a measured ' + money(w) };
    }

    return { finalWager: finalWager, dailyDoubleWager: dailyDoubleWager };
})();
