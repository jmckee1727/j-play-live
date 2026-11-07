// The online channel's catch-up after a dropped connection (online.js): a player whose channel
// drops and comes back gets the messages it missed, once each. Runs online.js against an
// in-memory stand-in for the realtime service (no network, no accounts).
// Run: node test/online/replay_test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'online.js'), 'utf8');

// A broadcast hub: channels by name; a "dropped" member misses broadcasts until it rejoins.
function makeHub() {
    const members = [ ];
    return {
        members,
        join(m) { members.push(m); },
        broadcast(from, payload) { for (const m of members) if (m !== from && !m.dropped) m.receive(JSON.parse(JSON.stringify(payload))); },
    };
}
const hub = makeHub();

function makePlayer(id, name) {
    const ctx = { console, setTimeout, clearTimeout, Date, JSON, Math, Promise, Object, Array, String, Number, Error };
    ctx.window = ctx;
    ctx.chrome = { storage: { local: { get(k, cb) { cb({ }); }, set(o, cb) { cb && cb(); }, remove(k, cb) { cb && cb(); } } } };
    let member = null;
    ctx.supabase = { createClient() {
        return {
            auth: { getSession: async () => ({ data: { session: { user: { id } } } }), onAuthStateChange() { } },
            from() { const q = { select() { return q; }, eq() { return q; }, update() { return q; }, maybeSingle: async () => ({ data: { id, name } }), then(f) { return Promise.resolve({ }).then(f); } }; return q; },
            channel() {
                const handlers = { };
                let subCb = null;
                member = {
                    dropped: false,
                    receive(p) { (handlers['broadcast'] || [ ]).forEach(f => f({ payload: p })); },
                    rejoin() { this.dropped = false; subCb && subCb('SUBSCRIBED'); },
                };
                hub.join(member);
                const ch = {
                    on(kind, filter, fn) { (handlers[kind] = handlers[kind] || [ ]).push(fn); return ch; },
                    subscribe(cb) { subCb = cb; setTimeout(() => cb('SUBSCRIBED'), 0); return ch; },
                    track() { }, presenceState() { return { }; },
                    send(m) { hub.broadcast(member, m.payload); },
                };
                return ch;
            },
            removeChannel() { },
        };
    } };
    vm.createContext(ctx);
    vm.runInContext(SRC, ctx);
    return { api: ctx.JPOnline, get member() { return member; } };
}

(async function() {
    const host = makePlayer('host-1', 'Host'), kathy = makePlayer('kathy-2', 'Kathy'), third = makePlayer('third-3', 'Third');
    for (const p of [ host, kathy, third ]) { await p.api.init(); await p.api.connect('room-x', 'host-1'); }

    host.api.send('scores', { seq: 1 });
    await new Promise(r => setTimeout(r, 10));
    assert.ok(await kathy.api.waitFor('scores', p => p.seq == 1, 100), 'Kathy gets messages while connected');

    // Kathy drops; the host moves on to Final Jeopardy and the third player wagers.
    kathy.member.dropped = true;
    host.api.send('fjstart', { round: 'FJ' });
    third.api.send('fjwager', { amount: 500 });
    await new Promise(r => setTimeout(r, 10));
    assert.equal(await kathy.api.waitFor('fjstart', null, 30), null, 'missed while dropped');

    // Kathy's channel comes back: she asks for what she missed, and gets it, once.
    kathy.member.rejoin();
    await new Promise(r => setTimeout(r, 300));
    const fj = await kathy.api.waitFor('fjstart', null, 500);
    assert.ok(fj && fj.round == 'FJ', 'the host message she missed arrives after the rejoin');
    const w = await kathy.api.waitFor('fjwager', null, 500);
    assert.ok(w && w.amount == 500, "another player's message she missed arrives too");
    assert.equal(kathy.api.drain('scores').length, 0, 'nothing she already had comes twice');
    assert.equal(kathy.api.drain('fjstart').length, 0, 'the replay comes once');

    // The others, who never dropped, don't get duplicates from the replay.
    assert.equal(third.api.drain('fjstart').length, 1, 'the third player has fjstart exactly once');
    assert.equal(host.api.drain('fjwager').length, 1, 'the host has the wager exactly once');
    console.log('replay test: ok');
    process.exit(0);
})().catch(e => { console.error('replay test FAILED:', e.message); process.exit(1); });
