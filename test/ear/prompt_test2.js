// The other side: a prompt must not put words in the player's mouth. Each phrase is
// transcribed with a prompt for a DIFFERENT response, and silence/noise with a prompt.
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
  await new Promise(r => server.listen(8788, r));
  const browser = await chromium.launch({ channel: 'chromium', headless: true, executablePath: '/opt/pw-browsers/chromium-1243/chrome-linux64/chrome', args: ['--no-proxy-server'] });
  const page = await browser.newPage();
  await page.goto('http://localhost:8788/test/ear/prompt_page.html');
  console.log(await page.evaluate(() => window.ready));
  const keys = Object.keys(phrases);
  let leaks = 0, n = 0;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i], said = phrases[k];
    const other = phrases[keys[(i + 7) % keys.length]].replace(/^(What|Who) is (the )?/, '').replace(/\?$/, '');
    const prompt = 'Category: ' + other.toUpperCase() + '. Response: What is ' + other + '?';
    const b = await page.evaluate(async ([k, prompt]) => await window.transcribe('/wav/' + k + '.wav', prompt), [k, prompt]);
    const out = b.text.replace(prompt, '').trim();
    const leak = new RegExp(other.split(' ').pop().replace(/[^a-z]/gi, ''), 'i').test(out);
    n++; if (leak) leaks++;
    console.log((leak ? 'LEAK ' : 'ok   ') + '"' + out + '"   said [' + said + '] prompted for [' + other + ']');
  }
  // silence and noise with a prompt
  const quiet = await page.evaluate(async () => {
    const res = [];
    for (const kind of ['silence', 'noise', 'hum']) {
      const a = new Float32Array(16000 * 1.5);
      if (kind == 'noise') for (let i = 0; i < a.length; i++) a[i] = (Math.random() - 0.5) * 0.02;
      if (kind == 'hum') for (let i = 0; i < a.length; i++) a[i] = Math.sin(i / 16000 * 2 * Math.PI * 120) * 0.05;
      const p = window.promptIds('Category: GAUSS. Response: What is Gauss?');
      const out = await window.asr(a, { max_new_tokens: 48, return_timestamps: false, decoder_input_ids: p.ids });
      res.push(kind + ': "' + out.text + '"');
    }
    return res;
  });
  console.log(quiet.join('\n'));
  console.log('leaks', leaks, 'of', n);
  await browser.close(); server.close();
})().catch(e => { console.error('ERR', e); process.exit(1); });
