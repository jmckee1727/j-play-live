// played.js -- the games you've finished, on every J! Archive page: a check
// next to each one in the lists, a note on the game's own page, and a small
// panel to pick up where you left off (the next game after the last one you
// played). live.js records a game here when it ends. Everything stays in the
// extension's own storage on this computer; nothing is sent anywhere.
window.JPPlayed = (function() {
    const KEY = 'jpLivePlayed', LAST = 'jpLiveLast';
    let store = null;
    try { store = chrome.storage && chrome.storage.local; } catch (e) { }
    let cache = null;   // { games: { id: rec }, last: { id, t, d, next } }

    function empty() { return { games: { }, last: null }; }
    function read(cb) {
        if (cache) return cb(cache);
        if (!store) { cache = fromLocal(); return cb(cache); }
        store.get([ KEY, LAST ], function(r) { cache = { games: (r && r[KEY]) || { }, last: (r && r[LAST]) || null }; cb(cache); });
    }
    function write() {
        if (store) { let o = { }; o[KEY] = cache.games; o[LAST] = cache.last; store.set(o); }
        else toLocal();
    }
    function fromLocal() { try { return JSON.parse(localStorage.getItem(KEY)) || empty(); } catch (e) { return empty(); } }
    function toLocal() { try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch (e) { } }

    // rec: { t: title, d: ISO date, s: score, w: won, p: people at the keyboard,
    // next: id of the game after this one, when the page had a link to it }
    function note(id, rec, cb) {
        if (!id) return;
        read(function(c) {
            let old = c.games[id] || { };
            let again = old.d && old.d != rec.d;
            c.games[id] = Object.assign({ }, old, rec, { n: (old.n || 0) + (old.d == rec.d ? 0 : 1), next: rec.next || old.next || '' });
            c.last = { id: id, t: rec.t, d: rec.d, next: c.games[id].next };
            write();
            if (cb) cb(c, again);
        });
    }
    // Games finished before this list existed: fill it in from the saved scores.
    function importScores(list) {
        read(function(c) {
            let changed = false, latest = c.last;
            for (let e of list || [ ]) {
                if (!e.gameId) continue;
                if (!c.games[e.gameId]) { c.games[e.gameId] = { t: e.game, d: e.date, s: e.score, w: !!e.won, p: 1, n: 1, next: '' }; changed = true; }
                if (!latest || (e.date > latest.d)) { latest = { id: e.gameId, t: e.game, d: e.date, next: c.games[e.gameId].next || '' }; changed = true; }
            }
            if (changed) { c.last = latest; write(); }
        });
    }
    function get(id, cb) { read(function(c) { cb(c.games[id] || null, c); }); }
    function forget() { cache = empty(); write(); }
    // The game to play next: follow the chain from the last game played until
    // an unplayed one; { id } when known, { after: id } when the last game in
    // the chain had no "next game" link yet (it was the newest at the time).
    function nextUp(c) {
        if (!c.last) return null;
        let cur = c.last.id, seen = 0;
        while (seen++ < 500) {
            let rec = c.games[cur];
            let n = rec ? rec.next : c.last.next;
            if (!n) return { after: cur, title: (c.games[cur] || c.last).t };
            if (!c.games[n]) return { id: n, after: cur, title: (c.games[cur] || c.last).t };
            cur = n;
        }
        return null;
    }
    return { note: note, importScores: importScores, get: get, read: read, forget: forget, nextUp: nextUp };
})();

// ---- the page: badges, the note on a played game, the continue panel ----
(function() {
    if (!/(^|\.)j-archive\.com$/.test(location.hostname)) return;
    function gameIdOf(s) { let m = (s || '').match(/showgame\.php\?game_id=(\d+)/); return m ? m[1] : ''; }
    function fmtDate(iso) { try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); } catch (e) { return ''; } }
    function money(n) { n = Math.round(+n || 0); return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US'); }
    function el(tag, cls, html) { let e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function(ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]; }); }
    function played(rec) { return 'Played ' + fmtDate(rec.d) + (typeof rec.s == 'number' ? ' — ' + money(rec.s) + (rec.w ? ', won' : '') : '') + (rec.n > 1 ? ' (' + rec.n + ' times)' : '') + (rec.p > 1 ? ', ' + rec.p + ' players' : ''); }
    let here = gameIdOf(location.pathname + location.search);

    function badges(c) {
        document.querySelectorAll('a[href*="showgame.php?game_id="]').forEach(function(a) {
            let id = gameIdOf(a.getAttribute('href') || ''), rec = id && c.games[id];
            if (!rec || a.dataset.jpPlayed) return;
            a.dataset.jpPlayed = '1';
            let b = el('span', 'jp-played-badge', '✓');
            b.title = played(rec);
            a.insertAdjacentElement('afterend', b);
        });
    }
    // On a game you've played: a line next to the Play Live button.
    function noteHere(c) {
        let rec = here && c.games[here];
        if (!rec) return;
        let tries = 0, t = setInterval(function() {
            let btn = document.getElementById('live_btn');
            if (!btn && ++tries < 40) return;
            clearInterval(t);
            if (!btn) return;
            let old = document.querySelector('.jp-played-note');
            if (old) old.remove();
            btn.insertAdjacentElement('afterend', el('span', 'jp-played-note', '✓ ' + esc(played(rec))));
        }, 100);
    }
    function panel(c) {
        let nx = JPPlayed.nextUp(c);
        if (!nx) return;
        try { if (sessionStorage.getItem('jpLiveContinueHidden')) return; } catch (e) { }
        if (document.querySelector('.jp-continue')) return;
        let isNext = nx.id && nx.id == here, isLast = nx.after == here;
        let body;
        if (isNext) body = '<b>This is the next game</b> after the last one you played (' + esc(nx.title) + ').<div class="jp-continue-actions"><button class="jp-continue-go">▶ Play it</button></div>';
        else if (nx.id) body = '<b>Pick up where you left off</b><div class="jp-continue-last">Last played: ' + esc(nx.title) + '</div><div class="jp-continue-actions"><a class="jp-continue-go" href="showgame.php?game_id=' + nx.id + '#jplive-next">▶ Play the next game</a></div>';
        else body = '<b>Pick up where you left off</b><div class="jp-continue-last">Last played: ' + esc(nx.title) + (isLast ? ' (this one)' : '') + '.</div><div class="jp-continue-actions"><a class="jp-continue-go" href="showgame.php?game_id=' + nx.after + '#jplive-continue">▶ Play the game after it</a></div>';
        let box = el('div', 'jp-continue', '<div class="jp-continue-head">J-Play Live <button class="jp-continue-x" title="Hide for now">×</button></div>' + body);
        document.body.appendChild(box);
        box.querySelector('.jp-continue-x').onclick = function() { box.remove(); try { sessionStorage.setItem('jpLiveContinueHidden', '1'); } catch (e) { } };
        let go = box.querySelector('button.jp-continue-go');
        if (go) go.onclick = function() { let b = document.getElementById('live_btn'); if (b) b.click(); box.remove(); };
    }
    function run() {
        JPPlayed.read(function(c) {
            badges(c);
            noteHere(c);
            panel(c);
        });
    }
    if (document.readyState == 'loading') document.addEventListener('DOMContentLoaded', run); else run();
    // A game finished on this page: the badges and the note follow.
    try {
        if (chrome.storage && chrome.storage.onChanged) chrome.storage.onChanged.addListener(function(ch, area) {
            if (area != 'local' || !(ch.jpLivePlayed || ch.jpLiveLast)) return;
            JPPlayed.read(function(c) {
                if (ch.jpLivePlayed) c.games = ch.jpLivePlayed.newValue || { };
                if (ch.jpLiveLast) c.last = ch.jpLiveLast.newValue || null;
                badges(c); noteHere(c);
                let old = document.querySelector('.jp-continue'); if (old) old.remove();
                panel(c);
            });
        });
    } catch (e) { }
})();
