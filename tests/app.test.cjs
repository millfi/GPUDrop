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
  assert.equal(app.find(n => n.props?.children === 'Add mask').props.disabled, false);
  assert.equal(app.find(n => n.props?.children === 'Edit layout').props.disabled, false);
  assert.equal(app.find(n => n.props?.children === 'Export').props.disabled, false);
});

function drawMask(app, x1, y1, x2, y2, cancel = false) {
  app.find(n => n.props?.children === 'Add mask').props.onClick();
  app.render();
  const layer = () => app.find(n => n.props?.className === 'mask-layer is-editing');
  const currentTarget = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 100 }),
    setPointerCapture() {},
  };
  layer().props.onPointerDown({ button: 0, pointerId: 1, clientX: x1, clientY: y1, currentTarget });
  app.render();
  if (cancel) layer().props.onPointerCancel();
  else layer().props.onPointerUp({ clientX: x2, clientY: y2, currentTarget });
  app.render();
}

test('multiple masks are exported, independently removable, and reset for a new file', async () => {
  const app = createApp();
  const choose = name => {
    app.find(n => n.props?.type === 'file').props.onChange({ target: { files: [{ name }] } });
    app.render();
  };
  choose('first.mp4');
  drawMask(app, 0, 0, 30, 30);
  drawMask(app, 20, 20, 50, 50);
  drawMask(app, 70, 70, 80, 80, true);
  assert.equal(app.nodes().filter(n => n.props?.className === 'mask-rectangle').length, 2);
  await app.find(n => n.props?.children === 'Export').props.onClick();
  assert.equal(app.exports[0].masks.length, 2);
  assert.equal(app.exports[0].masks[1].x, 0.2);
  app.render();
  app.find(n => n.props?.['aria-label'] === 'Remove mask 1').props.onClick();
  app.render();
  assert.equal(app.nodes().filter(n => n.props?.className === 'mask-rectangle').length, 1);
  choose('second.mp4');
  assert.equal(app.nodes().filter(n => n.props?.className === 'mask-rectangle').length, 0);
});

test('masks that would exclude the entire frame are rejected', () => {
  const app = createApp();
  app.find(n => n.props?.type === 'file').props.onChange({ target: { files: [{ name: 'test.mp4' }] } });
  app.render();
  drawMask(app, 0, 0, 50, 100);
  drawMask(app, 50, 0, 100, 100);
  assert.equal(app.nodes().filter(n => n.props?.className === 'mask-rectangle').length, 1);
  app.find(n => n.props?.children === 'This mask would leave no pixels to analyze.');
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
