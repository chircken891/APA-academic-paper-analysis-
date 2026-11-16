const { Plugin, Notice } = require('obsidian');
const { promises: { readFile }, watchFile, unwatchFile } = require('node:fs');
const { join } = require('node:path');

function readScopePaths(contents) {
  const scope = JSON.parse(contents);
  if (scope?.schema_version !== 'apa-official-graph-scope-1.0'
      || typeof scope.generation_id !== 'string' || !scope.generation_id.trim()
      || !Number.isInteger(scope.logical_paper_count) || scope.logical_paper_count < 0
      || !Number.isInteger(scope.logical_topic_count) || scope.logical_topic_count < 0
      || !Array.isArray(scope.expected_nodes)
      || !scope.expected_nodes.every(path => typeof path === 'string' && path.trim())) {
    throw new Error('Invalid official graph scope');
  }
  return new Set(scope.expected_nodes);
}

function filterGraphData(data, scopePaths, hideOrphans) {
  const nodes = Object.create(null);
  for (const [path, node] of Object.entries(data.nodes)) {
    if (scopePaths.has(path)) nodes[path] = { ...node, links: Object.create(null) };
  }

  const connectedPaths = hideOrphans ? new Set() : null;
  let numLinks = 0;
  for (const [path, node] of Object.entries(nodes)) {
    for (const [target, link] of Object.entries(data.nodes[path].links)) {
      if (!Object.hasOwn(nodes, target)) continue;
      node.links[target] = link;
      numLinks++;
      if (connectedPaths && path !== target) {
        connectedPaths.add(path);
        connectedPaths.add(target);
      }
    }
  }
  // Obsidian counts incoming and outgoing connections, excluding self-links.
  if (connectedPaths) {
    for (const [path, node] of Object.entries(nodes)) {
      if (connectedPaths.has(path)) continue;
      numLinks -= Object.keys(node.links).length;
      delete nodes[path];
    }
  }
  return { ...data, nodes, numLinks };
}

module.exports = class ApaOfficialGraphPlugin extends Plugin {
  onload() {
    this.active = true;
    this.scopePaths = new Set();
    this.scopeLoaded = false;
    this.scopeNoticeShown = false;
    this.scopeRead = 0;
    this.patches = new Map();
    this.scopeFile = join(this.app.vault.adapter.getBasePath(), '.apa-v3', 'phase22', 'graph', 'SCOPE.json');

    const reload = () => this.reloadScope();
    watchFile(this.scopeFile, { persistent: false, interval: 1000 }, reload);
    this.register(() => unwatchFile(this.scopeFile, reload));

    const workspace = this.app.workspace;
    workspace.onLayoutReady(() => {
      if (!this.active) return;
      this.registerEvent(workspace.on('layout-change', () => this.attachViews()));
      this.attachViews();
    });
    return this.reloadScope();
  }

  async reloadScope() {
    if (!this.active) return;
    const read = ++this.scopeRead;
    let paths;
    let error;
    try {
      paths = readScopePaths(await readFile(this.scopeFile, 'utf8'));
    } catch (cause) {
      paths = new Set();
      error = cause;
    }
    if (!this.active || read !== this.scopeRead) return;
    this.scopePaths = paths;
    this.scopeLoaded = true;
    if (error && !this.scopeNoticeShown) {
      this.scopeNoticeShown = true;
      new Notice(`APA 正式图谱清单不可用，已显示空图谱。\n${error.code ?? error.message}`);
    }
    this.attachViews(true);
  }

  graphEngines() {
    // Obsidian 1.15.1 uses dataEngine on the global graph view.
    return this.app.workspace.getLeavesOfType('graph')
      .map(leaf => leaf.view.dataEngine)
      .filter(engine => typeof engine?.render === 'function' && typeof engine.renderer?.setData === 'function');
  }

  attachViews(refresh = false) {
    if (!this.active) return;
    const engines = this.graphEngines();
    const renderers = new Set(engines.map(engine => engine.renderer));
    for (const [renderer, restore] of this.patches) {
      if (renderers.has(renderer)) continue;
      restore();
      this.patches.delete(renderer);
    }

    for (const engine of engines) {
      const renderer = engine.renderer;
      const alreadyPatched = this.patches.has(renderer);
      if (!alreadyPatched) this.patchRenderer(engine);
      if (this.scopeLoaded && (refresh || !alreadyPatched)) engine.render();
    }
  }

  patchRenderer(engine) {
    const plugin = this;
    const renderer = engine.renderer;
    const original = renderer.setData;
    const ownMethod = Object.getOwnPropertyDescriptor(renderer, 'setData');
    function setData(data, ...args) {
      const payload = plugin.active
        ? filterGraphData(data, plugin.scopePaths, engine.options.showOrphans === false)
        : data;
      return original.call(this, payload, ...args);
    }
    renderer.setData = setData;
    this.patches.set(renderer, () => {
      if (renderer.setData !== setData) return;
      if (ownMethod) Object.defineProperty(renderer, 'setData', ownMethod);
      else delete renderer.setData;
    });
  }

  onunload() {
    this.active = false;
    const engines = this.graphEngines().filter(engine => this.patches.has(engine.renderer));
    for (const restore of this.patches.values()) restore();
    this.patches.clear();
    for (const engine of engines) engine.render();
  }
};
