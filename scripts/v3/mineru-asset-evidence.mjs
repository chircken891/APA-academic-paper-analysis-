import { createHash } from 'node:crypto';

const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const canonical = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
};
const fail = reason => { throw new Error('Saved MinerU asset evidence: ' + reason); };
const bytesOf = value => {
  if (!(Buffer.isBuffer(value) || value instanceof Uint8Array)) fail('independently supplied binary bytes required');
  return Buffer.from(value);
};
const jsonOf = bytes => {
  try { return JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')); }
  catch { fail('invalid saved JSON bytes'); }
};
const relativePath = value => {
  if (typeof value !== 'string' || !value || /[\\:\u0000]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) fail('invalid relative inventory path');
  return value;
};
const bboxOf = value => Array.isArray(value) && value.length === 4 && value.every(Number.isFinite) && value[0] <= value[2] && value[1] <= value[3];

/** Verifies supplied saved bytes only. No file access, parser calls or scientific interpretation. */
export function verifySavedMineruAssetEvidence({ evidence, sources, rawPayloads, entriesByDocument }) {
  if (!Array.isArray(evidence)) fail('evidence array required');
  const resolved = new Map(), proofs = [], seen = new Set();
  for (const item of evidence) {
    const source = sources.find(value => value.document_id === item?.document_id);
    const payload = rawPayloads.find(value => value.document_id === item?.document_id);
    if (!source || !payload || seen.has(item.document_id)) fail('undeclared or duplicate evidence document');
    seen.add(item.document_id);
    const packetBytes = bytesOf(item.packetBytes), observationBytes = bytesOf(item.observationBytes);
    const packet = jsonOf(packetBytes), observation = jsonOf(observationBytes);
    const sourceBytes = typeof source.bytes === 'string' ? Buffer.from(source.bytes) : bytesOf(source.bytes);
    if (!packet.run_id || packet.run_id !== observation.run_id || !packet.allowed_output_root || packet.allowed_output_root !== observation.output_path || packet.source?.sha256 !== hash(sourceBytes) || packet.source?.byte_length !== sourceBytes.length || packet.backend?.identity !== observation.port || !packet.backend?.version || packet.backend.version !== observation.parser_version) fail('source or same-run observation binding mismatch');
    if (!Array.isArray(observation.output_inventory) || !Array.isArray(item.crops)) fail('inventory and crop arrays required');
    const inventory = new Map();
    for (const file of observation.output_inventory) {
      const path = relativePath(file.path);
      if (inventory.has(path)) fail('duplicate inventory path');
      inventory.set(path, file);
    }
    const verifyFile = file => {
      const path = relativePath(file?.path), bytes = bytesOf(file?.bytes), expected = inventory.get(path);
      const sha256 = hash(bytes);
      if (!expected || expected.sha256 !== sha256 || expected.byte_length !== bytes.length) fail('saved file hash or length mismatch: ' + path);
      return { path, sha256, byte_length: bytes.length, bytes };
    };
    const raw = verifyFile(item.raw);
    if (!raw.path.endsWith('/input_content_list.json') || canonical(jsonOf(raw.bytes)) !== canonical(payload.content)) fail('raw payload differs from saved content list');
    const directory = raw.path.slice(0, raw.path.lastIndexOf('/') + 1);
    const middleFile = item.middle ? verifyFile(item.middle) : null;
    if (middleFile && middleFile.path !== directory + 'input_middle.json') fail('middle file not in same parser output');
    const middle = middleFile ? jsonOf(middleFile.bytes) : null;
    const crops = new Map();
    for (const file of item.crops) {
      const crop = verifyFile(file);
      if (crops.has(crop.path) || !crop.path.startsWith(directory + 'images/')) fail('duplicate or unrelated crop path');
      crops.set(crop.path, crop);
    }
    const bindings = [];
    for (const entry of entriesByDocument.get(item.document_id)) {
      if (!['image', 'chart', 'table'].includes(entry.type)) continue;
      let imagePath = null, mapping = null;
      if (typeof entry.img_path === 'string' && entry.img_path) {
        imagePath = relativePath(entry.img_path);
        mapping = { kind: 'raw_img_path' };
      } else if (entry.type === 'table' && middle && Number.isInteger(entry.page_idx) && entry.page_idx >= 0 && bboxOf(entry.bbox)) {
        const page = middle.pdf_info?.[entry.page_idx];
        if (!page || (page.page_idx !== undefined && page.page_idx !== entry.page_idx) || !Array.isArray(page.page_size) || page.page_size.length !== 2 || !page.page_size.every(axis => Number.isFinite(axis) && axis > 0)) continue;
        const bbox = entry.bbox.map((coordinate, index) => Math.ceil(coordinate * page.page_size[index % 2] / 1000));
        const matches = (page.preproc_blocks ?? []).map((block, index) => ({ block, index })).filter(({ block }) => block.type === 'table' && canonical(block.bbox) === canonical(bbox));
        if (matches.length !== 1) continue;
        const match = matches[0], spans = [];
        let body = match.block, pointer = `/pdf_info/${entry.page_idx}/preproc_blocks/${match.index}`;
        if (Array.isArray(match.block.blocks)) {
          const bodies = match.block.blocks.map((block, index) => ({ block, index })).filter(({ block }) => block.type === 'table_body');
          if (bodies.length !== 1 || (match.block.lines ?? []).some(line => (line.spans ?? []).some(span => span.image_path))) continue;
          body = bodies[0].block;
          pointer += `/blocks/${bodies[0].index}`;
        }
        for (const [lineIndex, line] of (body.lines ?? []).entries()) {
          for (const [spanIndex, span] of (line.spans ?? []).entries()) {
            if (typeof span.image_path === 'string' && span.image_path) spans.push({ image_path: span.image_path, pointer: `${pointer}/lines/${lineIndex}/spans/${spanIndex}/image_path` });
          }
        }
        if (spans.length !== 1) continue;
        imagePath = relativePath(spans[0].image_path);
        if (!imagePath.includes('/')) imagePath = 'images/' + imagePath;
        mapping = { kind: 'middle_table_bbox', raw_bbox: entry.bbox, page_size: page.page_size, middle_bbox: bbox, pointer: spans[0].pointer };
      }
      if (!imagePath || !imagePath.startsWith('images/')) continue;
      const crop = crops.get(directory + imagePath);
      if (!crop) continue;
      const binding = { document_id: item.document_id, source_sha256: packet.source.sha256, source_item_index: entry.source_item_index, path: crop.path, sha256: crop.sha256, byte_length: crop.byte_length, mapping };
      const assetId = item.document_id + ':saved-crop:' + hash(canonical(binding)).slice(7);
      resolved.set(item.document_id + ':' + entry.source_item_index, assetId);
      bindings.push(binding);
    }
    const identity = file => file ? { path: file.path, sha256: file.sha256, byte_length: file.byte_length } : null;
    proofs.push({ document_id: item.document_id, source_sha256: packet.source.sha256, packet_sha256: hash(packetBytes), observation_sha256: hash(observationBytes), raw: identity(raw), middle: identity(middleFile), crops: [...crops.values()].map(identity).sort((a, b) => a.path.localeCompare(b.path)), bindings });
  }
  return { resolved, fingerprint: hash(canonical(proofs.sort((a, b) => a.document_id.localeCompare(b.document_id)))) };
}
