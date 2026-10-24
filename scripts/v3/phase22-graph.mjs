import { assertCommittedSnapshot, normalizeIndexPath, readCommittedReaderPresentations, readCommittedReadingFirstPresentations } from './phase22-active-version.mjs';

const fail = (code, details = {}) => { throw Object.assign(new Error(code), { code, details }); };
const escapeRegex = text => text.replace(/[.*+?^$\{\}()|[\]\\/]/g, '\\$&');

/**
 * Read-only proposal: Obsidian path:/regex/ uses JavaScript regular expressions.
 * Official syntax: https://obsidian.md/help/plugins/search
 * Reader native observation belongs to Plan22.1-09; this only produces a proposal.
 */
export function buildGraphProposal({ activeSnapshot, entityInventory } = {}) {
  assertCommittedSnapshot(activeSnapshot);
  if (!Array.isArray(entityInventory)) fail('P22_GRAPH_INVENTORY_REQUIRED');
  const paths = entityInventory.map(entry => normalizeIndexPath(entry?.path));
  if (new Set(paths.map(path => path.normalize('NFC').toLowerCase())).size !== paths.length) fail('P22_GRAPH_PATH_COLLISION');
  const { generation } = activeSnapshot;
  const expectedNodes = [
    ...generation.papers.map(paper => paper.paths['zh-CN']),
    ...generation.shared_nodes.map(node => node.path),
  ].sort();
  const inventory = new Set(paths), expected = new Set(expectedNodes);
  const missing = expectedNodes.filter(path => !inventory.has(path));
  if (missing.length) fail('P22_GRAPH_INVENTORY_INCOMPLETE', { missing });
  const excludedNodes = paths.filter(path => !expected.has(path)).sort();
  const expectedLanguageLinks = generation.papers.filter(paper => paper.pipeline_version === '3.0')
    .flatMap(paper => [
      { paper_id: paper.paper_id, from: paper.paths['zh-CN'], to: paper.paths.en },
      { paper_id: paper.paper_id, from: paper.paths.en, to: paper.paths['zh-CN'] },
    ]);
  const readers = readCommittedReaderPresentations(activeSnapshot);
  const readingFirst = readCommittedReadingFirstPresentations(activeSnapshot);
  const expectedReaderNavigation = readers.flatMap(({ paper, presentation }) => presentation.navigation.map(route => ({
    paper_id: paper.paper_id, from: paper.paths[route.language], ...route,
  })));
  return {
    generation_id: generation.generation_id, evidence_mode: generation.evidence_mode,
    filter: expectedNodes.length ? 'path:/^(?:' + expectedNodes.map(escapeRegex).join('|') + ')$/' : 'path:/(?!)/',
    expectedNodes, excludedNodes, expectedLanguageLinks,
    ...(readers.length ? { expectedReaderNavigation, reader_support_paths: [...new Set(readers.flatMap(row => row.presentation.targets.support))].sort(),
      reader_native_presentation: 'not_run', native_auto_expansion: 'not_observed' } : {}),
    ...(readingFirst.length ? { reading_first_support_paths: [...new Set(readingFirst.flatMap(row => row.presentation.targets.support.map(node => node.path)))].sort(),
      reading_first_native_presentation: 'not_run' } : {}),
    showOrphans: true, hideUnresolved: true,
    logicalPaperCount: generation.papers.length, nativeNodeCount: expectedNodes.length,
    native_gui: 'not_run', production_config: 'not_switched',
  };
}

