const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

// Load the production TypeScript with browser/GPU boundaries replaced by fakes.
function loadSource(file, mocks = {}, globals = {}, cache = new Map()) {
  file = path.resolve(__dirname, '..', file);
  if (cache.has(file)) return cache.get(file).exports;
  const module = { exports: {} };
  cache.set(file, module);
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(code, {
    module, exports: module.exports, console, performance, AbortController,
    setTimeout, clearTimeout, ...globals,
    require(id) {
      if (Object.hasOwn(mocks, id)) return mocks[id];
      if (id.startsWith('.')) {
        const base = path.resolve(path.dirname(file), id);
        return loadSource(fs.existsSync(base + '.ts') ? base + '.ts' : base + '.tsx', mocks, globals, cache);
      }
      return require(id);
    },
  }, { filename: file });
  return module.exports;
}

function createApp(overrides = {}) {
  const slots = [];
  let cursor = 0;
  let effects = [];
  const players = [];
  const exports = [];
  const canvas = { width: 640, height: 360, getContext: () => ({ clearRect() {} }) };
  const react = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], next => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }];
    },
    useRef(initial) {
      const i = cursor++;
      return slots[i] ??= { current: initial };
    },
    useEffect(fn, deps) {
      const i = cursor++;
      if (!slots[i] || deps.some((x, j) => x !== slots[i][j])) effects.push(fn);
      slots[i] = deps;
    },
  };
  class Player {
    constructor(options) { this.options = options; players.push(this); }
    async start() {
      this.options.onReady({ timestamp: 0, duration: 10 });
      this.options.onStats({ timestamp: 0, frameNumber: 1, fps: 1, frameTime: 0 });
    }
    pause() { this.options.onPausedChange(true); }
    resume() { this.options.onPausedChange(false); }
    stop() { this.options.onEnd(); }
    setThreshold() {} setFrameThreshold() {} setMask() {} setMasks() {}
    async seek(timestamp) { this.options.onStats({ timestamp, frameNumber: 5, fps: 30, frameTime: 1 / 30 }); }
  }
  const overlay = loadSource('src/overlay.ts');
  const App = loadSource('src/App.tsx', {
    react,
    './player': { Player },
    './exporter': {
      ExportCanceledError: class extends Error {},
      exportOverlayVideo: async options => { exports.push(options); return { audioSkippedReason: null }; },
      ...overrides.exporter,
    },
    './overlay': { ...overlay, drawOverlay() {}, renderChart() {}, saveOverlayLayout() {} },
  }, {
    document: { addEventListener() {}, removeEventListener() {} },
    alert: message => { throw new Error(message); },
  }).default;
  let tree;
  function walk(node, result = []) {
    if (!node || typeof node !== 'object') return result;
    if (Array.isArray(node)) { node.forEach(n => walk(n, result)); return result; }
    result.push(node);
    if (typeof node.type === 'function') walk(node.type(node.props), result);
    walk(node.props?.children, result);
    return result;
  }
  function render() {
    cursor = 0;
    tree = App();
    for (const node of walk(tree)) {
      if (node.ref && node.type === 'canvas') node.ref.current = canvas;
    }
    const pending = effects; effects = [];
    pending.forEach(fn => fn());
    return tree;
  }
  function find(predicate) {
    const node = walk(tree).find(predicate);
    if (!node) throw new Error('Control not found');
    return node;
  }
  render();
  return { render, find, players, exports, nodes: () => walk(tree) };
}

module.exports = { loadSource, createApp };
