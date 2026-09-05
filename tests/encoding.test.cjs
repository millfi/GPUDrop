const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSource, createApp } = require('./helpers.cjs');
const { DEFAULT_ENCODING_SETTINGS: defaults, makeEncodingConfig, validateEncodingSettings } = loadSource('src/encoding-settings.ts');

test('bitrate and encoder options are preserved without a stale automatic codec level', () => {
  const config = makeEncodingConfig({ ...defaults, rateControl: 'bitrate', bitrateMbps: 25.5, bitrateMode: 'constant', hardwareAcceleration: 'prefer-software', latencyMode: 'realtime', keyFrameInterval: 0, scalabilityMode: 'L1T2', contentHint: 'detail', alpha: 'keep' }, 'avc', 12e6);
  const rate = config.quality._toVideoRateControl('avc', 1920, 1080);
  assert.equal(rate.bitrate, 25500000);
  assert.equal(rate.bitrateMode, 'constant');
  assert.equal(config.fullCodecString, undefined);
  assert.equal(config.hardwareAcceleration, 'prefer-software');
  assert.equal(config.latencyMode, 'realtime');
  assert.equal(config.keyFrameInterval, 0);
  assert.equal(config.scalabilityMode, 'L1T2');
  assert.equal(config.contentHint, 'detail');
  assert.equal(config.alpha, 'keep');
});

test('explicit quantizer has no silent bitrate fallback unless opted in', () => {
  const settings = { ...defaults, codec: 'av1', rateControl: 'quantizer', quantizer: 200 };
  let rate = makeEncodingConfig(settings, 'av1', 5e6).quality._toVideoRateControl('av1', 1920, 1080);
  assert.equal(rate.quantizer, 200);
  assert.equal(rate.bitrateMode, 'quantizer');
  rate = makeEncodingConfig({ ...settings, quantizerFallback: true, bitrateMbps: 8 }, 'av1', 5e6).quality._toVideoRateControl('av1', 1920, 1080);
  assert.equal(rate.quantizer, 200);
  assert.equal(rate.bitrate, 8e6);
  assert.equal(rate.bitrateMode, 'variable');
});

test('invalid inputs and mismatched codec strings are rejected', () => {
  for (const overrides of [
    { rateControl: 'bitrate', bitrateMbps: NaN }, { keyFrameInterval: -1 },
    { rateControl: 'quality', quality: Infinity },
    { rateControl: 'quantizer', codec: 'auto' },
    { rateControl: 'quantizer', codec: 'avc', quantizer: 52 },
    { rateControl: 'quantizer', codec: 'hevc', quantizer: 1.5 },
    { rateControl: 'quantizer', codec: 'av1', quantizer: 256 },
    { codec: 'avc', fullCodecString: 'av01.0.08M.08' },
  ]) assert.ok(validateEncodingSettings({ ...defaults, ...overrides }));
});

test('quality level can force bitrate and preserve VBR/CBR selection', () => {
  const config = makeEncodingConfig({ ...defaults, rateControl: 'quality', quality: .75, preferBitrate: true, bitrateMode: 'constant' }, 'avc', 12e6);
  const rate = config.quality._toVideoRateControl('avc', 1920, 1080);
  assert.equal(rate.quantizer, null);
  assert.equal(rate.bitrateMode, 'constant');
});

test('explicit codec selection never falls back to another codec', async () => {
  const calls = [];
  const { selectEncodingConfig } = loadSource('src/exporter.ts', { mediabunny: { ...require('mediabunny'), canEncodeVideo: async (codec, config) => { calls.push({ codec, config }); return false; } } });
  await assert.rejects(selectEncodingConfig(1920, 1080, { ...defaults, codec: 'hevc', rateControl: 'bitrate', bitrateMbps: 20 }), /unsupported/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].codec, 'hevc');
  assert.equal(calls[0].config.quality._toVideoRateControl('hevc', 1920, 1080).bitrate, 20e6);
});

test('UI exports a snapshot of edited settings and rejects incomplete numeric fields', async () => {
  const app = createApp();
  app.find(n => n.props?.type === 'file').props.onChange({ target: { files: [{ name: 'capture.mp4' }] } });
  app.render();
  app.find(n => n.type === 'select' && n.props['aria-label'] === 'Rate control').props.onChange({ target: { value: 'bitrate' } });
  app.render();
  app.find(n => n.props?.['aria-label'] === 'Bitrate (Mbps)').props.onChange({ target: { valueAsNumber: 32 } });
  app.render();
  await app.find(n => n.props?.children === 'Export').props.onClick();
  assert.equal(app.exports[0].encoding.bitrateMbps, 32);
  assert.equal(app.exports[0].encoding.rateControl, 'bitrate');
  app.render();
  app.find(n => n.props?.['aria-label'] === 'Bitrate (Mbps)').props.onChange({ target: { valueAsNumber: NaN } });
  app.render();
  assert.equal(app.find(n => n.props?.children === 'Export').props.disabled, true);
});

test('export pipeline passes the user settings into encoder capability detection', async () => {
  const calls = [];
  const track = { canDecode: async () => true, getFirstTimestamp: async () => 0, getCodedWidth: async () => 640, getCodedHeight: async () => 360 };
  const bunny = require('mediabunny');
  const { exportOverlayVideo } = loadSource('src/exporter.ts', {
    mediabunny: { ...bunny, BlobSource: class {}, Input: class {
      async getPrimaryVideoTrack() { return track; }
      async getDurationFromMetadata() { return 1; }
      dispose() {}
    }, canEncodeVideo: async (codec, config) => { calls.push({ codec, config }); return false; } },
    './analyzer': { Analyzer: class { async init() {} destroy() {} }, getAnalyzedPixelCount: () => 640 * 360 },
  }, { document: { createElement: () => ({ getContext: () => ({}) }) } });
  await assert.rejects(exportOverlayVideo({
    file: {}, videoCanvas: { getContext: () => ({}) }, diffCanvas: {}, masks: [],
    signal: new AbortController().signal,
    encoding: { ...defaults, codec: 'avc', rateControl: 'bitrate', bitrateMbps: 31 },
  }), /unsupported/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].codec, 'avc');
  assert.equal(calls[0].config.quality._toVideoRateControl('avc', 640, 360).bitrate, 31e6);
});
