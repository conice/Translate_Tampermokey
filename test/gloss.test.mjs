import test from 'node:test';
import assert from 'node:assert/strict';
import { createMatcher, segment, isProseText, isSkippableElement } from '../src/core/gloss.js';

const map = new Map([
  ['run', '跑'],
  ['apple', '苹果'],
  ['take off', '起飞'],
  ['跑', 'run'],
]);

const matcher = createMatcher(map);

test('matcher finds a whole word', () => {
  const found = matcher.find('I run every day');
  assert.deepEqual(found, [{ start: 2, end: 5, translation: '跑' }]);
});

test('matcher does not match inside a longer word', () => {
  assert.deepEqual(matcher.find('running quickly'), []);
});

test('matcher is case insensitive', () => {
  assert.deepEqual(matcher.find('Apple pie'), [{ start: 0, end: 5, translation: '苹果' }]);
});

test('matcher prefers the longest phrase', () => {
  const m = createMatcher(new Map([['take', '拿'], ['take off', '起飞']]));
  assert.deepEqual(m.find('we take off now'), [{ start: 3, end: 11, translation: '起飞' }]);
});

test('matcher ignores punctuation adjacency that is not a letter', () => {
  assert.deepEqual(matcher.find('(run)'), [{ start: 1, end: 4, translation: '跑' }]);
});

test('matcher handles CJK substrings without boundaries', () => {
  assert.deepEqual(matcher.find('我们跑得快'), [{ start: 2, end: 3, translation: 'run' }]);
});

test('matcher finds several occurrences', () => {
  const found = matcher.find('run and apple and run');
  assert.deepEqual(
    found.map((f) => f.translation),
    ['跑', '苹果', '跑'],
  );
});

test('matcher with an empty book never matches', () => {
  const empty = createMatcher(new Map());
  assert.deepEqual(empty.find('run'), []);
});

test('matcher escapes regex metacharacters in terms', () => {
  const m = createMatcher(new Map([['c++', 'C加加']]));
  assert.deepEqual(m.find('I like c++ a lot'), [{ start: 7, end: 10, translation: 'C加加' }]);
});

test('segment splits text into plain and glossed pieces', () => {
  assert.deepEqual(segment('I run home', matcher), [
    { type: 'text', text: 'I ' },
    { type: 'gloss', text: 'run', translation: '跑' },
    { type: 'text', text: ' home' },
  ]);
});

test('segment returns no pieces when nothing matches', () => {
  assert.deepEqual(segment('nothing here', matcher), []);
});

test('segment handles a match at the start and end', () => {
  assert.deepEqual(segment('run', matcher), [{ type: 'gloss', text: 'run', translation: '跑' }]);
});

test('isProseText rejects digits, punctuation and short fragments', () => {
  assert.equal(isProseText('run'), true);
  assert.equal(isProseText('a'), false);
  assert.equal(isProseText('12345'), false);
  assert.equal(isProseText('  ...  '), false);
  assert.equal(isProseText(''), false);
});

test('isSkippableElement protects code and editable regions', () => {
  assert.equal(isSkippableElement({ tagName: 'CODE' }), true);
  assert.equal(isSkippableElement({ tagName: 'PRE' }), true);
  assert.equal(isSkippableElement({ tagName: 'TEXTAREA' }), true);
  assert.equal(isSkippableElement({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(isSkippableElement({ tagName: 'P' }), false);
  assert.equal(isSkippableElement(null), false);
});