// node test/judge/judge_test.js -- the answer judge against known calls.
const fs = require('fs'), path = require('path');
global.document = { createElement: () => ({ set innerHTML(v) { this.value = v.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'"); }, value: '' }) };
const src = fs.readFileSync(path.join(__dirname, '..', '..', 'judge.js'), 'utf8');
const JPJudge = new Function(src + '\nreturn JPJudge;')();
const cases = [
  // [said, correct response, expected]
  ['white-bellied whale', 'sulfur-bellied whale', false],
  ['yellow-bellied whale', 'sulfur-bellied whale', false],
  ['killer whale', 'sulfur-bellied whale', false],
  ['whale', 'sulfur-bellied whale', false],
  ['sulfur-bellied whale', 'sulfur-bellied whale', true],
  ['what is a sulfur bellied whale', 'sulfur-bellied whale', true],
  ['sulphur bellied whale', 'sulfur-bellied whale', true],
  ['the brooklyn bridge', 'the Golden Gate Bridge', false],
  ['golden gate', 'the Golden Gate Bridge', true],
  ['who is newton', '(Sir) Isaac Newton', true],
  ['newton', 'Isaac Newton', true],
  ['newton i think', 'Isaac Newton', true],
  ['isaac newton the physicist', 'Isaac Newton', true],
  ['wayne newton', 'Isaac Newton', false],
  ['who is beethoven', 'Ludwig van Beethoven', true],
  ['hanks', 'Thomas (Tom) Hanks', true],
  ['tom hanks', 'Thomas (Tom) Hanks', true],
  ['london or paris', 'Paris', false],
  ['what is paris', 'Paris', true],
  ['paris france', 'Paris', true],
  ['wild', 'Cheryl Strayed or Wild', true],
  ['strayed', 'Cheryl Strayed or Wild', true],
  ['the sea', 'the Mediterranean Sea', false],
  ['mediterranean', 'the Mediterranean Sea', true],
  ['red sea', 'the Mediterranean Sea', false],
  ['series', 'Ceres', true],
  ['war', 'the War of 1812', false],
  ['war of 1812', 'the War of 1812', true],
  ['war of eighteen twelve', 'the War of 1812', true],
  ['gentlemen of verona', 'The Two Gentlemen of Verona', true],
  ['a horse', 'a horse', true],
  ['cat', 'dog', false],
];
let bad = 0;
for (const [said, correct, want] of cases) {
  const r = JPJudge.judge(said, correct);
  const ok = r.correct === want;
  if (!ok) bad++;
  console.log((ok ? 'ok  ' : 'FAIL') + '  ' + JSON.stringify(said) + ' vs ' + JSON.stringify(correct) + ' -> ' + (r.correct ? 'right' : 'wrong') + ' (' + r.reason + ')');
}
console.log(bad ? bad + ' failed' : 'all ' + cases.length + ' passed');
process.exit(bad ? 1 : 0);
