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
    onClose: () => {},
  });

  const wrap = popup.host.shadowRoot.querySelector('.wrap');
  return { window, document: window.document, popup, wrap, copied, spoken, targetChanges };
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
