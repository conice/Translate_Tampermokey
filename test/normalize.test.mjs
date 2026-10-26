import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTerm, scriptOf, isCjk, countWords } from '../src/core/normalize.js';

test('normalizeTerm strips surrounding punctuation and lowercases latin', () => {
  assert.equal(normalizeTerm('Running,'), 'running');
  assert.equal(normalizeTerm('"Hello!"'), 'hello');
  assert.equal(normalizeTerm('  hello   world '), 'hello world');
  assert.equal(normalizeTerm('Apple.'), 'apple');
});

test('normalizeTerm leaves CJK untouched apart from punctuation', () => {
  assert.equal(normalizeTerm('跑。'), '跑');
  assert.equal(normalizeTerm('“你好”'), '你好');
  assert.equal(normalizeTerm('日本語'), '日本語');
});

test('normalizeTerm does not strip internal hyphens or apostrophes', () => {
  assert.equal(normalizeTerm("don't"), "don't");
  assert.equal(normalizeTerm('well-known'), 'well-known');
});

test('normalizeTerm handles empty and punctuation-only input', () => {
  assert.equal(normalizeTerm(''), '');
  assert.equal(normalizeTerm('   '), '');
  assert.equal(normalizeTerm('…'), '');
  assert.equal(normalizeTerm(',.'), '');
});

test('scriptOf classifies writing systems', () => {
  assert.equal(scriptOf('apple'), 'latin');
  assert.equal(scriptOf('跑'), 'han');
  assert.equal(scriptOf('ひらがな'), 'kana');
  assert.equal(scriptOf('한국어'), 'hangul');
  assert.equal(scriptOf('привет'), 'cyrillic');
  assert.equal(scriptOf('12345'), 'none');
});

test('scriptOf prefers kana over han for mixed Japanese text', () => {
  assert.equal(scriptOf('日本語のテキスト'), 'kana');
});

test('isCjk covers han, kana and hangul', () => {
  assert.equal(isCjk('跑'), true);
  assert.equal(isCjk('の'), true);
  assert.equal(isCjk('한'), true);
  assert.equal(isCjk('a'), false);
});

test('countWords counts whitespace-separated words, CJK as one run', () => {
  assert.equal(countWords('apple'), 1);
  assert.equal(countWords('take off'), 2);
  assert.equal(countWords('take off your shoes'), 4);
  assert.equal(countWords('跑步'), 1);
  assert.equal(countWords(''), 0);
});