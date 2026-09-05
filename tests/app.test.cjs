const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./helpers.cjs');

test('paused playback can export the file independently of the seek position', async () => {
  const app = createApp();
  const file = { name: 'capture.mp4' };
  app.find(n => n.props?.type === 'file').props.onChange({ target: { files: [file] } });
  app.render();
  app.find(n => n.props?.['aria-label'] === 'Play').props.onClick();
  app.render();
  assert.equal(app.find(n => n.props?.children === 'Export').props.disabled, true);
  app.players[0].pause();
  await app.players[0].seek(5);
  app.render();
  const button = app.find(n => n.props?.children === 'Export');
  assert.equal(button.props.disabled, false);
  await button.props.onClick();
  assert.equal(app.exports.length, 1);
  assert.equal(app.exports[0].file, file);
  assert.equal(app.exports[0].startTime, undefined);
  assert.equal(app.exports[0].endTime, undefined);
  assert.equal(app.players.length, 2, 'the player is restored after exporting');
});

test('file selection shows the first frame paused with editing and export available', () => {
  const app = createApp();
  assert.equal(app.nodes().some(n => n.props?.children === 'Start'), false);
  app.find(n => n.props?.type === 'file').props.onChange({ target: { files: [{ name: 'capture.mp4' }] } });
  app.render();
  assert.equal(app.players.length, 1);
  assert.equal(app.find(n => n.props?.['aria-label'] === 'Play').props.disabled, false);
  assert.equal(app.find(n => n.props?.children === 'Select mask area').props.disabled, false);
  assert.equal(app.find(n => n.props?.children === 'Edit layout').props.disabled, false);
  assert.equal(app.find(n => n.props?.children === 'Export').props.disabled, false);
});

test('callbacks from a replaced file cannot overwrite the new player', () => {
  const app = createApp();
  const choose = name => {
    app.find(n => n.props?.type === 'file').props.onChange({ target: { files: [{ name }] } });
    app.render();
  };
  choose('first.mp4');
  const old = app.players[0];
  choose('second.mp4');
  old.options.onStats({ timestamp: 99, frameNumber: 999, fps: 999, frameTime: 0 });
  old.options.onPausedChange(false);
  old.options.onEnd();
  app.render();
  assert.equal(app.find(n => n.props?.['aria-label'] === 'Play').props.disabled, false);
  assert.equal(app.nodes().some(n => typeof n.props?.children === 'string' && n.props.children.includes('frame#999')), false);
});

test('export locks all chart settings until it completes', async () => {
  let complete;
  const app = createApp({ exporter: {
    exportOverlayVideo: () => new Promise(resolve => { complete = resolve; }),
  } });
  app.find(n => n.props?.type === 'file').props.onChange({ target: { files: [{ name: 'capture.mp4' }] } });
  app.render();
  const pending = app.find(n => n.props?.children === 'Export').props.onClick();
  app.render();
  const settings = () => app.nodes().filter(n => ['axis-range-slider', 'axis-number'].includes(n.props?.className));
  assert.equal(settings().length, 12);
  assert.ok(settings().every(n => n.props.disabled));
  assert.ok(app.find(n => n.props?.type === 'file').props.disabled);
  complete({ audioSkippedReason: null });
  await pending;
  app.render();
  assert.ok(settings().every(n => !n.props.disabled));
});
