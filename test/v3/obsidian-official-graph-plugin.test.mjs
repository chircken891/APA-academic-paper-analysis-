import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = new URL('../../scripts/obsidian/apa-official-graph/main.cjs', import.meta.url);
const paper = 'Wiki/sources/研究.md';
const method = 'Wiki/methods/方法.md';
const translation = 'Wiki/translations/译文.md';
const vaultRoot = join(process.cwd(), 'synthetic-vault');
const scopeFile = join(vaultRoot, '.apa-v3', 'phase22', 'graph', 'SCOPE.json');

function scope(expectedNodes, generationId = 'committed-1') {
  return JSON.stringify({
    schema_version: 'apa-official-graph-scope-1.0',
    generation_id: generationId,
    expected_nodes: expectedNodes,
    logical_paper_count: 1,
    logical_topic_count: 0,
  });
}

function graph(type = 'graph') {
  const fullData = {
    nodes: {
      [paper]: { type: '', color: '#123456', links: { [translation]: true, [method]: true } },
      [method]: { type: '', links: { [paper]: true } },
      [translation]: { type: '', links: { [paper]: true } },
    },
    numLinks: 4,
    marker: 'native field',
  };
  class Renderer {
    constructor() {
      this.frames = [];
    }

    setData(data) {
      assert.equal(this, renderer);
      this.frames.push(data);
    }
  }
  const renderer = new Renderer();
  const engine = {
    renderer,
    query: '',
    options: { showOrphans: true },
    render() {
      const data = this.query ? {
        ...fullData,
        // The renderer has to discard link targets absent from the current node set.
        nodes: { [paper]: fullData.nodes[paper], [translation]: fullData.nodes[translation] },
      } : fullData;
      assert.equal(this, engine);
      renderer.setData(data);
    },
  };
  const view = type === 'graph' ? { dataEngine: engine } : { engine };
  return { engine, renderer, leaf: { type, view }, fullData };
}

async function nextTurn() {
  await new Promise(resolve => setImmediate(resolve));
}

function host(t, loadScope = () => scope([paper, method])) {
  assert.ok(existsSync(source), 'The official graph plugin entrypoint must exist');
  const leaves = [];
  const notices = [];
  const disposers = [];
  const layoutCallbacks = new Set();
  const layoutListeners = new Set();
  const fileListeners = new Map();
  const app = {
    vault: { adapter: { getBasePath: () => vaultRoot } },
    workspace: {
      getLeavesOfType: type => leaves.filter(leaf => leaf.type === type),
      onLayoutReady(callback) {
        layoutCallbacks.add(callback);
      },
      on(name, listener) {
        assert.equal(name, 'layout-change');
        layoutListeners.add(listener);
        return () => layoutListeners.delete(listener);
      },
    },
  };
  class Plugin {
    constructor() {
      this.app = app;
    }
    register(disposer) {
      disposers.push(disposer);
    }
    registerEvent(disposer) {
      this.register(disposer);
    }
  }
  class Notice {
    constructor(message) {
      notices.push(message);
    }
  }
  const fs = {
    promises: {
      async readFile(file, encoding) {
        assert.equal(file, scopeFile);
        assert.equal(encoding, 'utf8');
        return loadScope();
      },
    },
    watchFile(file, options, listener) {
      assert.equal(file, scopeFile);
      fileListeners.set(file, listener);
    },
    unwatchFile(file, listener) {
      if (fileListeners.get(file) === listener) fileListeners.delete(file);
    },
  };
  const dependencies = new Map([
    ['obsidian', { Plugin, Notice }],
    ['node:fs', fs],
    ['node:path', { join }],
  ]);
  const module = { exports: {} };
  runInNewContext(readFileSync(source, 'utf8'), {
    module,
    require(name) {
      assert.ok(dependencies.has(name), `Unexpected plugin dependency: ${name}`);
      return dependencies.get(name);
    },
  }, { filename: source.pathname });
  const plugin = new module.exports();
  let unloaded = false;
  const unload = () => {
    if (unloaded) return;
    unloaded = true;
    plugin.onunload?.();
    for (const dispose of disposers.reverse()) dispose();
  };
  t.after(unload);
  return {
    leaves,
    notices,
    unload,
    async start() {
      plugin.onload();
      for (const callback of layoutCallbacks) callback();
      await nextTurn();
    },
    async layoutChange() {
      for (const listener of layoutListeners) listener();
      await nextTurn();
    },
    async scopeChange() {
      fileListeners.get(scopeFile)?.();
      await nextTurn();
    },
  };
}

function lastFrame(graphView) {
  return graphView.renderer.frames.at(-1);
}

test('startup filters existing native graph nodes and edges while preserving the original data', async t => {
  const plugin = host(t);
  const global = graph();
  plugin.leaves.push(global.leaf);
  global.engine.render();
  await plugin.start();

  const frame = lastFrame(global);
  assert.deepEqual(Object.keys(frame.nodes), [paper, method]);
  assert.deepEqual(Object.keys(frame.nodes[paper].links), [method]);
  assert.deepEqual(Object.keys(frame.nodes[method].links), [paper]);
  assert.equal(frame.nodes[paper].color, '#123456');
  assert.equal(frame.marker, 'native field');
  assert.equal(frame.numLinks, 2);
  assert.deepEqual(Object.keys(global.fullData.nodes[paper].links), [translation, method]);
  assert.equal(global.fullData.numLinks, 4);
});

test('a native query intersects the official scope and clearing the query restores only that scope', async t => {
  const plugin = host(t);
  const view = graph();
  plugin.leaves.push(view.leaf);
  view.engine.query = '研究';
  await plugin.start();

  assert.equal(view.engine.query, '研究');
  assert.deepEqual(Object.keys(lastFrame(view).nodes), [paper]);
  assert.deepEqual(Object.keys(lastFrame(view).nodes[paper].links), []);
  view.engine.query = '';
  view.engine.render();
  assert.deepEqual(Object.keys(lastFrame(view).nodes), [paper, method]);
});

test('the native orphan toggle uses connections inside the official scope', async t => {
  const concept = 'Wiki/concepts/概念.md';
  const plugin = host(t, () => scope([paper, method, concept]));
  const view = graph();
  view.fullData.nodes = {
    [paper]: { type: '', links: { [translation]: true, [paper]: true } },
    [method]: { type: '', links: { [concept]: true } },
    [concept]: { type: '', links: {} },
    [translation]: { type: '', links: {} },
  };
  plugin.leaves.push(view.leaf);
  await plugin.start();
  assert.deepEqual(Object.keys(lastFrame(view).nodes), [paper, method, concept]);
  assert.equal(lastFrame(view).numLinks, 2);

  // The native input retains every node because each has a non-self edge in
  // the full graph. The paper loses that connection once the plugin scopes it.
  view.engine.options.showOrphans = false;
  view.engine.render();
  assert.deepEqual(Object.keys(lastFrame(view).nodes), [method, concept]);
  assert.deepEqual(Object.keys(lastFrame(view).nodes[method].links), [concept]);
  assert.equal(lastFrame(view).numLinks, 1);

  view.engine.options.showOrphans = true;
  view.engine.render();
  assert.deepEqual(Object.keys(lastFrame(view).nodes), [paper, method, concept]);
});

test('a new committed scope redraws the current graph and applies to newly opened graphs', async t => {
  let current = scope([paper]);
  const plugin = host(t, () => current);
  const first = graph();
  plugin.leaves.push(first.leaf);
  await plugin.start();
  assert.deepEqual(Object.keys(lastFrame(first).nodes), [paper]);

  current = scope([method], 'committed-2');
  await plugin.scopeChange();
  assert.deepEqual(Object.keys(lastFrame(first).nodes), [method]);
  const next = graph();
  const local = graph('localgraph');
  plugin.leaves.push(next.leaf, local.leaf);
  await plugin.layoutChange();
  assert.deepEqual(Object.keys(lastFrame(next).nodes), [method]);
  local.engine.render();
  assert.deepEqual(Object.keys(lastFrame(local).nodes), [paper, method, translation]);
});

test('missing or malformed scope leaves an empty graph and emits only one notice', async t => {
  let current = 'broken JSON';
  const plugin = host(t, () => {
    if (!current) throw Object.assign(new Error('Missing scope'), { code: 'ENOENT' });
    return current;
  });
  const view = graph();
  plugin.leaves.push(view.leaf);
  await plugin.start();
  assert.deepEqual(Object.keys(lastFrame(view).nodes), []);
  assert.equal(lastFrame(view).numLinks, 0);
  assert.equal(plugin.notices.length, 1);

  current = null;
  await plugin.scopeChange();
  assert.deepEqual(Object.keys(lastFrame(view).nodes), []);
  assert.equal(plugin.notices.length, 1);

  current = scope([paper]);
  await plugin.scopeChange();
  assert.deepEqual(Object.keys(lastFrame(view).nodes), [paper]);

  current = scope([paper, null]);
  await plugin.scopeChange();
  assert.deepEqual(Object.keys(lastFrame(view).nodes), []);
  assert.equal(plugin.notices.length, 1);
});

test('a slow filesystem read cannot replace a newer scope', async t => {
  const pending = [];
  const plugin = host(t, () => new Promise(resolve => pending.push(resolve)));
  const view = graph();
  plugin.leaves.push(view.leaf);
  await plugin.start();
  await plugin.scopeChange();
  assert.equal(pending.length, 2);

  pending[1](scope([method], 'committed-2'));
  await nextTurn();
  pending[0](scope([paper]));
  await nextTurn();

  assert.deepEqual(Object.keys(lastFrame(view).nodes), [method]);
});

test('unloading restores the inherited renderer method, redraws, and drops callbacks in flight', async t => {
  let read = () => scope([paper]);
  const plugin = host(t, () => read());
  const view = graph();
  plugin.leaves.push(view.leaf);
  const nativeSetData = view.renderer.setData;
  await plugin.start();
  assert.deepEqual(Object.keys(lastFrame(view).nodes), [paper]);

  let resolveScope;
  read = () => new Promise(resolve => { resolveScope = resolve; });
  await plugin.scopeChange();
  plugin.unload();
  assert.equal(view.renderer.setData, nativeSetData);
  assert.equal(Object.hasOwn(view.renderer, 'setData'), false);
  assert.deepEqual(Object.keys(lastFrame(view).nodes), [paper, method, translation]);
  const framesBeforeUpdate = view.renderer.frames.length;
  resolveScope(scope([method], 'committed-2'));
  await plugin.scopeChange();
  await plugin.layoutChange();
  assert.equal(view.renderer.frames.length, framesBeforeUpdate);
});
