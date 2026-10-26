import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTheme, normalizeTheme } from '../src/core/theme.js';

test('theme follows the system unless the user forces one', () => {
  assert.equal(resolveTheme({ setting: 'system', prefersDark: true }), 'dark');
  assert.equal(resolveTheme({ setting: 'system', prefersDark: false }), 'light');
  assert.equal(resolveTheme({ setting: 'dark', prefersDark: true }), 'dark');
  assert.equal(resolveTheme({ setting: 'dark', prefersDark: false }), 'dark');
  assert.equal(resolveTheme({ setting: 'light', prefersDark: true }), 'light');
  assert.equal(resolveTheme({ setting: 'light', prefersDark: false }), 'light');
});

test('an unknown or missing setting falls back to following the system', () => {
  assert.equal(resolveTheme({ setting: undefined, prefersDark: true }), 'dark');
  assert.equal(resolveTheme({ setting: 'purple', prefersDark: false }), 'light');
  assert.equal(normalizeTheme('dark'), 'dark');
  assert.equal(normalizeTheme('nonsense'), 'system');
});