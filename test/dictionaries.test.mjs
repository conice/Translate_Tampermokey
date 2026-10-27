import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DICTIONARY,
  DEFAULT_DICTIONARY_IDS,
  DICTIONARIES,
  DICTIONARY_CHOICES,
  dictionaryById,
  dictionaryChoicesFor,
  dictionaryFor,
  eudic,
  krdict,
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

/** A trimmed copy of the krdict Chinese search page for `사과`. */
const KDICT = `
<div class="search_result">
  <dl>
    <dt>
      <a href="javascript:checkSubmit('66371','Y');"><span class="word_type1_17">
        사과
        <sup>1</sup>
      </span></a>
      <span>(沙果/砂果)</span>
      <span class="word_att_type1">「명사」<span class="manyLang11">名词</span></span>
      <span class="search_sub"><span class="search_sub">[사과<a href="javascript:fnSoundPlay('https://krdicmedia.korean.go.kr/multimedia/multimedia_files/convert/20120601/91370/SND000080073.mp3');" class="sound">듣기</a>]</span></span>
      <a href="javascript:checkSubmit('66371','Y');" class="allview manyLang11">查看全部</a>
    </dt>
    <dd class="manyLang11 ">苹果</dd>
    <dd class="ml20">모양이 둥글고 붉으며 새콤하고 단맛이 나는 과일.</dd>
    <dd class="manyLang11 ml20">圆而红、味道酸甜的水果。</dd>
  </dl>
  <dl>
    <dt>
      <a href="javascript:checkSubmit('15830','Y');"><span class="word_type1_17">
        사과
        <sup>2</sup>
      </span></a>
      <span>(謝過)</span>
      <span class="word_att_type1">「명사」<span class="manyLang11">名词</span></span>
      <span class="search_sub"><span class="search_sub">[사ː과<a href="javascript:fnSoundPlay('https://krdicmedia.korean.go.kr/multimedia/multimedia_files/convert/20160913/10000/07000/294717/SND000304071.mp3');" class="sound">듣기</a>]</span></span>
    </dt>
    <dd class="manyLang11 ">道歉</dd>
    <dd class="ml20">자신의 잘못을 인정하며 용서해 달라고 빔.</dd>
    <dd class="manyLang11 ml20">承认自己的不是并请求原谅的行为。</dd>
  </dl>
  <dl>
    <dt>
      <a href="javascript:checkSubmit('62023','Y');"><span class="word_type1_17">
        사과나무
      </span></a>
      <span class="word_att_type1">「명사」<span class="manyLang11">名词</span></span>
    </dt>
    <dd class="manyLang11 ">苹果树</dd>
  </dl>
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
  assert.ok(
    DICTIONARIES.some((source) => source.id === 'dictionaryapi'),
    'the old English-English source remains available',
  );
});

test('the Default Dictionary only lists sources that serve English', () => {
  assert.deepEqual(
    DICTIONARY_CHOICES.map(([id]) => id),
    ['youdao', 'microsoft', 'eudic', 'dictionaryapi'],
  );
  assert.deepEqual(DEFAULT_DICTIONARY_IDS, DICTIONARY_CHOICES.map(([id]) => id));
  assert.equal(dictionaryFor('en', 'krdict').id, 'youdao', 'a Korean source cannot answer an English word');
});

test('a word is sent to a source written for its language', () => {
  assert.equal(dictionaryFor('ko').id, 'krdict');
  assert.equal(dictionaryFor('ko-KR').id, 'krdict');
  assert.deepEqual(dictionaryChoicesFor('ko'), [['krdict', '韩国语学习词典']]);
  assert.equal(dictionaryFor('en', 'eudic').id, 'eudic');
  assert.equal(dictionaryFor('fr'), undefined, 'no source means no request worth making');
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

test('krdict reads the Chinese search page, keeping the exact headword only', () => {
  const details = krdict.parse(KDICT, { word: '사과' });
  assert.equal(details.phonetic, '[사과]', 'Korean dictionaries show the Hangul in brackets');
  assert.equal(
    details.audio,
    'https://krdicmedia.korean.go.kr/multimedia/multimedia_files/convert/20120601/91370/SND000080073.mp3',
  );
  assert.deepEqual(details.meanings, [
    { pos: '名词', definition: '苹果' },
    { pos: '名词', definition: '道歉' },
  ], 'both homographs match, but 사과나무 merely contains the word');
});

test('krdict can be asked for a longer headword, and then keeps only that one', () => {
  const details = krdict.parse(KDICT, { word: '사과나무' });
  assert.deepEqual(details.meanings, [{ pos: '名词', definition: '苹果树' }]);
  assert.equal(details.phonetic, undefined, 'the entry has no pronunciation line in this page');
});

test('krdict says nothing when the search page has no result', () => {
  assert.equal(krdict.parse('<html><body>检索结果 共0个</body></html>', { word: '먹었어요' }), undefined);
  assert.equal(krdict.parse(undefined, { word: '사과' }), undefined);
});

test('krdict joins every sense of one homograph without losing whole senses', () => {
  const long = `
  <dl><dt><span class="word_type1_17">먹다</span>
    <span class="word_att_type1">「동사」<span class="manyLang11">动词</span></span></dt>
    <dd class="manyLang11 "><strong>1</strong>. 吃</dd>
    <dd class="ml20">음식을 먹다.</dd>
    <dd class="manyLang11 mt15"><strong>2</strong>. 喝</dd>
    <dd class="manyLang11 mt15"><strong>3</strong>. 抽，吸</dd>
  </dl>`;
  assert.deepEqual(krdict.parse(long, { word: '먹다' }).meanings, [
    { pos: '动词', definition: '吃；喝；抽，吸' },
  ]);
});

test('krdict skips a sense whose only Chinese cell is a placeholder', () => {
  const empty = `
  <dl><dt><span class="word_type1_17">먹다</span>
    <span class="word_att_type1">「보조 동사」<span class="manyLang11">补助动词</span></span></dt>
    <dd class="manyLang11 ">(无对应词汇)</dd>
    <dd class="manyLang11 ml20">强调前面语句所表达的行为。</dd>
  </dl>`;
  assert.equal(krdict.parse(empty, { word: '먹다' }), undefined);
});
