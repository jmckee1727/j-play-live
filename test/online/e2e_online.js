// Three browsers with the extension loaded play an online game against the live
// service: a custom lobby (Ann hosts, Bob and Cy join by code, everyone readies up)
// and/or a ranked match from the queue. Bots pick, ring in, type responses and
// wagers; with VOTE=1 they call votes on their wrong rulings (and a challenge now and
// then) and cast ballots; with PAUSE=1 one of them asks for a pause once. Everyone
// must reach the final screen with the same standings, verdicts and rulings, and the
// service must hold the results.
//   MODE=lobby|ranked|both (default lobby)   VOTE=1   PAUSE=1   CONTESTANTS=1 (lobby with the archive contestants)
// Needs direct network (the browsers run with --no-proxy-server).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const api = require('./api');
const EXT = path.resolve(__dirname, '..', '..');
const OUT = process.env.OUT || '/tmp/jpl-e2e';
const MODE = process.env.MODE || 'lobby';
const VOTE = !!process.env.VOTE, PAUSE = !!process.env.PAUSE;
const USERS = [ { n: 'Ann', email: 'jplay-test-ann@example.com', pw: 'testpass-Ann' }, { n: 'Bob', email: 'jplay-test-bob@example.com', pw: 'testpass-Bob' }, { n: 'Cy', email: 'jplay-test-cy@example.com', pw: 'testpass-Cy' } ];
let fails = 0;
function check(name, ok, info) { console.log((ok ? 'PASS ' : 'FAIL ') + name + (info ? ' — ' + String(info).slice(0, 400) : '')); if (!ok) fails++; }
fs.mkdirSync(OUT, { recursive: true });

async function launch(u) {
  const dir = '/tmp/pw-online-' + u.n.toLowerCase();
  fs.rmSync(dir, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: 'chromium', headless: true, executablePath: '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome',
    args: [ '--disable-extensions-except=' + EXT, '--load-extension=' + EXT, '--no-proxy-server', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required' ],
    ignoreHTTPSErrors: true, viewport: { width: 1400, height: 850 },
  });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page); const worlds = [];
  cdp.on('Runtime.executionContextCreated', e => { if (/J-Play Live/.test(e.context.name)) worlds.push(e.context.id); });
  cdp.on('Runtime.executionContextDestroyed', e => { const i = worlds.indexOf(e.executionContextId); if (i >= 0) worlds.splice(i, 1); });
  await cdp.send('Runtime.enable');
  const inExt = async expr => { for (let i = worlds.length - 1; i >= 0; i--) { try { const r = await cdp.send('Runtime.evaluate', { expression: expr, contextId: worlds[i], returnByValue: true }); if (r.exceptionDetails) return 'EXC ' + JSON.stringify(r.exceptionDetails).slice(0, 300); if (r.result && r.result.value !== undefined) return r.result.value; } catch (e) { } } return null; };
  page.on('pageerror', e => console.log('[' + u.n + ' pageerror] ' + e.message));
  page.on('console', m => { if (m.type() == 'error' && !/favicon|net::ERR|403|404/.test(m.text())) console.log('[' + u.n + ' console] ' + m.text().slice(0, 200)); });
  return { u, ctx, page, cdp, inExt, stats: { picks: 0, buzzes: 0, typed: 0, wagers: 0 } };
}

async function signIn(b) {
  const { page, u } = b;
  await page.goto('https://j-archive.com/showgame.php?game_id=9537', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#live_btn', { timeout: 30000 });
  await page.evaluate((cont) => localStorage.setItem('jpLiveSettings', JSON.stringify({ voiceEngine: 'system', earEngine: 'chrome', readCategories: false, sfx: false, contestantVoices: false, micMode: 'off', difficulty: 'custom', customMedian: 600, customSpread: 0.4, answerSeconds: 3, buzzWindowSeconds: 2, lockoutMs: 200, ddAnswerSeconds: 3, fjSeconds: 4, autoAdvanceMs: 600, contestantsOn: cont, playerCount: 1, players: [ { name: 'You', key: ' ' }, { name: 'P2', key: 'a' }, { name: 'P3', key: 'l' } ], mousePlayer: 0, settingsVersion: 6, onboardedVoice: true })), !!process.env.CONTESTANTS);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#live_btn', { timeout: 30000 });
  await page.click('#live_btn');
  await page.waitForSelector('.jp-online-box .jp-signin', { timeout: 30000 });
  await page.click('.jp-online-box .jp-signin');
  await page.fill('.jp-acct-email', u.email);
  await page.fill('.jp-acct-pw', u.pw);
  await page.click('.jp-acct-go');
  await page.waitForSelector('.jp-online-box .jp-signout', { timeout: 30000 });
  const box = await page.textContent('.jp-online-box');
  check(u.n + ' signed in', /Signed in as Test /.test(box), box.slice(0, 80));
}

// The bot: one tick every 150 ms while a game is on.
function startBot(b) {
  let lit = null, pickCell = null, wager = null, answered = null, stop = false, lastCall = null, lastBallot = null, pausedAt = 0, paused = false;
  let rng = b.u.n.charCodeAt(0) * 7919;
  const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
  b.stats.calls = 0; b.stats.ballots = 0; b.stats.challenges = 0; b.stats.pauses = 0; b.stats.resumes = 0;
  (async () => {
    while (!stop) {
      try {
        const st = await b.page.evaluate(() => {
          const q = s => document.querySelector(s);
          const lit = q('.jp-clue.jp-lit'), cell = q('.jp-cell.jp-pickable'), w = q('.jp-wager'), inp = q('.jp-answer.jp-show .jp-input');
          const hint = (q('.jp-hint') || {}).textContent || '';
          const call = q('.jp-hint button[data-call="vote"], .jp-vote-panel button[data-call="vote"]'), pauseBtn = q('.jp-hint button[data-call="pause"]');
          const ballot = q('.jp-vote-panel .jp-vote-yes'), resume = q('.jp-resume-online');
          return { lit: !!lit, cell: !!cell, cellKey: cell ? cell.dataset.num : null,
                   wager: !!w, wagerKey: w ? (w.dataset.k || (w.dataset.k = String(Math.random()))) : null, wmin: w ? +w.min : 0, wmax: w ? +w.max : 0,
                   input: !!inp, hint, done: !!q('.jp-again'), lost: /Connection lost|never arrived|That game is over/.test((q('.jp-panel h1') || {}).textContent || ''),
                   callVid: call ? call.dataset.vid : null, callKind: call ? (/Challenge/.test(call.textContent) ? 'wrong' : 'right') : null, canPause: !!pauseBtn, ballotKey: ballot ? ((q('.jp-vote-panel') || {}).dataset || {}).vid || 'x' : null, resume: !!resume };
        });
        if (st.done || st.lost) { stop = true; break; }
        if (VOTE && st.callVid && st.callVid !== lastCall) {
          lastCall = st.callVid;
          if (st.callKind == 'right' || b.stats.challenges < 1) {
            b.stats.calls++; if (st.callKind == 'wrong') b.stats.challenges++;
            if (rand() < 0.5) await b.page.click('button[data-call="vote"][data-vid="' + st.callVid + '"]'); else await b.page.keyboard.press(st.callKind == 'right' ? 'y' : 'n');
          }
        }
        if (PAUSE && st.canPause && b.stats.pauses < 1 && b.u.n == 'Bob' && b.stats.picks + b.stats.buzzes > 8) { b.stats.pauses++; await b.page.keyboard.press('p'); }
        if (st.ballotKey && st.ballotKey !== lastBallot) {
          lastBallot = st.ballotKey; b.stats.ballots++;
          const yes = rand() < 0.7;
          if (rand() < 0.5) await b.page.click('.jp-vote-panel ' + (yes ? '.jp-vote-yes' : '.jp-vote-no')); else await b.page.keyboard.press(yes ? 'y' : 'n');
        }
        if (st.resume) { if (!paused) { paused = true; pausedAt = Date.now(); } else if (Date.now() - pausedAt > 2500 && b.u.n == 'Cy') { b.stats.resumes++; await b.page.click('.jp-resume-online').catch(() => {}); } }
        else paused = false;
        if (st.cell && st.cellKey !== pickCell) { pickCell = st.cellKey; b.stats.picks++; await b.page.click('.jp-cell.jp-pickable').catch(() => {}); }
        if (st.lit && !lit) { if (rand() < 0.75) { await new Promise(r => setTimeout(r, 30 + rand() * 400)); b.stats.buzzes++; await b.page.keyboard.press('Space'); } }
        lit = st.lit;
        if (st.wager && st.wagerKey !== wager) { wager = st.wagerKey; b.stats.wagers++; await b.page.fill('.jp-wager', String(Math.max(st.wmin, Math.min(st.wmax, 1000)))); await b.page.click('.jp-ok'); }
        if (st.input && !answered) {
          const correct = await b.inExt('(function(){ var s = jpLiveDebug.state; if (s.round == "FJ" && window.clues && clues[61]) return clues[61].correct_response || ""; return s.current ? s.current.correct : ""; })()');
          const text = rand() < 0.6 && correct ? 'what is ' + String(correct).replace(/<[^>]+>/g, '') : 'banana bread';
          b.stats.typed++;
          await b.page.fill('.jp-answer.jp-show .jp-input', text);
          await b.page.keyboard.press('Enter');
        }
        answered = st.input;
      } catch (e) { }
      await new Promise(r => setTimeout(r, 150));
    }
  })();
  return () => { stop = true; };
}

async function diagnose(bots, label) {
  for (const b of bots) {
    const info = await b.page.evaluate(() => ({ h1: (document.querySelector('.jp-panel h1') || {}).textContent, hint: ((document.querySelector('.jp-hint') || {}).textContent || '').slice(0, 120), input: !!document.querySelector('.jp-answer.jp-show') })).catch(() => ({}));
    const log = await b.inExt('JSON.stringify((JPOnline.log || []).slice(-14).map(function(e) { return e.m.slice(0, 90); }))').catch(() => 'x');
    const st = await b.inExt('JSON.stringify({ phase: jpLiveDebug.state.phase, control: jpLiveDebug.state.control, cur: jpLiveDebug.state.current && jpLiveDebug.state.current.num, interlude: !!(jpLiveDebug.state.online && jpLiveDebug.state.online.interlude), calls: jpLiveDebug.state.online && (jpLiveDebug.state.online.calls || []).length })').catch(() => 'x');
    console.log(label + ' [' + b.u.n + '] ' + JSON.stringify(info) + ' ' + st + '\n   ' + log);
  }
}
async function waitDone(bots, label, timeoutMs) {
  const t0 = Date.now();
  let lastPlayed = -1, lastChange = Date.now(), stalls = 0;
  while (Date.now() - t0 < timeoutMs) {
    const done = await Promise.all(bots.map(b => b.page.evaluate(() => !!document.querySelector('.jp-again') || /Connection lost|never arrived/.test((document.querySelector('.jp-panel h1') || {}).textContent || '')).catch(() => false)));
    if (done.every(Boolean)) return true;
    const played = +(await bots[0].inExt('Object.keys(jpLiveDebug.state.played).length').catch(() => 0)) || 0;
    if (played != lastPlayed) { lastPlayed = played; lastChange = Date.now(); }
    else if (Date.now() - lastChange > (+process.env.STALL_MS || 45000) && stalls < 6) { stalls++; lastChange = Date.now(); console.log(label + ': no new clue for 45 s — diagnostics'); await diagnose(bots, label); }
    if (Math.round((Date.now() - t0) / 1000) % 60 == 0) console.log(label + ' +' + Math.round((Date.now() - t0) / 1000) + 's', await Promise.all(bots.map(b => b.inExt('jpLiveDebug.state.round + ":" + Object.keys(jpLiveDebug.state.played).length + " " + JSON.stringify(jpLiveDebug.state.scores)').catch(() => '?'))));
    await new Promise(r => setTimeout(r, 1000));
  }
  console.log(label + ': not everyone finished');
  await diagnose(bots, label);
  return false;
}

async function playGame(bots, label) {
  const stops = bots.map(startBot);
  const t0 = Date.now();
  const ok = await waitDone(bots, label, 12 * 60 * 1000);
  stops.forEach(s => s());
  console.log(label + ' finished in ' + ((Date.now() - t0) / 1000).toFixed(0) + ' s; bots:', bots.map(b => b.u.n + ' ' + JSON.stringify(b.stats)).join(' | '));
  const states = await Promise.all(bots.map(b => b.inExt('JSON.stringify({ scores: jpLiveDebug.state.scores, round: jpLiveDebug.state.round, played: Object.keys(jpLiveDebug.state.played).length, results: jpLiveDebug.state.results.length, online: jpLiveDebug.state.online ? { mode: jpLiveDebug.state.online.mode, me: jpLiveDebug.state.online.me, host: jpLiveDebug.state.online.host, deltas: jpLiveDebug.state.online.deltas } : null })')));
  const parsed = states.map(s => { try { return JSON.parse(s); } catch (e) { return null; } });
  console.log(label + ' states:', parsed.map((p, i) => bots[i].u.n + ': ' + (p ? JSON.stringify(p.scores) + ' clues ' + p.played + ' host ' + (p.online && p.online.host) : 'null')).join(' | '));
  check(label + ': everyone reached the final screen', ok);
  check(label + ': all three clients agree on the standings', parsed.every(p => p && JSON.stringify(p.scores) == JSON.stringify(parsed[0].scores)), parsed.map(p => p && JSON.stringify(p.scores)).join(' vs '));
  const avail = +(await bots[0].inExt('Object.keys(clues).filter(function(n) { return +n <= 60 && clues[n] && clues[n].id; }).length').catch(() => 60)) || 60;
  check(label + ': every clue was played (' + avail + ' in the archive)', parsed.every(p => p && p.played == avail), parsed.map(p => p && p.played).join(','));
  // Votes: every client holds the same verdicts and the same rulings on every response.
  const votesAll = await Promise.all(bots.map(b => b.inExt('JSON.stringify(Object.values((jpLiveDebug.state.online && jpLiveDebug.state.online.votes) || {}).map(function(v) { return [v.vid, v.verdict, v.yes, v.no, v.want]; }).sort())').catch(() => 'x')));
  const rulings = await Promise.all(bots.map(b => b.inExt('JSON.stringify(jpLiveDebug.state.results.map(function(r) { return [r.kind, r.num, r.who, r.outcome, r.id, r.voided || null]; }))').catch(() => 'x')));
  console.log(label + ' votes:', votesAll[0], '· bots:', bots.map(b => b.u.n + ' calls ' + b.stats.calls + ' ballots ' + b.stats.ballots + ' pauses ' + b.stats.pauses).join(', '));
  check(label + ': all clients agree on the verdicts', votesAll.every(v => v == votesAll[0]), votesAll.join(' vs ').slice(0, 300));
  check(label + ': all clients agree on every ruling', rulings.every(r => r == rulings[0]), rulings.map(r => r.slice(0, 80)).join(' vs '));
  let vs = []; try { vs = JSON.parse(votesAll[0]); } catch (e) { }
  let recs = []; try { recs = JSON.parse(rulings[0]); } catch (e) { }
  if (VOTE) {
    check(label + ': votes were held and settled', vs.length > 0 && vs.every(v => v[1]), votesAll[0].slice(0, 200));
    check(label + ': at least one vote reversed a ruling', vs.some(v => v[1] == 'right' || v[1] == 'wrong'), votesAll[0].slice(0, 200));
    // A reversal to right voids whoever answered after on that clue (their money comes back off).
    let cascadeOk = true, cascades = 0, bad = [];
    for (const v of vs) {
      if (v[1] != 'right') continue;
      const [num, who] = v[0].split(':');
      const mine = recs.find(r => String(r[1]) == num && r[2] == who && r[0] != 'fj');
      if (!mine) continue;
      for (const r of recs) if (String(r[1]) == num && r[0] == mine[0] && r[4] > mine[4]) { cascades++; if (r[3] != 'none' || !r[5]) { cascadeOk = false; bad.push(v[0] + ' -> ' + JSON.stringify(r)); } }
    }
    check(label + ': reversals void the responses that followed (' + cascades + ' seen)', cascadeOk, bad.join('; '));
  }
  if (PAUSE) check(label + ': a pause was asked for and voted on', vs.some(v => v[4] == 'pause'), votesAll[0].slice(0, 200));
  const panels = await Promise.all(bots.map(b => b.page.textContent('.jp-panel').catch(() => '')));
  try { await bots[0].page.screenshot({ path: OUT + '/on_final_' + label + '.png' }); } catch (e) { }
  return { parsed, panels };
}

(async () => {
  const bots = [];
  for (const u of USERS) bots.push(await launch(u));
  for (const b of bots) await signIn(b);
  const tokens = {};
  for (const u of USERS) { const t = await api.signin(u.email, u.pw); tokens[u.n] = t.body.access_token; }

  if (MODE == 'lobby' || MODE == 'both') {
    // ---- custom lobby: Ann creates, Bob and Cy join by code and ready up, Ann starts.
    const [ann, bob, cy] = bots;
    await ann.page.click('.jp-online-box .jp-lobby');
    await ann.page.waitForSelector('.jp-copy-link', { timeout: 30000 });
    const code = (await ann.page.textContent('.jp-panel h1 .jp-code')).trim();
    check('lobby created with a code', /^[A-Z]{6}$/.test(code), code);
    for (const b of [bob, cy]) { await b.page.fill('.jp-online-box .jp-join-code', code.toLowerCase()); await b.page.click('.jp-online-box .jp-join'); await b.page.waitForSelector('.jp-copy-link', { timeout: 30000 }); }
    await ann.page.waitForFunction(() => document.querySelectorAll('.jp-lobby-table tr').length >= 3, null, { timeout: 30000 }).catch(() => {});
    const lobbyRows = await ann.page.$$eval('.jp-lobby-table tr', rs => rs.map(r => r.textContent.replace(/\s+/g, ' ').trim()));
    check('the host sees all three in the lobby', lobbyRows.length == 3, lobbyRows.join(' / '));
    const lobbyText = await ann.page.textContent('.jp-panel');
    check('lobby shows this game and the settings', /Show #9620/.test(lobbyText) && (process.env.CONTESTANTS ? /with the archive contestants/ : /no archive contestants/).test(lobbyText), lobbyText.slice(0, 120));
    check('non-hosts have no settings button', !(await bob.page.$('.jp-room-settings')) && !!(await ann.page.$('.jp-room-settings')));
    check('the host cannot start before everyone is ready', await ann.page.$eval('.jp-start-room', b => b.disabled));
    // mic test (a fake device here), then ready
    await bob.page.click('.jp-mic-test');
    await bob.page.waitForFunction(() => /mic ok|mic quiet|no mic|typing/.test((document.querySelector('.jp-lobby-table') || {}).textContent || '') && !document.querySelector('.jp-mic-test:disabled'), null, { timeout: 20000 }).catch(() => {});
    const micRow = await bob.page.$$eval('.jp-lobby-table tr.jp-you', rs => rs.map(r => r.textContent.replace(/\s+/g, ' ')).join(''));
    check('the mic test leaves a status on the row', /mic ok|mic quiet|no mic|typing/.test(micRow), micRow);
    for (const b of [bob, cy]) { await b.page.click('.jp-ready'); await b.page.waitForFunction(() => /Unready/.test((document.querySelector('.jp-ready') || {}).textContent || ''), null, { timeout: 20000 }); }
    await ann.page.waitForFunction(() => { const b = document.querySelector('.jp-start-room'); return b && !b.disabled; }, null, { timeout: 30000 }).catch(() => {});
    check('the host sees everyone ready', !(await ann.page.$eval('.jp-start-room', b => b.disabled)), await ann.page.textContent('.jp-online-status'));
    const cyRow = await ann.page.$$eval('.jp-lobby-table tr', rs => rs.map(r => r.textContent.replace(/\s+/g, ' ')).join(' | '));
    check('the host sees the mic status of the others', /mic ok|mic quiet|no mic|typing/.test(cyRow), cyRow);
    await ann.page.click('.jp-start-room');
    for (const b of bots) await b.page.waitForFunction(() => /jplive-room=|showgame/.test(location.href) && document.querySelector('.jp-podium'), null, { timeout: 40000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 1500));
    const { parsed, panels } = await playGame(bots, 'lobby');
    check('lobby: final screen says custom lobby', panels.every(p => /Custom lobby/.test(p)), panels[0].slice(0, 100));
    const roomId = await ann.inExt('jpLiveDebug.state.online && jpLiveDebug.state.online.room.id');
    const res = await api.select('results', 'select=user_id,score,place,mode&room_id=eq.' + roomId + '&order=place', tokens.Ann);
    check('lobby: results recorded for all three', res.status == 200 && res.body.length == 3 && res.body.every(r => r.mode == 'custom'), JSON.stringify(res.body).slice(0, 200));
    const ann0 = parsed[0];
    if (ann0 && res.body.length) { const mine = res.body.find(r => r.score == ann0.scores[ann0.online.me]); check('lobby: recorded score matches the screen', !!mine, JSON.stringify(res.body.map(r => r.score)) + ' vs ' + JSON.stringify(ann0.scores)); }
    for (const b of bots) { await b.page.click('.jp-again'); await b.page.waitForSelector('.jp-online-box .jp-signout', { timeout: 30000 }).catch(() => {}); }
  }

  if (MODE == 'ranked' || MODE == 'both') {
    const before = {};
    for (const u of USERS) { const p = await api.select('profiles', 'select=elo,ranked_games&name=eq.Test%20' + u.n, tokens.Ann); before[u.n] = p.body[0]; }
    for (const b of bots) { await b.page.click('.jp-online-box .jp-ranked'); await b.page.waitForSelector('.jp-queue-time', { timeout: 30000 }); }
    for (const b of bots) await b.page.waitForURL(/game_id=(?!9537)\d+/, { timeout: 120000 }).catch(() => {});
    for (const b of bots) await b.page.waitForSelector('.jp-online-status', { timeout: 60000 }).catch(() => {});
    const urls = bots.map(b => b.page.url());
    const gid = (urls[0].match(/game_id=(\d+)/) || [])[1];
    check('ranked: all three landed on the same game', urls.every(u => u.includes('game_id=' + gid)) && gid != '9537', urls.join(' '));
    const { parsed, panels } = await playGame(bots, 'ranked');
    check('ranked: rating lines shown', panels.every(p => /Your rating: \d+ → \d+/.test(p)), panels.map(p => (p.match(/Your rating[^)]*\)/) || [''])[0]).join(' | '));
    const after = {};
    for (const u of USERS) { const p = await api.select('profiles', 'select=elo,ranked_games&name=eq.Test%20' + u.n, tokens.Ann); after[u.n] = p.body[0]; }
    check('ranked: every profile gained a ranked game', USERS.every(u => after[u.n].ranked_games == before[u.n].ranked_games + 1), JSON.stringify(after));
    const sum = USERS.reduce((a, u) => a + (after[u.n].elo - before[u.n].elo), 0);
    check('ranked: rating changes sum to about zero', Math.abs(sum) <= 2, 'sum ' + sum);
    const played = await api.select('played', 'select=archive_game_id&archive_game_id=eq.' + gid, tokens.Ann);
    check('ranked: the game is marked played for the account', played.body.length == 1, JSON.stringify(played.body));
  }
  for (const b of bots) await b.ctx.close();
  console.log(fails ? fails + ' FAILED' : 'ALL PASS');
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error('ERR', e); process.exit(1); });
