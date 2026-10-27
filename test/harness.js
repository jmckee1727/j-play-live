// Plays a whole game in jsdom with a simulated player (clicks, ring-ins, spoken and typed
// responses, wagers) to shake out runtime errors in the game flow, and checks what the
// end of the game leaves behind (saved games, the played-games record, the final screen).
// Modes (environment): MULTI=2|3 (several people at one keyboard), NOCONT=1 (no archive
// contestants), SWEEP=1 (always right, picks in order: runs categories; the success cues
// must fire), EDIT=1 (edit results from the pause menu), CASCADE=1 (mark a miss right:
// the contestants who followed give their money back), CONTROL=1 (control follows a
// "y" during the pick), REWIND=1, REWINDFJ=1, PAUSE=1, MEDIA=none|half|full.
// Needs test/fixtures/game9537.html (test/fetch_fixture.sh).
const { JSDOM, VirtualConsole } = require('jsdom');
const fs = require('fs');
const path = require('path');
const EXT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(__dirname, 'fixtures', 'game9537.html'), 'utf8');
const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', e => { if (!/Could not load|not implemented/i.test(e.message || '')) errors.push('jsdomError: ' + (e.message || e)); });
vc.on('error', (...a) => { errors.push('console.error: ' + a.join(' ')); });
vc.on('warn', () => {});
vc.on('log', (...a) => { if (process.env.VERBOSE) console.log('[page]', ...a); });
const dom = new JSDOM(html, { url: 'https://j-archive.com/showgame.php?game_id=9537', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
const w = dom.window, doc = w.document;
const MULTI = +process.env.MULTI || 0;
const SWEEP = !!process.env.SWEEP;
const HUMAN_KEYS = [ [' ', 'Space'], ['a', 'KeyA'], ['l', 'KeyL'] ];

// ---- browser stubs ---------------------------------------------------------------
w.CSS = { escape: s => String(s).replace(/([^\w-])/g, '\\$1') };
// jsdom has no innerText; the archive's own markup is read with it.
Object.defineProperty(w.HTMLElement.prototype, 'innerText', { get() { return this.textContent; }, set(v) { this.textContent = v; }, configurable: true });
w.HTMLElement.prototype.scrollIntoView = function() {};
const store = {};
w.chrome = { runtime: { getURL: p => 'chrome-extension://test/' + p, sendMessage: (m, cb) => { if (cb) cb({ ok: false }); return Promise.resolve({ ok: false }); }, onMessage: { addListener() {} }, lastError: null, id: 'test' },
             storage: { local: { get: (k, cb) => { const o = {}; (Array.isArray(k) ? k : [k]).forEach(x => { if (x in store) o[x] = store[x]; }); cb(o); }, set: (o, cb) => { Object.assign(store, o); if (cb) cb(); }, remove: (k, cb) => { (Array.isArray(k) ? k : [k]).forEach(x => delete store[x]); if (cb) cb(); } }, onChanged: { addListener() {} } } };
w.fetch = () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}), text: () => Promise.resolve('') });
w.AudioContext = undefined; w.webkitAudioContext = undefined;
w.requestAnimationFrame = f => setTimeout(() => f(Date.now()), 16);
const spoken = [];
w.speechSynthesis = { getVoices: () => [], speak(u) { spoken.push(u.text); setTimeout(() => { if (u.onend) u.onend(); }, 15 + Math.min(600, u.text.length * 2)); }, cancel() {}, pause() {}, resume() {}, speaking: false, paused: false };
w.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; this.rate = 1; this.pitch = 1; this.volume = 1; } };
// The recognizer: hears what the bot "says" shortly after it starts.
let botTranscript = () => '';
let srStarts = 0;
w.webkitSpeechRecognition = class {
  constructor() { this.continuous = false; this.interimResults = false; this.maxAlternatives = 1; this._t = null; }
  start() { srStarts++; if (this.onstart) this.onstart(); const text = botTranscript(); this._t = setTimeout(() => { if (!text) { if (this.onend) this.onend(); return; } const results = [ Object.assign([ { transcript: text, confidence: 0.9 } ], { isFinal: true, length: 1 }) ]; if (this.onresult) this.onresult({ results, resultIndex: 0 }); setTimeout(() => { if (this.onend) this.onend(); }, 50); }, 250 + Math.random() * 300); }
  stop() { clearTimeout(this._t); setTimeout(() => { if (this.onend) this.onend(); }, 10); }
  abort() { clearTimeout(this._t); setTimeout(() => { if (this.onend) this.onend(); }, 10); }
};
w.navigator.mediaDevices = undefined;

// Settings before the scripts load.
w.localStorage.setItem('jpLiveSettings', JSON.stringify({
  voiceEngine: 'system', earEngine: 'chrome', readCategories: false, sfx: true, contestantVoices: false, micMode: 'always', answerMode: 'speech', difficulty: 'custom', customMedian: 700, customSpread: 0.4,
  answerSeconds: 2, buzzWindowSeconds: 1.2, lockoutMs: 150, ddAnswerSeconds: 2, fjSeconds: 2, autoAdvanceMs: 120, mediaCredit: process.env.MEDIA || 'none', settingsVersion: 6, onboardedVoice: true, voicePick: false,
  playerCount: MULTI || 1, players: [ { name: 'Ann', key: ' ' }, { name: 'Bob', key: 'a' }, { name: 'Cy', key: 'l' } ], mousePlayer: MULTI ? 1 : 0, contestantsOn: !process.env.NOCONT,
}));
w.addEventListener('error', e => errors.push('window.error: ' + (e.error && e.error.stack || e.message)));
process.on('unhandledRejection', r => errors.push('unhandledRejection: ' + (r && r.stack || r)));

// ---- load the extension scripts in order (one global scope, like a content-script world)
for (const f of ['played.js', 'archive.js', 'clock.js', 'audio.js', 'judge.js', 'wagers.js', 'interpret.js', 'reader.js', 'names.js', 'neural.js', 'ear.js', 'live.js']) {
  try { w.eval(fs.readFileSync(path.join(EXT, f), 'utf8')); }
  catch (e) { errors.push('load ' + f + ': ' + e.stack); }
}
const cues = {};
{ const orig = w.JPAudio.play; w.JPAudio.play = function(name) { cues[name] = (cues[name] || 0) + 1; return orig.apply(this, arguments); }; }

// ---- the bot -------------------------------------------------------------------
const stats = { picks: 0, buzzes: 0, wagers: 0, enters: 0, answersHeard: 0 };
let rng = 12345;
const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
function currentCorrect() {
  const st = w.jpLiveDebug && w.jpLiveDebug.state;
  if (!st) return '';
  if (st.round == 'FJ' && w.clues[61]) return w.clues[61].correct_response || '';
  return st.current ? st.current.correct : '';
}
botTranscript = () => {
  stats.answersHeard++;
  const c = currentCorrect().replace(/<[^>]+>/g, '');
  return (SWEEP || rand() < 0.65) ? 'what is ' + c : 'banana bread';
};
function key(k, code) { doc.dispatchEvent(new w.KeyboardEvent('keydown', { key: k, code: code || k, bubbles: true, cancelable: true })); }
let litHandled = null, wagerHandled = null, pickHandled = null, fjBuzzed = false;
const mo = new w.MutationObserver(() => {
  const cells = doc.querySelectorAll('.jp-cell.jp-pickable');
  if (cells.length && pickHandled !== cells[0]) {
    pickHandled = cells[0];
    const cell = SWEEP ? Array.from(cells).sort((a, b) => +a.dataset.num - +b.dataset.num)[0] : cells[Math.floor(rand() * cells.length)];
    setTimeout(() => { stats.picks++; cell.click(); }, 30);
  }
  const lit = doc.querySelector('.jp-clue.jp-lit');
  if (lit && litHandled !== lit) {
    litHandled = lit;
    if (SWEEP || rand() < 0.7) setTimeout(() => {
      stats.buzzes++;
      if (MULTI) { const i = Math.floor(rand() * MULTI); stats['buzz' + i] = (stats['buzz' + i] || 0) + 1; if (i == 1 && rand() < 0.5) { stats.mouseBuzzes = (stats.mouseBuzzes || 0) + 1; lit.dispatchEvent(new w.MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true })); } else key(HUMAN_KEYS[i][0], HUMAN_KEYS[i][1]); }
      else if (rand() < 0.5) key(' ', 'Space'); else { stats.mouseBuzzes = (stats.mouseBuzzes || 0) + 1; lit.dispatchEvent(new w.MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true })); }
    }, 20 + rand() * 250);
    if (MULTI > 1 && rand() < 0.4) setTimeout(() => { stats.secondBuzzes = (stats.secondBuzzes || 0) + 1; key(HUMAN_KEYS[MULTI - 1][0], HUMAN_KEYS[MULTI - 1][1]); }, 200 + rand() * 600);
  }
  const clue = doc.querySelector('.jp-clue');
  if (clue && !lit && clue !== litHandled && !SWEEP && rand() < 0.15) { litHandled = clue; setTimeout(() => key(' ', 'Space'), 30); }   // early buzz -> lockout
  const hint = doc.querySelector('.jp-hint');
  if (hint && /ready to respond/.test(hint.textContent) && !fjBuzzed) {
    fjBuzzed = true;
    setTimeout(() => { const inp = doc.querySelector('.jp-answer.jp-show .jp-input'); if (!inp || !doc.querySelector('.jp-clue')) return; if (rand() < 0.5) inp.dispatchEvent(new w.KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true })); else doc.querySelector('.jp-clue').dispatchEvent(new w.MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true })); }, 300);
  }
  const wager = doc.querySelector('.jp-wager');
  if (wager && wagerHandled !== wager) {
    wagerHandled = wager;
    setTimeout(() => { stats.wagers++; wager.value = String(Math.max(+wager.min, Math.min(+wager.max, 1000))); const ok = doc.querySelector('.jp-ok'); if (ok) ok.click(); }, 30);
  }
});
mo.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
const enterTimer = setInterval(() => {
  const hint = doc.querySelector('.jp-hint'), input = doc.querySelector('.jp-answer.jp-show .jp-input');
  if (hint && /Enter/.test(hint.textContent) && !input) { stats.enters++; key('Enter'); }
}, 60);

// ---- run ----------------------------------------------------------------------
setTimeout(() => {
  const btn = doc.getElementById('live_btn');
  if (!btn) { errors.push('no live_btn'); finish(); return; }
  btn.click();
  const start = doc.querySelector('.jp-start');
  if (!start) { errors.push('no start button'); finish(); return; }
  start.click();
}, 120);
const t0 = Date.now();

if (process.env.PAUSE) {
  let pauses = 0;
  const pauseTimer = setInterval(() => {
    const st = w.jpLiveDebug.state;
    if (!st || !doc.querySelector('.jp-clue') || pauses >= 3) { if (pauses >= 3) clearInterval(pauseTimer); return; }
    pauses++;
    key('Escape');
    const before = w.JPClock.now(), dlg = doc.querySelector('.jp-dialog'), stageBefore = doc.querySelector('.jp-stage').textContent;
    if (!dlg || !w.JPClock.paused) errors.push('pause #' + pauses + ': dialog=' + !!dlg + ' paused=' + w.JPClock.paused);
    setTimeout(() => {
      const during = w.JPClock.now(), stageDuring = doc.querySelector('.jp-stage').textContent;
      if (Math.abs(during - before) > 5) errors.push('game clock advanced while paused: ' + (during - before));
      if (stageDuring !== stageBefore) errors.push('stage changed while paused');
      const rs = doc.querySelector('.jp-dialog .jp-resume'); if (rs) rs.click(); else errors.push('no resume button');
      if (w.JPClock.paused) errors.push('still paused after resume');
      console.log('pause #' + pauses + ' ok');
    }, 700);
  }, 4000);
}
if (process.env.EDIT) {
  let done = false;
  const t = setInterval(() => {
    const st = w.jpLiveDebug && w.jpLiveDebug.state;
    if (done || !st || !(st.results || []).length || doc.querySelector('.jp-dialog') || doc.querySelector('.jp-clue')) return;
    done = true; clearInterval(t);
    key('Escape');
    const btn = doc.querySelector('.jp-dialog .jp-show-results');
    if (!btn) { errors.push('no Edit results button in pause menu'); return; }
    btn.click();
    const rows = doc.querySelectorAll('.jp-results tr[data-id]');
    if (rows.length !== st.results.length) errors.push('results rows ' + rows.length + ' != records ' + st.results.length);
    const rec = st.results[0], before = st.scores[rec.who || 'You'];
    const row = doc.querySelector('.jp-results tr[data-id="' + rec.id + '"]');
    function choose(v) { const r = row.querySelector('input[value="' + v + '"]'); r.checked = true; r.dispatchEvent(new w.Event('change', { bubbles: true })); }
    const orig = rec.outcome;
    choose('none');
    const expectNone = before - (orig == 'right' ? rec.amount : orig == 'wrong' ? -rec.amount : 0);
    if (st.scores[rec.who || 'You'] !== expectNone) errors.push('edit results: none -> ' + st.scores[rec.who || 'You'] + ' expected ' + expectNone);
    choose(orig);
    if (st.scores[rec.who || 'You'] !== before) errors.push('edit results: restore -> ' + st.scores[rec.who || 'You'] + ' expected ' + before);
    console.log('edit results ok: record 0 (' + rec.kind + ' ' + rec.amount + ', ' + orig + ')');
    const back = doc.querySelector('.jp-dialog .jp-resume'); if (back) back.click(); else errors.push('no resume in results view');
  }, 200);
}
if (process.env.REWIND) {
  let done = false;
  const t = setInterval(() => {
    const st = w.jpLiveDebug && w.jpLiveDebug.state;
    if (done || !st || (st.history || []).length < 3 || doc.querySelector('.jp-dialog') || doc.querySelector('.jp-clue')) return;
    done = true; clearInterval(t);
    const snap = JSON.parse(JSON.stringify(st.history[2]));
    w.jpLiveDebug.rewindTo(2);
    const after = w.jpLiveDebug.state;
    if (Object.keys(after.played).length !== Object.keys(snap.played).length) errors.push('rewind: played ' + Object.keys(after.played).length + ' expected ' + Object.keys(snap.played).length);
    if (JSON.stringify(after.scores) !== JSON.stringify(snap.scores)) errors.push('rewind: scores differ');
    if (after.control !== snap.control) errors.push('rewind: control ' + after.control + ' expected ' + snap.control);
    if (after.history.length !== 2) errors.push('rewind: history length ' + after.history.length);
    console.log('rewind ok: back to history entry 2, scores ' + JSON.stringify(after.scores));
  }, 300);
}
if (process.env.REWINDFJ) {
  let done = false;
  const t = setInterval(() => {
    const st = w.jpLiveDebug && w.jpLiveDebug.state;
    if (done || !st || st.round !== 'FJ' || !doc.querySelector('.jp-clue') || doc.querySelector('.jp-dialog')) return;
    done = true; clearInterval(t);
    const i = st.history.findIndex(h => h.num == null);
    if (i < 0) { errors.push('no FJ history entry'); return; }
    const snap = JSON.parse(JSON.stringify(st.history[i]));
    w.jpLiveDebug.rewindTo(i);
    const g = w.jpLiveDebug.state;
    if (JSON.stringify(g.scores) !== JSON.stringify(snap.scores)) errors.push('FJ rewind: scores differ');
    if (g.results.length !== snap.results.length) errors.push('FJ rewind: results ' + g.results.length + ' vs ' + snap.results.length);
    console.log('FJ rewind ok — replaying Final Jeopardy!');
  }, 300);
}
if (process.env.CASCADE) {
  let done = false;
  const t = setInterval(() => {
    const st = w.jpLiveDebug && w.jpLiveDebug.state;
    if (done || !st || doc.querySelector('.jp-dialog') || doc.querySelector('.jp-clue')) return;
    const rec = (st.results || []).find(r => r.kind == 'clue' && r.outcome == 'wrong' && r.others && r.others.length && r.othersDelta && Object.keys(r.othersDelta).length);
    if (!rec) return;
    done = true; clearInterval(t);
    const before = JSON.parse(JSON.stringify(st.scores));
    key('Escape');
    doc.querySelector('.jp-dialog .jp-show-results').click();
    const row = doc.querySelector('.jp-results tr[data-id="' + rec.id + '"]');
    if (!row) { errors.push('cascade: no row for record ' + rec.id); return; }
    function choose(v) { const r = row.querySelector('input[value="' + v + '"]'); r.checked = true; r.dispatchEvent(new w.Event('change', { bubbles: true })); }
    choose('right');
    const after = JSON.parse(JSON.stringify(st.scores));
    for (const o of rec.others) { const exp = before[o.who] - o.delta; if (after[o.who] !== exp) errors.push('cascade: ' + o.who + ' ' + after[o.who] + ' expected ' + exp); }
    const me = rec.who || 'You';
    if (after[me] !== before[me] + 2 * rec.amount) errors.push('cascade: ' + me + ' ' + after[me] + ' expected ' + (before[me] + 2 * rec.amount));
    choose('wrong');
    if (JSON.stringify(st.scores) !== JSON.stringify(before)) errors.push('cascade: restore failed');
    console.log('cascade ok: clue ' + rec.num + ' (' + rec.amount + '), followers ' + JSON.stringify(rec.others.map(o => o.who + (o.right ? '+' : '-'))));
    doc.querySelector('.jp-dialog .jp-resume').click();
  }, 200);
}
if (process.env.CONTROL) {
  let done = false;
  const t = setInterval(() => {
    const st = w.jpLiveDebug && w.jpLiveDebug.state;
    if (done || !st || st.phase !== 'pick' || doc.querySelector('.jp-dialog') || doc.querySelector('.jp-clue')) return;
    const rec = (st.results || [])[st.results.length - 1];
    if (!rec || rec.outcome !== 'wrong' || !rec.others || !rec.others.some(o => o.right) || st.control === (rec.who || 'You')) return;
    done = true; clearInterval(t);
    const before = st.control, me = rec.who || 'You';
    key('y');
    setTimeout(() => {
      const g = w.jpLiveDebug.state;
      if (g.control !== me) errors.push('control after y: ' + g.control + ' (was ' + before + ')');
      console.log('control ok: after "y" on clue ' + rec.num + ', control ' + before + ' -> ' + g.control);
    }, 1200);
  }, 150);
}
let lastRound = '';
const scoreLog = setInterval(() => { const st = w.jpLiveDebug && w.jpLiveDebug.state; if (!st) return; if (st.round !== lastRound) { lastRound = st.round; console.log('round', st.round, 'scores', JSON.stringify(st.scores)); } }, 100);
// Media clues: the contestants' money moves only as the setting allows.
let mediaClues = 0, mediaMoved = [], curNum = null, curMedia = false, curScores = null, curDD = false, curValue = 0;
const mediaWatch = setInterval(() => {
  const st = w.jpLiveDebug && w.jpLiveDebug.state; if (!st || !st.current) return;
  const num = st.current.num;
  if (num === curNum) return;
  if (curMedia && curScores && !curDD && !process.env.EDIT && !process.env.CASCADE && !process.env.CONTROL && !process.env.REWIND && !process.env.REWINDFJ) {
    const mode = process.env.MEDIA || 'none';
    const ok = d => d === 0 || (mode === 'half' && Math.abs(d) === curValue / 2) || (mode === 'full' && Math.abs(d) === curValue);
    const hs = new Set(st.humans || ['You']);
    for (const n in curScores) if (!hs.has(n) && !ok(st.scores[n] - curScores[n])) mediaMoved.push(n + ' on clue ' + curNum + ': ' + curScores[n] + ' -> ' + st.scores[n]);
  }
  curNum = num; curMedia = !!(st.current.media && st.current.media.length); curScores = Object.assign({}, st.scores); curDD = !!st.current.dd; curValue = st.current.value;
  if (curMedia) mediaClues++;
}, 25);
const poll = setInterval(() => { if (doc.querySelector('.jp-again') || Date.now() - t0 > 240000) finish(); }, 200);

function finish() {
  clearInterval(poll); clearInterval(enterTimer); clearInterval(scoreLog); clearInterval(mediaWatch); mo.disconnect();
  const st = (w.jpLiveDebug && w.jpLiveDebug.state) || { scores: {}, stats: {}, played: {}, results: [], humans: ['You'] };
  console.log('media clues played:', mediaClues, '· contestant money moved wrongly on them:', mediaMoved.length, mediaMoved.slice(0, 3));
  if (mediaMoved.length) errors.push('contestant money moved on a media clue: ' + mediaMoved.join('; '));
  console.log('--- finished in', ((Date.now() - t0) / 1000).toFixed(1), 's');
  console.log('scores:', JSON.stringify(st.scores));
  console.log('game stats:', JSON.stringify(st.stats));
  console.log('clues played:', Object.keys(st.played).length, 'round:', st.round);
  console.log('bot:', JSON.stringify(stats), 'utterances:', spoken.length, 'recognizer starts:', srStarts);
  console.log('final panel:', (doc.querySelector('.jp-panel') || { textContent: '' }).textContent.replace(/\s+/g, ' ').slice(0, 240));
  const saved = JSON.parse(w.localStorage.getItem('jpLiveScores') || '[]');
  const humans = st.humans || ['You'];
  console.log('saved entries:', saved.length, saved.map(e => (e.player || 'You') + ' $' + e.score + (e.won ? ' won' : '') + ' coryat ' + e.coryat + ' ' + e.correct + '/' + e.answered).join(' | '));
  if (saved.length != humans.length) errors.push('expected ' + humans.length + ' saved entries, got ' + saved.length);
  for (const hm of humans) { const e = saved.find(x => (x.player || 'You') == hm); if (!e) errors.push('no saved entry for ' + hm); else if (e.score !== st.scores[hm]) errors.push('saved score for ' + hm + ' ' + e.score + ' != ' + st.scores[hm]); }
  if (MULTI > 1) { const by = {}; for (const r of st.results) by[r.who || 'You'] = (by[r.who || 'You'] || 0) + 1; if (Object.keys(by).length < 2) errors.push('only one human ever responded: ' + JSON.stringify(by)); }
  const played = { games: store.jpLivePlayed || null, last: store.jpLiveLast || null };   // the extension's storage (the stub above)
  if (!played.games || !played.games['9537'] || !played.last || played.last.id != '9537') errors.push('the played-games record was not written: ' + JSON.stringify(played).slice(0, 200));
  const dyn = doc.querySelector('.jp-dyn'); if (!dyn) errors.push('no game dynamics table'); else if (dyn.querySelectorAll('tr').length != Object.keys(st.scores).length + 1) errors.push('dynamics rows ' + dyn.querySelectorAll('tr').length + ' for ' + Object.keys(st.scores).length + ' players');
  // The correct response stays hidden after a miss while others can still ring in (several humans), and shows at the clue's end.
  const sweeps = Object.values(st.hstats || {}).reduce((a, h) => a + (h.sweeps || 0), 0);
  console.log('cues:', JSON.stringify(cues), '· categories run:', sweeps, '· win cue flag:', st.winCue);
  if (SWEEP && MULTI < 2) {
    if (!sweeps || !cues.sweep) errors.push('SWEEP: no category run / no sweep cue (' + sweeps + ', ' + (cues.sweep || 0) + ')');
    if (cues.sweep !== sweeps) errors.push('SWEEP: sweep cue count ' + cues.sweep + ' != categories run ' + sweeps);
    if (!cues.win && Object.keys(st.scores).length > 1) errors.push('SWEEP: no win cue although ' + JSON.stringify(st.scores));
    if (cues.win && Object.keys(st.scores).length == 1) errors.push('SWEEP: win cue with nobody to beat');
    if (!cues.fjright) errors.push('SWEEP: no Final Jeopardy! cue');
    if (!/ran \d+ categories|ran a category/.test(doc.body.textContent)) errors.push('SWEEP: final screen does not mention the categories run');
  } else if (cues.win && !humans.some(h => Object.keys(st.scores).sort((a, b) => st.scores[b] - st.scores[a])[0] == h)) errors.push('win cue played although no human won');
  console.log('ERRORS:', errors.length);
  errors.slice(0, 10).forEach(e => console.log('  ', e.split('\n').slice(0, 4).join(' | ')));
  if (!doc.querySelector('.jp-again')) console.log('DID NOT REACH THE END. stage:', (doc.querySelector('.jp-stage') || {}).textContent, '| hint:', (doc.querySelector('.jp-hint') || {}).textContent);
  process.exit(errors.length || !doc.querySelector('.jp-again') ? 1 : 0);
}
