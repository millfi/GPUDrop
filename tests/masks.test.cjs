const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSource } = require('./helpers.cjs');
const { getAnalyzedPixelCount } = loadSource('src/analyzer.ts');

test('mask area counts the union of disjoint, overlapping and nested rectangles', () => {
  const a = { x: 0, y: 0, width: 0.5, height: 0.5 };
  const b = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
  assert.equal(getAnalyzedPixelCount([], 100, 100), 10000);
  assert.equal(getAnalyzedPixelCount([a], 100, 100), 7500);
  assert.equal(getAnalyzedPixelCount([a, a], 100, 100), 7500);
  assert.equal(getAnalyzedPixelCount([a, b], 100, 100), 5625);
  assert.equal(getAnalyzedPixelCount([a, { x: 0, y: 0, width: 0.1, height: 0.1 }], 100, 100), 7500);
  assert.equal(getAnalyzedPixelCount([a, { x: 0.5, y: 0.5, width: 0.5, height: 0.5 }], 100, 100), 5000);
  assert.equal(getAnalyzedPixelCount([{ x: 0, y: 0, width: 1, height: 1 }], 100, 100), 0);
});

test('union count agrees with a pixel-by-pixel oracle on rounded and clipped masks', () => {
  let seed = 42;
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let trial = 0; trial < 100; trial++) {
    const masks = Array.from({ length: 8 }, () => ({ x: random() - 0.1, y: random() - 0.1, width: random(), height: random() }));
    let expected = 0;
    for (let y = 0; y < 19; y++) for (let x = 0; x < 23; x++) {
      const excluded = masks.some(m => x >= Math.floor(m.x * 23) && x < Math.ceil((m.x + m.width) * 23)
        && y >= Math.floor(m.y * 19) && y < Math.ceil((m.y + m.height) * 19));
      if (!excluded) expected++;
    }
    assert.equal(getAnalyzedPixelCount(masks, 23, 19), expected);
  }
});
