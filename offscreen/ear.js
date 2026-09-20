// offscreen/ear.js -- the "studio ear": Whisper running in the browser.
//
// The game's speech recognition, on this computer. Chrome's built-in
// recognizer sends audio to Google and behaves differently from day to day;
// this one is OpenAI's Whisper (the English-only "base" or "small" model, in
// ONNX form from onnx-community), executed by ONNX Runtime on the GPU (WebGPU)
// or the CPU (WebAssembly), in this hidden extension page. The game page
// captures the microphone, cuts it into utterances, and sends each one here:
//
//   { op: 'ear-caps' }                        -> which models are cached, what's loaded
//   { op: 'ear-load', size, device }          -> download (first time) and load; progress events stream back
//   { op: 'ear-unload' }
//   { op: 'ear-transcribe', pcm }             -> pcm: base64 16-bit mono 16 kHz -> { text }
//   { op: 'ear-selftest', text, tts }         -> speak a phrase with the voice model, hear it back (for tests)
//
// Model files come from Hugging Face on first use and are cached by the
// browser (Cache API); afterwards nothing leaves the machine.

import { pipeline, env } from '../vendor/transformers.min.js';

// ONNX Runtime's WebAssembly comes from the extension, never from a CDN.
try { env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('vendor/'); } catch (e) { }
env.wasmPaths = chrome.runtime.getURL('vendor/');
env.allowLocalModels = false;

const MODELS = {
    base:  { id: 'onnx-community/whisper-base.en',  label: 'Base — quick, good (about 210 MB on the GPU, 80 MB on the CPU)' },
    small: { id: 'onnx-community/whisper-small.en', label: 'Small — more accurate on names (about 590 MB on the GPU, 250 MB on the CPU)' },
};
// Download sizes in MB, by model and device (encoder + decoder).
const SIZES = { base: { webgpu: 206, wasm: 77 }, small: { webgpu: 586, wasm: 249 } };

let asr = null;
let loading = null;
let current = { size: null, device: null };
let queue = Promise.resolve();

function dtypeFor(device) {
    // The WebGPU build keeps the encoder in fp32 and packs the decoder to 4 bits
    // (fast, accurate); the CPU build uses 8-bit everywhere.
    return device == 'webgpu' ? { encoder_model: 'fp32', decoder_model_merged: 'q4' } : { encoder_model: 'q8', decoder_model_merged: 'q8' };
}

async function cachedModels() {
    let out = { base: { webgpu: false, wasm: false }, small: { webgpu: false, wasm: false } };
    try {
        let names = await caches.keys();
        for (let name of names) {
            let cache = await caches.open(name);
            let keys = await cache.keys();
            let seen = { };
            for (let req of keys) seen[req.url] = true;
            for (let size in MODELS) {
                let base = 'https://huggingface.co/' + MODELS[size].id + '/resolve/main/onnx/';
                if (seen[base + 'encoder_model.onnx'] && seen[base + 'decoder_model_merged_q4.onnx']) out[size].webgpu = true;
                if (seen[base + 'encoder_model_quantized.onnx'] && seen[base + 'decoder_model_merged_quantized.onnx']) out[size].wasm = true;
            }
        }
    } catch (e) { }
    return out;
}

async function webgpuAvailable() {
    try { if (!navigator.gpu) return false; return !!(await navigator.gpu.requestAdapter()); } catch (e) { return false; }
}

export async function earCaps() {
    return { ok: true, webgpu: await webgpuAvailable(), cached: await cachedModels(), loaded: !!asr, size: current.size, device: current.device, sizesMB: SIZES, models: MODELS };
}

function report(tabId, payload) {
    try { chrome.runtime.sendMessage(Object.assign({ type: 'ear-event', tabId: tabId }, payload)); } catch (e) { }
}

export async function earLoad(opts, tabId) {
    let size = MODELS[opts.size] ? opts.size : 'base';
    let device = opts.device == 'webgpu' ? 'webgpu' : 'wasm';
    if (asr && current.size == size && current.device == device) return { ok: true, size, device };
    if (loading) return loading;
    loading = (async function() {
        if (asr) { try { await asr.dispose(); } catch (e) { } asr = null; }
        let files = { };
        let cb = function(p) {
            if (p && p.file) {
                if (p.status == 'progress') files[p.file] = { loaded: p.loaded || 0, total: p.total || 0 };
                else if (p.status == 'done') files[p.file] = { loaded: files[p.file] ? files[p.file].total : 0, total: files[p.file] ? files[p.file].total : 0 };
            }
            let loaded = 0, total = 0;
            for (let f in files) { loaded += files[f].loaded; total += files[f].total; }
            report(tabId, { event: 'progress', status: p ? p.status : '', file: p ? p.file : '', loaded: loaded, total: total });
        };
        try {
            asr = await pipeline('automatic-speech-recognition', MODELS[size].id, { dtype: dtypeFor(device), device: device, progress_callback: cb });
            current = { size: size, device: device };
            // Warm up on a second of silence (compiles the shaders).
            try { await asr(new Float32Array(16000), { max_new_tokens: 8 }); } catch (e) { }
            report(tabId, { event: 'loaded', size: size, device: device });
            return { ok: true, size: size, device: device };
        } catch (e) {
            asr = null; current = { size: null, device: null };
            let msg = (e && e.message) ? e.message : String(e);
            report(tabId, { event: 'error', error: msg });
            return { ok: false, error: msg, size: size, device: device };
        } finally {
            loading = null;
        }
    })();
    return loading;
}

export async function earUnload() {
    if (asr) { try { await asr.dispose(); } catch (e) { } }
    asr = null; current = { size: null, device: null };
    return { ok: true };
}

function pcm16Base64ToFloat(b64) {
    let bin = atob(b64);
    let bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    let i16 = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
    let f = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f[i] = i16[i] / 32768;
    return f;
}

// Whisper answers silence with stock phrases ("Thank you.", "you"); drop those.
const HALLUCINATIONS = /^(thank you\.?|thanks\.?|you\.?|bye\.?|\.|\s*)$/i;

export function earTranscribe(opts) {
    if (!asr) return Promise.resolve({ ok: false, error: 'ear not loaded' });
    let audio = opts.pcm ? pcm16Base64ToFloat(opts.pcm) : (opts.audio || new Float32Array(0));
    let job = queue.then(async function() {
        let t0 = performance.now();
        if (audio.length < 1600) return { ok: true, text: '', ms: 0 };
        let out = await asr(audio, { max_new_tokens: 48, return_timestamps: false });
        let text = String((out && out.text) || '').trim();
        if (HALLUCINATIONS.test(text)) text = '';
        return { ok: true, text: text, ms: Math.round(performance.now() - t0), seconds: audio.length / 16000 };
    });
    queue = job.catch(function() { });
    return job;
}

// For tests: say a phrase with the voice model and hear it back with the ear.
export async function earSelfTest(opts, ttsGenerate) {
    if (!asr) return { ok: false, error: 'ear not loaded' };
    if (!ttsGenerate) return { ok: false, error: 'voice not loaded' };
    let audio = await ttsGenerate(opts.text || 'What is Ceres?');   // RawAudio { audio: Float32Array, sampling_rate }
    let src = audio.audio, rate = audio.sampling_rate || 24000;
    // Resample to 16 kHz (linear; fine for speech).
    let n = Math.floor(src.length * 16000 / rate), out = new Float32Array(n);
    for (let i = 0; i < n; i++) { let x = i * rate / 16000, j = Math.floor(x), t = x - j; out[i] = src[j] * (1 - t) + (src[Math.min(j + 1, src.length - 1)] || 0) * t; }
    let r = await earTranscribe({ audio: out });
    return Object.assign({ said: opts.text || 'What is Ceres?' }, r);
}
