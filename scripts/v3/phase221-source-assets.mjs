import { createHash } from 'node:crypto';
import { fingerprintV3Json as hash } from './semantic-package-validator.mjs';

const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const fail = (code, details = {}) => { throw Object.assign(new Error(code), { code, details }); };
const text = value => typeof value === 'string' && value.trim().length > 0;
const digest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
const sameList = (left, right) => Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every(id => right.includes(id));
function location(row) {
  const loc = row.locator ?? row.native_locator ?? row;
  return { source_block_id: row.source_block_id ?? loc.source_block_id, source_document_id: loc.source_document_id ?? loc.document_id,
    source_hash: loc.source_hash ?? row.source_hash,
    physical_page: Number.isSafeInteger(loc.page_index) && loc.page_index >= 0 ? loc.page_index + 1 : loc.physical_page ?? loc.page_number ?? null,
    printed_page: loc.printed_page ?? null, region: loc.region ?? null };
}
function imageMatches(bytes, type) {
  return type === 'image/png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    : type === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : type === 'image/webp' ? bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' : false;
}
function assetRecord(asset) {
  const ref = asset.source_ref;
  if (!text(asset.asset_id) || !text(asset.artifact_id) || asset.origin !== 'registered_source_asset'
    || !Buffer.isBuffer(asset.bytes) || !asset.bytes.length || sha(asset.bytes) !== asset.byte_sha256 || asset.bytes.length !== asset.byte_length
    || !imageMatches(asset.bytes, asset.media_type)) fail('P221_ASSET_BYTES_OR_REGISTRATION_INVALID');
  if (!text(asset.target_path) || !asset.target_path.startsWith('Figures/') || /[\\\r\n\[\]#|]|(?:^|\/)\.\.?(?:\/|$)/.test(asset.target_path)) fail('P221_ASSET_TARGET_INVALID');
  if (!ref || ref.source_document_id !== asset.source_document_id || ref.source_hash !== asset.source_hash || !digest(asset.source_hash)
    || !Array.isArray(asset.source_block_ids) || !asset.source_block_ids.length || new Set(asset.source_block_ids).size !== asset.source_block_ids.length
    || !sameList(asset.source_block_ids, ref.source_block_ids) || !sameList(asset.evidence_ids, ref.evidence_ids)
    || !Array.isArray(ref.locators)) fail('P221_ASSET_SOURCE_INVALID');
  const locations = ref.locators.map(location);
  if (locations.length !== asset.source_block_ids.length || locations.some(loc => !asset.source_block_ids.includes(loc.source_block_id)
    || loc.source_document_id !== asset.source_document_id || loc.source_hash !== asset.source_hash
    || !Number.isSafeInteger(loc.physical_page) || loc.physical_page < 1)
    || new Set(locations.map(loc => loc.source_block_id)).size !== locations.length) fail('P221_ASSET_LOCATION_INVALID');
  return { ...asset, bytes: Buffer.from(asset.bytes), source_locations: locations };
}
function derivedRecord(asset, record) {
  const { registration, ...provenance } = record;
  if (!asset.qualification_reason?.includes('reader-derivation:' + hash(provenance))) fail('P221_ASSET_DERIVATION_NOT_REGISTERED');
  if (record.source_document_id !== asset.source_document_id || record.source_hash !== asset.source_hash
    || !asset.source_locations.every(loc => loc.physical_page === record.physical_page)
    || record.image_sha256 !== asset.byte_sha256 || record.registration?.artifact_id !== asset.artifact_id
    || record.registration?.sha256 !== asset.byte_sha256 || record.registration?.byte_length !== asset.byte_length
    || !text(record.approval_ref) || !text(record.rendering_tool?.name) || !text(record.rendering_tool?.version)
    || !record.rendering_tool.options || typeof record.rendering_tool.options !== 'object' || Array.isArray(record.rendering_tool.options)
    || !['full_page', 'crop'].includes(record.scope) || !text(record.region)
    || !Object.hasOwn(record, 'printed_page')) fail('P221_ASSET_DERIVATION_INVALID');
  if (record.scope === 'full_page' && record.region !== 'full_page') fail('P221_ASSET_DERIVATION_CONTEXT_INVALID');
  if (record.scope === 'crop' && !['caption', 'headers', 'footnotes'].every(key => {
    const bound = record.context_bounds?.[key];
    return Array.isArray(bound) && bound.length === 2 && bound.every(Number.isFinite) && bound[0] >= 0 && bound[1] > bound[0];
  })) fail('P221_ASSET_DERIVATION_CONTEXT_INVALID');
  return structuredClone(record);
}

/** Pure adapter, not a registration or authentication boundary. registeredAssets must
 * come from the parent's current/historical capability read, never caller metadata.
 * Derivation records only constrain already registered bytes; approval_ref retains
 * an upstream controlled decision reference and cannot grant authority by itself.
 * No supplied path is opened, no source is rendered, and no acceptance is promoted.
 */
export function resolveReaderSourceAssets({ registeredAssets, requestedInventory, derivationRecords = [] } = {}) {
  if (![registeredAssets, requestedInventory, derivationRecords].every(Array.isArray)) fail('P221_ASSET_INPUT_REQUIRED');
  const assets = new Map(), derived = new Map();
  for (const asset of registeredAssets) {
    if (assets.has(asset.asset_id)) fail('P221_ASSET_DUPLICATE');
    assets.set(asset.asset_id, assetRecord(asset));
  }
  for (const record of derivationRecords) {
    // Unregistered derivations are evidence of pending work, never new assets.
    if (!assets.has(record?.asset_id)) continue;
    if (derived.has(record.asset_id)) fail('P221_ASSET_DERIVATION_DUPLICATE');
    derived.set(record.asset_id, derivedRecord(assets.get(record.asset_id), record));
  }
  const records = [], gaps = [], admitted = new Map(), inventoryIds = new Set();
  for (const row of requestedInventory) {
    const inventory_id = row.inventory_id ?? row.id;
    if (!text(inventory_id) || inventoryIds.has(inventory_id)) fail('P221_ASSET_INVENTORY_ID_INVALID');
    inventoryIds.add(inventory_id);
    const availability = row.availability ?? 'not_assessable';
    if (!['available', 'available_not_derived', 'source_unavailable', 'unavailable', 'not_assessable', 'not_applicable'].includes(availability)) fail('P221_ASSET_AVAILABILITY_INVALID');
    const reason = row.reason ?? row.applicability?.reason;
    if (availability === 'not_applicable') {
      if (!text(reason)) fail('P221_ASSET_REASON_REQUIRED');
      records.push({ inventory_id, status: 'not_applicable', asset_ids: [], reason }); continue;
    }
    if (['source_unavailable', 'unavailable'].includes(availability)) {
      const entry = { inventory_id, status: 'partial', asset_ids: [], reason: reason ?? 'The supplied source is unavailable.', code: 'P221_ASSET_SOURCE_UNAVAILABLE' };
      records.push(entry); gaps.push({ ...entry, action: 'Retain the source limitation for the authorized reading review.' }); continue;
    }
    const requested = (row.source_locations ?? []).map(location);
    if (Object.hasOwn(row, 'source_page_groups')) {
      const groups = row.source_page_groups;
      if (!Array.isArray(groups) || !groups.length || Object.hasOwn(row, 'asset_ids') || row.asset_refs) fail('P221_ASSET_PAGE_GROUPS_INVALID', { inventory_id });
      const groupIds = new Set(), assetIds = new Set(), sourcePages = new Set(), selected = [];
      let missingAsset = false;
      for (const group of groups) {
        if (!group || !text(group.group_id) || groupIds.has(group.group_id) || !Array.isArray(group.asset_ids) || !group.asset_ids.length) fail('P221_ASSET_PAGE_GROUPS_INVALID', { inventory_id });
        groupIds.add(group.group_id);
        let first, previousPage = 0;
        for (const id of group.asset_ids) {
          if (!text(id) || assetIds.has(id)) fail('P221_ASSET_PAGE_GROUPS_INVALID', { inventory_id });
          assetIds.add(id);
          const asset = assets.get(id);
          if (!asset) { missingAsset = true; continue; }
          first ??= asset;
          const pages = [...new Set(asset.source_locations.map(loc => loc.physical_page))], page = pages[0];
          if (asset.source_document_id !== first.source_document_id || asset.source_hash !== first.source_hash || pages.length !== 1 || page <= previousPage) fail('P221_ASSET_GROUP_ORDER_OR_SOURCE_INVALID', { inventory_id });
          previousPage = page;
          const pageKey = hash({ source_document_id: asset.source_document_id, source_hash: asset.source_hash, physical_page: page });
          if (sourcePages.has(pageKey)) fail('P221_ASSET_PAGE_GROUPS_INVALID', { inventory_id });
          sourcePages.add(pageKey);
          if (!requested.some(wanted => asset.source_locations.some(actual => actual.source_block_id === wanted.source_block_id
            && actual.source_document_id === wanted.source_document_id && actual.source_hash === wanted.source_hash && actual.physical_page === wanted.physical_page))) fail('P221_ASSET_REQUEST_SOURCE_MISMATCH', { inventory_id });
          selected.push(asset);
        }
      }
      const complete = !missingAsset && requested.length && Array.isArray(row.source_block_ids) && row.source_block_ids.length
        && row.source_block_ids.every(id => selected.some(asset => asset.source_block_ids.includes(id)))
        && (row.evidence_ids ?? []).every(id => selected.some(asset => asset.evidence_ids.includes(id)))
        && requested.every(wanted => selected.some(asset => asset.source_locations.some(actual => actual.source_block_id === wanted.source_block_id
          && actual.source_document_id === wanted.source_document_id && actual.source_hash === wanted.source_hash && actual.physical_page === wanted.physical_page)));
      const fullPages = selected.length && selected.every(asset => derived.get(asset.asset_id)?.scope === 'full_page');
      if (!complete || !fullPages) {
        const entry = { inventory_id, status: 'blocked', asset_ids: [], code: complete ? 'P221_ASSET_FULL_PAGE_REQUIRED' : 'P221_ASSET_REGISTRATION_REQUIRED',
          reason: complete ? 'Every source-page image requires its existing registered full-page provenance.' : 'The registered source-page collection does not cover every required source location and evidence reference.' };
        records.push(entry); gaps.push({ ...entry, action: 'Retain the named gap; use only existing controlled complete-page assets and their source-bound provenance.' }); continue;
      }
      for (const asset of selected) admitted.set(asset.asset_id, { ...asset, derivation: derived.get(asset.asset_id),
        inventory_ids: [...new Set([...(admitted.get(asset.asset_id)?.inventory_ids ?? []), inventory_id])] });
      records.push({ inventory_id, status: 'available', asset_ids: [...assetIds], source_page_groups: structuredClone(groups) });
      continue;
    }
    const explicit = Object.hasOwn(row, 'asset_ids');
    if (explicit && (!Array.isArray(row.asset_ids) || !row.asset_ids.length || row.asset_ids.some(id => !text(id))
      || new Set(row.asset_ids).size !== row.asset_ids.length || row.asset_refs)) fail('P221_ASSET_GROUP_INVALID', { inventory_id });
    let grouped = [];
    if (explicit) {
      grouped = row.asset_ids.map(id => assets.get(id));
      const present = grouped.filter(Boolean);
      let previousPage = 0;
      for (const asset of present) {
        const pages = [...new Set(asset.source_locations.map(loc => loc.physical_page))];
        if (asset.source_document_id !== present[0].source_document_id || asset.source_hash !== present[0].source_hash
          || pages.length !== 1 || pages[0] <= previousPage) fail('P221_ASSET_GROUP_ORDER_OR_SOURCE_INVALID', { inventory_id });
        previousPage = pages[0];
        if (!requested.some(wanted => asset.source_locations.some(actual => actual.source_block_id === wanted.source_block_id
          && actual.source_document_id === wanted.source_document_id && actual.source_hash === wanted.source_hash && actual.physical_page === wanted.physical_page))) {
          fail('P221_ASSET_REQUEST_SOURCE_MISMATCH', { inventory_id });
        }
      }
      const complete = present.length === grouped.length && requested.length && Array.isArray(row.source_block_ids) && row.source_block_ids.length
        && row.source_block_ids.every(id => present.some(asset => asset.source_block_ids.includes(id)))
        && (row.evidence_ids ?? []).every(id => present.some(asset => asset.evidence_ids.includes(id)))
        && requested.every(wanted => present.some(asset => asset.source_locations.some(actual => actual.source_block_id === wanted.source_block_id
          && actual.source_document_id === wanted.source_document_id && actual.source_hash === wanted.source_hash && actual.physical_page === wanted.physical_page)));
      if (!complete) grouped = [];
    }
    const candidates = [...assets.values()].filter(asset => (!row.asset_refs || row.asset_refs.includes(asset.asset_id))
      && Array.isArray(row.source_block_ids) && row.source_block_ids.length && row.source_block_ids.every(id => asset.source_block_ids.includes(id))
      && (!row.evidence_ids?.length || row.evidence_ids.every(id => asset.evidence_ids.includes(id))));
    const matching = explicit ? grouped : candidates.filter(asset => requested.length && requested.every(wanted => asset.source_locations.some(actual => actual.source_block_id === wanted.source_block_id
      && actual.source_document_id === wanted.source_document_id && actual.source_hash === wanted.source_hash && actual.physical_page === wanted.physical_page)));
    if (!explicit && candidates.length && !matching.length && requested.length) fail('P221_ASSET_REQUEST_SOURCE_MISMATCH', { inventory_id });
    const selected = matching.filter(asset => {
      const derivation = derived.get(asset.asset_id), region = derivation?.region ?? asset.source_ref.region;
      return !row.region || region === row.region || derivation?.scope === 'full_page';
    });
    if (!selected.length || (explicit && selected.length !== row.asset_ids.length)) {
      const entry = { inventory_id, status: 'blocked', asset_ids: [], code: matching.length ? 'P221_ASSET_REGION_UNPROVEN' : 'P221_ASSET_REGISTRATION_REQUIRED',
        reason: matching.length ? 'Requested crop region is not proven by the registered asset.' : 'No registered image bytes match the required source location.' };
      records.push(entry); gaps.push({ ...entry, action: matching.length ? 'Use a registered full source page or obtain approved complete crop provenance.' : 'Under the separately authorized asset package, register the existing source image or approved same-source derivation through the existing controlled presentation store.' }); continue;
    }
    for (const asset of selected) admitted.set(asset.asset_id, { ...asset, inventory_ids: [...new Set([...(admitted.get(asset.asset_id)?.inventory_ids ?? []), inventory_id])],
      ...(derived.has(asset.asset_id) ? { derivation: derived.get(asset.asset_id) } : {}) });
    const first = selected[0], derivation = derived.get(first.asset_id);
    records.push({ inventory_id, status: 'available', asset_ids: selected.map(asset => asset.asset_id), source_document_id: first.source_document_id,
      source_hash: first.source_hash, physical_page: requested[0].physical_page, printed_page: derivation?.printed_page ?? requested[0].printed_page,
      region: derivation?.region ?? first.source_ref.region ?? requested[0].region });
  }
  return { assets: [...admitted.values()], records, gaps, status: records.some(row => row.status === 'blocked') ? 'blocked' : records.some(row => row.status === 'partial') ? 'partial' : 'ready',
    visual_acceptance: 'not_run', scientific_acceptance: 'not_assessed' };
}

