import { assertCommittedSnapshot, assertRegisteredCommit, normalizeIndexPath, readCommittedReadingFirstPresentations,
  verifyReadingFirstPresentation, INDEX_READING_FIRST_PROFILE, readRegisteredObject } from './phase22-active-version.mjs';

const fail = (code, details = {}) => { throw Object.assign(new Error(code), { code, details }); };
const escapeRegex = text => text.replace(/[.*+?^$\{\}()|[\]\\/]/g, '\\$&');

/**
 * Read-only proposal: Obsidian path:/regex/ uses JavaScript regular expressions.
 * Official syntax: https://obsidian.md/help/plugins/search
 * This only produces a proposal.
 */
export function buildGraphProposal({ activeSnapshot, entityInventory } = {}) {
  assertCommittedSnapshot(activeSnapshot);
  const readingFirst = readCommittedReadingFirstPresentations(activeSnapshot);
  return graphProposal(activeSnapshot, entityInventory, readingFirst);
}

/** Registered metadata drives graph membership even when editable note bytes change. */
export function buildRegisteredGraphProposal({ activeSnapshot, entityInventory } = {}) {
  assertRegisteredCommit(activeSnapshot);
  const readingFirst = activeSnapshot.generation.papers.filter(paper => paper.profile === INDEX_READING_FIRST_PROFILE).map(paper => {
    const object = activeSnapshot.generation.objects.find(row => row.path === paper.reader_presentation.path && row.kind === 'reader-presentation');
    if (!object) fail('P22_GRAPH_PRESENTATION_MISSING', { path: paper.reader_presentation.path });
    const { bytes } = readRegisteredObject(activeSnapshot, object.path);
    return { paper, presentation: verifyReadingFirstPresentation(paper, bytes, activeSnapshot.generation) };
  });
  assertRegisteredCommit(activeSnapshot);
  return graphProposal(activeSnapshot, entityInventory, readingFirst);
}

function graphProposal(activeSnapshot, entityInventory, readingFirst) {
  if (!Array.isArray(entityInventory)) fail('P22_GRAPH_INVENTORY_REQUIRED');
  const paths = entityInventory.map(entry => normalizeIndexPath(entry?.path));
  if (new Set(paths.map(path => path.normalize('NFC').toLowerCase())).size !== paths.length) fail('P22_GRAPH_PATH_COLLISION');
  const { generation } = activeSnapshot;
  const topics = generation.topics ?? [];
  const expectedNodes = [
    ...generation.papers.map(paper => {
      const sourcePaths = Object.values(paper.paths).filter(path => path.startsWith('Wiki/sources/'));
      return sourcePaths.length === 1 ? sourcePaths[0] : paper.paths['zh-CN'];
    }),
    ...generation.shared_nodes.map(node => node.path),
    ...topics.map(topic => topic.path),
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
  return {
    generation_id: generation.generation_id, evidence_mode: generation.evidence_mode,
    filter: expectedNodes.length ? 'path:/^(?:' + expectedNodes.map(escapeRegex).join('|') + ')$/' : 'path:/(?!)/',
    expectedNodes, excludedNodes, expectedLanguageLinks,
    ...(readingFirst.length ? { reading_first_support_paths: [...new Set(readingFirst.flatMap(row => row.presentation.targets.support.map(node => node.path)))].sort(),
      reading_first_native_presentation: 'not_run' } : {}),
    showOrphans: true, hideUnresolved: true,
    logicalPaperCount: generation.papers.length, logicalTopicCount: topics.length, nativeNodeCount: expectedNodes.length,
    native_gui: 'not_run', production_config: 'not_switched',
  };
}

