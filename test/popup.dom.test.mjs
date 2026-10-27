import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createPopup } from '../src/ui/popup.js';

/**
 * The Popup is the one place where a Lookup becomes controls, so its two shapes
 * — a word and a sentence — are worth pinning here rather than only through
 * the built bundle. jsdom has no layout, so positions are not asserted.
 *
 * popup.js reads `window` for the viewport bounds; the module takes only a
 * document, so the jsdom window is installed as the global for the test.
 */
function setup({ copyResult = true, copyThrows = false, touch = false } = {}) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  const { window } = dom;

  const copied = [];
  const spoken = [];
  const targetChanges = [];
  const dictionaryChanges = [];
  const popup = createPopup({
    document: window.document,
    window,
    touch,
    onAdd: async () => {},
    onSpeak: (...args) => spoken.push(args),
    onCopy: async (text) => {
      copied.push(text);
      if (copyThrows) throw new Error('denied');
      return copyResult;
    },
    onTargetChange: (target, state) => targetChanges.push({ target, state }),
    onDictionaryChange: (dictionaryId, state) => dictionaryChanges.push({ dictionaryId, state }),
    onClose: () => {},
  });

  const wrap = popup.host.shadowRoot.querySelector('.wrap');
  return { window, document: window.document, popup, wrap, copied, spoken, targetChanges, dictionaryChanges };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function sentence(overrides = {}) {
  return {
    status: 'ok',
    sentence: true,
    term: 'We are all here.\nAnd the weather is fine.',
    translation: '我们都在这儿。\n天气也很好。',
    sourceLang: 'en',
    canSpeak: true,
    canSave: false,
    anchor: null,
    ...overrides,
  };
}

function word(overrides = {}) {
  return {
    status: 'ok',
    sentence: false,
    term: 'run',
    translation: '跑',
    sourceLang: 'en',
    canSpeak: true,
    canSave: true,
    entry: { normalized: 'run' },
    anchor: null,
    ...overrides,
  };
}

test('a sentence result is its translation plus copy, speech and close', () => {
  const { popup, wrap } = setup();
  popup.render(sentence());

  assert.equal(wrap.querySelector('.translation').textContent, '我们都在这儿。\n天气也很好。');
  assert.equal(wrap.querySelector('button.copy').textContent, '复制译文');
  assert.ok(wrap.querySelector('button.speak'), 'a sentence can still be read aloud');
  assert.equal(
    wrap.querySelector('.close').style.display,
    'block',
    'a sentence result has no other way to say "done"',
  );

  assert.equal(wrap.querySelector('button.primary'), null, 'a sentence cannot be saved');
  assert.doesNotMatch(wrap.textContent, /过长/);
  assert.equal(wrap.querySelector('.detected'), null, 'language detection is word-mode noise here');
  assert.equal(wrap.querySelector('.term'), null, 'the sentence is already on the page');
});

test('a word result keeps its controls and gains copy', () => {
  const { popup, wrap } = setup();
  popup.render(word());

  assert.ok(wrap.querySelector('button.primary'), 'a word can be saved');
  assert.ok(wrap.querySelector('.term'));
  assert.equal(wrap.querySelector('.close').style.display, 'none', 'desktop keeps click-away to close');
});

test('copying a word sends the translation to the clipboard', async () => {
  const { popup, wrap, copied } = setup();
  popup.render(word());
  wrap.querySelector('button.copy').click();
  await tick();
  assert.deepEqual(copied, ['跑']);
  assert.equal(wrap.querySelector('button.copy').textContent, '已复制');
});

test('a refused copy leaves the label alone and nothing else changes', async () => {
  const { popup, wrap } = setup({ copyResult: false });
  popup.render(word());
  const copy = wrap.querySelector('button.copy');
  copy.click();
  await tick();

  assert.equal(copy.textContent, '复制译文');
  assert.equal(wrap.querySelector('button.primary').disabled, false, 'the other actions still work');
});

test('a throwing copy does not take the popup down with it', async () => {
  const { popup, wrap } = setup({ copyThrows: true });
  popup.render(word());
  const copy = wrap.querySelector('button.copy');
  copy.click();
  await tick();

  assert.equal(copy.textContent, '复制译文');
  assert.ok(wrap.querySelector('button.primary'));
});

test('loading a sentence shows only that it is working', () => {
  const { popup, wrap } = setup();
  popup.render({ status: 'loading', sentence: true, term: 'We are all here.', anchor: null });
  assert.match(wrap.textContent, /翻译中/);
  assert.equal(wrap.querySelector('.term'), null);
});

test('the target language is a dropdown in the word popup, not the Panel', () => {
  const { window, popup, wrap, targetChanges } = setup();
  const state = word({ target: 'zh-CN', targetOverride: '' });
  popup.render(state);

  const select = wrap.querySelector('select.target-select');
  assert.ok(select, 'the site target language belongs where the reading decision is made');
  assert.equal(select.value, '', 'with no override the dropdown follows the page language');
  assert.deepEqual(
    [...select.options].slice(0, 3).map((option) => option.textContent),
    ['自动', '中文', '英语'],
  );

  select.value = 'ja';
  select.dispatchEvent(new window.Event('change'));
  assert.deepEqual(targetChanges, [{ target: 'ja', state }]);
});

test('the target language sits in the bottom row, beside the actions', () => {
  const { popup, wrap } = setup();
  popup.render(word());
  const target = wrap.querySelector('.target');
  assert.equal(target.parentElement.className, 'actions',
    'the language dropdown shares the last row with the actions');
  assert.equal(target.nextElementSibling, null, 'and is the rightmost thing in it');

  popup.render(sentence());
  assert.equal(wrap.querySelector('.target').parentElement.className, 'actions');
  assert.equal(wrap.querySelector('.target').nextElementSibling, null);
});

test('an existing override is selected, including a code outside the short list', () => {
  const { popup, wrap } = setup();
  popup.render(word({ target: 'pt-BR', targetOverride: 'pt-BR' }));

  const select = wrap.querySelector('select.target-select');
  assert.equal(select.value, 'pt-BR');
  assert.equal(
    [...select.options].find((option) => option.value === 'pt-BR').textContent,
    'pt-BR',
    'a language the list does not name must still be visible',
  );
});

test('a saved base code selects the regional option that keeps entries comparable', () => {
  const { popup, wrap } = setup();
  popup.render(word({ target: 'zh-CN', targetOverride: 'zh' }));

  const select = wrap.querySelector('select.target-select');
  assert.equal(select.value, 'zh-CN', '「中文」 is stored as the default Chinese tag, not a bare zh');
});

test('a sentence result can change the target language too', () => {
  const { popup, wrap } = setup();
  popup.render(sentence({ target: 'ja', targetOverride: 'ja' }));

  assert.equal(wrap.querySelector('select.target-select').value, 'ja');
});

test('the dictionary is a row of logos in the top right of the word popup', () => {
  const { popup, wrap, dictionaryChanges } = setup();
  const state = word({
    dictionaryId: 'youdao',
    dictionaryStatus: 'ok',
    meanings: [{ pos: 'v.', definition: '跑' }],
  });
  popup.render(state);

  const group = wrap.querySelector('.dict');
  assert.ok(group, 'the meanings need their source on screen');
  assert.equal(group.parentElement.className, 'head',
    'the dictionary belongs beside the word it describes');
  assert.equal(group.nextElementSibling, null, 'and is the rightmost thing in the head');
  assert.match(group.title, /仅本次/, 'the temporary scope must be stated');

  const logos = [...group.querySelectorAll('button.logo')];
  assert.deepEqual(logos.map((logo) => logo.dataset.dict), [
    'youdao',
    'microsoft',
    'eudic',
    'dictionaryapi',
  ]);
  assert.deepEqual(logos.map((logo) => logo.title), [
    '有道词典',
    '微软词典',
    '欧陆词典',
    '英英词典',
  ]);
  assert.equal(group.querySelector('select'), null, 'a dropdown is what this row replaced');
  assert.equal(logos[0].getAttribute('aria-pressed'), 'true');
  assert.equal(
    logos[0].querySelector('.logo-mark').textContent,
    '有',
    'each source carries its own mark',
  );
  assert.equal(
    logos[1].querySelectorAll('.logo-ms rect').length,
    4,
    'Microsoft keeps its four-square mark',
  );

  logos[1].click();
  assert.deepEqual(dictionaryChanges, [{ dictionaryId: 'microsoft', state }]);
});

test('a word the dictionaries cannot help with shows no selector at all', () => {
  const { popup, wrap } = setup();
  // Non-English words and sentences have no meaning lookup, so `dictionaryId`
  // is absent and the row must not render an empty control.
  popup.render(word({ dictionaryId: undefined }));

  assert.equal(wrap.querySelector('.dict'), null);
  assert.equal(wrap.querySelector('button[data-dict]'), null);
});

test('a language with one dictionary shows its meanings without a dead switch row', () => {
  const { popup, wrap } = setup();
  popup.render(word({
    term: '사과',
    dictionaryId: 'krdict',
    dictionaryChoices: [['krdict', '韩国语学习词典']],
    dictionaryStatus: 'ok',
    meanings: [{ pos: '名词', definition: '苹果' }],
  }));

  assert.equal(wrap.querySelector('.dict'), null, 'one logo is a control that cannot do anything');
  assert.match(wrap.querySelector('.meanings').textContent, /苹果/);
});

test('a sentence result has no dictionary row even if its state names one', () => {
  const { popup, wrap } = setup();
  popup.render(sentence({ dictionaryId: 'youdao' }));

  assert.equal(wrap.querySelector('button[data-dict]'), null);
});

test('a dictionary id outside the list falls back to the default', () => {
  const { popup, wrap } = setup();
  popup.render(word({ dictionaryId: 'gone', dictionaryStatus: 'ok' }));

  assert.equal(
    wrap.querySelector('button[data-dict="youdao"]').getAttribute('aria-pressed'),
    'true',
  );
});

test('the Popup says why there are no meanings, without hiding the translation', () => {
  const cases = [
    ['loading', /正在查询释义/],
    ['empty', /该词典暂无释义/],
    ['error', /释义加载失败/],
  ];
  for (const [dictionaryStatus, text] of cases) {
    const { popup, wrap } = setup();
    popup.render(word({ dictionaryId: 'eudic', dictionaryStatus }));
    assert.match(wrap.querySelector('.meanings-state').textContent, text);
    assert.equal(wrap.querySelector('.translation').textContent, '跑',
      'a dictionary problem must not take the translation down');
  }
});
