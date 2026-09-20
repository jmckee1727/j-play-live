// offscreen/tts.js -- the "studio voice": Kokoro-82M running in the browser.
//
// This page is an offscreen document (chrome.offscreen). It never shows; it
// exists so the speech model can run in a full extension page with WebGPU,
// workers and the Cache API, away from the J! Archive tab. The game's content
// script talks to it through background.js:
//
//   { op: 'caps' }                       -> what this machine can do, and whether the model is cached
//   { op: 'load', device }               -> download (first time) and load the model; progress events stream back
//   { op: 'unload' }                     -> free the model
//   { op: 'generate', text, voice, speed } -> 16-bit PCM audio, base64, plus the sample rate
//   { op: 'voices' }                     -> the voice list
//
// The model files come from Hugging Face on first use and are cached by the
// browser (Cache API), so later loads are local. Nothing about the user is sent
// anywhere: the requests are plain file downloads.

import { KokoroTTS, env } from '../vendor/kokoro.web.js';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const HF_BASE = 'https://huggingface.co/' + MODEL_ID + '/resolve/main/';

// ONNX Runtime's WebAssembly comes from the extension, never from a CDN.
env.wasmPaths = chrome.runtime.getURL('vendor/');

let tts = null;
let loading = null;
let current = { device: null, dtype: null };
let queue = Promise.resolve();   // generation is serialized: one utterance at a time

// The voices we offer (Kokoro's American/British English set). Grades are
// the model author's own quality grades.
const VOICES = [
    { id: 'am_michael', label: 'Michael — American, measured baritone (host default)', gender: 'm' },
    { id: 'am_fenrir',  label: 'Fenrir — American, bright and energetic', gender: 'm' },
    { id: 'am_puck',    label: 'Puck — American, warm', gender: 'm' },
    { id: 'am_onyx',    label: 'Onyx — American, deep', gender: 'm' },
    { id: 'am_echo',    label: 'Echo — American', gender: 'm' },
    { id: 'am_liam',    label: 'Liam — American', gender: 'm' },
    { id: 'am_eric',    label: 'Eric — American', gender: 'm' },
    { id: 'bm_george',  label: 'George — British, warm', gender: 'm' },
    { id: 'bm_lewis',   label: 'Lewis — British', gender: 'm' },
    { id: 'bm_daniel',  label: 'Daniel — British', gender: 'm' },
    { id: 'bm_fable',   label: 'Fable — British, storyteller', gender: 'm' },
    { id: 'af_heart',   label: 'Heart — American, the model\'s best-rated voice', gender: 'f' },
    { id: 'af_bella',   label: 'Bella — American, warm', gender: 'f' },
    { id: 'af_nicole',  label: 'Nicole — American, soft', gender: 'f' },
    { id: 'af_sarah',   label: 'Sarah — American', gender: 'f' },
    { id: 'af_nova',    label: 'Nova — American', gender: 'f' },
    { id: 'bf_emma',    label: 'Emma — British', gender: 'f' },
    { id: 'bf_isabella',label: 'Isabella — British', gender: 'f' },
];

function dtypeFor(device) { return device == 'webgpu' ? 'fp32' : 'q8'; }
function modelFile(dtype) { return dtype == 'fp32' ? 'onnx/model.onnx' : dtype == 'fp16' ? 'onnx/model_fp16.onnx' : 'onnx/model_quantized.onnx'; }
const SIZES = { fp32: 326, fp16: 163, q8: 92 };

async function webgpuAvailable() {
    try {
        if (!navigator.gpu) return false;
        let adapter = await navigator.gpu.requestAdapter();
        return !!adapter;
    } catch (e) { return false; }
}

// transformers.js keeps downloaded files in the Cache API under this name.
async function cachedModels() {
    let out = { };
    try {
        let names = await caches.keys();
        for (let name of names) {
            let cache = await caches.open(name);
            let keys = await cache.keys();
            for (let req of keys) {
                let u = req.url;
                if (u.indexOf('Kokoro-82M') < 0) continue;
                if (/onnx\/model\.onnx/.test(u)) out.fp32 = true;
                if (/onnx\/model_fp16\.onnx/.test(u)) out.fp16 = true;
                if (/onnx\/model_quantized\.onnx/.test(u)) out.q8 = true;
            }
        }
    } catch (e) { }
    return out;
}

async function caps() {
    let cached = await cachedModels();
    return {
        webgpu: await webgpuAvailable(),
        deviceMemory: navigator.deviceMemory || null,
        cores: navigator.hardwareConcurrency || null,
        crossOriginIsolated: !!self.crossOriginIsolated,
        cached: cached,
        loaded: !!tts,
        device: current.device,
        dtype: current.dtype,
        sizesMB: SIZES,
    };
}

function report(tabId, payload) {
    try { chrome.runtime.sendMessage(Object.assign({ type: 'tts-event', tabId: tabId }, payload)); } catch (e) { }
}

async function load(opts, tabId) {
    let device = opts.device == 'webgpu' ? 'webgpu' : 'wasm';
    let dtype = opts.dtype || dtypeFor(device);
    if (tts && current.device == device && current.dtype == dtype) return { ok: true, device, dtype };
    if (loading) return loading;
    loading = (async function() {
        if (tts) { try { await tts.model.dispose(); } catch (e) { } tts = null; }
        let files = { };
        let cb = function(p) {
            // p: { status: 'initiate'|'download'|'progress'|'done'|'ready', file, loaded, total, progress }
            if (p && p.file) {
                if (p.status == 'progress') files[p.file] = { loaded: p.loaded || 0, total: p.total || 0 };
                else if (p.status == 'done') files[p.file] = { loaded: files[p.file] ? files[p.file].total : 0, total: files[p.file] ? files[p.file].total : 0, done: true };
            }
            let loaded = 0, total = 0;
            for (let f in files) { loaded += files[f].loaded; total += files[f].total; }
            report(tabId, { event: 'progress', status: p ? p.status : '', file: p ? p.file : '', loaded: loaded, total: total });
        };
        try {
            if (device == 'wasm') {
                // Threads need cross-origin isolation (set in the manifest); otherwise ORT runs single-threaded.
                env.backends = env.backends || { };
            }
            tts = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: dtype, device: device, progress_callback: cb });
            current = { device: device, dtype: dtype };
            // Warm up (the first generation compiles shaders / JITs).
            try { await tts.generate('Ready.', { voice: 'am_michael', speed: 1 }); } catch (e) { }
            report(tabId, { event: 'loaded', device: device, dtype: dtype });
            return { ok: true, device: device, dtype: dtype };
        } catch (e) {
            tts = null; current = { device: null, dtype: null };
            let msg = (e && e.message) ? e.message : String(e);
            report(tabId, { event: 'error', error: msg });
            // WebGPU can fail on some drivers; the caller may retry with wasm.
            return { ok: false, error: msg, device: device, dtype: dtype };
        } finally {
            loading = null;
        }
    })();
    return loading;
}

async function unload() {
    if (tts) { try { await tts.model.dispose(); } catch (e) { } }
    tts = null; current = { device: null, dtype: null };
    return { ok: true };
}

function floatToPcm16Base64(f32) {
    let i16 = new Int16Array(f32.length);
    for (let i = 0; i < f32.length; i++) {
        let v = Math.max(-1, Math.min(1, f32[i]));
        i16[i] = v < 0 ? v * 32768 : v * 32767;
    }
    let bytes = new Uint8Array(i16.buffer);
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
        s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
}

async function generate(opts) {
    if (!tts) return { ok: false, error: 'voice not loaded' };
    let text = String(opts.text || '').trim();
    if (!text) return { ok: true, rate: 24000, pcm: '', ms: 0 };
    let voice = opts.voice || 'am_michael';
    let speed = Math.max(0.5, Math.min(2, +opts.speed || 1));
    let job = queue.then(async function() {
        let t0 = performance.now();
        let audio = await tts.generate(text, { voice: voice, speed: speed });
        let pcm = floatToPcm16Base64(audio.audio);
        return { ok: true, rate: audio.sampling_rate, pcm: pcm, ms: Math.round(audio.audio.length / audio.sampling_rate * 1000), genMs: Math.round(performance.now() - t0) };
    });
    queue = job.catch(function() { });
    try { return await job; }
    catch (e) { return { ok: false, error: (e && e.message) ? e.message : String(e) }; }
}

chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
    if (!msg || msg.type != 'tts-op') return false;
    let p;
    switch (msg.op) {
      case 'caps': p = caps(); break;
      case 'load': p = load(msg, msg.tabId); break;
      case 'unload': p = unload(); break;
      case 'generate': p = generate(msg); break;
      case 'voices': p = Promise.resolve({ ok: true, voices: VOICES }); break;
      case 'ping': p = Promise.resolve({ ok: true, loaded: !!tts }); break;
      default: p = Promise.resolve({ ok: false, error: 'unknown op ' + msg.op });
    }
    p.then(sendResponse, function(e) { sendResponse({ ok: false, error: (e && e.message) ? e.message : String(e) }); });
    return true; // async response
});
