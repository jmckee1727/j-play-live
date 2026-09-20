// neural.js -- the game page's client for the studio voice (offscreen/tts.js).
//
// JPNeural.speak(text) plays a synthesized line through the page's audio
// graph (so Pause freezes it with everything else). Audio is fetched from the
// engine over extension messaging and cached by text, and a background
// prefetch queue keeps the next clues ready so there is nothing to wait for
// during play. If the engine is unavailable or fails, callers fall back to the
// system voice (JPAudio handles that).

var JPNeural = (function() {
    'use strict';

    let tabId = null;
    let engineOk = null;          // null unknown, true/false after the first ensure
    let state = { loaded: false, loading: false, device: null, dtype: null, error: null, progress: null };
    let listeners = [ ];          // status listeners
    let cache = new Map();        // key -> { rate, pcm: Int16Array, ms }
    let inflight = new Map();     // key -> Promise
    let queue = [ ];              // [{ key, text, voice, speed, priority, resolve, reject }]
    let pumping = false;
    let playing = null;           // { source, resolve }
    let voicesCache = null;

    function key(text, voice, speed) { return voice + '|' + speed.toFixed(2) + '|' + text; }

    function emit(ev) { listeners.slice().forEach(function(f) { try { f(ev, state); } catch (e) { } }); }
    function onStatus(f) { listeners.push(f); return function() { listeners = listeners.filter(function(x) { return x !== f; }); }; }

    // Messages from the engine (progress, loaded, error) arrive via background.js.
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
        chrome.runtime.onMessage.addListener(function(msg) {
            if (!msg || msg.type != 'tts-event') return;
            if (msg.event == 'progress') { state.progress = { loaded: msg.loaded, total: msg.total, file: msg.file, status: msg.status }; emit('progress'); }
            else if (msg.event == 'loaded') { state.loaded = true; state.loading = false; state.device = msg.device; state.dtype = msg.dtype; state.error = null; emit('loaded'); }
            else if (msg.event == 'error') { state.loading = false; state.error = msg.error; emit('error'); }
        });
    }

    function available() { return typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.sendMessage && chrome.runtime.id); }

    async function ensure() {
        if (!available()) { engineOk = false; throw new Error('extension messaging unavailable'); }
        let r = await chrome.runtime.sendMessage({ type: 'tts-ensure' });
        if (!r || !r.ok) { engineOk = false; throw new Error(r && r.error ? r.error : 'voice engine unavailable'); }
        tabId = r.tabId;
        engineOk = true;
        return r;
    }

    async function rpc(op, data) {
        if (engineOk === null || tabId == null) await ensure();
        let r = await chrome.runtime.sendMessage(Object.assign({ type: 'tts', op: op, tabId: tabId }, data || { }));
        if (!r) throw new Error('no reply from the voice engine');
        if (r.ok === false) throw new Error(r.error || 'voice engine error');
        return r;
    }

    async function caps() {
        let c = await rpc('caps');
        state.loaded = !!c.loaded; state.device = c.device; state.dtype = c.dtype;
        return c;
    }

    async function voices() {
        if (voicesCache) return voicesCache;
        let r = await rpc('voices');
        voicesCache = r.voices || [ ];
        return voicesCache;
    }

    // Download (first time) and load the model. device: 'webgpu' | 'wasm'.
    async function load(device) {
        state.loading = true; state.error = null; state.progress = null; emit('loading');
        try {
            let r = await rpc('load', { device: device });
            if (!r.ok && device == 'webgpu') {
                // Drivers vary; fall back to the CPU build.
                emit('fallback');
                r = await rpc('load', { device: 'wasm' });
            }
            if (!r.ok) throw new Error(r.error || 'could not load the voice');
            state.loaded = true; state.loading = false; state.device = r.device; state.dtype = r.dtype;
            cache.clear();
            emit('loaded');
            return r;
        } catch (e) {
            state.loading = false; state.loaded = false; state.error = e.message || String(e);
            emit('error');
            throw e;
        }
    }

    async function unload() { try { await rpc('unload'); } catch (e) { } state.loaded = false; state.device = null; cache.clear(); emit('unloaded'); }

    function b64ToInt16(b64) {
        let bin = atob(b64);
        let bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Int16Array(bytes.buffer);
    }

    // ---- the synthesis queue --------------------------------------------
    // The engine generates one utterance at a time, so the page hands it one
    // request at a time in priority order: what's needed now (priority 0)
    // before prefetch (1, 2, 3... in broadcast order).

    function synth(text, voice, speed, priority) {
        text = String(text || '').trim();
        if (!text) return Promise.resolve({ rate: 24000, pcm: new Int16Array(0), ms: 0 });
        let k = key(text, voice, speed);
        if (cache.has(k)) return Promise.resolve(cache.get(k));
        if (inflight.has(k)) {
            // Raise its priority if it is now needed sooner.
            let q = queue.find(function(x) { return x.key == k; });
            if (q && priority < q.priority) q.priority = priority;
            return inflight.get(k);
        }
        let p = new Promise(function(resolve, reject) {
            queue.push({ key: k, text: text, voice: voice, speed: speed, priority: priority, resolve: resolve, reject: reject });
        });
        inflight.set(k, p);
        pump();
        return p;
    }

    async function pump() {
        if (pumping) return;
        pumping = true;
        try {
            while (queue.length) {
                if (!state.loaded) { // nothing we can do until the model is in
                    let q = queue.splice(0); q.forEach(function(x) { inflight.delete(x.key); x.reject(new Error('voice not loaded')); });
                    break;
                }
                queue.sort(function(a, b) { return a.priority - b.priority; });
                let job = queue.shift();
                try {
                    let r = await rpc('generate', { text: job.text, voice: job.voice, speed: job.speed });
                    let out = { rate: r.rate || 24000, pcm: b64ToInt16(r.pcm || ''), ms: r.ms || 0, genMs: r.genMs || 0 };
                    cache.set(job.key, out);
                    if (cache.size > 400) { let first = cache.keys().next().value; cache.delete(first); }
                    job.resolve(out);
                } catch (e) {
                    job.reject(e);
                } finally {
                    inflight.delete(job.key);
                }
            }
        } finally {
            pumping = false;
        }
    }

    // Queue lines to synthesize ahead of time, in the order given.
    function prefetch(items, voice, speed, basePriority) {
        let p = basePriority == null ? 10 : basePriority;
        items.forEach(function(text, i) {
            synth(text, voice, speed, p + i).catch(function() { });
        });
    }
    function clearPrefetch() {
        let keep = queue.filter(function(x) { return x.priority <= 0; });
        let drop = queue.filter(function(x) { return x.priority > 0; });
        queue = keep;
        drop.forEach(function(x) { inflight.delete(x.key); x.reject(new Error('cancelled')); });
    }

    // ---- playback --------------------------------------------------------

    function stop() {
        if (playing) {
            let p = playing; playing = null;
            try { p.source.stop(); } catch (e) { }
            p.resolve(false);
        }
    }

    // Resolves true when the line has finished playing, false if stopped.
    async function speak(text, opts) {
        opts = opts || { };
        let voice = opts.voice || 'am_michael';
        let speed = +opts.speed || 1;
        let ctx = JPAudio.context();
        if (!ctx) throw new Error('no audio context');
        let clip = await synth(text, voice, speed, 0);
        await JPClock.whenRunning();
        return new Promise(function(resolve) {
            stop();
            if (!clip.pcm.length) { resolve(true); return; }
            let buf = ctx.createBuffer(1, clip.pcm.length, clip.rate);
            let ch = buf.getChannelData(0);
            for (let i = 0; i < clip.pcm.length; i++) ch[i] = clip.pcm[i] / 32768;
            let src = ctx.createBufferSource();
            src.buffer = buf;
            let gain = ctx.createGain();
            gain.gain.value = opts.volume == null ? 1 : opts.volume;
            src.connect(gain).connect(ctx.destination);
            let me = { source: src, resolve: resolve };
            playing = me;
            src.onended = function() { if (playing === me) { playing = null; resolve(true); } };
            if (ctx.state == 'suspended' && !JPClock.paused) ctx.resume().catch(function() { });
            src.start();
        });
    }

    function isPlaying() { return !!playing; }

    return {
        available: available, ensure: ensure, caps: caps, voices: voices, load: load, unload: unload,
        synth: synth, prefetch: prefetch, clearPrefetch: clearPrefetch,
        speak: speak, stop: stop, isPlaying: isPlaying, onStatus: onStatus, rpc: rpc,
        get state() { return state; },
        get ready() { return state.loaded; },
        cacheSize: function() { return cache.size; },
        queueLength: function() { return queue.length; },
    };
})();
