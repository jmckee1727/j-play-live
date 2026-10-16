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
    // Games your account says you've played (on another computer, or online): marked, without details.
    function importIds(ids) {
        read(function(c) {
            let changed = false;
            for (let id of ids || [ ]) if (!c.games[id]) { c.games[id] = { t: 'archive game ' + id, d: '', s: null, w: false, p: 1, n: 1, next: '', cloud: true }; changed = true; }
            if (changed) write();
        });
    }
    function forget() { cache = empty(); write(); }
    // Air dates of games seen in the archive's lists (id -> 'YYYY-MM-DD'), for "the most recent game".
    let dates = null;
    function readDates(cb) {
        if (dates) return cb(dates);
        if (!store) { try { dates = JSON.parse(localStorage.getItem('jpLiveDates')) || { }; } catch (e) { dates = { }; } return cb(dates); }
        store.get([ 'jpLiveDates' ], function(r) { dates = (r && r.jpLiveDates) || { }; cb(dates); });
    }
    function noteDates(found) {
        readDates(function(d) {
            let changed = false;
            for (let id in found) if (d[id] != found[id]) { d[id] = found[id]; changed = true; }
            if (!changed) return;
            let ids = Object.keys(d).map(Number).sort(function(a, b) { return b - a; });
            for (let id of ids.slice(500)) delete d[id];     // the newest 500 are plenty
            if (store) store.set({ jpLiveDates: d }); else { try { localStorage.setItem('jpLiveDates', JSON.stringify(d)); } catch (e) { } }
        });
    }
    function today() { let n = new Date(); return n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0'); }
    // The newest game that aired before today (today's may still be half-entered): { id, aired } or null.
    function newestComplete(d) {
        let best = null, t = today();
        for (let id in d) if (d[id] < t && (!best || +id > best.id)) best = { id: +id, aired: d[id] };
        return best;
    }
    // The game before the last one played, following the chain back over games already played.
    function prevUp(c) {
        if (!c.last) return null;
        let cur = c.last.id, seen = 0;
        while (seen++ < 500) {
            let rec = c.games[cur];
            let p = rec ? rec.prev : '';
            if (!p) return { before: cur, title: (c.games[cur] || c.last).t };
            if (!c.games[p]) return { id: p, before: cur, title: (c.games[cur] || c.last).t };
            cur = p;
        }
        return null;
    }
    // How this person plays, from their last games: 'new' (none yet), 'online' (the last was online),
    // 'newest' (the last was the archive's newest at the time), 'forward' (climbing through the
    // games) or 'backward' (working back in time).
    function style(c) {
        let played = Object.keys(c.games).map(function(id) { return Object.assign({ id: +id }, c.games[id]); }).filter(function(g) { return g.d; });
        if (!played.length) return 'new';
        played.sort(function(a, b) { return a.d < b.d ? 1 : a.d > b.d ? -1 : 0; });
        let last = played[0];
        if (last.o) return 'online';
        if (last.newest) return 'newest';
        if (played.length < 2 || !last.prev && !last.next) return 'forward';
        let prev = played[1];
        return last.id < prev.id ? 'backward' : 'forward';
    }
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
    return { note: note, importScores: importScores, importIds: importIds, get: get, read: read, forget: forget, nextUp: nextUp, prevUp: prevUp, style: style, readDates: readDates, noteDates: noteDates, newestComplete: newestComplete };
})();

// ---- the page: badges, the note on a played game, the continue panel ----
(function() {
    if (!/(^|\.)j-archive\.com$/.test(location.hostname)) return;
    function gameIdOf(s) { let m = (s || '').match(/showgame\.php\?game_id=(\d+)/); return m ? m[1] : ''; }
    function fmtDate(iso) { try { return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }); } catch (e) { return ''; } }
    function money(n) { n = Math.round(+n || 0); return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US'); }
    function el(tag, cls, html) { let e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function(ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]; }); }
    function played(rec) { return rec.cloud && !rec.d ? 'Played (per your account)' : 'Played ' + fmtDate(rec.d) + (typeof rec.s == 'number' ? ' — ' + money(rec.s) + (rec.w ? ', won' : '') : '') + (rec.n > 1 ? ' (' + rec.n + ' times)' : '') + (rec.p > 1 ? ', ' + rec.p + ' players' : ''); }
    let here = gameIdOf(location.pathname + location.search);

    const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };
    function airedIn(text) {
        let m = text.match(/aired\s+(\d{4}-\d{2}-\d{2})/i);
        if (m) return m[1];
        m = text.match(/([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})/);
        if (m && MONTHS[m[1].toLowerCase()]) return m[3] + '-' + String(MONTHS[m[1].toLowerCase()]).padStart(2, '0') + '-' + String(+m[2]).padStart(2, '0');
        return '';
    }
    function noteNewest() {
        let max = +here || 0, found = { };
        document.querySelectorAll('a[href*="showgame.php?game_id="]').forEach(function(a) {
            let id = +gameIdOf(a.getAttribute('href') || '');
            if (id > max) max = id;
            let when = airedIn(a.textContent || '') || airedIn((a.parentElement && a.parentElement.textContent) || '');
            if (id && when) found[id] = when;
        });
        if (here) { let when = airedIn(document.title || ''); if (when) found[here] = when; }
        if (Object.keys(found).length) JPPlayed.noteDates(found);
        if (!max) return;
        try { chrome.storage.local.get([ 'jpLiveMaxGame' ], function(o) { if (!o || !(o.jpLiveMaxGame >= max)) chrome.storage.local.set({ jpLiveMaxGame: max }); }); } catch (e) { }
    }
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
    // The panel: the way this person plays decides the big button (the next
    // game, the previous one, the newest, or online); the other ways are links.
    function panel(c) {
        try { if (sessionStorage.getItem('jpLiveContinueHidden')) return; } catch (e) { }
        if (document.querySelector('.jp-continue')) return;
        JPPlayed.readDates(function(d) {
            let style = JPPlayed.style(c), nx = JPPlayed.nextUp(c), pv = JPPlayed.prevUp(c), newest = JPPlayed.newestComplete(d);
            let last = c.last, lastTitle = last ? (c.games[last.id] || last).t : '';
            let showNo = function(t) { let m = String(t || '').match(/#(\d+)/); return m ? 'Show #' + m[1] : t; };
            let opts = [ ];   // { key, label, href|click, note }
            if (nx && nx.id) opts.push({ key: 'next', label: 'Play the next game', href: 'showgame.php?game_id=' + nx.id + '#jplive-next', note: 'after ' + showNo(nx.title) });
            else if (nx && nx.after) opts.push({ key: 'next', label: 'Play the next game', href: 'showgame.php?game_id=' + nx.after + '#jplive-continue', note: 'after ' + showNo(nx.title) + ', once the archive has it' });
            if (pv && pv.id) opts.push({ key: 'prev', label: 'Play the previous game', href: 'showgame.php?game_id=' + pv.id + '#jplive-next', note: 'before ' + showNo(pv.title) });
            else if (pv && pv.before) opts.push({ key: 'prev', label: 'Play the previous game', href: 'showgame.php?game_id=' + pv.before + '#jplive-prev', note: 'before ' + showNo(pv.title) });
            if (newest && !c.games[newest.id]) opts.push({ key: 'newest', label: style == 'new' ? 'Play yesterday\'s game' : 'Play the most recent game', href: 'showgame.php?game_id=' + newest.id + '#jplive-next', note: 'aired ' + fmtDate(newest.aired + 'T12:00:00') });
            else if (newest) opts.push({ key: 'newest', label: 'The most recent game', note: 'played — check back after the next one airs', dim: true });
            opts.push({ key: 'online', label: 'Play online', href: 'showgame.php?game_id=' + ((nx && (nx.id || nx.after)) || (newest && newest.id) || here || 9537) + '#jplive-online', note: 'friends, or a ranked match' });
            let order = { online: [ 'online', 'next', 'newest', 'prev' ], newest: [ 'newest', 'prev', 'next', 'online' ], 'new': [ 'newest', 'next', 'online' ], backward: [ 'prev', 'next', 'newest', 'online' ], forward: [ 'next', 'newest', 'prev', 'online' ] }[style] || [ 'next', 'online' ];
            let main = null;
            for (let k of order) { main = opts.find(function(o) { return o.key == k && o.href; }); if (main) break; }
            // Already on the page the big button would open: play it here.
            let onIt = main && main.href && gameIdOf(main.href) == here && document.getElementById('live_btn');
            let body = '';
            if (style == 'new') body += '<div class="jp-continue-last">New here? Start with the newest game that\'s complete' + (newest ? '' : ' — open the archive\'s front page or a season list to find it') + '.</div>';
            else if (last) body += '<div class="jp-continue-last">Last played: ' + esc(lastTitle) + (last.id == here ? ' (this page)' : '') + '</div>';
            if (main) body += '<div class="jp-continue-actions">' + (onIt ? '<button class="jp-continue-go" data-key="' + main.key + '">▶ ' + esc(main.label) + '</button>' : '<a class="jp-continue-go" href="' + esc(main.href) + '">▶ ' + esc(main.label) + '</a>') + (main.note ? ' <span class="jp-continue-note">' + esc(main.note) + '</span>' : '') + '</div>';
            let rest = opts.filter(function(o) { return o !== main; });
            if (rest.length) body += '<div class="jp-continue-more">' + rest.map(function(o) { return o.href ? '<div><a href="' + esc(o.href) + '">' + esc(o.label) + '</a>' + (o.note ? ' <span class="jp-continue-note">— ' + esc(o.note) + '</span>' : '') + '</div>' : '<div class="jp-continue-dim">' + esc(o.label) + (o.note ? ' <span class="jp-continue-note">— ' + esc(o.note) + '</span>' : '') + '</div>'; }).join('') + '</div>';
            let box = el('div', 'jp-continue', '<div class="jp-continue-head">J-Play Live <button class="jp-continue-x" title="Hide for now">×</button></div>' + body);
            document.body.appendChild(box);
            box.querySelector('.jp-continue-x').onclick = function() { box.remove(); try { sessionStorage.setItem('jpLiveContinueHidden', '1'); } catch (e) { } };
            let go = box.querySelector('button.jp-continue-go');
            if (go) go.onclick = function() { let b = document.getElementById('live_btn'); if (b) b.click(); box.remove(); };
        });
    }
    function run() {
        noteNewest();
        JPPlayed.read(function(c) {
            // Games saved on this site before the list existed (or after the extension was reinstalled) fill it back in.
            try { let saved = JSON.parse(localStorage.getItem('jpLiveScores') || '[]'); if (saved.length) JPPlayed.importScores(saved); } catch (e) { }
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
