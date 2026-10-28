import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const profile = 'role-reply-1.0';
const contractUrl = new URL('../../prompts/v3/role-reply-1.0.md', import.meta.url);
const fail = code => { throw Object.assign(new Error(code), { code }); };

function readContract() {
  let bytes;
  try { bytes = readFileSync(contractUrl); }
  catch { fail('APA_ROLE_REPLY_CONTRACT_CHANGED'); }
  return {
    metadata: { profile, sha256: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), byte_length: bytes.length },
    content: bytes.toString('utf8'),
  };
}

/** Select the immutable rule for a NEW configured binding, never on resume. */
export function getRoleReplyContract() {
  return Object.freeze(readContract().metadata);
}

/** An absent field preserves legacy requests without reading the new resource. */
export function loadRoleReplyContract(contract) {
  if (contract === undefined) return '';
  if (!contract || Object.keys(contract).sort().join() !== 'byte_length,profile,sha256'
    || contract.profile !== profile || !/^sha256:[a-f0-9]{64}$/.test(contract.sha256)
    || !Number.isInteger(contract.byte_length) || contract.byte_length <= 0) fail('APA_ROLE_REPLY_CONTRACT_INVALID');
  const current = readContract();
  if (current.metadata.sha256 !== contract.sha256 || current.metadata.byte_length !== contract.byte_length) fail('APA_ROLE_REPLY_CONTRACT_CHANGED');
  return current.content;
}
