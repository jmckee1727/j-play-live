// live.js -- the "Play Live" game mode.
//
// Uses the data that archive.js scraped from the J! Archive page (clues,
// values, who rang in right/wrong and in what order, Daily Double and Final
// Jeopardy! wagers) to run a game you play in real time:
//
//   * the host reads each clue aloud (JPAudio.speak)
//   * when the reading ends the "lights" come on and the buzzers arm
//   * the original contestants who responded in the broadcast try to ring in,
//     each at a randomized reaction time set by the difficulty
//   * if you win the buzz, you answer by voice (or typing) and JPJudge decides
//   * scores, board control, Daily Doubles and Final Jeopardy! all follow
//     the show's rules, using the archived outcomes for the contestants
//
// Everything is a small state machine driven by async functions. Each flow
// captures `runToken` and bails out if the game is quit or restarted.

var liveActive = false;   // archive.js checks this to stay out of the way
var startLiveGame;        // wired to the "Play Live" button in archive.js

(function() {
    'use strict';

    const YOU = 'You';

    const DEFAULTS = {
        difficulty: 'easy',      // easy | medium | hard | champion | custom
        customMedian: 500,       // ms, when difficulty == custom
        customSpread: 0.65,      // log-normal sigma: 0.4 tight, 0.65 normal, 0.9 wide
        buzzKey: ' ',            // ' ' | 'b' | 'j' | 'k' | 'Shift'
        hostVoice: '',           // voice name; '' = auto
        rate: 1.15,                   // the host's reading speed; shown to the user relative to this (1.15 reads as 1.00×)
        settingsVersion: 3,
        answerMode: 'speech',    // speech | typed
        contestantVoices: true,
        contestantEngine: 'neural',   // 'neural' (studio voices, when the host uses one) or 'system'
        voicePick: true,              // pick clues by voice ("Science for 600") when answering by voice
        readCategories: true,
        sfx: true,
        upper: true,
        answerSeconds: 5,
        buzzWindowSeconds: 5,
        lockoutMs: 250,
        ddAnswerSeconds: 8,
        fjSeconds: 30,
        autoAdvanceMs: 800,           // wait after a clue resolves before moving on (click/Space skips it)
        voiceEngine: 'neural',        // 'neural' = studio voice (on-device model), 'system' = OS voice
        neuralVoice: 'am_michael',
        neuralDevice: 'auto',         // auto | webgpu | wasm
        onboardedVoice: false,        // the one-time studio-voice notice has been seen
        earEngine: 'studio',          // 'studio' (on-device Whisper, when downloaded) or 'chrome' (Chrome's built-in recognizer)
        earSize: 'base',              // 'base' | 'small'
        earDevice: 'auto',            // 'auto' | 'webgpu' | 'wasm'
    };
    // Reaction times are log-normal: the median is what the difficulty
    // promises, nobody rings in impossibly early, and there's a long right
    // tail for the clues nobody is sure about (a second or two of thinking,
    // occasionally almost the whole window). sigma 0.65 puts about 16% of
    // ring-ins under 0.52x the median and 16% over 1.9x; 2.5% over 3.6x.
    const BASE_RATE = 1.15;           // what the speed slider calls 1.00×
    const DIFFICULTY = {
        easy:     { median: 1000, sigma: 0.65, label: 'Easy (contestants typically ring in ~1 s after the lights)' },
        medium:   { median: 500,  sigma: 0.65, label: 'Medium (~0.5 s)' },
        hard:     { median: 300,  sigma: 0.65, label: 'Hard (~0.3 s)' },
        champion: { median: 200,  sigma: 0.6,  label: 'Champion (~0.2 s)' },
        custom:   { median: 500, sigma: 0.65, label: 'Custom' },
    };
    const HOST_RIGHT = [ 'Yes.', 'Correct.', 'That\'s it.', 'Right.', 'Yes, that\'s right.' ];
    const HOST_WRONG = [ 'No.', 'Sorry, no.', 'That is incorrect.', 'No, sorry.' ];

    let S = Object.assign({ }, DEFAULTS);
    let G = null;          // game state
    let U = null;          // UI element refs
    let runToken = 0;
    let handlers = { buzz: null, override: null, cont: null, pick: null };
    let voiceMap = { };    // contestant -> SpeechSynthesisVoice
    let hostVoice = null;

    // ------------------------------------------------------------ utilities

    function alive(tok) { return liveActive && tok === runToken; }

    // All game waits run on JPClock so the Pause button freezes them.
    function sleep(ms, tok) {
        return new Promise(function(resolve) {
            JPClock.setTimeout(function() { resolve(alive(tok)); }, ms);
        });
    }

    // Sleep that can be cut short with a click, the buzz key, or Enter.
    function pause(ms, tok) {
        return new Promise(function(resolve) {
            let t = JPClock.setTimeout(done, ms);
            function done() { JPClock.clearTimeout(t); handlers.cont = null; resolve(alive(tok)); }
            handlers.cont = done;
        });
    }

    function gauss(mean, sd) {
        let u = 0, v = 0;
        while (u === 0) u = Math.random();
        while (v === 0) v = Math.random();
        return mean + sd * Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    }

    function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

    function money(n) {
        let s = String(Math.abs(Math.round(n)));
        s = s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        return (n < 0 ? '-$' : '$') + s;
    }

    function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

    function esc(s) {
        return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    function h(tag, cls, html) {
        let e = document.createElement(tag);
        if (cls) e.className = cls;
        if (html != null) e.innerHTML = html;
        return e;
    }

    function loadSettings() {
        try {
            let saved = JSON.parse(localStorage.getItem('jpLiveSettings') || '{}');
            if (saved.customMean && !saved.customMedian) saved.customMedian = saved.customMean;   // pre-0.4.1 settings
            delete saved.customMean; delete saved.customSd;
            // Settings saved before the default speed went up keep an untouched 1.00 slider: move it with the default.
            if (!(saved.settingsVersion >= 2)) { if (saved.rate == null || +saved.rate == 1) saved.rate = 1.08; saved.settingsVersion = 2; }
            // v3: the default speed became 1.15 and the pauses between clues shorter; settings still at the old defaults follow.
            if (!(saved.settingsVersion >= 3)) {
                if (saved.rate == null || Math.abs(+saved.rate - 1.08) < 0.001) saved.rate = DEFAULTS.rate;
                if (saved.autoAdvanceMs == null || +saved.autoAdvanceMs == 1200 || +saved.autoAdvanceMs == 1800) saved.autoAdvanceMs = DEFAULTS.autoAdvanceMs;
                saved.settingsVersion = 3;
            }
            S = Object.assign({ }, DEFAULTS, saved);
        } catch (e) { S = Object.assign({ }, DEFAULTS); }
    }
    function saveSettings() {
        try { localStorage.setItem('jpLiveSettings', JSON.stringify(S)); } catch (e) { }
    }

    // mult scales the median for this particular ring-in (clue difficulty, rebounds).
    function reaction(mult) {
        let d = S.difficulty == 'custom' ? { median: +S.customMedian || 500, sigma: +S.customSpread || 0.65 } : (DIFFICULTY[S.difficulty] || DIFFICULTY.easy);
        let z = gauss(0, 1);
        return clamp(d.median * (mult || 1) * Math.exp(d.sigma * z), 90, 4900);
    }

    // How much slower than the difficulty's median a ring-in on this clue
    // should be. The archive doesn't record ring-in times, but it does record
    // how hard a clue was: its row on the board (the $200 row is answered on
    // reflex, the bottom row after a think), whether it took a miss before
    // someone got it (a rebound ring-in is a more hesitant one), and, rarely,
    // an ellipsis in the transcription before anyone responded (time passed).
    const ROW_MULT = { 1: 0.8, 2: 0.9, 3: 1.0, 4: 1.15, 5: 1.3 };
    function ringInMult(info, isRebound) {
        let m = ROW_MULT[info.row] || 1;
        if (isRebound) m *= 1.35;
        if (info.slowStart) m *= 1.6;
        return m;
    }

    // ----------------------------------------------------- archive adapters

    function realNames() {
        return nicknames.slice(0, 3).filter(function(n) { return n && !/Coryat/.test(n); });
    }

    function categoryInfo(idx) {
        let el = categories[idx];
        if (!el) return { name: '', comments: '' };
        let n = el.querySelector('.category_name'), c = el.querySelector('.category_comments');
        return { name: n ? n.innerText.trim() : el.innerText.trim(), comments: c ? c.innerText.trim() : '' };
    }

    function roundOf(num) { return num <= 30 ? 'J' : num <= 60 ? 'DJ' : 'FJ'; }

    function roundNums(round) {
        let out = [ ];
        let lo = round == 'J' ? 1 : 31, hi = round == 'J' ? 30 : 60;
        for (let n = lo; n <= hi; n++)
            if (clues[n] && clues[n].id) out.push(n);
        return out;
    }

    function roundMaxValue(round) {
        let nums = roundNums(round), m = 0;
        for (let n of nums) m = Math.max(m, clues[n].value || 0);
        return m || (round == 'J' ? 1000 : 2000);
    }

    function roundLowest(round) {
        let nums = roundNums(round), lo = Infinity;
        for (let n of nums) {
            let p = position(n);
            if (p && clues[n].value) lo = Math.min(lo, clues[n].value / p.row);
        }
        return isFinite(lo) ? lo : (round == 'J' ? 200 : 400);
    }

    function position(num) {
        let c = clues[num];
        if (!c || !c.id) return null;
        let m = c.id.match(/^clue_(J|DJ)_(\d)_(\d)$/);
        if (!m) return null;
        return { col: +m[2], row: +m[3], catIdx: (m[1] == 'J' ? 0 : 6) + (+m[2] - 1) };
    }

    // Wrong responders' actual (mis)responses, when the archive recorded them
    // in the banter, e.g. "(Mark: What is a mirror?)".
    function wrongResponseText(clue, who) {
        let html = clue.raw_response_html || '';
        let re = new RegExp('\\(' + who.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\s*([^)]*?\\?)\\)', 'i');
        let m = re.exec(html);
        if (m) return JPJudge.stripHtml(m[1]).trim();
        return '';
    }

    // How a response to this clue is phrased ("Who is", "What are", ...): see interpret.js.
    function questionWord(info) {
        return JPInterpret.phrase({ category: info.category.name, clueText: info.queryText, answer: info.abbrev || info.correct });
    }

    function clueInfo(num) {
        let c = clues[num];
        let info = { num: num, id: c.id, value: c.value || 0, dd: !!c.dd_wager, dd_wager: c.dd_wager || 0,
                     queryHtml: '', queryText: '', correct: '', abbrev: '', right: [ ], wrong: [ ], sequence: [ ],
                     media: [ ], category: { name: '', comments: '' }, ok: true };
        let p = position(num);
        if (p) info.category = categoryInfo(p.catIdx);
        try {
            finishClueParsing(c);
            info.queryHtml = c.query || '';
            info.correct = c.correct_response || '';
            info.abbrev = c.abbrev_response || info.correct;
            info.right = (c.right || [ ]).slice();
            info.wrong = (c.wrong || [ ]).slice();
        } catch (e) {
            info.ok = false;
            info.queryHtml = (document.getElementById(c.id) || { innerHTML: '' }).innerHTML;
            let r = document.getElementById(c.id + '_r');
            let m = r ? r.innerHTML.match(/class="correct_response">(.*?)<\/em>/) : null;
            info.correct = m ? m[1] : '(unknown)';
            info.abbrev = info.correct;
        }
        // Media links inside the clue.
        let m, re = /<a href="([^"]+?)"/g;
        while ((m = re.exec(info.queryHtml)) !== null) info.media.push(m[1]);
        // Linked words stay in the text (the link is just the media); JPReader makes it readable.
        info.queryText = JPReader.clueToSpeech(info.queryHtml.replace(/<a [^>]*>(.*?)<\/a>/g, '$1'));
        info.phrase = questionWord(info);
        // Broadcast response sequence: the wrong ones first (in order), then the right one.
        for (let w of info.wrong) info.sequence.push({ who: w, right: false });
        for (let r of info.right) info.sequence.push({ who: r, right: true });
        // Only real contestants can ring in.
        let names = realNames();
        info.sequence = info.sequence.filter(function(x) { return names.indexOf(x.who) >= 0; });
        info.row = p ? p.row : 3;
        // "..." in the transcription before anyone rang in: the room went quiet
        // first. Host lines that call on a contestant ("(Ken: Mark?)") mean a
        // ring-in already happened, so those don't count.
        info.slowStart = false;
        let banter = String(c.raw_response_html || '').split('<table')[0].replace(/<[^>]+>/g, ' ');
        if (banter.indexOf('...') >= 0) {
            let before = banter.split('...')[0]
                .replace(/\[[^\]]*\]/g, ' ')                                     // [Laughter], [Applause]
                .replace(/\(([A-Z][a-z]+):([^)]*)\)/g, function(all, who, said) {   // host asides that don't involve a contestant
                    if (names.indexOf(who) >= 0) return 'X';
                    return names.some(function(n) { return said.indexOf(n) >= 0; }) ? 'X' : ' ';
                });
            info.slowStart = before.trim() === '';
        }
        return info;
    }

    function fjInfo() {
        let c = clues[61];
        if (!c || !c.id || !c.fj_order) return null;
        let info = { queryHtml: c.query || '', correct: c.correct_response || '', category: categoryInfo(12), players: { } };
        info.queryText = JPReader.clueToSpeech(info.queryHtml.replace(/<a [^>]*>(.*?)<\/a>/g, '$1'));
        info.abbrev = info.correct;
        info.phrase = questionWord(info);
        for (let o of c.fj_order) {
            let html = c.response[o.who] || '';
            let m = html.match(/^<p>[^:]*:\s*(.*?)<p>/);
            info.players[o.who] = { right: !!o.right, wager: Math.abs(c.scores[o.who] || 0), response: m ? JPJudge.stripHtml(m[1]).trim() : (o.right ? info.correct : '') };
        }
        return info;
    }

    // A contestant's Final wager in this game comes from JPWagers.finalWager,
    // the textbook game theory applied to the live scores (yours included).

    // ------------------------------------------------------------------ UI

    function buildOverlay() {
        if (U) return;
        let root = h('div');
        root.id = 'jp_live';
        root.style.display = 'none';
        root.innerHTML =
            '<div class="jp-top"><div class="jp-round"></div><div class="jp-cat"></div><div class="jp-val"></div>' +
            '<div class="jp-timer"><div class="jp-timer-fill"></div></div></div>' +
            '<div class="jp-stage"></div>' +
            '<div class="jp-answer"><div class="jp-mic"></div><input class="jp-input" type="text" autocomplete="off" spellcheck="false" placeholder="Type your response and press Enter">' +
            '<div class="jp-heard"></div></div>' +
            '<div class="jp-podiums"></div>' +
            '<div class="jp-foot"><div class="jp-hint"></div><button class="jp-pause-btn">&#10074;&#10074; Pause</button><button class="jp-settings-btn">Settings</button><button class="jp-quit-btn">Quit</button></div>';
        document.body.appendChild(root);
        U = {
            root: root,
            round: root.querySelector('.jp-round'),
            cat: root.querySelector('.jp-cat'),
            val: root.querySelector('.jp-val'),
            timer: root.querySelector('.jp-timer'),
            timerFill: root.querySelector('.jp-timer-fill'),
            stage: root.querySelector('.jp-stage'),
            answer: root.querySelector('.jp-answer'),
            input: root.querySelector('.jp-input'),
            mic: root.querySelector('.jp-mic'),
            heard: root.querySelector('.jp-heard'),
            podiums: root.querySelector('.jp-podiums'),
            hint: root.querySelector('.jp-hint'),
        };
        watchClueSize();
        root.querySelector('.jp-pause-btn').onclick = function() { showPauseMenu(); };
        root.querySelector('.jp-quit-btn').onclick = function() { showPauseMenu(); };
        root.querySelector('.jp-settings-btn').onclick = function() { showPauseMenu(true); };

        // The mouse is a buzzer too. Mouse-down (not click) rings in, since it
        // fires the moment the button goes down; a click advances when the
        // game is waiting for you. Interactive controls are left alone.
        function clickable(target) {
            if (pauseEl) return false;
            if (!target || !target.closest) return false;
            if (target.closest('a, button, input, select, textarea, label, option, .jp-foot, .jp-dialog, .jp-cell.jp-pickable')) return false;
            let panel = target.closest('.jp-panel');
            if (panel && !panel.classList.contains('jp-clickthrough')) return false;
            return true;
        }
        root.addEventListener('mousedown', function(e) {
            if (e.button !== 0 || !clickable(e.target)) return;
            if (handlers.buzz) { e.preventDefault(); handlers.buzz(); }
        });
        root.addEventListener('click', function(e) {
            if (e.button !== 0 || !clickable(e.target)) return;
            if (!handlers.buzz && handlers.cont) { e.preventDefault(); handlers.cont(); }
        });
        U.input.addEventListener('keydown', function(e) {
            if (e.key == 'Enter') { e.preventDefault(); e.stopPropagation(); if (handlers.submit) handlers.submit(U.input.value); }
            else if (e.key == 'Escape') { e.preventDefault(); e.stopPropagation(); showPauseMenu(); }
            else e.stopPropagation();
        });
    }

    function setHeader(round, cat, val) {
        U.round.textContent = round || '';
        U.cat.textContent = cat || '';
        U.val.textContent = val || '';
    }

    function setHint(html) { U.hint.innerHTML = html || ''; }

    // The timer bar is a CSS transition; on pause we freeze it at its current
    // width and on resume restart the transition for the time that is left.
    let timerState = null; // { totalMs, startedAt (game clock) }
    function setTimer(seconds, color) {
        let f = U.timerFill;
        U.timer.className = 'jp-timer' + (color ? ' jp-' + color : '');
        f.style.transition = 'none';
        f.style.width = '100%';
        void f.offsetWidth; // reflow
        f.style.transition = 'width ' + seconds + 's linear';
        f.style.width = '0%';
        timerState = { totalMs: seconds * 1000, startedAt: JPClock.now() };
    }
    function clearTimer() {
        let f = U.timerFill;
        f.style.transition = 'none';
        f.style.width = '0%';
        timerState = null;
    }
    function freezeTimer() {
        if (!timerState || !U) return;
        let f = U.timerFill;
        let elapsed = JPClock.now() - timerState.startedAt;
        let pct = Math.max(0, 100 * (1 - elapsed / timerState.totalMs));
        f.style.transition = 'none';
        f.style.width = pct + '%';
    }
    function thawTimer() {
        if (!timerState || !U) return;
        let f = U.timerFill;
        let remaining = Math.max(0, timerState.totalMs - (JPClock.now() - timerState.startedAt));
        void f.offsetWidth;
        f.style.transition = 'width ' + (remaining / 1000) + 's linear';
        f.style.width = '0%';
    }
    JPClock.onPause(freezeTimer);
    JPClock.onResume(thawTimer);

    function stage(node) {
        U.stage.innerHTML = '';
        U.stage.appendChild(node);
        return node;
    }

    function showPanel(html) {
        return stage(h('div', 'jp-panel', html));
    }

    // The clue screen. opts.category ({ name, comments }) puts the category
    // strip across the top of the clue, with opts.value (e.g. "$600") beside it.
    let clueEl = null, clueTextEl = null, clueSubEl = null;
    function showClue(html, opts) {
        opts = opts || { };
        clueEl = h('div', 'jp-clue');
        if (opts.category && opts.category.name) {
            let strip = h('div', 'jp-clue-cat',
                '<span class="jp-clue-cat-name">' + esc(opts.category.name) + '</span>' +
                (opts.value ? '<span class="jp-clue-cat-val">' + esc(opts.value) + '</span>' : '') +
                (opts.category.comments ? '<span class="jp-clue-cat-note">' + esc(opts.category.comments) + '</span>' : ''));
            clueEl.appendChild(strip);
        }
        clueTextEl = h('div', 'jp-clue-text' + (S.upper && !opts.noUpper ? ' jp-upper' : '') + (opts.noUpper ? ' jp-special' : ''), html);
        clueSubEl = h('div', 'jp-clue-sub', '');
        clueEl.appendChild(clueTextEl);
        clueEl.appendChild(clueSubEl);
        // Pictures: J! Archive links a media file for "seen here" clues but
        // rarely hosts it. Try; if it 404s, say so instead of a broken image.
        clueTextEl.querySelectorAll('img').forEach(function(img) {
            img.addEventListener('load', fitClueText);
            img.addEventListener('error', function() {
                let note = h('div', 'jp-clue-nomedia', '(the archive doesn\'t have this clue\'s picture)');
                img.replaceWith(note);
                fitClueText();
            });
        });
        stage(clueEl);
        clueEl.dataset.fit = opts.noUpper ? '0' : '1';
        fitClueText();
        return clueEl;
    }

    // Size the clue text like the show does: as large as will fit the panel,
    // wrapped in a column narrower than the panel so it runs to several lines.
    function fitClueText() {
        if (!clueEl || !clueTextEl || !clueEl.isConnected || clueEl.dataset.fit != '1') return;
        let strip = clueEl.querySelector('.jp-clue-cat');
        if (strip) clueEl.style.paddingTop = (strip.offsetHeight + 18) + 'px';   // never under the category strip
        let cs = getComputedStyle(clueEl);
        let padT = parseFloat(cs.paddingTop) || 0, padB = parseFloat(cs.paddingBottom) || 0;
        let subH = clueSubEl ? clueSubEl.offsetHeight : 0;
        let avail = clueEl.clientHeight - padT - padB - subH - 6;
        let width = Math.round(clueEl.clientWidth * 0.8);
        if (avail < 40 || width < 80) return;
        clueTextEl.style.maxWidth = width + 'px';
        clueTextEl.style.width = width + 'px';
        let lo = 12, hi = Math.min(220, avail);
        while (hi - lo > 0.5) {
            let mid = (lo + hi) / 2;
            clueTextEl.style.fontSize = mid + 'px';
            let fits = clueTextEl.scrollHeight <= avail && clueTextEl.scrollWidth <= width + 1;
            if (fits) lo = mid; else hi = mid;
        }
        clueTextEl.style.fontSize = Math.floor(lo) + 'px';
    }
    let fitObserver = null;
    function watchClueSize() {
        if (typeof ResizeObserver === 'undefined' || fitObserver) return;
        fitObserver = new ResizeObserver(function() { fitClueText(); });
        fitObserver.observe(U.stage);
        window.addEventListener('resize', fitClueText);
    }

    function setSub(html) { if (clueSubEl) { let before = clueSubEl.offsetHeight; clueSubEl.innerHTML = html; if (clueSubEl.offsetHeight != before) fitClueText(); } }
    function setLit(on) { if (clueEl) { clueEl.classList.toggle('jp-lit', !!on); if (on) clueEl.classList.remove('jp-locked'); } }
    function flashLocked() {
        if (!clueEl) return;
        clueEl.classList.add('jp-locked');
        setTimeout(function() { if (clueEl) clueEl.classList.remove('jp-locked'); }, S.lockoutMs);
    }

    function renderPodiums() {
        U.podiums.innerHTML = '';
        let names = realNames().concat([ YOU ]);
        for (let n of names) {
            let p = h('div', 'jp-podium' + (n == YOU ? ' jp-you' : '') + (G.control == n ? ' jp-control' : ''));
            p.dataset.who = n;
            let sc = G.scores[n] || 0;
            p.innerHTML = '<div class="jp-pdelta"></div><div class="jp-pscore' + (sc < 0 ? ' jp-neg' : '') + '">' + money(sc) + '</div>' +
                          '<div class="jp-pname">' + esc(n) + '</div><div class="jp-pline"></div>';
            U.podiums.appendChild(p);
        }
    }
    function podium(who) { return U.podiums.querySelector('.jp-podium[data-who="' + CSS.escape(who) + '"]'); }
    function lightPodium(who, on) {
        U.podiums.querySelectorAll('.jp-podium').forEach(function(p) { p.classList.remove('jp-lit'); });
        if (who && on !== false) { let p = podium(who); if (p) p.classList.add('jp-lit'); }
    }
    function podiumLine(who, html) { let p = podium(who); if (p) p.querySelector('.jp-pline').innerHTML = html || ''; }
    function clearPodiumLines() { U.podiums.querySelectorAll('.jp-pline').forEach(function(e) { e.innerHTML = ''; }); U.podiums.querySelectorAll('.jp-pdelta').forEach(function(e) { e.className = 'jp-pdelta'; e.textContent = ''; }); }
    function markOut(who, out) { let p = podium(who); if (p) p.classList.toggle('jp-out', !!out); }
    function clearOuts() { U.podiums.querySelectorAll('.jp-podium').forEach(function(p) { p.classList.remove('jp-out'); }); }

    function adjustScore(who, delta) {
        G.scores[who] = (G.scores[who] || 0) + delta;
        let p = podium(who);
        if (!p) return;
        let sc = p.querySelector('.jp-pscore');
        sc.textContent = money(G.scores[who]);
        sc.classList.toggle('jp-neg', G.scores[who] < 0);
        let d = p.querySelector('.jp-pdelta');
        if (delta) {
            d.className = 'jp-pdelta ' + (delta > 0 ? 'jp-plus' : 'jp-minus');
            d.textContent = (delta > 0 ? '+' : '-') + money(Math.abs(delta));
        }
    }

    // Every response of yours is kept, so a misjudged one can be fixed
    // afterwards (y/n right after the clue, or "Edit results" in the pause
    // menu). Only the money changes: the buzz, the rebound, control of the
    // board and the contestants' results stay as they happened.
    // rec: { kind: 'clue'|'dd'|'fj', round, category, value, amount, said, correct, outcome: 'right'|'wrong'|'none' }
    function addResult(rec) {
        rec.id = G.results.length;
        rec.applied = 0;
        G.results.push(rec);
        applyResult(rec);
        return rec;
    }
    function applyResult(rec) {
        let want = rec.outcome == 'right' ? rec.amount : rec.outcome == 'wrong' ? -rec.amount : 0;
        if (want != rec.applied) { adjustScore(YOU, want - rec.applied); rec.applied = want; }
    }
    function setOutcome(rec, outcome) {
        if (rec.outcome == outcome) return;
        if (rec.outcome == 'right') G.stats.correct--; else if (rec.outcome == 'wrong') G.stats.wrong--;
        if (outcome == 'right') G.stats.correct++; else if (outcome == 'wrong') G.stats.wrong++;
        rec.outcome = outcome;
        applyResult(rec);
        reconcileOthers(rec);
        followControl(rec);
    }
    // Control of the board follows your result on the clue just played: right,
    // the board is yours; wrong, it goes to whoever answered right after you,
    // or stays with the player who picked the clue. Earlier clues are left
    // alone (the board has moved on since). If the change lands while the
    // next pick is being made, the pick starts over with the right player.
    function controlFor(rec) {
        if (rec.outcome == 'right') return YOU;
        let winner = (rec.others || [ ]).find(function(o) { return o.right && (rec.othersDelta || { })[o.who]; });
        if (winner) return winner.who;
        let snap = (G.history || [ ]).slice().reverse().find(function(h) { return h.num == rec.num; });
        return snap ? snap.control : G.control;
    }
    function followControl(rec) {
        if (rec.kind == 'fj') return;
        let last = (G.results || [ ])[G.results.length - 1];
        if (rec !== last) return;                                  // only the most recent clue
        if (G.phase == 'clue') { if (G.current && G.current.num == rec.num) G.pendingControl = true; return; }   // settled when the clue ends
        if (G.phase != 'pick') return;
        let who = controlFor(rec);
        if (who == G.control) return;
        setControl(who);
        restartPick();
    }
    let pickListener = null;
    function restartPick() {
        runToken++;
        let tok = runToken;
        handlers = { buzz: null, override: null, cont: null, pick: null, submit: null };
        if (pickListener) { try { pickListener.stop(); } catch (e) { } pickListener = null; }
        JPAudio.stopSpeaking();
        runGame(tok, G.round, true);
    }
    // The contestants who rang in after you (rec.others, in broadcast order, with
    // the money each one's archived response is worth). If you were right they
    // never got the chance, so their money comes off; if you were wrong (or
    // scratched), they play it out and it goes back on.
    function reconcileOthers(rec) {
        if (!rec.others || !rec.others.length) return;
        let applied = rec.othersDelta || (rec.othersDelta = { });
        for (let o of rec.others) {
            let want = rec.outcome != 'right' ? o.delta : 0, cur = applied[o.who] || 0;
            if (want != cur) { adjustScore(o.who, want - cur); applied[o.who] = want; }
        }
    }
    function setControl(who) {
        G.control = who;
        U.podiums.querySelectorAll('.jp-podium').forEach(function(p) { p.classList.toggle('jp-control', p.dataset.who == who); });
    }

    function showAnswerStrip(on, listening) {
        U.answer.classList.toggle('jp-show', !!on);
        U.mic.className = 'jp-mic' + (listening ? ' jp-listening' : '');
        U.mic.textContent = listening ? 'Listening…' : (S.answerMode == 'speech' ? 'Mic off' : 'Type it');
        U.heard.textContent = '';
        U.input.value = '';
        if (on) setTimeout(function() { U.input.focus(); }, 0);
        else U.input.blur();
    }

    // ------------------------------------------------------------- speech

    // The host: the studio voice when it's chosen and loaded, else the system voice.
    function usingNeural() { return S.voiceEngine == 'neural' && typeof JPNeural !== 'undefined' && JPNeural.ready; }
    function hostOpts(rateMul, kind) {
        return usingNeural()
            ? { engine: 'neural', neuralVoice: S.neuralVoice, rate: S.rate * (rateMul || 1), kind: kind || 'line' }
            : { voice: hostVoice, rate: S.rate * (rateMul || 1) };
    }
    function hostText(text, kind) { return usingNeural() ? JPReader.forNeural(text, kind || 'line') : text; }
    function hostSay(text, kind) {
        return JPAudio.speak(hostText(text, kind), hostOpts(1, kind));
    }
    function contestantUsesNeural() { return usingNeural() && S.contestantEngine != 'system'; }
    function contestantOpts(who) {
        return contestantUsesNeural()
            ? { engine: 'neural', neuralVoice: neuralVoiceMap[who] || S.neuralVoice, rate: S.rate, kind: 'line' }
            : { voice: voiceMap[who] || hostVoice, rate: S.rate, pitch: 1.0 };
    }
    function contestantSay(who, text) {
        if (!S.contestantVoices) return Promise.resolve(false);
        return JPAudio.speak(contestantUsesNeural() ? JPReader.forNeural(text, 'line') : text, contestantOpts(who));
    }

    // Studio voices for the contestants: distinct from the host's and from each
    // other, matched to a guess at the contestant's gender from the first name
    // (the archive records no pronouns; a wrong guess only means a voice that
    // fits less well). Each voice is a 0.5 MB file the engine fetches once and
    // caches alongside the model.
    const NEURAL_POOL = {
        m: [ 'am_fenrir', 'am_puck', 'bm_george', 'am_eric', 'am_liam', 'am_onyx', 'bm_lewis', 'am_michael', 'bm_daniel', 'am_echo', 'bm_fable' ],
        f: [ 'af_heart', 'af_bella', 'af_sarah', 'af_nicole', 'bf_emma', 'af_nova', 'bf_isabella' ],
    };
    const FEMALE_NAMES = 'mary patricia jennifer linda elizabeth barbara susan jessica sarah karen lisa nancy betty sandra margaret ashley kimberly emily donna michelle carol amanda melissa deborah stephanie dorothy rebecca sharon laura cynthia amy kathleen angela shirley brenda emma anna pamela nicole samantha katherine christine helen debra rachel carolyn janet maria catherine heather diane olivia julie joyce victoria ruth virginia lauren kelly christina joan evelyn judith andrea hannah megan cheryl jacqueline martha madison teresa gloria sara janice ann kathryn abigail sophia frances jean alice judy isabella julia grace amber denise danielle marilyn beverly charlotte natalie theresa diana brittany doris kayla alexis lori marie erin chloe zoe ella lily mia ava lucy claire nora leah audrey stella hazel eleanor violet aurora savannah brooklyn bella skylar paisley naomi elena caroline sadie eva aria scarlett penelope layla riley zoey ellie ivy aubrey kennedy autumn piper quinn maya faith molly josephine ruby jade alyssa jasmine hailey taylor sydney jordan morgan casey robin jamie leslie dana kim tracy stacy tina wendy tammy carla connie rita rosa paula peggy anita bonnie irene jill jenny kristen kristin krista kate katie kathy cathy cindy debbie liz beth becky jane joanne jo sue suzanne sally rose eileen ellen colleen holly heidi april amanda allison alison alexandra alexa erica erika monica veronica valerie vanessa vicki vickie wanda yolanda yvonne yvette adrienne alicia amelia angelica ariana bianca bridget brooke camille candace cassandra celeste cecilia claudia courtney crystal daisy dawn desiree elaine esther fiona gabriela gabrielle genevieve gina gwen harriet ingrid iris jackie jada janelle jeanette jenna joanna jocelyn jolene juliet kara karla kayleigh kelsey kendra kerry kirsten kristina kylie lacey lana latoya lena lillian lindsay lindsey lorraine louise lydia lynn mackenzie mandy marcia margo marissa marjorie meredith mindy miranda miriam nadia natasha nina norma octavia pauline phoebe priscilla regina renee rhonda roberta rochelle rosemary roxanne sabrina selena serena shannon shelley sheila sherry simone sonia sonya sophie stacey tabitha tamara tanya tara tasha tiffany toni tonya trisha ursula vera vivian whitney willow zara mallory meghan maggie annie carrie trina ellie lisa marcy'.split(' ');
    const MALE_NAMES = 'james john robert michael william david richard joseph thomas charles christopher daniel matthew anthony mark donald steven paul andrew joshua kenneth kevin brian george timothy ronald edward jason jeffrey ryan jacob gary nicholas eric jonathan stephen larry justin scott brandon benjamin samuel gregory alexander frank patrick raymond jack dennis jerry tyler aaron jose adam nathan henry douglas zachary peter kyle noah ethan jeremy walter christian keith roger terry austin sean gerald carl harold dylan arthur lawrence jordan jesse bryan billy bruce gabriel joe logan alan juan albert willie elijah wayne randy vincent mason roy ralph bobby russell bradley philip eugene louis harry howard fred fredrick frederick leo luke liam owen oliver isaac caleb connor hunter cameron evan levi lucas landon nolan wyatt eli miles max leon ivan felix hugo jasper simon oscar victor marcus martin clark chase cole colin dean derek drew glenn grant graham ian jake jared jay jeff jim jimmy joel johnny jon josh ken kent kirk lance lee lloyd lonnie lyle marc mike mitch mitchell neil nick norman pat phil rick ricky rob rod rodney ron ross rusty sam shane shawn stan stanley steve stuart ted todd tom tommy tony travis trevor troy vern vernon wade warren wes wesley will alec alex andre angelo antonio armando arturo barry bart ben bernard bill blake brad brent brett brody bryce byron cal calvin carlos carter cedric cesar chad chris clay clayton cliff clifford clint clinton clyde cody conrad corey craig curtis dale dallas damon dan dane darren darryl dave davis dax dominic don doug duane dustin dwayne dwight earl ed eddie edwin elliot elliott emmett ernest ernie floyd forrest ray luigi guy ari levi rudy cody jody elijah isaiah noah micah jonah judah josiah francis gene geoffrey gilbert gordon guy hank hans harvey heath herbert herman homer horace irving jamal javier jeremiah jerome jesus jorge julian julio kelvin kurt kurtis lamar leonard leroy lester lorenzo luis luther malcolm manuel mario marvin maurice maxwell melvin milton morris moses nathaniel nelson nigel noel omar orlando otis pablo pedro percy perry preston quentin quincy rafael ramon randall raul reginald rex ricardo roberto roland rudy rufus salvador sergio seth sheldon sidney spencer sterling stewart terrence theodore tim toby tyrone vance virgil wallace walt wendell wilbur wilson winston xavier zack'.split(' ');
    function guessGender(name) {
        if (typeof JPNames !== 'undefined') { let g = JPNames.gender(name); if (g) return g; }
        let first = String(name || '').trim().toLowerCase().split(/[\s.-]+/)[0];
        if (!first) return 'm';
        if (FEMALE_NAMES.indexOf(first) >= 0) return 'f';
        if (MALE_NAMES.indexOf(first) >= 0) return 'm';
        return /a$/.test(first) && !/^(joshua|ezra|luca|ira|asa|mustafa|dakota|nikita|akira|kota)$/.test(first) ? 'f' : 'm';   // unknown name: a final -a is the one reliable hint
    }
    let neuralVoiceMap = { };
    function setupNeuralVoices() {
        neuralVoiceMap = { };
        let used = { }; used[S.neuralVoice || 'am_michael'] = true;
        let names = realNames();
        names.forEach(function(n) {
            let g = guessGender(n);
            let pick = NEURAL_POOL[g].find(function(v) { return !used[v]; }) || NEURAL_POOL[g == 'm' ? 'f' : 'm'].find(function(v) { return !used[v]; }) || S.neuralVoice;
            used[pick] = true;
            neuralVoiceMap[n] = pick;
        });
    }
    // Every line of dialogue except the clue itself can be clicked through:
    // say() and csay() are hostSay/contestantSay that a click, the buzz key or
    // Enter cut short (the clue reading stays as it is — clicking then is a buzz).
    function say(text, tok, kind) { return hostSaySkippable(text, tok, 1, kind); }
    function csay(who, text, tok) {
        if (!S.contestantVoices) return Promise.resolve({ alive: alive(tok), skipped: false });
        return new Promise(function(resolve) {
            let done = false;
            handlers.cont = function() { if (done) return; done = true; handlers.cont = null; JPAudio.stopSpeaking(); resolve({ alive: alive(tok), skipped: true }); };
            contestantSay(who, text).then(function() { if (done) return; done = true; handlers.cont = null; resolve({ alive: alive(tok), skipped: false }); });
        });
    }
    // Speak, but let a click / the buzz key / Enter cut it short.
    // Resolves { alive, skipped }. rateMul scales the reading speed.
    function hostSaySkippable(text, tok, rateMul, kind) {
        return new Promise(function(resolve) {
            let done = false;
            handlers.cont = function() { if (done) return; done = true; handlers.cont = null; JPAudio.stopSpeaking(); resolve({ alive: alive(tok), skipped: true }); };
            JPAudio.speak(hostText(text, kind), hostOpts(rateMul, kind)).then(function() {
                if (done) return; done = true; handlers.cont = null; resolve({ alive: alive(tok), skipped: false });
            });
        });
    }

    function setupVoices() {
        hostVoice = JPAudio.voiceByName(S.hostVoice) || JPAudio.defaultHostVoice();
        let names = realNames();
        let vs = JPAudio.contestantVoices(hostVoice, names.length);
        voiceMap = { };
        names.forEach(function(n, i) { voiceMap[n] = vs[i]; });
        setupNeuralVoices();
    }

    // ---------------------------------------------------------- key input

    function isBuzz(e) {
        if (S.buzzKey == 'Shift') return e.key == 'Shift';
        return e.key == S.buzzKey || (S.buzzKey == ' ' && e.code == 'Space');
    }

    function onKey(e) {
        if (!liveActive) return;
        if (e.target === U.input) return; // handled on the input itself
        let tn = e.target && e.target.tagName;
        if (tn == 'INPUT' || tn == 'TEXTAREA' || tn == 'SELECT') {
            if (e.key == 'Escape') { e.preventDefault(); showPauseMenu(); }
            return; // let people type in wager / settings fields
        }
        if (pauseEl && e.key != 'Escape') return;
        if (e.repeat && isBuzz(e)) { e.preventDefault(); return; }
        if (isBuzz(e)) {
            e.preventDefault();
            if (handlers.buzz) handlers.buzz();
            else if (handlers.cont) handlers.cont();
            return;
        }
        switch (e.key) {
          case 'Enter':
            e.preventDefault();
            if (handlers.cont) handlers.cont();
            break;
          case 'Escape':
            e.preventDefault();
            showPauseMenu();
            break;
          case 'y': case 'Y': case '+': case '=':
            if (handlers.override) { e.preventDefault(); handlers.override(true); }
            break;
          case 'n': case 'N': case '-':
            if (handlers.override) { e.preventDefault(); handlers.override(false); }
            break;
        }
    }

    // ------------------------------------------------------------- screens

    function buzzKeyName() {
        return S.buzzKey == ' ' ? 'Space' : S.buzzKey == 'Shift' ? 'Shift' : S.buzzKey.toUpperCase();
    }

    function settingsForm() {
        let voices = JPAudio.voices();
        let vopts = '<option value="">(auto: ' + esc(JPAudio.defaultHostVoice() ? JPAudio.defaultHostVoice().name : 'none') + ')</option>';
        for (let v of voices)
            vopts += '<option value="' + esc(v.name) + '"' + (S.hostVoice == v.name ? ' selected' : '') + '>' + esc(v.name) + ' (' + esc(v.lang) + (v.localService ? '' : ', network') + ')</option>';
        let dopts = '';
        for (let k in DIFFICULTY)
            dopts += '<option value="' + k + '"' + (S.difficulty == k ? ' selected' : '') + '>' + esc(DIFFICULTY[k].label) + '</option>';
        let sr = JPAudio.recognitionSupported();
        return '<table class="jp-form">' +
            '<tr><td>Contestant speed</td><td><select data-s="difficulty">' + dopts + '</select>' +
            ' <span class="jp-note">custom: median <input type="number" data-s="customMedian" min="60" max="4000" step="10" value="' + (+S.customMedian) + '" style="min-width:5em;width:5em"> ms, spread <select data-s="customSpread" style="min-width:6em">' +
              [[0.4, 'tight'], [0.65, 'normal'], [0.9, 'wide']].map(function(o) { return '<option value="' + o[0] + '"' + (Math.abs(+S.customSpread - o[0]) < 0.01 ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') +
              '</select></span></td></tr>' +
            '<tr><td>Buzz-in key</td><td><select data-s="buzzKey">' +
              [[' ', 'Space'], ['b', 'B'], ['j', 'J'], ['k', 'K'], ['Shift', 'Shift']].map(function(o) { return '<option value="' + esc(o[0]) + '"' + (S.buzzKey == o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') +
              '</select></td></tr>' +
            '<tr><td>How you answer</td><td><select data-s="answerMode">' +
              '<option value="speech"' + (S.answerMode == 'speech' ? ' selected' : '') + (sr ? '' : ' disabled') + '>Speak it (typing also works)' + (sr ? '' : ' — not supported here') + '</option>' +
              '<option value="typed"' + (S.answerMode == 'typed' ? ' selected' : '') + '>Type it</option></select>' +
              ' <button class="jp-btn jp-secondary jp-mic-test" style="padding:3px 10px;font-size:0.9em">Test microphone</button> <span class="jp-mic-result jp-note"></span>' +
              '<div style="margin-top:4px"><label><input type="checkbox" data-s="voicePick"' + (S.voicePick ? ' checked' : '') + '>Pick clues by voice too, when you have the board ("Science for 600", "same category, 800"); clicking always works</label></div></td></tr>' +
            '<tr><td>Recognition</td><td>' + earSection() + '</td></tr>' +
            '<tr><td>Host voice</td><td>' + voiceSection(vopts) + '</td></tr>' +
            '<tr><td>Reading speed</td><td><input type="range" class="jp-rate" min="0.6" max="1.4" step="0.05" value="' + (S.rate / BASE_RATE).toFixed(2) + '"> <span class="jp-rate-val">' + (S.rate / BASE_RATE).toFixed(2) + '×</span></td></tr>' +
            '<tr><td>Contestants speak</td><td><label><input type="checkbox" data-s="contestantVoices"' + (S.contestantVoices ? ' checked' : '') + '>Read their responses aloud in their own voices</label> ' +
              '<select data-s="contestantEngine" style="min-width:16em;margin-left:8px"><option value="neural"' + (S.contestantEngine != 'system' ? ' selected' : '') + '>studio voices (with the studio host)</option><option value="system"' + (S.contestantEngine == 'system' ? ' selected' : '') + '>system voices</option></select></td></tr>' +
            '<tr><td>Read categories</td><td><label><input type="checkbox" data-s="readCategories"' + (S.readCategories ? ' checked' : '') + '>Host reads the categories at the start of each round</label></td></tr>' +
            '<tr><td>Uppercase clues</td><td><label><input type="checkbox" data-s="upper"' + (S.upper ? ' checked' : '') + '>Show clue text in capitals, like the show</label></td></tr>' +
            '<tr><td>Sound effects</td><td><label><input type="checkbox" data-s="sfx"' + (S.sfx ? ' checked' : '') + '>On (drop files into the extension\'s <code>sounds/</code> folder to replace the built-in tones)</label></td></tr>' +
            '<tr><td>Time to answer</td><td><input type="number" data-s="answerSeconds" min="2" max="15" value="' + (+S.answerSeconds) + '" style="min-width:5em;width:5em"> s after buzzing &nbsp; ' +
              'ring-in window <input type="number" data-s="buzzWindowSeconds" min="2" max="15" value="' + (+S.buzzWindowSeconds) + '" style="min-width:5em;width:5em"> s &nbsp; ' +
              'lockout <input type="number" data-s="lockoutMs" min="0" max="2000" step="50" value="' + (+S.lockoutMs) + '" style="min-width:5em;width:5em"> ms</td></tr>' +
            '<tr><td>After a clue</td><td>move on after <input type="number" data-s="autoAdvanceMs" min="0" max="10000" step="100" value="' + (+S.autoAdvanceMs) + '" style="min-width:6em;width:6em"> ms if you don\'t click or press <span class="jp-key">' + buzzKeyName() + '</span> first</td></tr>' +
            '</table>';
    }

    // ---- the studio voice (on-device neural model) -------------------------

    let neuralCaps = null;      // last capability report from the engine
    function neuralAvailableHere() { return typeof JPNeural !== 'undefined' && JPNeural.available(); }

    function voiceSection(vopts) {
        let nv = S.neuralVoice || 'am_michael';
        let neuralOpts = (neuralVoiceList || [ ]).map(function(v) { return '<option value="' + esc(v.id) + '"' + (nv == v.id ? ' selected' : '') + '>' + esc(v.label) + '</option>'; }).join('');
        if (!neuralOpts) neuralOpts = '<option value="' + esc(nv) + '" selected>' + esc(nv) + '</option>';
        return '<div class="jp-voice">' +
            '<label><input type="radio" name="jp-engine" value="neural"' + (S.voiceEngine == 'neural' ? ' checked' : '') + (neuralAvailableHere() ? '' : ' disabled') + '> <b>Studio voice</b> <span class="jp-note">— a natural voice that runs on this computer (free; one-time download)</span></label>' +
            '<div class="jp-voice-neural" style="margin:4px 0 8px 24px">' +
              '<div class="jp-neural-status jp-note">…</div>' +
              '<div class="jp-neural-checked jp-note" style="display:none;color:#6cff8f"></div>' +
              '<div class="jp-neural-bar" style="display:none"><div class="jp-neural-fill"></div></div>' +
              '<div style="margin-top:4px"><button class="jp-btn jp-secondary jp-neural-check" style="padding:3px 10px;font-size:0.9em">Check my computer</button> ' +
              '<button class="jp-btn jp-neural-download" style="padding:3px 10px;font-size:0.9em;display:none">Download the studio voice</button> ' +
              '<select data-s="neuralVoice" style="min-width:14em">' + neuralOpts + '</select> ' +
              '<button class="jp-btn jp-secondary jp-neural-test" style="padding:3px 10px;font-size:0.9em">Test</button></div>' +
            '</div>' +
            '<label><input type="radio" name="jp-engine" value="system"' + (S.voiceEngine != 'neural' ? ' checked' : '') + '> <b>System voice</b> <span class="jp-note">— the voices built into this computer</span></label>' +
            '<div style="margin:4px 0 0 24px"><select data-s="hostVoice">' + vopts + '</select> <button class="jp-btn jp-secondary jp-voice-test" style="padding:3px 10px;font-size:0.9em">Test</button>' +
              (JPAudio.hasEnhancedVoice() ? '' : '<div class="jp-note" style="margin-top:4px">macOS tip: better free system voices can be downloaded in <b>System Settings → Accessibility → Spoken Content → System Voice → Manage Voices…</b> (Tom, Evan, Nathan "Enhanced", or Alex).</div>') +
            '</div></div>';
    }

    function fmtMB(bytes) { return (bytes / 1048576).toFixed(0) + ' MB'; }

    // ---- the studio ear (on-device speech recognition) -----------------------
    let earCaps = null;
    function earAvailableHere() { return typeof JPEar !== 'undefined' && JPEar.available(); }
    function earSection() {
        let sizes = { base: 'Base — quick and good (about 210 MB)', small: 'Small — better with names (about 590 MB)' };
        let sopts = Object.keys(sizes).map(function(k) { return '<option value="' + k + '"' + ((S.earSize || 'base') == k ? ' selected' : '') + '>' + esc(sizes[k]) + '</option>'; }).join('');
        return '<div class="jp-voice jp-ear">' +
            '<label><input type="radio" name="jp-ear" value="studio"' + (S.earEngine != 'chrome' ? ' checked' : '') + (earAvailableHere() ? '' : ' disabled') + '> <b>Studio ear</b> <span class="jp-note">— speech recognition that runs on this computer, the same every time (free; one-time download)</span></label>' +
            '<div class="jp-ear-studio" style="margin:4px 0 8px 24px">' +
              '<div class="jp-ear-status jp-note">…</div>' +
              '<div class="jp-neural-bar jp-ear-bar" style="display:none"><div class="jp-neural-fill jp-ear-fill"></div></div>' +
              '<div style="margin-top:4px"><select data-s="earSize" style="min-width:14em">' + sopts + '</select> ' +
              '<button class="jp-btn jp-ear-download" style="padding:3px 10px;font-size:0.9em;display:none">Download the studio ear</button> ' +
              '<button class="jp-btn jp-secondary jp-ear-log" style="padding:3px 10px;font-size:0.9em">Mic log</button></div>' +
              '<pre class="jp-mic-log jp-note" style="display:none;white-space:pre-wrap;max-height:14em;overflow:auto;margin:6px 0 0;font-size:0.8em"></pre>' +
            '</div>' +
            '<label><input type="radio" name="jp-ear" value="chrome"' + (S.earEngine == 'chrome' ? ' checked' : '') + '> <b>Chrome\'s built-in</b> <span class="jp-note">— Google\'s speech service (audio leaves the computer while the game listens)</span></label>' +
            '</div>';
    }
    function earStatusText() {
        if (!earAvailableHere()) return 'Not available in this browser.';
        let st = JPEar.state;
        if (st.loading) {
            let p = st.progress, c = earCaps, sz = S.earSize || 'base';
            let fromDisk = c && c.cached && c.cached[sz] && (c.cached[sz].webgpu || c.cached[sz].wasm);
            if (p && p.total) return (fromDisk ? 'Loading… ' : 'Downloading… ') + fmtMB(p.loaded) + ' of ' + fmtMB(p.total);
            return 'Preparing the studio ear…';
        }
        if (st.loaded) return 'Ready — ' + (st.size || 'base') + ' model on ' + (st.device == 'webgpu' ? 'the graphics processor (WebGPU)' : 'the CPU (WebAssembly)') + (st.micError ? ' · microphone: ' + st.micError : '') + '.';
        if (st.error) return 'Problem: ' + st.error;
        let c = earCaps;
        if (!c) return 'Not set up yet.';
        let sz = S.earSize || 'base';
        let has = c.cached && c.cached[sz] && (c.cached[sz].webgpu || c.cached[sz].wasm);
        if (has) return 'Downloaded. It loads when a game starts.';
        return (c.webgpu ? 'This computer can run it well (WebGPU). ' : 'It would run on the CPU here (a bit slower to answer). ') + 'One-time download of about ' + (c.webgpu ? c.sizesMB[sz].webgpu : c.sizesMB[sz].wasm) + ' MB.';
    }
    function earPreferredDevice() {
        if (S.earDevice == 'webgpu' || S.earDevice == 'wasm') return S.earDevice;
        return earCaps && earCaps.webgpu ? 'webgpu' : 'wasm';
    }
    function refreshEarUI(panel) {
        panel.querySelectorAll('.jp-ear').forEach(function(sec) {
            let status = sec.querySelector('.jp-ear-status');
            if (status) status.textContent = earStatusText();
            let st = JPEar.state;
            let bar = sec.querySelector('.jp-ear-bar'), fill = sec.querySelector('.jp-ear-fill');
            if (bar) { let p = st.progress; bar.style.display = st.loading && p && p.total ? 'block' : 'none'; if (fill && p && p.total) fill.style.width = Math.min(100, 100 * p.loaded / p.total) + '%'; }
            let dl = sec.querySelector('.jp-ear-download');
            if (dl) {
                let c = earCaps, sz = S.earSize || 'base';
                let has = c && c.cached && c.cached[sz] && (c.cached[sz].webgpu || c.cached[sz].wasm);
                let wrongSize = st.loaded && st.size != sz;
                dl.style.display = (c && (!st.loaded || wrongSize) && !st.loading) ? 'inline-block' : 'none';
                dl.textContent = has ? 'Load the studio ear' : 'Download the studio ear (' + (c ? (c.webgpu ? c.sizesMB[sz].webgpu : c.sizesMB[sz].wasm) : '?') + ' MB)';
            }
        });
    }
    async function earCheck(panel) {
        try { earCaps = await JPEar.caps(); } catch (e) { earCaps = null; JPEar.state.error = e.message || String(e); }
        refreshEarUI(panel);
    }
    async function earDownload(panel) {
        try {
            if (!earCaps) earCaps = await JPEar.caps();
            await JPEar.load(S.earSize || 'base', earPreferredDevice());
            S.earEngine = 'studio'; saveSettings(); JPEar.enabled = true;
            let r = panel.querySelector('input[name="jp-ear"][value="studio"]'); if (r) r.checked = true;
        } catch (e) { }
        try { earCaps = await JPEar.caps(); } catch (e) { }
        refreshEarUI(panel);
    }
    let earAutoLoadStarted = false;
    async function earAutoLoad() {
        JPEar.enabled = S.earEngine != 'chrome';
        if (earAutoLoadStarted || !earAvailableHere() || S.earEngine == 'chrome') return;
        earAutoLoadStarted = true;
        try {
            earCaps = await JPEar.caps();
            let sz = S.earSize || 'base';
            let has = earCaps.cached && earCaps.cached[sz] && (earCaps.cached[sz].webgpu || earCaps.cached[sz].wasm);
            if (earCaps.loaded || has) {
                let dev = earPreferredDevice();
                if (has && !earCaps.cached[sz].webgpu && dev == 'webgpu') dev = 'wasm';
                await JPEar.load(sz, dev);
            }
        } catch (e) { }
        if (U && U.stage) refreshEarUI(U.stage);
    }
    function micLogText() {
        let lines = [ ];
        let chrome = JPAudio.micLog || [ ];
        for (let e of chrome.slice(-8)) lines.push('[Chrome ' + e.at + '] ' + e.events.join(' → '));
        let ear = (typeof JPEar !== 'undefined' && JPEar.log) || [ ];
        for (let e of ear.slice(-24)) lines.push('[ear +' + e.t + 'ms] ' + e.m);
        if (typeof JPEar !== 'undefined') lines.push('[mic] ' + (JPEar.micState ? JPEar.micState() : (JPEar.micLabel() || 'not open')) + ' · level ' + JPEar.level.toFixed(3) + ' · room floor ' + JPEar.noise.toFixed(3));
        return lines.length ? lines.join('\n') : 'Nothing yet — play a clue and answer, then look again.';
    }

    // Human-readable status of the studio voice, from the last caps report + live state.
    function neuralStatusText() {
        if (!neuralAvailableHere()) return 'Not available in this browser.';
        let st = JPNeural.state;
        if (st.loading) {
            let p = st.progress;
            let c = neuralCaps, fromDisk = c && c.cached && (c.cached.fp32 || c.cached.q8 || c.cached.fp16);
            if (p && p.total) return (fromDisk ? 'Loading… ' : 'Downloading… ') + fmtMB(p.loaded) + ' of ' + fmtMB(p.total) + (p.file ? ' (' + p.file.replace(/^.*\//, '') + ')' : '');
            return 'Preparing the studio voice…';
        }
        if (st.loaded) return 'Ready — running on ' + (st.device == 'webgpu' ? 'the graphics processor (WebGPU)' : 'the CPU (WebAssembly)') + '.';
        if (st.error) return 'Problem: ' + st.error;
        let c = neuralCaps;
        if (!c) return 'Not set up yet. Click "Check my computer" to see if it can run the studio voice.';
        let has = c.cached && (c.cached.fp32 || c.cached.q8 || c.cached.fp16);
        let hw = (c.webgpu ? 'graphics processor available (WebGPU)' : 'no WebGPU — would use the CPU') + (c.cores ? ', ' + c.cores + ' cores' : '') + (c.deviceMemory ? ', ' + c.deviceMemory + '+ GB memory' : '');
        if (has) return 'Downloaded (' + hw + '). It loads when a game starts.';
        if (c.webgpu) return 'Recommended: this computer can run it well (' + hw + '). One-time download of about ' + c.sizesMB.fp32 + ' MB.';
        if ((c.cores || 4) >= 4 && (c.deviceMemory == null || c.deviceMemory >= 4)) return 'Should work (' + hw + '). Clues are prepared ahead of time so play stays smooth. One-time download of about ' + c.sizesMB.q8 + ' MB.';
        return 'Not recommended on this computer (' + hw + '); the system voice will sound fine.';
    }

    function refreshNeuralUI(panel) {
        panel.querySelectorAll('.jp-voice').forEach(function(sec) {
            let status = sec.querySelector('.jp-neural-status');
            if (status) status.textContent = neuralStatusText();
            let st = JPNeural.state;
            let bar = sec.querySelector('.jp-neural-bar'), fill = sec.querySelector('.jp-neural-fill');
            if (bar) {
                let p = st.progress;
                bar.style.display = st.loading && p && p.total ? 'block' : 'none';
                if (fill && p && p.total) fill.style.width = Math.min(100, 100 * p.loaded / p.total) + '%';
            }
            let dl = sec.querySelector('.jp-neural-download');
            if (dl) {
                let c = neuralCaps;
                let has = c && c.cached && (c.cached.fp32 || c.cached.q8 || c.cached.fp16);
                dl.style.display = (c && !st.loaded && !st.loading) ? 'inline-block' : 'none';
                dl.textContent = has ? 'Load the studio voice' : 'Download the studio voice (' + (c && c.webgpu ? c.sizesMB.fp32 : c ? c.sizesMB.q8 : '?') + ' MB)';
            }
            let test = sec.querySelector('.jp-neural-test');
            if (test) test.disabled = !st.loaded;
            // The voice list arrives from the engine after the form is built; fill it in.
            let sel = sec.querySelector('select[data-s="neuralVoice"]');
            if (sel && neuralVoiceList && sel.options.length < neuralVoiceList.length) {
                let cur = S.neuralVoice || 'am_michael';
                sel.innerHTML = neuralVoiceList.map(function(v) { return '<option value="' + esc(v.id) + '"' + (cur == v.id ? ' selected' : '') + '>' + esc(v.label) + '</option>'; }).join('');
            }
        });
    }

    // One line that says what the check found, so clicking the button visibly does something.
    function neuralCheckSummary() {
        let c = neuralCaps;
        if (!c) return 'Checked: the speech engine did not answer' + (JPNeural.state.error ? ' (' + JPNeural.state.error + ')' : '') + '.';
        let parts = [ ];
        parts.push(c.webgpu ? 'graphics processor: yes (WebGPU)' : 'graphics processor: no (would use the CPU)');
        if (c.cores) parts.push(c.cores + ' CPU cores');
        if (c.deviceMemory) parts.push(c.deviceMemory + (c.deviceMemory >= 8 ? '+' : '') + ' GB memory');
        let cached = c.cached || { };
        if (cached.fp32 && cached.q8) parts.push('both voice builds downloaded');
        else if (cached.fp32) parts.push('GPU voice build downloaded (' + c.sizesMB.fp32 + ' MB)');
        else if (cached.q8) parts.push('CPU voice build downloaded (' + c.sizesMB.q8 + ' MB)');
        else parts.push('voice not downloaded yet');
        let st = JPNeural.state;
        if (st.loaded) parts.push('loaded and ready on ' + (st.device == 'webgpu' ? 'WebGPU' : 'the CPU'));
        return 'Checked just now: ' + parts.join(' · ') + '.';
    }

    async function neuralCheck(panel) {
        let btn = panel.querySelector('.jp-neural-check'), line = panel.querySelector('.jp-neural-checked');
        if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
        if (line) { line.style.display = 'none'; line.textContent = ''; }
        let t0 = Date.now();
        try {
            neuralCaps = await JPNeural.caps();
            if (!neuralVoiceList) { neuralVoiceList = await JPNeural.voices(); }
        } catch (e) {
            neuralCaps = null;
            JPNeural.state.error = e.message || String(e);
        }
        // Long enough to be seen as a check even when the answer is instant.
        await new Promise(function(r) { setTimeout(r, Math.max(0, 500 - (Date.now() - t0))); });
        if (btn) { btn.disabled = false; btn.textContent = 'Check my computer'; }
        refreshNeuralUI(panel);
        if (line) { line.textContent = neuralCheckSummary(); line.style.display = 'block'; }
    }

    function preferredDevice() {
        if (S.neuralDevice == 'webgpu' || S.neuralDevice == 'wasm') return S.neuralDevice;
        return neuralCaps && neuralCaps.webgpu ? 'webgpu' : 'wasm';
    }

    async function neuralDownload(panel) {
        try {
            if (!neuralCaps) neuralCaps = await JPNeural.caps();
            await JPNeural.load(preferredDevice());
            S.voiceEngine = 'neural'; saveSettings();
            let r = panel.querySelector('input[name="jp-engine"][value="neural"]'); if (r) r.checked = true;
        } catch (e) { /* state.error is set; the status line shows it */ }
        try { neuralCaps = await JPNeural.caps(); } catch (e) { }
        refreshNeuralUI(panel);
    }

    let neuralVoiceList = null;
    let neuralAutoLoadStarted = false;
    // At Play Live start: if the studio voice is chosen and already downloaded, load it quietly.
    async function neuralAutoLoad() {
        if (neuralAutoLoadStarted || !neuralAvailableHere() || S.voiceEngine != 'neural') return;
        neuralAutoLoadStarted = true;
        try {
            neuralCaps = await JPNeural.caps();
            neuralVoiceList = await JPNeural.voices();
            let has = neuralCaps.cached && (neuralCaps.cached.fp32 || neuralCaps.cached.q8 || neuralCaps.cached.fp16);
            if (neuralCaps.loaded || has) {
                let dev = preferredDevice();
                if (has && !neuralCaps.cached.fp32 && dev == 'webgpu') dev = 'wasm';   // only the q8 build is on disk
                await JPNeural.load(dev);
                prefetchHostLines();
            }
        } catch (e) { }
        if (U && U.stage) refreshNeuralUI(U.stage);
    }

    // Short host lines used all game long: have them ready before the first clue.
    function prefetchHostLines() {
        if (!usingNeural()) return;
        let lines = HOST_RIGHT.concat(HOST_WRONG, [ 'Here are the categories.', 'The categories in Double Jeopardy.', 'It\'s a Daily Double.' ]);
        JPNeural.prefetch(lines.map(function(t) { return JPReader.forNeural(t, 'line'); }), S.neuralVoice, S.rate, 50);
    }

    function bindSettingsForm(panel) {
        // Voice engine radios + studio voice controls
        panel.querySelectorAll('input[name="jp-engine"]').forEach(function(r) {
            r.addEventListener('change', function() {
                if (!r.checked) return;
                S.voiceEngine = r.value; saveSettings();
                if (r.value == 'neural' && !JPNeural.ready) neuralCheck(panel);
            });
        });
        panel.querySelectorAll('input[name="jp-ear"]').forEach(function(r) {
            r.addEventListener('change', function() {
                if (!r.checked) return;
                S.earEngine = r.value; saveSettings();
                if (typeof JPEar !== 'undefined') { JPEar.enabled = r.value == 'studio'; if (r.value == 'studio' && !JPEar.ready) earCheck(panel); }
            });
        });
        let edl = panel.querySelector('.jp-ear-download');
        if (edl) edl.onclick = function() { earDownload(panel); };
        let elog = panel.querySelector('.jp-ear-log');
        if (elog) elog.onclick = function() { let pre = panel.querySelector('.jp-mic-log'); pre.textContent = micLogText(); pre.style.display = pre.style.display == 'none' ? 'block' : 'none'; };
        if (earAvailableHere()) {
            if (!earCaps) earCheck(panel); else refreshEarUI(panel);
            let offE = JPEar.onStatus(function() { if (panel.isConnected) refreshEarUI(panel); else offE(); });
        }
        let chk = panel.querySelector('.jp-neural-check');
        if (chk) chk.onclick = function() { neuralCheck(panel); };
        let dl = panel.querySelector('.jp-neural-download');
        if (dl) dl.onclick = function() { neuralDownload(panel); };
        let nt = panel.querySelector('.jp-neural-test');
        if (nt) nt.onclick = function() {
            if (!JPNeural.ready) return;
            JPAudio.speak(JPReader.forNeural('Here\'s the clue. This planet, the largest in our solar system, has a storm that has raged for centuries.', 'clue'),
                          { engine: 'neural', neuralVoice: S.neuralVoice, rate: S.rate });
        };
        if (neuralAvailableHere()) {
            refreshNeuralUI(panel);
            if (!neuralCaps && S.voiceEngine == 'neural') neuralCheck(panel);
            let off = JPNeural.onStatus(function() { if (panel.isConnected) refreshNeuralUI(panel); else off(); });
        }

        panel.querySelectorAll('[data-s]').forEach(function(inp) {
            let key = inp.dataset.s;
            inp.addEventListener('change', function() {
                if (inp.type == 'checkbox') S[key] = inp.checked;
                else if (inp.type == 'number' || inp.type == 'range') S[key] = +inp.value;
                else S[key] = inp.value;

                if (key == 'sfx') JPAudio.setEnabled(S.sfx);
                if (key == 'hostVoice' || key == 'neuralVoice') setupVoices();
                if (key == 'earSize') refreshEarUI(panel);
                saveSettings();
            });
        });
        let rateEl = panel.querySelector('.jp-rate');
        if (rateEl) {
            rateEl.addEventListener('input', function() { panel.querySelector('.jp-rate-val').textContent = (+rateEl.value).toFixed(2) + '×'; });
            rateEl.addEventListener('change', function() { S.rate = Math.round(+rateEl.value * BASE_RATE * 1000) / 1000; setupVoices(); saveSettings(); });
        }
        let vt = panel.querySelector('.jp-voice-test');
        if (vt) vt.onclick = function() { setupVoices(); hostSay('This is Jeopardy! Let\'s play. For 800: this planet is the largest in our solar system.'); };
        let mt = panel.querySelector('.jp-mic-test');
        if (mt) mt.onclick = function() {
            let out = panel.querySelector('.jp-mic-result');
            if (!JPAudio.recognitionSupported()) { out.textContent = 'Speech recognition is not available in this browser.'; return; }
            out.textContent = 'Listening for 4 seconds — say something…';
            let level = JPAudio.sampleInputLevel(4000);      // which mic, and how loud it comes in
            JPAudio.listen(4000, function(t) { out.textContent = 'Heard: "' + t + '"'; }).then(function(r) {
                let msg;
                if (r.error == 'not-allowed' || r.error == 'service-not-allowed') msg = 'Microphone permission was denied. Click the lock icon in the address bar to allow the microphone for j-archive.com.';
                else if (r.error == 'audio-capture') msg = 'No microphone found.';
                else if (!r.text) msg = 'Nothing heard' + (r.error ? ' (' + r.error + ')' : '') + '. Check the microphone permission for this site.';
                else msg = 'Heard: "' + r.text + '" — working.';
                out.textContent = msg;
                level.then(function(lv) {
                    if (!lv) return;
                    let pct = Math.round(lv.peak * 100);
                    let verdict = pct < 15 ? ' — quiet: raise Input volume in System Settings → Sound → Input, or move closer to the mic' : pct < 35 ? ' — a little low; more Input volume in System Settings → Sound would help' : ' — good';
                    out.textContent = msg + '  ·  Input: ' + (lv.label || 'default microphone') + ', peak level ' + pct + '%' + verdict + '.';
                });
            });
        };
    }

    function showSetup() {
        setHeader('Play Live', document.title.replace(/^J! Archive - /, ''), '');
        clearTimer();
        showAnswerStrip(false);
        let names = realNames();
        let onboarding = (!S.onboardedVoice && neuralAvailableHere())
            ? '<div class="jp-onboard"><b>New: a studio-quality host voice.</b> The host can now speak with a natural voice that runs entirely on your computer — free, no account, nothing sent anywhere. It\'s a one-time download (about 90–330 MB depending on your hardware). Click <b>Check my computer</b> under Host voice to see if yours can run it, then <b>Download</b>. The system voice keeps working either way. <button class="jp-btn jp-secondary jp-onboard-ok" style="padding:2px 10px;font-size:0.9em;margin-left:8px">Got it</button></div>'
            : '';
        let panel = showPanel(
            '<h1>Play Live</h1>' + onboarding +
            '<p>The host reads each clue aloud. When the reading ends, the lights come on and the buzzers arm: click anywhere or press <span class="jp-key">' + buzzKeyName() + '</span> to ring in against ' +
            esc(names.join(', ')) + ', who ring in the way they did in the broadcast. Buzz too early and you\'re locked out for a moment. ' +
            'If you win the buzz, answer out loud (or type it). Whoever answers correctly picks the next clue. Daily Doubles and Final Jeopardy! work as on the show.</p>' +
            '<p class="jp-note">During play: click / <span class="jp-key">' + buzzKeyName() + '</span> ring in, and move on when the game is waiting · <span class="jp-key">Enter</span> submit a typed response or wager · <span class="jp-key">y</span>/<span class="jp-key">n</span> overrule a judgment · <span class="jp-key">Esc</span> or the Pause button freezes everything</p>' +
            '<h2>Settings</h2>' + settingsForm() +
            '<p style="margin-top:1em"><button class="jp-btn jp-start">Start the game</button> <button class="jp-btn jp-secondary jp-scores">High scores</button> <button class="jp-btn jp-secondary jp-cancel">Back to the page</button></p>'
        );
        bindSettingsForm(panel);
        let ob = panel.querySelector('.jp-onboard-ok');
        if (ob) ob.onclick = function() { S.onboardedVoice = true; saveSettings(); ob.parentElement.remove(); };
        panel.querySelector('.jp-start').onclick = function() { startGame(); };
        panel.querySelector('.jp-scores').onclick = function() { showScores(showSetup); };
        panel.querySelector('.jp-cancel').onclick = function() { quitLive(); };
        setHint('');
        renderPodiums();
    }

    // The pause menu freezes the game clock, so the buzzer race, answer clock,
    // host's voice, timer bar and music all stop where they are and pick up
    // again on Resume. Opening Settings pauses the same way.
    let pauseEl = null;
    function showPauseMenu(withSettings) {
        if (pauseEl) {
            if (withSettings && !pauseEl.querySelector('.jp-form')) { swapPauseContents('settings'); return; }
            closePauseMenu();
            return;
        }
        JPClock.pause();
        pauseEl = h('div', 'jp-dialog');
        U.root.appendChild(pauseEl);
        swapPauseContents(withSettings ? 'settings' : 'pause');
    }
    // mode: 'pause' | 'settings' | 'results' | 'rewind'
    function swapPauseContents(mode) {
        if (mode === true) mode = 'settings';
        let inner = h('div', 'jp-panel jp-wide');
        let title = mode == 'settings' ? 'Settings' : mode == 'results' ? 'Edit results' : mode == 'rewind' ? 'Rewind' : 'Paused';
        let body = mode == 'settings' ? settingsForm() + '<p class="jp-note">The game is paused. Changes apply from the next clue.</p>'
                 : mode == 'results' ? resultsForm()
                 : mode == 'rewind' ? rewindForm()
                 : '<p class="jp-note">The game is frozen where it is.</p>';
        inner.innerHTML = '<h1>' + title + '</h1>' + body +
            '<div class="jp-menu-row"><button class="jp-btn jp-resume">Resume</button>' +
            (mode == 'settings' ? '' : '<button class="jp-btn jp-secondary jp-show-settings">Settings</button>') +
            (mode == 'results' ? '' : '<button class="jp-btn jp-secondary jp-show-results">Edit results</button>') +
            (mode == 'rewind' ? '' : '<button class="jp-btn jp-secondary jp-show-rewind">Rewind</button>') +
            '<button class="jp-btn jp-secondary jp-restart">Restart game</button>' +
            '<button class="jp-btn jp-secondary jp-quit">Quit to page</button></div>';
        pauseEl.innerHTML = '';
        pauseEl.appendChild(inner);
        pauseEl.scrollTop = 0;
        if (mode == 'settings') bindSettingsForm(inner);
        if (mode == 'results') bindResultsForm(inner);
        if (mode == 'rewind') bindRewindForm(inner);
        inner.querySelector('.jp-resume').onclick = closePauseMenu;
        let ss = inner.querySelector('.jp-show-settings');
        if (ss) ss.onclick = function() { swapPauseContents('settings'); };
        let sr = inner.querySelector('.jp-show-results');
        if (sr) sr.onclick = function() { swapPauseContents('results'); };
        let sw = inner.querySelector('.jp-show-rewind');
        if (sw) sw.onclick = function() { swapPauseContents('rewind'); };
        inner.querySelector('.jp-restart').onclick = function() { closePauseMenu(); runToken++; JPAudio.stopSpeaking(); JPAudio.stopLoop(); showSetup(); };
        inner.querySelector('.jp-quit').onclick = function() { closePauseMenu(); quitLive(); };
        // Focus Resume for the keyboard, without scrolling a tall panel (Settings) down to it.
        setTimeout(function() { let b = inner.querySelector('.jp-resume'); if (b) b.focus({ preventScroll: true }); if (pauseEl) pauseEl.scrollTop = 0; }, 0);
    }

    // Your responses so far, each with a three-way choice. Changing one
    // corrects the money (and the tally); the clue itself is not replayed.
    function resultsForm() {
        let recs = (G && G.results) || [ ];
        if (!recs.length) return '<p class="jp-note">You haven\'t responded to a clue yet. Once you have, each response is listed here and can be marked right, wrong, or scratched if the judge got it wrong.</p>';
        let rows = recs.map(function(r) {
            let where = r.kind == 'fj' ? 'Final Jeopardy!' : (roundTitle(r.round) + ' · ' + money(r.value) + (r.kind == 'dd' ? ' Daily Double' : ''));
            let stake = money(r.amount);
            function opt(v, label) {
                return '<label class="jp-result-opt"><input type="radio" name="jp-res-' + r.id + '" value="' + v + '"' + (r.outcome == v ? ' checked' : '') + '> ' + label + '</label>';
            }
            return '<tr data-id="' + r.id + '">' +
                '<td><div class="jp-result-where">' + esc(where) + '</div><div class="jp-result-cat">' + esc(r.category) + '</div></td>' +
                '<td class="jp-result-said">' + (r.said ? '“' + esc(r.said) + '”' : '<i>(no response)</i>') + '</td>' +
                '<td class="jp-result-correct">' + esc(r.correct) + '</td>' +
                '<td class="jp-result-choice">' + opt('right', 'Right <span class="jp-plus">+' + stake + '</span>') + opt('none', 'No response <span class="jp-zero">$0</span>') + opt('wrong', 'Wrong <span class="jp-minus">−' + stake + '</span>') +
                (r.others && r.others.length ? '<div class="jp-note jp-result-others">If you\'re not right, then: ' + r.others.map(function(o) { return esc(o.who) + ' ' + (o.right ? '<span class="jp-plus">+' : '<span class="jp-minus">−') + money(Math.abs(o.delta)) + '</span>'; }).join(', ') + '</div>' : '') +
                '</td></tr>';
        }).join('');
        return '<p class="jp-note">If the judge got one of your responses wrong, fix it here. The money follows: yours, and that of anyone who rang in after you on that clue (right, and they never got the chance; wrong, and they play it out as broadcast). The ring-in order and control of the board stay as they happened.</p>' +
            '<table class="jp-results"><tr><th>Clue</th><th>You said</th><th>Correct response</th><th>Result</th></tr>' + rows + '</table>' +
            '<p class="jp-result-total">Your score: <b class="jp-result-score">' + money(G.scores[YOU]) + '</b></p>';
    }
    // Every clue played so far, in order, each a point to go back to.
    function rewindForm() {
        let hist = (G && G.history) || [ ];
        if (!hist.length) return '<p class="jp-note">Nothing to rewind yet — the list fills in as clues are played.</p>';
        let rows = hist.map(function(snap, i) {
            let where = snap.num == null ? 'Final Jeopardy!' : roundTitle(snap.round) + ' · ' + money(snap.value);
            let picker = snap.num == null ? '' : (snap.control == YOU ? 'you had the board' : snap.control + ' had the board');
            let rec = (G.results || [ ]).find(function(r) { return snap.num != null ? (r.kind != 'fj' && r.num == snap.num) : r.kind == 'fj'; });
            let yours = rec ? ('You: ' + (rec.said ? '“' + esc(rec.said) + '”' : '(no response)') + ' — ' + (rec.outcome == 'right' ? '<span class="jp-plus">right</span>' : rec.outcome == 'wrong' ? '<span class="jp-minus">wrong</span>' : 'no response')) : '';
            let total = Object.keys(snap.scores).map(function(n) { return (n == YOU ? 'you' : n) + ' ' + money(snap.scores[n]); }).join(' · ');
            return '<tr data-i="' + i + '">' +
                '<td class="jp-rw-n">' + (i + 1) + '</td>' +
                '<td><div class="jp-result-where">' + esc(where) + '</div><div class="jp-result-cat">' + esc(snap.category) + '</div></td>' +
                '<td class="jp-rw-info"><div>' + esc(picker) + '</div><div class="jp-note">' + yours + '</div></td>' +
                '<td class="jp-rw-scores jp-note">' + esc(total) + '</td>' +
                '<td><button class="jp-btn jp-secondary jp-rw-go" style="padding:3px 10px;font-size:0.9em">Rewind to here</button></td></tr>';
        }).join('');
        return '<p class="jp-note">Go back to the moment before any clue. That clue and everything after it are played again; the board, the money and who has it are as they were then (the scores shown are from just before each clue), and your responses from that point on are cleared.</p>' +
            '<table class="jp-results jp-rewind"><tr><th>#</th><th>Clue</th><th>What happened</th><th>Scores before</th><th></th></tr>' + rows + '</table>';
    }
    function bindRewindForm(panel) {
        panel.querySelectorAll('.jp-rw-go').forEach(function(b) {
            b.addEventListener('click', function() { rewindTo(+b.closest('tr').dataset.i); });
        });
    }

    function bindResultsForm(panel) {
        panel.querySelectorAll('.jp-results input[type=radio]').forEach(function(r) {
            r.addEventListener('change', function() {
                if (!r.checked) return;
                let id = +r.closest('tr').dataset.id;
                let rec = G.results[id];
                if (!rec) return;
                setOutcome(rec, r.value);
                let sc = panel.querySelector('.jp-result-score');
                if (sc) sc.textContent = money(G.scores[YOU]);
            });
        });
    }
    function closePauseMenu() {
        if (pauseEl) { pauseEl.remove(); pauseEl = null; }
        JPClock.resume();
    }

    // --------------------------------------------------------- game flows

    startLiveGame = function() {
        loadSettings();
        buildOverlay();
        JPAudio.setEnabled(S.sfx);
        JPAudio.preload();
        setupVoices();
        liveActive = true;
        runToken++;
        JPClock.resume();
        G = { round: '', scores: { }, played: { }, control: null, results: [ ], history: [ ], recorded: null, stats: { buzzWins: 0, buzzLost: 0, lockouts: 0, answered: 0, correct: 0, wrong: 0, clues: 0 } };
        for (let n of realNames()) G.scores[n] = 0;
        G.scores[YOU] = 0;
        document.addEventListener('keydown', onKey, true);
        U.root.style.display = 'flex';
        showSetup();
        neuralAutoLoad();
        earAutoLoad();
    };

    function quitLive() {
        runToken++;
        liveActive = false;
        handlers = { buzz: null, override: null, cont: null, pick: null };
        JPAudio.stopSpeaking();
        JPAudio.stopLoop();
        closePauseMenu();
        JPClock.resume();
        document.removeEventListener('keydown', onKey, true);
        if (typeof JPEar !== 'undefined') JPEar.closeMic();
        if (U) U.root.style.display = 'none';
    }

    // ------------------------------------------------------ the host's script
    // Lines that make the host sound like a host: standings at the top of
    // Double Jeopardy!, who starts, the Daily Double exchange, Final Jeopardy!
    // Money is written "$8,000" — both voice engines read that naturally.

    function isChampion(name) {
        try { return /winnings total/i.test((contestants[name] || { }).info || ''); } catch (e) { return false; }
    }
    function heShe(who) { return who == YOU ? 'you' : (guessGender(who) == 'f' ? 'she' : 'he'); }
    function himHer(who) { return who == YOU ? 'you' : (guessGender(who) == 'f' ? 'her' : 'him'); }
    function ordinalPlace(i) { return [ 'first', 'second', 'third', 'fourth' ][i] || (i + 1) + 'th'; }
    function joinNatural(items) {
        if (items.length <= 1) return items.join('');
        if (items.length == 2) return items[0] + ' and ' + items[1];
        return items.slice(0, -1).join(', ') + ', and ' + items[items.length - 1];
    }
    // Standings order: by money, and on a tie you rank above the contestants
    // (they keep podium order among themselves). ranked(scores) is high to low.
    function ranked(scores) {
        let base = realNames().concat([ YOU ]);
        let names = base.slice();
        names.sort(function(a, b) {
            if (scores[b] != scores[a]) return scores[b] - scores[a];
            if (a == YOU) return -1;
            if (b == YOU) return 1;
            return base.indexOf(a) - base.indexOf(b);
        });
        return names;
    }
    // "Holly leads with $8,000. Mark has $5,000, you have $3,000, and Michael has $2,000."
    function standingsSentence() {
        let names = ranked(G.scores);
        let groups = [ ];
        for (let n of names) {
            let g = groups[groups.length - 1];
            if (g && g.score == G.scores[n]) g.who.push(n); else groups.push({ score: G.scores[n], who: [ n ] });
        }
        function has(g) { return g.who.length > 1 ? (joinNatural(g.who.map(function(n) { return n == YOU ? 'you' : n; })) + ' are tied at ' + money(g.score)) : (g.who[0] == YOU ? 'you have ' + money(g.score) : g.who[0] + ' has ' + money(g.score)); }
        let lead = groups[0], rest = groups.slice(1);
        let first = lead.who.length > 1 ? joinNatural(lead.who.map(function(n) { return n == YOU ? 'you' : n; })) + ' are tied for the lead at ' + money(lead.score) + '.'
                  : (lead.who[0] == YOU ? 'You lead with ' + money(lead.score) + '.' : lead.who[0] + ' leads with ' + money(lead.score) + '.');
        if (!rest.length) return first;
        let others = joinNatural(rest.map(has));
        return first + ' ' + others.charAt(0).toUpperCase() + others.slice(1) + '.';
    }
    function roundOpeningLine(round) {
        let who = G.control;
        if (round == 'J') {
            if (who == YOU) return 'You start us off. Pick a clue.';
            return isChampion(who) ? who + ', as our returning champion, you start us off.' : who + ', you start us off.';
        }
        // Double Jeopardy!: the standings, then the trailing player picks first.
        let names = realNames().concat([ YOU ]);
        let low = Math.min.apply(null, names.map(function(n) { return G.scores[n]; }));
        let tiedLow = names.filter(function(n) { return G.scores[n] == low; }).length > 1;
        let starter = who == YOU ? (tiedLow ? 'You\'ll start us off.' : 'You\'re in last place, so you\'ll start us off.')
                                 : (tiedLow ? who + ', you\'ll start us off.' : who + ', you\'re in last place, so you\'ll start us off.');
        return 'The scores as we begin Double Jeopardy: ' + standingsSentence() + ' ' + starter;
    }
    function roundEndLine(round) {
        return round == 'J' ? 'And that\'s the end of the Jeopardy round.' : 'That\'s the end of Double Jeopardy. Coming up: Final Jeopardy.';
    }
    function placeOf(who, scores) { return ranked(scores).indexOf(who); }

    async function startGame() {
        runToken++;
        let tok = runToken;
        saveSettings();
        setupVoices();
        // If the studio voice is chosen and still loading, give it a moment (it's usually seconds).
        let earLoading = function() { return earAvailableHere() && S.earEngine != 'chrome' && JPEar.state.loading; };
        if ((S.voiceEngine == 'neural' && neuralAvailableHere() && JPNeural.state.loading) || earLoading()) {
            showPanel('<h1>One moment</h1><p>Preparing the studio ' + (earLoading() ? 'ear' : 'voice') + '…</p><p class="jp-note">Click or press <span class="jp-key">' + buzzKeyName() + '</span> to start without it (Chrome\'s recognizer and the system voice fill in).</p>').classList.add('jp-clickthrough');
            let skip = false;
            handlers.cont = function() { skip = true; };
            for (let i = 0; i < 900 && ((neuralAvailableHere() && JPNeural.state.loading) || earLoading()) && !skip; i++) { await sleep(100, tok); if (!alive(tok)) return; }
            handlers.cont = null;
        }
        G.scores = { };
        for (let n of realNames()) G.scores[n] = 0;
        G.scores[YOU] = 0;
        G.played = { };
        G.results = [ ];
        G.history = [ ];
        G.recorded = null;
        G.stats = { buzzWins: 0, buzzLost: 0, lockouts: 0, answered: 0, correct: 0, wrong: 0, clues: 0 };
        // The returning champion (leftmost podium on J! Archive) picks first.
        G.control = realNames()[0] || YOU;
        renderPodiums();
        await runGame(tok, 'J', false);
    }

    // The game from a given round onward. resumed: picking up mid-round after a
    // rewind (no round opening, no recomputed control).
    async function runGame(tok, fromRound, resumed) {
        if (fromRound == 'J' && roundNums('J').length) {
            await playRound('J', tok, resumed);
            if (!alive(tok)) return;
            resumed = false;
        }
        if ((fromRound == 'J' || fromRound == 'DJ') && roundNums('DJ').length) {
            if (!resumed) {
                // Lowest score picks first in Double Jeopardy! (the last-ranked player; ties rank you higher)
                let names = ranked(G.scores);
                setControl(names[names.length - 1]);
            }
            await playRound('DJ', tok, resumed);
            if (!alive(tok)) return;
        }
        if (fjInfo()) {
            pushHistory('FJ', null);
            await playFinal(tok);
            if (!alive(tok)) return;
        }
        showFinalStandings();
    }

    // ---- rewind: a snapshot of the game before every clue ----------------
    function clone(x) { return JSON.parse(JSON.stringify(x)); }
    function pushHistory(round, num) {
        if (!G.history) G.history = [ ];
        let info = num != null ? clueInfo(num) : null;
        G.history.push({
            round: round, num: num, category: info ? info.category.name : '', value: info ? info.value : 0,
            control: G.control, scores: clone(G.scores), played: clone(G.played), results: clone(G.results || [ ]), stats: clone(G.stats),
        });
    }
    // Back to the moment before history entry i: that clue and everything after
    // it are played again; the board, the money and control are as they were.
    function rewindTo(i) {
        let snap = G.history && G.history[i];
        if (!snap) return;
        closePauseMenu();
        runToken++;
        let tok = runToken;
        handlers = { buzz: null, override: null, cont: null, pick: null, submit: null };
        JPAudio.stopSpeaking();
        JPAudio.stopLoop();
        if (typeof JPNeural !== 'undefined') JPNeural.clearPrefetch();
        G.round = snap.round;
        G.scores = clone(snap.scores);
        G.played = clone(snap.played);
        G.control = snap.control;
        G.results = clone(snap.results);
        G.stats = clone(snap.stats);
        G.history = G.history.slice(0, i);
        G.current = null;
        renderPodiums();
        clearOuts();
        clearPodiumLines();
        showAnswerStrip(false);
        clearTimer();
        runGame(tok, snap.round, true);
    }

    function roundTitle(round) {
        return round == 'J' ? 'Jeopardy! Round' : round == 'DJ' ? 'Double Jeopardy! Round' : 'Final Jeopardy!';
    }

    // With the studio voice, have the round's lines synthesized ahead of play:
    // the categories first, then every clue in broadcast order, then the
    // "correct response" lines at a lower priority.
    function prefetchRound(round) {
        if (!usingNeural()) return;
        JPNeural.clearPrefetch();
        let v = S.neuralVoice, catIdx = round == 'J' ? 0 : 6;
        let cats = [ ], notes = [ ], clueTexts = [ ], reveals = [ ];
        for (let i = 0; i < 6; i++) {
            let c = categoryInfo(catIdx + i);
            cats.push(JPReader.forNeural(categorySpoken(c.name, i), 'category'));
            if (c.comments) notes.push(JPReader.forNeural(JPReader.commentToSpeech(c.comments), 'line'));
        }
        for (let n of roundNums(round)) {
            if (G.played[n]) continue;
            let info;
            try { info = clueInfo(n); } catch (e) { continue; }
            clueTexts.push(JPReader.forNeural(info.queryText, 'clue'));
            reveals.push(JPReader.forNeural('The correct response: ' + info.phrase.toLowerCase() + ' ' + JPReader.responseToSpeech(info.abbrev) + '?', 'line'));
        }
        JPNeural.prefetch([ JPReader.forNeural(round == 'J' ? 'Let\'s take a look at the categories.' : 'Here are the categories in Double Jeopardy.', 'line') ], v, S.rate * 0.95, 90);
        JPNeural.prefetch(cats, v, S.rate * CATEGORY_RATE, 100);
        JPNeural.prefetch([ JPReader.forNeural(roundOpeningLine(round), 'line') ], v, S.rate * (round == 'DJ' ? 0.97 : 1), 105);
        JPNeural.prefetch(notes, v, S.rate * 0.92, 110);
        JPNeural.prefetch([ JPReader.forNeural(roundEndLine(round), 'line') ], v, S.rate, 1200);
        JPNeural.prefetch(clueTexts, v, S.rate, 200);
        JPNeural.prefetch(reveals, v, S.rate, 1000);
        // The contestants' archived responses, in their own studio voices.
        if (S.contestantVoices && S.contestantEngine != 'system') {
            let byVoice = { };
            for (let n of roundNums(round)) {
                if (G.played[n]) continue;
                let info;
                try { info = clueInfo(n); } catch (e) { continue; }
                for (let ev of info.sequence) {
                    let text = ev.right ? (info.phrase + ' ' + JPJudge.stripHtml(info.abbrev) + '?') : (wrongResponseText(clues[n], ev.who) || '(an incorrect response)');
                    let voice = neuralVoiceMap[ev.who] || v;
                    (byVoice[voice] = byVoice[voice] || [ ]).push(JPReader.forNeural(JPReader.responseToSpeech(text.replace(/^\(|\)$/g, '')), 'line'));
                }
            }
            for (let voice in byVoice) JPNeural.prefetch(byVoice[voice], voice, S.rate, 600);
        }
    }

    async function playRound(round, tok, resumed) {
        G.round = round;
        prefetchHostLines();
        prefetchRound(round);
        setHeader(roundTitle(round), '', '');
        clearTimer();
        showAnswerStrip(false);
        clearPodiumLines();
        clearOuts();
        setHint('');

        // Board reveal + category read-through.
        renderBoard(round, false);
        JPAudio.play('boardfill');
        let r = { skipped: resumed ? true : false };
        if (resumed) { await pause(900, tok); if (!alive(tok)) return; }
        if (S.readCategories && !r.skipped) {
            r = await readCategories(round, tok);
            if (!alive(tok)) return;
            if (!r.skipped) { await sleep(500, tok); if (!alive(tok)) return; }
        } else if (!r.skipped) {
            await pause(900, tok);
            if (!alive(tok)) return;
        }
        if (!r.skipped) {
            // Who starts: the champion in the first round; in Double Jeopardy! the
            // standings, ending with the trailing player, who then picks straight away.
            setHint('Click or press <span class="jp-key">' + buzzKeyName() + '</span> to skip.');
            r = await hostSaySkippable(roundOpeningLine(round), tok, round == 'DJ' ? 0.97 : 1);
            if (!alive(tok)) return;
        }

        while (alive(tok)) {
            let remaining = roundNums(round).filter(function(n) { return !G.played[n]; });
            if (!remaining.length) break;
            G.phase = 'pick';
            let num;
            if (remaining.length == 1) {
                // The last clue picks itself; the host announces it, whoever has the board.
                num = remaining[0];
                renderBoard(round, false);
                let info = clueInfo(num);
                let cell = boardCell(num);
                if (cell) cell.classList.add('jp-picking');
                setHint('The last clue of the round.');
                await say('And now, the last clue of the round: ' + JPReader.categoryToSpeech(info.category.name) + ' for ' + money(info.value) + '.', tok);
                if (!alive(tok)) return;
                await sleep(250, tok);
                if (!alive(tok)) return;
            } else if (G.control == YOU) {
                setHint('<b>You have control.</b> Click a clue on the board.');
                renderBoard(round, true);
                num = await userPick(tok);
                if (!alive(tok)) return;
            } else {
                num = remaining[0]; // broadcast order
                renderBoard(round, false);
                let info = clueInfo(num);
                let cell = boardCell(num);
                if (cell) cell.classList.add('jp-picking');
                setHint(esc(G.control) + ' has control.');
                podiumLine(G.control, '&ldquo;' + esc(info.category.name) + ' for ' + money(info.value) + '&rdquo;');
                await csay(G.control, JPReader.categoryToSpeech(info.category.name) + ' for ' + info.value, tok);
                if (!alive(tok)) return;
                await sleep(S.contestantVoices ? 150 : 700, tok);
                if (!alive(tok)) return;
            }
            pushHistory(round, num);
            await playClue(num, tok);
            if (!alive(tok)) return;
        }

        G.phase = 'other';
        JPAudio.play('roundend');
        showPanel('<h1>End of the ' + roundTitle(round) + '</h1>' + standingsTable() + '<p class="jp-note">Click or press <span class="jp-key">' + buzzKeyName() + '</span> to continue.</p>').classList.add('jp-clickthrough');
        setHint('');
        let e = await hostSaySkippable(roundEndLine(round), tok, 1);
        if (!alive(tok)) return;
        if (!e.skipped) await pause(2500, tok);
    }

    // The host reads the six categories the way the show does: one at a time,
    // a little slower than a clue, with a beat between them, while the board
    // lights up the one being read. A click or the buzz key skips the rest.
    // Categories are read slower than clues, with a beat between them — but not so slow that it drags.
    const CATEGORY_RATE = 0.93;
    // The sixth category gets the "and finally" the host gives it.
    function categorySpoken(name, i) {
        let t = JPReader.categoryToSpeech(name);
        return i == 5 ? 'And finally, ' + t : t;
    }
    async function readCategories(round, tok) {
        let catIdx = round == 'J' ? 0 : 6;
        setHint('The host is reading the categories — click or press <span class="jp-key">' + buzzKeyName() + '</span> to skip.');
        let r = await hostSaySkippable(round == 'J' ? 'Let\'s take a look at the categories.' : 'Here are the categories in Double Jeopardy.', tok, 0.95);
        if (!alive(tok) || r.skipped) return r;
        for (let i = 0; i < 6; i++) {
            let c = categoryInfo(catIdx + i);
            let cell = boardEl ? boardEl.querySelectorAll('.jp-cathead')[i] : null;
            if (cell) cell.classList.add('jp-reading');
            let text = categorySpoken(c.name, i);
            r = await hostSaySkippable(text, tok, CATEGORY_RATE, 'category');
            if (alive(tok) && !r.skipped && c.comments) {
                await sleep(250, tok);
                r = await hostSaySkippable(JPReader.commentToSpeech(c.comments), tok, 0.92);
            }
            if (cell) cell.classList.remove('jp-reading');
            if (!alive(tok) || r.skipped) return r;
            if (i < 5) { await sleep(700, tok); if (!alive(tok)) return r; }
        }
        return { alive: alive(tok), skipped: false };
    }

    // ----------------------------------------------------------- the board

    let boardEl = null;
    function renderBoard(round, pickable) {
        boardEl = h('div', 'jp-board');
        let catIdx = round == 'J' ? 0 : 6;
        for (let i = 0; i < 6; i++) {
            let c = categoryInfo(catIdx + i);
            boardEl.appendChild(h('div', 'jp-cell jp-cathead', esc(c.name) + (c.comments ? '<small>' + esc(c.comments) + '</small>' : '')));
        }
        let lowest = roundLowest(round);
        let byPos = { };
        for (let n of roundNums(round)) { let p = position(n); if (p) byPos[p.col + '_' + p.row] = n; }
        for (let row = 1; row <= 5; row++) {
            for (let col = 1; col <= 6; col++) {
                let n = byPos[col + '_' + row];
                let cell = h('div', 'jp-cell jp-value');
                if (!n || G.played[n]) {
                    cell.classList.add('jp-empty');
                    cell.innerHTML = '&nbsp;';
                } else {
                    let v = clues[n].value || row * lowest;
                    cell.innerHTML = '<span class="jp-dollar">$</span>' + v;
                    cell.dataset.num = n;
                    if (pickable) {
                        cell.classList.add('jp-pickable');
                        cell.onclick = function() { if (handlers.pick) handlers.pick(n); };
                    }
                }
                boardEl.appendChild(cell);
            }
        }
        stage(boardEl);
    }
    function boardCell(num) { return boardEl ? boardEl.querySelector('.jp-cell[data-num="' + num + '"]') : null; }

    // ---- picking a clue: click a cell, or say it ("Science for 600",
    // "Shakespeare, 400", "same category for 800").
    const NUMBER_WORDS = { 'two hundred': 200, '2 hundred': 200, 'four hundred': 400, '4 hundred': 400, 'six hundred': 600, '6 hundred': 600,
        'eight hundred': 800, '8 hundred': 800, 'a thousand': 1000, 'one thousand': 1000, '1 thousand': 1000, 'thousand': 1000,
        'twelve hundred': 1200, '12 hundred': 1200, 'sixteen hundred': 1600, '16 hundred': 1600, 'two thousand': 2000, '2 thousand': 2000 };
    const PICK_STOP = /^(the|a|an|for|and|let's|lets|let|us|go|to|with|please|i'll|ill|i|take|give|me|category|categories|dollars|dollar|bucks|um|uh|of|in|on|that|this|it|one|next|pick|choose|select|try|do|we'll|well|okay|ok|hundred|thousand|same|stay|again|there|back|up|down|at|now|then|how|about|and)$/;
    function normalizeSpeech(t) { return String(t || '').toLowerCase().replace(/[$,]/g, '').replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
    function amountIn(text, values) {
        let t = ' ' + normalizeSpeech(text) + ' ';
        let found = null;
        for (let k in NUMBER_WORDS) if (t.indexOf(' ' + k + ' ') >= 0 && values.indexOf(NUMBER_WORDS[k]) >= 0) found = NUMBER_WORDS[k];
        let m, re = /\b(\d{3,4})\b/g;
        while ((m = re.exec(t)) !== null) { let v = +m[1]; if (values.indexOf(v) >= 0) found = v; }
        m = /\b([12])k\b/.exec(t); if (m && values.indexOf(+m[1] * 1000) >= 0) found = +m[1] * 1000;
        return found;
    }
    function sameWord(a, b) {
        if (a == b) return true;
        if (a.length < 3 || b.length < 3) return false;
        if (a + 's' == b || b + 's' == a) return true;
        let sim = JPJudge.similarity(a, b);
        return Math.max(a.length, b.length) >= 5 ? sim >= 0.8 : false;
    }
    function categoryWords(name) {
        let raw = normalizeSpeech(name).split(' ');
        let spoken = normalizeSpeech(JPReader.categoryToSpeech(name)).split(' ');
        let out = [ ];
        raw.concat(spoken).forEach(function(w) { if (w && !PICK_STOP.test(w) && out.indexOf(w) < 0) out.push(w); });
        return out;
    }
    // Which unplayed clue the words name, or null. round: 'J' | 'DJ'.
    function parsePick(text, round) {
        let t = normalizeSpeech(text);
        if (!t) return null;
        let nums = roundNums(round).filter(function(n) { return !G.played[n]; });
        if (!nums.length) return null;
        let lowest = roundLowest(round);
        function valueOf(n) { let p = position(n); return clues[n].value || (p ? p.row * lowest : 0); }
        let values = [ ];
        nums.forEach(function(n) { let v = valueOf(n); if (v && values.indexOf(v) < 0) values.push(v); });
        let amount = amountIn(t, values);
        let said = t.split(' ').filter(function(w) { return w && !PICK_STOP.test(w) && !/^\d+$/.test(w) && w.length >= 3; });
        // Score the categories that still have clues.
        let catIdx = round == 'J' ? 0 : 6, scores = [ ];
        for (let i = 0; i < 6; i++) {
            let has = nums.some(function(n) { let p = position(n); return p && p.catIdx == catIdx + i; });
            if (!has) { scores.push(0); continue; }
            let words = categoryWords(categoryInfo(catIdx + i).name);
            let hits = 0;
            for (let w of words) if (said.some(function(x) { return sameWord(x, w); })) hits++;
            scores.push(words.length ? hits / Math.min(words.length, 3) + hits * 0.01 : 0);
        }
        let col = -1;
        if (/\b(same|stay|again)\b/.test(t) && G.current && G.current.category) {
            for (let i = 0; i < 6; i++) if (categoryInfo(catIdx + i).name == G.current.category.name && nums.some(function(n) { let p = position(n); return p && p.catIdx == catIdx + i; })) col = i;
        }
        if (col < 0) {
            let best = Math.max.apply(null, scores);
            if (best >= 0.33 && scores.filter(function(x) { return x == best; }).length == 1) col = scores.indexOf(best);
        }
        let candidates = nums.filter(function(n) {
            let p = position(n);
            if (col >= 0 && (!p || p.catIdx != catIdx + col)) return false;
            if (amount != null && valueOf(n) != amount) return false;
            return true;
        });
        if (col >= 0 && amount != null && candidates.length == 1) return candidates[0];
        if (col >= 0 && amount == null && candidates.length == 1) return candidates[0];   // last clue in that category
        if (col < 0 && amount != null && candidates.length == 1) return candidates[0];    // only one clue left at that value
        return null;
    }
    function userPick(tok) {
        let useVoice = S.voicePick && S.answerMode == 'speech' && JPAudio.recognitionSupported();
        setHint('<b>You have control.</b> ' + (useVoice ? 'Say a category and an amount ("Science for 600"), or click a clue.' : 'Click a clue on the board.') + (useVoice ? ' <span class="jp-heard-pick jp-note"></span>' : ''));
        return new Promise(function(resolve) {
            let done = false, current = null;
            function finish(n) {
                if (done) return;
                done = true;
                handlers.pick = null;
                JPClock.off(onPausePick);
                if (current) current.stop();
                resolve(n);
            }
            handlers.pick = function(n) { finish(n); };
            function onPausePick() { if (current) current.stop(); }
            if (!useVoice) return;
            JPClock.onPause(onPausePick);
            (async function() {
                while (!done && alive(tok)) {
                    await JPClock.whenRunning();
                    if (done || !alive(tok)) break;
                    let heard = document.querySelector('.jp-heard-pick');
                    current = JPAudio.listen(20000, function(text) {
                        if (heard) heard.textContent = text ? '“' + text + '”' : '';
                        let n = parsePick(text, G.round);
                        if (n != null) { let cell = boardCell(n); if (cell) cell.classList.add('jp-picking'); finish(n); }
                    }, { endOnFinal: false });
                    pickListener = current;
                    let r = await current;
                    if (done) break;
                    if (r.text) { let n = parsePick(r.text, G.round); if (n != null) { finish(n); break; } }
                    if (r.error == 'not-allowed' || r.error == 'service-not-allowed' || r.error == 'audio-capture' || r.error == 'unsupported') break;
                    await sleep(150, tok);
                }
            })();
        });
    }

    // --------------------------------------------------------- one clue

    async function playClue(num, tok) {
        let info = clueInfo(num);
        G.current = info;
        G.phase = 'clue';
        G.pendingControl = false;
        G.played[num] = true;
        G.stats.clues++;
        handlers.override = null;
        clearPodiumLines();
        clearOuts();
        lightPodium(null);
        setHeader(roundTitle(G.round), info.category.name, money(info.value));
        JPAudio.play('select');
        await sleep(200, tok);
        if (!alive(tok)) return;

        if (info.dd) {
            await playDailyDouble(info, tok);
            return;
        }

        showClue(clueHtml(info), { category: info.category, value: money(info.value) });
        clearTimer();

        // Early buzz = lockout. The handler is live while the host is reading.
        let armed = false, lockedUntil = 0;
        handlers.buzz = function() {
            if (armed) return;
            lockedUntil = JPClock.now() + S.lockoutMs;
            G.stats.lockouts++;
            JPAudio.play('lockout');
            flashLocked();
        };
        setHint('Wait for the lights, then click or press <span class="jp-key">' + buzzKeyName() + '</span> to ring in.');
        await hostSay(info.queryText, 'clue');
        if (!alive(tok)) { handlers.buzz = null; return; }

        // Lights on.
        armed = true;
        setLit(true);
        JPAudio.play('lights');
        let userOut = false;
        let seqIdx = 0;
        let resolved = false;
        let responded = { };
        let events = [ ], userRec = null, userAt = -1;   // contestant responses in order; where yours fell

        while (alive(tok) && !resolved) {
            let next = info.sequence[seqIdx] || null;
            while (next && responded[next.who]) next = info.sequence[++seqIdx] || null;
            setTimer(S.buzzWindowSeconds, 'green');
            let isRebound = Object.keys(responded).length > 0 || userOut;
            let ev = await race(tok, next, S.buzzWindowSeconds * 1000, !userOut, function() { return lockedUntil; }, function(t) { lockedUntil = t; }, ringInMult(info, isRebound));
            if (!alive(tok)) break;
            clearTimer();

            if (ev.type == 'user') {
                G.stats.buzzWins++;
                JPAudio.play('buzz');
                lightPodium(YOU);
                setLit(false);
                let res = await userAnswers(info, S.answerSeconds, tok, info.value);
                if (!alive(tok)) break;
                userRec = res.rec || null; userAt = events.length;
                if (userRec) {
                    // What the rest of the broadcast holds for this clue, should your response turn out wrong.
                    userRec.others = info.sequence.filter(function(x) { return !responded[x.who]; }).map(function(x) { return { who: x.who, right: x.right, delta: x.right ? info.value : -info.value }; });
                    userRec.othersDelta = { };
                }
                if (res.correct) {
                    setControl(YOU);
                    resolved = true;
                } else {
                    userOut = true;
                    markOut(YOU, true);
                    if (!next) {
                        await revealCorrect(info, tok, true);
                        resolved = true;
                    } else {
                        setLit(true);
                        lightPodium(null);
                        JPAudio.play('lights');
                        setHint('Rebound — the others can ring in now.');
                    }
                }
            } else if (ev.type == 'contestant') {
                if (next && !userOut) G.stats.buzzLost++;
                JPAudio.play('buzz');
                lightPodium(ev.who);
                setLit(false);
                responded[ev.who] = true;
                events.push({ who: ev.who, right: ev.right });
                await sleep(clamp(gauss(650, 200), 300, 1200), tok);
                if (!alive(tok)) break;
                let text = ev.right ? (info.phrase + ' ' + JPJudge.stripHtml(info.abbrev) + '?') : (wrongResponseText(clues[num], ev.who) || '(an incorrect response)');
                podiumLine(ev.who, '<span class="' + (ev.right ? 'jp-correct' : 'jp-incorrect') + '">' + esc(text) + '</span>');
                setSub('<span class="jp-who">' + esc(ev.who) + ':</span> ' + esc(text));
                await csay(ev.who, JPReader.responseToSpeech(text.replace(/^\(|\)$/g, '')), tok);
                if (!alive(tok)) break;
                if (ev.right) {
                    adjustScore(ev.who, info.value);
                    if (userRec) userRec.othersDelta[ev.who] = info.value;
                    setControl(ev.who);
                    setSub('<span class="jp-who">' + esc(ev.who) + ':</span> ' + esc(text) + ' &nbsp; <span class="jp-correct">' + esc(pick(HOST_RIGHT)) + '</span>');
                    await say(pick(HOST_RIGHT), tok);
                    resolved = true;
                } else {
                    adjustScore(ev.who, -info.value);
                    if (userRec) userRec.othersDelta[ev.who] = -info.value;
                    markOut(ev.who, true);
                    setSub('<span class="jp-who">' + esc(ev.who) + ':</span> ' + esc(text) + ' &nbsp; <span class="jp-incorrect">' + esc(pick(HOST_WRONG)) + '</span>');
                    await say(pick(HOST_WRONG), tok);
                    if (!alive(tok)) break;
                    seqIdx++;
                    let more = info.sequence.slice(seqIdx).some(function(x) { return !responded[x.who]; });
                    if (!more && userOut) {
                        await revealCorrect(info, tok, true);
                        resolved = true;
                    } else {
                        setLit(true);
                        lightPodium(null);
                        JPAudio.play('lights');
                        setHint(userOut ? 'Rebound.' : 'Rebound — press <span class="jp-key">' + buzzKeyName() + '</span> to ring in.');
                    }
                }
            } else { // timeout
                await revealCorrect(info, tok, false);
                resolved = true;
            }
        }
        handlers.buzz = null;
        if (userRec) {
            // Those who actually followed you are the ones whose money moves with your result
            // (they are the archived sequence, played out as far as it went).
            let followed = events.slice(userAt);
            if (followed.length) userRec.others = followed.map(function(e) { return { who: e.who, right: e.right, delta: e.right ? info.value : -info.value }; });
            reconcileOthers(userRec);   // a "y" pressed while they were still answering
            if (G.pendingControl) setControl(controlFor(userRec));   // ...and the board goes with it
        }
        G.phase = 'pick';
        setLit(false);
        clearTimer();
        lightPodium(null);
        setHint('Click or press <span class="jp-key">' + buzzKeyName() + '</span> to continue.');
        await pause(S.autoAdvanceMs, tok);
        showAnswerStrip(false);
    }

    function clueHtml(info) {
        let html = info.queryHtml.replace(/<a [^>]*>(.*?)<\/a>/g, '$1');
        for (let m of info.media) {
            if (/\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i.test(m)) html += '<img src="' + esc(m) + '" alt="">';
            else if (/\.(mp4|webm|mov|m4v)(\?.*)?$/i.test(m)) html += '<video src="' + esc(m) + '" autoplay muted playsinline></video>';
            else html += '<div class="jp-clue-medium"><a href="' + esc(m) + '" target="_blank" rel="noopener" style="color:gold">&#9654; media clue</a></div>';
        }
        return html;
    }

    // Wait for the first of: the user's buzz, the next archived contestant's
    // simulated buzz, or the ring-in window closing.
    function race(tok, contestant, windowMs, userAllowed, getLock, setLock, mult) {
        return new Promise(function(resolve) {
            let done = false;
            let timers = [ ];
            function finish(ev) {
                if (done) return;
                done = true;
                timers.forEach(JPClock.clearTimeout);
                handlers.buzz = null;
                resolve(ev);
            }
            if (contestant) {
                let t = clamp(reaction(mult), 60, windowMs - 30);
                timers.push(JPClock.setTimeout(function() { finish({ type: 'contestant', who: contestant.who, right: contestant.right, t: t }); }, t));
            }
            timers.push(JPClock.setTimeout(function() { finish({ type: 'timeout' }); }, windowMs));
            handlers.buzz = function() {
                let now = JPClock.now();
                if (now < getLock()) { setLock(now + S.lockoutMs); G.stats.lockouts++; JPAudio.play('lockout'); flashLocked(); return; }
                if (!userAllowed) return;
                finish({ type: 'user' });
            };
        });
    }

    // You rang in (or it's your Daily Double): listen / read the input, judge,
    // show the verdict with a short y/n override window, apply the money.
    // The microphone opens when you ring in and closes as soon as you've
    // responded: the first finished phrase is your response, judged right
    // away, right or wrong (no second tries -- a live game doesn't give those,
    // and an open mic changes how headphones sound).
    async function userAnswers(info, seconds, tok, amount) {
        G.stats.answered++;
        let useSpeech = S.answerMode == 'speech' && JPAudio.recognitionSupported();
        showAnswerStrip(true, useSpeech);
        setTimer(seconds, 'red');
        setHint(useSpeech ? 'Say your response (or type it and press <span class="jp-key">Enter</span>).' : 'Type your response and press <span class="jp-key">Enter</span>.');
        setSub('<span class="jp-who">You:</span> …');

        let got = await new Promise(function(resolve) {
            let done = false, listener = null, interim = '', phrases = [ ];   // phrases: the finished phrase heard, with its alternatives
            let deadline = JPClock.now() + seconds * 1000;
            function finish(typed) {
                if (done) return;
                done = true;
                JPClock.clearTimeout(t);
                JPClock.off(onPauseAnswer); JPClock.off(onResumeAnswer);
                handlers.submit = null;
                if (listener) { try { listener.stop(); } catch (e) { } }
                resolve({ typed: (typed || '').trim(), phrases: phrases, interim: interim });
            }
            let timeUp = false;
            let t = JPClock.setTimeout(function() {
                // Time's up. If a phrase is in flight (the studio ear may still be
                // transcribing what you just said), give it a moment; then judge.
                timeUp = true;
                if (listener && useSpeech) { try { listener.stop(); } catch (e) { } setTimeout(function() { finish(U.input.value); }, 4000); }
                else finish(U.input.value);
            }, seconds * 1000);
            handlers.submit = function(text) { finish(text); };

            function onHeard(text, gotFinal, segments) {
                interim = text;
                U.heard.textContent = text ? '“' + text + '”' : '';
                if (!gotFinal || !segments || !segments.length) return;
                phrases = segments.slice();
                finish(U.input.value);
            }
            function attach(l) {
                listener = l;
                l.onInterim = onHeard;
                l.then(function(r) {
                    if (listener !== l || done) return;         // superseded after a pause, or finished
                    if (r.segments && r.segments.length && !phrases.length) { phrases = r.segments.slice(); finish(U.input.value); return; }
                    if (timeUp) { finish(U.input.value); return; }
                    if (JPClock.paused) return;
                    if (r.error && r.error != 'no-speech' && r.error != 'aborted') { U.mic.className = 'jp-mic'; U.mic.textContent = 'Mic: ' + r.error + ' — type it'; return; }
                    // The recognizer ended on silence with nothing heard; keep listening while there is time.
                    let remaining = deadline - JPClock.now();
                    if (remaining > 600) startListening(remaining); else finish(U.input.value);
                });
            }
            function startListening(ms) { attach(JPAudio.listen(ms + 300, null, { endOnFinal: true })); }
            // The recognizer can't be paused, so stop it on pause and start a
            // fresh one for the remaining time on resume.
            function onPauseAnswer() { if (listener) { let l = listener; listener = null; l.stop(); } }
            function onResumeAnswer() {
                if (done || !useSpeech) return;
                let remaining = deadline - JPClock.now();
                if (remaining > 300) startListening(remaining);
            }
            JPClock.onPause(onPauseAnswer);
            JPClock.onResume(onResumeAnswer);
            if (useSpeech) startListening(seconds * 1000);
        });
        if (!alive(tok)) return { correct: false };
        clearTimer();
        U.mic.className = 'jp-mic';
        U.mic.textContent = '';

        // Judge: the typed text, then every phrase heard (each with its alternatives), newest first.
        let candidates = [ ];
        if (got.typed) candidates.push(got.typed);
        for (let i = got.phrases.length - 1; i >= 0; i--) for (let a of got.phrases[i]) candidates.push(a);
        if (!got.phrases.length && got.interim) candidates.push(got.interim);
        let heardLast = got.phrases.length ? got.phrases[got.phrases.length - 1][0] : got.interim;
        let verdict = JPJudge.judgeAny(candidates, info.correct);
        let said = got.typed || (verdict.correct && verdict.text ? verdict.text : heardLast) || '';
        let correct = !!verdict.correct;
        if (correct) G.stats.correct++; else G.stats.wrong++;
        let rec = addResult({ kind: info.dd ? 'dd' : 'clue', num: info.num, round: G.round, category: info.category.name, value: info.value, amount: amount,
                              said: said, correct: JPJudge.stripHtml(info.correct), outcome: correct ? 'right' : 'wrong' });

        function show() {
            let ok = rec.outcome == 'right', none = rec.outcome == 'none';
            let line = '<span class="jp-who">You:</span> ' + (said ? esc(said) : '<i>(no response)</i>') +
                ' &nbsp; <span class="' + (ok ? 'jp-correct' : 'jp-incorrect') + '">' + (none ? 'No response.' : ok ? esc(pick(HOST_RIGHT)) : esc(pick(HOST_WRONG))) + '</span>' +
                (ok ? '' : ' &nbsp; <span class="jp-note">Correct response: <em class="correct_response">' + info.correct + '</em></span>');
            setSub(line);
            podiumLine(YOU, '<span class="' + (ok ? 'jp-correct' : 'jp-incorrect') + '">' + (said ? esc(said) : '(no response)') + '</span>');
        }
        show();
        JPAudio.play(correct ? 'right' : 'wrong');
        let speakP = say(correct ? pick(HOST_RIGHT) : pick(HOST_WRONG), tok);
        showAnswerStrip(false);
        setHint('Misjudged? <span class="jp-key">y</span> = I was right, <span class="jp-key">n</span> = I was wrong (until the next clue; later, Edit results in the pause menu).');
        // The y/n override stays available until the next clue starts; it
        // corrects the money (control of the board is not revisited).
        handlers.override = function(isRight) {
            setOutcome(rec, isRight ? 'right' : 'wrong');
            show();
        };
        await speakP;
        return { correct: rec.outcome == 'right', said: said, rec: rec };
    }

    async function revealCorrect(info, tok, afterWrongs) {
        setLit(false);
        lightPodium(null);
        if (!afterWrongs) JPAudio.play('timeout');
        setSub('<span class="jp-note">The correct response:</span> <em class="correct_response">' + info.correct + '</em>');
        await say('The correct response: ' + info.phrase.toLowerCase() + ' ' + JPReader.responseToSpeech(info.abbrev) + '?', tok);
    }

    // ------------------------------------------------------- Daily Double

    function promptWager(min, max, title, note) {
        return new Promise(function(resolve) {
            let panel = showPanel('<h1>' + esc(title) + '</h1><p>' + note + '</p>' +
                '<p><input type="number" class="jp-wager" min="' + min + '" max="' + max + '" step="1" value="' + Math.min(max, Math.max(min, 1000)) + '" style="font-size:1.6em;width:9em;min-width:9em"> ' +
                '<button class="jp-btn jp-ok">Wager</button> <button class="jp-btn jp-secondary jp-max">All of it (' + money(max) + ')</button></p>' +
                '<p class="jp-note">Between ' + money(min) + ' and ' + money(max) + '. Press <span class="jp-key">Enter</span> to confirm.</p>');
            let inp = panel.querySelector('.jp-wager');
            setTimeout(function() { inp.focus(); inp.select(); }, 0);
            function done(v) { handlers.cont = null; resolve(clamp(Math.round(+v || 0), min, max)); }
            panel.querySelector('.jp-ok').onclick = function() { done(inp.value); };
            panel.querySelector('.jp-max').onclick = function() { done(max); };
            inp.addEventListener('keydown', function(e) { e.stopPropagation(); if (e.key == 'Enter') { e.preventDefault(); done(inp.value); } });
            handlers.cont = function() { done(inp.value); };
        });
    }

    async function playDailyDouble(info, tok) {
        let who = G.control;
        let maxVal = roundMaxValue(G.round);
        JPAudio.play('dd');
        showClue('<div class="jp-clue-big">DAILY DOUBLE</div>', { noUpper: true, category: info.category });
        podiumLine(who, 'Daily Double!');
        await say(who == YOU ? 'You\'ve found the Daily Double! You have ' + money(G.scores[YOU]) + '. What will you wager?'
                             : who + ', you\'ve found the Daily Double. You have ' + money(G.scores[who]) + '. What will you wager?', tok);
        if (!alive(tok)) return;
        await pause(300, tok);
        if (!alive(tok)) return;

        let wager;
        if (who == YOU) {
            let max = Math.max(G.scores[YOU], maxVal);
            wager = await promptWager(5, max, 'Daily Double — ' + info.category.name,
                'You have ' + money(G.scores[YOU]) + '. You may wager up to ' + money(max) + '.' + standingsTable(true));
            if (!alive(tok)) return;
        } else {
            let max = Math.max(G.scores[who], maxVal);
            let others = realNames().concat([ YOU ]).filter(function(n) { return n != who; }).map(function(n) { return G.scores[n]; });
            let cluesLeft = roundNums(G.round).filter(function(n) { return !G.played[n]; }).length;
            let d = JPWagers.dailyDoubleWager(G.scores[who], others, maxVal, cluesLeft);
            wager = clamp(Math.round(d.wager), 5, max);
            showClue('<div class="jp-clue-big">DAILY DOUBLE</div><div class="jp-clue-medium">' + esc(who) + ' wagers ' + money(wager) +
                     '</div><div class="jp-clue-why">' + esc(d.why) + '</div>', { noUpper: true, category: info.category });
            await csay(who, wager == G.scores[who] ? 'Let\'s make it a true Daily Double.' : 'I\'ll wager ' + wager, tok);
            if (!alive(tok)) return;
            await pause(500, tok);
            if (!alive(tok)) return;
        }
        setHeader(roundTitle(G.round), info.category.name, 'DD ' + money(wager));
        podiumLine(who, 'wagers ' + money(wager));
        let trueDD = wager == G.scores[who] && wager > 0;
        await say((trueDD ? 'A true Daily Double. ' : money(wager) + '. ') + 'Here\'s the clue.', tok);
        if (!alive(tok)) return;

        showClue(clueHtml(info), { category: info.category, value: 'Daily Double · ' + money(wager) });
        await hostSay(info.queryText, 'clue');
        if (!alive(tok)) return;

        if (who == YOU) {
            let res = await userAnswers(info, S.ddAnswerSeconds, tok, wager);
            if (!alive(tok)) return;
            if (!res.correct) { await say('The correct response: ' + info.phrase.toLowerCase() + ' ' + JPReader.responseToSpeech(info.abbrev) + '?', tok); if (!alive(tok)) return; }
            await say((res.correct ? 'That takes you to ' : 'That takes you down to ') + money(G.scores[YOU]) + '.', tok);
        } else {
            lightPodium(who);
            await sleep(clamp(gauss(1100, 300), 500, 1900), tok);
            if (!alive(tok)) return;
            // The archived outcome for this Daily Double (whoever found it in the
            // broadcast; the contestant in control here plays it out the same way).
            let ddWho = clues[info.num].dd_who;
            let right = ddWho ? ((clues[info.num].scores || { })[ddWho] > 0) : false;
            let text = right ? (info.phrase + ' ' + JPJudge.stripHtml(info.abbrev) + '?') : (wrongResponseText(clues[info.num], ddWho || who) || '(an incorrect response)');
            podiumLine(who, '<span class="' + (right ? 'jp-correct' : 'jp-incorrect') + '">' + esc(text) + '</span>');
            setSub('<span class="jp-who">' + esc(who) + ':</span> ' + esc(text));
            await csay(who, JPReader.responseToSpeech(text.replace(/^\(|\)$/g, '')), tok);
            if (!alive(tok)) return;
            adjustScore(who, right ? wager : -wager);
            setSub('<span class="jp-who">' + esc(who) + ':</span> ' + esc(text) + ' &nbsp; <span class="' + (right ? 'jp-correct' : 'jp-incorrect') + '">' + esc(right ? pick(HOST_RIGHT) : pick(HOST_WRONG)) + '</span>' +
                   (right ? '' : ' &nbsp; <span class="jp-note">Correct response: <em class="correct_response">' + info.correct + '</em></span>'));
            await say((right ? pick(HOST_RIGHT) + ' That takes you to ' + money(G.scores[who]) + '.'
                             : pick(HOST_WRONG) + ' The correct response: ' + info.phrase.toLowerCase() + ' ' + JPReader.responseToSpeech(info.abbrev) + '? That takes you down to ' + money(G.scores[who]) + '.'), tok);
        }
        lightPodium(null);
        setHint('Click or press <span class="jp-key">' + buzzKeyName() + '</span> to continue.');
        await pause(S.autoAdvanceMs, tok);
        showAnswerStrip(false);
    }

    // ------------------------------------------------------ Final Jeopardy!

    function fjIntroLine(fj) {
        return 'And now, the category for Final Jeopardy: ' + JPReader.categoryToSpeech(fj.category.name) + '.' +
               (fj.category.comments ? ' ' + JPReader.commentToSpeech(fj.category.comments) + '.' : '') + ' Contestants, it\'s time to make your wagers.';
    }
    async function playFinal(tok) {
        let fj = fjInfo();
        G.round = 'FJ';
        G.phase = 'other';
        if (usingNeural()) {
            JPNeural.clearPrefetch();
            JPNeural.prefetch([ JPReader.forNeural(fjIntroLine(fj), 'line'),
                                JPReader.forNeural('Here\'s the clue.', 'line'),
                                JPReader.forNeural(fj.queryText, 'clue'),
                                JPReader.forNeural('You have ' + S.fjSeconds + ' seconds. Good luck.', 'line'),
                                JPReader.forNeural('The correct response: ' + fj.phrase.toLowerCase() + ' ' + JPReader.responseToSpeech(fj.correct) + '?', 'line') ], S.neuralVoice, S.rate, 100);
        }
        setHeader('Final Jeopardy!', fj.category.name, '');
        clearTimer();
        clearPodiumLines();
        clearOuts();
        lightPodium(null);
        JPAudio.play('fj');
        showClue('<div class="jp-clue-big">FINAL JEOPARDY!</div><div class="jp-clue-medium">The category:</div><div class="jp-clue-big" style="font-size:clamp(1.6em,4vw,3.4em)">' + esc(fj.category.name) + '</div>' +
                 (fj.category.comments ? '<div class="jp-clue-medium">' + esc(fj.category.comments) + '</div>' : ''), { noUpper: true });
        await say(fjIntroLine(fj), tok);
        if (!alive(tok)) return;
        await pause(700, tok);
        if (!alive(tok)) return;

        // Contestants wager on the live standings, you included (JPWagers).
        let names = realNames();
        let players = { };
        for (let n of names) {
            let sc = G.scores[n];
            let p = fj.players[n];
            if (sc > 0 && p) {
                let d = JPWagers.finalWager(n, G.scores);
                players[n] = { wager: clamp(Math.round(d.wager), 0, sc), why: d.why, right: p.right, response: p.response };
            } else
                markOut(n, true);
        }
        let youIn = G.scores[YOU] > 0;
        let yourWager = 0;
        if (youIn) {
            yourWager = await promptWager(0, G.scores[YOU], 'Final Jeopardy! — ' + fj.category.name,
                'You have ' + money(G.scores[YOU]) + '. How much will you wager?' + standingsTable(true));
            if (!alive(tok)) return;
            podiumLine(YOU, 'wager locked in');
        } else {
            markOut(YOU, true);
            showPanel('<h1>Final Jeopardy! — ' + esc(fj.category.name) + '</h1><p>With ' + money(G.scores[YOU]) + ' you can\'t play Final Jeopardy!, but you can still play along. Click or press <span class="jp-key">' + buzzKeyName() + '</span>.</p>').classList.add('jp-clickthrough');
            await pause(2500, tok);
            if (!alive(tok)) return;
        }
        for (let n in players) podiumLine(n, 'wager locked in');

        setHeader('Final Jeopardy!', fj.category.name, youIn ? 'wager ' + money(yourWager) : '');
        let fjOpts = { category: fj.category, value: 'Final Jeopardy!' };
        showClue(fj.queryHtml.replace(/<a [^>]*>(.*?)<\/a>/g, '$1'), fjOpts);
        await say('Here\'s the clue.', tok);
        if (!alive(tok)) return;
        await hostSay(fj.queryText, 'clue');
        if (!alive(tok)) return;
        let preScores = Object.assign({ }, G.scores);   // places at the reveal are the pre-Final standings
        await say('You have ' + S.fjSeconds + ' seconds. Good luck.', tok);   // before the music, so the mic doesn't hear it
        if (!alive(tok)) return;

        JPAudio.startLoop('think');
        let yourAnswer = { said: '', correct: false };
        if (youIn) {
            yourAnswer = await finalAnswer(fj, S.fjSeconds, tok);
            if (!alive(tok)) return;
        } else {
            setTimer(S.fjSeconds, 'green');
            await pause(S.fjSeconds * 1000, tok);
            if (!alive(tok)) return;
        }
        JPAudio.stopLoop();
        clearTimer();

        // Reveal, lowest score first, you included.
        let inFinal = Object.keys(players).concat(youIn ? [ YOU ] : [ ]);
        let order = ranked(G.scores).filter(function(n) { return inFinal.indexOf(n) >= 0; }).reverse();
        showClue(fj.queryHtml.replace(/<a [^>]*>(.*?)<\/a>/g, '$1'), fjOpts);
        setSub('<span class="jp-note">The correct response:</span> <em class="correct_response">' + fj.correct + '</em>');
        await say('The correct response: ' + fj.phrase.toLowerCase() + ' ' + JPReader.responseToSpeech(fj.correct) + '?', tok);
        if (!alive(tok)) return;
        await pause(800, tok);
        if (!alive(tok)) return;
        for (let i = 0; i < order.length; i++) {
            let who = order[i];
            let isYou = who == YOU;
            let resp = isYou ? yourAnswer.said : players[who].response;
            let right = isYou ? yourAnswer.correct : players[who].right;
            let wager = isYou ? yourWager : players[who].wager;
            let why = isYou ? '' : players[who].why;
            lightPodium(who);
            let place = ordinalPlace(placeOf(who, preScores));
            let lead = i == 0 ? 'Let\'s start with ' : i == order.length - 1 ? 'And finally, ' : 'Next, ';
            let intro = isYou ? lead + 'you, in ' + place + ' place with ' + money(preScores[who]) + '.'
                              : lead + who + ', in ' + place + ' place with ' + money(preScores[who]) + '.';
            setSub('<span class="jp-who">' + esc(who) + '</span> <span class="jp-note">— ' + place + ' place, ' + money(preScores[who]) + '</span>');
            await say(intro, tok);
            if (!alive(tok)) return;
            setSub('<span class="jp-who">' + esc(who) + ' wrote:</span> ' + (resp ? esc(resp) : '<i>(nothing)</i>'));
            podiumLine(who, '<span class="' + (right ? 'jp-correct' : 'jp-incorrect') + '">' + (resp ? esc(resp) : '(nothing)') + '</span>');
            await say((isYou ? 'You wrote: ' : heShe(who).charAt(0).toUpperCase() + heShe(who).slice(1) + ' wrote: ') + (resp ? JPReader.responseToSpeech(resp) : 'nothing.'), tok);
            if (!alive(tok)) return;
            await pause(600, tok);
            if (!alive(tok)) return;
            setSub('<span class="jp-who">' + esc(who) + ' wrote:</span> ' + (resp ? esc(resp) : '<i>(nothing)</i>') + ' &nbsp; <span class="' + (right ? 'jp-correct' : 'jp-incorrect') + '">' + (right ? 'Correct!' : 'Sorry, no.') + '</span> &nbsp; wager ' + money(wager) +
                   (why ? '<div class="jp-clue-why">' + esc(why) + '</div>' : ''));
            await say(right ? 'That is correct!' : 'That is incorrect.', tok);
            if (!alive(tok)) return;
            if (isYou) addResult({ kind: 'fj', round: 'FJ', category: fj.category.name, value: 0, amount: wager, said: resp, correct: JPJudge.stripHtml(fj.correct), outcome: right ? 'right' : 'wrong' });
            else adjustScore(who, right ? wager : -wager);
            let takes = (isYou ? 'That takes you ' : 'That takes ' + himHer(who) + ' ') + (right ? 'to ' : 'down to ') + money(G.scores[who]) + '.';
            await say((wager ? 'And the wager: ' + money(wager) + '. ' : 'No wager. ') + takes, tok);
            if (!alive(tok)) return;
            await pause(why ? 1600 : 900, tok);
            if (!alive(tok)) return;
        }
        lightPodium(null);
        // The verdict.
        let all = ranked(G.scores);
        let top = all.filter(function(n) { return G.scores[n] == G.scores[all[0]]; });
        let line = top.length > 1 ? 'And we have a tie at ' + money(G.scores[all[0]]) + ' between ' + joinNatural(top.map(function(n) { return n == YOU ? 'you' : n; })) + '!'
                 : all[0] == YOU ? 'And that makes you our champion, with ' + money(G.scores[YOU]) + '! Congratulations.'
                 : 'And that makes ' + all[0] + ' our champion, with ' + money(G.scores[all[0]]) + '. Congratulations, ' + all[0] + '.';
        await say(line, tok);
    }

    // Final Jeopardy! answer: the window stays open for the full time (Enter
    // locks it in early). Chrome ends speech recognition on its own after a
    // silence, so listening is restarted until the clock runs out.
    async function finalAnswer(fj, seconds, tok) {
        let useSpeech = S.answerMode == 'speech' && JPAudio.recognitionSupported();
        showAnswerStrip(true, useSpeech);
        setTimer(seconds, 'green');
        setHint(useSpeech ? 'Say (or type) your response. <span class="jp-key">Enter</span> locks it in early.' : 'Type your response. <span class="jp-key">Enter</span> locks it in early.');

        let deadline = JPClock.now() + seconds * 1000;
        let typed = '', stopped = false, current = null;
        let heardParts = [ ], alternatives = [ ];

        let lockIn = new Promise(function(resolve) {
            let t = JPClock.setTimeout(function() { stopped = true; if (current) current.stop(); handlers.submit = null; resolve(); }, seconds * 1000);
            handlers.submit = function(text) { typed = text || ''; stopped = true; JPClock.clearTimeout(t); if (current) current.stop(); handlers.submit = null; resolve(); };
        });

        // A pause stops the recognizer; the loop below starts a new one on resume.
        let onPauseFJ = function() { if (current) current.stop(); };
        JPClock.onPause(onPauseFJ);

        let listening = Promise.resolve();
        if (useSpeech) {
            listening = (async function() {
                while (!stopped && JPClock.now() < deadline - 700) {
                    await JPClock.whenRunning();
                    if (stopped) break;
                    current = JPAudio.listen(deadline - JPClock.now(), function(text) {
                        U.heard.textContent = '“' + (heardParts.join(' ') + ' ' + text).trim() + '”';
                    }, { endOnFinal: false });
                    let r = await current;
                    if (r.text) heardParts.push(r.text);
                    if (r.alternatives && r.alternatives.length) alternatives = r.alternatives;
                    if (r.error == 'not-allowed' || r.error == 'service-not-allowed' || r.error == 'audio-capture') {
                        U.mic.className = 'jp-mic'; U.mic.textContent = 'Mic: ' + r.error + ' — type it';
                        break;
                    }
                }
            })();
        }
        await lockIn;
        await listening;
        JPClock.off(onPauseFJ);
        typed = (typed || U.input.value || '').trim();
        showAnswerStrip(false);

        let heardText = heardParts.join(' ').trim();
        let candidates = [ ];
        if (typed) candidates.push(typed);
        if (heardText) candidates.push(heardText);
        for (let a of alternatives) candidates.push(a);
        let verdict = JPJudge.judgeAny(candidates, fj.correct);
        let said = typed || heardText || '';
        G.stats.answered++;
        if (verdict.correct) G.stats.correct++; else G.stats.wrong++;
        podiumLine(YOU, 'response locked in');
        return { said: said, correct: !!verdict.correct };
    }

    // ------------------------------------------------------------ results

    // inline: a compact version with a heading, for the wager screens.
    function standingsTable(inline) {
        let names = ranked(G.scores);
        let rows = names.map(function(n) {
            return '<tr' + (n == YOU ? ' class="jp-you"' : '') + '><td>' + esc(n) + '</td><td class="jp-num">' + money(G.scores[n]) + '</td></tr>';
        }).join('');
        return (inline ? '<div class="jp-note" style="margin-top:0.8em">Standings</div>' : '') + '<table class="jp-standings' + (inline ? ' jp-inline' : '') + '">' + rows + '</table>';
    }

    // Read-only view of the game state, for debugging in the console
    // (e.g. jpLiveDebug.state.scores) and for automated tests.
    window.jpLiveDebug = { get state() { return G; }, get settings() { return S; }, parsePick: parsePick, standingsSentence: standingsSentence, roundOpeningLine: roundOpeningLine, showFinalStandings: showFinalStandings, rewindTo: rewindTo };

    // ---- high scores (this browser; kept in localStorage for j-archive.com) ----
    function loadScores() { try { return JSON.parse(localStorage.getItem('jpLiveScores') || '[]'); } catch (e) { return [ ]; } }
    function saveScores(list) { try { localStorage.setItem('jpLiveScores', JSON.stringify(list.slice(-300))); } catch (e) { } }
    function gameTitle() { return document.title.replace(/^J! Archive - /, ''); }
    function gameId() { let m = location.search.match(/game_id=(\d+)/); return m ? m[1] : ''; }
    function recordScore() {
        if (G.recorded) return G.recorded;
        let st = G.stats, names = ranked(G.scores);
        let entry = {
            id: Date.now().toString(36), date: new Date().toISOString(), game: gameTitle(), gameId: gameId(),
            score: G.scores[YOU], place: names.indexOf(YOU) + 1, won: names[0] == YOU,
            answered: st.answered, correct: st.correct, clues: st.clues, buzzWins: st.buzzWins,
            difficulty: S.difficulty, contestants: realNames().map(function(n) { return { name: n, score: G.scores[n] }; }),
        };
        let list = loadScores(); list.push(entry); saveScores(list);
        G.recorded = entry;
        return entry;
    }
    function scoresPanelHtml(currentId) {
        let list = loadScores().slice().sort(function(a, b) { return b.score - a.score || (a.date < b.date ? 1 : -1); });
        if (!list.length) return '<p class="jp-note">No games finished yet. Finish one and it lands here.</p>';
        let best = list[0], games = list.length, wins = list.filter(function(e) { return e.won; }).length;
        let rows = list.slice(0, 25).map(function(e, i) {
            let d = new Date(e.date), acc = e.answered ? Math.round(100 * e.correct / e.answered) : 0;
            return '<tr' + (e.id == currentId ? ' class="jp-you"' : '') + '><td class="jp-num">' + (i + 1) + '</td><td>' + esc(e.game) + '</td><td class="jp-note">' + d.toLocaleDateString() + '</td>' +
                '<td class="jp-num">' + money(e.score) + '</td><td>' + (e.won ? 'won' : ordinalPlace(e.place - 1) + ' place') + '</td><td class="jp-note">' + e.correct + '/' + e.answered + ' (' + acc + '%)</td></tr>';
        }).join('');
        return '<p>' + games + ' game' + (games == 1 ? '' : 's') + ' played · ' + wins + ' won · best ' + money(best.score) + ' (' + esc(best.game) + ')</p>' +
            '<table class="jp-results jp-scores"><tr><th>#</th><th>Game</th><th>Date</th><th>Your score</th><th>Result</th><th>Responses</th></tr>' + rows + '</table>' +
            (games > 25 ? '<p class="jp-note">Top 25 of ' + games + '.</p>' : '');
    }
    function showScores(backTo) {
        let panel = showPanel('<h1>High scores</h1>' + scoresPanelHtml(G.recorded && G.recorded.id) +
            '<p><button class="jp-btn jp-back">Back</button> <button class="jp-btn jp-secondary jp-clear-scores">Clear all</button></p>');
        panel.querySelector('.jp-back').onclick = backTo;
        panel.querySelector('.jp-clear-scores').onclick = function() { if (confirm('Clear all high scores?')) { saveScores([ ]); showScores(backTo); } };
        setHint('');
    }

    function showFinalStandings() {
        let st = G.stats;
        let names = ranked(G.scores);
        let winner = names[0];
        setHeader('Final results', '', '');
        clearTimer();
        showAnswerStrip(false);
        lightPodium(winner);
        let acc = st.answered ? Math.round(100 * st.correct / st.answered) : 0;
        let entry = recordScore();
        let all = loadScores().slice().sort(function(a, b) { return b.score - a.score; });
        let rank = all.findIndex(function(e) { return e.id == entry.id; }) + 1;
        showPanel('<h1>' + (winner == YOU ? 'You win!' : esc(winner) + ' wins') + '</h1>' + standingsTable() +
            '<h2>Your game</h2>' +
            '<p>Clues played: ' + st.clues + ' · buzzer races won: ' + st.buzzWins + ' · lost: ' + st.buzzLost + ' · early buzzes: ' + st.lockouts + '</p>' +
            '<p>Responses: ' + st.answered + ' · correct: ' + st.correct + ' · incorrect: ' + st.wrong + ' · accuracy: ' + acc + '%</p>' +
            '<p>' + (rank == 1 && all.length > 1 ? '<b>A new high score!</b> ' : '') + 'This game ranks #' + rank + ' of ' + all.length + ' on this computer. <button class="jp-btn jp-secondary jp-scores" style="padding:3px 10px;font-size:0.9em">High scores</button></p>' +
            '<p>' + (nextGameLink() ? '<button class="jp-btn jp-next">Play the next game &rarr;</button> ' : '') +
            '<button class="jp-btn' + (nextGameLink() ? ' jp-secondary' : '') + ' jp-again">Play this game again</button> <button class="jp-btn jp-secondary jp-close">Back to the page</button></p>' +
            (nextGameLink() ? '<p class="jp-note">The next game in the archive (the day after this one) opens ready to start, with these settings.</p>'
                            : '<p class="jp-note">This is the most recent game in the archive, so there is no next game yet.</p>'));
        let nx = U.stage.querySelector('.jp-next');
        if (nx) nx.onclick = function() { goToNextGame(); };
        U.stage.querySelector('.jp-scores').onclick = function() { showScores(showFinalStandings); };
        U.stage.querySelector('.jp-again').onclick = function() { showSetup(); };
        U.stage.querySelector('.jp-close').onclick = function() { quitLive(); };
        setHint('');
    }

    // The archive's "[next game >>]" link on this page, if there is one.
    function nextGameLink() {
        let links = document.querySelectorAll('a[href*="showgame.php?game_id="]');
        for (let a of links) if (/next game/i.test(a.textContent)) return a;
        return null;
    }
    // Go to the next game's page; the hash tells the extension there to open
    // the live overlay straight away (one click starts it — the browser needs
    // a click on the new page before it will play audio).
    function goToNextGame() {
        let a = nextGameLink();
        if (!a) return;
        saveSettings();
        quitLive();
        location.href = a.href.replace(/#.*$/, '') + '#jplive-next';
    }
    // On a page opened by "Play the next game": open the overlay ready to start.
    function autoOpenIfRequested() {
        if (location.hash != '#jplive-next') return;
        try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { }
        if (!document.getElementById('live_btn')) return;
        startLiveGame();
        let names = realNames();
        let panel = showPanel('<h1>' + esc(document.title.replace(/^J! Archive - /, '')) + '</h1>' +
            '<p>Next game, same settings. Today\'s contestants: ' + esc(names.join(', ')) + '.</p>' +
            '<p style="margin-top:1em"><button class="jp-btn jp-start">Start the game</button> <button class="jp-btn jp-secondary jp-setup">Settings first</button> <button class="jp-btn jp-secondary jp-cancel">Back to the page</button></p>');
        panel.querySelector('.jp-start').onclick = function() { startGame(); };
        panel.querySelector('.jp-setup').onclick = function() { showSetup(); };
        panel.querySelector('.jp-cancel').onclick = function() { quitLive(); };
        setHint('');
    }
    // archive.js builds the page (and the Play Live button) at load; look after it.
    if (location.hash == '#jplive-next') {
        let tries = 0;
        let t = setInterval(function() { if (document.getElementById('live_btn') || ++tries > 50) { clearInterval(t); autoOpenIfRequested(); } }, 100);
    }

})();
