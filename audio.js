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
        }
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

    // An original 30-second tune for the Final Jeopardy! think time, played
    // when there is no sounds/think.* file. (The show's own music is Sony's
    // and isn't bundled; drop your own file in to replace this.)
    //
    // 14 bars of 4/4 at 112 bpm = 30.0 s: a gentle I-vi-IV-V melody with a
    // soft pad, a bass line and a clock tick on every beat, ending on a bell.
    const THINK_BPM = 112;
    const THINK_MELODY = [                    // MIDI note per quarter note, bar by bar
        76, 79, 81, 79,   76, 72, 74, 76,   77, 81, 79, 77,   74, 76, 74, 71,
        72, 76, 79, 76,   81, 79, 76, 72,   74, 77, 81, 77,   79, 77, 74, 71,
        81, 77, 72, 77,   79, 74, 71, 74,   76, 79, 83, 79,   81, 76, 72, 76,
        74, 77, 79, 83,   84, null, null, null,
    ];
    const THINK_CHORDS = [                    // [pad notes], bass note, per bar (bar 13 changes mid-bar)
        [ [60, 67], 48 ], [ [57, 64], 45 ], [ [53, 60], 41 ], [ [55, 62], 43 ],
        [ [60, 67], 48 ], [ [57, 64], 45 ], [ [50, 57], 38 ], [ [55, 62], 43 ],
        [ [53, 60], 41 ], [ [55, 62], 43 ], [ [52, 59], 40 ], [ [57, 64], 45 ],
        [ [50, 57], 38, [55, 62], 43 ], [ [60, 67], 48 ],
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

    // Returns a function that stops the music.
    function playThinkMusic() {
        let c = audioCtx();
        if (!c) return function() { };
        let master = c.createGain();
        master.gain.setValueAtTime(0.0001, c.currentTime);
        master.gain.exponentialRampToValueAtTime(0.62, c.currentTime + 0.4);   // under the host's voice, not over it
        master.connect(c.destination);
        let beat = 60 / THINK_BPM, bar = beat * 4;
        let t0 = c.currentTime + 0.05;
        let oscs = [ ];

        // Melody
        THINK_MELODY.forEach(function(m, i) {
            if (m == null) return;
            let dur = (i == THINK_MELODY.length - 4) ? beat * 3.6 : beat * 0.95;   // the last note rings
            oscs.push(note(master, midiHz(m), t0 + i * beat, dur, 'triangle', 0.16, 0.02, 0.12));
        });
        // Pad + bass, per bar
        THINK_CHORDS.forEach(function(ch, b) {
            let halves = ch.length > 2 ? [ [ch[0], ch[1], 0, bar / 2], [ch[2], ch[3], bar / 2, bar / 2] ] : [ [ch[0], ch[1], 0, bar] ];
            halves.forEach(function(hv) {
                let start = t0 + b * bar + hv[2], len = hv[3];
                hv[0].forEach(function(m) { oscs.push(note(master, midiHz(m), start, len * 0.98, 'sine', 0.05, 0.15, 0.3)); });
                oscs.push(note(master, midiHz(hv[1]), start, len * 0.9, 'sine', 0.11, 0.03, 0.2));
                oscs.push(note(master, midiHz(hv[1]), start + len / 2, len * 0.4, 'sine', 0.07, 0.03, 0.15));
            });
        });
        // Clock tick on every beat, slightly stronger on the downbeat
        for (let i = 0; i < THINK_MELODY.length; i++)
            oscs.push(note(master, i % 4 == 0 ? 1760 : 1320, t0 + i * beat, 0.05, 'sine', i % 4 == 0 ? 0.05 : 0.03, 0.005, 0.03));
        // Closing bell
        let tEnd = t0 + THINK_MELODY.length * beat - beat * 0.4;
        oscs.push(note(master, midiHz(88), tEnd, 1.6, 'sine', 0.14, 0.01, 1.2));
        oscs.push(note(master, midiHz(95), tEnd, 1.2, 'sine', 0.06, 0.01, 0.9));

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
    // present; otherwise the built-in tune above.
    let loopName = null;
    let loopWasRunning = false;
    let musicStop = null;
    function startLoop(name) {
        stopLoop();
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
                musicStop = playThinkMusic();
            }
        });
    }
    function stopLoop() {
        if (loopAudio) { try { loopAudio.pause(); loopAudio.loop = false; } catch (e) { } loopAudio = null; }
        if (musicStop) { musicStop(); musicStop = null; }
        loopName = null;
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
        return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
    }

    // Listen for up to `ms` milliseconds. Calls onInterim(text) as words arrive.
    // Resolves { text, alternatives, final, error } -- text may be '' if nothing heard.
    // Never rejects. The returned promise has a .stop() to end early.
    // opts.endOnFinal: resolve as soon as the recognizer finalizes a phrase
    // (right for a 5-second answer); otherwise keep listening until stopped.
    // Opens the microphone for a moment to report which input it is and how
    // loud speech arrives (peak 0..1). Speech recognition itself has no gain
    // control; a low reading means the system input volume, not the game.
    function sampleInputLevel(ms) {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return Promise.resolve(null);
        return navigator.mediaDevices.getUserMedia({ audio: true }).then(function(stream) {
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
        let SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        let stopFn = function() { };
        let handle = { onInterim: null, done: false };
        let p = new Promise(function(resolve) {
            if (!SR) { resolve({ text: '', alternatives: [ ], final: false, error: 'unsupported' }); return; }
            let rec;
            try { rec = new SR(); } catch (e) { resolve({ text: '', alternatives: [ ], final: false, error: 'init' }); return; }
            rec.lang = 'en-US';
            rec.interimResults = true;
            rec.continuous = !opts.endOnFinal;
            rec.maxAlternatives = 5;

            let best = '', alts = [ ], done = false, gotFinal = false, err = null, lastSegments = [ ];
            let finish = function() {
                if (done) return;
                done = true;
                handle.done = true;
                clearTimeout(timer);
                try { rec.onresult = null; rec.onend = null; rec.onerror = null; rec.abort(); } catch (e) { }
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
                if (gotFinal && opts.endOnFinal) finish();
            };
            rec.onerror = function(ev) { err = ev.error; if (ev.error == 'not-allowed' || ev.error == 'service-not-allowed' || ev.error == 'audio-capture') finish(); };
            rec.onend = function() { if (!done) { /* Chrome ended it early (silence); keep what we have. */ finish(); } };
            stopFn = function() { try { rec.stop(); } catch (e) { } setTimeout(finish, 300); };
            try { rec.start(); } catch (e) { err = 'start'; finish(); }
        });
        p.stop = function() { stopFn(); };
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
        stopLoop: stopLoop,
        recognitionSupported: recognitionSupported,
        listen: listen, sampleInputLevel: sampleInputLevel,
        SFX_FILES: SFX_FILES,
    };
})();
