const test = require('node:test');
const assert = require('node:assert/strict');
const { createApp } = require('./helpers.cjs');

test('paused playback can export the file independently of the seek position', async () => {
  const app = createApp();
  const file = { name: 'capture.mp4' };
  app.find(n => n.props?.type === 'file').props.onChange({ target: { files: [file] } });
  app.render();
  await app.find(n => n.props?.children === 'Start').props.onClick();
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
