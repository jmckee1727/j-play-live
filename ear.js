// ear.js -- JPEar: the game page's side of the studio ear (on-device speech
// recognition). It opens the microphone while listening, cuts the feed into
// utterances (a simple energy detector finds where speech starts and stops),
// and sends each one to the recognizer in the offscreen page (offscreen/ear.js,
// Whisper).
//
// JPEar.listen(ms, onInterim, opts) has the same shape as JPAudio's Chrome
// recognizer, so the game uses either without knowing:
//   returns a promise of { text, alternatives, final, error, segments },
//   with .stop(), .onInterim (swappable) and .done; onInterim(text, gotFinal,
//   segments) is called once per finished utterance (segments: [[text]]).
//
// Nothing here leaves the computer: audio goes to the extension's own hidden
// page and comes back as text.

var JPEar = (function() {
    'use strict';

    const RATE = 16000;
    let state = { loaded: false, loading: false, size: null, device: null, error: null, progress: null, enabled: true, micError: null };
    let listeners = [ ];
    function emit(ev) { listeners.forEach(function(f) { try { f(ev, state); } catch (e) { } }); }
    function onStatus(f) { listeners.push(f); return function() { listeners = listeners.filter(function(x) { return x !== f; }); }; }

    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.addListener(function(msg) {
            if (!msg || msg.type != 'ear-event') return;
            if (msg.event == 'progress') { state.progress = { loaded: msg.loaded, total: msg.total, file: msg.file, status: msg.status }; emit('progress'); }
            else if (msg.event == 'loaded') { state.loaded = true; state.loading = false; state.size = msg.size; state.device = msg.device; state.error = null; emit('loaded'); }
            else if (msg.event == 'error') { state.loading = false; state.error = msg.error; emit('error'); }
        });
    }

    function rpc(op, data) { return JPNeural.rpc(op, data); }
    function available() { return typeof JPNeural !== 'undefined' && JPNeural.available(); }

    async function caps() {
        let c = await rpc('ear-caps');
        state.loaded = !!c.loaded; state.size = c.size; state.device = c.device;
        return c;
    }
    async function load(size, device) {
        if (state.loading) return;
        state.loading = true; state.error = null; state.progress = null; emit('loading');
        let r;
        try { r = await rpc('ear-load', { size: size, device: device }); }
        catch (e) { r = { ok: false, error: e.message || String(e) }; }
        if (!r.ok && device == 'webgpu') {
            try { r = await rpc('ear-load', { size: size, device: 'wasm' }); } catch (e) { r = { ok: false, error: e.message || String(e) }; }
        }
        if (!r.ok) { state.loading = false; state.loaded = false; state.error = r.error || 'could not load'; emit('error'); throw new Error(state.error); }
        state.loaded = true; state.loading = false; state.size = r.size; state.device = r.device; emit('loaded');
        return r;
    }
    async function unload() { try { await rpc('ear-unload'); } catch (e) { } state.loaded = false; state.size = null; state.device = null; emit('unloaded'); }

    // ---- the microphone --------------------------------------------------
    let ctx = null, stream = null, source = null, proc = null, track = null;
    let ring = new Float32Array(RATE * 2), ringPos = 0;         // the last 2 s, for the pre-roll
    let session = null;                                          // the active listen(), if any
    let opening = null;                                          // openMic() in flight
    let sessionStart = 0;                                        // for log timestamps
    function mlog(m) { JPEar.log.push({ t: Math.round(performance.now() - (sessionStart || performance.now())), m: m }); if (JPEar.log.length > 200) JPEar.log.shift(); }

    // The microphone opens when a listen() starts and closes shortly after the
    // last one ends (an open mic changes how Bluetooth headphones sound, so it
    // isn't held between clues). While it is open the feed is watched: a stream
    // can go dead on some systems (a Mac with AirPods switching profiles, a
    // device change), turning into exact zeros while a fresh one would be fine;
    // then, or when the track ends, the mic is reopened.
    let closeTimer = null;
    let micPref = 'auto';                                        // 'auto' | 'default' | a device id (see JPAudio.micChoice)
    function setMicPreference(p) { micPref = p || 'auto'; }
    function openMic() {
        if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
        if (proc) return Promise.resolve(true);
        if (opening) return opening;
        opening = openMicNow().then(function(ok) { opening = null; return ok; }, function(e) { opening = null; state.micError = (e && e.message) || 'mic error'; return false; });
        return opening;
    }
    async function openMicNow() {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { state.micError = 'no microphone access'; return false; }
        let st, choice = null;
        try { choice = (typeof JPAudio !== 'undefined' && JPAudio.micChoice) ? await JPAudio.micChoice(micPref) : null; } catch (e) { choice = null; }
        // Echo cancellation only when the sound comes out of speakers the mic can
        // hear; with headphones it's needless, and on a Mac engaging it can
        // reconfigure the output for a moment (an audible hiccup).
        let aec = !(choice && choice.headphones);
        let base = { echoCancellation: aec, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
        try {
            if (choice && choice.id && choice.id != 'default') {
                try { st = await navigator.mediaDevices.getUserMedia({ audio: Object.assign({ deviceId: { exact: choice.id } }, base) }); }
                catch (e) { mlog('mic ' + choice.label + ' could not be opened (' + (e && e.name) + '); using the default'); choice = null; st = await navigator.mediaDevices.getUserMedia({ audio: base }); }
            } else st = await navigator.mediaDevices.getUserMedia({ audio: base });
        } catch (e) { state.micError = e && e.name == 'NotAllowedError' ? 'not-allowed' : (e && e.message) || 'mic error'; mlog('mic open failed: ' + state.micError); return false; }
        if (proc) { st.getTracks().forEach(function(t) { t.stop(); }); return true; }   // someone else opened it meanwhile
        stream = st;
        track = stream.getAudioTracks()[0] || null;
        let AC = window.AudioContext || window.webkitAudioContext;
        // The context runs at the device's own rate; the feed is resampled here.
        // (Forcing 16 kHz on the context has its own quirks on some systems.)
        ctx = new AC();
        if (ctx.state != 'running') { try { await ctx.resume(); } catch (e) { } }
        if (ctx.state != 'running') {
            // Started before any user gesture: resume on the next one.
            let tryResume = function() { if (ctx) ctx.resume().catch(function() { }); document.removeEventListener('click', tryResume, true); document.removeEventListener('keydown', tryResume, true); };
            document.addEventListener('click', tryResume, true); document.addEventListener('keydown', tryResume, true);
        }
        source = ctx.createMediaStreamSource(stream);
        proc = ctx.createScriptProcessor(4096, 1, 1);
        let ratio = ctx.sampleRate / RATE, mine = proc;
        proc.onaudioprocess = function(ev) {
            if (proc !== mine) return;
            feed(decimate(ev.inputBuffer.getChannelData(0), ratio));
        };
        source.connect(proc);
        proc.connect(ctx.destination);                            // Chrome only runs a ScriptProcessor that is connected; it outputs silence
        zeroRun = 0; pendLen = 0;
        let ts = (track && track.getSettings) ? track.getSettings() : { };
        mlog('mic open: ' + (track ? track.label : '?') + ' (' + (ts.sampleRate || '?') + ' Hz in, context ' + ctx.sampleRate + ' Hz ' + ctx.state + '; ' + (choice ? choice.why : 'default') + (choice && choice.outLabel ? '; output ' + choice.outLabel : '') + '; echo cancellation ' + (aec ? 'on' : 'off') + ')');
        if (track) {
            track.onmute = function() { mlog('mic track muted by the system'); };
            track.onunmute = function() { mlog('mic track unmuted'); };
            track.onended = function() { if (track === this) reopenMic('track ended'); };
        }
        let myCtx = ctx;
        ctx.onstatechange = function() { if (ctx === myCtx) mlog('audio context ' + myCtx.state); };
        state.micError = null;
        return true;
    }
    function closeMic() {
        try { if (proc) { proc.disconnect(); proc.onaudioprocess = null; } if (source) source.disconnect(); if (track) { track.onended = null; track.onmute = null; track.onunmute = null; } if (stream) stream.getTracks().forEach(function(t) { t.stop(); }); if (ctx) { ctx.onstatechange = null; ctx.close().catch(function() { }); } } catch (e) { }
        proc = null; source = null; stream = null; ctx = null; track = null;
        zeroRun = 0; pendLen = 0;
        ring.fill(0); ringPos = 0;                                // no stale pre-roll next time
        if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    }
    // Close when the last session ends -- at once, or after a short linger for
    // loops that start the next session right away (picking by voice).
    function releaseMic(lingerMs) {
        if (session || closeTimer || !stream) return;
        if (!lingerMs) { closeMic(); return; }
        closeTimer = setTimeout(function() { closeTimer = null; if (!session) closeMic(); }, lingerMs);
    }
    function micLabel() { let t = stream && stream.getAudioTracks()[0]; return t ? t.label : ''; }
    function micState() {
        if (!stream) return 'not open';
        let t = track || stream.getAudioTracks()[0];
        return (t ? t.label + ' ' + t.readyState + (t.muted ? ' muted' : '') : 'no track') + (ctx ? ', context ' + ctx.state : '');
    }

    let reopening = false, reopens = 0, lastReopen = -1e9;
    function reopenMic(why) {
        if (reopening || !stream) return;
        let now = performance.now();
        // Not more than once every few seconds; and if reopening never brings
        // audio (a muted headset, say), back off to once a minute.
        if (now - lastReopen < (reopens >= 5 ? 60000 : 6000)) return;
        reopening = true; reopens++; lastReopen = now;
        mlog('mic ' + why + ' (' + micState() + '); reopening');
        closeMic();
        openMic().then(function(ok) {
            reopening = false;
            if (!ok) mlog('mic reopen failed: ' + state.micError);
        });
    }

    // Box-filter decimation from the context's rate to 16 kHz (ratio 3 at 48 kHz).
    function decimate(inp, ratio) {
        if (ratio == 1) return inp;
        let n = Math.floor(inp.length / ratio), out = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            let a = Math.floor(i * ratio), b = Math.max(a + 1, Math.floor((i + 1) * ratio)), s = 0;
            for (let j = a; j < b; j++) s += inp[j];
            out[i] = s / (b - a);
        }
        return out;
    }

    // ---- utterance detection ----------------------------------------------
    // Energy over 32 ms frames against a noise floor that adapts to the room.
    const FRAME = 512;                                            // 32 ms at 16 kHz
    const MIN_SPEECH = 8;                                         // frames of sound that make an utterance (256 ms)
    let noise = 0.004, level = 0;
    let pend = new Float32Array(FRAME), pendLen = 0;             // samples waiting to make a whole frame
    let zeroRun = 0;                                              // consecutive samples of exact digital silence
    const DEAD_AFTER = RATE * 1.5;                                // 1.5 s of exact zeros: the stream is dead
    function rms(buf, from, to) { let s = 0; for (let i = from; i < to; i++) s += buf[i] * buf[i]; return Math.sqrt(s / Math.max(1, to - from)); }

    function feed(chunk) {
        // the ring buffer keeps the last two seconds for the pre-roll
        for (let i = 0; i < chunk.length; i++) { ring[ringPos] = chunk[i]; ringPos = (ringPos + 1) % ring.length; }
        // whole 32 ms frames, carrying the remainder to the next chunk
        let i = 0;
        while (i < chunk.length) {
            let take = Math.min(FRAME - pendLen, chunk.length - i);
            pend.set(chunk.subarray(i, i + take), pendLen); pendLen += take; i += take;
            if (pendLen == FRAME) { pendLen = 0; frameIn(pend); }
        }
    }
    function frameIn(frame) {
        let e = rms(frame, 0, FRAME);
        level = e;
        if (e === 0) { zeroRun += FRAME; if (zeroRun >= DEAD_AFTER) { zeroRun = 0; reopenMic('feed is digital silence'); } }
        else { zeroRun = 0; reopens = 0; }
        if (!session || !session.inSpeech) noise = noise * 0.97 + e * 0.03;   // adapt only when nobody is talking
        if (session) session.frame(frame, e);
    }
    function preroll(ms) {
        let n = Math.min(ring.length, Math.floor(RATE * ms / 1000)), out = new Float32Array(n);
        for (let i = 0; i < n; i++) out[i] = ring[(ringPos - n + i + ring.length) % ring.length];
        return out;
    }

    function floatToPcm16Base64(f32) {
        let i16 = new Int16Array(f32.length);
        for (let i = 0; i < f32.length; i++) { let v = Math.max(-1, Math.min(1, f32[i])); i16[i] = v < 0 ? v * 32768 : v * 32767; }
        let bytes = new Uint8Array(i16.buffer), s = '';
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return btoa(s);
    }

    // ---- listen() ----------------------------------------------------------
    function listen(ms, onInterim, opts) {
        opts = opts || { };
        let handle = { onInterim: null, done: false };
        let stopFn = function() { }, abortFn = function() { };
        let p = new Promise(function(resolve) {
            let text = '', segments = [ ], gotFinal = false, gotContent = false, err = null, done = false, pending = 0, stopping = false;
            let s = {
                inSpeech: false, buf: [ ], bufLen: 0, speechFrames: 0, silentFrames: 0, started: performance.now(), lastLevel: 0,
                frame: function(frame, e) {
                    let thr = Math.max(0.006, noise * 3.5);
                    if (!this.inSpeech) {
                        if (e > thr) { this.inSpeech = true; this.speechFrames = 1; this.silentFrames = 0; this.buf = [ preroll(320) ]; this.bufLen = this.buf[0].length; this.push(frame); log('speech start (level ' + e.toFixed(3) + ', floor ' + noise.toFixed(3) + ')'); }
                        return;
                    }
                    this.push(frame);
                    if (e > thr * 0.7) { this.speechFrames++; this.silentFrames = 0; } else this.silentFrames++;
                    let secs = this.bufLen / RATE;
                    // 550 ms of quiet ends the utterance; 12 s caps it. Fewer than
                    // 8 frames (a quarter second) of sound is a click or a cough,
                    // not a response: dropped, and the window stays open.
                    if ((this.silentFrames >= 17 && this.speechFrames >= MIN_SPEECH) || secs > 12) this.flush(false);
                    else if (this.silentFrames >= 25 && this.speechFrames < MIN_SPEECH) { this.inSpeech = false; this.buf = [ ]; this.bufLen = 0; log('noise, not speech (' + this.speechFrames + ' frames); ignored'); }
                },
                push: function(frame) { this.buf.push(new Float32Array(frame)); this.bufLen += frame.length; },
                flush: function(final) {
                    if (!this.inSpeech) return;
                    let all = new Float32Array(this.bufLen), o = 0;
                    for (let b of this.buf) { all.set(b, o); o += b.length; }
                    this.inSpeech = false; this.buf = [ ]; this.bufLen = 0; this.speechFrames = 0; this.silentFrames = 0;
                    transcribe(all);
                },
            };
            function log(m) { JPEar.log.push({ t: Math.round(performance.now() - s.started), m: m }); if (JPEar.log.length > 200) JPEar.log.shift(); }
            function transcribe(audio) {
                pending++;
                let t0 = performance.now();
                let secs = (audio.length / RATE).toFixed(1);
                log('utterance ' + secs + ' s -> recognizer');
                rpc('ear-transcribe', { pcm: floatToPcm16Base64(audio) }).then(function(r) {
                    pending--;
                    let t = String(r.text || '').trim();
                    log('heard "' + t + '" in ' + Math.round(performance.now() - t0) + ' ms');
                    if (t) {
                        gotFinal = true;
                        segments.push([ t ]);
                        text = segments.map(function(x) { return x[0]; }).join(' ');
                        let cb = handle.onInterim || onInterim;
                        if (cb) { try { cb(text, true, segments.slice()); } catch (e) { } }
                        // One real phrase is the answer; a bare "what is" keeps the mic open for the rest.
                        if (opts.endOnFinal && !(typeof JPJudge !== 'undefined' && JPJudge.contentFree(t))) { gotContent = true; finish(); }
                    }
                    if (stopping && !pending) finish();
                }, function(e) {
                    pending--;
                    err = (e && e.message) || 'recognizer error';
                    log('recognizer error: ' + err);
                    if (stopping && !pending) finish();
                });
            }
            function finish() {
                if (done) return;
                done = true; handle.done = true;
                clearTimeout(timer);
                if (session === s) session = null;
                releaseMic(opts.linger);
                resolve({ text: text, alternatives: segments.length ? segments[segments.length - 1].slice() : [ ], final: gotFinal, error: err, segments: segments });
            }
            let timer = setTimeout(function() { stopFn(); }, ms);
            stopFn = function() {
                if (done || stopping) return;
                stopping = true;
                // Hear out what was being said -- unless one phrase was all that was wanted and it's in.
                if (s.inSpeech && s.speechFrames >= MIN_SPEECH && !(opts.endOnFinal && gotContent)) s.flush(true);
                if (!pending) finish(); else setTimeout(finish, 4000);     // but don't wait forever for it
            };
            abortFn = function() {
                if (done) return;
                stopping = true;
                s.inSpeech = false; s.buf = [ ]; s.bufLen = 0;           // whatever was in progress is dropped
                finish();
                closeMic();
            };
            openMic().then(function(ok) {
                if (!ok) { err = state.micError || 'audio-capture'; if (err == 'not-allowed') err = 'not-allowed'; finish(); return; }
                if (session) { try { session.flush(false); } catch (e) { } }
                session = s; sessionStart = s.started;
                log('listening (' + ms + ' ms; ' + micState() + ', level ' + level.toFixed(3) + ', floor ' + noise.toFixed(3) + ')');
                if (zeroRun >= RATE / 2) { zeroRun = 0; reopenMic('feed silent at the start of listening'); }   // don't wait for the watchdog
            });
        });
        p.stop = function() { stopFn(); };
        p.abort = function() { abortFn(); };
        p.handle = handle;
        Object.defineProperty(p, 'onInterim', { set: function(f) { handle.onInterim = f; }, get: function() { return handle.onInterim; } });
        Object.defineProperty(p, 'done', { get: function() { return handle.done; } });
        return p;
    }

    function active() { return state.enabled && state.loaded; }

    return {
        available: available, caps: caps, load: load, unload: unload, listen: listen, onStatus: onStatus,
        openMic: openMic, closeMic: closeMic, micLabel: micLabel, micState: micState, active: active, setMicPreference: setMicPreference,
        get state() { return state; }, get ready() { return state.loaded; }, get level() { return level; }, get noise() { return noise; },
        set enabled(v) { state.enabled = !!v; }, get enabled() { return state.enabled; },
        log: [ ],
    };
})();
