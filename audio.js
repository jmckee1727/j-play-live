// audio.js -- text-to-speech (the host and the contestants), sound effects,
// and the speech-recognition wrapper used to hear your answers.
//
// Everything here is built on browser APIs that work inside a content script:
//   speechSynthesis / SpeechSynthesisUtterance   (reading aloud)
//   webkitSpeechRecognition                       (hearing you)
//   AudioContext                                  (synthesized stand-in sounds)
// If you drop MP3/WAV files into the sounds/ folder they are used instead of the
// synthesized tones (see SFX_FILES below for the file names).

var JPAudio = (function() {
    'use strict';

    // ------------------------------------------------------------------ TTS

    let voicesReady = false;
    let voiceCache = [ ];

    function loadVoices() {
        voiceCache = speechSynthesis.getVoices() || [ ];
        if (voiceCache.length)
            voicesReady = true;
        return voiceCache;
    }
    if (typeof speechSynthesis !== 'undefined') {
        loadVoices();
        speechSynthesis.onvoiceschanged = loadVoices;
    }

    // Returns the voice list (English first, local voices before network ones).
    function voices() {
        if (!voicesReady)
            loadVoices();
        let v = voiceCache.slice();
        v.sort(function(a, b) {
            let ae = /^en/i.test(a.lang) ? 0 : 1, be = /^en/i.test(b.lang) ? 0 : 1;
            if (ae != be) return ae - be;
            if (a.localService != b.localService) return a.localService ? -1 : 1;
            return a.name.localeCompare(b.name);
        });
        return v;
    }

    // Pick a sensible default host voice: a local English voice. macOS ships
    // several "Enhanced" / "Premium" voices that are free to download and a
    // large step up (System Settings > Accessibility > Spoken Content >
    // System Voice > Manage Voices); when one is installed it is preferred.
    const PREFERRED_HOST = [ 'Alex', 'Tom', 'Evan', 'Nathan', 'Aaron', 'Oliver', 'Daniel', 'Samantha', 'Ava', 'Allison', 'Zoe', 'Susan', 'Karen', 'Moira', 'Tessa', 'Fred' ];
    function quality(v) { return /premium/i.test(v.name) ? 2 : /enhanced/i.test(v.name) ? 1 : 0; }
    function baseName(v) { return v.name.split(/[\s(]/)[0]; }

    function defaultHostVoice() {
        let v = voices().filter(x => x.localService && /^en/i.test(x.lang));
        // Best quality build of the most preferred name.
        let best = null, bestScore = -1;
        for (let x of v) {
            let pi = PREFERRED_HOST.indexOf(baseName(x));
            if (pi < 0) continue;
            let score = (quality(x) * 100) + (PREFERRED_HOST.length - pi);
            if (score > bestScore) { best = x; bestScore = score; }
        }
        if (best) return best;
        let anyEnhanced = v.find(x => quality(x) > 0);
        return anyEnhanced || v[0] || voices().find(x => /^en/i.test(x.lang)) || voices()[0] || null;
    }

    // True when a higher-quality (Enhanced/Premium) English voice is installed.
    function hasEnhancedVoice() { return voices().some(x => x.localService && /^en/i.test(x.lang) && quality(x) > 0); }

    function voiceByName(name) {
        if (!name) return null;
        return voices().find(x => x.name == name) || null;
    }

    // Distinct voices for the three contestants (never the host's voice).
    function contestantVoices(hostVoice, n) {
        let pool = voices().filter(x => /^en/i.test(x.lang) && x.localService && (!hostVoice || x.name != hostVoice.name));
        // Skip novelty voices that would sound silly at a podium.
        pool = pool.filter(x => !/(Bad News|Bahh|Bells|Boing|Bubbles|Cellos|Deranged|Good News|Hysterical|Pipe Organ|Trinoids|Whisper|Zarvox|Albert|Jester|Organ|Superstar|Wobble|Eddy|Flo|Grandma|Grandpa|Reed|Rocko|Sandy|Shelley|Junior|Kathy|Ralph|Fred)/i.test(x.name));
        let out = [ ];
        for (let i = 0; i < n; i++)
            out.push(pool.length ? pool[i % pool.length] : hostVoice);
        return out;
    }

    // Convert clue HTML into something worth reading aloud.
    function htmlToSpeech(html) {
        if (!html) return '';
        let s = String(html)
            .replace(/<br\s*\/?>/gi, ', ')
            .replace(/<\/(p|div)>/gi, ', ')
            .replace(/<[^>]+>/g, ' ');
        let tmp = document.createElement('textarea');
        tmp.innerHTML = s;
        s = tmp.value;
        s = s.replace(/\[\*\*?\]/g, '')
             .replace(/_{2,}/g, ' blank ')
             .replace(/\s*&\s*/g, ' and ')
             .replace(/\s+/g, ' ')
             .replace(/\s+([,.;:!?])/g, '$1')
             .replace(/,\s*,/g, ',')
             .trim();
        return s;
    }

    let currentUtterance = null;
    let speakToken = 0;

    // Speak text; resolves when finished (or cancelled). Never rejects.
    // opts: { voice, rate, pitch, volume, engine: 'system'|'neural', neuralVoice }
    // With engine 'neural' the studio voice (JPNeural) is used and the system
    // voice is the fallback if it fails.
    function speak(text, opts) {
        opts = opts || { };
        if (opts.engine == 'neural' && typeof JPNeural !== 'undefined' && JPNeural.ready && text) {
            let token = ++speakToken;
            try { speechSynthesis.cancel(); } catch (e) { }
            return JPNeural.speak(text, { voice: opts.neuralVoice, speed: opts.rate || 1, volume: opts.volume }).then(function(ok) {
                return ok;
            }, function(e) {
                if (token != speakToken) return false;
                console.warn('[j-play-live] studio voice failed, using the system voice:', e && e.message);
                return speakSystem(text, opts, token);
            });
        }
        return speakSystem(text, opts, ++speakToken);
    }

    function speakSystem(text, opts, token) {
        return new Promise(function(resolve) {
            if (typeof speechSynthesis === 'undefined' || !text) {
                resolve(false);
                return;
            }
            try { speechSynthesis.cancel(); } catch (e) { }

            let u = new SpeechSynthesisUtterance(text);
            if (opts.voice) u.voice = opts.voice;
            u.rate = opts.rate || 1.0;
            u.pitch = opts.pitch || 1.0;
            u.volume = opts.volume == null ? 1.0 : opts.volume;
            currentUtterance = u; // keep a reference: Chrome garbage-collects utterances mid-speech otherwise

            let done = false;
            let finish = function(ok) {
                if (done) return;
                done = true;
                JPClock.clearTimeout(watchdog);
                if (currentUtterance === u) currentUtterance = null;
                resolve(ok);
            };
            // Watchdog in case onend never fires (a known Chrome quirk with some
            // voices). Runs on the game clock, so a pause doesn't trip it.
            let words = text.split(/\s+/).length;
            let estMs = (words / (2.6 * u.rate)) * 1000; // ~160 wpm at rate 1
            let watchdog = JPClock.setTimeout(function() { finish(true); }, Math.max(1500, estMs * 2 + 2500));

            u.onend = function() { finish(true); };
            u.onerror = function(e) { finish(e && e.error == 'interrupted' ? false : true); };

            // Chrome needs a tick after cancel() before speak() reliably starts.
            // If the game is paused, hold the utterance until it resumes.
            setTimeout(function() {
                JPClock.whenRunning().then(function() {
                    if (token != speakToken) { finish(false); return; }
                    try {
                        if (speechSynthesis.paused) speechSynthesis.resume();
                        speechSynthesis.speak(u);
                    } catch (e) { finish(false); }
                });
            }, 30);
        });
    }

    // Freeze / unfreeze speech with the game clock.
    JPClock.onPause(function() { try { if (speechSynthesis.speaking) speechSynthesis.pause(); } catch (e) { } });
    JPClock.onResume(function() { try { if (speechSynthesis.paused) speechSynthesis.resume(); } catch (e) { } });

    function stopSpeaking() {
        speakToken++;
        try { speechSynthesis.cancel(); } catch (e) { }
        if (typeof JPNeural !== 'undefined') JPNeural.stop();
    }

    // ------------------------------------------------------------------ SFX

    const SFX_FILES = {
        boardfill: 'boardfill',   // board reveal at the start of a round
        select:    'select',      // a clue is picked
        lights:    'lights',      // buzzers armed (the show is silent here; optional)
        buzz:      'buzz',        // someone rang in
        lockout:   'lockout',     // you rang in too early
        timeout:   'timeout',     // nobody answered ("beep beep beep")
        right:     'right',       // your answer was right (optional)
        wrong:     'wrong',       // your answer was wrong (optional)
        dd:        'dd',          // Daily Double reveal
        fj:        'fj',          // Final Jeopardy! reveal
        think:     'think',       // 30-second Final Jeopardy! think track (loops until stopped)
        roundend:  'roundend',    // end-of-round signal
        sweep:     'sweep',       // you ran the category (all five clues right)
        ddright:   'ddright',     // your Daily Double was right
        fjright:   'fjright',     // your Final Jeopardy! response was right
        win:       'win',         // you won the game
    };
    const EXTS = [ 'mp3', 'wav', 'ogg', 'm4a' ];

    let enabled = true;
    let fileCache = { };   // name -> HTMLAudioElement | null (null = no file, use synth)
    let ctx = null;
    let loopAudio = null;

    function setEnabled(on) { enabled = !!on; if (!on) stopLoop(); }

    function audioCtx() {
        if (!ctx) {
            try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { ctx = null; }
            if (ctx && outSink && ctx.setSinkId) { try { ctx.setSinkId(outSink).catch(function() { }); } catch (e) { } }
        }
        if (ctx && ctx.state == 'suspended' && !JPClock.paused)
            ctx.resume().catch(function() { });
        return ctx;
    }
    // Pausing the game suspends the whole audio graph, which freezes the
    // think music exactly where it is (all its notes are pre-scheduled).
    JPClock.onPause(function() { if (ctx && ctx.state == 'running') ctx.suspend().catch(function() { }); });
    JPClock.onResume(function() { if (ctx && ctx.state == 'suspended') ctx.resume().catch(function() { }); });

    function fileUrl(base, ext) {
        try { return chrome.runtime.getURL('sounds/' + base + '.' + ext); } catch (e) { return null; }
    }

    // Find a bundled sound file for a name (any supported extension). Resolves
    // to an Audio element or null. Result is cached.
    function findFile(name) {
        if (name in fileCache)
            return Promise.resolve(fileCache[name]);
        let base = SFX_FILES[name] || name;
        let tryExt = function(i) {
            if (i >= EXTS.length) { fileCache[name] = null; return Promise.resolve(null); }
            let url = fileUrl(base, EXTS[i]);
            if (!url) { fileCache[name] = null; return Promise.resolve(null); }
            return fetch(url, { method: 'HEAD' }).then(function(r) {
                if (!r.ok) return tryExt(i + 1);
                let a = new Audio(url);
                a.preload = 'auto';
                if (outSink && a.setSinkId) { try { a.setSinkId(outSink).catch(function() { }); } catch (e) { } }
                fileCache[name] = a;
                return a;
            }).catch(function() { return tryExt(i + 1); });
        };
        return tryExt(0);
    }

    function preload() {
        for (let name in SFX_FILES)
            findFile(name);
    }

    // Simple synthesized stand-ins, so the game has cues before any files exist.
    function tone(freq, ms, type, gain, when) {
        let c = audioCtx();
        if (!c) return;
        let t0 = c.currentTime + (when || 0);
        let o = c.createOscillator();
        let g = c.createGain();
        o.type = type || 'sine';
        o.frequency.setValueAtTime(freq, t0);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(gain || 0.25, t0 + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + ms / 1000);
        o.connect(g).connect(c.destination);
        o.start(t0);
        o.stop(t0 + ms / 1000 + 0.05);
    }

    function synth(name) {
        switch (name) {
          case 'boardfill':
            for (let i = 0; i < 6; i++) tone(520 + i * 60, 90, 'square', 0.08, i * 0.07);
            break;
          case 'select':
            tone(880, 70, 'sine', 0.12);
            break;
          case 'lights':
            tone(1320, 40, 'sine', 0.06);
            break;
          case 'buzz':
            tone(660, 120, 'triangle', 0.2);
            break;
          case 'lockout':
            tone(140, 180, 'sawtooth', 0.18);
            break;
          case 'timeout':
            tone(1046, 110, 'sine', 0.22, 0); tone(1046, 110, 'sine', 0.22, 0.16); tone(1046, 110, 'sine', 0.22, 0.32);
            break;
          case 'right':
            tone(784, 90, 'sine', 0.12, 0); tone(1175, 140, 'sine', 0.12, 0.09);
            break;
          case 'wrong':
            tone(220, 220, 'triangle', 0.15);
            break;
          case 'dd':
            tone(392, 160, 'sine', 0.18, 0); tone(523, 160, 'sine', 0.18, 0.14); tone(659, 160, 'sine', 0.18, 0.28); tone(784, 400, 'sine', 0.18, 0.42);
            break;
          case 'fj':
            tone(330, 300, 'sine', 0.16, 0); tone(415, 300, 'sine', 0.16, 0.25); tone(494, 600, 'sine', 0.16, 0.5);
            break;
          case 'roundend':
            tone(600, 250, 'sine', 0.15, 0); tone(450, 350, 'sine', 0.15, 0.22);
            break;
          case 'sweep': case 'ddright':
            playChime(false);
            break;
          case 'fjright':
            playChime(true);
            break;
          case 'win':
            playWinMusic();
            break;
        }
    }

    // ---- success cues -------------------------------------------------------
    // Original synthesized cues (none of the show's): a bell chime for running
    // a category, a Daily Double or Final Jeopardy! answered right, and a short
    // fanfare for winning the game. Files named sweep / ddright / fjright / win
    // in sounds/ replace them.

    // A struck bell: the fundamental and two bright, inharmonic partials that die away faster.
    function bell(dest, freq, t0, dur, peak) {
        let c = ctx;
        [ [1, 1, dur], [2.76, 0.32, dur * 0.4], [5.4, 0.1, dur * 0.2] ].forEach(function(p) {
            let o = c.createOscillator(), g = c.createGain();
            o.type = 'sine';
            o.frequency.setValueAtTime(freq * p[0], t0);
            g.gain.setValueAtTime(0.0001, t0);
            g.gain.exponentialRampToValueAtTime(peak * p[1], t0 + 0.008);
            g.gain.exponentialRampToValueAtTime(0.0001, t0 + p[2]);
            o.connect(g).connect(dest);
            o.start(t0);
            o.stop(t0 + p[2] + 0.05);
        });
    }
    // A brassy note: detuned sawtooths through a low-pass filter that opens on the attack.
    function brass(dest, freq, t0, dur, peak) {
        let c = ctx;
        let f = c.createBiquadFilter();
        f.type = 'lowpass'; f.Q.value = 1.1;
        f.frequency.setValueAtTime(freq * 1.5, t0);
        f.frequency.linearRampToValueAtTime(Math.min(freq * 7, 9000), t0 + 0.05);
        f.frequency.exponentialRampToValueAtTime(freq * 2.5, t0 + Math.max(0.1, dur));
        let g = c.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(peak, t0 + 0.03);
        g.gain.setValueAtTime(peak, Math.max(t0 + 0.03, t0 + dur - 0.08));
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        [ [1, 'sawtooth', 1], [1.004, 'sawtooth', 0.55], [0.5, 'square', 0.2] ].forEach(function(p) {
            let o = c.createOscillator(), og = c.createGain();
            o.type = p[1];
            o.frequency.setValueAtTime(freq * p[0], t0);
            og.gain.value = p[2];
            o.connect(og).connect(f);
            o.start(t0);
            o.stop(t0 + dur + 0.05);
        });
        f.connect(g).connect(dest);
    }
    // A timpani hit: a low sine whose pitch drops as it rings.
    function drum(dest, freq, t0, dur, peak) {
        let c = ctx, o = c.createOscillator(), g = c.createGain();
        o.type = 'sine';
        o.frequency.setValueAtTime(freq * 1.7, t0);
        o.frequency.exponentialRampToValueAtTime(freq, t0 + 0.07);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(peak, t0 + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        o.connect(g).connect(dest);
        o.start(t0);
        o.stop(t0 + dur + 0.05);
    }
    // A cymbal: bright filtered noise that fades.
    function cymbal(dest, t0, dur, peak) {
        let c = ctx, len = Math.ceil(c.sampleRate * dur), buf = c.createBuffer(1, len, c.sampleRate), d = buf.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
        let src = c.createBufferSource();
        src.buffer = buf;
        let f = c.createBiquadFilter();
        f.type = 'highpass'; f.frequency.value = 6000;
        let g = c.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(peak, t0 + 0.015);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        src.connect(f).connect(g).connect(dest);
        src.start(t0);
        src.stop(t0 + dur + 0.05);
    }
    function bus(c, level) {
        let comp = c.createDynamicsCompressor();
        comp.threshold.value = -14; comp.ratio.value = 4; comp.attack.value = 0.003; comp.release.value = 0.12;
        let master = c.createGain();
        master.gain.value = level;
        master.connect(comp).connect(c.destination);
        return master;
    }

    // A rising bell arpeggio (C E G C, and E on top for the big one) that rings out.
    function playChime(big) {
        let c = audioCtx();
        if (!c) return;
        let master = bus(c, 0.7);
        let t0 = c.currentTime + 0.02;
        let notes = big ? [ 72, 76, 79, 84, 88 ] : [ 72, 76, 79, 84 ];
        let step = big ? 0.115 : 0.1;
        notes.forEach(function(m, i) {
            let last = i == notes.length - 1;
            bell(master, midiHz(m), t0 + i * step, last ? (big ? 2.4 : 1.7) : 0.55, last ? 0.26 : 0.2);
        });
        // A soft octave under the top note, so the ring has some body.
        bell(master, midiHz(notes[notes.length - 1] - 12), t0 + (notes.length - 1) * step, big ? 2.0 : 1.4, 0.09);
        if (big) bell(master, midiHz(72), t0 + (notes.length - 1) * step + 0.05, 2.0, 0.07);
    }

    // A short original fanfare, about five seconds: three pickup notes to the
    // tonic, a leap to the fifth, and a held top chord with timpani and cymbal.
    const WIN_BPM = 128;
    const WIN_FANFARE = [                    // [start beat, length in beats, notes (the first is the lead)]
        [ 0,    0.45, [ 67 ] ], [ 0.5, 0.45, [ 67 ] ], [ 1.0, 0.45, [ 67 ] ],
        [ 1.5,  1.4,  [ 72, 64, 55 ] ],
        [ 3.0,  0.45, [ 74 ] ], [ 3.5, 0.45, [ 76 ] ],
        [ 4.0,  2.4,  [ 79, 72, 67, 60 ] ],
        [ 6.5,  0.45, [ 81 ] ], [ 7.0, 0.45, [ 83 ] ],
        [ 7.5,  4.2,  [ 84, 79, 76, 72, 60 ] ],
    ];
    function playWinMusic() {
        let c = audioCtx();
        if (!c) return;
        let master = bus(c, 0.5);
        let beat = 60 / WIN_BPM, t0 = c.currentTime + 0.03;
        WIN_FANFARE.forEach(function(ev) {
            let start = t0 + ev[0] * beat, dur = ev[1] * beat;
            ev[2].forEach(function(m, i) { brass(master, midiHz(m), start, dur, i == 0 ? 0.13 : 0.06); });
        });
        [ 0, 1.5, 4.0 ].forEach(function(b) { drum(master, 65.4, t0 + b * beat, 0.7, 0.45); });
        drum(master, 65.4, t0 + 7.5 * beat, 1.6, 0.55);
        drum(master, 49, t0 + 7.5 * beat + 0.02, 1.8, 0.3);
        cymbal(master, t0 + 4.0 * beat, 0.7, 0.05);
        cymbal(master, t0 + 7.5 * beat, 3.0, 0.11);
    }

    function play(name) {
        if (!enabled) return Promise.resolve();
        return findFile(name).then(function(a) {
            if (a) {
                try { a.currentTime = 0; return a.play().catch(function() { synth(name); }); }
                catch (e) { synth(name); }
            } else
                synth(name);
        });
    }

    // ----------------------------------------------------------- music

    // Original tunes for the Final Jeopardy! think time, played when there is
    // no sounds/think.* file. (The show's own music is Sony's and isn't
    // bundled; drop your own file in to replace these.) All four are written
    // for this extension and synthesized here with Web Audio, so no recording
    // or sample is involved.
    //
    // Each tune is 48 beats long. The tempo follows the Final Jeopardy! time
    // setting so the last note lands as time runs out: 96 bpm at the default
    // 30 seconds. Everything goes through a warm low-pass, so nothing is shrill.
    //
    //   marimba   Bright marimba (the default since 0.14.3): a light, bouncy
    //             tune in G on a soft marimba, a plucked bass walking on the
    //             beat, gentle chords on 2 and 4, a soft tick-tock in the last
    //             two bars.
    //   suspense  Quiet suspense: A minor, a dark low string pad, a slow
    //             heartbeat, and a celesta arpeggio that starts sparse and
    //             fills in; the heartbeat quickens over the last bars.
    //   musicbox  Music box waltz: a gentle 3/4 tune in D on a music box, with
    //             a soft oom-pah-pah underneath.
    //   calm      Calm jazz piano (0.14.2's tune; John, Nov 13: the one before
    //             it was "super annoying"): a jazzy electric piano piece in F
    //             with a plucked bass and a soft echo.
    const THINK_BEATS = 48;
    const THINK_DEFAULT = 'marimba';
    const THINK_TUNES = [
        { id: 'marimba',  name: 'Bright marimba' },
        { id: 'suspense', name: 'Quiet suspense' },
        { id: 'musicbox', name: 'Music box waltz' },
        { id: 'calm',     name: 'Calm jazz piano' },
    ];
    function thinkTune(id) { return THINK_TUNES.some(function(t) { return t.id == id; }) ? id : THINK_DEFAULT; }

    // ---- calm: [MIDI note or null for a rest, beats], bar by bar
    const CALM_MELODY = [
        [69, 1.5], [72, 0.5], [69, 1], [65, 1],          // Fmaj7
        [65, 1.5], [69, 0.5], [74, 2],                   // Dm7
        [74, 1], [72, 0.5], [70, 0.5], [67, 2],          // Gm7
        [64, 1], [67, 1], [70, 1.5], [null, 0.5],        // C9
        [69, 1.5], [72, 0.5], [77, 1], [76, 1],          // Fmaj7
        [74, 1.5], [72, 0.5], [69, 2],                   // Bbmaj7
        [70, 1], [69, 0.5], [67, 0.5], [74, 2],          // Gm7
        [72, 1], [70, 0.5], [67, 0.5], [64, 2],          // C9
        [76, 1.5], [74, 0.5], [72, 1], [69, 1],          // Am7
        [72, 1.5], [74, 0.5], [77, 2],                   // Dm7
        [74, 1], [72, 1], [70, 1], [67, 1],              // Gm7 | C9
        [69, 0.5], [72, 0.5], [77, 3],                   // F6 (the last note rings)
    ];
    const CALM_CHORDS = [                     // [chord notes, bass root, bass fifth, beats]
        [ [53, 57, 60, 64], 41, 48, 4 ],     // Fmaj7
        [ [53, 57, 60, 62], 38, 45, 4 ],     // Dm7
        [ [55, 58, 62, 65], 43, 50, 4 ],     // Gm7
        [ [52, 55, 58, 62], 36, 43, 4 ],     // C9
        [ [53, 57, 60, 64], 41, 48, 4 ],     // Fmaj7
        [ [53, 57, 58, 62], 46, 41, 4 ],     // Bbmaj7
        [ [55, 58, 62, 65], 43, 50, 4 ],     // Gm7
        [ [52, 55, 58, 62], 36, 43, 4 ],     // C9
        [ [52, 55, 60, 64], 45, 40, 4 ],     // Am7
        [ [53, 57, 60, 62], 38, 45, 4 ],     // Dm7
        [ [55, 58, 62, 65], 43, 43, 2 ],     // Gm7
        [ [52, 55, 58, 62], 36, 36, 2 ],     // C9
        [ [53, 57, 60, 62], 41, 41, 4 ],     // F6
    ];

    // ---- marimba: G major, 12 bars of 4/4
    const MARIMBA_MELODY = [
        [74, .5], [79, .5], [78, .5], [79, .5], [74, 1], [71, 1],     // G
        [76, .5], [79, .5], [78, .5], [76, .5], [71, 2],              // Em
        [72, .5], [76, .5], [79, .5], [76, .5], [81, 1], [79, 1],     // C
        [78, .5], [76, .5], [74, .5], [76, .5], [78, 1], [null, 1],   // D
        [74, .5], [79, .5], [78, .5], [79, .5], [83, 1], [81, 1],     // G
        [79, .5], [78, .5], [76, .5], [78, .5], [79, 1], [71, 1],     // Em
        [72, .5], [76, .5], [81, .5], [79, .5], [76, 1], [72, 1],     // Am
        [74, .5], [78, .5], [81, .5], [84, .5], [83, 1], [81, 1],     // D7
        [79, 1], [76, .5], [79, .5], [84, 1], [79, 1],                // C
        [78, 1], [74, .5], [78, .5], [83, 1], [78, 1],                // Bm
        [76, .5], [81, .5], [79, .5], [76, .5], [78, .5], [81, .5], [74, .5], [78, .5],   // Am | D
        [79, .5], [74, .5], [71, .5], [74, .5], [79, 2],              // G (the last note rings)
    ];
    const MARIMBA_CHORDS = [                  // [chord notes, bass root, bass fifth, beats]
        [ [55, 59, 62], 43, 50, 4 ],         // G
        [ [52, 55, 59], 40, 47, 4 ],         // Em
        [ [52, 55, 60], 48, 43, 4 ],         // C
        [ [54, 57, 62], 38, 45, 4 ],         // D
        [ [55, 59, 62], 43, 50, 4 ],         // G
        [ [52, 55, 59], 40, 47, 4 ],         // Em
        [ [52, 57, 60], 45, 40, 4 ],         // Am
        [ [54, 57, 60], 38, 45, 4 ],         // D7
        [ [52, 55, 60], 48, 43, 4 ],         // C
        [ [54, 59, 62], 47, 42, 4 ],         // Bm
        [ [52, 57, 60], 45, 45, 2 ],         // Am
        [ [54, 57, 62], 38, 38, 2 ],         // D
        [ [55, 59, 62, 67], 43, 43, 4 ],     // G
    ];

    // ---- suspense: A minor, 12 bars of 4/4. [pad chord, heartbeat root, arpeggio (one note per step), step in beats]
    const SUSPENSE_BARS = [
        [ [57, 60, 64], 45, [69, 72, 76, 72], 1 ],                          // Am (sparse: quarter notes)
        [ [57, 60, 64], 45, [69, 76, 74, 72], 1 ],                          // Am
        [ [57, 60, 65], 41, [65, 69, 72, 69], 1 ],                          // F
        [ [57, 60, 65], 41, [65, 72, 71, 69], 1 ],                          // F (the B natural: a little mystery)
        [ [57, 62, 65], 38, [74, 77, 81, 77, 74, 77, 81, 77], .5 ],         // Dm (fills in: eighths)
        [ [57, 62, 65], 38, [74, 77, 81, 77, 76, 77, 74, 77], .5 ],         // Dm
        [ [56, 59, 64], 40, [76, 80, 83, 80, 76, 80, 83, 80], .5 ],         // E
        [ [56, 59, 64], 40, [76, 80, 83, 80, 77, 76, 74, 71], .5 ],         // E
        [ [57, 60, 64], 45, [69, 72, 76, 81, 84, 81, 76, 72], .5 ],         // Am
        [ [57, 60, 65], 41, [65, 69, 72, 77, 81, 77, 72, 69], .5 ],         // F
        [ [57, 62, 65, 64, 59, 56], 38, [74, 77, 81, 77, 76, 80, 83, 88], .5, 40 ],   // Dm | E
        [ [57, 60, 64, 69], 45, [81], 4 ],                                  // Am (rings)
    ];

    // ---- musicbox: D major, 16 bars of 3/4
    const MUSICBOX_MELODY = [
        [78, 2], [81, 1],                    // D
        [86, 2], [85, .5], [83, .5],         // D
        [83, 2], [79, 1],                    // G
        [81, 3],                             // D
        [78, 2], [83, 1],                    // Bm
        [79, 1.5], [78, .5], [76, 1],        // Em
        [76, 1], [79, 1], [85, 1],           // A7
        [83, 2], [81, 1],                    // A7
        [78, 2], [81, 1],                    // D
        [84, 2], [83, .5], [81, .5],         // D7
        [83, 2], [86, 1],                    // G
        [82, 2], [79, 1],                    // Gm
        [78, 1.5], [81, .5], [86, 1],        // D/A
        [85, 1], [76, 1], [79, 1],           // A7
        [78, 3],                             // D
        [74, 3],                             // D (rings)
    ];
    const MUSICBOX_CHORDS = [                 // [chord notes, bass], one bar of 3/4 each
        [ [62, 66, 69], 50 ], [ [62, 66, 69], 50 ], [ [59, 62, 67], 43 ], [ [62, 66, 69], 50 ],
        [ [59, 62, 66], 47 ], [ [59, 64, 67], 40 ], [ [61, 64, 67], 45 ], [ [61, 64, 67], 45 ],
        [ [62, 66, 69], 50 ], [ [60, 62, 66], 50 ], [ [59, 62, 67], 43 ], [ [58, 62, 67], 43 ],
        [ [62, 66, 69], 45 ], [ [61, 64, 67], 45 ], [ [62, 66, 69], 50 ], [ [62, 66, 69, 74], 38 ],
    ];
    function midiHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }

    function note(dest, freq, t0, dur, type, peak, attack, release) {
        let c = ctx;
        let o = c.createOscillator();
        let g = c.createGain();
        o.type = type;
        o.frequency.setValueAtTime(freq, t0);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(peak, t0 + attack);
        g.gain.setValueAtTime(peak, Math.max(t0 + attack, t0 + dur - release));
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        o.connect(g).connect(dest);
        o.start(t0);
        o.stop(t0 + dur + 0.05);
        return o;
    }
    // A soft electric-piano note: a sine with a quieter octave that fades faster
    // (the bell of the attack), then a long natural decay.
    function epNote(dest, freq, t0, dur, peak, oscs) {
        let c = ctx;
        let g = c.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(peak, t0 + 0.012);
        g.gain.exponentialRampToValueAtTime(peak * 0.45, t0 + Math.min(0.6, dur * 0.6));
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        g.connect(dest);
        let o1 = c.createOscillator();
        o1.type = 'sine';
        o1.frequency.setValueAtTime(freq, t0);
        o1.connect(g);
        let h = c.createGain();
        h.gain.setValueAtTime(0.0001, t0);
        h.gain.exponentialRampToValueAtTime(0.35, t0 + 0.01);
        h.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.35);
        h.connect(g);
        let o2 = c.createOscillator();
        o2.type = 'sine';
        o2.frequency.setValueAtTime(freq * 2, t0);
        o2.connect(h);
        [o1, o2].forEach(function(o) { o.start(t0); o.stop(t0 + dur + 0.05); oscs.push(o); });
    }
    // A struck note that only decays (marimba, celesta, music box): a sine plus
    // one overtone (`ratio` times the pitch) that dies away within `ring` seconds.
    function bellNote(dest, freq, t0, dur, peak, oscs, ratio, level, ring) {
        let c = ctx;
        let g = c.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(peak, t0 + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        g.connect(dest);
        let o1 = c.createOscillator();
        o1.type = 'sine';
        o1.frequency.setValueAtTime(freq, t0);
        o1.connect(g);
        let h = c.createGain();
        h.gain.setValueAtTime(0.0001, t0);
        h.gain.exponentialRampToValueAtTime(level, t0 + 0.004);
        h.gain.exponentialRampToValueAtTime(0.0001, t0 + ring);
        h.connect(g);
        let o2 = c.createOscillator();
        o2.type = 'sine';
        o2.frequency.setValueAtTime(freq * ratio, t0);
        o2.connect(h);
        [o1, o2].forEach(function(o) { o.start(t0); o.stop(t0 + dur + 0.05); oscs.push(o); });
    }
    // A soft string pad: two slightly detuned saws per note, slow in and out,
    // through a dark low-pass.
    function padChord(dest, notes, t0, dur, peak, oscs) {
        let c = ctx;
        let lp = c.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.setValueAtTime(750, t0);
        lp.Q.setValueAtTime(0.6, t0);
        lp.connect(dest);
        let g = c.createGain();
        let fade = Math.min(0.45, dur / 4);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(peak, t0 + fade);
        g.gain.setValueAtTime(peak, t0 + dur - fade);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
        g.connect(lp);
        notes.forEach(function(m) {
            [-6, 6].forEach(function(cents) {
                let o = c.createOscillator();
                o.type = 'sawtooth';
                o.frequency.setValueAtTime(midiHz(m), t0);
                o.detune.setValueAtTime(cents, t0);
                o.connect(g);
                o.start(t0); o.stop(t0 + dur + 0.05); oscs.push(o);
            });
        });
    }
    // A heartbeat thump: a low sine that drops in pitch as it fades.
    function thump(dest, freq, t0, peak, oscs) {
        let c = ctx;
        let o = c.createOscillator(), g = c.createGain();
        o.type = 'sine';
        o.frequency.setValueAtTime(freq * 1.6, t0);
        o.frequency.exponentialRampToValueAtTime(freq, t0 + 0.07);
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(peak, t0 + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.32);
        o.connect(g).connect(dest);
        o.start(t0); o.stop(t0 + 0.4); oscs.push(o);
    }
    // A soft tick-tock over the last two bars: time is almost up.
    function tickTock(dest, t0, beat, oscs, peak) {
        for (let i = THINK_BEATS - 8; i < THINK_BEATS - 1; i++)
            oscs.push(note(dest, i % 2 ? 620 : 820, t0 + i * beat, 0.04, 'sine', peak, 0.004, 0.03));
    }
    // Plays [note, beats] pairs through `play(freq, start, len, isLast)`; returns the end time.
    function melody(list, t0, beat, play) {
        let at = 0;
        list.forEach(function(n, i) {
            let len = n[1] * beat;
            if (n[0] != null) play(midiHz(n[0]), t0 + at, len, i == list.length - 1);
            at += len;
        });
        return t0 + at;
    }

    // Each tune's parts, scheduled from t0 into `bus` (straight to the warm
    // low-pass) and `lead` (the same, plus the soft echo). Returns the end time.
    const THINK_BUILD = {
        calm: function(bus, lead, t0, beat, oscs) {
            let end = melody(CALM_MELODY, t0, beat, function(f, t, len, last) {
                epNote(lead, f, t, last ? len + 1.2 : Math.max(len * 1.1, 0.35), last ? 0.13 : 0.15, oscs);
            });
            // Chords (on 1 and the "and" of 2) and a plucked bass (root on 1, fifth on 3)
            let bt = 0;
            CALM_CHORDS.forEach(function(ch, b) {
                let start = t0 + bt * beat, len = ch[3] * beat, final = b == CALM_CHORDS.length - 1;
                let hits = final ? [ [0, len + 1.4] ] : ch[3] >= 4 ? [ [0, 1.5 * beat], [1.5 * beat, 2.3 * beat] ] : [ [0, 0.9 * beat], [beat, 0.9 * beat] ];
                hits.forEach(function(hit) {
                    ch[0].forEach(function(m) { epNote(bus, midiHz(m), start + hit[0], hit[1], 0.035, oscs); });
                });
                oscs.push(note(bus, midiHz(ch[1]), start, final ? len + 1.2 : Math.min(len, 2 * beat) * 0.9, 'sine', 0.16, 0.012, 0.25));
                if (!final) oscs.push(note(bus, midiHz(ch[2]), start + Math.min(len, 2 * beat), Math.min(len, 2 * beat) * 0.85, 'sine', 0.12, 0.012, 0.2));
                bt += ch[3];
            });
            tickTock(bus, t0, beat, oscs, 0.035);
            return end;
        },
        marimba: function(bus, lead, t0, beat, oscs) {
            // The marimba: a short wooden ring, its overtone two octaves up (as on the real bars).
            let end = melody(MARIMBA_MELODY, t0, beat, function(f, t, len, last) {
                bellNote(lead, f, t, last ? 2.2 : Math.max(0.45, Math.min(0.9, len * 1.6)), 0.2, oscs, 4, 0.22, 0.05);
            });
            let bt = 0;
            MARIMBA_CHORDS.forEach(function(ch, b) {
                let start = t0 + bt * beat, final = b == MARIMBA_CHORDS.length - 1;
                if (final) {
                    ch[0].forEach(function(m) { bellNote(bus, midiHz(m), start, 2.4, 0.05, oscs, 4, 0.15, 0.05); });
                    oscs.push(note(bus, midiHz(ch[1]), start, 2.2, 'triangle', 0.15, 0.01, 1.2));
                } else {
                    // Light chords on 2 and 4, a plucked bass walking root, fifth, root, fifth.
                    for (let k = 1; k < ch[3]; k += 2)
                        ch[0].forEach(function(m) { bellNote(bus, midiHz(m), start + k * beat, 0.5, 0.04, oscs, 4, 0.12, 0.04); });
                    for (let k = 0; k < ch[3]; k++)
                        oscs.push(note(bus, midiHz(k % 2 ? ch[2] : ch[1]), start + k * beat, beat * 0.7, 'triangle', 0.15, 0.008, beat * 0.4));
                }
                bt += ch[3];
            });
            tickTock(bus, t0, beat, oscs, 0.03);
            return end;
        },
        suspense: function(bus, lead, t0, beat, oscs) {
            let bt = 0;
            SUSPENSE_BARS.forEach(function(bar, b) {
                let start = t0 + bt * beat, final = b == SUSPENSE_BARS.length - 1;
                let pad = bar[0];
                if (pad.length > 4) {   // two chords in one bar
                    padChord(bus, pad.slice(0, 3), start, 2 * beat + 0.4, 0.012, oscs);
                    padChord(bus, pad.slice(3), start + 2 * beat, 2 * beat + 0.4, 0.012, oscs);
                } else padChord(bus, pad, start, final ? 4 * beat + 1.6 : 4 * beat + 0.4, 0.012, oscs);   // each overlaps the next, so the pad never dips
                // The heartbeat: lub-dub on 1 (on every beat in the two bars before the end).
                let beats = b >= SUSPENSE_BARS.length - 3 && !final ? [0, 1, 2, 3] : [0];
                beats.forEach(function(k) {
                    let root = bar[4] && k >= 2 ? bar[4] : bar[1];
                    thump(bus, midiHz(root), start + k * beat, 0.32, oscs);
                    thump(bus, midiHz(root), start + k * beat + 0.28 * beat, 0.2, oscs);
                });
                // The celesta: a bell with a soft overtone an octave up.
                bar[2].forEach(function(m, i) {
                    let t = start + i * bar[3] * beat;
                    bellNote(lead, midiHz(m), t, final ? 3 : Math.max(0.7, bar[3] * beat * 2), final ? 0.12 : 0.1, oscs, 2, 0.3, 0.3);
                });
                bt += 4;
            });
            return t0 + THINK_BEATS * beat;
        },
        musicbox: function(bus, lead, t0, beat, oscs) {
            // The music box: a bright tine (its overtone a twelfth up, fading fast) that rings on.
            let end = melody(MUSICBOX_MELODY, t0, beat, function(f, t, len, last) {
                bellNote(lead, f, t, last ? 3 : 1.6, last ? 0.12 : 0.13, oscs, 3, 0.12, 0.2);
            });
            MUSICBOX_CHORDS.forEach(function(ch, b) {
                let start = t0 + b * 3 * beat, final = b == MUSICBOX_CHORDS.length - 1;
                // Oom-pah-pah: the bass on 1, a soft chord on 2 and 3 (all of it on 1 at the end).
                oscs.push(note(bus, midiHz(ch[1]), start, final ? 2.6 : beat * 0.9, 'triangle', 0.13, 0.008, final ? 1.6 : beat * 0.5));
                (final ? [0] : [1, 2]).forEach(function(k) {
                    ch[0].forEach(function(m) { bellNote(bus, midiHz(m), start + k * beat, final ? 2.8 : 0.6, final ? 0.04 : 0.03, oscs, 3, 0.08, 0.1); });
                });
            });
            return end;
        },
    };

    // Plays a tune into c (an AudioContext, or an OfflineAudioContext for the
    // tests) for `seconds`; returns { master, oscs, end, level } without
    // starting any stop logic.
    const THINK_LEVEL = { calm: 0.62, marimba: 0.8, suspense: 1.2, musicbox: 1.0 };   // about as loud as each other
    function scheduleThink(c, seconds, t0, tune) {
        tune = thinkTune(tune);
        let saved = ctx;
        ctx = c;
        let oscs = [ ];
        let secs = Math.max(10, Math.min(120, +seconds || 30));
        let bpm = Math.max(60, Math.min(140, THINK_BEATS * 60 / secs));   // 20.6 to 48 s fit exactly
        let beat = 60 / bpm;
        let level = THINK_LEVEL[tune];

        let master = c.createGain();
        master.gain.setValueAtTime(0.0001, t0);
        master.gain.exponentialRampToValueAtTime(level, t0 + 0.6);   // under the host's voice, not over it
        let warm = c.createBiquadFilter();                           // nothing shrill gets through
        warm.type = 'lowpass';
        warm.frequency.setValueAtTime(tune == 'musicbox' ? 3400 : 2600, t0);
        warm.Q.setValueAtTime(0.5, t0);
        warm.connect(master);
        // A little room: one soft echo under the lead.
        let echo = c.createDelay(1);
        echo.delayTime.setValueAtTime(beat * 0.75, t0);
        let echoBack = c.createGain(), echoOut = c.createGain();
        echoBack.gain.setValueAtTime(0.22, t0);
        echoOut.gain.setValueAtTime(tune == 'marimba' ? 0.12 : 0.2, t0);
        echo.connect(echoBack).connect(echo);
        echo.connect(echoOut).connect(warm);
        let lead = c.createGain();
        lead.gain.setValueAtTime(1, t0);
        lead.connect(warm);
        lead.connect(echo);

        let end = THINK_BUILD[tune](warm, lead, t0, beat, oscs);

        ctx = saved;
        return { master: master, oscs: oscs, end: end, level: level };
    }

    // Returns a function that stops the music.
    function playThinkMusic(seconds, tune) {
        let c = audioCtx();
        if (!c) return function() { };
        let t0 = c.currentTime + 0.05;
        let m = scheduleThink(c, seconds, t0, tune);
        let master = m.master, oscs = m.oscs;
        master.connect(c.destination);
        loopGain = master; loopLevel = m.level;

        let stopped = false;
        return function stop() {
            if (stopped) return;
            stopped = true;
            try {
                let now = c.currentTime;
                master.gain.cancelScheduledValues(now);
                master.gain.setValueAtTime(Math.max(master.gain.value, 0.0001), now);
                master.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
                setTimeout(function() { try { master.disconnect(); oscs.forEach(function(o) { try { o.stop(); } catch (e) { } }); } catch (e) { } }, 500);
            } catch (e) { }
        };
    }

    // Looping track (the Final Jeopardy! think timer). Uses sounds/think.* if
    // present; otherwise the built-in tune chosen in Settings (opts.tune).
    let loopName = null;
    let loopWasRunning = false;
    let musicStop = null;
    let loopGain = null, loopLevel = 0.62, ducked = false;
    function startLoop(name, opts) {
        stopLoop();
        stopPreview();
        if (!enabled) return;
        loopName = name;
        findFile(name).then(function(a) {
            if (loopName !== name) return; // stopped meanwhile
            if (a) {
                loopAudio = a;
                a.loop = true;
                a.volume = name == 'think' ? 0.7 : 1;
                a.currentTime = 0;
                a.play().catch(function() { });
            } else if (name == 'think') {
                musicStop = playThinkMusic(opts && opts.seconds, opts && opts.tune);
            }
        });
    }
    function stopLoop() {
        if (loopAudio) { try { loopAudio.pause(); loopAudio.loop = false; } catch (e) { } loopAudio = null; }
        if (musicStop) { musicStop(); musicStop = null; }
        loopName = null; loopGain = null; ducked = false;
    }
    // Settings' "Hear it" button: the first `seconds` (default 12) of a built-in
    // tune at the default 30-second tempo, then a fade. Plays even with sound
    // effects off (you asked for it); a second call stops the one before.
    // Returns a function that stops it.
    let previewStop = null, previewTimer = null;
    function previewThink(tune, seconds) {
        stopPreview();
        let stop = playThinkMusic(30, tune);
        previewStop = stop;
        previewTimer = setTimeout(stopPreview, (seconds || 12) * 1000);
        return stopPreview;
    }
    function stopPreview() {
        if (previewTimer) { clearTimeout(previewTimer); previewTimer = null; }
        if (previewStop) { let s = previewStop; previewStop = null; s(); if (!musicStop) loopGain = null; }
    }

    // Turn the music down (to a quarter) while the microphone listens, and back up.
    function duckLoop(on) {
        ducked = !!on;
        let level = on ? 0.25 : 1;
        if (loopAudio) { try { loopAudio.volume = (loopName == 'think' ? 0.7 : 1) * level; } catch (e) { } }
        if (loopGain && ctx) {
            try { let now = ctx.currentTime; loopGain.gain.cancelScheduledValues(now); loopGain.gain.setValueAtTime(Math.max(loopGain.gain.value, 0.0001), now); loopGain.gain.exponentialRampToValueAtTime(loopLevel * level, now + 0.3); } catch (e) { }
        }
    }
    JPClock.onPause(function() {
        loopWasRunning = !!loopName;
        if (loopAudio) { try { loopAudio.pause(); } catch (e) { } }
    });
    JPClock.onResume(function() {
        if (loopWasRunning && loopAudio) loopAudio.play().catch(function() { });
    });

    // ------------------------------------------------------ speech recognition

    function recognitionSupported() {
        if (typeof JPEar !== 'undefined' && JPEar.active()) return true;
        return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    }
    // What the recognizer did, session by session (the last 16), for the mic log in Settings.
    let micLog = [ ];
    function micLogAdd(entry) { micLog.push(entry); if (micLog.length > 16) micLog.shift(); }

    // Listen for up to `ms` milliseconds. Calls onInterim(text) as words arrive.
    // Resolves { text, alternatives, final, error } -- text may be '' if nothing heard.
    // Never rejects. The returned promise has a .stop() to end early.
    // opts.endOnFinal: resolve as soon as the recognizer finalizes a phrase
    // (right for a 5-second answer); otherwise keep listening until stopped.
    // ---- audio devices ---------------------------------------------------
    // Chrome labels devices after the microphone has been allowed once
    // ("MacBook Pro Microphone (Built-in)", "AirPods (Bluetooth)"); the
    // system defaults are listed again as "Default - ...".
    const HEADSET_RE = /bluetooth|airpods|beats|headphone|headset|earbuds?|\bbuds\b|\bpods\b|\bBT\b/i;
    const BUILTIN_RE = /built-in|internal|macbook|imac|mac mini|mac studio|mac pro|\bpc\b|realtek|array/i;
    function devices() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return Promise.resolve({ inputs: [ ], outputs: [ ], labeled: false });
        return navigator.mediaDevices.enumerateDevices().then(function(list) {
            let inputs = [ ], outputs = [ ];
            for (let d of list) {
                let e = { id: d.deviceId, label: d.label || '', group: d.groupId, isDefault: d.deviceId == 'default' };
                if (d.kind == 'audioinput') inputs.push(e); else if (d.kind == 'audiooutput') outputs.push(e);
            }
            return { inputs: inputs, outputs: outputs, labeled: inputs.some(function(d) { return !!d.label; }) };
        }).catch(function() { return { inputs: [ ], outputs: [ ], labeled: false }; });
    }
    function defaultOf(list) {
        let d = list.find(function(x) { return x.isDefault; });
        if (!d) return null;
        let label = d.label.replace(/^default\s*[-\u2013\u2014]\s*/i, '');
        let real = list.find(function(x) { return !x.isDefault && x.label && x.label == label; }) || (d.group ? list.find(function(x) { return !x.isDefault && x.group == d.group; }) : null);
        return { id: real ? real.id : 'default', label: label || (real ? real.label : ''), real: real };
    }
    // Which microphone to open. pref: 'auto', 'default', or a device id.
    // 'auto' = the system default, unless that's a Bluetooth headset and a
    // built-in mic exists: then the built-in one, so the headphones aren't
    // dropped to their low-quality call mode every time the game listens.
    function micChoice(pref) {
        return devices().then(function(dv) {
            let out = defaultOf(dv.outputs), inp = defaultOf(dv.inputs);
            let headphones = !!(out && HEADSET_RE.test(out.label));
            let res = { id: null, label: inp ? inp.label : '', why: 'the system default microphone', headphones: headphones, outLabel: out ? out.label : '' };
            if (pref && pref != 'auto' && pref != 'default') {
                let d = dv.inputs.find(function(x) { return x.id == pref; });
                if (d) return Object.assign(res, { id: d.id, label: d.label, why: 'chosen in Settings' });
                res.why = 'the system default microphone (the one chosen in Settings is not connected)';
                return res;
            }
            if (pref == 'auto' && inp && HEADSET_RE.test(inp.label)) {
                let builtin = dv.inputs.find(function(x) { return !x.isDefault && BUILTIN_RE.test(x.label) && !HEADSET_RE.test(x.label); });
                if (builtin) return Object.assign(res, { id: builtin.id, label: builtin.label, why: 'the built-in microphone, because the default (' + inp.label + ') is a headset' });
            }
            return res;
        });
    }
    // Route the game's own sounds (the studio voice, effects, music) to an
    // output device; '' or 'default' = the system default. The system voice
    // (speechSynthesis) always follows the system default.
    let outSink = '';
    function setOutput(id) {
        outSink = (id && id != 'default') ? id : '';
        try { if (ctx && ctx.setSinkId) ctx.setSinkId(outSink).catch(function() { }); } catch (e) { }
        for (let k in fileCache) { let a = fileCache[k]; if (a && a.setSinkId) { try { a.setSinkId(outSink).catch(function() { }); } catch (e) { } } }
    }
    function outputRoutable() { return !!(window.AudioContext && AudioContext.prototype.setSinkId); }

    // Opens the microphone for a moment to report which input it is and how
    // loud speech arrives (peak 0..1). Speech recognition itself has no gain
    // control; a low reading means the system input volume, not the game.
    function sampleInputLevel(ms, deviceId) {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return Promise.resolve(null);
        let constraints = { audio: deviceId ? { deviceId: { exact: deviceId } } : true };
        return navigator.mediaDevices.getUserMedia(constraints).catch(function() { return navigator.mediaDevices.getUserMedia({ audio: true }); }).then(function(stream) {
            let track = stream.getAudioTracks()[0];
            let label = track ? track.label : '';
            let AC = window.AudioContext || window.webkitAudioContext;
            if (!AC) { stream.getTracks().forEach(function(t) { t.stop(); }); return { label: label, peak: 0 }; }
            let ctx = new AC();
            let src = ctx.createMediaStreamSource(stream), an = ctx.createAnalyser();
            an.fftSize = 2048; src.connect(an);
            let buf = new Float32Array(an.fftSize), peak = 0;
            return new Promise(function(resolve) {
                let t0 = Date.now();
                (function tick() {
                    an.getFloatTimeDomainData(buf);
                    let sum = 0; for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
                    let rms = Math.sqrt(sum / buf.length);
                    if (rms > peak) peak = rms;
                    if (Date.now() - t0 < ms) requestAnimationFrame(tick);
                    else { stream.getTracks().forEach(function(t) { t.stop(); }); ctx.close().catch(function() { }); resolve({ label: label, peak: Math.min(1, peak * 3) }); }
                })();
            });
        }).catch(function() { return null; });
    }

    function listen(ms, onInterim, opts) {
        opts = opts || { };
        // The studio ear (on-device Whisper) takes over when it is loaded and chosen.
        if (typeof JPEar !== 'undefined' && JPEar.active()) return JPEar.listen(ms, onInterim, opts);
        let SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        let stopFn = function() { }, abortFn = function() { };
        let handle = { onInterim: null, done: false };
        let entry = { engine: 'chrome', at: new Date().toLocaleTimeString(), ms: ms, events: [ ], result: '' };
        let t0 = performance.now();
        function logEv(name) { entry.events.push(Math.round(performance.now() - t0) + 'ms ' + name); }
        micLogAdd(entry);
        let p = new Promise(function(resolve) {
            if (!SR) { resolve({ text: '', alternatives: [ ], final: false, error: 'unsupported' }); return; }
            let rec;
            try { rec = new SR(); } catch (e) { logEv('init failed'); resolve({ text: '', alternatives: [ ], final: false, error: 'init' }); return; }
            rec.lang = 'en-US';
            rec.interimResults = true;
            rec.continuous = true;                            // a phrase that's only "what is..." must not end the session
            rec.maxAlternatives = 5;
            rec.onstart = function() { logEv('start'); };
            rec.onaudiostart = function() { logEv('audio'); };
            rec.onspeechstart = function() { logEv('speech'); };
            rec.onspeechend = function() { logEv('speech end'); };
            rec.onnomatch = function() { logEv('no match'); };

            let best = '', alts = [ ], done = false, gotFinal = false, err = null, lastSegments = [ ];
            let finish = function() {
                if (done) return;
                done = true;
                handle.done = true;
                clearTimeout(timer);
                try { rec.onresult = null; rec.onend = null; rec.onerror = null; rec.abort(); } catch (e) { }
                logEv('end' + (err ? ' (' + err + ')' : '') + (best.trim() ? ' "' + best.trim().slice(0, 60) + '"' : ' — nothing'));
                entry.result = best.trim(); entry.error = err;
                resolve({ text: best.trim(), alternatives: alts, final: gotFinal, error: err, segments: lastSegments });
            };
            let timer = setTimeout(function() {
                // Ask for a final result, then give it a beat to arrive.
                try { rec.stop(); } catch (e) { }
                setTimeout(finish, 350);
            }, ms);

            rec.onresult = function(ev) {
                let text = '', a = [ ], segments = [ ], finalCount = 0;
                for (let i = 0; i < ev.results.length; i++) {
                    let r = ev.results[i];
                    text += r[0].transcript + ' ';
                    if (r.isFinal) {
                        gotFinal = true;
                        finalCount++;
                        let seg = [ ];
                        for (let j = 0; j < r.length; j++) seg.push(r[j].transcript);
                        segments.push(seg);              // each finished phrase with its alternatives
                        for (let j = 0; j < r.length; j++) a.push(r[j].transcript);
                    }
                }
                best = text;
                if (a.length) alts = a;
                lastSegments = segments;
                // The handler can be swapped after the fact (handle.onInterim), so a
                // recognizer started early can be handed to whoever needs it next.
                let cb = handle.onInterim || onInterim;
                if (cb) cb(best.trim(), gotFinal, segments, text.trim());
                if (finalCount) logEv('result #' + finalCount + ' "' + text.trim().slice(0, 40) + '"');
                // One real phrase is the answer; a bare "what is" or "um" keeps listening.
                if (gotFinal && opts.endOnFinal && segments.some(function(seg) { return !(typeof JPJudge !== 'undefined' && JPJudge.contentFree(seg[0])); })) finish();
            };
            rec.onerror = function(e) { err = e.error; logEv('error ' + e.error); if (e.error == 'not-allowed' || e.error == 'service-not-allowed' || e.error == 'audio-capture') finish(); };
            rec.onend = function() { if (!done) { /* Chrome ended it early (silence); keep what we have. */ finish(); } };
            stopFn = function() { try { rec.stop(); } catch (e) { } setTimeout(finish, 300); };
            abortFn = finish;                                 // release the microphone right now; keep what was heard
            try { rec.start(); } catch (e) { err = 'start'; finish(); }
        });
        p.stop = function() { stopFn(); };
        p.abort = function() { abortFn(); };
        p.handle = handle;                                  // .onInterim (swap the callback), .done
        Object.defineProperty(p, 'onInterim', { set: function(f) { handle.onInterim = f; }, get: function() { return handle.onInterim; } });
        Object.defineProperty(p, 'done', { get: function() { return handle.done; } });
        return p;
    }

    return {
        voices: voices,
        defaultHostVoice: defaultHostVoice,
        hasEnhancedVoice: hasEnhancedVoice,
        voiceByName: voiceByName,
        contestantVoices: contestantVoices,
        htmlToSpeech: htmlToSpeech,
        speak: speak,
        stopSpeaking: stopSpeaking,
        setEnabled: setEnabled,
        context: audioCtx,
        preload: preload,
        play: play,
        startLoop: startLoop,
        scheduleThink: scheduleThink,   // for the tests: render the think music offline
        thinkTunes: THINK_TUNES, thinkDefault: THINK_DEFAULT, previewThink: previewThink, stopPreview: stopPreview,
        stopLoop: stopLoop,
        duckLoop: duckLoop,
        devices: devices, micChoice: micChoice, setOutput: setOutput, outputRoutable: outputRoutable,
        recognitionSupported: recognitionSupported,
        listen: listen, sampleInputLevel: sampleInputLevel, get micLog() { return micLog; },
        SFX_FILES: SFX_FILES,
    };
})();
