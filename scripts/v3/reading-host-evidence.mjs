import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
const text = value => typeof value === 'string' && !!value.trim();
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = () => { throw Object.assign(new Error('HOST_RECEIPT_EVIDENCE_INVALID'), { code:'HOST_RECEIPT_EVIDENCE_INVALID' }); };
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export function validateHostReceiptEvidence(receipt, { strict = false } = {}) {
  if (!strict) return receipt;
  if (!receipt || ![undefined,'observed','outcome_unknown'].includes(receipt.status) || typeof receipt.raw_result_text !== 'string') fail();
  if (receipt.status === 'outcome_unknown' && !receipt.evidence) return receipt;
  const evidence = receipt.evidence;
  if ((!text(receipt.raw_result_text) && receipt.status !== 'outcome_unknown') || !evidence || typeof evidence !== 'object') fail();
  if (evidence.kind === 'raw') {
    if (evidence.capture !== 'direct' || !digest(evidence.sha256) || evidence.sha256 !== hash(Buffer.from(receipt.raw_result_text,'utf8'))) fail();
    if (!text(evidence.source_reference) || !isAbsolute(evidence.source_reference)) fail();
    let bytes; try { bytes = readFileSync(evidence.source_reference); } catch { fail(); }
    if (hash(bytes) !== evidence.sha256) fail();
  } else if (evidence.kind === 'transcribed') {
    if (!text(evidence.source_reference) || !isAbsolute(evidence.source_reference) || !digest(evidence.source_sha256)) fail();
    let bytes; try { bytes = readFileSync(evidence.source_reference); } catch { fail(); }
    if (hash(bytes) !== evidence.source_sha256) fail();
  } else fail();
  return receipt;
}
export function normalizeHostReceipt(receipt, { strict = false } = {}) {
  const result = structuredClone(receipt);
  if (strict && (!text(result.raw_result_text) || !result.evidence)) result.status = 'outcome_unknown';
  validateHostReceiptEvidence(result, { strict });
  return result;
}
export function capturedHostEvidence(rawResultText) {
  if (typeof rawResultText !== 'string') fail();
  return { kind:'raw', capture:'direct', sha256:hash(Buffer.from(rawResultText,'utf8')) };
}
