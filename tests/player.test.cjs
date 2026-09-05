const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSource } = require('./helpers.cjs');

async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.fail('Timed out waiting for player');
}

test('real playback pipeline loads one frame, steps both ways, resumes and stops', async () => {
  const stats = [];
  const paused = [];
  const samples = [0, 0.01, 0.02].map(timestamp => ({
    timestamp, close() {}, toVideoFrame: () => ({ timestamp: timestamp * 1e6, close() {} }),
  }));
  const track = {
    canDecode: async () => true, getFirstTimestamp: async () => 0,
    getCodedWidth: async () => 100, getCodedHeight: async () => 100,
  };
  class Analyzer {
    first = true;
    async init() {} destroy() {} async renderBlankDiff() {} async renderDiffBetween() {}
    async reset() { this.first = true; }
    async compare() { const isFirst = this.first; this.first = false; return { isFirst, diffCount: 10000 }; }
  }
  const { Player } = loadSource('src/player.ts', {
    mediabunny: {
      BlobSource: class {}, ALL_FORMATS: [],
      Input: class { async getPrimaryVideoTrack() { return track; } async getDurationFromMetadata() { return 0.03; } dispose() {} },
      VideoSampleSink: class {
        async *samples(start) { yield* samples.filter(s => s.timestamp >= start); }
        async getSample(time) { return samples.findLast(s => s.timestamp <= time) ?? null; }
      },
    },
    './analyzer': { Analyzer, getAnalyzedPixelCount: () => 10000 },
  }, {
    window: { setTimeout, clearTimeout }, createImageBitmap: async () => ({ close() {} }),
  });
  const player = new Player({
    file: {}, videoCanvas: { getContext: () => ({ drawImage() {} }) }, diffCanvas: {},
    threshold: 0.05, frameThreshold: 0.001, mask: null,
    onStats: s => stats.push(s), onDuplicate() {}, onPausedChange: value => paused.push(value),
  });
  const playback = player.start();
  await until(() => stats.length === 1);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(stats.length, 1);
  assert.equal(stats[0].timestamp, 0);
  assert.equal(paused.at(-1), true);
  await player.stepForward();
  await until(() => stats.length === 2);
  assert.equal(stats.at(-1).timestamp, 0.01);
  await player.stepBackward();
  assert.equal(stats.at(-1).timestamp, 0);
  await player.stepForward();
  assert.equal(stats.at(-1).timestamp, 0.01);
  player.resume();
  await playback;
  assert.equal(stats.at(-1).timestamp, 0.02);
  player.stop();
});
