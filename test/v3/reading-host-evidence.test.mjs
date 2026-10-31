import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateHostReceiptEvidence, normalizeHostReceipt, capturedHostEvidence } from '../../scripts/v3/reading-host-evidence.mjs';
import { usesExecutionLedger, validateExecutionLedger } from '../../scripts/v3/reading-execution-budget.mjs';
const hash = s => createHash('sha256').update(s).digest('hex');
test('strict evidence distinguishes captured and transcribed results', () => {
  const source = join(mkdtempSync(join(tmpdir(),'host-evidence-')), 'source.txt');
  writeFileSync(source, 'result');
  const raw = { status:'observed', raw_result_text:'result', evidence:{kind:'raw',capture:'direct',sha256:hash('result'),source_reference:source} };
  assert.deepEqual(validateHostReceiptEvidence(raw,{strict:true}),raw);
  assert.throws(()=>validateHostReceiptEvidence({...raw,evidence:{kind:'raw',capture:'direct',sha256:hash('result')}},{strict:true}));
  validateHostReceiptEvidence({...raw,status:undefined},{strict:true});
  assert.throws(()=>validateHostReceiptEvidence({...raw,raw_result_text:'  '},{strict:true}));
  assert.throws(()=>validateHostReceiptEvidence({...raw,evidence:{kind:'raw',capture:'direct',sha256:hash('other')}},{strict:true}));
  assert.throws(()=>validateHostReceiptEvidence({...raw,evidence:{kind:'transcribed'}},{strict:true}));
  writeFileSync(source, 'source');
  validateHostReceiptEvidence({...raw,evidence:{kind:'transcribed',source_reference:source,source_sha256:hash('source')}},{strict:true});
  assert.throws(()=>validateHostReceiptEvidence({...raw,evidence:{kind:'transcribed',source_reference:source,source_sha256:hash('wrong')}},{strict:true}));
  assert.equal(normalizeHostReceipt({status:'observed',raw_result_text:''},{strict:true}).status,'outcome_unknown');
  assert.equal(normalizeHostReceipt({raw_result_text:'unverified'},{strict:true}).status,'outcome_unknown');
  assert.equal(usesExecutionLedger({configured_setup:{instruction_profile:'configured-reading-2.2'}}),true);
});
test('empty captured return remains unknown while preserving its actual source', () => {
  const source=join(mkdtempSync(join(tmpdir(),'host-empty-')),'result.txt'); writeFileSync(source,'');
  const receipt=normalizeHostReceipt({status:'observed',raw_result_text:'',evidence:{...capturedHostEvidence(''),source_reference:source}},{strict:true});
  assert.equal(receipt.status,'outcome_unknown');
  assert.equal(receipt.evidence.source_reference,source);
  validateHostReceiptEvidence(receipt,{strict:true});
  writeFileSync(source,'changed');
  assert.throws(()=>validateHostReceiptEvidence(receipt,{strict:true}));
});
test('strict ledger does not accept unknown as an observed execution', () => {
  const row={execution_id:'one',task_id:'task',action_id:'action',tool:'tool',kind:'initial',handle:null,arguments:{},status:'observed',receipt:{status:'outcome_unknown',raw_result_text:''}};
  assert.throws(()=>validateExecutionLedger([row],1,{strict:true}));
});
