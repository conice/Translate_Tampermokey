import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DICTIONARY,
  DICTIONARIES,
  DICTIONARY_CHOICES,
  dictionaryById,
  eudic,
  microsoft,
  youdao,
} from '../src/core/dictionaries.js';

/** Shapes captured from live answers on 2026-10-27. */
const YOUDAO = JSON.stringify({
  ec: {
    word: [
      {
        usphone: 'rʌn',
        ukphone: 'rʌn',
        usspeech: 'run&type=2',
        ukspeech: 'run&type=1',
        prototype: 'run',
        trs: [
          { tr: [{ l: { i: ['v. 跑，奔跑；参加（赛跑），举行（比赛）'] } }] },
          { tr: [{ l: { i: ['n. 跑步，赛跑'] } }] },
          { tr: [{ l: { i: ['【名】 （Run）鲁恩（人名）'] } }] },
          { tr: [{ l: { i: ['adj. 运转着的'] } }] },
        ],
      },
    ],
  },
  simple: { word: [{ usphone: 'rʌn' }] },
});

const BING = `
<div class="qdef">
  <div class="hd_area">
    <div class="hd_prUS b_primtxt">美&nbsp;[rʌn] </div>
    <a id="bigaud_us" data-mp3link="/dict/mediamp3?blob=audio%2Frun.mp3" class="bigaud"></a>
    <div class="hd_pr b_primtxt">英国&nbsp;[rʊn] </div>
  </div>
  <ul>
    <li><span class="pos">n.</span><span class="def b_regtxt"><a>跑</a><span>；</span><a>跑步</a></span></li>
    <li><span class="pos">v.</span><span class="def b_regtxt">跑 &amp; 奔跑</span></li>
    <li><span class="pos web">网络</span><span class="def b_regtxt">运行(running)</span></li>
    <li><span class="pos">x.</span><span class="def b_regtxt">超出显示上限</span></li>
  </ul>
</div>`;

const EUDIC = `
<div id="dict-body" class="dict-body-main">
  <h1 class="explain-Word"><span class="word">run</span></h1>
  <span class="phonitic-line">
    <a class="voice-button"><span class="phontype">英</span><span class="Phonitic">/rʌn/</span></a>
    <a class="voice-button"><span class="phontype">美</span><span class="Phonitic">/rʊn/</span></a>
  </span>
  <div id="ExpFC" class="explain_wrap">
    <div id="ExpFCchild" class="expDiv"><ol>
      <li><i>vt. &amp; vi.</i> 跑</li>
      <li>管理，经营；运行</li>
      <li>移动</li>
      <li><i>n.</i> 跑，奔跑</li>
      <li>旅行，旅程</li>
    </ol><div id="trans"><span>时 态:</span> ran</div></div>
  </div>
</div>`;

test('the dictionary choices lead with the requested sources, defaulting to Youdao', () => {
  assert.deepEqual(
    DICTIONARY_CHOICES.slice(0, 3),
    [
      ['youdao', '有道词典'],
      ['microsoft', '微软词典'],
      ['eudic', '欧陆词典'],
    ],
  );
  assert.equal(DEFAULT_DICTIONARY, 'youdao');
  assert.equal(dictionaryById('eudic'), eudic);
  assert.equal(dictionaryById('nope'), undefined);
  assert.deepEqual(
    DICTIONARIES.map((source) => source.id).slice(-1),
    ['dictionaryapi'],
    'the old English-English source remains available',
  );
});

test('Youdao asks only for the two sections the Popup needs', () => {
  const url = youdao.request({ word: 'run' });
  assert.match(url, /^https:\/\/dict\.youdao\.com\/jsonapi\?/);
  assert.match(url, /q=run/);
  assert.match(url, /dicts=/);
  assert.doesNotMatch(url, /clients5/);
});

test('Youdao parses phonetic, American audio, meanings and a base form', () => {
  const details = youdao.parse(YOUDAO);
  assert.equal(details.phonetic, '/rʌn/');
  assert.equal(details.audio, 'https://dict.youdao.com/dictvoice?audio=run&type=2');
  assert.equal(details.lemma, 'run');
  assert.deepEqual(details.meanings, [
    { pos: 'v.', definition: '跑，奔跑；参加（赛跑），举行（比赛）' },
    { pos: 'n.', definition: '跑步，赛跑' },
    { pos: '名', definition: '（Run）鲁恩（人名）' },
  ]);
});

test('Youdao keeps a long definition readable instead of filling the Popup', () => {
  const long = 'v. ' + Array.from({ length: 40 }, (_, i) => `释义${i}`).join('；');
  const details = youdao.parse(
    JSON.stringify({ ec: { word: [{ trs: [{ tr: [{ l: { i: [long] } }] }] }] } }),
  );
  assert.ok(details.meanings[0].definition.length <= 101);
  assert.match(details.meanings[0].definition, /…$/u);
});

test('Youdao can answer with pronunciation alone', () => {
  const details = youdao.parse(
    JSON.stringify({ simple: { word: [{ usphone: 'x', usspeech: 'x&type=1' }] } }),
  );
  assert.equal(details.phonetic, '/x/');
  assert.equal(details.audio, 'https://dict.youdao.com/dictvoice?audio=x&type=1');
  assert.deepEqual(details.meanings, []);
});

test('Youdao returns nothing for an unknown word or a non-JSON body', () => {
  assert.equal(youdao.parse(JSON.stringify({ input: 'qwertyuiopasdf' })), undefined);
  assert.equal(youdao.parse('<html>blocked</html>'), undefined);
  assert.equal(youdao.parse('null'), undefined);
});

test('Microsoft reads the Bing definition block and prefers the American phonetic', () => {
  const details = microsoft.parse(BING);
  assert.equal(details.phonetic, '/rʌn/');
  assert.equal(details.audio, 'https://cn.bing.com/dict/mediamp3?blob=audio%2Frun.mp3');
  assert.deepEqual(details.meanings, [
    { pos: 'n.', definition: '跑；跑步' },
    { pos: 'v.', definition: '跑 & 奔跑' },
    { pos: '网络', definition: '运行(running)' },
  ]);
});

test('Microsoft says nothing rather than guessing when the page has no definition block', () => {
  assert.equal(microsoft.parse('<html><h1>qwertyuiopasdf - 搜索 词典</h1></html>'), undefined);
  assert.equal(microsoft.parse(''), undefined);
  assert.equal(microsoft.parse(undefined), undefined);
});

test('Eudic groups list items under the part of speech that opened them', () => {
  const details = eudic.parse(EUDIC);
  assert.equal(details.phonetic, '/rʊn/', 'the American spelling is second on the page');
  assert.deepEqual(details.meanings, [
    { pos: 'vt. & vi.', definition: '跑；管理，经营；运行；移动' },
    { pos: 'n.', definition: '跑，奔跑；旅行，旅程' },
  ]);
});

test('Eudic handles a phrase, whose page has no ordered list', () => {
  const details = eudic.parse('<div id="ExpFCchild" class="expDiv">起,脱掉<img src="x"></div>');
  assert.deepEqual(details.meanings, [{ pos: '', definition: '起,脱掉' }]);
});

test('Eudic returns nothing when the page has no entry', () => {
  assert.equal(eudic.parse('<html><body>没有找到</body></html>'), undefined);
  assert.equal(eudic.parse(''), undefined);
});
