import { fingerprintV3Json as hash } from './semantic-package-validator.mjs';
import { collectLanguageSpans } from './phase22-language.mjs';

const fail = (code, details = {}) => { throw Object.assign(new Error(code), { code, details }); };
const anchor = (kind, id) => kind + '-' + hash({ id }).slice(7, 31);
const safe = value => {
  if (typeof value !== 'string' || !value.trim() || /<!--|\[\[|!\[|<\/?(?:script|style|iframe)|^---$/im.test(value)) fail('P221_VISUAL_TEXT_INVALID');
  return value;
};
const label = value => safe(value).replace(/[\r\n|\[\]]/g, ' ');
const link = (target, text) => `[[${target}|${label(text)}]]`;

function nativeTable(grid, item, blocks, literal) {
  const bad = () => fail('P221_VISUAL_TABLE_GRID_INVALID', { inventory_id: item.inventory_id });
  const range = grid?.range, sheet = grid?.sheet;
  if (item.kind !== 'table' || !grid || !sheet || !Number.isSafeInteger(sheet.index) || sheet.index < 0 || !sheet.name
    || !range || !['start_row', 'start_column', 'end_row', 'end_column'].every(key => Number.isSafeInteger(range[key]) && range[key] > 0)
    || range.start_row > range.end_row || range.start_column > range.end_column || !Array.isArray(grid.cells) || !Array.isArray(grid.missing_cells)) bad();
  const entries = new Map(), missing = [];
  const add = cell => {
    if (!Number.isSafeInteger(cell.row) || !Number.isSafeInteger(cell.column) || cell.row < range.start_row || cell.row > range.end_row
      || cell.column < range.start_column || cell.column > range.end_column || entries.has(cell.row + ':' + cell.column)) bad();
    entries.set(cell.row + ':' + cell.column, cell);
  };
  for (const cell of grid.cells) {
    const block = blocks.find(row => row.source_block_id === cell.source?.source_block_id), loc = block?.native_locator;
    if (cell.status !== 'observed' || !block || !item.source_block_ids.includes(block.source_block_id) || !loc || loc.kind !== 'workbook'
      || block.source_document_id !== grid.source_document_id || block.source_hash !== grid.source_hash
      || loc.block_id !== block.block_id || loc.source_document_id !== grid.source_document_id || loc.source_hash !== grid.source_hash || hash(loc.sheet) !== hash(sheet)
      || hash(loc) !== hash(cell.native_locator) || loc.range?.start_row !== cell.row || loc.range.end_row !== cell.row
      || loc.range.start_column !== cell.column || loc.range.end_column !== cell.column) bad();
    literal(cell.source); add(cell);
  }
  for (const cell of grid.missing_cells) {
    if (cell.status !== 'not_assessable' || typeof cell.reason !== 'string' || !cell.reason.trim()) bad();
    safe(cell.reason); add(cell); missing.push(cell);
  }
  if (entries.size !== (range.end_row - range.start_row + 1) * (range.end_column - range.start_column + 1)) bad();
  const nativeBlocks = blocks.filter(block => item.source_block_ids.includes(block.source_block_id) && block.native_locator?.kind === 'workbook');
  if (!nativeBlocks.length || nativeBlocks.some(block => block.source_document_id !== grid.source_document_id || block.source_hash !== grid.source_hash
    || hash(block.native_locator.sheet) !== hash(sheet)
    || !grid.cells.some(cell => cell.source.source_block_id === block.source_block_id) && !grid.missing_cells.some(cell => cell.row === block.native_locator.range.start_row && cell.column === block.native_locator.range.start_column))) bad();
  const escape = text => text.replace(/\|/g, '&#124;').replace(/\r?\n/g, '<br>');
  const columns = Array.from({ length: range.end_column - range.start_column + 1 }, (_, index) => range.start_column + index);
  return { missing, location: { sheet, range }, render(zh) {
    const header = '| ' + (zh ? '行 / 列' : 'Row / column') + ' | ' + columns.join(' | ') + ' |';
    const rows = [header, '| ' + ['---', ...columns.map(() => '---')].join(' | ') + ' |'];
    for (let row = range.start_row; row <= range.end_row; row++) rows.push('| ' + row + ' | ' + columns.map(column => {
      const cell = entries.get(row + ':' + column);
      return escape(cell.status === 'observed' ? literal(cell.source) : (zh ? '无法评估：' : 'Not assessable: ') + cell.reason);
    }).join(' | ') + ' |');
    return rows.join('\n');
  } };
}

/** Mapping requests carry no authority: every literal resolves against the admitted source. */
export function buildReaderVisuals({ input, manifest = {}, targetRegistry, assets = { assets: [], records: [], gaps: [] } } = {}) {
  const science = input.science, details = science.scientific_details;
  const blocks = details.source_blocks, units = manifest.visualUnits ?? [];
  const fragments = { en: [], 'zh-CN': [] }, navigation = [], gaps = [], bindings = [];
  const relocated = { en: new Set(), 'zh-CN': new Set() };
  const used = new Set();
  for (const unit of units) {
    if (used.has(unit.inventory_id) || !details.inventory.some(row => row.inventory_id === unit.inventory_id)) fail('P221_VISUAL_INVENTORY_INVALID');
    used.add(unit.inventory_id);
  }
  const sorted = details.inventory.map((item, index) => ({ item, index,
    order: Math.min(...item.source_block_ids.map(id => blocks.findIndex(row => row.source_block_id === id)).filter(n => n >= 0)),
    offset: units.find(unit => unit.inventory_id === item.inventory_id)?.number?.start ?? 0
  })).sort((a, b) => a.order - b.order || a.offset - b.offset || a.index - b.index);
  for (const { item, order } of sorted) {
    const unit = units.find(row => row.inventory_id === item.inventory_id);
    const addGap = (code, reason) => gaps.push({ id: code + ':' + item.inventory_id, kind: 'not_displayed', owner: 'Plan04/08', reason, impact: 'The source visual remains in the required reading denominator.' });
    if (!unit) {
      addGap('P221_VISUAL_CONTEXT_MISSING', 'Original number/title, complete caption/header/legend/footnotes, supported explanation and explicit related-content routes have not been mapped.');
      continue;
    }
    const literal = ref => {
      const block = blocks.find(row => row.source_block_id === ref?.source_block_id);
      if (!block || !item.source_block_ids.includes(block.source_block_id) || !Number.isInteger(ref.start) || !Number.isInteger(ref.end)
        || ref.start < 0 || ref.end <= ref.start || ref.end > block.text.length || block.text.slice(ref.start, ref.end) !== ref.text) fail('P221_VISUAL_LITERAL_UNBOUND', { inventory_id: item.inventory_id });
      return safe(ref.text);
    };
    const sourcePages = Object.hasOwn(unit, 'source_page_groups');
    if (sourcePages && (!Array.isArray(unit.source_page_groups) || !unit.source_page_groups.length
      || unit.source_page_groups.some(group => !Array.isArray(group?.asset_ids) || !group.asset_ids.length)
      || ['asset_id', 'asset_ids', 'table_grid'].some(key => Object.hasOwn(unit, key)))) fail('P221_VISUAL_SOURCE_PAGES_INVALID');
    const isFormula = item.kind === 'essential_formula' && !sourcePages;
    if (!sourcePages && (!unit.number || !unit.title || !unit.caption || !unit.context)) { addGap('P221_VISUAL_CONTEXT_MISSING', 'Original visual number, title, caption or context mapping is absent.'); continue; }
    const number = sourcePages ? null : literal(unit.number), title = sourcePages ? null : literal(unit.title), caption = sourcePages ? null : literal(unit.caption);
    // Empty required context is not a successful absence; an exact source statement is required.
    const context = [];
    let contextMissing = false;
    for (const kind of (sourcePages ? [] : ['headers', 'legend', 'footnotes'])) {
      const part = unit.context[kind];
      if (!part || !['present', 'not_applicable'].includes(part.status) || (part.status === 'present' && !part.ranges?.length) || (part.status === 'not_applicable' && !part.reason)) { contextMissing = true; continue; }
      context.push(...(part.status === 'present' ? part.ranges.map(literal) : [literal(part.reason)]));
    }
    if (contextMissing) { addGap('P221_VISUAL_CONTEXT_MISSING', 'Required headers, legend or footnotes lack a source-bound disposition.'); continue; }
    const grid = Object.hasOwn(unit, 'table_grid') ? nativeTable(unit.table_grid, item, blocks, literal) : null;
    if (grid && (Object.hasOwn(unit, 'asset_id') || Object.hasOwn(unit, 'asset_ids'))) fail('P221_VISUAL_TABLE_GRID_INVALID');
    if (grid?.missing.length) addGap('P221_VISUAL_TABLE_CELL_MISSING', grid.missing.map(cell => 'R' + cell.row + 'C' + cell.column + ': ' + cell.reason).join('; '));
    const explicitGroup = Object.hasOwn(unit, 'asset_ids');
    if (explicitGroup && (unit.asset_id || !Array.isArray(unit.asset_ids) || !unit.asset_ids.length || new Set(unit.asset_ids).size !== unit.asset_ids.length)) fail('P221_VISUAL_ASSET_GROUP_INVALID');
    const assetIds = sourcePages ? unit.source_page_groups.flatMap(group => group.asset_ids) : explicitGroup ? unit.asset_ids : [unit.asset_id];
    const selectedAssets = assetIds.map(id => assets.assets.find(row => row.asset_id === id));
    const asset = selectedAssets[0];
    let visual;
    if (isFormula) {
      const ref = unit.equation, classification = input.source_presentation?.immutable_ranges.find(row => row.classification_id === ref?.classification_id);
      if (!classification || classification.kind !== 'formula' || classification.source_block_id !== ref?.source_block_id || classification.start !== ref.start || classification.end !== ref.end) fail('P221_VISUAL_FORMULA_UNBOUND');
      visual = '$$\n' + literal(ref) + '\n$$';
    } else if (!grid) {
      const disposition = assets.records.find(row => row.inventory_id === item.inventory_id);
      if (selectedAssets.some(asset => !asset || !item.source_block_ids.some(id => asset.source_block_ids.includes(id))) || disposition?.status !== 'available'
        || ((explicitGroup || sourcePages) && (JSON.stringify(disposition.asset_ids) !== JSON.stringify(assetIds)))
        || (sourcePages && (hash(disposition.source_page_groups) !== hash(unit.source_page_groups) || selectedAssets.some(asset => asset.derivation?.scope !== 'full_page')))) {
        addGap('P221_VISUAL_ASSET_MISSING', 'No admitted complete source image is available for this visual; derive/register the source-bound page within an authorized asset package.'); continue;
      }
      visual = '![[' + asset.target_path + ']]';
      if (selectedAssets.some(asset => !asset.derivation || !['full_page', 'crop'].includes(asset.derivation.scope))) addGap('P221_VISUAL_IMAGE_CONTEXT_UNVERIFIED',
        'Registered image bytes are preserved, but complete page/compound-panel/crop context has not been proven. Verify the complete source image in the authorized asset package.');
    }
    const sourceBlock = blocks[order], sourceDocument = science.source_package.source_documents.find(row => row.source_document_id === (grid ? unit.table_grid.source_document_id : sourceBlock.source_document_id));
    const sourceText = grid || sourcePages ? '' : `${label(sourceDocument.source_label)} · ${sourceBlock.page_index + 1}`;
    const languageBindings = [];
    for (const language of ['en', 'zh-CN']) {
      const rows = collectLanguageSpans(input.views[language]);
      const ids = unit.explanation_spans?.[language] ?? [];
      const explanations = ids.map(id => rows.find(row => row.span.span_id === id));
      if (!ids.length || explanations.some(row => !row || ['asset', 'formula', 'code', 'quote'].includes(row.span.kind)
        || !row.span.semantic_refs.some(ref => ref === item.inventory_id || item.affected_ids.includes(ref)))) {
        addGap('P221_VISUAL_EXPLANATION_MISSING', 'A source-linked visible explanation is missing in ' + language + '; shared evidence does not establish a visual relationship.'); continue;
      }
      const relationIds = unit.related_ids ?? [];
      if (relationIds.some(id => !item.affected_ids.includes(id))) fail('P221_VISUAL_RELATION_UNBOUND');
      const related = relationIds.map(id => ({ id, rows: rows.filter(row => row.span.semantic_refs.includes(id)) }));
      if (!related.length || related.some(row => row.rows.length !== 1)) {
        addGap('P221_VISUAL_RELATION_MISSING', 'No unique explicit related-content paragraph exists; a shared source/evidence reference cannot substitute.'); continue;
      }
      const entry = anchor('v', item.inventory_id), path = targetRegistry.paper_targets[language];
      const evidence = [...new Set(explanations.flatMap(row => row.span.evidence_refs))].filter(id => input.core.evidence.some(row => row.evidence_id === id));
      if (!evidence.length) { addGap('P221_VISUAL_EVIDENCE_MISSING', 'The visual explanation has no registered evidence route.'); continue; }
      const zh = language === 'zh-CN';
      const links = related.map(row => link('#^' + anchor('p', row.rows[0].span.span_id), (zh ? '关联内容：' : 'Related discussion: ') + label(row.rows[0].span.text)));
      const sourceLinks = evidence.map(id => link('#^' + anchor('e', id), (zh ? '来源片段 ' : 'Source passage ') + (input.core.evidence.findIndex(row => row.evidence_id === id) + 1)));
      const relocated_span_ids = [], relocated_displays = {};
      let displayedVisual;
      if (isFormula) {
        const sourceSpan = rows.find(row => row.span.kind === 'formula' && row.span.immutable_ref?.classification_id === unit.equation.classification_id);
        if (sourceSpan && !relocated[language].has(sourceSpan.span.span_id)) relocated_span_ids.push(sourceSpan.span.span_id);
        displayedVisual = visual + (relocated_span_ids.length ? '\n\n^' + anchor('p', sourceSpan.span.span_id) : '');
      } else if (grid) {
        displayedVisual = grid.render(zh);
      } else {
        displayedVisual = selectedAssets.map(pageAsset => {
          const spans = rows.filter(row => row.span.kind === 'asset' && row.span.immutable_ref?.id === pageAsset.asset_id && !relocated[language].has(row.span.span_id));
          const embed = '![[' + pageAsset.target_path + ']]';
          let display = embed;
          for (const [index, row] of spans.entries()) {
            const payload = index === 0 ? embed : link(pageAsset.target_path, zh ? '打开原尺寸图像' : 'Open full-size image');
            relocated_span_ids.push(row.span.span_id); relocated_displays[row.span.span_id] = payload;
            if (index === 0) display += ' ^' + anchor('p', row.span.span_id);
            else display += '\n\n' + payload + ' ^' + anchor('p', row.span.span_id);
          }
          if (explicitGroup || sourcePages) {
            const physicalPage = pageAsset.source_locations[0].physical_page;
            const pageDocument = sourcePages ? science.source_package.source_documents.find(row => row.source_document_id === pageAsset.source_document_id) : null;
            display += '\n\n' + (pageDocument ? label(pageDocument.source_label) + ' · ' : '') + (zh ? '物理页：' : 'Physical page: ') + physicalPage + ' · ' + link(pageAsset.target_path, zh ? '打开原尺寸图像' : 'Open full-size image');
          }
          if (sourcePages) {
            const groupIndex = unit.source_page_groups.findIndex(group => group.asset_ids.includes(pageAsset.asset_id));
            if (unit.source_page_groups[groupIndex].asset_ids[0] === pageAsset.asset_id) display = '#### ' + (zh ? '原页组 ' : 'Original page group ') + (groupIndex + 1) + '\n\n' + display;
          }
          return display;
        }).join('\n\n');
      }
      for (const id of relocated_span_ids) relocated[language].add(id);
      const sourceDescription = grid ? `${label(sourceDocument.source_label)} · ${zh ? '工作表：' : 'Sheet: '}${label(grid.location.sheet.name)} (${grid.location.sheet.index}) · R${grid.location.range.start_row}C${grid.location.range.start_column}:R${grid.location.range.end_row}C${grid.location.range.end_column}` : sourceText;
      const heading = sourcePages ? (zh ? '既有完整原页' : 'Original source pages') : label(number) + ' — ' + label(title);
      const visualLabel = sourcePages ? heading : label(number);
      const captionText = sourcePages ? (zh ? '这是相关既有完整原页的集合，可能包含不同图表；图题、表头、图例及脚注保留在原页图像中，此处未作文字转录。' : 'This collection contains the related existing full original pages and may include separate visuals. Captions, headers, legends and footnotes remain in the page images and are not transcribed here.') : caption;
      const text = `### ${heading}\n\n${visualLabel} ^${entry}\n\n${displayedVisual}\n\n${captionText}\n\n${context.join('\n\n')}\n\n${explanations.map(row => safe(row.span.text)).join('\n\n')}\n\n${links.join(' · ')}\n\n${sourceLinks.join(' · ')}\n\n${sourcePages ? (zh ? '每页来源与物理页已分别标明。' : 'Each original page is individually identified above.') : grid ? (zh ? '来源与原生单元格：' : 'Source and native cells: ') : (zh ? '来源与物理页：' : 'Source and physical page: ')}${sourceDescription}${!grid && !sourcePages && unit.printed_page ? ' · ' + literal(unit.printed_page) : (!grid && !sourcePages ? (zh ? '；印刷页未登记' : '; printed page not recorded') : '')}\n\n${asset && !explicitGroup && !sourcePages ? link(asset.target_path, zh ? '打开原尺寸图像' : 'Open full-size image') + '\n\n' : ''}${link('#^' + anchor('p', explanations[0].span.span_id), zh ? '返回正文解释' : 'Return to the explanation')}\n\n`;
      fragments[language].push({ inventory_id: item.inventory_id, anchor: entry, text, relocated_span_ids, relocated_displays });
      navigation.push({ language, kind: 'semantic', semantic_id: item.inventory_id, target: path + '#^' + entry, label: heading });
      languageBindings.push({ language, explanation_spans: ids, related_ids: relationIds, evidence_ids: evidence });
    }
    bindings.push({ inventory_id: item.inventory_id, source_order: order, mapping: unit, languages: languageBindings });
  }
  return { fragments, navigation, gaps, bindings, input_fingerprint: hash(units) };
}

/** Check the actual complete Markdown graph at its declared vault root, not file existence alone. */
export function validateReaderTargetGraph({ files }) {
  const byPath = new Map(files.map(row => [row.path, Buffer.from(row.bytes)])), routes = [], errors = [];
  for (const [path, bytes] of byPath) {
    if (!path.endsWith('.md')) continue;
    const text = bytes.toString('utf8').replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\s*$/gm, '');
    for (const match of text.matchAll(/!?\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g)) {
      const [file, section] = match[1].split('#'), targetPath = file || path;
      const target = byPath.get(targetPath) ?? byPath.get(targetPath + '.md');
      let valid = !!target && !targetPath.startsWith('.') && !targetPath.includes('..');
      if (valid && section) {
        const targetText = target.toString('utf8');
        valid = section.startsWith('^') ? targetText.split(/\r?\n/).some(line => line.trimEnd().endsWith(section))
          : targetText.split(/\r?\n/).some(line => line.replace(/^#{1,6}\s+/, '') === section && /^#{1,6}\s/.test(line));
      }
      const route = { from: path, target: match[1], label: match[2] ?? '', valid };
      routes.push(route); if (!valid) errors.push(route);
    }
  }
  return { ok: errors.length === 0, routes, errors, native_observation: 'not_run' };
}
