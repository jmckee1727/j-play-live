// Does a Whisper prompt (the category and the correct response) help the studio ear hear
// the response? Transcribes synthesized phrases with and without one.
const { chromium } = require('playwright');
const http = require('http'); const fs = require('fs'); const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const WAVS = process.env.WAVS || '/tmp/claude-0/-home-claude/f8d80636-7ed3-5699-9a02-98a85fdaae10/scratchpad/tts';
const phrases = JSON.parse(fs.readFileSync(path.join(WAVS, 'phrases.json'), 'utf8'));
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  let file = p.startsWith('/wav/') ? path.join(WAVS, p.slice(5)) : path.join(ROOT, p);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
  const ext = path.extname(file);
  res.writeHead(200, { 'Content-Type': ext == '.js' || ext == '.mjs' ? 'text/javascript' : ext == '.wasm' ? 'application/wasm' : ext == '.html' ? 'text/html' : ext == '.wav' ? 'audio/wav' : 'application/octet-stream', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' });
  fs.createReadStream(file).pipe(res);
});
(async () => {
  await new Promise(r => server.listen(8787, r));
  const browser = await chromium.launch({ channel: 'chromium', headless: true, executablePath: '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome', args: ['--no-proxy-server'] });
  const page = await browser.newPage();
  page.on('console', m => { if (m.type() == 'error') console.log('[console]', m.text().slice(0, 200)); });
  await page.goto('http://localhost:8787/test/ear/prompt_page.html');
  console.log('loading model…');
  console.log(await page.evaluate(() => window.ready.then(x => x).catch(e => 'ERR ' + e.message)));
  console.log('files:', await page.evaluate(() => window.log.join(', ')));
  console.log('prompt ids sample:', JSON.stringify(await page.evaluate(() => { const p = window.promptIds('lo'); return { prev: p.prev, words: p.words, init: p.init }; })));
  let better = 0, worse = 0, same = 0;
  for (const [k, said] of Object.entries(phrases)) {
    const correct = said.replace(/^(What|Who) is (the )?/, '').replace(/\?$/, '');
    const prompt = 'Category: ' + correct.toUpperCase() + '. Response: What is ' + correct + '?';
    const a = await page.evaluate(async (k) => await window.transcribe('/wav/' + k + '.wav', null), k);
    const b = await page.evaluate(async ([k, prompt]) => await window.transcribe('/wav/' + k + '.wav', prompt), [k, prompt]);
    const hit = t => new RegExp(correct.split(' ').pop().replace(/[^a-z]/gi, ''), 'i').test(t);
    const ha = hit(a.text), hb = hit(b.text);
    if (hb && !ha) better++; else if (ha && !hb) worse++; else same++;
    console.log((ha ? '✓' : '✗') + ' plain: "' + a.text + '" (' + a.ms + ' ms)  ' + (hb ? '✓' : '✗') + ' prompted: "' + b.text + '" (' + b.ms + ' ms)   [' + said + ']');
  }
  console.log('better', better, 'worse', worse, 'same', same);
  await browser.close(); server.close();
})().catch(e => { console.error('ERR', e); process.exit(1); });
