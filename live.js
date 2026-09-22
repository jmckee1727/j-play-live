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
        buzzKey: ' ',            // player 1's key (kept in sync with players[0].key)
        playerCount: 1,          // humans at the keyboard: 1, 2 or 3
        players: [ { name: 'You', key: ' ' }, { name: 'Player 2', key: 'a' }, { name: 'Player 3', key: 'l' } ],
        mousePlayer: 0,          // which player a mouse click rings in for (-1: nobody)
        contestantsOn: true,     // play against the broadcast's contestants (off: only the humans)
        hostVoice: '',           // voice name; '' = auto
        rate: 1.15,                   // the host's reading speed; shown to the user relative to this (1.15 reads as 1.00×)
        settingsVersion: 6,
        answerMode: 'speech',    // speech | typed (follows micMode: 'off' = typed)
        micMode: 'always',       // 'always' = the mic stays open for the whole game (steadier sound); 'toggle' = opens only while the game listens; 'off' = type your responses
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
        mediaCredit: 'half',          // when a clue's picture/audio/video is missing from the archive: what the contestants' responses are worth -- 'half' (default), 'none', or 'full' (as on TV). Yours always count in full.
        micDevice: 'auto',            // which microphone the studio ear opens: 'auto' (built-in when a headset is the default), 'default', or a device id
        outDevice: 'default',         // where the game's own sounds play: 'default' (system) or a device id
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
        easy:     { median: 1500, sigma: 0.65, label: 'Easy (contestants typically ring in ~1.5 s after the lights)' },
        medium:   { median: 500,  sigma: 0.65, label: 'Medium (~0.5 s)' },
        hard:     { median: 300,  sigma: 0.65, label: 'Hard (~0.3 s)' },
        champion: { median: 200,  sigma: 0.6,  label: 'Champion (~0.2 s)' },
        custom:   { median: 500, sigma: 0.65, label: 'Custom' },
    };
    const HOST_RIGHT = [ 'Yes.', 'Correct.', 'That\'s it.', 'Right.', 'Yes, that\'s right.' ];
    // A clue built around a picture, video or audio file. The contestants had
    // it on TV; you mostly don't (the archive rarely hosts the media), so by
    // default their money doesn't move on these -- they ring in and respond as
    // broadcast, control of the board follows, but for no credit.
    function mediaClue(info) { return !!(info && info.media && info.media.length); }
    // Missing = the archive lacks at least one of the clue's files (the probe
    // result; a probe still pending when the money is settled counts as missing).
    function mediaMissing(info) { return mediaClue(info) && (!info.mediaStatus || info.mediaStatus.missing > 0); }
    // What a contestant's response on this clue is worth: the full value unless
    // the media is missing, then per the Media clues setting (half by default).
    function othersCredit(info, value) {
        if (!mediaMissing(info) || S.mediaCredit == 'full' || S.mediaCredit == 'broadcast') return value;
        if (S.mediaCredit == 'none') return 0;
        return Math.round(value / 2 / 100) * 100 || Math.round(value / 2);
    }
    function creditNote(credit, value) { return credit == value ? '' : ' <span class="jp-note">(' + (credit ? 'half credit' : 'no credit') + ': media missing)</span>'; }
    const HOST_WRONG = [ 'No.', 'Sorry, no.', 'That is incorrect.', 'No, sorry.' ];

    let S = Object.assign({ }, DEFAULTS);
    let G = null;          // game state
    let U = null;          // UI element refs
    let runToken = 0;
    let handlers = { buzz: null, override: null, cont: null, pick: null, submit: null, inputBuzz: null };
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
        if (online()) return sleep(ms, tok);
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
            // v4: media clues went from "no credit" to "half credit" by default; the old default follows.
            if (!(saved.settingsVersion >= 4)) { if (saved.mediaCredit == null || saved.mediaCredit == 'none') saved.mediaCredit = 'half'; if (saved.mediaCredit == 'broadcast') saved.mediaCredit = 'full'; saved.settingsVersion = 4; }
            // v5: one Microphone setting (whole game / while listening / off) replaces "How you answer".
            if (!(saved.settingsVersion >= 5)) { if (saved.micMode == null) saved.micMode = saved.answerMode == 'typed' ? 'off' : 'always'; saved.settingsVersion = 5; }
            // v6: players (offline multiplayer); player 1's key is the old buzz key.
            if (!(saved.settingsVersion >= 6)) { if (!saved.players) { saved.players = clone(DEFAULTS.players); if (saved.buzzKey) saved.players[0].key = saved.buzzKey; } saved.settingsVersion = 6; }
            S = Object.assign({ }, DEFAULTS, saved);
        } catch (e) { S = Object.assign({ }, DEFAULTS); }
        S.answerMode = S.micMode == 'off' ? 'typed' : 'speech';
        if (!Array.isArray(S.players) || S.players.length < 3) S.players = clone(DEFAULTS.players);
        S.buzzKey = S.players[0].key || ' ';
        applyDevices();
    }
    function saveSettings() {
        try {
            let out = S;
            if (online() && G.online.overlay) {   // the room's timing and contestants, not yours: keep what you had
                let saved = JSON.parse(localStorage.getItem('jpLiveSettings') || '{}');
                out = Object.assign({ }, S); for (let k in G.online.overlay) { if (k in saved) out[k] = saved[k]; else delete out[k]; }
            }
            localStorage.setItem('jpLiveSettings', JSON.stringify(out));
        } catch (e) { }
        applyDevices();
    }
    function applyDevices() {
        if (typeof JPEar !== 'undefined' && JPEar.setMicPreference) JPEar.setMicPreference(S.micDevice || 'auto');
        if (JPAudio.setOutput) JPAudio.setOutput(S.outDevice || 'default');
    }
    // "Microphone: on for the whole game": the stream is held open from the
    // first clue to the end, so the input device never starts and stops
    // mid-game (which is what makes headphones hiccup). Audio is only used
    // while the game is listening; the rest is discarded. Off between games.
    function applyMicHold() {
        if (typeof JPEar === 'undefined' || !JPEar.setHold) return;
        JPEar.setHold(!!(liveActive && G && G.round && !G.recorded && S.micMode == 'always' && S.answerMode == 'speech'));
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

    function archiveNames() {
        return nicknames.slice(0, 3).filter(function(n) { return n && !/Coryat/.test(n); });
    }
    // The contestants in this game: the broadcast's, unless they're switched off.
    function realNames() { return S.contestantsOn === false ? [ ] : archiveNames(); }
    // The humans at the keyboard: 'You' alone, or the named players of an
    // offline multiplayer game. Every player, contestants first, then humans.
    function humans() { return (G && G.humans && G.humans.length) ? G.humans : [ YOU ]; }
    function isHuman(who) { return humans().indexOf(who) >= 0; }
    function allPlayers() { return realNames().concat(humans()); }
    function nameOf(who) { return who == YOU ? 'you' : who; }
    // The names for a game from the settings: trimmed, unique, never a contestant's.
    function humanNames() {
        let count = clamp(+S.playerCount || 1, 1, 3), taken = archiveNames(), out = [ ];
        for (let i = 0; i < count; i++) {
            let nm = String((S.players[i] || { }).name || '').trim() || (i == 0 ? YOU : 'Player ' + (i + 1));
            if (count == 1) nm = YOU;
            while (taken.indexOf(nm) >= 0 || out.indexOf(nm) >= 0) nm += ' 2';
            out.push(nm);
        }
        return out;
    }
    function humanKey(i) { return ((S.players[i] || { }).key || [ ' ', 'a', 'l' ][i] || ' '); }
    function keyName(k) { return k == ' ' ? 'Space' : k == 'Shift' ? 'Shift' : k == 'Enter' ? 'Enter' : k.length == 1 ? k.toUpperCase() : k; }

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

    // The show's typefaces ship with the extension: a Korinna-like serif for
    // the clues (Averia Serif Libre Bold: wide, soft, low-contrast letters) and
    // a compressed grotesque for the board (Anton).
    function installFonts() {
        if (document.getElementById('jp-live-fonts')) return;
        let url = function(f) { try { return chrome.runtime.getURL('fonts/' + f); } catch (e) { return null; } };
        let clue = url('AveriaSerifLibre-Bold.ttf'), board = url('Anton-Regular.ttf');
        if (!clue || !board) return;
        let st = document.createElement('style');
        st.id = 'jp-live-fonts';
        st.textContent = '@font-face { font-family: "JP Clue"; src: url("' + clue + '") format("truetype"); font-display: swap; }\n' +
                         '@font-face { font-family: "JP Board"; src: url("' + board + '") format("truetype"); font-display: swap; }';
        (document.head || document.documentElement).appendChild(st);
    }

    function buildOverlay() {
        if (U) return;
        installFonts();
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
        let downOn = null;
        root.addEventListener('mousedown', function(e) {
            downOn = e.target;
            if (e.button !== 0 || !clickable(e.target)) return;
            if (handlers.buzz) { e.preventDefault(); let who = mouseHuman(); if (who) handlers.buzz(who); }
        });
        root.addEventListener('click', function(e) {
            // A press that started somewhere else (selecting text, dragging out of a box) isn't a click here.
            if (e.button !== 0 || e.target !== downOn || !clickable(e.target)) return;
            if (!handlers.buzz && handlers.cont) { e.preventDefault(); handlers.cont(); }
        });
        U.input.addEventListener('keydown', function(e) {
            if (e.key == 'Enter') { e.preventDefault(); e.stopPropagation(); if (handlers.submit) handlers.submit(U.input.value); }
            else if (e.key == 'Escape') { e.preventDefault(); e.stopPropagation(); showPauseMenu(); }
            else if (handlers.inputBuzz && !U.input.value && isBuzz(e)) { e.preventDefault(); e.stopPropagation(); handlers.inputBuzz(humans()[buzzIndex(e)]); }   // Final Jeopardy!: the buzz key in an empty box rings in
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
    let clueEl = null, clueTextEl = null, clueSubEl = null, clueMediaEl = null;
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
        clueMediaEl = null;
        clueSubEl = h('div', 'jp-clue-sub', '');
        clueEl.appendChild(clueTextEl);
        clueEl.appendChild(clueSubEl);
        stage(clueEl);
        clueEl.dataset.fit = opts.noUpper ? '0' : '1';
        // The clue's media (probed ahead by probeMedia): rendered in one go, below
        // the text -- what loaded, or a single note for what the archive lacks.
        if (opts.media) {
            let mine = clueEl;
            renderMedia(opts.media, opts);
            if (opts.media.late) opts.media.late.then(function(r) { if (clueEl === mine) renderMedia(r, opts, true); });
        }
        fitClueText();
        return clueEl;
    }
    function renderMedia(r, opts, late) {
        if (!clueEl || !r) return;
        if (late) {
            // Files that arrived after the clue was drawn: add what loaded; the note stays.
            if (!clueMediaEl) { clueMediaEl = h('div', 'jp-clue-media'); clueEl.insertBefore(clueMediaEl, clueSubEl); }
            let added = false;
            for (let it of r.items) if (it.ok && it.el && !it.el.isConnected) { placeMedia(it, opts); added = true; }
            if (added) fitClueText();
            return;
        }
        if (clueMediaEl) return;
        let box = h('div', 'jp-clue-media');
        clueMediaEl = box;
        let kinds = { };
        for (let it of r.items) { if (it.ok && it.el) placeMedia(it, opts); else kinds[it.kind] = true; }
        if (r.missing) {
            let what = r.missing == r.total ? (kinds.image && !kinds.audio && !kinds.video ? 'picture' : kinds.audio && !kinds.image && !kinds.video ? 'audio' : kinds.video && !kinds.image && !kinds.audio ? 'video' : 'media') : 'rest of the media';
            box.appendChild(h('div', 'jp-clue-nomedia', '(the archive doesn\'t have this clue\'s ' + what + (r.missing > 1 && r.missing == r.total ? ' — ' + r.missing + ' files' : '') + ')'));
        }
        if (!box.childNodes.length) { clueMediaEl = null; return; }
        clueEl.insertBefore(box, clueSubEl);
        fitClueText();
    }
    function placeMedia(it, opts) {
        let box = clueMediaEl;
        if (it.kind == 'image') { it.el.alt = ''; if (!it.el.complete) it.el.addEventListener('load', fitClueText); box.appendChild(it.el); }
        else if (it.kind == 'audio') { it.el.controls = true; box.appendChild(it.el); if (opts.playAudio !== false) { try { it.el.currentTime = 0; it.el.play().catch(function() { }); } catch (e) { } } }
        else if (it.kind == 'video') { it.el.controls = true; it.el.muted = false; box.appendChild(it.el); }
    }
    // A clue's video plays after the reading (audio plays with it); wait it out, up to 20 s.
    function playClueVideo(tok) {
        let v = clueMediaEl && clueMediaEl.querySelector('video');
        if (!v) return Promise.resolve();
        return new Promise(function(resolve) {
            let done = false, finish = function() { if (done) return; done = true; try { v.pause(); } catch (e) { } handlers.cont = null; resolve(); };
            v.addEventListener('ended', finish);
            v.addEventListener('error', finish);
            let t = setTimeout(finish, 20000);
            handlers.cont = function() { clearTimeout(t); finish(); };
            try { v.currentTime = 0; v.play().catch(finish); } catch (e) { finish(); }
        });
    }

    // ---- media in clues --------------------------------------------------
    // J! Archive links a media file for "seen here"/"heard here" clues but
    // rarely hosts it. Each file is probed once per game (an image load, or
    // the metadata of an audio/video file), so the clue can be drawn once,
    // with the media or with one note, instead of flickering through broken
    // placeholders. The verdicts use the result: on a clue whose media is
    // missing the contestants' credit follows the Media clues setting.
    function mediaKind(url) {
        if (/\.(jpe?g|png|gif|webp|bmp)(\?|$)/i.test(url)) return 'image';
        if (/\.(mp3|wav|m4a|aac|ogg|oga)(\?|$)/i.test(url)) return 'audio';
        if (/\.(mp4|webm|mov|m4v|ogv)(\?|$)/i.test(url)) return 'video';
        return 'other';
    }
    let mediaProbes = { };                                       // num -> { items, done (promise) }
    function probeMedia(info) {
        if (!mediaClue(info)) return null;
        if (mediaProbes[info.num]) { info.mediaStatus = mediaProbes[info.num].snapshot(); return mediaProbes[info.num]; }
        let items = info.media.map(function(url) { return { url: url, kind: mediaKind(url), ok: null, el: null }; });
        let probe = { items: items };
        probe.snapshot = function() {
            let r = { items: items.slice(), total: items.length, missing: items.filter(function(i) { return i.ok !== true; }).length, pending: items.filter(function(i) { return i.ok === null; }).length };
            return r;
        };
        probe.done = Promise.all(items.map(function(it) {
            return new Promise(function(resolve) {
                let done = false;
                let t = setTimeout(function() { finish(false); }, 4000);
                function finish(ok, el) { if (done) return; done = true; clearTimeout(t); it.ok = !!ok; it.el = ok ? el : null; resolve(it); }
                try {
                    if (it.kind == 'image') { let img = new Image(); img.onload = function() { finish(true, img); }; img.onerror = function() { finish(false); }; img.src = it.url; }
                    else if (it.kind == 'audio' || it.kind == 'video') { let el = document.createElement(it.kind); el.preload = 'metadata'; el.onloadedmetadata = function() { finish(true, el); }; el.onerror = function() { finish(false); }; el.src = it.url; }
                    else fetch(it.url, { method: 'HEAD' }).then(function(r) { finish(r.ok, null); }, function() { finish(false); });   // (cross-origin: usually can't tell; counts as missing)
                } catch (e) { finish(false); }
            });
        })).then(function() { return probe.snapshot(); });
        mediaProbes[info.num] = probe;
        probe.done.then(function(r) { if (G.current && G.current.num == info.num) G.current.mediaStatus = r; info.mediaStatus = r; });
        return probe;
    }
    // What to draw with the clue: the probe's state after at most a moment (a
    // 404 answers fast). Anything still pending counts as missing for the
    // note and the money; a slow file that does arrive is added when it does.
    function mediaFor(info, tok) {
        if (!mediaClue(info)) return Promise.resolve(null);
        let probe = probeMedia(info);
        return Promise.race([ probe.done, sleep(1200, tok) ]).then(function() {
            let r = probe.snapshot();
            info.mediaStatus = r;
            if (r.pending) r.late = probe.done;                     // showClue adds late arrivals
            return r;
        });
    }

    // Size the clue text like the show does: as large as will fit the panel,
    // wrapped in a column narrower than the panel so it runs to several lines.
    function fitClueText() {
        if (!clueEl || !clueTextEl || !clueEl.isConnected || clueEl.dataset.fit != '1') return;
        let strip = clueEl.querySelector('.jp-clue-cat');
        if (strip) clueEl.style.paddingTop = (strip.offsetHeight + 28) + 'px';   // clear of the category strip (10px in, inside the lights)
        let cs = getComputedStyle(clueEl);
        let padT = parseFloat(cs.paddingTop) || 0, padB = parseFloat(cs.paddingBottom) || 0;
        let subH = clueSubEl ? clueSubEl.offsetHeight : 0;
        let mediaH = (clueMediaEl && clueMediaEl.isConnected) ? clueMediaEl.offsetHeight + 14 : 0;
        let avail = clueEl.clientHeight - padT - padB - subH - mediaH - 6;
        let W = clueEl.clientWidth, H = clueEl.clientHeight;
        if (avail < 40 || W < 160) return;
        // The show's proportions: a narrow column of short lines (about 45% of
        // the width) in a type size tied to the screen, not to the clue's
        // length. Long clues get a wider column first, then a smaller size;
        // pictures and other extras below the text take from the height.
        let target = Math.max(18, Math.min(H * 0.1, W * 0.055));   // measured off the broadcast (~9% of the height), plus a little for this face's smaller capitals
        let fit = function(width) {
            clueTextEl.style.maxWidth = width + 'px';
            clueTextEl.style.width = width + 'px';
            let lo = 12, hi = target;
            clueTextEl.style.fontSize = hi + 'px';
            if (clueTextEl.scrollHeight <= avail && clueTextEl.scrollWidth <= width + 1) return hi;
            while (hi - lo > 0.5) {
                let mid = (lo + hi) / 2;
                clueTextEl.style.fontSize = mid + 'px';
                let fits = clueTextEl.scrollHeight <= avail && clueTextEl.scrollWidth <= width + 1;
                if (fits) lo = mid; else hi = mid;
            }
            return lo;
        };
        let size = fit(Math.round(W * 0.45));
        if (size < target * 0.8) size = fit(Math.round(W * 0.6));
        if (size < target * 0.65) size = fit(Math.round(W * 0.76));
        clueTextEl.style.fontSize = Math.floor(size) + 'px';
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
        let names = allPlayers();
        U.podiums.classList.toggle('jp-many', names.length > 4);
        U.podiums.style.gridTemplateColumns = 'repeat(' + Math.max(1, names.length) + ', 1fr)';
        for (let n of names) {
            let p = h('div', 'jp-podium' + (isHuman(n) ? ' jp-you' : '') + (G.control == n ? ' jp-control' : ''));
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
        if (want != rec.applied) { adjustScore(rec.who || YOU, want - rec.applied); rec.applied = want; }
    }
    function setOutcome(rec, outcome) {
        if (rec.outcome == outcome) return;
        if (rec.outcome == 'right') G.stats.correct--; else if (rec.outcome == 'wrong') G.stats.wrong--;
        if (outcome == 'right') G.stats.correct++; else if (outcome == 'wrong') G.stats.wrong++;
        rec.outcome = outcome;
        applyResult(rec);
        reconcileOthers(rec);
        followControl(rec);
        refreshRecord();
    }
    // Control of the board follows your result on the clue just played: right,
    // the board is yours; wrong, it goes to whoever answered right after you,
    // or stays with the player who picked the clue. Earlier clues are left
    // alone (the board has moved on since). If the change lands while the
    // next pick is being made, the pick starts over with the right player.
    function controlFor(rec) {
        if (rec.outcome == 'right') return rec.who || YOU;
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
        handlers = { buzz: null, override: null, cont: null, pick: null, submit: null, inputBuzz: null };
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

    // The human whose ring-in key this is (index), or -1.
    function buzzIndex(e) {
        let hs = humans();
        for (let i = 0; i < hs.length; i++) {
            if (online() && hs[i] != G.online.me) continue;
            let k = online() ? humanKey(0) : humanKey(i);
            if (k == 'Shift' ? e.key == 'Shift' : (e.key == k || (k == ' ' && e.code == 'Space') || (k.length == 1 && e.key.length == 1 && e.key.toLowerCase() == k.toLowerCase()))) return i;
        }
        return -1;
    }
    function isBuzz(e) { return buzzIndex(e) >= 0; }
    function mouseHuman() { if (online()) return G.online.me; let hs = humans(); if (hs.length == 1) return hs[0]; let i = S.mousePlayer == null ? 0 : +S.mousePlayer; return (i >= 0 && i < hs.length) ? hs[i] : null; }

    function onKey(e) {
        if (!liveActive) return;
        if (keyCapture) { e.preventDefault(); e.stopPropagation(); keyCapture(e); return; }
        if (e.target === U.input) return; // handled on the input itself
        let tn = e.target && e.target.tagName;
        if (tn == 'INPUT' || tn == 'TEXTAREA' || tn == 'SELECT') {
            if (e.key == 'Escape') { e.preventDefault(); showPauseMenu(); }
            return; // let people type in wager / settings fields
        }
        if (pauseEl && e.key != 'Escape') return;
        if (e.repeat && isBuzz(e)) { e.preventDefault(); return; }
        let bi = buzzIndex(e);
        if (bi >= 0) {
            e.preventDefault();
            if (handlers.buzz) handlers.buzz(humans()[bi]);
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

    function buzzKeyName(who) {
        if (online()) return keyName(humanKey(0));
        let i = who ? humans().indexOf(who) : 0;
        return keyName(humanKey(i < 0 ? 0 : i));
    }
    // "Space" for one player; "Space / A / L" for several (any of them moves the game on).
    function anyKeyHtml() {
        if (online()) return '<span class="jp-key">' + buzzKeyName() + '</span>';
        return humans().map(function(hm) { return '<span class="jp-key">' + buzzKeyName(hm) + '</span>'; }).join(' / ');
    }

    // Who's at the keyboard: one to three people, each with a ring-in key
    // (one of them may use the mouse too), and whether the broadcast's
    // contestants play as well.
    const RESERVED_KEYS = { 'Escape': 1, 'Enter': 1, 'Tab': 1, 'y': 1, 'n': 1, '+': 1, '-': 1, '=': 1, 'Meta': 1, 'Control': 1, 'Alt': 1, 'CapsLock': 1 };
    function playersSection() {
        let count = online() ? 1 : clamp(+S.playerCount || 1, 1, 3), rows = '';
        for (let i = 0; i < count; i++) {
            let p = S.players[i] || { };
            rows += '<div class="jp-player-row" data-i="' + i + '">' +
                (count > 1 ? '<input class="jp-pname" maxlength="16" placeholder="' + (i == 0 ? 'You' : 'Player ' + (i + 1)) + '" value="' + esc(p.name || '') + '"> ' : '') +
                (count > 1 ? 'rings in with ' : 'Ring in with ') + '<button class="jp-btn jp-secondary jp-key-btn" style="padding:2px 12px;font-size:0.9em;min-width:5em">' + esc(keyName(humanKey(i))) + '</button>' +
                (count > 1 ? ' <label><input type="radio" name="jp-mouse" value="' + i + '"' + (+S.mousePlayer == i ? ' checked' : '') + '> and the mouse</label>' : ' <span class="jp-note">or the mouse</span>') +
                '</div>';
        }
        if (count > 1) rows += '<div class="jp-player-row jp-note"><label><input type="radio" name="jp-mouse" value="-1"' + (!(+S.mousePlayer >= 0 && +S.mousePlayer < count) ? ' checked' : '') + '> nobody rings in with the mouse</label></div>';
        if (online()) return '<div class="jp-players">' + rows + '</div>';
        return '<select data-s="playerCount">' + [[1, 'Just me'], [2, 'Two of us'], [3, 'Three of us']].map(function(o) { return '<option value="' + o[0] + '"' + (count == o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>' +
            '<div class="jp-players">' + rows + '</div>' +
            '<div style="margin-top:4px"><label><input type="checkbox" data-s="contestantsOn"' + (S.contestantsOn !== false ? ' checked' : '') + '>Play against the archive\'s contestants too' + (count == 1 ? '' : ' <span class="jp-note">(off: just the ' + (count == 2 ? 'two' : 'three') + ' of you)</span>') + '</label></div>' +
            (count > 1 ? '<div class="jp-note" style="margin-top:3px">Everyone shares this keyboard, screen and microphone. Ring in with your own key, then answer out loud (or type). Whoever answers right picks the next clue and plays the Daily Doubles they find; in Final Jeopardy! everyone wagers in turn and responds in turn. Each of you gets a saved game and stats under your name.</div>' : '');
    }
    let keyCapture = null;    // while a ring-in key button waits for a key press
    let onlineSynced = false; // your saved games have gone up to the account once this page load
    function bindPlayers(panel) {
        let wrap = panel.querySelector('.jp-players-wrap');
        if (!wrap) return;
        let refresh = function() {
            wrap.innerHTML = playersSection(); bindPlayers(panel);
            let intro = panel.querySelector('.jp-intro'); if (intro) intro.innerHTML = setupIntro();
            // On the setup screen the podiums show who's playing; a running game keeps its players.
            if (G && !G.round && !G.recorded) { G.humans = humanNames(); G.scores = { }; for (let n of allPlayers()) G.scores[n] = 0; renderPodiums(); }
        };
        let pc = wrap.querySelector('[data-s="playerCount"]');
        if (pc) pc.addEventListener('change', function() { S.playerCount = clamp(+pc.value || 1, 1, 3); if (S.playerCount == 1) S.mousePlayer = 0; saveSettings(); refresh(); });
        let co = wrap.querySelector('[data-s="contestantsOn"]');
        if (co) co.addEventListener('change', function() { S.contestantsOn = co.checked; saveSettings(); refresh(); });
        wrap.querySelectorAll('input[name="jp-mouse"]').forEach(function(r) { r.addEventListener('change', function() { if (r.checked) { S.mousePlayer = +r.value; saveSettings(); } }); });
        wrap.querySelectorAll('.jp-pname').forEach(function(inp) {
            let i = +inp.closest('.jp-player-row').dataset.i;
            inp.addEventListener('input', function() {
                S.players[i] = S.players[i] || { key: humanKey(i) }; S.players[i].name = inp.value; saveSettings();
                let intro = panel.querySelector('.jp-intro'); if (intro) intro.innerHTML = setupIntro();
                if (G && !G.round && !G.recorded) { G.humans = humanNames(); G.scores = { }; for (let n of allPlayers()) G.scores[n] = 0; renderPodiums(); }
            });
        });
        wrap.querySelectorAll('.jp-key-btn').forEach(function(b) {
            b.onclick = function(ev) {
                ev.stopPropagation();
                let i = +b.closest('.jp-player-row').dataset.i;
                b.textContent = 'press a key…'; b.classList.add('jp-on'); b.blur();
                let cancel = function() { b.textContent = keyName(humanKey(i)); b.classList.remove('jp-on'); keyCapture = null; };
                keyCapture = function(e) {
                    let k = (e.key == ' ' || e.code == 'Space') ? ' ' : e.key.length == 1 ? e.key.toLowerCase() : e.key;
                    if (k == 'Escape') { cancel(); return; }
                    if (RESERVED_KEYS[k] || RESERVED_KEYS[e.key]) { b.textContent = 'not that one…'; return; }
                    for (let j = 0; j < clamp(+S.playerCount || 1, 1, 3); j++) if (j != i && humanKey(j) == k) { b.textContent = 'taken — another…'; return; }
                    S.players[i] = S.players[i] || { }; S.players[i].key = k;
                    if (i == 0) S.buzzKey = k;
                    saveSettings(); cancel();
                    let intro = panel.querySelector('.jp-intro'); if (intro) intro.innerHTML = setupIntro();
                };
                setTimeout(function() { if (keyCapture) { let off = function() { if (keyCapture) cancel(); document.removeEventListener('mousedown', off, true); }; document.addEventListener('mousedown', off, true); } }, 0);
            };
        });
    }
    // The setup screen's opening paragraph, for one player or several.
    function setupIntro() {
        let names = realNames(), hs = humanNames();
        let vs = names.length ? ' against ' + esc(names.join(', ')) + ', who ring in the way they did in the broadcast' : '';
        if (hs.length == 1)
            return '<p>The host reads each clue aloud. When the reading ends, the lights come on and the buzzers arm: click anywhere or press <span class="jp-key">' + keyName(humanKey(0)) + '</span> to ring in' + (vs || ' — nobody else is playing, so every clue is yours') + '. Buzz too early and you\'re locked out for a moment. ' +
                'If you win the buzz, answer out loud (or type it). Whoever answers correctly picks the next clue. Daily Doubles and Final Jeopardy! work as on the show.</p>';
        let keys = hs.map(function(nm, i) { return esc(nm) + ' with <span class="jp-key">' + keyName(humanKey(i)) + '</span>' + (+S.mousePlayer == i ? ' (or the mouse)' : ''); });
        return '<p>The host reads each clue aloud. When the reading ends, the lights come on and the buzzers arm: ' + joinNatural(keys) + vs + (names.length ? '' : ' — the ' + hs.length + ' of you against each other') + '. Buzz too early and you\'re locked out for a moment. ' +
            'Whoever wins the buzz answers out loud (or types it); a wrong response lets the others ring in. Whoever answers correctly picks the next clue. Daily Doubles and Final Jeopardy! work as on the show.</p>';
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
        let roomRows = online() && G.online.overlay;   // timing and contestants are the room's; only your own device settings show
        return '<table class="jp-form">' +
            (roomRows ? '' : '<tr><td>Contestant speed</td><td><select data-s="difficulty">' + dopts + '</select>' +
            ' <span class="jp-note">custom: median <input type="number" data-s="customMedian" min="60" max="4000" step="10" value="' + (+S.customMedian) + '" style="min-width:5em;width:5em"> ms, spread <select data-s="customSpread" style="min-width:6em">' +
              [[0.4, 'tight'], [0.65, 'normal'], [0.9, 'wide']].map(function(o) { return '<option value="' + o[0] + '"' + (Math.abs(+S.customSpread - o[0]) < 0.01 ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') +
              '</select></span></td></tr>') +
            (roomRows ? '' : '<tr><td>Media clues</td><td><select data-s="mediaCredit" style="max-width:100%">' +
              '<option value="half"' + (S.mediaCredit != 'none' && S.mediaCredit != 'full' ? ' selected' : '') + '>Contestants get half credit when the media is missing</option>' +
              '<option value="none"' + (S.mediaCredit == 'none' ? ' selected' : '') + '>Contestants get no credit when the media is missing</option>' +
              '<option value="full"' + (S.mediaCredit == 'full' ? ' selected' : '') + '>Score everyone as on TV</option></select>' +
              '<div class="jp-note" style="margin-top:3px">Clues built on a picture, audio or video file. When the archive has it, it\'s shown or played and everyone scores as on TV; when it\'s missing, the contestants (who saw it) get the credit above, right or wrong, and your own responses count in full either way.</div></td></tr>') +
            (roomRows ? '<tr><td>Ring in with</td><td><div class="jp-players-wrap">' + playersSection() + '</div></td></tr>' : '<tr><td>Players</td><td><div class="jp-players-wrap">' + playersSection() + '</div></td></tr>') +
            '<tr><td>Microphone</td><td><select data-s="micMode" style="max-width:100%">' +
              '<option value="always"' + (S.micMode != 'toggle' && S.micMode != 'off' ? ' selected' : '') + (sr ? '' : ' disabled') + '>On for the whole game — answer out loud; steadiest sound' + (sr ? '' : ' (not supported here)') + '</option>' +
              '<option value="toggle"' + (S.micMode == 'toggle' ? ' selected' : '') + (sr ? '' : ' disabled') + '>On only while the game listens — answer out loud; the mic light goes off between turns</option>' +
              '<option value="off"' + (S.micMode == 'off' ? ' selected' : '') + '>Off — type your responses</option></select>' +
              ' <button class="jp-btn jp-secondary jp-mic-test" style="padding:3px 10px;font-size:0.9em">Test microphone</button> <span class="jp-mic-result jp-note"></span>' +
              '<div class="jp-note" style="margin-top:3px">The mic is only ever listened to when it\'s your turn to speak (after you ring in, on your own board, on your Daily Double); nothing is recorded or sent anywhere by the game. Held open, the input device never starts and stops mid-game, which is what makes headphones hiccup.</div>' +
              '<div style="margin-top:4px"><label><input type="checkbox" data-s="voicePick"' + (S.voicePick ? ' checked' : '') + '>Pick clues by voice too, when you have the board ("Science for 600", "same category, 800"); clicking always works</label></div>' +
              '<div style="margin-top:6px">Which microphone: <select class="jp-mic-device" style="max-width:100%"><option value="auto">Automatic</option></select>' +
              '<div class="jp-mic-device-note jp-note" style="margin-top:3px">Automatic uses the system default, or the built-in microphone when a Bluetooth headset is the default — so your headphones don\'t drop to call quality every time the game listens. (Chrome\'s built-in recognizer always uses the system default microphone.)</div></div></td></tr>' +
            '<tr><td>Recognition</td><td>' + earSection() + '</td></tr>' +
            '<tr><td>Host voice</td><td>' + voiceSection(vopts) + '</td></tr>' +
            '<tr><td>Reading speed</td><td><input type="range" class="jp-rate" min="0.6" max="1.4" step="0.05" value="' + (S.rate / BASE_RATE).toFixed(2) + '"> <span class="jp-rate-val">' + (S.rate / BASE_RATE).toFixed(2) + '×</span></td></tr>' +
            '<tr><td>Contestants speak</td><td><label><input type="checkbox" data-s="contestantVoices"' + (S.contestantVoices ? ' checked' : '') + '>Read their responses aloud in their own voices</label> ' +
              '<select data-s="contestantEngine" style="min-width:16em;margin-left:8px"><option value="neural"' + (S.contestantEngine != 'system' ? ' selected' : '') + '>studio voices (with the studio host)</option><option value="system"' + (S.contestantEngine == 'system' ? ' selected' : '') + '>system voices</option></select></td></tr>' +
            '<tr><td>Read categories</td><td><label><input type="checkbox" data-s="readCategories"' + (S.readCategories ? ' checked' : '') + '>Host reads the categories at the start of each round</label></td></tr>' +
            '<tr><td>Uppercase clues</td><td><label><input type="checkbox" data-s="upper"' + (S.upper ? ' checked' : '') + '>Show clue text in capitals, like the show</label></td></tr>' +
            '<tr><td>Sound effects</td><td><label><input type="checkbox" data-s="sfx"' + (S.sfx ? ' checked' : '') + '>On (drop files into the extension\'s <code>sounds/</code> folder to replace the built-in tones)</label></td></tr>' +
            '<tr><td>Playback</td><td><select class="jp-out-device" style="max-width:100%"><option value="default">System default</option></select>' +
              '<span class="jp-out-device-note jp-note" style="margin-left:8px">the studio voice, effects and music (a system voice always follows the system default)</span></td></tr>' +
            (roomRows ? '' : '<tr><td>Time to answer</td><td><input type="number" data-s="answerSeconds" min="2" max="15" value="' + (+S.answerSeconds) + '" style="min-width:5em;width:5em"> s after buzzing &nbsp; ' +
              'ring-in window <input type="number" data-s="buzzWindowSeconds" min="2" max="15" value="' + (+S.buzzWindowSeconds) + '" style="min-width:5em;width:5em"> s &nbsp; ' +
              'lockout <input type="number" data-s="lockoutMs" min="0" max="2000" step="50" value="' + (+S.lockoutMs) + '" style="min-width:5em;width:5em"> ms</td></tr>' +
            '<tr><td>After a clue</td><td>move on after <input type="number" data-s="autoAdvanceMs" min="0" max="10000" step="100" value="' + (+S.autoAdvanceMs) + '" style="min-width:6em;width:6em"> ms if you don\'t click or press <span class="jp-key">' + buzzKeyName() + '</span> first</td></tr>') +
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

    // The Microphone and Playback lists. Labels appear once the mic has been allowed.
    function fillDeviceSelects(panel) {
        let ms = panel.querySelector('.jp-mic-device'), os = panel.querySelector('.jp-out-device');
        if (!ms && !os) return;
        JPAudio.devices().then(function(dv) {
            if (!panel.isConnected) return;
            let opt = function(v, label, cur) { return '<option value="' + esc(v) + '"' + (cur == v ? ' selected' : '') + '>' + esc(label) + '</option>'; };
            if (ms) {
                let cur = S.micDevice || 'auto';
                let html = opt('auto', 'Automatic', cur) + opt('default', 'System default microphone', cur);
                for (let d of dv.inputs) if (!d.isDefault && d.label) html += opt(d.id, d.label, cur);
                if (!dv.labeled) html += '<option value="" disabled>(allow the microphone — Test microphone — to list them)</option>';
                if (cur != 'auto' && cur != 'default' && !dv.inputs.some(function(d) { return d.id == cur; })) html += opt(cur, '(chosen microphone, not connected)', cur);
                ms.innerHTML = html;
                describeMicChoice(panel);
            }
            if (os) {
                let cur = S.outDevice || 'default';
                let html = opt('default', 'System default', cur);
                if (JPAudio.outputRoutable()) for (let d of dv.outputs) if (!d.isDefault && d.label) html += opt(d.id, d.label, cur);
                if (cur != 'default' && !dv.outputs.some(function(d) { return d.id == cur; })) html += opt(cur, '(chosen output, not connected)', cur);
                os.innerHTML = html;
                os.disabled = !JPAudio.outputRoutable();
            }
        });
    }
    function describeMicChoice(panel) {
        let note = panel.querySelector('.jp-mic-device-note');
        if (!note || !JPAudio.micChoice) return;
        JPAudio.micChoice(S.micDevice || 'auto').then(function(c) {
            if (!panel.isConnected || !c) return;
            let base = 'Automatic uses the system default, or the built-in microphone when a Bluetooth headset is the default — so your headphones don\'t drop to call quality every time the game listens. (Chrome\'s built-in recognizer always uses the system default microphone.)';
            note.textContent = (c.label ? 'The studio ear will open ' + c.label + ' (' + c.why + ')' + (c.outLabel ? '; sound plays through ' + c.outLabel : '') + '. ' : '') + base;
        });
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
        fillDeviceSelects(panel);
        let onDev = function() { if (panel.isConnected) fillDeviceSelects(panel); else if (navigator.mediaDevices) navigator.mediaDevices.removeEventListener('devicechange', onDev); };
        if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener('devicechange', onDev);
        let ms = panel.querySelector('.jp-mic-device');
        if (ms) ms.addEventListener('change', function() { S.micDevice = ms.value || 'auto'; saveSettings(); describeMicChoice(panel); });
        let os = panel.querySelector('.jp-out-device');
        if (os) os.addEventListener('change', function() { S.outDevice = os.value || 'default'; saveSettings(); });
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

        bindPlayers(panel);
        panel.querySelectorAll('[data-s]').forEach(function(inp) {
            let key = inp.dataset.s;
            if (inp.closest('.jp-players-wrap')) return;
            inp.addEventListener('change', function() {
                if (inp.type == 'checkbox') S[key] = inp.checked;
                else if (inp.type == 'number' || inp.type == 'range') S[key] = +inp.value;
                else S[key] = inp.value;

                if (key == 'sfx') JPAudio.setEnabled(S.sfx);
                if (key == 'hostVoice' || key == 'neuralVoice') setupVoices();
                if (key == 'earSize') refreshEarUI(panel);
                if (key == 'micMode') { S.answerMode = S.micMode == 'off' ? 'typed' : 'speech'; applyMicHold(); }
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
            let earOn = typeof JPEar !== 'undefined' && JPEar.active();
            // which mic, and how loud it comes in (the studio ear's choice; Chrome's recognizer always takes the system default)
            let level = (JPAudio.micChoice ? JPAudio.micChoice(earOn ? (S.micDevice || 'auto') : 'default') : Promise.resolve(null)).then(function(c) {
                return JPAudio.sampleInputLevel(4000, c && c.id && c.id != 'default' ? c.id : null).then(function(lv) { if (lv && c) lv.why = c.why; return lv; });
            });
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
                    out.textContent = msg + '  ·  Input: ' + (lv.label || 'default microphone') + (lv.why && !/default/.test(lv.why) ? ' (' + lv.why + ')' : '') + ', peak level ' + pct + '%' + verdict + '.';
                });
            });
        };
    }

    function showSetup() {
        if (G) G.round = '';
        applyMicHold();                                   // no game running: the mic is let go
        setHeader('Play Live', document.title.replace(/^J! Archive - /, ''), '');
        clearTimer();
        showAnswerStrip(false);
        let names = realNames();
        let onboarding = (!S.onboardedVoice && neuralAvailableHere())
            ? '<div class="jp-onboard"><b>New: a studio-quality host voice.</b> The host can now speak with a natural voice that runs entirely on your computer — free, no account, nothing sent anywhere. It\'s a one-time download (about 90–330 MB depending on your hardware). Click <b>Check my computer</b> under Host voice to see if yours can run it, then <b>Download</b>. The system voice keeps working either way. <button class="jp-btn jp-secondary jp-onboard-ok" style="padding:2px 10px;font-size:0.9em;margin-left:8px">Got it</button></div>'
            : '';
        let panel = showPanel(
            '<h1>Play Live</h1>' + onboarding + '<div class="jp-online-slot"></div>' +
            '<div class="jp-intro">' + setupIntro() + '</div>' +
            '<p class="jp-note">During play: click / <span class="jp-key">' + buzzKeyName() + '</span> ring in, and move on when the game is waiting · <span class="jp-key">Enter</span> submit a typed response or wager · <span class="jp-key">y</span>/<span class="jp-key">n</span> overrule a judgment · <span class="jp-key">Esc</span> or the Pause button freezes everything</p>' +
            '<h2>Settings</h2>' + settingsForm() +
            '<div class="jp-setup-actions"><button class="jp-btn jp-start">Start the game</button> <button class="jp-btn jp-secondary jp-scores">High scores</button> <button class="jp-btn jp-secondary jp-cancel">Back to the page</button></div>'
        );
        bindSettingsForm(panel);
        let slot = panel.querySelector('.jp-online-slot');
        if (slot && onlineAvailable()) JPOnline.init().then(function() {
            if (!slot.isConnected) return;
            slot.innerHTML = accountBox();
            bindAccountBox(panel, showSetup);
            if (JPOnline.signedIn && !onlineSynced) { onlineSynced = true; syncOnline(); }
        });
        if (typeof JPPlayed != 'undefined') JPPlayed.get(gameId(), function(rec) {
            if (!rec || !panel.isConnected || panel.querySelector('.jp-played-before')) return;
            let d = rec.d ? new Date(rec.d) : null, p = h('p', 'jp-note jp-played-before');
            p.innerHTML = '\u2713 ' + (d && !isNaN(d) ? 'You played this game on ' + esc(d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' })) + (typeof rec.s == 'number' ? ' — ' + money(rec.s) + (rec.w ? ', and won' : '') : '') + (rec.n > 1 ? ' (' + rec.n + ' times in all)' : '') : 'You\'ve played this game before (so says your account)') + '. ' +
                          (nextGameLink() ? 'The <a href="' + esc(nextGameLink().href.replace(/#.*$/, '')) + '#jplive-next" class="jp-link">next game</a> is a click away.' : '');
            panel.querySelector('h1').insertAdjacentElement('afterend', p);
        });
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
        if (!online()) JPClock.pause();
        pauseEl = h('div', 'jp-dialog');
        U.root.appendChild(pauseEl);
        swapPauseContents(withSettings ? 'settings' : 'pause');
    }
    // mode: 'pause' | 'settings' | 'results' | 'rewind'
    function swapPauseContents(mode) {
        if (mode === true) mode = 'settings';
        let inner = h('div', 'jp-panel jp-wide' + (mode == 'pause' ? ' jp-pause-plain' : ''));
        let title = mode == 'settings' ? 'Settings' : mode == 'results' ? 'Edit results' : mode == 'rewind' ? 'Rewind' : 'Paused';
        let body = mode == 'settings' ? settingsForm() + '<p class="jp-note">' + (online() ? 'The game goes on meanwhile. Changes apply from the next clue.' : 'The game is paused. Changes apply from the next clue.') + '</p>'
                 : mode == 'results' ? resultsForm()
                 : mode == 'rewind' ? rewindForm()
                 : online() ? '<p class="jp-note">An online game can\'t be paused — it goes on while this is open.</p>'
                 : '<p class="jp-note">The game is frozen where it is.</p>';
        inner.innerHTML = '<h1>' + (online() && mode == 'pause' ? 'Menu' : title) + '</h1>' + body +
            '<div class="jp-menu-row"><button class="jp-btn jp-resume">' + (online() ? 'Back to the game' : 'Resume') + '</button>' +
            (mode == 'settings' ? '' : '<button class="jp-btn jp-secondary jp-show-settings">Settings</button>') +
            (mode == 'results' || online() ? '' : '<button class="jp-btn jp-secondary jp-show-results">Edit results</button>') +
            (mode == 'rewind' || online() ? '' : '<button class="jp-btn jp-secondary jp-show-rewind">Rewind</button>') +
            (online() ? '' : '<button class="jp-btn jp-secondary jp-restart">Restart game</button>') +
            '<button class="jp-btn jp-secondary jp-quit">' + (online() ? 'Leave the game' : 'Quit to page') + '</button></div>';
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
        let rs = inner.querySelector('.jp-restart');
        if (rs) rs.onclick = function() { closePauseMenu(); runToken++; JPAudio.stopSpeaking(); JPAudio.stopLoop(); showSetup(); };
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
                '<td class="jp-result-said">' + (humans().length > 1 ? '<b>' + esc(r.who || YOU) + ':</b> ' : '') + (r.said ? '“' + esc(r.said) + '”' : '<i>(no response)</i>') + '</td>' +
                '<td class="jp-result-correct">' + esc(r.correct) + '</td>' +
                '<td class="jp-result-choice">' + opt('right', 'Right <span class="jp-plus">+' + stake + '</span>') + opt('none', 'No response <span class="jp-zero">$0</span>') + opt('wrong', 'Wrong <span class="jp-minus">−' + stake + '</span>') +
                (r.others && r.others.length ? '<div class="jp-note jp-result-others">If you\'re not right, then: ' + r.others.map(function(o) { return esc(o.who) + ' ' + (o.delta ? (o.right ? '<span class="jp-plus">+' : '<span class="jp-minus">−') + money(Math.abs(o.delta)) + '</span>' : (o.right ? 'right' : 'wrong') + ', no credit (media missing)'); }).join(', ') + '</div>' : '') +
                '</td></tr>';
        }).join('');
        return '<p class="jp-note">If the judge got one of your responses wrong, fix it here. The money follows: yours, and that of anyone who rang in after you on that clue (right, and they never got the chance; wrong, and they play it out as broadcast). The ring-in order and control of the board stay as they happened.</p>' +
            '<table class="jp-results"><tr><th>Clue</th><th>' + (humans().length > 1 ? 'Response' : 'You said') + '</th><th>Correct response</th><th>Result</th></tr>' + rows + '</table>' +
            '<p class="jp-result-total">' + humanTotals() + '</p>';
    }
    function humanTotals() {
        return humans().map(function(hm) { return (hm == YOU ? 'Your score' : esc(hm)) + ': <b class="jp-result-score">' + money(G.scores[hm]) + '</b>'; }).join(' &nbsp;·&nbsp; ');
    }
    // Every clue played so far, in order, each a point to go back to.
    function rewindForm() {
        let hist = (G && G.history) || [ ];
        if (!hist.length) return '<p class="jp-note">Nothing to rewind yet — the list fills in as clues are played.</p>';
        let rows = hist.map(function(snap, i) {
            let where = snap.num == null ? 'Final Jeopardy!' : roundTitle(snap.round) + ' · ' + money(snap.value);
            let picker = snap.num == null ? '' : (snap.control == YOU ? 'you had the board' : snap.control + ' had the board');
            let recs = (G.results || [ ]).filter(function(r) { return snap.num != null ? (r.kind != 'fj' && r.num == snap.num) : r.kind == 'fj'; });
            let yours = recs.map(function(rec) { return esc(rec.who || YOU) + ': ' + (rec.said ? '“' + esc(rec.said) + '”' : '(no response)') + ' — ' + (rec.outcome == 'right' ? '<span class="jp-plus">right</span>' : rec.outcome == 'wrong' ? '<span class="jp-minus">wrong</span>' : 'no response'); }).join('<br>');
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
                let tot = panel.querySelector('.jp-result-total');
                if (tot) tot.innerHTML = humanTotals();
            });
        });
    }
    function closePauseMenu() {
        if (pauseEl) { pauseEl.remove(); pauseEl = null; }
        JPClock.resume();
        if (G.recorded && U && U.stage.querySelector('.jp-again')) showFinalStandings();   // the final screen follows edits
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
        G = { round: '', scores: { }, played: { }, control: null, results: [ ], cresults: [ ], trajectory: [ ], history: [ ], recorded: null, humans: humanNames(), hstats: { }, stats: { buzzWins: 0, buzzLost: 0, lockouts: 0, answered: 0, correct: 0, wrong: 0, clues: 0 } };
        for (let n of allPlayers()) G.scores[n] = 0;
        document.addEventListener('keydown', onKey, true);
        U.root.style.display = 'flex';
        showSetup();
        neuralAutoLoad();
        earAutoLoad();
    };

    function quitLive() {
        runToken++;
        if (online()) {
            if (!G.recorded && !G.online.dead) { try { if (hostHere()) JPOnline.abandonRoom(G.online.room.id); } catch (e) { } }
            if (typeof JPOnline !== 'undefined') JPOnline.disconnect();
            G.online = null;
        }
        liveActive = false;
        handlers = { buzz: null, override: null, cont: null, pick: null };
        JPAudio.stopSpeaking();
        JPAudio.stopLoop();
        closePauseMenu();
        JPClock.resume();
        document.removeEventListener('keydown', onKey, true);
        if (typeof JPEar !== 'undefined') { if (JPEar.setHold) JPEar.setHold(false); JPEar.closeMic(); }
        if (U) U.root.style.display = 'none';
    }

    // ------------------------------------------------------ the host's script
    // Lines that make the host sound like a host: standings at the top of
    // Double Jeopardy!, who starts, the Daily Double exchange, Final Jeopardy!
    // Money is written "$8,000" — both voice engines read that naturally.

    function isChampion(name) {
        try { return /winnings total/i.test((contestants[name] || { }).info || ''); } catch (e) { return false; }
    }
    function heShe(who) { return who == YOU ? 'you' : isHuman(who) ? who : (guessGender(who) == 'f' ? 'she' : 'he'); }
    function himHer(who) { return who == YOU ? 'you' : isHuman(who) ? who : (guessGender(who) == 'f' ? 'her' : 'him'); }
    function ordinalPlace(i) { return [ 'first', 'second', 'third', 'fourth' ][i] || (i + 1) + 'th'; }
    function joinNatural(items) {
        if (items.length <= 1) return items.join('');
        if (items.length == 2) return items[0] + ' and ' + items[1];
        return items.slice(0, -1).join(', ') + ', and ' + items[items.length - 1];
    }
    // Standings order: by money, and on a tie you rank above the contestants
    // (they keep podium order among themselves). ranked(scores) is high to low.
    function ranked(scores) {
        let base = allPlayers();
        let names = base.slice();
        names.sort(function(a, b) {
            if (scores[b] != scores[a]) return scores[b] - scores[a];
            let ha = isHuman(a), hb = isHuman(b);
            if (ha != hb) return ha ? -1 : 1;
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
        function has(g) { return g.who.length > 1 ? (joinNatural(g.who.map(nameOf)) + ' are tied at ' + money(g.score)) : (g.who[0] == YOU ? 'you have ' + money(g.score) : g.who[0] + ' has ' + money(g.score)); }
        let lead = groups[0], rest = groups.slice(1);
        let first = lead.who.length > 1 ? joinNatural(lead.who.map(nameOf)) + ' are tied for the lead at ' + money(lead.score) + '.'
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
        let names = allPlayers();
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
        if (!online()) saveSettings();
        setupVoices();
        G.humans = online() ? G.online.names : humanNames();
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
        for (let n of allPlayers()) G.scores[n] = 0;
        G.played = { };
        G.results = [ ];
        G.cresults = [ ];
        G.trajectory = [ ];
        G.history = [ ];
        G.recorded = null; G.recordedAll = null;
        G.hstats = { };
        G.stats = { buzzWins: 0, buzzLost: 0, lockouts: 0, answered: 0, correct: 0, wrong: 0, clues: 0 };
        // The returning champion (leftmost podium on J! Archive) picks first; with no contestants, the first human.
        G.control = realNames()[0] || humans()[0];
        renderPodiums();
        G.round = 'J';
        applyMicHold();                                   // "on for the whole game": open now, close at the end
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
        if (online()) { await finishOnline(tok); if (!alive(tok)) return; }
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
            cresults: clone(G.cresults || [ ]), trajectory: clone(G.trajectory || [ ]), hstats: clone(G.hstats || { }),
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
        handlers = { buzz: null, override: null, cont: null, pick: null, submit: null, inputBuzz: null };
        JPAudio.stopSpeaking();
        JPAudio.stopLoop();
        if (typeof JPNeural !== 'undefined') JPNeural.clearPrefetch();
        G.round = snap.round;
        G.scores = clone(snap.scores);
        G.played = clone(snap.played);
        G.control = snap.control;
        G.results = clone(snap.results);
        G.stats = clone(snap.stats);
        G.cresults = clone(snap.cresults || [ ]);
        G.trajectory = clone(snap.trajectory || [ ]);
        G.hstats = clone(snap.hstats || { });
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
        JPNeural.prefetch(notes, v, S.rate, 110);
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
            setHint('Click or press ' + anyKeyHtml() + ' to skip.');
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
            } else if (isHuman(G.control) && online() && !isMe(G.control)) {
                renderBoard(round, false);
                setHint('<b>' + esc(G.control) + '</b> has control and is picking…');
                let ev = await fromPlayerOrForce('pick', G.control, function(p) { return remaining.indexOf(p.num) >= 0; }, 30000, { num: remaining[0], round: round });
                if (!alive(tok)) return;
                if (!ev) { onlineLost(); return; }
                num = ev.num;
                let cell = boardCell(num);
                if (cell) cell.classList.add('jp-picking');
                await sleep(400, tok);
                if (!alive(tok)) return;
            } else if (isHuman(G.control)) {
                setHint('<b>' + (G.control == YOU ? 'You have' : esc(G.control) + ', you have') + ' control.</b> Click a clue on the board.');
                renderBoard(round, true);
                num = await userPick(tok);
                if (!alive(tok)) return;
                if (online()) JPOnline.send('pick', { num: num, round: round });
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
            recordTrajectory(num);
            if (hostHere()) JPOnline.send('scores', { num: num, scores: G.scores });
        }

        G.phase = 'other';
        JPAudio.play('roundend');
        showPanel('<h1>End of the ' + roundTitle(round) + '</h1>' + standingsTable() + '<p class="jp-note">Click or press ' + anyKeyHtml() + ' to continue.</p>').classList.add('jp-clickthrough');
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
        setHint('The host is reading the categories — click or press ' + anyKeyHtml() + ' to skip.');
        let r = await hostSaySkippable(round == 'J' ? 'Let\'s take a look at the categories.' : 'Here are the categories in Double Jeopardy.', tok, 0.95);
        if (!alive(tok) || r.skipped) return r;
        for (let i = 0; i < 6; i++) {
            let c = categoryInfo(catIdx + i);
            let cell = boardEl ? boardEl.querySelectorAll('.jp-cathead')[i] : null;
            if (cell) cell.classList.add('jp-reading');
            let text = categorySpoken(c.name, i);
            r = await hostSaySkippable(text, tok, CATEGORY_RATE, 'category');
            // The category's note (a host's aside) follows straight on, at the normal clue speed; the long pause is between categories.
            if (alive(tok) && !r.skipped && c.comments) r = await hostSaySkippable(JPReader.commentToSpeech(c.comments), tok, 1);
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
    // A spoken wager: "twelve hundred", "two thousand five hundred", "$1,500",
    // "3k", "all of it" / "true Daily Double" (= max). Returns a number or null.
    const SMALL_NUMS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
        sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, a: 1, an: 1 };
    function wordsToNumber(words) {
        // "two thousand five hundred", "twelve hundred", "fifteen hundred and fifty"
        let total = 0, cur = 0, any = false;
        for (let w of words) {
            if (w == 'and') continue;
            if (SMALL_NUMS[w] != null) { cur += SMALL_NUMS[w]; any = true; }
            else if (/^\d+$/.test(w)) { cur += +w; any = true; }
            else if (w == 'hundred') { cur = (cur || 1) * 100; any = true; }
            else if (w == 'thousand' || w == 'grand' || w == 'k') { total += (cur || 1) * 1000; cur = 0; any = true; }
            else return any ? null : null;
        }
        return any ? total + cur : null;
    }
    function parseWager(text, min, max) {
        let t = normalizeSpeech(text);
        if (!t) return null;
        if (/\b(all of it|all in|everything|the whole thing|true daily double|make it a true|go all in|bet it all|max|maximum)\b/.test(t)) return max;
        if (/\b(nothing|zero|zip|nada)\b/.test(t) && !/\d/.test(t)) return min;
        // digits first ("1500", "1,500" -> commas already stripped, "3k", "3.5k")
        let m = /\b(\d+(?:\.\d+)?)\s*k\b/.exec(t);
        if (m) return Math.round(+m[1] * 1000);
        m = /\b(\d{1,5})\b/.exec(t);
        if (m) { let v = +m[1]; if (/\b\d{1,2} (hundred|thousand|grand)\b/.test(t)) { /* "15 hundred" */ } else return v; }
        // number words, in the run of words that are numbers
        let words = t.split(' '), best = null;
        for (let i = 0; i < words.length; i++) {
            if (!(SMALL_NUMS[words[i]] != null || /^\d+$/.test(words[i]))) continue;
            let j = i;
            while (j < words.length && (SMALL_NUMS[words[j]] != null || /^\d+$/.test(words[j]) || /^(hundred|thousand|grand|k|and)$/.test(words[j]))) j++;
            let v = wordsToNumber(words.slice(i, j));
            if (v != null && (words[i] != 'a' && words[i] != 'an' || j - i > 1)) { best = v; i = j; }
        }
        return best;
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
        setHint('<b>' + (G.control == YOU || !isHuman(G.control) ? 'You have' : esc(G.control) + ', you have') + ' control.</b> ' + (useVoice ? 'Say a category and an amount ("Science for 600"), or click a clue.' : 'Click a clue on the board.') + (useVoice ? ' <span class="jp-heard-pick jp-note"></span>' : ''));
        return new Promise(function(resolve) {
            let done = false, current = null;
            function finish(n) {
                if (done) return;
                done = true;
                handlers.pick = null;
                JPClock.off(onPausePick);
                if (current) { try { if (current.abort) current.abort(); else current.stop(); } catch (e) { } }   // the mic is released before the host speaks
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
                    }, { endOnFinal: false, linger: 400 });     // the next 20 s session follows at once: keep the mic across the gap
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
        if (online()) G.online.attempt = 0;
        handlers.override = null;
        clearPodiumLines();
        clearOuts();
        lightPodium(null);
        setHeader(roundTitle(G.round), '', '');            // the clue's own strip carries the category and the value
        JPAudio.play('select');
        await sleep(200, tok);
        if (!alive(tok)) return;

        if (info.dd) {
            await playDailyDouble(info, tok);
            return;
        }

        let media = await mediaFor(info, tok);
        if (!alive(tok)) return;
        showClue(clueHtml(info), { category: info.category, value: money(info.value), media: media });
        clearTimer();

        // Early buzz = lockout (for that player). The handler is live while the host is reading.
        let armed = false, locked = { };
        handlers.buzz = function(who) {
            if (armed) return;
            locked[who] = JPClock.now() + S.lockoutMs;
            G.stats.lockouts++; hstat(who, 'lockouts');
            JPAudio.play('lockout');
            flashLocked();
        };
        setHint('Wait for the lights, then ' + ringInHint() + ' to ring in.');
        await hostSay(info.queryText, 'clue');
        if (!alive(tok)) { handlers.buzz = null; return; }
        await playClueVideo(tok);                       // a clue's video plays after the reading (audio played with it)
        if (!alive(tok)) { handlers.buzz = null; return; }

        // Lights on (online, the race lights them, once everyone has heard the clue).
        armed = true;
        if (!online()) { setLit(true); JPAudio.play('lights'); }
        let out = { };                                    // humans who've missed this clue
        let userOut = function() { return humans().every(function(hm) { return out[hm]; }); };
        let seqIdx = 0;
        let resolved = false;
        let responded = { };
        let events = [ ], userRec = null, userAt = -1;   // contestant responses in order; where the last human's response fell

        while (alive(tok) && !resolved) {
            let next = info.sequence[seqIdx] || null;
            while (next && responded[next.who]) next = info.sequence[++seqIdx] || null;
            setTimer(S.buzzWindowSeconds, 'green');
            let isRebound = Object.keys(responded).length > 0 || Object.keys(out).length > 0;
            let ev = await race(tok, next, S.buzzWindowSeconds * 1000, function(who) { return !out[who]; }, function(who) { return locked[who] || 0; }, function(who, t) { locked[who] = t; }, ringInMult(info, isRebound));
            if (!alive(tok)) break;
            clearTimer();

            if (ev.type == 'user') {
                let who = ev.who;
                G.stats.buzzWins++; hstat(who, 'buzzWins');
                JPAudio.play('buzz');
                lightPodium(who);
                setLit(false);
                let res = await userAnswers(info, S.answerSeconds, tok, info.value, who);
                if (!alive(tok)) break;
                if (userRec) { userRec.others = [ ]; }         // an earlier human's miss: only their own money is theirs to edit
                userRec = res.rec || null; userAt = events.length;
                if (userRec) {
                    // What the rest of the broadcast holds for this clue, should the response turn out wrong.
                    userRec.others = info.sequence.filter(function(x) { return !responded[x.who]; }).map(function(x) { return { who: x.who, right: x.right, delta: (x.right ? 1 : -1) * othersCredit(info, info.value) }; });
                    userRec.othersDelta = { };
                }
                if (res.correct) {
                    setControl(who);
                    resolved = true;
                } else {
                    out[who] = true;
                    markOut(who, true);
                    if (!next && userOut()) {
                        await revealCorrect(info, tok, true);
                        resolved = true;
                    } else {
                        if (!online()) { setLit(true); JPAudio.play('lights'); }
                        lightPodium(null);
                        setHint(userOut() ? 'Rebound — the others can ring in now.' : 'Rebound — ' + ringInHint(out) + ' to ring in.');
                    }
                }
            } else if (ev.type == 'contestant') {
                if (next && !userOut()) G.stats.buzzLost++;
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
                let credit = othersCredit(info, info.value);
                (G.cresults || (G.cresults = [ ])).push({ who: ev.who, num: num, right: ev.right, value: info.value, dd: false });
                if (ev.right) {
                    adjustScore(ev.who, credit);
                    if (userRec) userRec.othersDelta[ev.who] = credit;
                    setControl(ev.who);
                    setSub('<span class="jp-who">' + esc(ev.who) + ':</span> ' + esc(text) + ' &nbsp; <span class="jp-correct">' + esc(pick(HOST_RIGHT)) + '</span>' + creditNote(credit, info.value));
                    await say(pick(HOST_RIGHT), tok);
                    resolved = true;
                } else {
                    adjustScore(ev.who, -credit);
                    if (userRec) userRec.othersDelta[ev.who] = -credit;
                    markOut(ev.who, true);
                    setSub('<span class="jp-who">' + esc(ev.who) + ':</span> ' + esc(text) + ' &nbsp; <span class="jp-incorrect">' + esc(pick(HOST_WRONG)) + '</span>' + creditNote(credit, info.value));
                    await say(pick(HOST_WRONG), tok);
                    if (!alive(tok)) break;
                    seqIdx++;
                    let more = info.sequence.slice(seqIdx).some(function(x) { return !responded[x.who]; });
                    if (!more && userOut()) {
                        await revealCorrect(info, tok, true);
                        resolved = true;
                    } else {
                        if (!online()) { setLit(true); JPAudio.play('lights'); }
                        lightPodium(null);
                        setHint(userOut() ? 'Rebound.' : 'Rebound — ' + ringInHint(out) + ' to ring in.');
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
            if (followed.length) userRec.others = followed.map(function(e) { return { who: e.who, right: e.right, delta: (e.right ? 1 : -1) * othersCredit(info, info.value) }; });
            reconcileOthers(userRec);   // a "y" pressed while they were still answering
            if (G.pendingControl) setControl(controlFor(userRec));   // ...and the board goes with it
        }
        G.phase = 'pick';
        setLit(false);
        clearTimer();
        lightPodium(null);
        setHint('Click or press ' + anyKeyHtml() + ' to continue.');
        await pause(S.autoAdvanceMs, tok);
        showAnswerStrip(false);
    }

    function clueHtml(info) {
        return info.queryHtml.replace(/<a [^>]*>(.*?)<\/a>/g, '$1');   // the media itself is rendered by showClue (opts.media)
    }

    // Wait for the first of: the user's buzz, the next archived contestant's
    // simulated buzz, or the ring-in window closing.
    function race(tok, contestant, windowMs, userAllowed, getLock, setLock, mult) {
        if (online()) return raceOnline(tok, contestant, windowMs, userAllowed, getLock, setLock, mult);
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
            handlers.buzz = function(who) {
                if (!who) who = humans()[0];
                let now = JPClock.now();
                if (now < getLock(who)) { setLock(who, now + S.lockoutMs); G.stats.lockouts++; hstat(who, 'lockouts'); JPAudio.play('lockout'); flashLocked(); return; }
                if (!userAllowed(who)) return;
                finish({ type: 'user', who: who });
            };
        });
    }
    // Per-human counters (buzzer races won, lockouts), for the records of a multiplayer game.
    function hstat(who, key) { if (!G.hstats) G.hstats = { }; let h = G.hstats[who] || (G.hstats[who] = { }); h[key] = (h[key] || 0) + 1; }
    // "click or press Space" (one player) / "Alice: A, Bob: L" (several); skip: humans who are out.
    function ringInHint(skip) {
        if (online()) return 'click or press <span class="jp-key">' + buzzKeyName() + '</span>';
        let hs = humans().filter(function(hm) { return !(skip && skip[hm]); });
        if (hs.length == 1 && humans().length == 1) return 'click or press <span class="jp-key">' + buzzKeyName(hs[0]) + '</span>';
        return hs.map(function(hm) { return esc(hm) + ' <span class="jp-key">' + buzzKeyName(hm) + '</span>' + (hm == mouseHuman() ? ' or click' : ''); }).join(', ');
    }

    // You rang in (or it's your Daily Double): listen / read the input, judge,
    // show the verdict with a short y/n override window, apply the money.
    // The microphone opens when you ring in and closes as soon as you've
    // responded: the first finished phrase is your response, judged right
    // away, right or wrong (no second tries -- a live game doesn't give those,
    // and an open mic changes how headphones sound).
    async function userAnswers(info, seconds, tok, amount, who) {
        who = who || humans()[0];
        G.stats.answered++;
        let useSpeech = S.answerMode == 'speech' && JPAudio.recognitionSupported();
        showAnswerStrip(true, useSpeech);
        setTimer(seconds, 'red');
        let lead = who == YOU ? '' : '<b>' + esc(who) + ':</b> ';
        setHint(lead + (useSpeech ? 'Say your response (or type it and press <span class="jp-key">Enter</span>).' : 'Type your response and press <span class="jp-key">Enter</span>.'));
        setSub('<span class="jp-who">' + esc(who) + ':</span> …');

        let collect = function() { return new Promise(function(resolve) {
            let done = false, listener = null, interim = '', phrases = [ ];   // phrases: the finished phrase heard, with its alternatives
            let stems = [ ];                                                  // "what is…", "um": heard, but no response yet
            let deadline = JPClock.now() + seconds * 1000;
            function finish(typed, abort) {
                if (done) return;
                done = true;
                JPClock.clearTimeout(t);
                JPClock.off(onPauseAnswer); JPClock.off(onResumeAnswer);
                handlers.submit = null;
                if (listener) { try { if (abort && listener.abort) listener.abort(); else listener.stop(); } catch (e) { } }
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
            handlers.submit = function(text) { finish(text, true); };   // typed: the mic is released at once

            // One finished phrase, with its alternatives. "What is…" on its own
            // isn't a response (you're still thinking): it's kept as a prefix and
            // the mic stays on. The first phrase with something in it is judged.
            function heardSegment(seg) {
                if (!seg || !seg.length || JPJudge.contentFree(seg[0])) { if (seg && seg[0]) stems.push(seg[0]); return false; }
                let stem = stems.join(' ').trim();
                phrases = [ stem ? seg.map(function(a) { return stem + ' ' + a; }).concat(seg) : seg.slice() ];
                return true;
            }
            function attach(l) {
                listener = l;
                let seen = 0, before = stems.join(' ').trim();                // segments are per recognizer session
                l.onInterim = function(text, gotFinal, segments) {
                    interim = (before + ' ' + text).trim();
                    U.heard.textContent = interim ? '“' + interim + '”' : '';
                    if (!gotFinal || !segments) return;
                    for (let seg of segments.slice(seen)) { seen++; if (heardSegment(seg)) { finish(U.input.value, true); return; } }
                };
                l.then(function(r) {
                    if (listener !== l || done) return;         // superseded after a pause, or finished
                    for (let seg of (r.segments || [ ]).slice(seen)) { seen++; if (heardSegment(seg)) { finish(U.input.value, true); return; } }
                    if (timeUp) { finish(U.input.value); return; }
                    if (JPClock.paused) return;
                    if (r.error && r.error != 'no-speech' && r.error != 'aborted') { U.mic.className = 'jp-mic'; U.mic.textContent = 'Mic: ' + r.error + ' — type it'; return; }
                    // The recognizer ended on silence with no response yet; keep listening while there is time.
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
        }); };
        let got;
        if (online() && !isMe(who)) {
            // Someone else's response: it arrives as what they typed or were heard to say, and every client judges it the same way.
            showAnswerStrip(false);
            setHint('<b>' + esc(who) + '</b> is responding…');
            let attempt = G.online.attempt;
            let ev = await fromPlayerOrForce('response', who, function(p) { return p.num == info.num && p.attempt == attempt; }, seconds * 1000 + 6000, { num: info.num, attempt: attempt, typed: '', phrases: [ ], interim: '' });
            if (!alive(tok)) return { correct: false };
            if (!ev) { onlineLost(); return { correct: false }; }
            got = { typed: String(ev.typed || ''), phrases: Array.isArray(ev.phrases) ? ev.phrases : [ ], interim: String(ev.interim || '') };
        } else {
            got = await collect();
            if (online() && alive(tok)) JPOnline.send('response', { num: info.num, attempt: G.online.attempt, typed: got.typed, phrases: got.phrases, interim: got.interim });
        }
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
        let rec = addResult({ kind: info.dd ? 'dd' : 'clue', num: info.num, round: G.round, category: info.category.name, value: info.value, amount: amount, who: who,
                              said: said, correct: JPJudge.stripHtml(info.correct), outcome: correct ? 'right' : 'wrong' });

        function show() {
            let ok = rec.outcome == 'right', none = rec.outcome == 'none';
            let line = '<span class="jp-who">' + esc(who) + ':</span> ' + (said ? esc(said) : '<i>(no response)</i>') +
                ' &nbsp; <span class="' + (ok ? 'jp-correct' : 'jp-incorrect') + '">' + (none ? 'No response.' : ok ? esc(pick(HOST_RIGHT)) : esc(pick(HOST_WRONG))) + '</span>' +
                ' &nbsp; <span class="jp-note">Correct response: <em class="correct_response">' + info.correct + '</em></span>';   // shown either way: check the judge, and learn the exact wording
            setSub(line);
            podiumLine(who, '<span class="' + (ok ? 'jp-correct' : 'jp-incorrect') + '">' + (said ? esc(said) : '(no response)') + '</span>');
        }
        show();
        JPAudio.play(correct ? 'right' : 'wrong');
        let speakP = say(correct ? pick(HOST_RIGHT) : pick(HOST_WRONG), tok);
        showAnswerStrip(false);
        if (online()) setHint('');
        else {
            setHint('Misjudged? <span class="jp-key">y</span> = ' + (who == YOU ? 'I was' : esc(who) + ' was') + ' right, <span class="jp-key">n</span> = wrong (until the next clue; later, Edit results in the pause menu).');
            // The y/n override stays available until the next clue starts; it
            // corrects the money (control of the board is not revisited).
            handlers.override = function(isRight) {
                setOutcome(rec, isRight ? 'right' : 'wrong');
                show();
            };
        }
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

    // opts.voice: a Daily Double wager can be spoken ("twelve hundred", "all of
    // it"); a Final Jeopardy! wager is typed. Only Enter, the buttons or a clear
    // spoken amount confirm it -- a click outside the box just puts the cursor back.
    function promptWager(min, max, title, note, opts) {
        opts = opts || { };
        let useVoice = !!opts.voice && S.answerMode == 'speech' && JPAudio.recognitionSupported();
        return new Promise(function(resolve) {
            let panel = showPanel('<h1>' + esc(title) + '</h1><p>' + note + '</p>' +
                '<p><input type="number" class="jp-wager" min="' + min + '" max="' + max + '" step="1" value="' + Math.min(max, Math.max(min, 1000)) + '" style="font-size:1.6em;width:9em;min-width:9em"> ' +
                '<button class="jp-btn jp-ok">Wager</button> <button class="jp-btn jp-secondary jp-max">All of it (' + money(max) + ')</button>' +
                (useVoice ? ' <span class="jp-mic jp-listening" style="margin-left:8px">Listening…</span> <span class="jp-heard-wager jp-note"></span>' : '') + '</p>' +
                '<p class="jp-note">Between ' + money(min) + ' and ' + money(max) + '. ' + (useVoice ? 'Say it ("twelve hundred", "all of it") or type it and press' : 'Press') + ' <span class="jp-key">Enter</span> to confirm.</p>');
            let inp = panel.querySelector('.jp-wager'), heard = panel.querySelector('.jp-heard-wager');
            setTimeout(function() { inp.focus(); inp.select(); }, 0);
            let finished = false, current = null;
            function done(v) {
                if (finished) return;
                finished = true;
                handlers.cont = null;
                JPClock.off(onPauseW);
                if (current) { try { if (current.abort) current.abort(); else current.stop(); } catch (e) { } }
                resolve(clamp(Math.round(+v || 0), min, max));
            }
            panel.querySelector('.jp-ok').onclick = function() { done(inp.value); };
            panel.querySelector('.jp-max').onclick = function() { done(max); };
            inp.addEventListener('keydown', function(e) { e.stopPropagation(); if (e.key == 'Enter') { e.preventDefault(); done(inp.value); } });
            handlers.cont = function() { try { inp.focus(); } catch (e) { } };   // a click or Space elsewhere is not a confirmation
            function onPauseW() { if (current) current.stop(); }
            if (!useVoice) return;
            JPClock.onPause(onPauseW);
            (async function() {
                while (!finished && panel.isConnected) {
                    await JPClock.whenRunning();
                    if (finished || !panel.isConnected) break;
                    current = JPAudio.listen(15000, function(text) {
                        if (heard) heard.textContent = text ? '“' + text + '”' : '';
                        let v = parseWager(text, min, max);
                        if (v != null) { inp.value = clamp(v, min, max); done(inp.value); }
                    }, { endOnFinal: false, linger: 400 });
                    let r = await current;
                    if (finished) break;
                    if (r.text) { let v = parseWager(r.text, min, max); if (v != null) { inp.value = clamp(v, min, max); done(inp.value); break; } }
                    if (r.error == 'not-allowed' || r.error == 'service-not-allowed' || r.error == 'audio-capture' || r.error == 'unsupported') break;
                    await sleep(150);
                }
            })();
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
        if (isHuman(who) && online() && !isMe(who)) {
            let max = Math.max(G.scores[who], maxVal);
            showPanel('<h1>Daily Double — ' + esc(info.category.name) + '</h1><p><b>' + esc(who) + '</b> is wagering…</p>' + standingsTable(true));
            let ev = await fromPlayerOrForce('wager', who, function(p) { return p.num == info.num; }, 45000, { num: info.num, amount: Math.min(max, 1000) });
            if (!alive(tok)) return;
            if (!ev) { onlineLost(); return; }
            wager = clamp(Math.round(+ev.amount) || 5, 5, max);
        } else if (isHuman(who)) {
            let max = Math.max(G.scores[who], maxVal);
            wager = await promptWager(5, max, 'Daily Double — ' + info.category.name,
                (who == YOU ? 'You have ' : esc(who) + ', you have ') + money(G.scores[who]) + '. You may wager up to ' + money(max) + '.' + standingsTable(true), { voice: true });
            if (!alive(tok)) return;
            if (online()) JPOnline.send('wager', { num: info.num, amount: wager });
        } else {
            let max = Math.max(G.scores[who], maxVal);
            let others = allPlayers().filter(function(n) { return n != who; }).map(function(n) { return G.scores[n]; });
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
        setHeader(roundTitle(G.round), '', '');
        podiumLine(who, 'wagers ' + money(wager));
        let trueDD = wager == G.scores[who] && wager > 0;
        await say((trueDD ? 'A true Daily Double! ' : money(wager) + '. ') + 'All right, here\'s the clue.', tok);
        if (!alive(tok)) return;

        let media = await mediaFor(info, tok);
        if (!alive(tok)) return;
        showClue(clueHtml(info), { category: info.category, value: 'Daily Double · ' + money(wager), media: media });
        await hostSay(info.queryText, 'clue');
        if (!alive(tok)) return;
        await playClueVideo(tok);
        if (!alive(tok)) return;

        if (isHuman(who)) {
            let res = await userAnswers(info, S.ddAnswerSeconds, tok, wager, who);
            if (!alive(tok)) return;
            if (!res.correct) { await say('The correct response: ' + info.phrase.toLowerCase() + ' ' + JPReader.responseToSpeech(info.abbrev) + '?', tok); if (!alive(tok)) return; }
            await say((res.correct ? 'That takes you to ' : 'That takes you down to ') + money(G.scores[who]) + '.', tok);
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
            let ddCredit = othersCredit(info, wager);
            (G.cresults || (G.cresults = [ ])).push({ who: who, num: info.num, right: right, value: info.value, dd: true });
            adjustScore(who, right ? ddCredit : -ddCredit);
            setSub('<span class="jp-who">' + esc(who) + ':</span> ' + esc(text) + ' &nbsp; <span class="' + (right ? 'jp-correct' : 'jp-incorrect') + '">' + esc(right ? pick(HOST_RIGHT) : pick(HOST_WRONG)) + '</span>' +
                   (right ? '' : ' &nbsp; <span class="jp-note">Correct response: <em class="correct_response">' + info.correct + '</em></span>') + creditNote(ddCredit, wager));
            let takes = ddCredit ? (right ? ' That takes you to ' : ' That takes you down to ') + money(G.scores[who]) + '.' : ' No change in score on this one.';
            await say((right ? pick(HOST_RIGHT) + takes
                             : pick(HOST_WRONG) + ' The correct response: ' + info.phrase.toLowerCase() + ' ' + JPReader.responseToSpeech(info.abbrev) + '?' + takes), tok);
        }
        lightPodium(null);
        setHint('Click or press ' + anyKeyHtml() + ' to continue.');
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
        // The humans wager in turn (a table-mate looks away while the others type); online, everyone at once.
        let hIn = humans().filter(function(hm) { return G.scores[hm] > 0; });
        let hWager = { }, hAnswer = { };
        if (online()) {
            let me = G.online.me;
            if (hIn.indexOf(me) >= 0) {
                hWager[me] = await promptWager(0, G.scores[me], 'Final Jeopardy! — ' + fj.category.name, 'You have ' + money(G.scores[me]) + '. How much will you wager?' + standingsTable(true));
                if (!alive(tok)) return;
                JPOnline.send('fjwager', { amount: hWager[me] });
                podiumLine(me, 'wager locked in');
            }
            for (let hm of hIn) if (hm != me) {
                showPanel('<h1>Final Jeopardy! — ' + esc(fj.category.name) + '</h1><p>Waiting for <b>' + esc(hm) + '</b> to wager…</p>' + standingsTable(true));
                let ev = await fromPlayerOrForce('fjwager', hm, null, 75000, { amount: 0 });
                if (!alive(tok)) return;
                if (!ev) { onlineLost(); return; }
                hWager[hm] = clamp(Math.round(+ev.amount) || 0, 0, G.scores[hm]);
                podiumLine(hm, 'wager locked in');
            }
        } else for (let hm of hIn) {
            hWager[hm] = await promptWager(0, G.scores[hm], 'Final Jeopardy! — ' + fj.category.name,
                (hm == YOU ? 'You have ' : '<b>' + esc(hm) + '</b>, you have ') + money(G.scores[hm]) + '. How much will you wager?' + (humans().length > 1 ? ' <span class="jp-note">(the others look away)</span>' : '') + standingsTable(true));
            if (!alive(tok)) return;
            podiumLine(hm, 'wager locked in');
        }
        for (let hm of humans()) if (hIn.indexOf(hm) < 0) markOut(hm, true);
        let youIn = hIn.length > 0;
        if (!youIn) {
            showPanel('<h1>Final Jeopardy! — ' + esc(fj.category.name) + '</h1><p>' + (humans().length == 1 ? 'With ' + money(G.scores[YOU]) + ' you can\'t play' : 'With no money, nobody at the keyboard can play') + ' Final Jeopardy!, but you can still play along. Click or press ' + anyKeyHtml() + '.</p>').classList.add('jp-clickthrough');
            await pause(2500, tok);
            if (!alive(tok)) return;
        }
        for (let n in players) podiumLine(n, 'wager locked in');

        setHeader('Final Jeopardy!', fj.category.name, hIn.length == 1 ? 'wager ' + money(hWager[hIn[0]]) : '');
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
        if (online()) {
            // Everyone responds at once, on their own machine; the responses come over the channel and are judged alike everywhere.
            let me = G.online.me;
            if (hIn.indexOf(me) >= 0) {
                let a = await finalAnswer(fj, S.fjSeconds, tok, me);
                if (!alive(tok)) return;
                JPOnline.send('fjanswer', { got: a.got });
                hAnswer[me] = a;
            } else { setTimer(S.fjSeconds, 'green'); setHint('The others are writing their responses.'); await sleep(S.fjSeconds * 1000, tok); if (!alive(tok)) return; }
            JPAudio.stopLoop();
            for (let hm of hIn) if (hm != me) {
                setHint('Waiting for <b>' + esc(hm) + '</b>…');
                let ev = await fromPlayerOrForce('fjanswer', hm, null, 25000, { got: { typed: '', phrases: [ ], interim: '' } });
                if (!alive(tok)) return;
                if (!ev) { onlineLost(); return; }
                hAnswer[hm] = judgeFinal(fj, ev.got || { });
                podiumLine(hm, 'response locked in');
            }
        } else if (hIn.length == 1) {
            hAnswer[hIn[0]] = await finalAnswer(fj, S.fjSeconds, tok, hIn[0]);
            if (!alive(tok)) return;
        } else if (hIn.length > 1) {
            // Several humans: the music is thinking time; then each responds in turn.
            setTimer(S.fjSeconds, 'green');
            setHint('Think it over. When the music ends, ' + joinNatural(hIn.map(esc)) + ' respond in turn.');
            await pause(S.fjSeconds * 1000, tok);
            if (!alive(tok)) return;
            JPAudio.stopLoop();
            for (let hm of hIn) {
                hAnswer[hm] = await finalAnswer(fj, 15, tok, hm, { immediate: true });
                if (!alive(tok)) return;
            }
        } else {
            setTimer(S.fjSeconds, 'green');
            await pause(S.fjSeconds * 1000, tok);
            if (!alive(tok)) return;
        }
        JPAudio.stopLoop();
        clearTimer();

        // Reveal, lowest score first, you included.
        let inFinal = Object.keys(players).concat(hIn);
        let order = ranked(G.scores).filter(function(n) { return inFinal.indexOf(n) >= 0; }).reverse();
        showClue(fj.queryHtml.replace(/<a [^>]*>(.*?)<\/a>/g, '$1'), fjOpts);
        setSub('<span class="jp-note">The correct response:</span> <em class="correct_response">' + fj.correct + '</em>');
        await say('The correct response: ' + fj.phrase.toLowerCase() + ' ' + JPReader.responseToSpeech(fj.correct) + '?', tok);
        if (!alive(tok)) return;
        await pause(800, tok);
        if (!alive(tok)) return;
        for (let i = 0; i < order.length; i++) {
            let who = order[i];
            let isYou = isHuman(who);
            let ans = isYou ? (hAnswer[who] || { said: '', correct: false }) : null;
            let resp = isYou ? ans.said : players[who].response;
            let right = isYou ? ans.correct : players[who].right;
            let wager = isYou ? (hWager[who] || 0) : players[who].wager;
            let why = isYou ? '' : players[who].why;
            lightPodium(who);
            let place = ordinalPlace(placeOf(who, preScores));
            let lead = i == 0 ? 'Let\'s start with ' : i == order.length - 1 ? 'And finally, ' : 'Next, ';
            let intro = who == YOU ? lead + 'you, in ' + place + ' place with ' + money(preScores[who]) + '.'
                                   : lead + who + ', in ' + place + ' place with ' + money(preScores[who]) + '.';
            setSub('<span class="jp-who">' + esc(who) + '</span> <span class="jp-note">— ' + place + ' place, ' + money(preScores[who]) + '</span>');
            await say(intro, tok);
            if (!alive(tok)) return;
            setSub('<span class="jp-who">' + esc(who) + ' wrote:</span> ' + (resp ? esc(resp) : '<i>(nothing)</i>'));
            podiumLine(who, '<span class="' + (right ? 'jp-correct' : 'jp-incorrect') + '">' + (resp ? esc(resp) : '(nothing)') + '</span>');
            await say((who == YOU ? 'You wrote: ' : heShe(who).charAt(0).toUpperCase() + heShe(who).slice(1) + ' wrote: ') + (resp ? JPReader.responseToSpeech(resp) : 'nothing.'), tok);
            if (!alive(tok)) return;
            await pause(600, tok);
            if (!alive(tok)) return;
            setSub('<span class="jp-who">' + esc(who) + ' wrote:</span> ' + (resp ? esc(resp) : '<i>(nothing)</i>') + ' &nbsp; <span class="' + (right ? 'jp-correct' : 'jp-incorrect') + '">' + (right ? 'Correct!' : 'Sorry, no.') + '</span> &nbsp; wager ' + money(wager) +
                   (why ? '<div class="jp-clue-why">' + esc(why) + '</div>' : ''));
            await say(right ? 'That is correct!' : 'That is incorrect.', tok);
            if (!alive(tok)) return;
            if (isYou) {
                let fjRec = addResult({ kind: 'fj', round: 'FJ', category: fj.category.name, value: 0, amount: wager, who: who, said: resp, correct: JPJudge.stripHtml(fj.correct), outcome: right ? 'right' : 'wrong' });
                // The judge can be overruled here too (y/n), now or from the final screen; the standings and the saved game follow.
                if (!online()) setHint('Misjudged? <span class="jp-key">y</span> = ' + (who == YOU ? 'I was' : esc(who) + ' was') + ' right, <span class="jp-key">n</span> = wrong (also later: Edit results).');
                if (!online()) handlers.override = function(isRight) {
                    setOutcome(fjRec, isRight ? 'right' : 'wrong');
                    let ok = fjRec.outcome == 'right';
                    podiumLine(who, '<span class="' + (ok ? 'jp-correct' : 'jp-incorrect') + '">' + (resp ? esc(resp) : '(nothing)') + '</span>');
                    if (clueSubEl && clueSubEl.isConnected) setSub('<span class="jp-who">' + esc(who) + ' wrote:</span> ' + (resp ? esc(resp) : '<i>(nothing)</i>') + ' &nbsp; <span class="' + (ok ? 'jp-correct' : 'jp-incorrect') + '">' + (ok ? 'Correct!' : 'Sorry, no.') + '</span> &nbsp; wager ' + money(wager) + ' <span class="jp-note">(overruled)</span>');
                    if (U.stage.querySelector('.jp-again')) showFinalStandings();
                };
            }
            else adjustScore(who, right ? wager : -wager);
            let takes = (who == YOU ? 'That takes you ' : 'That takes ' + himHer(who) + ' ') + (right ? 'to ' : 'down to ') + money(G.scores[who]) + '.';
            await say((wager ? 'And the wager: ' + money(wager) + '. ' : 'No wager. ') + takes, tok);
            if (!alive(tok)) return;
            await pause(why ? 1600 : 900, tok);
            if (!alive(tok)) return;
        }
        lightPodium(null);
        (G.trajectory || (G.trajectory = [ ])).push({ num: null, round: 'FJ', label: 'Final Jeopardy!', scores: clone(G.scores) });
        // The verdict.
        let all = ranked(G.scores);
        let top = all.filter(function(n) { return G.scores[n] == G.scores[all[0]]; });
        let line = top.length > 1 ? 'And we have a tie at ' + money(G.scores[all[0]]) + ' between ' + joinNatural(top.map(function(n) { return n == YOU ? 'you' : n; })) + '!'
                 : all[0] == YOU ? 'And that makes you our champion, with ' + money(G.scores[YOU]) + '! Congratulations.'
                 : isHuman(all[0]) ? 'And that makes ' + all[0] + ' our champion, with ' + money(G.scores[all[0]]) + '! Congratulations, ' + all[0] + '.'
                 : 'And that makes ' + all[0] + ' our champion, with ' + money(G.scores[all[0]]) + '. Congratulations, ' + all[0] + '.';
        await say(line, tok);
    }

    // Final Jeopardy! answer. The music plays for the full time, but the
    // microphone isn't left open through it (people think out loud): you ring
    // in when you're ready to respond, say it, and the first real phrase is
    // locked in. Typing works throughout; Enter locks it in.
    // who: the human responding; opts.immediate skips the ring-in phase (the
    // thinking music has already played) and listens from the first moment.
    async function finalAnswer(fj, seconds, tok, who, opts) {
        who = who || YOU; opts = opts || { };
        let useSpeech = S.answerMode == 'speech' && JPAudio.recognitionSupported();
        let me = who == YOU ? '' : '<span class="jp-who">' + esc(who) + ':</span> ';
        let your = who == YOU ? 'your' : who + '\'s';
        showAnswerStrip(true, false);
        U.input.value = '';
        setTimer(seconds, 'green');
        let key = '<span class="jp-key">' + buzzKeyName(who) + '</span>';
        if (opts.immediate) setHint(me + (useSpeech ? 'Say ' + your + ' response now (or type it and press <span class="jp-key">Enter</span>).' : 'Type ' + your + ' response. <span class="jp-key">Enter</span> locks it in.'));
        else setHint(me + (useSpeech ? 'Think it over. When you\'re ready to respond, press ' + key + (mouseHuman() == who ? ' (or click)' : '') + ' and say it — or type it and press <span class="jp-key">Enter</span>.'
                                     : 'Type your response. <span class="jp-key">Enter</span> locks it in early.'));

        let got = await new Promise(function(resolve) {
            let done = false, listener = null, interim = '', phrases = [ ], stems = [ ], buzzed = false, timeUp = false;
            let deadline = JPClock.now() + seconds * 1000;
            function finish(typed, abort) {
                if (done) return;
                done = true;
                JPClock.clearTimeout(t);
                JPClock.off(onPauseFJ); JPClock.off(onResumeFJ);
                handlers.submit = null; handlers.buzz = null; handlers.inputBuzz = null;
                if (listener) { try { if (abort && listener.abort) listener.abort(); else listener.stop(); } catch (e) { } }
                resolve({ typed: (typed || '').trim(), phrases: phrases, interim: interim });
            }
            let t = JPClock.setTimeout(function() {
                timeUp = true;
                if (listener && useSpeech) { try { listener.stop(); } catch (e) { } setTimeout(function() { finish(U.input.value); }, 4000); }
                else finish(U.input.value);
            }, seconds * 1000);
            handlers.submit = function(text) { finish(text, true); };

            function heardSegment(seg) {
                if (!seg || !seg.length || JPJudge.contentFree(seg[0])) { if (seg && seg[0]) stems.push(seg[0]); return false; }
                let stem = stems.join(' ').trim();
                phrases = [ stem ? seg.map(function(a) { return stem + ' ' + a; }).concat(seg) : seg.slice() ];
                return true;
            }
            function attach(l) {
                listener = l;
                let seen = 0, before = stems.join(' ').trim();
                l.onInterim = function(text, gotFinal, segments) {
                    interim = (before + ' ' + text).trim();
                    U.heard.textContent = interim ? '“' + interim + '”' : '';
                    if (!gotFinal || !segments) return;
                    for (let seg of segments.slice(seen)) { seen++; if (heardSegment(seg)) { finish(U.input.value, true); return; } }
                };
                l.then(function(r) {
                    if (listener !== l || done) return;
                    for (let seg of (r.segments || [ ]).slice(seen)) { seen++; if (heardSegment(seg)) { finish(U.input.value, true); return; } }
                    if (timeUp) { finish(U.input.value); return; }
                    if (JPClock.paused) return;
                    if (r.error && r.error != 'no-speech' && r.error != 'aborted') { U.mic.className = 'jp-mic'; U.mic.textContent = 'Mic: ' + r.error + ' — type it'; return; }
                    let remaining = deadline - JPClock.now();
                    if (remaining > 600) startListening(remaining); else finish(U.input.value);
                });
            }
            function startListening(ms) { attach(JPAudio.listen(ms + 300, null, { endOnFinal: true })); }
            // Ringing in opens the mic; the music ducks underneath. Other
            // players' keys do nothing during one player's response.
            function ringIn(name) {
                if (buzzed || done || !useSpeech) return;
                if (name && name != who) return;
                buzzed = true;
                handlers.buzz = null; handlers.inputBuzz = null;
                if (!opts.immediate) { JPAudio.play('buzz'); JPAudio.duckLoop(true); }
                lightPodium(who);
                U.mic.className = 'jp-mic jp-listening'; U.mic.textContent = 'Listening…';
                setHint(me + 'Say ' + your + ' response (or type it and press <span class="jp-key">Enter</span>).');
                let remaining = deadline - JPClock.now();
                if (remaining > 300) startListening(remaining); else finish(U.input.value);
            }
            if (useSpeech && opts.immediate) ringIn(who);
            else if (useSpeech) { handlers.buzz = ringIn; handlers.inputBuzz = ringIn; }
            else lightPodium(who);
            function onPauseFJ() { if (listener) { let l = listener; listener = null; l.stop(); } }
            function onResumeFJ() {
                if (done || !buzzed) return;
                let remaining = deadline - JPClock.now();
                if (remaining > 300) startListening(remaining);
            }
            JPClock.onPause(onPauseFJ);
            JPClock.onResume(onResumeFJ);
        });
        if (!alive(tok)) return { said: '', correct: false, got: got };
        JPAudio.duckLoop(false);
        showAnswerStrip(false);
        let res = judgeFinal(fj, got);
        G.stats.answered++;
        if (res.correct) G.stats.correct++; else G.stats.wrong++;
        podiumLine(who, 'response locked in');
        return res;
    }
    // Judge a Final Jeopardy! response: the typed text, then the phrase heard (with its alternatives).
    function judgeFinal(fj, got) {
        got = { typed: String(got.typed || ''), phrases: Array.isArray(got.phrases) ? got.phrases : [ ], interim: String(got.interim || '') };
        let candidates = [ ];
        if (got.typed) candidates.push(got.typed);
        for (let i = got.phrases.length - 1; i >= 0; i--) for (let a of got.phrases[i]) candidates.push(a);
        if (!got.phrases.length && got.interim) candidates.push(got.interim);
        let heardLast = got.phrases.length ? got.phrases[got.phrases.length - 1][0] : got.interim;
        let verdict = JPJudge.judgeAny(candidates, fj.correct);
        let said = got.typed || (verdict.correct && verdict.text ? verdict.text : heardLast) || '';
        return { said: said, correct: !!verdict.correct, got: got };
    }

    // ================================================================ online play
    // Two or three people in different places play the same archive game.
    // Every client runs the same game script; only the inputs that decide the
    // game travel over the room's channel (who rang in first, what they said,
    // the pick, the wagers), and the room's host arbitrates the buzzer race and
    // speaks for anyone who has gone quiet. The service writes results and
    // ratings when the host reports the finished game. Nothing from the archive
    // page itself is sent anywhere: each player's browser has the page.
    const ONLINE_MATCH_SETTINGS = { contestantsOn: false, answerSeconds: 8, buzzWindowSeconds: 6, lockoutMs: 250, ddAnswerSeconds: 10, fjSeconds: 30, autoAdvanceMs: 1500, mediaCredit: 'half' };
    const ROOM_SETTING_KEYS = [ 'contestantsOn', 'difficulty', 'customMedian', 'customSpread', 'answerSeconds', 'buzzWindowSeconds', 'lockoutMs', 'ddAnswerSeconds', 'fjSeconds', 'mediaCredit', 'autoAdvanceMs' ];
    function online() { return !!(G && G.online); }
    function hostHere() { return online() && G.online.host; }
    function isMe(who) { return online() ? who == G.online.me : isHuman(who); }
    function onlineIdOf(who) { return online() ? (G.online.byName[who] || null) : null; }
    function onlineNameOf(uid) { return online() ? (G.online.byId[uid] || null) : null; }
    function onlineAvailable() { return typeof JPOnline !== 'undefined' && JPOnline.available() && !!(window.chrome && chrome.storage); }
    function roomSettingsFromS() { let o = { }; for (let k of ROOM_SETTING_KEYS) o[k] = S[k]; return o; }
    // To the room's game page; already on it, straight into the room (a hash change alone reloads nothing).
    function goToRoom(game, roomId) {
        if (+game == +gameId() && document.getElementById('live_btn')) { JPOnline.disconnect(); onlineLanding(roomId); }
        else location.href = 'showgame.php?game_id=' + game + '#jplive-room=' + roomId;
    }
    function modeLabel(mode) { return mode == 'ranked' ? 'Ranked match' : mode == 'unrated' ? 'Unrated match' : 'Custom lobby'; }

    // A message of `type` from `who` about this moment, or the host's word for
    // a player who has gone quiet. Followers wait longer than the host does,
    // since the host's forced message is what ends their wait; null means the
    // host is gone too.
    async function fromPlayerOrForce(type, who, pred, timeoutMs, forcedData) {
        let id = onlineIdOf(who), hostId = G.online.hostId;
        let match = function(p) { return (p.from == id || (p.forced && p.from == hostId && p.who == who)) && (!pred || pred(p)); };
        let wait = hostHere() ? (JPOnline.isPresent(id) ? timeoutMs : 1500) : timeoutMs + 12000;
        let ev = await JPOnline.waitFor(type, match, wait);
        if (ev) return ev;
        if (hostHere()) { let p = Object.assign({ forced: true, who: who }, forcedData || { }); JPOnline.send(type, p); return Object.assign({ from: hostId }, p); }
        return null;
    }
    // The host's connection is gone (or ours): the game can't go on.
    function onlineLost(why) {
        if (!online() || G.online.dead) return;
        G.online.dead = true;
        runToken++;
        JPAudio.stopSpeaking(); JPAudio.stopLoop();
        if (!G.recorded) { try { JPOnline.abandonRoom(G.online.room.id); } catch (e) { } }
        clearTimer(); showAnswerStrip(false);
        let panel = showPanel('<h1>Connection lost</h1><p>' + esc(why || 'The host of this game dropped off (or the connection did), so the game is over. Nothing is scored.') + '</p>' +
            '<p><button class="jp-btn jp-online-again">Play online again</button> <button class="jp-btn jp-secondary jp-cancel">Back to the page</button></p>');
        panel.querySelector('.jp-online-again').onclick = function() { JPOnline.disconnect(); G.online = null; loadSettings(); G.humans = humanNames(); G.scores = { }; for (let n of allPlayers()) G.scores[n] = 0; renderPodiums(); showSetup(); };
        panel.querySelector('.jp-cancel').onclick = function() { quitLive(); };
        setHint('');
    }
    function onlinePresence(present) {
        if (!online()) return;
        let hostId = G.online.hostId;
        if (!hostHere() && !present[hostId] && G.round && !G.recorded) {
            if (!G.online.hostGoneAt) G.online.hostGoneAt = Date.now();
            setTimeout(function() { if (online() && G.online.hostGoneAt && !JPOnline.isPresent(hostId)) onlineLost(); }, 12000);
        } else G.online.hostGoneAt = null;
        for (let p of G.online.players) {
            let nm = G.online.byId[p.user_id];
            let gone = !present[p.user_id];
            if (gone != !!G.online.gone[nm]) { G.online.gone[nm] = gone; let el = podium(nm); if (el) el.classList.toggle('jp-gone', gone); }
        }
    }

    // ---- the buzzer race, online: lights for everyone at one moment ----------------
    // Everyone reads the clue with their own voice, so the lights wait until every
    // client is done (ready), then the host names the moment (in its clock; the
    // clients synced theirs to it when they joined). Buzzes carry the offset from
    // that moment; the host takes the smallest one that arrives within a short
    // grace, against the archived contestants' reaction times when they play too.
    async function onlineLights(num, attempt, tok) {
        JPOnline.send('ready', { num: num, attempt: attempt });
        let at;
        if (hostHere()) {
            let need = G.online.players.map(function(p) { return p.user_id; }).filter(function(id) { return id != G.online.myId && JPOnline.isPresent(id); });
            let deadline = Date.now() + 20000;
            while (need.length && Date.now() < deadline && alive(tok)) {
                let ev = await JPOnline.waitFor('ready', function(p) { return p.num == num && p.attempt == attempt && need.indexOf(p.from) >= 0; }, deadline - Date.now());
                if (!ev) break;
                need.splice(need.indexOf(ev.from), 1);
                need = need.filter(function(id) { return JPOnline.isPresent(id); });
            }
            if (!alive(tok)) return null;
            at = JPOnline.hostNow() + 500;
            JPOnline.send('lights', { num: num, attempt: attempt, at: at });
        } else {
            setHint('Waiting for the others…');
            let ev = await JPOnline.waitFor('lights', function(p) { return p.num == num && p.attempt == attempt; }, 75000);
            if (!alive(tok)) return null;
            if (!ev) { onlineLost(); return null; }
            at = ev.at;
        }
        let wait = at - JPOnline.hostNow();
        if (wait > 0) await new Promise(function(r) { setTimeout(r, wait); });
        return alive(tok) ? at : null;
    }
    async function raceOnline(tok, contestant, windowMs, userAllowed, getLock, setLock, mult) {
        let num = G.current.num, attempt = ++G.online.attempt;
        let at = await onlineLights(num, attempt, tok);
        if (at == null) return { type: 'timeout', lost: true };
        setLit(true); JPAudio.play('lights');
        setTimer(S.buzzWindowSeconds, 'green');
        setHint(hostHere() || true ? 'Ring in: ' + ringInHint() + '.' : '');
        let me = G.online.me;
        return new Promise(function(resolve) {
            let done = false, timers = [ ], offs = [ ], cands = [ ], scheduled = false;
            function finish(ev) { if (done) return; done = true; timers.forEach(clearTimeout); offs.forEach(function(f) { f(); }); handlers.buzz = null; resolve(ev); }
            function candidate(c) { cands.push(c); if (!scheduled) { scheduled = true; timers.push(setTimeout(resolveNow, 250)); } }
            function resolveNow() {
                if (done) return;
                cands.sort(function(a, b) { return a.off - b.off; });
                let c = cands[0];
                if (!c) { JPOnline.send('buzzwin', { num: num, attempt: attempt, type: 'timeout' }); finish({ type: 'timeout' }); return; }
                JPOnline.send('buzzwin', { num: num, attempt: attempt, type: c.type, who: c.who, right: c.right, off: c.off });
                finish(c.type == 'user' ? { type: 'user', who: c.who } : { type: 'contestant', who: c.who, right: c.right, t: c.off });
            }
            handlers.buzz = function(who) {
                who = me;
                let now = JPClock.now();
                if (now < getLock(who)) { setLock(who, now + S.lockoutMs); G.stats.lockouts++; hstat(who, 'lockouts'); JPAudio.play('lockout'); flashLocked(); return; }
                if (!userAllowed(who)) return;
                let off = Math.max(0, JPOnline.hostNow() - at);
                if (hostHere()) candidate({ type: 'user', who: who, off: off });
                else JPOnline.send('buzz', { num: num, attempt: attempt, off: off });
            };
            if (hostHere()) {
                if (contestant) { let t = clamp(reaction(mult), 60, windowMs - 30); timers.push(setTimeout(function() { candidate({ type: 'contestant', who: contestant.who, right: contestant.right, off: t }); }, t)); }
                timers.push(setTimeout(resolveNow, windowMs));
                let take = function(p) { if (p.num != num || p.attempt != attempt) return; let who = onlineNameOf(p.from); if (!who || !userAllowed(who)) return; candidate({ type: 'user', who: who, off: Math.max(0, +p.off || 0) }); };
                for (let p of JPOnline.drain('buzz', function(p) { return p.num == num && p.attempt == attempt; })) take(p);
                offs.push(JPOnline.on('buzz', take));
            } else {
                JPOnline.waitFor('buzzwin', function(p) { return p.num == num && p.attempt == attempt; }, windowMs + 8000).then(function(p) {
                    if (!p) { finish({ type: 'timeout', lost: true }); return; }
                    finish(p.type == 'user' ? { type: 'user', who: p.who } : p.type == 'contestant' ? { type: 'contestant', who: p.who, right: p.right, t: p.off } : { type: 'timeout' });
                });
            }
        });
    }
    // After each clue the host's standings are the standings.
    function onlineScoresSync() {
        return JPOnline.on('scores', function(p) {
            if (!online() || hostHere()) return;
            if (G.online.lastScoresNum != null && p.num < G.online.lastScoresNum) return;
            G.online.lastScoresNum = p.num;
            let changed = false;
            for (let n in p.scores) if (G.scores[n] !== p.scores[n]) { G.scores[n] = p.scores[n]; changed = true; }
            if (changed) { for (let n in G.scores) { let el = podium(n); if (el) { let sc = el.querySelector('.jp-pscore'); if (sc) { sc.textContent = money(G.scores[n]); sc.classList.toggle('jp-neg', G.scores[n] < 0); } } } }
        });
    }
    // The finished game: the host reports it; everyone learns the ratings.
    async function finishOnline(tok) {
        let results = humans().map(function(hm) {
            let e = gameEntry({ }, hm);
            return { user_id: onlineIdOf(hm), score: e.score, coryat: e.coryat, place: e.place, won: e.won, answered: e.answered, correct: e.correct, dd: e.dd, fj: e.fj,
                     opponents: humans().filter(function(x) { return x != hm; }).map(function(x) { return { name: x, score: G.scores[x] }; }).concat(e.contestants) };
        });
        let deltas = null;
        if (hostHere()) {
            try { deltas = await JPOnline.finishRoom(G.online.room.id, results); } catch (e) { deltas = { error: e.message }; }
            JPOnline.send('finished', { deltas: deltas });
        } else {
            setHint('Waiting for the final word…');
            let ev = await JPOnline.waitFor('finished', null, 30000);
            deltas = ev ? ev.deltas : null;
        }
        if (!alive(tok)) return;
        G.online.deltas = deltas;
        try { await JPOnline.loadProfile(); } catch (e) { }
    }
    function ratingLine() {
        if (!online() || !G.online.deltas) return '';
        let d = G.online.deltas[G.online.myId];
        if (G.online.deltas.error) return '<p class="jp-note">The service could not record this game: ' + esc(G.online.deltas.error) + '</p>';
        if (!d) return G.online.mode == 'ranked' ? '' : '<p class="jp-note">' + modeLabel(G.online.mode) + ' — no rating change.</p>';
        return '<p><b>Your rating: ' + d.before + ' → ' + d.after + ' (' + (d.delta >= 0 ? '+' : '') + d.delta + ')</b>' + (JPOnline.profile ? ' <span class="jp-note">· average Coryat in ranked play ' + money(JPOnline.profile.ranked_games ? Math.round(JPOnline.profile.ranked_coryat_sum / JPOnline.profile.ranked_games) : 0) + ' over ' + JPOnline.profile.ranked_games + ' game' + (JPOnline.profile.ranked_games == 1 ? '' : 's') + '</span>' : '') + '</p>';
    }

    // ---- getting into a game -------------------------------------------------------
    // The room is known (a match from the queue, or a lobby the host started):
    // everyone lands on the game's page with #jplive-room=<id>, joins the
    // channel, and the host starts the game once everyone is there.
    async function onlineLanding(roomId) {
        try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { }
        await JPOnline.init();
        let st = null;
        if (JPOnline.signedIn) { try { st = await JPOnline.roomState(roomId); } catch (e) { } }
        if (!document.getElementById('live_btn') && st && st.room && st.room.archive_game_id == +gameId()) {
            // Not a playable page (the archive has no such game, or no board): the host picks another game.
            if (st.room.host == JPOnline.user.id && st.room.mode != 'custom') {
                try { let g = await JPOnline.reroll(roomId); location.href = 'showgame.php?game_id=' + g + '#jplive-room=' + roomId; } catch (e) { }
            } else {
                for (let i = 0; i < 40; i++) { await new Promise(function(r) { setTimeout(r, 3000); }); try { let s2 = await JPOnline.roomState(roomId); if (s2 && s2.room.archive_game_id != st.room.archive_game_id) { location.href = 'showgame.php?game_id=' + s2.room.archive_game_id + '#jplive-room=' + roomId; return; } } catch (e) { } }
            }
            return;
        }
        if (!document.getElementById('live_btn')) return;
        startLiveGame();
        if (!JPOnline.signedIn) { showOnlineSignIn(function() { onlineLanding(roomId); }, 'This is an online game. Sign in to join it.'); return; }
        if (!st || !st.room) { showPanel('<h1>No such game</h1><p>This game\'s room is gone (or you are not one of its players).</p><p><button class="jp-btn jp-cancel">Back</button></p>').querySelector('.jp-cancel').onclick = function() { showSetup(); }; return; }
        if (st.room.archive_game_id != +gameId()) { location.href = 'showgame.php?game_id=' + st.room.archive_game_id + '#jplive-room=' + roomId; return; }
        if (st.room.status == 'done' || st.room.status == 'abandoned') { showPanel('<h1>That game is over</h1><p>This room has already finished.</p><p><button class="jp-btn jp-cancel">Back</button></p>').querySelector('.jp-cancel').onclick = function() { showSetup(); }; return; }
        await showOnlineWaiting(st);
    }
    async function showOnlineWaiting(st) {
        let room = st.room, tok = ++runToken;
        setHeader(modeLabel(room.mode), gameTitle(), '');
        let panel = showPanel('<h1>' + esc(modeLabel(room.mode)) + '</h1><p class="jp-online-status">Joining the game…</p><div class="jp-online-players"></div><p><button class="jp-btn jp-secondary jp-cancel">Leave</button></p>');
        panel.querySelector('.jp-cancel').onclick = function() { JPOnline.disconnect(); try { if (room.host == JPOnline.user.id && room.mode != 'custom') JPOnline.abandonRoom(room.id); else JPOnline.leaveRoom(room.id); } catch (e) { } G.online = null; loadSettings(); showSetup(); };
        // Set the game up (players, settings) so the podiums show who's coming.
        loadSettings();
        let overlay = room.mode == 'custom' ? Object.assign({ }, room.settings || { }) : Object.assign({ }, ONLINE_MATCH_SETTINGS);
        for (let k in overlay) if (ROOM_SETTING_KEYS.indexOf(k) >= 0) S[k] = overlay[k];
        S.answerMode = S.micMode == 'off' ? 'typed' : 'speech';
        let taken = archiveNames(), byId = { }, byName = { }, names = [ ];
        for (let p of st.players) { let nm = p.name; while (taken.indexOf(nm) >= 0 || names.indexOf(nm) >= 0) nm += ' 2'; names.push(nm); byId[p.user_id] = nm; byName[nm] = p.user_id; }
        G.online = { room: room, players: st.players, mode: room.mode, hostId: room.host, host: room.host == JPOnline.user.id, me: byId[JPOnline.user.id], myId: JPOnline.user.id, byId: byId, byName: byName, names: names, attempt: 0, gone: { }, overlay: overlay };
        G.humans = names; G.scores = { }; for (let n of allPlayers()) G.scores[n] = 0; renderPodiums();
        let players = function(present) {
            return '<table class="jp-standings jp-inline">' + st.players.map(function(p) { let here = present && present[p.user_id]; return '<tr><td>' + esc(byId[p.user_id]) + (p.user_id == room.host ? ' <span class="jp-note">(host)</span>' : '') + (p.user_id == JPOnline.user.id ? ' <span class="jp-note">(you)</span>' : '') + '</td><td>' + (here ? '<span class="jp-plus">here</span>' : '<span class="jp-note">not yet…</span>') + '</td></tr>'; }).join('') + '</table>';
        };
        try { await JPOnline.connect(room.id, room.host, function(present) { onlinePresence(present); let pl = panel.querySelector('.jp-online-players'); if (pl && pl.isConnected) pl.innerHTML = players(present); }); }
        catch (e) { panel.querySelector('.jp-online-status').textContent = 'Could not join the game: ' + e.message; return; }
        if (!alive(tok)) return;
        panel.querySelector('.jp-online-status').innerHTML = hostHere() ? 'Waiting for everyone to arrive. The game starts on its own when they have.' : 'Waiting for the host to start the game…';
        panel.querySelector('.jp-online-players').innerHTML = players(JPOnline.presence());
        let unsub = onlineScoresSync();
        G.online.unsub = unsub;
        await JPOnline.syncClock();
        let all = st.players.map(function(p) { return p.user_id; });
        if (hostHere()) {
            let deadline = Date.now() + (room.mode == 'custom' ? 120000 : 75000);
            while (alive(tok) && Date.now() < deadline && !all.every(function(id) { return JPOnline.isPresent(id); })) await new Promise(function(r) { setTimeout(r, 500); });
            if (!alive(tok)) return;
            let missing = all.filter(function(id) { return !JPOnline.isPresent(id); });
            if (missing.length && room.mode == 'ranked') {
                JPOnline.send('abort', { reason: 'A player never arrived, so this ranked match is off. Nothing is scored.' });
                try { await JPOnline.abandonRoom(room.id); } catch (e) { }
                onlineLost('A player never arrived, so this ranked match is off. Nothing is scored.');
                return;
            }
            for (let i = 3; i > 0; i--) { panel.querySelector('.jp-online-status').innerHTML = 'Everyone\'s here. Starting in ' + i + '…'; JPOnline.send('countdown', { n: i }); await new Promise(function(r) { setTimeout(r, 1000); }); if (!alive(tok)) return; }
            JPOnline.send('start', { at: JPOnline.hostNow() });
            startGame();
        } else {
            let offC = JPOnline.on('countdown', function(p) { let s = panel.querySelector('.jp-online-status'); if (s && s.isConnected) s.innerHTML = 'Everyone\'s here. Starting in ' + p.n + '…'; });
            let ev = await Promise.race([ JPOnline.waitFor('start', null, 600000), JPOnline.waitFor('abort', null, 600000) ]);
            offC();
            if (!alive(tok)) return;
            if (!ev) { onlineLost('The host never started the game.'); return; }
            if (ev.t == 'abort') { onlineLost(ev.reason); return; }
            startGame();
        }
    }

    // ---- the account box and the online menu on the setup screen ------------------
    function accountBox() {
        if (!onlineAvailable()) return '';
        if (!JPOnline.signedIn) {
            return '<div class="jp-online-box"><b>Play online</b> — against friends in a lobby, or anyone in a ranked or unrated match. <button class="jp-btn jp-secondary jp-signin" style="padding:3px 10px;font-size:0.9em">Sign in</button> <button class="jp-btn jp-secondary jp-signup" style="padding:3px 10px;font-size:0.9em">Create an account</button></div>';
        }
        let p = JPOnline.profile || { name: '?' };
        let rated = p.ranked_games ? ' · rating <b>' + p.elo + '</b> · average Coryat ' + money(Math.round(p.ranked_coryat_sum / p.ranked_games)) + ' over ' + p.ranked_games + ' ranked game' + (p.ranked_games == 1 ? '' : 's') : ' · unrated so far';
        return '<div class="jp-online-box">Signed in as <b>' + esc(p.name) + '</b>' + rated + ' <button class="jp-btn jp-secondary jp-signout" style="padding:2px 8px;font-size:0.85em">Sign out</button> <button class="jp-btn jp-secondary jp-delete-acct" style="padding:2px 8px;font-size:0.85em;opacity:0.7" title="Remove the account and everything kept with it">Delete account</button>' +
            '<div class="jp-online-row"><button class="jp-btn jp-ranked">Ranked match</button> <button class="jp-btn jp-unrated">Unrated match</button> <button class="jp-btn jp-secondary jp-lobby">Create a lobby</button> ' +
            '<span class="jp-join-wrap"><input class="jp-join-code" placeholder="lobby code" maxlength="6" style="width:7em;min-width:7em;text-transform:uppercase"> <button class="jp-btn jp-secondary jp-join">Join</button></span> <button class="jp-btn jp-secondary jp-leaderboard">Leaderboard</button></div>' +
            '<div class="jp-note">Matches are three players, no archive contestants, the same timing for everyone (' + ONLINE_MATCH_SETTINGS.buzzWindowSeconds + ' s to ring in, ' + ONLINE_MATCH_SETTINGS.answerSeconds + ' s to respond); ranked ones move your rating (by finishing place) and your average Coryat. A lobby plays this page\'s game with your settings, contestants and all, for two or three of you.</div></div>';
    }
    function bindAccountBox(panel, back) {
        let q = function(sel) { return panel.querySelector(sel); };
        let b;
        if ((b = q('.jp-signin'))) b.onclick = function() { showOnlineSignIn(back, null, 'in'); };
        if ((b = q('.jp-signup'))) b.onclick = function() { showOnlineSignIn(back, null, 'up'); };
        if ((b = q('.jp-signout'))) b.onclick = async function() { await JPOnline.signOut(); back(); };
        if ((b = q('.jp-delete-acct'))) b.onclick = async function() { if (!confirm('Delete your account? Your name, results and ratings on the service are removed for good. (The games saved on this computer stay.)')) return; try { await JPOnline.deleteAccount(); } catch (e) { alert(e.message); } back(); };
        if ((b = q('.jp-ranked'))) b.onclick = function() { showQueue('ranked'); };
        if ((b = q('.jp-unrated'))) b.onclick = function() { showQueue('unrated'); };
        if ((b = q('.jp-lobby'))) b.onclick = async function() { try { let st = await JPOnline.createRoom(+gameId(), roomSettingsFromS()); showLobby(st); } catch (e) { alert('Could not create the lobby: ' + e.message); } };
        if ((b = q('.jp-join'))) b.onclick = async function() { let code = (q('.jp-join-code').value || '').trim().toUpperCase(); if (code.length < 4) { q('.jp-join-code').focus(); return; } try { let st = await JPOnline.joinRoom(code); showLobby(st); } catch (e) { alert(e.message); } };
        let jc = q('.jp-join-code');
        if (jc) jc.addEventListener('keydown', function(e) { if (e.key == 'Enter') { e.preventDefault(); q('.jp-join').click(); } e.stopPropagation(); });
        if ((b = q('.jp-leaderboard'))) b.onclick = function() { showLeaderboard(back); };
    }
    // mode: 'in' | 'up'
    function showOnlineSignIn(back, note, mode) {
        mode = mode || 'in';
        let panel = showPanel('<h1>' + (mode == 'up' ? 'Create an account' : 'Sign in') + '</h1>' + (note ? '<p>' + esc(note) + '</p>' : '') +
            '<div class="jp-form-col">' +
            (mode == 'up' ? '<label>Display name <input class="jp-acct-name" maxlength="20" placeholder="what the others see"></label>' : '') +
            '<label>Email <input class="jp-acct-email" type="email" autocomplete="email"></label>' +
            '<label>Password <input class="jp-acct-pw" type="password" autocomplete="' + (mode == 'up' ? 'new-password' : 'current-password') + '"></label>' +
            '<div class="jp-acct-err jp-minus"></div>' +
            '<p><button class="jp-btn jp-acct-go">' + (mode == 'up' ? 'Create the account' : 'Sign in') + '</button> <button class="jp-btn jp-secondary jp-acct-swap">' + (mode == 'up' ? 'I have an account' : 'Create an account instead') + '</button> <button class="jp-btn jp-secondary jp-cancel">Back</button></p>' +
            '<p class="jp-note">' + (mode == 'up' ? 'Your name shows to other players and on the leaderboard. Your email is only for signing in; nothing is sent to it.' : '') + ' Your results (scores, Coryat, which games you\'ve played) are kept with the account so matchmaking never hands you a game you\'ve played.</p></div>');
        let q = function(sel) { return panel.querySelector(sel); };
        let go = async function() {
            let err = q('.jp-acct-err'); err.textContent = '';
            let email = q('.jp-acct-email').value.trim(), pw = q('.jp-acct-pw').value;
            q('.jp-acct-go').disabled = true;
            try {
                if (mode == 'up') await JPOnline.signUp(email, pw, q('.jp-acct-name').value.trim());
                else await JPOnline.signIn(email, pw);
                await syncOnline();
                back();
            } catch (e) { err.textContent = e.message; q('.jp-acct-go').disabled = false; }
        };
        q('.jp-acct-go').onclick = go;
        panel.querySelectorAll('input').forEach(function(inp) { inp.addEventListener('keydown', function(e) { if (e.key == 'Enter') { e.preventDefault(); go(); } e.stopPropagation(); }); });
        q('.jp-acct-swap').onclick = function() { showOnlineSignIn(back, note, mode == 'up' ? 'in' : 'up'); };
        q('.jp-cancel').onclick = back;
        setTimeout(function() { let f = q(mode == 'up' ? '.jp-acct-name' : '.jp-acct-email'); if (f) f.focus(); }, 0);
        setHint('');
    }
    // Your saved games go up to the account; the games you've played anywhere come down.
    async function syncOnline() {
        if (!onlineAvailable() || !JPOnline.signedIn) return;
        try { chrome.storage.local.get([ 'jpLiveMaxGame' ], function(o) { let m = Math.max(+(o && o.jpLiveMaxGame) || 0, +gameId() || 0); if (m) JPOnline.noteMaxGame(m); }); } catch (e) { }
        try {
            let mine = loadScores().filter(function(e) { return entryPlayer(e) == YOU && !e.online; });
            let ids = await JPOnline.syncUp(mine);
            if (typeof JPPlayed !== 'undefined' && ids && ids.length) JPPlayed.importIds(ids);
        } catch (e) { }
    }
    function showQueue(mode) {
        let tok = ++runToken, t0 = Date.now(), stopped = false;
        let panel = showPanel('<h1>' + esc(modeLabel(mode)) + '</h1><p class="jp-online-status">Looking for two more players…</p><p class="jp-note jp-queue-time"></p>' +
            '<p class="jp-note">You\'ll be sent to the game\'s page when three are found; keep this tab open. ' + (mode == 'ranked' ? 'Ranked: your rating moves with your finishing place, and your average Coryat counts.' : 'Unrated: nothing counts but bragging rights.') + '</p>' +
            '<p><button class="jp-btn jp-secondary jp-cancel">Cancel</button></p>');
        panel.querySelector('.jp-cancel').onclick = async function() { stopped = true; try { await JPOnline.dequeue(); } catch (e) { } showSetup(); };
        (async function() {
            try { await JPOnline.enqueue(mode); } catch (e) { panel.querySelector('.jp-online-status').textContent = 'Could not join the queue: ' + e.message; return; }
            while (!stopped && alive(tok)) {
                let s = Math.round((Date.now() - t0) / 1000);
                let tt = panel.querySelector('.jp-queue-time'); if (tt) tt.textContent = 'Waiting ' + Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
                let roomId = null;
                try { roomId = await JPOnline.matchMe(); } catch (e) { }
                if (roomId) {
                    stopped = true;
                    let st = null; try { st = await JPOnline.roomState(roomId); } catch (e) { }
                    try { await JPOnline.dequeue(); } catch (e) { }
                    if (st && st.room) { panel.querySelector('.jp-online-status').textContent = 'Match found! Off to the game…'; goToRoom(st.room.archive_game_id, roomId); }
                    return;
                }
                await new Promise(function(r) { setTimeout(r, 2500); });
            }
        })();
        setHint('');
    }
    function showLobby(st) {
        let tok = ++runToken, room = st.room, host = room.host == JPOnline.user.id, stopped = false;
        let link = 'https://j-archive.com/showgame.php?game_id=' + room.archive_game_id + '#jplive-join=' + room.code;
        let render = function(st) {
            let players = st.players.map(function(p) { return '<tr><td>' + esc(p.name) + (p.user_id == st.room.host ? ' <span class="jp-note">(host)</span>' : '') + '</td><td class="jp-note">' + (p.ranked_games ? 'rating ' + p.elo : 'unrated') + '</td></tr>'; }).join('');
            let s = st.room.settings || { };
            let summary = (s.contestantsOn === false ? 'no archive contestants' : 'with the archive contestants (' + (DIFFICULTY[s.difficulty] ? DIFFICULTY[s.difficulty].label.replace(/ \(.*$/, '') : s.difficulty) + ')') + ' · ' + s.buzzWindowSeconds + ' s to ring in · ' + s.answerSeconds + ' s to respond';
            return '<h1>Lobby ' + esc(st.room.code) + '</h1>' +
                '<p>Game: <b>' + esc(st.room.archive_game_id == +gameId() ? gameTitle() : 'archive game ' + st.room.archive_game_id) + '</b> · ' + esc(summary) + '</p>' +
                '<p>Invite: tell them the code <b style="font-size:1.4em;letter-spacing:0.1em">' + esc(st.room.code) + '</b> (Join on their setup screen), or send this link: <input class="jp-invite" readonly value="' + esc(link) + '" style="width:100%;min-width:20em"></p>' +
                '<table class="jp-standings jp-inline">' + players + '</table>' +
                '<p class="jp-online-status jp-note">' + (host ? (st.players.length >= 2 ? 'Ready when you are.' : 'Waiting for at least one more player…') : 'Waiting for ' + esc((st.players.find(function(p) { return p.user_id == st.room.host; }) || { }).name || 'the host') + ' to start the game…') + '</p>' +
                '<p>' + (host ? '<button class="jp-btn jp-start-room"' + (st.players.length >= 2 ? '' : ' disabled') + '>Start the game</button> <button class="jp-btn jp-secondary jp-room-settings">Settings</button> ' : '') + '<button class="jp-btn jp-secondary jp-cancel">Leave</button></p>' +
                (host ? '<p class="jp-note">The lobby plays this page\'s game with your current settings (contestants, speed, timing); Settings changes them for everyone. Voices and microphones stay each player\'s own.</p>' : '');
        };
        let panel = showPanel(render(st));
        let bind = function() {
            let q = function(sel) { return panel.querySelector(sel); };
            q('.jp-cancel').onclick = async function() { stopped = true; try { await JPOnline.leaveRoom(room.id); } catch (e) { } showSetup(); };
            let sr = q('.jp-start-room');
            if (sr) sr.onclick = async function() { try { let s2 = await JPOnline.startRoom(room.id); stopped = true; goToRoom(s2.room.archive_game_id, room.id); } catch (e) { alert(e.message); } };
            let rs = q('.jp-room-settings');
            if (rs) rs.onclick = function() {
                let form = showPanel('<h1>Lobby settings</h1>' + settingsForm() + '<p><button class="jp-btn jp-back">Back to the lobby</button></p>');
                bindSettingsForm(form);
                form.querySelector('.jp-back').onclick = async function() { try { let s3 = await JPOnline.setRoom(room.id, +gameId(), roomSettingsFromS()); panel = showPanel(render(s3)); bind(); } catch (e) { alert(e.message); } };
            };
            let inv = q('.jp-invite'); if (inv) inv.onclick = function() { inv.select(); };
        };
        bind();
        (async function() {
            while (!stopped && alive(tok)) {
                await new Promise(function(r) { setTimeout(r, 2500); });
                if (stopped || !alive(tok)) return;
                let s2 = null; try { s2 = await JPOnline.roomState(room.id); } catch (e) { }
                if (!s2 || !s2.room) { if (!stopped) { showPanel('<h1>The lobby closed</h1><p>The host left.</p><p><button class="jp-btn jp-cancel">Back</button></p>').querySelector('.jp-cancel').onclick = function() { showSetup(); }; } return; }
                if (s2.room.status == 'playing') { stopped = true; goToRoom(s2.room.archive_game_id, room.id); return; }
                if (s2.room.status == 'abandoned') { stopped = true; showPanel('<h1>The lobby closed</h1><p>The host left.</p><p><button class="jp-btn jp-cancel">Back</button></p>').querySelector('.jp-cancel').onclick = function() { showSetup(); }; return; }
                if (JSON.stringify(s2.players) != JSON.stringify(st.players) || JSON.stringify(s2.room.settings) != JSON.stringify(st.room.settings)) { st = s2; if (!panel.querySelector('.jp-form')) { panel = showPanel(render(st)); bind(); } }
            }
        })();
        setHint('');
    }
    async function showLeaderboard(back) {
        let panel = showPanel('<h1>Leaderboard</h1><p class="jp-note">Loading…</p><p><button class="jp-btn jp-back">Back</button></p>');
        panel.querySelector('.jp-back').onclick = back;
        let rows = [ ];
        try { rows = await JPOnline.leaderboard(); } catch (e) { }
        if (!panel.isConnected) return;
        let me = JPOnline.user ? JPOnline.user.id : '';
        let html = rows.length ? '<table class="jp-results jp-scores"><tr><th>#</th><th>Player</th><th>Rating</th><th>Ranked games</th><th>1st / 2nd / 3rd</th><th>Average Coryat</th><th>Best Coryat</th></tr>' +
            rows.map(function(r, i) { return '<tr' + (r.id == me ? ' class="jp-you"' : '') + '><td class="jp-num">' + (i + 1) + '</td><td>' + esc(r.name) + '</td><td class="jp-num">' + r.elo + '</td><td class="jp-num">' + r.ranked_games + '</td><td class="jp-num">' + r.ranked_firsts + ' / ' + r.ranked_seconds + ' / ' + r.ranked_thirds + '</td><td class="jp-num">' + (r.avg_coryat == null ? '—' : money(r.avg_coryat)) + '</td><td class="jp-num">' + (r.best_coryat == null ? '—' : money(r.best_coryat)) + '</td></tr>'; }).join('') + '</table>'
            : '<p class="jp-note">Nobody has finished a ranked match yet.</p>';
        panel.innerHTML = '<h1>Leaderboard</h1>' + html + '<p class="jp-note">Rating: Elo by finishing place in ranked matches (everyone starts at 1200). Average Coryat: regular-clue money per ranked game.</p><p><button class="jp-btn jp-back">Back</button></p>';
        panel.querySelector('.jp-back').onclick = back;
    }

    // ------------------------------------------------------------ results

    // inline: a compact version with a heading, for the wager screens.
    function standingsTable(inline) {
        let names = ranked(G.scores);
        let rows = names.map(function(n) {
            return '<tr' + (isHuman(n) ? ' class="jp-you"' : '') + '><td>' + esc(n) + '</td><td class="jp-num">' + money(G.scores[n]) + '</td></tr>';
        }).join('');
        return (inline ? '<div class="jp-note" style="margin-top:0.8em">Standings</div>' : '') + '<table class="jp-standings' + (inline ? ' jp-inline' : '') + '">' + rows + '</table>';
    }

    // Read-only view of the game state, for debugging in the console
    // (e.g. jpLiveDebug.state.scores) and for automated tests.
    window.jpLiveDebug = { get state() { return G; }, get settings() { return S; }, parsePick: parsePick, parseWager: parseWager, coryatScore: coryatScore, standingsSentence: standingsSentence, roundOpeningLine: roundOpeningLine, showFinalStandings: showFinalStandings, rewindTo: rewindTo, clueInfo: clueInfo, mediaClue: mediaClue };

    // ---- high scores (this browser; kept in localStorage for j-archive.com) ----
    function loadScores() { try { return JSON.parse(localStorage.getItem('jpLiveScores') || '[]'); } catch (e) { return [ ]; } }
    function saveScores(list) { try { localStorage.setItem('jpLiveScores', JSON.stringify(list.slice(-300))); } catch (e) { } }
    function gameTitle() { return document.title.replace(/^J! Archive - /, ''); }
    function gameId() { let m = location.search.match(/game_id=(\d+)/); return m ? m[1] : ''; }
    // The Coryat score: your regular-clue money -- right responses add the
    // clue's value, wrong ones take it away; a Daily Double counts at the clue's
    // face value when right and costs nothing when wrong; Final Jeopardy! is
    // left out. The standard yardstick for playing along at home.
    // A human's responses so far (records without a name are yours: single-player games).
    function humanRecs(who) { who = who || YOU; return (G.results || [ ]).filter(function(r) { return (r.who || YOU) == who; }); }
    function coryatScore(who) {
        let c = 0;
        who = who || YOU;
        if (isHuman(who)) {
            for (let r of humanRecs(who)) {
                if (r.kind == 'clue') c += r.outcome == 'right' ? r.value : r.outcome == 'wrong' ? -r.value : 0;
                else if (r.kind == 'dd' && r.outcome == 'right') c += r.value;
            }
        } else {
            for (let r of (G.cresults || [ ])) if (r.who == who) c += r.dd ? (r.right ? r.value : 0) : (r.right ? r.value : -r.value);
        }
        return c;
    }
    // The score of every player after each clue, for the game-dynamics chart.
    function recordTrajectory(num) {
        if (!G.trajectory) G.trajectory = [ ];
        let info = null; try { info = clueInfo(num); } catch (e) { }
        G.trajectory.push({ num: num, round: G.round, label: info ? info.category.name + ' ' + money(info.value) + (info.dd ? ' (DD)' : '') : String(num), scores: clone(G.scores) });
    }
    // One saved game per human at the keyboard; `player` names them (an
    // entry without one is from before multiplayer, and is yours).
    function gameEntry(base, who) {
        who = who || YOU;
        let st = G.stats, names = ranked(G.scores), recs = humanRecs(who), h = (G.hstats || { })[who] || { };
        let dds = recs.filter(function(r) { return r.kind == 'dd'; }), fj = recs.find(function(r) { return r.kind == 'fj'; });
        let others = humans().filter(function(hm) { return hm != who; });
        return Object.assign(base || { }, {
            player: who, score: G.scores[who], place: names.indexOf(who) + 1, won: names.length > 1 && names[0] == who && G.scores[who] > 0, coryat: coryatScore(who),
            dd: { n: dds.length, right: dds.filter(function(r) { return r.outcome == 'right'; }).length, wagers: dds.reduce(function(a, r) { return a + (r.amount || 0); }, 0) },
            fj: fj ? { played: 1, right: fj.outcome == 'right' ? 1 : 0, wager: fj.amount || 0 } : { played: 0, right: 0, wager: 0 },
            answered: recs.length, correct: recs.filter(function(r) { return r.outcome == 'right'; }).length, clues: st.clues, buzzWins: h.buzzWins || 0,
            difficulty: S.difficulty, contestants: realNames().map(function(n) { return { name: n, score: G.scores[n] }; }),
            others: others.map(function(n) { return { name: n, score: G.scores[n] }; }),
        });
    }
    function entryPlayer(e) { return e.player || YOU; }
    function recordScore() {
        if (G.recorded) return G.recorded;
        let stamp = Date.now().toString(36), date = new Date().toISOString(), list = loadScores();
        let who = online() ? [ G.online.me ] : humans();
        G.recordedAll = who.map(function(hm, i) {
            let e = gameEntry({ id: stamp + (i ? '-' + i : ''), date: date, game: gameTitle(), gameId: gameId() }, hm);
            if (online()) { e.human = hm; e.player = YOU; e.online = G.online.mode; }   // an online game is yours, under your own name at the podium
            return e;
        });
        for (let e of G.recordedAll) list.push(e);
        saveScores(list);
        G.recorded = G.recordedAll[0];
        notePlayed();
        return G.recorded;
    }
    // Results edited after the game ended (a Final Jeopardy! call overruled,
    // say) change the saved game too, so the record is what you can see.
    function refreshRecord() {
        if (!G.recorded) return;
        let list = loadScores();
        for (let e of (G.recordedAll || [ G.recorded ])) {
            let extra = { human: e.human, player: e.player, online: e.online };
            gameEntry(e, e.human || entryPlayer(e));
            if (extra.online) Object.assign(e, extra);
            let i = list.findIndex(function(x) { return x.id == e.id; });
            if (i >= 0) list[i] = e;
        }
        saveScores(list);
        notePlayed();
    }
    // The archive's pages mark the games you've finished (played.js keeps the
    // list, in the extension's storage); a finished game is noted there.
    function notePlayed() {
        if (!G.recorded || typeof JPPlayed == 'undefined') return;
        let a = nextGameLink(), m = a ? a.href.match(/game_id=(\d+)/) : null;
        JPPlayed.note(gameId(), { t: gameTitle(), d: G.recorded.date, s: G.recorded.score, w: !!G.recorded.won, p: humans().length, next: m ? m[1] : '' });
    }
    // Streaks: games won in a row (games with nobody to beat neither count nor
    // break it), and days played in a row (today or yesterday keeps it alive).
    function dayKey(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
    function dayDiff(a, b) { let pa = a.split('-').map(Number), pb = b.split('-').map(Number); return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 864e5); }
    function streaks(list) {
        let byDate = list.slice().sort(function(a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
        let win = { current: 0, best: 0 }, run = 0;
        for (let e of byDate) {
            let opponents = (e.contestants || [ ]).length + (e.others || [ ]).length;
            if (!opponents && e.contestants) continue;
            if (e.won) { run++; if (run > win.best) win.best = run; } else run = 0;
        }
        win.current = run;
        let days = Array.from(new Set(byDate.map(function(e) { return dayKey(new Date(e.date)); }))).sort();
        let day = { current: 0, best: 0 }; run = 0;
        for (let i = 0; i < days.length; i++) { run = (i && dayDiff(days[i - 1], days[i]) == 1) ? run + 1 : 1; if (run > day.best) day.best = run; }
        day.current = days.length && dayDiff(days[days.length - 1], dayKey(new Date())) <= 1 ? run : 0;
        return { win: win, day: day };
    }
    function statsSummary(list) {
        let games = list.length, wins = list.filter(function(e) { return e.won; }).length;
        let avg = function(f) { let xs = list.map(f).filter(function(x) { return typeof x == 'number' && !isNaN(x); }); return xs.length ? Math.round(xs.reduce(function(a, b) { return a + b; }, 0) / xs.length) : null; };
        let withCoryat = list.filter(function(e) { return typeof e.coryat == 'number'; });
        let dd = { n: 0, right: 0, wagers: 0 }, fj = { played: 0, right: 0, wager: 0 };
        for (let e of list) { if (e.dd) { dd.n += e.dd.n; dd.right += e.dd.right; dd.wagers += e.dd.wagers; } if (e.fj) { fj.played += e.fj.played; fj.right += e.fj.right; fj.wager += e.fj.wager; } }
        let sk = streaks(list);
        return { games: games, wins: wins, winRate: games ? Math.round(100 * wins / games) : 0, avgScore: avg(function(e) { return e.score; }), avgCoryat: avg(function(e) { return e.coryat; }),
                 winStreak: sk.win.current, bestWinStreak: sk.win.best, dayStreak: sk.day.current, bestDayStreak: sk.day.best,
                 bestCoryat: withCoryat.length ? Math.max.apply(null, withCoryat.map(function(e) { return e.coryat; })) : null, coryatGames: withCoryat.length,
                 ddRate: dd.n ? Math.round(100 * dd.right / dd.n) : null, ddAvg: dd.n ? Math.round(dd.wagers / dd.n) : null, ddN: dd.n,
                 fjRate: fj.played ? Math.round(100 * fj.right / fj.played) : null, fjAvg: fj.played ? Math.round(fj.wager / fj.played) : null, fjN: fj.played };
    }
    // ---- game dynamics: every player's score after each clue, and Coryat for all ----
    const PLAYER_COLORS = [ '#2E8FC4', '#C75E9A', '#4FA347' ];   // contestants, in podium order (validated for CVD on the panel's blue)
    const HUMAN_COLORS = [ '#D9A520', '#F4F4F4', '#E8632B' ];   // the people at the keyboard: gold, white, orange
    function playerColor(who) {
        if (isHuman(who)) return HUMAN_COLORS[Math.max(0, humans().indexOf(who)) % HUMAN_COLORS.length];
        let i = realNames().indexOf(who); return PLAYER_COLORS[Math.max(0, i) % PLAYER_COLORS.length];
    }
    function dynamicsHtml() {
        let names = allPlayers();
        let traj = (G.trajectory || [ ]).slice();
        // The table: final score, Coryat, right/wrong on regular clues, Daily Doubles.
        let rows = ranked(G.scores).map(function(who) {
            let right = 0, wrong = 0, ddN = 0, ddRight = 0;
            if (isHuman(who)) { for (let r of humanRecs(who)) { if (r.kind == 'clue') { if (r.outcome == 'right') right++; else if (r.outcome == 'wrong') wrong++; } else if (r.kind == 'dd') { ddN++; if (r.outcome == 'right') ddRight++; } } }
            else for (let r of (G.cresults || [ ])) if (r.who == who) { if (r.dd) { ddN++; if (r.right) ddRight++; } else if (r.right) right++; else wrong++; }
            return '<tr' + (isHuman(who) ? ' class="jp-you"' : '') + '><td><span class="jp-swatch" style="background:' + playerColor(who) + '"></span>' + esc(who) + '</td><td class="jp-num">' + money(G.scores[who]) + '</td><td class="jp-num">' + money(coryatScore(who)) + '</td>' +
                   '<td class="jp-num">' + right + ' / ' + wrong + '</td><td class="jp-num">' + (ddN ? ddRight + ' of ' + ddN : '—') + '</td></tr>';
        }).join('');
        let table = '<table class="jp-results jp-dyn"><tr><th>Player</th><th>Final</th><th>Coryat</th><th>Right / wrong</th><th>Daily Doubles</th></tr>' + rows + '</table>';
        if (traj.length < 2) return '<h2>Game dynamics</h2>' + table;
        // The chart.
        let W = 900, H = 300, L = 62, R = 118, T = 14, B = 34;
        let pts = [ { label: 'Start', round: traj[0].round, scores: { } } ].concat(traj);
        names.forEach(function(nm) { pts[0].scores[nm] = 0; });
        pts[pts.length - 1] = Object.assign({ }, pts[pts.length - 1], { scores: clone(G.scores) });   // the end of the line is the standings as they are now (edits included)
        let lo = 0, hi = 1000;
        for (let p of pts) for (let nm of names) { let v = p.scores[nm] || 0; if (v < lo) lo = v; if (v > hi) hi = v; }
        let span = hi - lo, step = span > 40000 ? 10000 : span > 16000 ? 5000 : span > 6000 ? 2000 : 1000;
        lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step; if (hi == lo) hi = lo + step;
        let X = function(i) { return L + (W - L - R) * i / (pts.length - 1); };
        let Y = function(v) { return T + (H - T - B) * (hi - v) / (hi - lo); };
        let svg = '<svg class="jp-dyn-chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" role="img" aria-label="Scores after each clue">';
        // grid + y labels
        for (let v = lo; v <= hi; v += step) {
            svg += '<line x1="' + L + '" y1="' + Y(v) + '" x2="' + (W - R) + '" y2="' + Y(v) + '" stroke="' + (v == 0 ? 'rgba(255,255,255,0.45)' : 'rgba(255,255,255,0.12)') + '" stroke-width="1"/>';
            svg += '<text x="' + (L - 8) + '" y="' + (Y(v) + 4) + '" text-anchor="end" class="jp-dyn-tick">' + (v ? money(v) : '$0') + '</text>';
        }
        // round boundaries
        let bounds = [ ];
        for (let i = 1; i < pts.length; i++) if (pts[i].round != pts[i - 1].round) bounds.push(i);
        let starts = [ 1 ].concat(bounds);
        for (let k = 0; k < starts.length; k++) {
            let i0 = starts[k], i1 = k + 1 < starts.length ? starts[k + 1] : pts.length;
            let r = pts[i0] ? pts[i0].round : '';
            let mid = (X(i0 - 1) + X(i1 - 1)) / 2;
            svg += '<text x="' + mid + '" y="' + (H - 10) + '" text-anchor="middle" class="jp-dyn-round">' + esc(r == 'J' ? 'Jeopardy!' : r == 'DJ' ? 'Double Jeopardy!' : r == 'FJ' ? 'Final' : r) + '</text>';
            if (k) svg += '<line x1="' + X(i0 - 1) + '" y1="' + T + '" x2="' + X(i0 - 1) + '" y2="' + (H - B) + '" stroke="rgba(255,255,255,0.35)" stroke-dasharray="4 4"/>';
        }
        // lines
        for (let nm of names) {
            let d = pts.map(function(p, i) { return (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(p.scores[nm] || 0).toFixed(1); }).join(' ');
            svg += '<path d="' + d + '" fill="none" stroke="' + playerColor(nm) + '" stroke-width="' + (isHuman(nm) ? 3 : 2) + '" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>';
        }
        // direct labels at the line ends, nudged apart
        let ends = names.map(function(nm) { return { nm: nm, y: Y(pts[pts.length - 1].scores[nm] || 0) }; }).sort(function(a, b) { return a.y - b.y; });
        for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 15) ends[i].y = ends[i - 1].y + 15;
        for (let e of ends) svg += '<text x="' + (W - R + 10) + '" y="' + (e.y + 4) + '" class="jp-dyn-label" fill="' + playerColor(e.nm) + '">' + esc(e.nm) + ' ' + money(pts[pts.length - 1].scores[e.nm] || 0) + '</text>';
        svg += '<line class="jp-dyn-cursor" x1="0" y1="' + T + '" x2="0" y2="' + (H - B) + '" stroke="#fff" stroke-width="1" style="display:none"/>';
        svg += '<rect class="jp-dyn-hit" x="' + L + '" y="' + T + '" width="' + (W - L - R) + '" height="' + (H - T - B) + '" fill="transparent"/>';
        svg += '</svg>';
        let json = esc(JSON.stringify({ names: names, pts: pts.map(function(p) { return { label: p.label, scores: p.scores }; }), L: L, R: R, W: W }));
        return '<h2>Game dynamics</h2>' + table + '<div class="jp-dyn-wrap" data-dyn="' + json + '">' + svg + '<div class="jp-dyn-tip" style="display:none"></div></div>' +
               '<p class="jp-note">Every player\'s money after each clue. Coryat counts the regular clues only (a Daily Double at face value when right, nothing when wrong; no Final).</p>';
    }
    function bindDynamics(panel) {
        let wrap = panel.querySelector('.jp-dyn-wrap');
        if (!wrap) return;
        let data = JSON.parse(wrap.dataset.dyn), svg = wrap.querySelector('svg'), tip = wrap.querySelector('.jp-dyn-tip'), cur = wrap.querySelector('.jp-dyn-cursor'), hit = wrap.querySelector('.jp-dyn-hit');
        let n = data.pts.length;
        function at(ev) {
            let box = svg.getBoundingClientRect();
            let x = (ev.clientX - box.left) / box.width * data.W;
            let i = Math.round((x - data.L) / (data.W - data.L - data.R) * (n - 1));
            i = Math.max(0, Math.min(n - 1, i));
            let p = data.pts[i];
            cur.setAttribute('x1', data.L + (data.W - data.L - data.R) * i / (n - 1)); cur.setAttribute('x2', cur.getAttribute('x1')); cur.style.display = '';
            tip.innerHTML = '<b>' + esc(i ? (i + '. ' + p.label) : 'Start') + '</b>' + data.names.map(function(nm) { return '<div><span class="jp-swatch" style="background:' + playerColor(nm) + '"></span>' + esc(nm) + ' <span class="jp-num">' + money(p.scores[nm] || 0) + '</span></div>'; }).join('');
            tip.style.display = '';
            let px = (ev.clientX - box.left), flip = px > box.width * 0.6;
            tip.style.left = flip ? '' : (px + 14) + 'px'; tip.style.right = flip ? (box.width - px + 14) + 'px' : '';
            tip.style.top = Math.max(0, ev.clientY - box.top - 10) + 'px';
        }
        hit.addEventListener('mousemove', at);
        hit.addEventListener('mouseleave', function() { tip.style.display = 'none'; cur.style.display = 'none'; });
    }

    // Everyone who has a saved game on this computer, you first.
    function savedPlayers() {
        let seen = [ YOU ];
        for (let e of loadScores()) if (seen.indexOf(entryPlayer(e)) < 0) seen.push(entryPlayer(e));
        return seen;
    }
    function statsTiles(t, best) {
        return '<table class="jp-stats"><tr><td><b>' + t.games + '</b><span>game' + (t.games == 1 ? '' : 's') + '</span></td><td><b>' + t.winRate + '%</b><span>win rate (' + t.wins + ' won)</span></td>' +
               '<td><b>' + money(t.avgScore || 0) + '</b><span>average score</span></td><td><b>' + (t.avgCoryat == null ? '—' : money(t.avgCoryat)) + '</b><span>average Coryat</span></td>' +
               '<td><b>' + money(best.score) + '</b><span>best score</span></td><td><b>' + (t.bestCoryat == null ? '—' : money(t.bestCoryat)) + '</b><span>best Coryat</span></td></tr>' +
               '<tr><td><b>' + (t.ddRate == null ? '—' : t.ddRate + '%') + '</b><span>Daily Doubles right (' + t.ddN + ')</span></td><td><b>' + (t.ddAvg == null ? '—' : money(t.ddAvg)) + '</b><span>average DD wager</span></td>' +
               '<td><b>' + (t.fjRate == null ? '—' : t.fjRate + '%') + '</b><span>Final Jeopardy! right (' + t.fjN + ')</span></td><td><b>' + (t.fjAvg == null ? '—' : money(t.fjAvg)) + '</b><span>average Final wager</span></td>' +
               '<td><b>' + t.winStreak + '</b><span>win streak (best ' + t.bestWinStreak + ')</span></td><td><b>' + t.dayStreak + '</b><span>day' + (t.dayStreak == 1 ? '' : 's') + ' in a row (best ' + t.bestDayStreak + ')</span></td></tr></table>';
    }
    function scoresPanelHtml(currentId, player) {
        player = player || YOU;
        let everyone = savedPlayers();
        let pick = everyone.length > 1 ? '<p class="jp-player-pick">' + everyone.map(function(p) { return '<button class="jp-btn jp-secondary' + (p == player ? ' jp-on' : '') + '" data-player="' + esc(p) + '" style="padding:3px 10px;font-size:0.9em">' + esc(p) + '</button>'; }).join(' ') + '</p>' : '';
        let list = loadScores().filter(function(e) { return entryPlayer(e) == player; }).sort(function(a, b) { return b.score - a.score || (a.date < b.date ? 1 : -1); });
        if (!list.length) return pick + '<p class="jp-note">No games finished yet. Finish one and it lands here.</p>';
        let best = list[0], games = list.length, t = statsSummary(list);
        let rows = list.slice(0, 25).map(function(e, i) {
            let d = new Date(e.date), acc = e.answered ? Math.round(100 * e.correct / e.answered) : 0;
            let vs = (e.others || [ ]).length ? '<div class="jp-note">with ' + esc(e.others.map(function(o) { return o.name; }).join(', ')) + (e.contestants && e.contestants.length ? '' : ', no archive contestants') + '</div>' : '';
            return '<tr' + (e.id == currentId ? ' class="jp-you"' : '') + '><td class="jp-num">' + (i + 1) + '</td><td>' + esc(e.game) + vs + '</td><td class="jp-note">' + d.toLocaleDateString() + '</td>' +
                '<td class="jp-num">' + money(e.score) + '</td><td class="jp-num">' + (typeof e.coryat == 'number' ? money(e.coryat) : '<span class="jp-note">—</span>') + '</td><td>' + (e.won ? 'won' : ordinalPlace(e.place - 1) + ' place') + '</td><td class="jp-note">' + e.correct + '/' + e.answered + ' (' + acc + '%)</td></tr>';
        }).join('');
        return pick + statsTiles(t, best) +
            '<table class="jp-results jp-scores"><tr><th>#</th><th>Game</th><th>Date</th><th>' + (player == YOU ? 'Your score' : 'Score') + '</th><th>Coryat</th><th>Result</th><th>Responses</th></tr>' + rows + '</table>' +
            (games > 25 ? '<p class="jp-note">Top 25 of ' + games + '.</p>' : '') +
            '<p class="jp-note">Coryat: your money from the regular clues alone — wrong responses count against you, a Daily Double counts at its face value when right and costs nothing when wrong, and Final Jeopardy! is left out. The usual measure for playing along at home. Streaks: games won in a row, and days with a game in a row.</p>';
    }
    function showScores(backTo, player) {
        let panel = showPanel('<h1>High scores</h1>' + scoresPanelHtml(G.recorded && G.recorded.id, player) +
            '<p><button class="jp-btn jp-back">Back</button> <button class="jp-btn jp-secondary jp-clear-scores">Clear all</button></p>');
        panel.querySelector('.jp-back').onclick = backTo;
        panel.querySelector('.jp-clear-scores').onclick = function() { if (confirm('Clear all high scores?')) { saveScores([ ]); showScores(backTo); } };
        panel.querySelectorAll('.jp-player-pick button').forEach(function(b) { b.onclick = function() { showScores(backTo, b.dataset.player); }; });
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
        recordScore();
        refreshRecord();                                  // results may have been edited since the game ended
        applyMicHold();                                   // the game is over: let the mic go
        let saved = loadScores(), multi = humans().length > 1;
        let sections = (G.recordedAll || [ G.recorded ]).map(function(entry) {
            let hm = entry.human || entryPlayer(entry), h = (G.hstats || { })[hm] || { };
            let all = saved.filter(function(e) { return entryPlayer(e) == entryPlayer(entry); }).sort(function(a, b) { return b.score - a.score; });
            let rank = all.findIndex(function(e) { return e.id == entry.id; }) + 1;
            let t = statsSummary(all);
            let acc = entry.answered ? Math.round(100 * entry.correct / entry.answered) : 0;
            let streak = (t.winStreak >= 2 ? '<b>' + t.winStreak + ' wins in a row' + (t.winStreak >= t.bestWinStreak ? ' — a best' : '') + '.</b> ' : '') +
                         (t.dayStreak >= 2 ? (hm == YOU ? 'You\'ve' : esc(hm) + ' has') + ' played ' + t.dayStreak + ' days running' + (t.dayStreak >= t.bestDayStreak ? ' (a best)' : '') + '. ' : '');
            return '<h2>' + (hm == YOU || (online() && isMe(hm)) ? 'Your game' : esc(hm) + '\'s game') + '</h2>' + (online() ? ratingLine() : '') +
                '<p>Clues played: ' + st.clues + ' · buzzer races won: ' + (h.buzzWins || 0) + (multi ? '' : ' · lost: ' + st.buzzLost) + ' · early buzzes: ' + (h.lockouts || 0) + '</p>' +
                '<p>Responses: ' + entry.answered + ' · correct: ' + entry.correct + ' · incorrect: ' + (entry.answered - entry.correct) + ' · accuracy: ' + acc + '% · Coryat score: <b>' + money(entry.coryat) + '</b>' + (t.avgCoryat != null && all.length > 1 ? ' <span class="jp-note">(' + (hm == YOU ? 'your' : 'the') + ' average: ' + money(t.avgCoryat) + ')</span>' : '') + '</p>' +
                '<p>' + (rank == 1 && all.length > 1 ? '<b>A new high score!</b> ' : '') + streak + 'This game ranks #' + rank + ' of ' + all.length + ' on this computer' + (all.length > 1 ? ' · win rate ' + t.winRate + '%' : '') + '. <button class="jp-btn jp-secondary jp-scores" data-player="' + esc(entryPlayer(entry)) + '" style="padding:3px 10px;font-size:0.9em">High scores</button> ' +
                (hm == entryPlayer(G.recorded) && !online() ? '<button class="jp-btn jp-secondary jp-edit-results" style="padding:3px 10px;font-size:0.9em">Edit results</button> <span class="jp-note">(a call the judge got wrong — Final Jeopardy! included — changes the standings and the saved game)</span>' : '') + '</p>';
        }).join('');
        let title = winner == YOU || (online() && isMe(winner)) ? 'You win!' : esc(winner) + ' wins' + (isHuman(winner) ? '!' : '');
        let ending = online()
            ? '<p><button class="jp-btn jp-again">Play online again</button> <button class="jp-btn jp-secondary jp-close">Back to the page</button></p>'
            : '<p>' + (nextGameLink() ? '<button class="jp-btn jp-next">Play the next game &rarr;</button> ' : '') +
              '<button class="jp-btn' + (nextGameLink() ? ' jp-secondary' : '') + ' jp-again">Play this game again</button> <button class="jp-btn jp-secondary jp-close">Back to the page</button></p>' +
              (nextGameLink() ? '<p class="jp-note">The next game in the archive (the day after this one) opens ready to start, with these settings.</p>'
                              : '<p class="jp-note">This is the most recent game in the archive, so there is no next game yet.</p>');
        showPanel('<h1>' + title + '</h1>' + (online() ? '<p class="jp-note">' + esc(modeLabel(G.online.mode)) + ' · ' + esc(gameTitle()) + '</p>' : '') + standingsTable() + sections + dynamicsHtml() + ending);
        let nx = U.stage.querySelector('.jp-next');
        if (nx) nx.onclick = function() { goToNextGame(); };
        U.stage.querySelectorAll('.jp-scores').forEach(function(b) { b.onclick = function() { showScores(showFinalStandings, b.dataset.player); }; });
        let er = U.stage.querySelector('.jp-edit-results');
        if (er) er.onclick = function() { showPauseMenu(); swapPauseContents('results'); };
        bindDynamics(U.stage);
        U.stage.querySelector('.jp-again').onclick = function() { if (online()) { JPOnline.disconnect(); G.online = null; loadSettings(); G.humans = humanNames(); G.scores = { }; for (let n of allPlayers()) G.scores[n] = 0; G.recorded = null; G.recordedAll = null; renderPodiums(); } showSetup(); };
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
    // "Play the game after it" from the archive's pages, for a game that had
    // no next game when it was played: forward to the next game if the archive
    // has one now, otherwise say so.
    function continueIfRequested() {
        if (location.hash != '#jplive-continue') return;
        let a = nextGameLink();
        if (a) { location.replace(a.href.replace(/#.*$/, '') + '#jplive-next'); return; }
        try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { }
        if (!document.getElementById('live_btn')) return;
        startLiveGame();
        let panel = showPanel('<h1>No next game yet</h1><p>' + esc(gameTitle()) + ' is still the newest game in the archive, so the one after it isn\'t there yet. Check back after the next episode is added — or play this one again.</p>' +
            '<p style="margin-top:1em"><button class="jp-btn jp-again">Play this game again</button> <button class="jp-btn jp-secondary jp-cancel">Back to the page</button></p>');
        panel.querySelector('.jp-again').onclick = function() { showSetup(); };
        panel.querySelector('.jp-cancel').onclick = function() { quitLive(); };
        setHint('');
    }
    // Online: a game's room (everyone lands here), a lobby invite, or just the online menu.
    function onlineIfRequested() {
        let mroom = location.hash.match(/^#jplive-room=([0-9a-f-]{36})$/), mjoin = location.hash.match(/^#jplive-join=([A-Za-z]{4,8})$/);
        if (mroom) { onlineLanding(mroom[1]); return; }
        if (!document.getElementById('live_btn') || !onlineAvailable()) return;
        if (mjoin) {
            try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { }
            startLiveGame();
            let code = mjoin[1].toUpperCase();
            let join = function() { JPOnline.joinRoom(code).then(showLobby).catch(function(e) { let p = showPanel('<h1>Could not join</h1><p>' + esc(e.message) + '</p><p><button class="jp-btn jp-cancel">Back</button></p>'); p.querySelector('.jp-cancel').onclick = function() { showSetup(); }; }); };
            JPOnline.init().then(function() { if (JPOnline.signedIn) join(); else showOnlineSignIn(join, 'You\'ve been invited to lobby ' + code + '. Sign in to join it.'); });
        } else if (location.hash == '#jplive-online') {
            try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { }
            startLiveGame();
        }
    }
    // archive.js builds the page (and the Play Live button) at load; look after it.
    if (/^#jplive-(next|continue|online|room=|join=)/.test(location.hash)) {
        let tries = 0;
        let t = setInterval(function() { if (document.getElementById('live_btn') || ++tries > 50) { clearInterval(t); autoOpenIfRequested(); continueIfRequested(); onlineIfRequested(); } }, 100);
    }
    // Games finished before the archive's pages kept the list: fill it in.
    if (typeof JPPlayed != 'undefined') JPPlayed.importScores(loadScores());

})();
