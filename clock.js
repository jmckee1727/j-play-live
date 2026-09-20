// clock.js -- a pausable game clock.
//
// Every timer the game runs (the buzzer race, the answer clock, the pauses
// between clues) goes through JPClock.setTimeout instead of window.setTimeout,
// so JPClock.pause() freezes the whole game mid-flight and JPClock.resume()
// picks it up with the remaining time intact. JPClock.now() is a millisecond
// clock that does not advance while paused. Other modules register onPause /
// onResume callbacks to freeze what they own (speech, the timer bar, music).

var JPClock = (function() {
    'use strict';

    let paused = false;
    let pausedAt = 0;      // performance.now() when the current pause began
    let pausedTotal = 0;   // total ms spent paused so far
    let nextId = 1;
    let timers = new Map();   // id -> { fn, remaining, startedAt, handle }
    let listeners = { pause: [ ], resume: [ ] };
    let resumeWaiters = [ ];

    function realNow() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }

    function now() {
        return paused ? pausedAt - pausedTotal : realNow() - pausedTotal;
    }

    function arm(id, t) {
        t.startedAt = realNow();
        t.handle = window.setTimeout(function() {
            timers.delete(id);
            try { t.fn(); } catch (e) { console.error('[j-play-live] timer callback failed', e); }
        }, t.remaining);
    }

    function setTimeout(fn, ms) {
        let id = nextId++;
        let t = { fn: fn, remaining: Math.max(0, ms || 0), startedAt: 0, handle: null };
        timers.set(id, t);
        if (!paused)
            arm(id, t);
        return id;
    }

    function clearTimeout(id) {
        let t = timers.get(id);
        if (!t) return;
        if (t.handle !== null) window.clearTimeout(t.handle);
        timers.delete(id);
    }

    function pause() {
        if (paused) return;
        paused = true;
        pausedAt = realNow();
        timers.forEach(function(t) {
            if (t.handle !== null) {
                window.clearTimeout(t.handle);
                t.handle = null;
                t.remaining = Math.max(0, t.remaining - (pausedAt - t.startedAt));
            }
        });
        listeners.pause.slice().forEach(function(f) { try { f(); } catch (e) { console.error(e); } });
    }

    function resume() {
        if (!paused) return;
        paused = false;
        pausedTotal += realNow() - pausedAt;
        timers.forEach(function(t, id) { if (t.handle === null) arm(id, t); });
        listeners.resume.slice().forEach(function(f) { try { f(); } catch (e) { console.error(e); } });
        let w = resumeWaiters; resumeWaiters = [ ];
        w.forEach(function(r) { r(); });
    }

    // Resolves immediately if running, otherwise when the game is resumed.
    function whenRunning() {
        return paused ? new Promise(function(resolve) { resumeWaiters.push(resolve); }) : Promise.resolve();
    }

    function onPause(f) { listeners.pause.push(f); }
    function onResume(f) { listeners.resume.push(f); }
    function off(f) {
        listeners.pause = listeners.pause.filter(function(x) { return x !== f; });
        listeners.resume = listeners.resume.filter(function(x) { return x !== f; });
    }

    return {
        now: now, setTimeout: setTimeout, clearTimeout: clearTimeout,
        pause: pause, resume: resume, whenRunning: whenRunning,
        onPause: onPause, onResume: onResume, off: off,
        get paused() { return paused; },
    };
})();
