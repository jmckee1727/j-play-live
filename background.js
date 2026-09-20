// background.js -- the extension's service worker.
//
// Its only job is plumbing for the studio voice: it creates the offscreen
// document that runs the speech model, forwards the game page's requests to
// it, and relays progress events back to the right tab.
//
//   content script  --('tts', op...)-->  background  --('tts-op')-->  offscreen/tts.js
//   content script  <--('tts-event')--   background  <--('tts-event')-- offscreen/tts.js

const OFFSCREEN_URL = 'offscreen/tts.html';
let creating = null;

async function ensureOffscreen() {
    if (!chrome.offscreen) throw new Error('This Chrome does not support offscreen documents (needs Chrome 109+).');
    let has = false;
    if (chrome.runtime.getContexts) {
        let ctxs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
        has = ctxs.length > 0;
    } else if (chrome.offscreen.hasDocument) {
        has = await chrome.offscreen.hasDocument();
    }
    if (has) return;
    if (!creating) {
        creating = chrome.offscreen.createDocument({
            url: OFFSCREEN_URL,
            reasons: ['WORKERS'],
            justification: 'Runs the on-device speech model that reads clues aloud.',
        }).catch(function(e) {
            // A race with another creator is fine.
            if (!/single offscreen|already exists/i.test(String(e && e.message))) throw e;
        }).finally(function() { creating = null; });
    }
    await creating;
}

// The offscreen page loads a 2 MB module before it can answer; give it a moment.
async function waitForEngine() {
    for (let i = 0; i < 60; i++) {
        try {
            let r = await chrome.runtime.sendMessage({ type: 'tts-op', op: 'ping' });
            if (r && r.ok) return;
        } catch (e) { }
        await new Promise(function(res) { setTimeout(res, 100); });
    }
    throw new Error('The voice engine did not start.');
}

chrome.runtime.onMessage.addListener(function(msg, sender, sendResponse) {
    if (!msg || !msg.type) return false;

    if (msg.type == 'tts-ensure') {
        ensureOffscreen().then(function() {
            sendResponse({ ok: true, tabId: sender.tab ? sender.tab.id : null });
        }, function(e) {
            sendResponse({ ok: false, error: (e && e.message) ? e.message : String(e) });
        });
        return true;
    }

    if (msg.type == 'tts') {
        // Forward to the offscreen document and return its answer.
        let tabId = sender.tab ? sender.tab.id : msg.tabId;
        ensureOffscreen().then(function() {
            return waitForEngine();
        }).then(function() {
            return chrome.runtime.sendMessage(Object.assign({ }, msg, { type: 'tts-op', tabId: tabId }));
        }).then(function(reply) {
            sendResponse(reply || { ok: false, error: 'no reply from the voice engine' });
        }, function(e) {
            sendResponse({ ok: false, error: (e && e.message) ? e.message : String(e) });
        });
        return true;
    }

    if (msg.type == 'tts-event') {
        // From the offscreen document: relay to the tab that asked.
        if (msg.tabId != null && chrome.tabs) {
            chrome.tabs.sendMessage(msg.tabId, msg).catch(function() { });
        }
        return false;
    }

    return false;
});

// Keep the offscreen document around from the start so the first request is quick.
chrome.runtime.onInstalled.addListener(function() { ensureOffscreen().catch(function() { }); });
chrome.runtime.onStartup.addListener(function() { ensureOffscreen().catch(function() { }); });
