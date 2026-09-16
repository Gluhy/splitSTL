// Translations rot quietly: a key renamed in the markup or a placeholder dropped from one
// language shows up as a blank label or a literal {n} months later. This checks both lists.
import fs from 'fs';
import { t, setLang } from '../i18n.js';

const root = new URL('..', import.meta.url).pathname;
const read = f => fs.readFileSync(root + f, 'utf8');
const src = read('i18n.js');
const keysOf = b => [...b.matchAll(/^\s+'([^']+)':/gm)].map(m => m[1]);
const EN = keysOf(src.slice(src.indexOf('const EN'), src.indexOf('const PL')));
const PL = keysOf(src.slice(src.indexOf('const PL'), src.indexOf('export const LANGS')));

let fails = 0;
const chk = (ok, msg) => { if (!ok) { fails++; console.log('   FAIL ' + msg); } };

// every key exists in both languages
chk(EN.length > 0, 'no English keys found');
const onlyEn = EN.filter(k => !PL.includes(k)), onlyPl = PL.filter(k => !EN.includes(k));
chk(!onlyEn.length, `missing Polish: ${onlyEn.join(', ')}`);
chk(!onlyPl.length, `Polish has keys English does not: ${onlyPl.join(', ')}`);

// every key the UI asks for exists
const used = new Set();
for (const m of read('index.html').matchAll(/data-i18n(?:-title|-html)?="([^"]+)"/g)) used.add(m[1]);
for (const f of ['app.js', 'cutter.js'])
  for (const m of read(f).matchAll(/'((?:log|err|stat|piece|edit|diagram)\.[A-Za-z.]+)'/g)) used.add(m[1]);
const missing = [...used].filter(k => !EN.includes(k));
chk(!missing.length, `used but not translated: ${missing.join(', ')}`);

// a key nobody asks for is dead weight
const dead = EN.filter(k => !used.has(k));
chk(!dead.length, `translated but never used: ${dead.join(', ')}`);

// {placeholders} must match, or one language silently drops a number
const ph = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');
setLang('en'); const en = Object.fromEntries(EN.map(k => [k, t(k)]));
setLang('pl');
for (const k of EN) chk(ph(en[k]) === ph(t(k)), `placeholders differ in "${k}": EN {${ph(en[k])}} vs PL {${ph(t(k))}}`);

// unknown key must stay visible rather than render empty
chk(t('no.such.key') === 'no.such.key', 'an unknown key should fall back to itself');

console.log(`i18n: ${EN.length} keys × ${['en','pl'].length} languages, ${used.size} used by the UI`);
console.log(fails ? `\n${fails} FAILED` : 'translations OK');
process.exit(fails ? 1 : 0);
