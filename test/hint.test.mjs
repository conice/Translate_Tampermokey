import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createHint } from '../src/ui/hint.js';

/**
 * The Hint owns one timer, so the clock is injected: waiting two real seconds
 * in a test is slow, and asserting the delay itself is what pins "2 秒后".
 */
function setup() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  const { window } = dom;
  const clock = { delay: null, fire: null, cleared: 0 };
  const timers = {
    set(fn, ms) {
      clock.delay = ms;
      clock.fire = fn;
      return { fn, ms };
    },
    clear() {
      clock.cleared += 1;
      clock.fire = null;
    },
  };
  const hint = createHint({ document: window.document, window, timers });
  return { window, hint, clock };
}

const SELECTION = { top: 10, left: 10, height: 12, width: 40 };

test('the hint says what the limit is and goes away by itself', () => {
  const { window, hint, clock } = setup();
  const host = window.document.querySelector('[data-tm=hint-host]');
  assert.equal(host.hidden, true, 'nothing shows before a hint is asked for');

  hint.show(SELECTION);
  assert.equal(host.hidden, false);
  assert.match(host.shadowRoot.textContent, /最多 400 字/);
  assert.equal(clock.delay, 2000, 'the hint is a glance, not a dialog');

  clock.fire();
  assert.equal(host.hidden, true);
});

test('the hint is placed rather than parked in the corner', () => {
  const { window, hint } = setup();
  const label = window.document.querySelector('[data-tm=hint-host]').shadowRoot.querySelector('.hint');
  hint.show(SELECTION);
  assert.match(label.style.top, /^\d+(\.\d+)?px$/);
  assert.match(label.style.left, /^\d+(\.\d+)?px$/);
});

test('showing the hint again restarts the countdown instead of stacking timers', () => {
  const { hint, clock } = setup();
  hint.show(SELECTION);
  assert.equal(clock.cleared, 0);

  hint.show(SELECTION);
  assert.equal(clock.cleared, 1, 'the first timer must not fire on the second hint');
  assert.equal(clock.delay, 2000);
});

test('hiding an already hidden hint does nothing', () => {
  const { hint, clock } = setup();
  hint.hide();
  assert.equal(clock.cleared, 0);
});
