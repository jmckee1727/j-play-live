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
        client = supabase.createClient(URL, KEY, { auth: { storage: storage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'jpLiveAuth' } });
        ready = client.auth.getSession().then(function(r) {
            user = r.data && r.data.session ? r.data.session.user : null;
            return user ? loadProfile().then(function() { return true; }, function() { return true; }) : false;
        }).catch(function(e) { mlog('session: ' + e.message); return false; });
        client.auth.onAuthStateChange(function(ev, session) { user = session ? session.user : null; if (!user) profile = null; });
        return ready;
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
    async function signOut() { try { await client.auth.signOut(); } catch (e) { } user = null; profile = null; }
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
    let channel = null, roomId = null, inbox = [ ], seq = 0, listeners = [ ], present = { }, presenceCb = null, offset = 0, hostId = null;
    function connect(id, host, onPresence) {
        disconnect();
        roomId = id; hostId = host; presenceCb = onPresence || null; inbox = [ ]; present = { }; offset = 0;
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
                if (status == 'SUBSCRIBED') { channel.track({ user_id: user.id, name: profile ? profile.name : '?', at: Date.now() }); if (!done) { done = true; resolve(true); } }
                else if ((status == 'CHANNEL_ERROR' || status == 'TIMED_OUT' || status == 'CLOSED') && !done) { done = true; reject(new Error('could not join the game channel (' + status + ')')); }
            });
            setTimeout(function() { if (!done) { done = true; reject(new Error('the game channel did not answer')); } }, 15000);
        });
    }
    function disconnect() { if (channel) { try { client.removeChannel(channel); } catch (e) { } } channel = null; roomId = null; listeners = [ ]; }
    function deliver(p) {
        if (!p || !p.t) return;
        p.seq = ++seq; p.at = Date.now();
        mlog('<- ' + p.t + ' ' + JSON.stringify(p).slice(0, 120));
        if (p.t == 'ping' && user && hostId == user.id) { send('pong', { to: p.from, t0: p.t0, th: Date.now() }); return; }
        inbox.push(p); if (inbox.length > 300) inbox.shift();
        for (let l of listeners.slice()) { try { if (l.type == p.t && (!l.pred || l.pred(p))) { l.fn(p); } } catch (e) { mlog('listener: ' + e.message); } }
    }
    function send(type, data) {
        if (!channel) return;
        let p = Object.assign({ t: type, from: user.id, ts: Date.now() }, data || { });
        mlog('-> ' + type + ' ' + JSON.stringify(data || { }).slice(0, 120));
        channel.send({ type: 'broadcast', event: 'g', payload: p });
    }
    function on(type, fn, pred) { let l = { type: type, fn: fn, pred: pred }; listeners.push(l); return function() { let i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); }; }
    // The first unconsumed message of that type matching pred, waiting up to timeoutMs; null on timeout.
    function waitFor(type, pred, timeoutMs) {
        for (let p of inbox) if (!p.used && p.t == type && (!pred || pred(p))) { p.used = true; return Promise.resolve(p); }
        return new Promise(function(resolve) {
            let off = null, t = null;
            off = on(type, function(p) { if (p.used) return; p.used = true; if (t) clearTimeout(t); off(); resolve(p); }, pred);
            t = setTimeout(function() { off(); resolve(null); }, timeoutMs || 30000);
        });
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
            if (pong) { let rtt = Date.now() - t0; let off = pong.th - (t0 + rtt / 2); if (!best || rtt < best.rtt) best = { rtt: rtt, off: off }; }
            await new Promise(function(r) { setTimeout(r, 250); });
        }
        offset = best ? best.off : 0;
        mlog('clock offset ' + offset + ' ms' + (best ? ' (rtt ' + best.rtt + ')' : ' (no pong)'));
        return offset;
    }
    function hostNow() { return Date.now() + offset; }

    return {
        available: available, init: init, get user() { return user; }, get profile() { return profile; }, get signedIn() { return !!user; },
        signUp: signUp, signIn: signIn, signOut: signOut, deleteAccount: deleteAccount, loadProfile: loadProfile, rename: rename, rpc: rpc,
        syncUp: syncUp, myResults: myResults, leaderboard: leaderboard,
        createRoom: createRoom, joinRoom: joinRoom, roomState: roomState, setRoom: setRoom, startRoom: startRoom, leaveRoom: leaveRoom, abandonRoom: abandonRoom, finishRoom: finishRoom,
        enqueue: enqueue, matchMe: matchMe, dequeue: dequeue, reroll: reroll, noteMaxGame: noteMaxGame,
        connect: connect, disconnect: disconnect, send: send, on: on, waitFor: waitFor, drain: drain, isPresent: isPresent, presence: presence, syncClock: syncClock, hostNow: hostNow,
        get roomId() { return roomId; }, get hostId() { return hostId; }, log: log,
    };
})();
