// ear.js -- JPEar: the game page's side of the studio ear (on-device speech
// recognition). It opens the microphone once, listens for utterances (a
// simple energy detector finds where speech starts and stops), and sends each
// one to the recognizer in the offscreen page (offscreen/ear.js, Whisper).
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
    let ctx = null, stream = null, source = null, proc = null;
    let ring = new Float32Array(RATE * 2), ringPos = 0;         // the last 2 s, for the pre-roll
    let session = null;                                          // the active listen(), if any

    async function openMic() {
        if (proc) return true;
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { state.micError = 'no microphone access'; return false; }
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
        } catch (e) { state.micError = e && e.name == 'NotAllowedError' ? 'not-allowed' : (e && e.message) || 'mic error'; return false; }
        let AC = window.AudioContext || window.webkitAudioContext;
        try { ctx = new AC({ sampleRate: RATE }); } catch (e) { ctx = new AC(); }
        source = ctx.createMediaStreamSource(stream);
        proc = ctx.createScriptProcessor(4096, 1, 1);
        let ratio = ctx.sampleRate / RATE;                       // 1 when the context runs at 16 kHz
        proc.onaudioprocess = function(ev) {
            let inp = ev.inputBuffer.getChannelData(0);
            let out;
            if (ratio == 1) out = inp;
            else { let n = Math.floor(inp.length / ratio); out = new Float32Array(n); for (let i = 0; i < n; i++) out[i] = inp[Math.floor(i * ratio)]; }
            feed(out);
        };
        source.connect(proc);
        proc.connect(ctx.destination);                            // Chrome only runs a ScriptProcessor that is connected; it outputs silence
        state.micError = null;
        return true;
    }
    function closeMic() {
        try { if (proc) { proc.disconnect(); proc.onaudioprocess = null; } if (source) source.disconnect(); if (stream) stream.getTracks().forEach(function(t) { t.stop(); }); if (ctx) ctx.close(); } catch (e) { }
        proc = null; source = null; stream = null; ctx = null;
    }
    function micLabel() { let t = stream && stream.getAudioTracks()[0]; return t ? t.label : ''; }

    // ---- utterance detection ----------------------------------------------
    // Energy over 32 ms frames against a noise floor that adapts to the room.
    const FRAME = 512;                                            // 32 ms at 16 kHz
    let noise = 0.004, level = 0;
    function rms(buf, from, to) { let s = 0; for (let i = from; i < to; i++) s += buf[i] * buf[i]; return Math.sqrt(s / Math.max(1, to - from)); }

    function feed(chunk) {
        // the ring buffer keeps the last two seconds for the pre-roll
        for (let i = 0; i < chunk.length; i++) { ring[ringPos] = chunk[i]; ringPos = (ringPos + 1) % ring.length; }
        for (let off = 0; off + FRAME <= chunk.length; off += FRAME) {
            let e = rms(chunk, off, off + FRAME);
            level = e;
            if (!session || !session.inSpeech) noise = noise * 0.97 + e * 0.03;   // adapt only when nobody is talking
            if (session) session.frame(chunk.subarray(off, off + FRAME), e);
        }
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
        let stopFn = function() { };
        let p = new Promise(function(resolve) {
            let text = '', segments = [ ], gotFinal = false, err = null, done = false, pending = 0, stopping = false;
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
                    // 550 ms of quiet ends the utterance; 12 s caps it.
                    if ((this.silentFrames >= 17 && this.speechFrames >= 3) || secs > 12) this.flush(false);
                    else if (this.silentFrames >= 25 && this.speechFrames < 3) { this.inSpeech = false; this.buf = [ ]; this.bufLen = 0; }   // a click, not speech
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
                        if (opts.endOnFinal) finish();
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
                resolve({ text: text, alternatives: segments.length ? segments[segments.length - 1].slice() : [ ], final: gotFinal, error: err, segments: segments });
            }
            let timer = setTimeout(function() { stopFn(); }, ms);
            stopFn = function() {
                if (done || stopping) return;
                stopping = true;
                if (s.inSpeech && s.speechFrames >= 3) s.flush(true);      // hear out what was being said
                if (!pending) finish(); else setTimeout(finish, 4000);     // but don't wait forever for it
            };
            openMic().then(function(ok) {
                if (!ok) { err = state.micError || 'audio-capture'; if (err == 'not-allowed') err = 'not-allowed'; finish(); return; }
                if (session) { try { session.flush(false); } catch (e) { } }
                session = s;
                log('listening (' + ms + ' ms)');
            });
        });
        p.stop = function() { stopFn(); };
        p.handle = handle;
        Object.defineProperty(p, 'onInterim', { set: function(f) { handle.onInterim = f; }, get: function() { return handle.onInterim; } });
        Object.defineProperty(p, 'done', { get: function() { return handle.done; } });
        return p;
    }

    function active() { return state.enabled && state.loaded; }

    return {
        available: available, caps: caps, load: load, unload: unload, listen: listen, onStatus: onStatus,
        openMic: openMic, closeMic: closeMic, micLabel: micLabel, active: active,
        get state() { return state; }, get ready() { return state.loaded; }, get level() { return level; }, get noise() { return noise; },
        set enabled(v) { state.enabled = !!v; }, get enabled() { return state.enabled; },
        log: [ ],
    };
})();
