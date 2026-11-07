// online.js -- accounts and online play: sign-in, the cloud copy of your
// results, lobbies, the matchmaking queue, ratings, and the realtime channel
// an online game runs on. Talks to the J-Play Live service (Supabase) through
// the vendored supabase-js. Nothing here runs until you sign in.
window.JPOnline = (function() {
    const URL = 'https://ckcgupksgfadhtyhycdl.supabase.co';
    const KEY = 'sb_publishable_yuyifKD-n51bRtmdzH_vlA_EdUgeJWX';
    let client = null, user = null, profile = null, ready = null;
    const log = [ ];
    function mlog(m) { log.push({ t: Date.now(), m: m }); if (log.length > 400) log.shift(); }

    // The session lives in the extension's storage, so every j-archive.com page (www or not) shares it.
    const storage = {
        getItem: function(k) { return new Promise(function(r) { try { chrome.storage.local.get([ k ], function(o) { r(o && o[k] != null ? o[k] : null); }); } catch (e) { r(null); } }); },
        setItem: function(k, v) { return new Promise(function(r) { try { let o = { }; o[k] = v; chrome.storage.local.set(o, function() { r(); }); } catch (e) { r(); } }); },
        removeItem: function(k) { return new Promise(function(r) { try { chrome.storage.local.remove([ k ], function() { r(); }); } catch (e) { r(); } }); },
    };
    function available() { return typeof supabase !== 'undefined' && !!supabase.createClient; }
    function init() {
        if (ready) return ready;
        if (!available()) return (ready = Promise.resolve(false));
        // Signing in once keeps you signed in on this computer: the service's sessions don't expire (no time box or
        // inactivity limit), the session sits in the extension's storage, and its tokens are renewed as you play.
        client = supabase.createClient(URL, KEY, { auth: { storage: storage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'jpLiveAuth' } });
        ready = restore().then(function(u) {
            user = u;
            return user ? loadProfile().then(function() { return true; }, function() { return true; }) : false;
        }).catch(function(e) { mlog('session: ' + e.message); return false; });
        client.auth.onAuthStateChange(function(ev, session) { user = session ? session.user : null; if (!user) profile = null; });
        return ready;
    }
    // The saved session, renewed if it's old. A renewal that fails because the network or the service is briefly away
    // (the computer just woke, Wi-Fi is back, the free project is starting up) is tried again a few times, and if it
    // still can't get through, you stay signed in with the saved session: supabase-js keeps it and renews it once the
    // service answers. Only a session the service itself has ended (signed out, account deleted) asks for a sign-in.
    async function restore() {
        let waits = [ 1000, 3000 ];
        for (let i = 0; ; i++) {
            let r = await client.auth.getSession().catch(function(e) { return { data: { }, error: e }; });
            let session = r.data && r.data.session;
            if (session) return session.user;
            let saved = await savedSession();
            if (!saved) return null;   // nothing saved, or the service ended it
            if (i >= waits.length) { mlog('session: renewal still failing (' + (r.error ? r.error.message : '?') + '); staying signed in'); return saved.user || null; }
            mlog('session: renewal failed (' + (r.error ? r.error.message : '?') + '); trying again');
            await new Promise(function(res) { setTimeout(res, waits[i]); });
        }
    }
    async function savedSession() {
        let raw = await storage.getItem('jpLiveAuth');
        if (!raw) return null;
        try { let o = typeof raw == 'string' ? JSON.parse(raw) : raw; return o && o.refresh_token ? o : null; } catch (e) { return null; }
    }
    async function loadProfile() {
        if (!user) return null;
        let r = await client.from('profiles').select('*').eq('id', user.id).maybeSingle();
        profile = r.data || null;
        if (profile) client.from('profiles').update({ last_seen: new Date().toISOString() }).eq('id', user.id).then(function() { });
        return profile;
    }
    async function signUp(email, password, name) {
        let r = await fetch(URL + '/functions/v1/signup', { method: 'POST', headers: { 'Content-Type': 'application/json', apikey: KEY }, body: JSON.stringify({ email: email, password: password, name: name }) });
        let body = { }; try { body = await r.json(); } catch (e) { }
        if (!r.ok) throw new Error(body.error || ('sign-up failed (' + r.status + ')'));
        return signIn(email, password);
    }
    async function signIn(email, password) {
        let r = await client.auth.signInWithPassword({ email: email, password: password });
        if (r.error) throw new Error(/invalid/i.test(r.error.message) ? 'Wrong email or password.' : r.error.message);
        user = r.data.user;
        await loadProfile();
        return profile;
    }
    // Signing out here leaves your other computers signed in (supabase-js's default would end every session).
    async function signOut() { try { await client.auth.signOut({ scope: 'local' }); } catch (e) { } user = null; profile = null; }
    // Removes the account and everything filed under it.
    async function deleteAccount() {
        let s = await client.auth.getSession();
        let token = s.data && s.data.session ? s.data.session.access_token : null;
        if (!token) throw new Error('not signed in');
        let r = await fetch(URL + '/functions/v1/delete_account', { method: 'POST', headers: { apikey: KEY, Authorization: 'Bearer ' + token } });
        let body = { }; try { body = await r.json(); } catch (e) { }
        if (!r.ok) throw new Error(body.error || ('could not delete the account (' + r.status + ')'));
        await signOut();
    }
    async function rpc(fn, args) {
        let r = await client.rpc(fn, args || { });
        if (r.error) throw new Error(r.error.message || String(r.error));
        return r.data;
    }
    async function rename(name) { let r = await client.from('profiles').update({ name: name }).eq('id', user.id); if (r.error) throw new Error(/unique|duplicate/i.test(r.error.message) ? 'That name is taken.' : r.error.message); profile.name = name; }

    // ---- the cloud copy of your results ---------------------------------------
    // entries: the extension's saved games (yours only); returns the ids of every game you've played, per the service.
    async function syncUp(entries) {
        let rows = (entries || [ ]).filter(function(e) { return e.gameId && e.id; }).map(function(e) {
            return { user_id: user.id, archive_game_id: +e.gameId, mode: (e.others && e.others.length) ? 'local' : 'solo', local_id: e.id, played_at: e.date, score: e.score || 0, coryat: e.coryat, place: e.place, players: 1 + ((e.others || [ ]).length), won: !!e.won, answered: e.answered, correct: e.correct, dd: e.dd || null, fj: e.fj || null, opponents: (e.contestants || [ ]).concat(e.others || [ ]) };
        });
        for (let i = 0; i < rows.length; i += 100) {
            let r = await client.from('results').upsert(rows.slice(i, i + 100), { onConflict: 'user_id,local_id', ignoreDuplicates: true });
            if (r.error) mlog('sync: ' + r.error.message);
        }
        let ids = [ ]; for (let e of entries || [ ]) if (e.gameId) ids.push(+e.gameId);
        return rpc('sync_played', { p_ids: ids });
    }
    async function myResults(limit) { let r = await client.from('results').select('*').eq('user_id', user.id).order('played_at', { ascending: false }).limit(limit || 200); return r.data || [ ]; }
    async function leaderboard() { let r = await client.from('leaderboard').select('*'); return r.data || [ ]; }

    // ---- rooms and the queue -------------------------------------------------------
    function createRoom(gameId, settings) { return rpc('create_room', { p_game: gameId, p_settings: settings || { } }); }
    function joinRoom(code) { return rpc('join_room', { p_code: code }); }
    function roomState(id) { return rpc('room_state', { p_room: id }); }
    function setRoom(id, gameId, settings) { return rpc('set_room', { p_room: id, p_game: gameId, p_settings: settings }); }
    function startRoom(id) { return rpc('start_room', { p_room: id }); }
    function setPlayerStatus(id, ready, mic) { return rpc('set_player_status', { p_room: id, p_ready: ready, p_mic: mic }); }
    function leaveRoom(id) { return rpc('leave_room', { p_room: id }); }
    function abandonRoom(id) { return rpc('abandon_room', { p_room: id }); }
    function finishRoom(id, results) { return rpc('finish_room', { p_room: id, p_results: results }); }
    function enqueue(mode) { return rpc('enqueue', { p_mode: mode }); }
    function matchMe() { return rpc('match_me', { }); }
    function dequeue() { return rpc('dequeue', { }); }
    function reroll(id) { return rpc('reroll_game', { p_room: id }); }
    function noteMaxGame(id) { if (user && id > 0) rpc('note_max_game', { p_id: id }).catch(function() { }); }

    // ---- the game channel ----------------------------------------------------------
    // Broadcast messages between the players of one room, with presence, an
    // inbox that waitFor() reads (a message may land before the game is ready
    // for it), and a clock synced to the host's for the buzzer race.
    let channel = null, roomId = null, inbox = [ ], seq = 0, listeners = [ ], present = { }, presenceCb = null, offset = 0, hostId = null, rtt = null;
    // Catch-up after a dropped connection: every message carries its sender's own running
    // number (n). Each client keeps what it sent and the highest number it has seen from
    // each sender; when its channel comes back after a drop (a Wi-Fi blip, a laptop lid, a
    // tab Chrome put to sleep) it asks everyone to send again what came after those
    // numbers, and a message seen twice is dropped. Without this, a message missed during
    // the drop was gone for good and that player's game stalled ("Connection lost").
    let sentN = 0, sentLog = [ ], lastFrom = { }, seenIds = { }, joins = 0, reconnectCb = null;
    function connect(id, host, onPresence) {
        disconnect();
        roomId = id; hostId = host; presenceCb = onPresence || null; inbox = [ ]; present = { }; offset = 0; rtt = null;
        sentN = 0; sentLog = [ ]; lastFrom = { }; seenIds = { }; joins = 0;
        return new Promise(function(resolve, reject) {
            let done = false;
            channel = client.channel('room:' + id, { config: { private: true, broadcast: { self: false, ack: false }, presence: { key: user.id } } });
            channel.on('broadcast', { event: 'g' }, function(m) { deliver(m.payload); });
            channel.on('presence', { event: 'sync' }, function() {
                let st = channel.presenceState(), now = { };
                for (let k in st) now[k] = (st[k][0] || { });
                present = now;
                if (presenceCb) presenceCb(present);
            });
            channel.subscribe(function(status, err) {
                mlog('channel ' + status + (err ? ': ' + err.message : ''));
                if (status == 'SUBSCRIBED') {
                    channel.track({ user_id: user.id, name: profile ? profile.name : '?', at: Date.now() });
                    if (++joins > 1) { mlog('rejoined; asking for what was missed'); send('replay', { since: Object.assign({ }, lastFrom) }); if (reconnectCb) { try { reconnectCb(); } catch (e) { } } }
                    if (!done) { done = true; resolve(true); }
                }
                else if ((status == 'CHANNEL_ERROR' || status == 'TIMED_OUT' || status == 'CLOSED') && !done) { done = true; reject(new Error('could not join the game channel (' + status + ')')); }
            });
            setTimeout(function() { if (!done) { done = true; reject(new Error('the game channel did not answer')); } }, 15000);
        });
    }
    function disconnect() { if (channel) { try { client.removeChannel(channel); } catch (e) { } } channel = null; roomId = null; listeners = [ ]; reconnectCb = null; }
    // The realtime service goes cold when nobody has opened a channel for days, and the
    // first players then wait minutes at "Joining the game…" while it comes up. Opening a
    // throwaway public channel as soon as someone heads for online play wakes it early.
    let warmed = null;
    function warmup() {
        if (warmed || !client) return warmed || Promise.resolve(false);
        warmed = new Promise(function(resolve) {
            let ch = client.channel('warmup-' + Math.random().toString(36).slice(2, 8)), done = false;
            let finish = function(ok) { if (done) return; done = true; try { client.removeChannel(ch); } catch (e) { } mlog('warmup ' + (ok ? 'ok' : 'failed')); if (!ok) warmed = null; resolve(ok); };
            ch.subscribe(function(status) { if (status == 'SUBSCRIBED') finish(true); else if (status == 'CHANNEL_ERROR' || status == 'TIMED_OUT' || status == 'CLOSED') finish(false); });
            setTimeout(function() { finish(false); }, 20000);
        });
        return warmed;
    }
    function deliver(p) {
        if (!p || !p.t) return;
        if (p.from && p.n != null) {
            let mid = p.from + ':' + p.n;
            if (seenIds[mid]) return;   // a replayed message this client already has
            seenIds[mid] = true;
            if (!(lastFrom[p.from] >= p.n)) lastFrom[p.from] = p.n;
        }
        if (p.t == 'replay') { resend(p); return; }
        p.seq = ++seq; p.rx = Date.now();   // receipt time (never `at`: the host's lights message names its moment in `at`)
        mlog('<- ' + p.t + ' ' + JSON.stringify(p).slice(0, 120));
        if (p.t == 'ping' && user && hostId == user.id) { send('pong', { to: p.from, t0: p.t0, th: Date.now() }); return; }
        inbox.push(p); if (inbox.length > 300) inbox.shift();
        for (let l of listeners.slice()) { try { if (l.type == p.t && (!l.pred || l.pred(p))) { l.fn(p); } } catch (e) { mlog('listener: ' + e.message); } }
    }
    function send(type, data) {
        if (!channel) return;
        let p = Object.assign({ t: type, from: user.id, ts: Date.now() }, data || { });
        if (type != 'ping' && type != 'pong' && type != 'replay') { p.n = ++sentN; sentLog.push(p); if (sentLog.length > 400) sentLog.shift(); }
        mlog('-> ' + type + ' ' + JSON.stringify(data || { }).slice(0, 120));
        channel.send({ type: 'broadcast', event: 'g', payload: p });
    }
    // Someone came back from a drop: send again what they missed of ours (once each; they drop repeats).
    function resend(req) {
        if (!channel || !user) return;
        let since = req.since && req.since[user.id] != null ? +req.since[user.id] : 0;
        let missed = sentLog.filter(function(p) { return p.n > since; }).slice(-120);
        mlog('replay for ' + req.from + ': ' + missed.length + ' message(s) after ' + since);
        // Paced (20 a second), so a long catch-up stays under the service's message rate.
        missed.forEach(function(p, i) { setTimeout(function() { if (channel) channel.send({ type: 'broadcast', event: 'g', payload: p }); }, i * 50); });
    }
    function onReconnect(fn) { reconnectCb = fn || null; }
    function on(type, fn, pred) { let l = { type: type, fn: fn, pred: pred }; listeners.push(l); return function() { let i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); }; }
    // The first unconsumed message of that type matching pred, waiting up to timeoutMs; null on timeout.
    // The promise has a cancel(): it stops listening without consuming anything and resolves null
    // (for a wait that lost a race -- a waiter left behind would swallow the next message).
    function waitFor(type, pred, timeoutMs) {
        for (let p of inbox) if (!p.used && p.t == type && (!pred || pred(p))) { p.used = true; let r = Promise.resolve(p); r.cancel = function() { }; return r; }
        let off = null, t = null, done = false, res = null;
        let pr = new Promise(function(resolve) {
            res = resolve;
            off = on(type, function(p) { if (done || p.used) return; done = true; p.used = true; if (t) clearTimeout(t); off(); resolve(p); }, pred);
            t = setTimeout(function() { if (done) return; done = true; off(); resolve(null); }, timeoutMs == null ? 30000 : timeoutMs);
        });
        pr.cancel = function() { if (done) return; done = true; if (t) clearTimeout(t); if (off) off(); res(null); };
        return pr;
    }
    // The first unconsumed message of any of several types matching pred (which sees p.t); null on timeout.
    function waitForAny(types, pred, timeoutMs) {
        for (let p of inbox) if (!p.used && types.indexOf(p.t) >= 0 && (!pred || pred(p))) { p.used = true; let r = Promise.resolve(p); r.cancel = function() { }; return r; }
        let offs = [ ], t = null, done = false, res = null;
        let pr = new Promise(function(resolve) {
            res = resolve;
            let take = function(p) { if (done || p.used) return; done = true; p.used = true; if (t) clearTimeout(t); offs.forEach(function(f) { f(); }); resolve(p); };
            for (let ty of types) offs.push(on(ty, take, pred));
            t = setTimeout(function() { if (done) return; done = true; offs.forEach(function(f) { f(); }); resolve(null); }, timeoutMs == null ? 30000 : timeoutMs);
        });
        pr.cancel = function() { if (done) return; done = true; if (t) clearTimeout(t); offs.forEach(function(f) { f(); }); res(null); };
        return pr;
    }
    // Everything unconsumed of a type (e.g. all the wagers that have come in).
    function drain(type, pred) { let out = [ ]; for (let p of inbox) if (!p.used && p.t == type && (!pred || pred(p))) { p.used = true; out.push(p); } return out; }
    function isPresent(userId) { return !!present[userId]; }
    function presence() { return present; }
    // Clock: a few pings to the host; the sample with the shortest round trip wins.
    async function syncClock() {
        if (!user || user.id == hostId) { offset = 0; return 0; }
        let best = null;
        for (let i = 0; i < 6; i++) {
            let t0 = Date.now();
            send('ping', { t0: t0 });
            let pong = await waitFor('pong', function(p) { return p.to == user.id && p.t0 == t0; }, 2500);
            if (pong) { let r = Date.now() - t0; let off = pong.th - (t0 + r / 2); if (!best || r < best.rtt) best = { rtt: r, off: off }; }
            await new Promise(function(r) { setTimeout(r, 250); });
        }
        if (best || offset == 0) offset = best ? best.off : 0;   // a re-sync that got no answer keeps the old offset
        if (best) rtt = best.rtt;
        mlog('clock offset ' + offset + ' ms' + (best ? ' (rtt ' + best.rtt + ')' : ' (no pong)'));
        return offset;
    }
    function hostNow() { return Date.now() + offset; }

    return {
        available: available, init: init, get user() { return user; }, get profile() { return profile; }, get signedIn() { return !!user; },
        signUp: signUp, signIn: signIn, signOut: signOut, deleteAccount: deleteAccount, loadProfile: loadProfile, rename: rename, rpc: rpc,
        syncUp: syncUp, myResults: myResults, leaderboard: leaderboard,
        createRoom: createRoom, setPlayerStatus: setPlayerStatus, joinRoom: joinRoom, roomState: roomState, setRoom: setRoom, startRoom: startRoom, leaveRoom: leaveRoom, abandonRoom: abandonRoom, finishRoom: finishRoom,
        enqueue: enqueue, matchMe: matchMe, dequeue: dequeue, reroll: reroll, noteMaxGame: noteMaxGame,
        connect: connect, warmup: warmup, disconnect: disconnect, send: send, on: on, waitFor: waitFor, waitForAny: waitForAny, drain: drain, get log() { return log; }, isPresent: isPresent, presence: presence, syncClock: syncClock, hostNow: hostNow, onReconnect: onReconnect, get rtt() { return rtt; },
        get roomId() { return roomId; }, get hostId() { return hostId; }, log: log,
    };
})();
