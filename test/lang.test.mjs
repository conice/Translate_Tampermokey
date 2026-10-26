import test from 'node:test';
import assert from 'node:assert/strict';
import { pageLanguage, resolveTarget, normalizeLangTag } from '../src/core/lang.js';

test('normalizeLangTag maps tags to base codes', () => {
  assert.equal(normalizeLangTag('zh-CN'), 'zh');
  assert.equal(normalizeLangTag('en-US'), 'en');
  assert.equal(normalizeLangTag('ja'), 'ja');
  assert.equal(normalizeLangTag(''), '');
  assert.equal(normalizeLangTag(undefined), '');
});

test('pageLanguage prefers the document lang attribute', () => {
  assert.equal(pageLanguage('en', ''), 'en');
  assert.equal(pageLanguage('zh-CN', ''), 'zh');
  assert.equal(pageLanguage('ja-JP', ''), 'ja');
});

test('pageLanguage falls back to sampled text when lang is missing', () => {
  assert.equal(pageLanguage('', '这是一个中文段落,里面没有英文。'), 'zh');
  assert.equal(pageLanguage('', 'The quick brown fox jumps over the lazy dog.'), 'en');
  assert.equal(pageLanguage('', ''), 'en');
});

test('pageLanguage ignores the sample when lang is valid but the page is mostly CJK', () => {
  assert.equal(pageLanguage('en', '这是一个中文段落。'), 'en');
});

test('resolveTarget: non-Chinese page translates to Chinese', () => {
  assert.equal(resolveTarget({ pageLang: 'en', sourceLang: 'en' }), 'zh-CN');
  assert.equal(resolveTarget({ pageLang: 'ja', sourceLang: 'ja' }), 'zh-CN');
});

test('resolveTarget: Chinese page translates to English', () => {
  assert.equal(resolveTarget({ pageLang: 'zh', sourceLang: 'zh' }), 'en');
});

test('resolveTarget: a Chinese selection on a non-Chinese page still targets English', () => {
  assert.equal(resolveTarget({ pageLang: 'en', sourceLang: 'zh' }), 'en');
});

test('resolveTarget: an override wins over page inference', () => {
  assert.equal(resolveTarget({ pageLang: 'en', sourceLang: 'en', override: 'ja' }), 'ja');
  assert.equal(resolveTarget({ pageLang: 'zh', sourceLang: 'zh', override: 'fr' }), 'fr');
});

test('resolveTarget: an override equal to the source is discarded', () => {
  assert.equal(resolveTarget({ pageLang: 'en', sourceLang: 'en', override: 'en' }), 'zh-CN');
});