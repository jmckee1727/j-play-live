// Store screenshots (1280x800): the lobby (a real one, with the test account) and the vote panel.
const { chromium } = require('playwright');
const fs = require('fs'); const path = require('path');
const EXT = path.resolve(__dirname, '..');
const OUT = path.join(EXT, 'store', 'screenshots');
const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'game9537.html'), 'utf8');
(async () => {
  const dir = '/tmp/pw-store-shots'; fs.rmSync(dir, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(dir, { channel: 'chromium', headless: true, executablePath: '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome', args: ['--disable-extensions-except=' + EXT, '--load-extension=' + EXT, '--no-proxy-server'], ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page); const worlds = [];
  cdp.on('Runtime.executionContextCreated', e => { if (/J-Play Live/.test(e.context.name)) worlds.push(e.context.id); });
  await cdp.send('Runtime.enable');
  const inExt = async expr => { for (let i = worlds.length - 1; i >= 0; i--) { try { const r = await cdp.send('Runtime.evaluate', { expression: expr, contextId: worlds[i], returnByValue: true }); if (r.exceptionDetails) return 'EXC ' + JSON.stringify(r.exceptionDetails).slice(0, 300); if (r.result && r.result.value !== undefined) return r.result.value; } catch (e) { } } return null; };
  await page.goto('https://j-archive.com/showgame.php?game_id=9537', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#live_btn', { timeout: 30000 });
  await page.evaluate(() => localStorage.setItem('jpLiveSettings', JSON.stringify({ voiceEngine: 'system', earEngine: 'chrome', readCategories: false, sfx: false, contestantVoices: false, micMode: 'always', settingsVersion: 6, onboardedVoice: true, players: [{ name: 'You', key: ' ' }], playerCount: 1, mousePlayer: 0, contestantsOn: true, difficulty: 'medium' })));
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForSelector('#live_btn', { timeout: 30000 });
  await page.click('#live_btn');
  await page.waitForSelector('.jp-online-box .jp-signin', { timeout: 30000 });
  await page.click('.jp-online-box .jp-signin');
  await page.fill('.jp-acct-email', 'jplay-test-ann@example.com'); await page.fill('.jp-acct-pw', 'testpass-Ann'); await page.click('.jp-acct-go');
  await page.waitForSelector('.jp-online-box .jp-signout', { timeout: 30000 });
  await page.click('.jp-online-box .jp-lobby');
  await page.waitForSelector('.jp-copy-link', { timeout: 30000 });
  // Dress the lobby up a little: two more rows, as a real lobby looks once friends have joined.
  await page.evaluate(() => {
    const t = document.querySelector('.jp-lobby-table'); if (!t) return;
    const mk = (name, rating, mic, ready) => '<tr><td>' + name + '</td><td class="jp-note">' + rating + '</td><td>' + mic + '</td><td>' + ready + '</td></tr>';
    t.insertAdjacentHTML('beforeend', mk('Priya', 'rating 1312', '<span class="jp-plus">mic ok</span>', '<span class="jp-plus">ready</span>') + mk('Marcus', 'unrated', '<span class="jp-plus">mic ok</span>', '<span class="jp-note">not ready</span>'));
    const st = document.querySelector('.jp-online-status'); if (st) st.textContent = 'Waiting for Marcus to be ready…';
    const me = t.querySelector('tr.jp-you td'); if (me) me.innerHTML = me.innerHTML.replace('Test Ann', 'Dana');
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: OUT + '/6-lobby.png' });
  await page.click('.jp-cancel');
  await page.waitForSelector('.jp-start', { timeout: 20000 });
  // A game, then the vote panel on a synthesized state.
  await page.click('.jp-start');
  await page.waitForSelector('.jp-clue, .jp-cell.jp-pickable', { timeout: 40000 });
  const v = `{ vid: '7:Priya', who: 'Priya', want: 'right', callerId: 'a', caller: 'Priya', said: 'what is the Seine', correct: 'the Seine', label: 'RIVERS OF EUROPE for $800', ballots: { a: true }, verdict: null, yes: 0, no: 0, of: 3, at: Date.now(), timer: null }`;
  console.log(await inExt(`(function() { var G = jpLiveDebug.state; G.online = { players: [{ user_id: 'a' }, { user_id: 'b' }, { user_id: 'c' }], byId: { a: 'Priya', b: 'Marcus', c: 'You' }, byName: { Priya: 'a', Marcus: 'b', You: 'c' }, me: 'You', myId: 'c', hostId: 'a', host: false, mode: 'custom', votes: { }, gone: { }, names: ['Priya', 'Marcus', 'You'], calls: [] }; G.humans = ['Priya', 'Marcus', 'You']; G.scores = { Priya: 5400, Marcus: 3200, You: 4600 }; jpLiveDebug.votePanel(${v}); return 'ok'; })()`));
  await page.evaluate(() => { document.querySelectorAll('.jp-podium').forEach(p => p.remove()); });
  await inExt(`(function() { var G = jpLiveDebug.state; var pods = document.querySelector('.jp-podiums'); pods.innerHTML = ['Priya','Marcus','You'].map(function(n) { return '<div class="jp-podium" data-who="' + n + '"><div class="jp-pscore">$' + G.scores[n].toLocaleString() + '</div><div class="jp-pname">' + n + '</div><div class="jp-pline"></div></div>'; }).join(''); return 'ok'; })()`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: OUT + '/7-vote.png' });
  await ctx.close(); console.log('done');
})().catch(e => { console.error('ERR', e); process.exit(1); });
