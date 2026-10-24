import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalizeV3Json } from './semantic-package-validator.mjs';
import { buildOfficeSourceEvidenceReview, validateOfficeSavedConsumptionContext, requireOfficeRealPilotAuthority, validateOfficeRealPilotContext, readOfficeRealPilotParserEvidence, writeOfficeRealPilotArtifact, OFFICE_REAL_ROOT, OFFICE_REAL_METHOD } from './office-source-evidence.mjs';
import {OFFICE_REPRESENTATION_ROOT,OFFICE_REPRESENTATION_PROFILE,OFFICE_REPRESENTATION_METHOD,validateOfficeRepresentationContext,requireOfficeRepresentationAuthority,writeOfficeRepresentationArtifact,readOfficeRepresentationCache} from './office-source-evidence.mjs';
import {OFFICE_HTML_ROOT,OFFICE_HTML_PROFILE,OFFICE_HTML_METHOD,parseOfficeHtmlStructure,validateOfficeHtmlContext,readOfficeHtmlObservedStructure,writeOfficeHtmlArtifact,requireOfficeHtmlAuthority} from './office-source-evidence.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = 'Eval/apa-v3/phase21/office-original-comparison-r1';
const prepared = 'Eval/apa-v3/phase21/office-formal-ingress-scope-r1';
const saved = 'Eval/apa-v3/phase21/office-source-evidence-scope-r1';
const native = 'Eval/apa-v3/phase21/native-office-qualification-r1';
const hybridMethod = 'office-saved-mineru-source-metadata-hybrid-1.0';
const referenceMethod = { source_contact: ['historic_source_read', 'current_saved_record_review'], parser_output_access: 'used', verification: 'assisted',
  blinding: 'nonblind', independent_gold: false, shared_reader: true, shared_source_records_with_candidate: true };
export const OFFICE_CONTRACT = 'phase21-office-original-1.0';
const categories = ['text', 'table', 'formula', 'citation', 'figure', 'attachment', 'locator'];
const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const fingerprint = value => sha(Buffer.from(canonicalizeV3Json(value)));
const same = (a, b) => canonicalizeV3Json(a) === canonicalizeV3Json(b);
const json = async name => JSON.parse(await readFile(path.join(root, name), 'utf8'));
const save = async (name, value) => {
  await requireOfficeOriginalWriteAuthority();
  return writeFile(path.join(root, output, name), JSON.stringify(value, null, 2) + '\n');
};
const fail = code => { throw new Error(code); };
const clone = value => structuredClone(value);
const contextPaths = { manifestPath: path.join(root, output, 'METHOD.json'), authorizationRecordPath: path.join(root, output, 'AUTHORIZATION.json') };
const category = r => ['paragraph', 'footnote'].includes(r.kind) ? 'text' : ['table', 'row', 'cell', 'workbook_cell'].includes(r.kind) ? 'table' : 'locator';
const central = r => ['footnote', 'footnote_reference', 'layout_break', 'workbook_cell'].includes(r.kind) ? 'central' : 'noncentral';

export function deriveOfficeHtmlMapping({format,source,observed} = {}) {
  const tree=observed.tree;const rows=tree.rows;const checks=[];const check=(name,ok)=>checks.push({name,ok:!!ok});
  const records=source.records;const at=(r,c)=>records.find(x=>x.kind==='workbook_cell'&&x.row===r&&x.column===c);
  const cell=(r,c)=>rows[r-1]?.cells[c-1];
  check('unique complete grid without spans or missing paragraphs',!tree.unsupported&&rows.length===(format==='docx'?5:25)&&rows.every(r=>r.cells.length===(format==='docx'?2:3)&&r.cells.every(c=>c.paragraphs.length>0)));
  if(format==='docx') {
    const sourceCells=records.filter(r=>r.kind==='cell');
    check('source unique5x2 table',records.filter(r=>r.kind==='table').length===1&&records.filter(r=>r.kind==='row').length===5&&sourceCells.length===10);
    check('header and complete four feature row order',[1,2,3,4,5].every(r=>{
      const sourceCell=sourceCells.find(s=>s.locator.xml_path.endsWith(`/tr[${r}]/tc[1]`));
      const p=records.find(s=>s.kind==='paragraph'&&s.locator.xml_path===sourceCell?.locator.xml_path+'/p[1]');return cell(r,1)?.paragraphs[0]?.text===p?.text;
    })&&cell(1,2)?.text==='Description');
    check('all cell paragraph counts and nine sequence order',sourceCells.every(s=>{
      const m=/\/tr\[(\d+)\]\/tc\[(\d+)\]$/.exec(s.locator.xml_path);const c=cell(Number(m[1]),Number(m[2]));const ps=records.filter(p=>p.kind==='paragraph'&&p.locator.xml_path.startsWith(s.locator.xml_path+'/p['));
      return c?.paragraphs.length===ps.length&&(Number(m[1])!==5||Number(m[2])!==1||c.paragraphs.every((p,n)=>p.text===ps[n].text));
    }));
  } else {
    check('one exact original sheet and full coordinate range',records.length===75&&records.every((r,n)=>r.kind==='workbook_cell'&&r.sheet.index===0&&r.sheet.name==='Supplementary Table 9'&&r.row===Math.floor(n/3)+1&&r.column===n%3+1&&r.address===String.fromCharCode(65+n%3)+(Math.floor(n/3)+1)));
    check('title and all3 row3 headers',cell(1,1)?.text===at(1,1)?.text&&[1,2,3].every(c=>cell(3,c)?.text===at(3,c)?.text));
    check('all18 read length row labels and all3 statistics labels order',[...Array.from({length:18},(_,n)=>n+4),23,24,25].every(r=>cell(r,1)?.text===at(r,1)?.text));
    check('blank row positions and one paragraph per cell',[2,22].every(r=>[1,2,3].every(c=>cell(r,c)?.text===''))&&rows.every(r=>r.cells.every(c=>c.paragraphs.length===1))&&cell(1,2)?.text===''&&cell(1,3)?.text===''&&cell(24,3)?.text===''&&cell(25,3)?.text==='');
  }
  const ok=checks.every(c=>c.ok);const mappings=records.map(record=>{
    let node;let paragraphs=[];
    if(ok&&format==='xlsx'){node=cell(record.row,record.column);paragraphs=node.paragraphs;}
    if(ok&&format==='docx') {
      const m=/\/tbl\[1\](?:\/tr\[(\d+)\])?(?:\/tc\[(\d+)\])?(?:\/p\[(\d+)\])?$/.exec(record.locator.xml_path);
      if(m){node=m[3]?cell(Number(m[1]),Number(m[2])).paragraphs[Number(m[3])-1]:m[2]?cell(Number(m[1]),Number(m[2])):m[1]?rows[Number(m[1])-1]:{path:tree.table_path};paragraphs=node.paragraphs??(node.tag==='p'?[node]:[]);}
    }
    return {record_id:record.id,status:node?'mapped':'unmapped',source_locator:record.locator,html_node_path:node?.path??null,json_pointer:observed.json_pointer,
      output_sha256:observed.output_sha256,html_sha256:observed.html_sha256,observed_text:node&&typeof node.text==='string'?node.text:null,
      paragraph_paths:paragraphs.map(p=>p.path),paragraph_texts:paragraphs.map(p=>p.text),native_parser_coordinate_mapping:'unmapped',origin:'derived_source_mapping',framework_verified:ok};
  });
  return {format,ok,checks,mappings,structure_fingerprint:fingerprint(tree)};
}

const sealedR2Inputs={docx:'sha256:29d41f6477c7f925b546b25611a55ae0a0f33fa23cbd3b067a587d4fb9aadcc2',xlsx:'sha256:fbc15374bfef533a6a70bf38a2bebedc47051f456baa9028857470d8d03fc434'};
function makeHtmlCandidate(old,observed,mapping) {
  const run=clone(old);run.profile=OFFICE_HTML_PROFILE;run.method=OFFICE_HTML_METHOD;
  run.units=old.units.map(u=>{
    const map=mapping.mappings.find(m=>m.record_id===u.record_id);if(map?.status!=='mapped')return clone(u);
    return {...clone(u),mapping_status:'mapped',text:map.observed_text,parser_links:[{output_path:observed.output_path,output_sha256:observed.output_sha256,json_pointer:map.json_pointer,html_node_path:map.html_node_path,text:map.observed_text,physical_page:null,coordinate_mapping:'unmapped',origin:'parser_html_observed'}],derived_source_mapping:map};
  });
  return run;
}
export async function buildOfficeHtmlComparisonInputs({format,persist=false,replaceOwnedArtifacts=false} = {}) {
  if(!['docx','xlsx'].includes(format))fail('OFFICE_FORMAT_REQUIRED');
  if(persist)await requireOfficeHtmlAuthority();const context=await validateOfficeHtmlContext();if(!context.ok)fail(context.errors[0]);
  const oldBytes=await readFile(path.join(root,OFFICE_REPRESENTATION_ROOT,`COMPARISON-INPUTS-${format}.json`));if(sha(oldBytes)!==sealedR2Inputs[format])fail('OFFICE_HTML_OLD_INPUT_MISMATCH');
  const old=JSON.parse(oldBytes);const observed=await readOfficeHtmlObservedStructure(format);const source=old.candidateRun.construction_proof.source;
  const mapping=deriveOfficeHtmlMapping({format,source,observed});
  const reference=clone(old.referenceManifest);reference.profile=OFFICE_HTML_PROFILE;reference.derived_from={path:`${OFFICE_REPRESENTATION_ROOT}/REFERENCE-${format}.json`,reference_identity:old.referenceManifest.reference_identity};
  reference.current_consumption_method_identity=context.method_identity;reference.derivation_authorization_fingerprint=context.authorization_identity;
  delete reference.reference_identity;reference.reference_identity=fingerprint(reference);
  if(persist)await writeOfficeHtmlArtifact(`REFERENCE-${format}.json`,reference,{exclusive:!replaceOwnedArtifacts});
  const baseline=clone(old.baselineRun);baseline.profile=OFFICE_HTML_PROFILE;
  const candidate=makeHtmlCandidate(old.candidateRun,observed,mapping);
  const contentBytes=await readFile(path.join(root,observed.output_path),'utf8');const content=JSON.parse(contentBytes);
  const titles=content.map((b,n)=>({b,n})).filter(x=>typeof x.b.text==='string'&&x.n<observed.block_index);
  const sourceTitles=source.records.filter(r=>r.kind==='paragraph'&&/^\/document\[1\]\/body\[1\]\/p\[\d+\]$/.test(r.locator.xml_path)&&r.text);
  if(format==='docx'&&mapping.ok&&titles.length===1&&sourceTitles.length===1){const unit=candidate.units.find(u=>u.record_id===sourceTitles[0].id);unit.text=titles[0].b.text;unit.mapping_status='mapped';unit.parser_links=[{output_path:observed.output_path,output_sha256:observed.output_sha256,json_pointer:`/${titles[0].n}/text`,text:unit.text,physical_page:null,coordinate_mapping:'unmapped'}];unit.derived_source_mapping={record_id:unit.record_id,status:'mapped',origin:'derived_source_mapping',title_before_unique_bound_table:true,json_pointer:`/${titles[0].n}/text`,native_parser_coordinate_mapping:'unmapped'};}
  const proof={profile:OFFICE_HTML_PROFILE,old_input_bytes:oldBytes.toString('utf8'),old_input_sha256:sha(oldBytes),content_bytes:contentBytes,observed,mapping,method_identity:context.method_identity,method_manifest:context.manifest,authorization_identity:context.authorization_identity,code_bindings:context.manifest.bindings,reference_identity:reference.reference_identity};
  for(const run of [baseline,candidate]){run.html_construction_proof=clone(proof);run.html_construction_fingerprint=fingerprint(proof);run.run_identity=deriveOfficeOriginalRunIdentity(run);}
  return {baselineRun:baseline,candidateRun:candidate,referenceManifest:reference,comparisonPolicy:{location_contract:OFFICE_CONTRACT,method_identity:context.method_identity,reference_identity:reference.reference_identity},candidateDescriptor:{method:OFFICE_HTML_METHOD,independent_backend:false,scientific_eligible:false,method_identity:context.method_identity,authorization_fingerprint:context.authorization_identity}};
}

function compareHtmlRuns(input) {
  const failResult=errors=>({schema_version:'phase21-reference-comparison-office-original-1.0',reference_kind:'accepted_assisted_source_representation_pilot',scientific_eligible:false,independent_backend:false,status:'not_comparable',comparison_identity:null,errors});
  try {
    const {baselineRun:baseline,candidateRun:candidate,referenceManifest:reference}=input;const proof=candidate.html_construction_proof;
    if(!same(proof,baseline.html_construction_proof)||fingerprint(proof)!==candidate.html_construction_fingerprint||fingerprint(proof)!==baseline.html_construction_fingerprint||sha(Buffer.from(proof.old_input_bytes))!==sealedR2Inputs[candidate.format])return failResult(['OFFICE_HTML_PROOF_MISMATCH']);
    if(!proof.method_manifest||fingerprint(proof.method_manifest)!==proof.method_identity||!same(proof.code_bindings,proof.method_manifest.bindings)
      ||proof.method_manifest.authorization_sha256!==proof.authorization_identity||proof.method_manifest.profile!==OFFICE_HTML_PROFILE
      ||proof.method_manifest.scope_sha256!=='sha256:914b5571e1cb3acf9a99894a04ba8c6e37badb4db2b42cd29bc9b1482c02356d'
      ||proof.method_manifest.inputs_sha256!=='sha256:8e91be3e33b1d96890299a8b2f27d737675439fb2eb8084d7c02eb36fe130914'
      ||input.candidateDescriptor.method_identity!==proof.method_identity||input.candidateDescriptor.authorization_fingerprint!==proof.authorization_identity
      ||input.comparisonPolicy.reference_identity!==reference.reference_identity)return failResult(['OFFICE_HTML_METHOD_BINDING_MISMATCH']);
    const old=JSON.parse(proof.old_input_bytes);const content=JSON.parse(proof.content_bytes);const observed=proof.observed;
    const outputBinding=old.candidateRun.construction_proof.parser.outputs.find(b=>b.path.endsWith('/input_content_list.json'));
    if(observed.output_path!==outputBinding.path||observed.output_sha256!==outputBinding.sha256||sha(Buffer.from(proof.content_bytes))!==observed.output_sha256||sha(Buffer.from(content[observed.block_index].table_body))!==observed.html_sha256||observed.json_pointer!==`/${observed.block_index}/table_body`
      ||!same(parseOfficeHtmlStructure(content[observed.block_index].table_body),observed.tree))return failResult(['OFFICE_HTML_STRUCTURE_PROOF_MISMATCH']);
    const rebuiltMapping=deriveOfficeHtmlMapping({format:candidate.format,source:old.candidateRun.construction_proof.source,observed});
    if(!same(rebuiltMapping,proof.mapping)||!same(baseline.units,old.baselineRun.units)||!same(baseline.observations,old.baselineRun.observations)||!same(candidate.observations,old.candidateRun.observations))return failResult(['OFFICE_HTML_MAPPING_PROOF_MISMATCH']);
    const rebuilt=makeHtmlCandidate(old.candidateRun,observed,rebuiltMapping);
    const sourceTitles=old.candidateRun.construction_proof.source.records.filter(r=>r.kind==='paragraph'&&/^\/document\[1\]\/body\[1\]\/p\[\d+\]$/.test(r.locator.xml_path)&&r.text);
    const titles=content.map((b,n)=>({b,n})).filter(x=>typeof x.b.text==='string'&&x.n<observed.block_index);
    if(candidate.format==='docx'&&rebuiltMapping.ok&&sourceTitles.length===1&&titles.length===1){const u=rebuilt.units.find(u=>u.record_id===sourceTitles[0].id);const actual=candidate.units.find(v=>v.record_id===u.record_id);u.text=titles[0].b.text;u.mapping_status='mapped';u.parser_links=[{output_path:observed.output_path,output_sha256:observed.output_sha256,json_pointer:`/${titles[0].n}/text`,text:u.text,physical_page:null,coordinate_mapping:'unmapped'}];u.derived_source_mapping={record_id:u.record_id,status:'mapped',origin:'derived_source_mapping',title_before_unique_bound_table:true,json_pointer:`/${titles[0].n}/text`,native_parser_coordinate_mapping:'unmapped'};}
    const rebuiltBaseline=clone(old.baselineRun);rebuiltBaseline.profile=OFFICE_HTML_PROFILE;
    for(const run of [rebuiltBaseline,rebuilt]){run.html_construction_proof=clone(proof);run.html_construction_fingerprint=fingerprint(proof);run.run_identity=deriveOfficeOriginalRunIdentity(run);}
    if(!same(rebuilt,candidate)||!same(rebuiltBaseline,baseline))return failResult(['OFFICE_HTML_RUN_RECONSTRUCTION_MISMATCH']);
    const expected=clone(old.referenceManifest);expected.profile=OFFICE_HTML_PROFILE;expected.derived_from={path:`${OFFICE_REPRESENTATION_ROOT}/REFERENCE-${candidate.format}.json`,reference_identity:old.referenceManifest.reference_identity};expected.current_consumption_method_identity=proof.method_identity;expected.derivation_authorization_fingerprint=proof.authorization_identity;delete expected.reference_identity;expected.reference_identity=fingerprint(expected);
    if(!same(reference,expected)||proof.reference_identity!==reference.reference_identity||candidate.method!==OFFICE_HTML_METHOD||input.candidateDescriptor.method!==OFFICE_HTML_METHOD||input.candidateDescriptor.scientific_eligible!==false||input.candidateDescriptor.independent_backend!==false||input.comparisonPolicy.method_identity!==proof.method_identity)return failResult(['OFFICE_HTML_REFERENCE_DERIVATION_MISMATCH']);
    const result={schema_version:'phase21-reference-comparison-office-original-1.0',reference_kind:reference.reference_kind,evaluation_scope:'source_representation_fidelity',scientific_eligible:false,independent_backend:false,errors:[],baseline:scoreRun(baseline,reference),candidate:scoreRun(candidate,reference),original_required_records:reference.records.length,
      computation_verified:false,scientific_acceptance:'not_assessed',retained_scientific_uncertainties:reference.retained_scientific_uncertainties,current_review_scientific_uncertainties:reference.current_review_scientific_uncertainties,current_review_limitations:reference.current_review_limitations,
      mapping_framework:proof.mapping.checks,method_identity:proof.method_identity,native_parser_coordinate_mapping:'unmapped',mapping_origin:'derived_source_mapping',formula_cache_metric_scope:'serialized_field_fidelity_only',limitations:['Shared source reader and parser; not independent accuracy.','HTML row/cell mapping derived from full frame; no native Excel coordinates or physical pages.','Strict raw literal equality; Markdown and decimals not normalized.','No model reviewed r3 mapping code; r2 scientific unknowns and source representation advice preserved.']};
    result.status=result.candidate.critical_missing.length||result.candidate.metrics.matched!==result.candidate.metrics.denominator?'rejected':'compared';result.comparison_identity=fingerprint(result);return result;
  }catch{return failResult(['OFFICE_HTML_INPUT_INVALID']);}
}
const metadataKeys = r => r.kind === 'workbook_cell' ? ['locator', 'sheet', 'address', 'row', 'column', 'serialized', 'xml_type', 'state', 'formula', 'cache', 'merges', 'unresolved']
  : Object.keys(r).filter(k => !['id', 'kind', 'text', 'physical_page', 'evidence_origin'].includes(k));

/** Only actual qualification writes require the current approved active clock. */
export async function requireOfficeOriginalWriteAuthority() {
  const authorization = await json(`${output}/AUTHORIZATION.json`);
  const run = await json(`${output}/RUN.json`);
  const inputsBytes = await readFile(path.join(root, prepared, 'INPUTS.json'));
  if (authorization.authorized !== true || authorization.status !== 'approved'
    || authorization.proposal_id !== 'P21-OFFICE-ORIGINAL-COMPARISON-r1'
    || authorization.scope_sha256 !== 'sha256:b6bfcb1a8eb600e0d12dc9f8c3f7f7789a86899fe5629f0e881264fcb8d5f40b'
    || authorization.inputs_sha256 !== 'sha256:809b447f40aa78e6d876a1c57904807f21ac6939e5c2a1c0445f40d1a0695c88'
    || sha(inputsBytes) !== authorization.inputs_sha256
    || sha(await readFile(path.join(root, prepared, 'IMPLEMENTATION.md'))) !== authorization.scope_sha256
    || run.authorized !== true || run.proposal_id !== authorization.proposal_id
    || run.scope_sha256 !== authorization.scope_sha256 || run.inputs_sha256 !== authorization.inputs_sha256
    || authorization.output_root !== output || path.resolve(authorization.vault_root ?? '') !== path.resolve(root)
    || !same(authorization.owned_source_files, JSON.parse(inputsBytes).owned_source_files)
    || !same(authorization.limits, JSON.parse(inputsBytes).limits)
    || authorization.candidate_method !== hybridMethod
    || authorization.reference_authorization?.limited_acceptance_authorized !== true
    || authorization.reference_authorization.corpus_id !== 'phase21-office-original-synthetic-r1'
    || !same(authorization.reference_authorization.paper_ids,['synthetic-docx','synthetic-xlsx'])
    || authorization.reference_authorization.independent_gold !== false || authorization.reference_authorization.nonblind !== true
    || authorization.reference_authorization.shared_reader !== true) fail('OFFICE_WRITE_AUTHORITY_REQUIRED');
  const clock = authorization.budget;
  if (clock?.max_minutes !== 75 || clock.started_at !== '2026-10-09T13:56:29Z' || clock.deadline_at !== '2026-10-09T15:11:29Z'
    || run.budget?.max_minutes !== clock.max_minutes || run.budget.started_at !== clock.started_at || run.budget.deadline_at !== clock.deadline_at) fail('OFFICE_WRITE_CLOCK_MISMATCH');
  if (run.budget.status !== 'active' || run.budget.closed_at || run.status !== 'implementation_started') fail('OFFICE_WRITE_BUDGET_CLOSED');
  if (Date.now() < Date.parse(clock.started_at) || Date.now() > Date.parse(clock.deadline_at)) fail('OFFICE_WRITE_BUDGET_EXPIRED');
  return authorization;
}

/** Capture exact current code, unchanged saved inputs and explicit historical dispositions. */
export async function prepareOfficeOriginalMethod() {
  await requireOfficeOriginalWriteAuthority();
  const authorizationBytes = await readFile(contextPaths.authorizationRecordPath);
  const authorization = JSON.parse(authorizationBytes);
  const approved = await json(`${prepared}/INPUTS.json`);
  const owned = authorization.owned_source_files.map(x => x.path);
  const bindings = [];
  for (const name of [...approved.bindings.map(x => x.path), ...owned.filter(name => !approved.bindings.some(b => b.path === name))]) {
    const bytes = await readFile(path.resolve(root, name));
    bindings.push({ path: name, bytes: bytes.length, sha256: sha(bytes) });
  }
  const historicalInputs = await json(`${saved}/INPUTS.json`);
  const historicalValidation = await json(`${saved}/VALIDATION.json`);
  const dispositions = items => items.map(binding => {
    const current = bindings.find(b => path.resolve(root, b.path) === path.resolve(root, binding.path));
    if (!current) fail('OFFICE_METHOD_BINDING_MISMATCH');
    const changed = binding.sha256 !== current.sha256;
    if (changed && !owned.includes(binding.path)) fail('OFFICE_METHOD_BINDING_MISMATCH');
    return { path: binding.path, historical_sha256: binding.sha256, current_sha256: current.sha256,
      disposition: changed ? 'historical_code_changed' : 'unchanged_saved_bytes_verified' };
  });
  const manifest = { schema_version: 'phase21-office-original-method-1.0', method: 'office-saved-mineru-source-metadata-hybrid-1.0',
    scope_sha256: authorization.scope_sha256, inputs_sha256: authorization.inputs_sha256, authorization_sha256: sha(authorizationBytes),
    clock: authorization.budget, code_paths: owned, bindings,
    historical_31: dispositions(historicalInputs.bindings), historical_7: dispositions(historicalValidation.files),
    historical_replay: 'not_replayed', new_MinerU_run: false, independent_backend: false };
  await save('METHOD.json', manifest);
  const context = await validateOfficeSavedConsumptionContext(contextPaths);
  if (!context.ok) fail(context.errors[0]);
  return context;
}

export async function prepareOfficeRealPilotMethod({manifestPath,authorizationRecordPath} = {}) {
  const authority = await requireOfficeRealPilotAuthority();
  if (path.resolve(manifestPath ?? '') !== path.join(root,OFFICE_REAL_ROOT,'METHOD.json')
    || path.resolve(authorizationRecordPath ?? '') !== path.join(root,OFFICE_REAL_ROOT,'AUTHORIZATION.json')) fail('OFFICE_REAL_PATH_MISMATCH');
  const bindings = [];
  for (const name of authority.inputs.owned_source_files) {
    const bytes = await readFile(path.join(root,name));
    bindings.push({path:name,bytes:bytes.length,sha256:sha(bytes),kind:'code'});
  }
  const manifest = {profile:'paper03_real_office_pilot',schema_version:'phase21-office-real-method-1.0',method:OFFICE_REAL_METHOD,
    scope_sha256:authority.authorization.scope_sha256,inputs_sha256:authority.authorization.inputs_sha256,
    authorization_sha256:sha(authority.authorizationBytes),clock:authority.authorization.budget,
    code_paths:authority.inputs.owned_source_files,bindings,
    source_scope:authority.authorization.source_scope, reference_kind:'accepted_assisted_source_verified_pilot',
    scientific_eligible:false,independent_backend:false,
    historical_code_dispositions:authority.inputs.bindings.filter(b=>authority.inputs.owned_source_files.includes(b.path)).map(b=>({path:b.path,historical_sha256:b.sha256,current_sha256:bindings.find(x=>x.path===b.path).sha256,disposition:bindings.find(x=>x.path===b.path).sha256===b.sha256?'unchanged':'historical_code_changed'}))};
  await writeOfficeRealPilotArtifact('METHOD.json',manifest,{exclusive:false});
  return validateOfficeRealPilotContext({manifestPath,authorizationRecordPath});
}

const realReferenceMethod = {source_contact:['current_source_xml_read','current_source_prepare','current_source_review'],parser_output_access:'used',verification:'assisted',blinding:'nonblind',independent_gold:false,shared_reader:true,shared_source_records_with_candidate:true};
const representationReferenceMethod={...realReferenceMethod,source_contact:['saved_source_xml_material','saved_source_prepare','saved_source_review','current_representation_source_review']};

export function validateOfficeRepresentationReference(reference) {
  try {
    if(reference.profile!==OFFICE_REPRESENTATION_PROFILE||reference.reference_kind!=='accepted_assisted_source_representation_pilot'
      ||reference.evaluation_scope!=='source_representation_fidelity'||reference.representation_verified!==true||reference.computation_verified!==false
      ||!same(reference.method,representationReferenceMethod)||reference.acceptance.corpus_id!=='phase21-paper03-office-representation-r2'
      ||!same(reference.retained_scientific_uncertainties,reference.check.retained_scientific_uncertainties)
      ||!same(reference.current_review_scientific_uncertainties,reference.check.current_review_scientific_uncertainties)
      ||!same(reference.current_review_issues,reference.check.current_review_issues)||!same(reference.current_review_limitations,reference.check.current_review_limitations)
      ||!same(reference.current_review_computational_assessment,reference.check.current_review_computational_assessment??null)
      ||reference.reviewed_method_identity!==reference.check.reviewed_method_identity||reference.current_consumption_method_identity!==reference.check.method_identity
      ||fingerprint((({reference_identity,...body})=>body)(reference))!==reference.reference_identity)return {ok:false,errors:['OFFICE_REPRESENTATION_REFERENCE_INVALID']};
    const check=validateOfficeRepresentationSourceCheck({format:reference.format,source:{source:reference.source,records:reference.records.map(r=>r.expected),parts:reference.check.source_parts},check:reference.check,
      rawBytes:reference.check.raw_parts_bytes,context:{method_identity:reference.check.method_identity,authorization_identity:reference.acceptance.authorization_fingerprint}});
    if(!check.ok)return check;
    const normalized=clone(reference);
    normalized.profile='paper03_real_office_pilot';normalized.reference_kind='accepted_assisted_source_verified_pilot';normalized.method=clone(realReferenceMethod);normalized.acceptance.corpus_id='phase21-paper03-office-pilot-r1';
    delete normalized.reference_identity;normalized.reference_identity=fingerprint(normalized);
    return validateOfficeRealPilotReference(normalized);
  }catch{return {ok:false,errors:['OFFICE_REPRESENTATION_REFERENCE_INVALID']};}
}

export function validateOfficeRealPilotReference(reference) {
  try {
    const errors=[];
    const {reference_identity,...body}=reference;
    if (reference.profile!=='paper03_real_office_pilot' || reference.reference_kind!=='accepted_assisted_source_verified_pilot'
      || fingerprint(body)!==reference_identity || !same(reference.method,realReferenceMethod)
      || reference.acceptance?.status!=='accepted' || reference.acceptance.corpus_id!=='phase21-paper03-office-pilot-r1'
      || reference.acceptance.paper_id!==`paper03-${reference.format}` || reference.scientific_eligible!==false
      || reference.check?.ok!==true || fingerprint(reference.check)!==reference.acceptance.check_fingerprint
      || reference.check.authorization_fingerprint!==reference.acceptance.authorization_fingerprint
      || reference.check.source_records_fingerprint!==fingerprint(reference.records.map(r=>r.expected))
      || !same(reference.required_record_ids,reference.records.map(r=>r.record_id))
      || new Set(reference.required_record_ids).size!==reference.records.length
      || !same(reference.scope.category_dispositions.map(d=>d.category),categories)) errors.push('OFFICE_REAL_REFERENCE_INVALID');
    if (!Array.isArray(reference.check.receipts) || reference.check.receipts.length<2
      || !reference.check.receipts.some(r=>r.role==='source_prepare') || !reference.check.receipts.some(r=>r.role==='source_review')
      || reference.check.receipts.some(r=>r.requested_model!=='gpt-6.1-sol'||r.reasoning_effort!=='medium'||!r.response_sha256||!r.request_sha256||!r.agent_id)) errors.push('OFFICE_REAL_SOURCE_CHECK_REQUIRED');
    for (const item of reference.records) if (item.record_id!==item.expected.id || item.kind!==item.expected.kind || item.category!==category(item.expected)
      || !same(item.fields,metadataKeys(item.expected)) || !['central','noncentral'].includes(item.centrality)
      || item.text_required!==(typeof item.expected.text==='string'&&item.expected.text!=='')) errors.push('OFFICE_REFERENCE_SCOPE_INCOMPLETE');
    for (const d of reference.scope.category_dispositions) {
      const count=reference.records.filter(r=>r.category===d.category).length+reference.field_obligations.filter(r=>r.category===d.category).length;
      if(d.count!==count||d.disposition!==(count?'covered':'inapplicable')||!d.reason) errors.push('OFFICE_REFERENCE_SCOPE_INCOMPLETE');
    }
    if(reference.format==='xlsx' && reference.records.filter(r=>r.kind==='workbook_cell').length!==75) errors.push('OFFICE_REFERENCE_SCOPE_INCOMPLETE');
    return {ok:!errors.length,errors:[...new Set(errors)]};
  } catch {return {ok:false,errors:['OFFICE_REAL_REFERENCE_INVALID']};}
}

export function validateOfficeRealPilotSourceCheck({format,source,check,rawBytes,context:current} = {}) {
  try {
    const raw=JSON.parse(rawBytes);
    const ok=check.ok===true&&check.format===format&&check.method_identity===current.method_identity
      &&check.authorization_fingerprint===current.authorization_identity&&check.source_identity===fingerprint(source.source)
      &&check.source_records_fingerprint===fingerprint(source.records)&&check.raw_parts_sha256===sha(Buffer.from(rawBytes))
      &&same(check.required_record_ids,source.records.map(r=>r.id))&&Array.isArray(check.items)&&check.items.length===source.records.length
      &&check.items.every((i,n)=>i.record_id===source.records[n].id&&i.source_supported===true&&['central','noncentral'].includes(i.centrality)
        &&i.part_sha256===source.parts.find(p=>p.path===source.records[n].locator.part)?.sha256&&same(i.locator,source.records[n].locator)
        &&typeof i.source_excerpt==='string'&&typeof i.context==='string'&&i.unresolved!==true)
      &&raw.parts.every(p=>sha(Buffer.from(p.xml,'utf8'))===p.sha256)&&same(raw.parts.map(({xml,locator_root,...p})=>p),source.parts);
    return {ok,errors:ok?[]:['OFFICE_REAL_SOURCE_CHECK_REQUIRED']};
  }catch{return {ok:false,errors:['OFFICE_REAL_SOURCE_CHECK_REQUIRED']};}
}

/** Pure representation gate: scientific unknowns are preserved, never discharged. */
export function validateOfficeRepresentationSourceCheck({format,source,check,rawBytes,context} = {}) {
  try {
    const raw=JSON.parse(rawBytes);const retained=format==='docx'?[22,34,35]:[67,68];
    const oldRecords=check.retained_scientific_uncertainties;
    const ok=check.profile===OFFICE_REPRESENTATION_PROFILE&&check.reference_kind==='accepted_assisted_source_representation_pilot'
      &&check.evaluation_scope==='source_representation_fidelity'&&check.ok===true&&check.representation_verified===true&&check.computation_verified===false
      &&check.format===format&&check.method_identity===context.method_identity&&check.authorization_fingerprint===context.authorization_identity
      &&check.source_identity===fingerprint(source.source)&&check.source_records_fingerprint===fingerprint(source.records)&&check.raw_parts_sha256===sha(Buffer.from(rawBytes))
      &&same(check.source_parts,source.parts)&&check.raw_parts_bytes===Buffer.from(rawBytes).toString('utf8')
      &&Array.isArray(check.checks)&&check.checks.length>0&&check.checks.every(c=>c.ok===true)
      &&same(check.required_record_ids,source.records.map(r=>r.id))&&check.items.length===(format==='docx'?38:75)
      &&check.items.every((i,n)=>i.record_index===n&&i.record_id===source.records[n].id&&i.source_supported===true&&i.representation_verified===true
        &&i.computation_verified===false&&['central','noncentral'].includes(i.centrality)&&same(i.locator,source.records[n].locator)
        &&i.part_sha256===source.parts.find(p=>p.path===i.locator.part)?.sha256&&typeof i.source_excerpt==='string'&&typeof i.context==='string'
        &&i.unresolved===retained.includes(n)&&i.representation_unresolved!==true)
      &&same(oldRecords.map(i=>i.record_index),retained)&&oldRecords.every(i=>i.unresolved===true&&typeof i.reason==='string'&&i.reason.length>0)
      &&raw.parts.every(p=>sha(Buffer.from(p.xml,'utf8'))===p.sha256)&&same(raw.parts.map(({xml,locator_root,...p})=>p),source.parts)
      &&Array.isArray(check.receipts)&&check.receipts.length===3
      &&check.receipts.every(r=>r.requested_model==='gpt-6.1-sol'&&r.reasoning_effort==='medium'&&r.agent_id&&r.request_sha256&&r.response_sha256)
      &&check.receipts[0].role==='source_prepare'&&check.receipts[1].role==='source_review'
      &&check.receipts[2].role==='source_review'&&check.receipts[2].evaluation_scope==='source_representation_fidelity'
      &&check.receipts[0].response_path===`${OFFICE_REAL_ROOT}/source_prepare-RETURN-02.json`
      &&check.receipts[1].response_path===`${OFFICE_REAL_ROOT}/source_review-RETURN-01.json`
      &&check.receipts[2].response_path.startsWith(OFFICE_REPRESENTATION_ROOT+'/')&&check.receipts[2].request_path.startsWith(OFFICE_REPRESENTATION_ROOT+'/');
    return {ok,errors:ok?[]:['OFFICE_REPRESENTATION_SOURCE_CHECK_REQUIRED']};
  }catch{return {ok:false,errors:['OFFICE_REPRESENTATION_SOURCE_CHECK_REQUIRED']};}
}

export async function buildOfficeRealPilotComparisonInputs(args = {}) {return buildBoundRealOfficeInputs(args,false);}
export async function buildOfficeRepresentationComparisonInputs(args = {}) {return buildBoundRealOfficeInputs(args,true);}

async function buildBoundRealOfficeInputs({format,context,referenceCheckPath,persist=false} = {},representation) {
  if(representation&&persist)await requireOfficeRepresentationAuthority();
  const current=await (representation?validateOfficeRepresentationContext:validateOfficeRealPilotContext)(context);
  if(!current.ok) fail(current.errors[0]);
  const writeRoot=representation?OFFICE_REPRESENTATION_ROOT:OFFICE_REAL_ROOT;
  const profile=representation?OFFICE_REPRESENTATION_PROFILE:'paper03_real_office_pilot';
  const method=representation?OFFICE_REPRESENTATION_METHOD:OFFICE_REAL_METHOD;
  const write=representation?writeOfficeRepresentationArtifact:writeOfficeRealPilotArtifact;
  if(!['docx','xlsx'].includes(format)||path.resolve(referenceCheckPath??'')!==path.join(root,writeRoot,`REFERENCE-CHECK-${format}.json`)) fail('OFFICE_REAL_SOURCE_CHECK_REQUIRED');
  const sourceBytes=await readFile(path.join(root,OFFICE_REAL_ROOT,`SOURCE-EVIDENCE-${format}.json`));
  const source=JSON.parse(sourceBytes);
  const check=JSON.parse(await readFile(referenceCheckPath,'utf8'));
  const rawBytes=await readFile(path.join(root,OFFICE_REAL_ROOT,`RAW-SOURCE-PARTS-${format}.json`));
  const raw=JSON.parse(rawBytes);
  const gate=(representation?validateOfficeRepresentationSourceCheck:validateOfficeRealPilotSourceCheck)({format,source,check,rawBytes,context:current});
  if(!gate.ok)fail(gate.errors[0]);
  for(const receipt of check.receipts??[]) {
    for(const kind of ['request','response']) {
      const relative=receipt[`${kind}_path`];
      if(typeof relative!=='string'||!(relative.startsWith(OFFICE_REAL_ROOT+'/')||(representation&&relative.startsWith(OFFICE_REPRESENTATION_ROOT+'/')))||sha(await readFile(path.join(root,relative)))!==receipt[`${kind}_sha256`]) fail('OFFICE_REAL_SOURCE_CHECK_RECEIPT_MISMATCH');
    }
  }
  if(representation) {
    const receipt=check.receipts[2];const request=await json(receipt.request_path);const response=await json(receipt.response_path);
    const advice=response.formats?.find(f=>f.format===format);
    const actualRun=await json(`${OFFICE_REPRESENTATION_ROOT}/RUN.json`);
    const actualReceipt=actualRun.content_requests?.find(r=>r.request_id===receipt.request_id&&r.agent_id===receipt.agent_id&&r.request_sha256===receipt.request_sha256&&r.response_sha256===receipt.response_sha256&&r.status==='completed_source_advice');
    const materialPaths=['SOURCE-EVIDENCE-docx.json','SOURCE-EVIDENCE-xlsx.json','RAW-SOURCE-PARTS-docx.json','RAW-SOURCE-PARTS-xlsx.json','source_prepare-RETURN-02.json','source_review-RETURN-01.json','PARSER-EVIDENCE-docx.json','PARSER-EVIDENCE-xlsx.json'].map(n=>`${OFFICE_REAL_ROOT}/${n}`);
    if(request.role!=='source_review'||request.request_id!==receipt.request_id||request.requested_model!=='gpt-6.1-sol'||request.reasoning_effort!=='medium'
      ||request.evaluation_scope!=='source_representation_fidelity'||request.method_identity!==current.reviewed_method_identity||check.reviewed_method_identity!==current.reviewed_method_identity||request.authorization_identity!==current.authorization_identity
      ||response.role!=='source_review'||response.evaluation_scope!=='source_representation_fidelity'||advice?.representation_verified!==true||advice.computation_verified!==false
      ||advice.reference_recommendation!=='accepted_for_representation'||advice.items.length!==source.records.length||!actualReceipt||actualRun.content_requests.length>2
      ||!same(request.materials?.map(b=>b.path),materialPaths)||!same(check.checks,advice.checks)
      ||!same(check.current_review_scientific_uncertainties,advice.retained_scientific_uncertainties)
      ||!same(check.current_review_issues,advice.issues)||!same(check.current_review_limitations,response.limitations)
      ||!same(check.current_review_computational_assessment??null,advice.computational_assessment??null))fail('OFFICE_REPRESENTATION_ACTUAL_REVIEW_REQUIRED');
    for(const binding of request.materials??[]) {const bytes=await readFile(path.join(root,binding.path));if(bytes.length!==binding.bytes||sha(bytes)!==binding.sha256)fail('OFFICE_REPRESENTATION_REVIEW_MATERIAL_DRIFT');}
    for(const [n,item] of check.items.entries()) {
      const supplied=advice.items[n];const binding=request.record_bindings?.[format]?.[n];
      if(!binding||binding.record_id!==item.record_id||!same(binding.locator,item.locator)||binding.part_sha256!==item.part_sha256
        ||!same(supplied,item.review_advice)||supplied.record_index!==n||supplied.representation_verified!==true||supplied.computation_verified!==false
        ||supplied.source_supported!==true||supplied.representation_unresolved!==false
        ||item.source_supported!==supplied.source_supported||item.representation_unresolved!==supplied.representation_unresolved
        ||item.scientific_uncertainty_retained!==supplied.scientific_uncertainty_retained
        ||item.source_excerpt!==supplied.source_excerpt||item.context!==supplied.context||item.centrality!==supplied.centrality)fail('OFFICE_REPRESENTATION_ACTUAL_REVIEW_REQUIRED');
    }
    const old=await json(`${OFFICE_REAL_ROOT}/REFERENCE-CHECK-${format}.json`);
    if(!same(check.receipts.slice(0,2),old.receipts)
      ||!same(check.retained_scientific_uncertainties,old.items.filter(i=>i.centrality==='central'&&i.unresolved).map(i=>({record_index:i.record_index,record_id:i.record_id,unresolved:true,reason:i.reason})))
      ||check.items.some((i,n)=>i.centrality!==old.items[n].centrality||i.unresolved!==old.items[n].unresolved))fail('OFFICE_REPRESENTATION_UNCERTAINTY_CHANGED');
  }
  const records=source.records.map((record,n)=>({record_id:record.id,kind:record.kind,category:category(record),centrality:check.items[n].centrality,expected:clone(record),fields:metadataKeys(record),text_required:typeof record.text==='string'&&record.text!==''}));
  const field_obligations=source.records.filter(r=>r.formula?.present).flatMap(r=>['formula','cache'].map(field=>({evidence_id:`${r.id}#${field}`,record_id:r.id,field,category:'formula',centrality:'central'})));
  const referenceManifest={schema_version:'phase21-office-original-reference-1.0',profile,format,reference_kind:representation?'accepted_assisted_source_representation_pilot':'accepted_assisted_source_verified_pilot',scientific_eligible:false,
    ...(representation?{evaluation_scope:'source_representation_fidelity',representation_verified:true,computation_verified:false,retained_scientific_uncertainties:clone(check.retained_scientific_uncertainties),
      current_review_scientific_uncertainties:clone(check.current_review_scientific_uncertainties),current_review_issues:clone(check.current_review_issues),current_review_limitations:clone(check.current_review_limitations),
      current_review_computational_assessment:clone(check.current_review_computational_assessment??null),reviewed_method_identity:current.reviewed_method_identity,current_consumption_method_identity:current.method_identity}:{}),
    acceptance:{status:'accepted',corpus_id:representation?'phase21-paper03-office-representation-r2':'phase21-paper03-office-pilot-r1',paper_id:`paper03-${format}`,decision_ref:`${writeRoot}/AUTHORIZATION.json`,authorization_fingerprint:current.authorization_identity,check_fingerprint:fingerprint(check)},
    method:representation?representationReferenceMethod:realReferenceMethod,source:source.source,required_record_ids:records.map(r=>r.record_id),records,field_obligations,check,
    scope:{status:'complete_within_approved_two_member_selection',category_dispositions:categories.map(c=>{const count=records.filter(r=>r.category===c).length+field_obligations.filter(r=>r.category===c).length;return {category:c,count,disposition:count?'covered':'inapplicable',reason:count?'Complete approved current source obligations.':'No applicable obligation in this selected member.'};})}};
  referenceManifest.reference_identity=fingerprint(referenceManifest);
  const accepted=(representation?validateOfficeRepresentationReference:validateOfficeRealPilotReference)(referenceManifest);
  if(!accepted.ok) fail(accepted.errors[0]);
  if(persist) await write(`REFERENCE-${format}.json`,referenceManifest);
  const parser=representation?(await readOfficeRepresentationCache({format,context:current})).parser:await readOfficeRealPilotParserEvidence({format,context:current});
  const source_binding={path:`${OFFICE_REAL_ROOT}/SOURCE-EVIDENCE-${format}.json`,bytes:sourceBytes.length,sha256:sha(sourceBytes),kind:'source_records'};
  const bindings=[...current.manifest.bindings,source_binding,...parser.outputs.map(o=>({...o,bytes:o.byte_length,kind:'parser_output'}))];
  const proof={profile,source,parser,source_binding,source_bytes:sourceBytes.toString('utf8'),parser_content_bytes:await readFile(path.join(root,parser.outputs.find(o=>o.path.endsWith('/input_content_list.json')).path),'utf8'),
    method_identity:current.method_identity,authorization_identity:current.authorization_identity,code_bindings:current.manifest.bindings,saved_input_bindings:bindings,reference_identity:referenceManifest.reference_identity,
    raw_parts:raw,raw_parts_sha256:sha(rawBytes),check_fingerprint:fingerprint(check),required_record_ids:records.map(r=>r.record_id),centralities:check.items.map(i=>i.centrality)};
  const observation=await json(`${OFFICE_REAL_ROOT}/OBSERVATION-${format}.json`);
  const make=side=>{const run={schema_version:OFFICE_CONTRACT,profile,format,side,status:'accepted_for_comparison',method:side==='baseline'?'current_output_reconstruction':method,
    source:clone(source.source),backend:clone(parser.backend),original_run_id:parser.run_id,original_parse_observation:observation,independent_backend:false,saved_output_bindings:clone(parser.outputs),observations:clone(parser.anchors),
    construction_proof:clone(proof),construction_fingerprint:fingerprint(proof),units:source.records.map((r,n)=>({...makeUnit(r,parser.anchors,side,source,source_binding),centrality:check.items[n].centrality}))};run.run_identity=deriveOfficeOriginalRunIdentity(run);return run;};
  const input={baselineRun:make('baseline'),candidateRun:make('candidate'),referenceManifest,comparisonPolicy:{location_contract:OFFICE_CONTRACT,central_evidence_rule:'reject',method_identity:current.method_identity,reference_identity:referenceManifest.reference_identity,source_identity:fingerprint(source.source)},candidateDescriptor:{method,independent_backend:false,scientific_eligible:false,authorization_fingerprint:current.authorization_identity,method_identity:current.method_identity}};
  const after=await (representation?validateOfficeRepresentationContext:validateOfficeRealPilotContext)(current);
  if(!after.ok||after.method_identity!==current.method_identity) fail('OFFICE_REAL_METHOD_MISMATCH');
  return input;
}

export function deriveOfficeOriginalRunIdentity(run) {
  const { run_identity, ...body } = run ?? {};
  return fingerprint(body);
}

function validateObservations(run, errors) {
  if (!Array.isArray(run.observations) || run.observations.some(o => !o || typeof o !== 'object')) {
    errors.push('OFFICE_RUN_SCHEMA_INVALID'); return;
  }
  for (const observation of run.observations) {
    if (observation.physical_page !== null) errors.push('OFFICE_PHYSICAL_PAGE_CLAIM_INVALID');
    if (observation.coordinate_mapping !== 'unmapped') errors.push('OFFICE_CELL_MAPPING_UNSUPPORTED');
    const anchor = run.construction_proof?.parser?.anchors?.find(a => a.json_pointer === observation.json_pointer && (a.html_node_path ?? null) === (observation.html_node_path ?? null));
    if (!anchor || !same(anchor, observation)) errors.push('OFFICE_POINTER_MISMATCH');
  }
}

function validateRun(run) {
  const errors = [];
  const representation=run?.profile===OFFICE_REPRESENTATION_PROFILE;
  const real = run?.profile === 'paper03_real_office_pilot'||representation;
  if (!run || typeof run !== 'object' || run.schema_version !== OFFICE_CONTRACT || !['docx', 'xlsx'].includes(run.format)
    || !['baseline', 'candidate'].includes(run.side) || !run.construction_proof || !Array.isArray(run.units)
    || run.units.some(u => !u || typeof u !== 'object')) return { ok: false, errors: ['OFFICE_RUN_SCHEMA_INVALID'] };
  if (deriveOfficeOriginalRunIdentity(run) !== run.run_identity) errors.push('OFFICE_RUN_IDENTITY_MISMATCH');
  if (run.independent_backend !== false || run.status !== 'accepted_for_comparison'
    || run.method !== (run.side === 'baseline' ? (real?'current_output_reconstruction':'saved_output_reconstruction') : (representation?OFFICE_REPRESENTATION_METHOD:real?OFFICE_REAL_METHOD:hybridMethod))) errors.push('OFFICE_RUN_PROVENANCE_MISMATCH');
  const proof = run.construction_proof;
  if (fingerprint(proof) !== run.construction_fingerprint || !proof.source || !Array.isArray(proof.source.records)
    || proof.source.records.some(r => !r || typeof r !== 'object') || !proof.parser || !Array.isArray(proof.parser.anchors))
    return {ok:false,errors:[...new Set([...errors,'OFFICE_METHOD_BINDING_MISMATCH'])]};
  const bindingKey = name => typeof name === 'string' ? path.resolve(root, name).toLowerCase() : null;
  const bindingTable = proof.saved_input_bindings;
  if (!Array.isArray(bindingTable) || bindingTable.some(b => !b || typeof b.path !== 'string')
    || new Set(bindingTable.map(b => bindingKey(b.path))).size !== bindingTable.length) errors.push('OFFICE_PROOF_BINDING_MISMATCH');
  else {
    const linked = binding => {
      const registered = bindingTable.find(b => bindingKey(b.path) === bindingKey(binding?.path));
      return registered && registered.bytes === (binding.bytes ?? binding.byte_length) && registered.sha256 === binding.sha256;
    };
    if (bindingKey(proof.source_binding?.path) !== bindingKey(`${real?OFFICE_REAL_ROOT:saved}/SOURCE-EVIDENCE-${run.format}.json`)
      || !linked(proof.source_binding)) errors.push('OFFICE_PROOF_BINDING_MISMATCH');
    const outputPrefix = bindingKey(`${real?OFFICE_REAL_ROOT:native}/${run.format}-output`) + path.sep;
    const registeredOutputs = bindingTable.filter(b => bindingKey(b.path).startsWith(outputPrefix));
    if (!Array.isArray(proof.parser.outputs) || proof.parser.outputs.some(b => !linked(b))
      || !same(proof.parser.outputs.map(b => bindingKey(b.path)).sort(), registeredOutputs.map(b => bindingKey(b.path)).sort())) errors.push('OFFICE_PROOF_BINDING_MISMATCH');
    const codePaths = representation?['scripts/v3/office-original-comparison.mjs','scripts/v3/office-source-evidence.mjs','test/v3/office-original-comparison.test.mjs','test/v3/office-source-evidence.test.mjs']:real ? ['scripts/v3/office-original-comparison.mjs','scripts/v3/office-source-evidence.mjs','scripts/v3/office-source-evidence-reader.py','test/v3/office-original-comparison.test.mjs','test/v3/office-source-evidence.test.mjs'] : ['scripts/v3/office-original-comparison.mjs','test/v3/office-original-comparison.test.mjs',
      'scripts/v3/parser-comparison.mjs','scripts/v3/office-source-evidence.mjs','test/v3/office-source-evidence.test.mjs'];
    if (!Array.isArray(proof.code_bindings) || proof.code_bindings.some(b => !linked(b))
      || !same(proof.code_bindings.map(b => bindingKey(b.path)).sort(), codePaths.map(bindingKey).sort())) errors.push('OFFICE_PROOF_BINDING_MISMATCH');
  }
  try {
    if (sha(Buffer.from(proof.source_bytes, 'utf8')) !== proof.source_binding?.sha256 || !same(JSON.parse(proof.source_bytes), proof.source)) errors.push('OFFICE_SOURCE_SCOPE_MISMATCH');
    const contentBinding = proof.parser.outputs.find(b => b.path.endsWith('/input_content_list.json'));
    if (sha(Buffer.from(proof.parser_content_bytes, 'utf8')) !== contentBinding?.sha256) errors.push('OFFICE_OUTPUT_HASH_MISMATCH');
    const content = JSON.parse(proof.parser_content_bytes);
    const expectedAnchors = content.flatMap((block,index) => {
      const base = {output_path:contentBinding.path,output_sha256:contentBinding.sha256,logical_group:block.page_idx ?? null,
        block_index:index,physical_page:null,coordinate_mapping:'unmapped'};
      const anchors = typeof block.text === 'string' ? [{...base,json_pointer:`/${index}/text`,text:block.text}] : [];
      if (typeof block.table_body === 'string') {
        // Fixed saved synthetic outputs contain complete <p> units. This check
        // binds their ordinal/text to the Python HTML-only reconstruction.
        const paragraphs=[...block.table_body.matchAll(/<p(?:\s[^>]*)?>([\s\S]*?)<\/p\s*>/gi)];
        for(const [ordinal,match] of paragraphs.entries()){
          if (/<p(?:\s|>)/i.test(match[1])) fail('OFFICE_POINTER_MISMATCH');
          const text=match[1].replace(/<br\s*\/?\s*>/gi,'\n').replace(/<[^>]*>/g,'')
            .replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&amp;/g,'&');
          anchors.push({...base,json_pointer:`/${index}/table_body`,html_node_path:`p[${ordinal+1}]`,text});
        }
      }
      return anchors;
    });
    if (!same(expectedAnchors, proof.parser.anchors) || !same(expectedAnchors, run.observations)) errors.push('OFFICE_POINTER_MISMATCH');
    for (const anchor of proof.parser.anchors) {
      const match = /^\/(\d+)\/(text|table_body)$/.exec(anchor.json_pointer ?? '');
      const block = match ? content[Number(match[1])] : null;
      if (!block || anchor.block_index !== Number(match[1]) || anchor.logical_group !== (block.page_idx ?? null)
        || anchor.output_sha256 !== contentBinding.sha256 || anchor.output_path !== contentBinding.path
        || (match[2] === 'text' && anchor.text !== block.text)
        || (match[2] === 'table_body' && (typeof block.table_body !== 'string' || !anchor.html_node_path
          || !block.table_body.includes(anchor.text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'))))) errors.push('OFFICE_POINTER_MISMATCH');
    }
  } catch { errors.push('OFFICE_METHOD_BINDING_MISMATCH'); }
  if (!same(run.source, proof.source?.source) || !same(run.backend, proof.parser?.backend)
    || run.original_run_id !== proof.parser?.run_id || !same(run.saved_output_bindings, proof.parser?.outputs)) errors.push('OFFICE_METHOD_BINDING_MISMATCH');
  validateObservations(run, errors);
  const records = proof.source?.records ?? [];
  if(real) {
    const expectedSha=run.format==='docx'?'sha256:4a40c0f50975dade1f854c7ae5d27db39a6ee73db8c0785a8fa7b914114552b8':'sha256:79101d549c9b8e45e0d51969d24ef15050ac3c3a78d51b17c3e042106b24f0c4';
    if(proof.source.source.sha256!==expectedSha || proof.source.source.archive_sha256!=='sha256:1959619da84d7c46eb6292a1a64f209d64b4c95174436d73a9340da25bcea993'
      ||proof.source.source.parent_document_id!=='src_f04a67e08b386f3ff9a911c0beca72e9'
      ||proof.source.source.path!==`${OFFICE_REAL_ROOT}/members/input.${run.format}`
      ||proof.source.source.member_path!==`supplementary Tables/Supplementary Table ${run.format==='docx'?11:10}.${run.format}`
      ||proof.raw_parts.parts.some(p=>sha(Buffer.from(p.xml,'utf8'))!==p.sha256)
      ||!same(proof.raw_parts.parts.map(({xml,locator_root,...p})=>p),proof.source.parts)) errors.push('OFFICE_SOURCE_SCOPE_MISMATCH');
    if(run.format==='xlsx'&&records.some((r,n)=>r.kind!=='workbook_cell'||r.sheet.index!==0||r.sheet.name!=='Supplementary Table 9'||r.address!==String.fromCharCode(65+n%3)+String(Math.floor(n/3)+1))) errors.push('OFFICE_SOURCE_SCOPE_MISMATCH');
  }
  if ((!real && records.length !== (run.format === 'docx' ? 238 : 11)) || !same(records.map(r => r.id), run.units.map(u => u.record_id))
    || (real && (!same(proof.required_record_ids,records.map(r=>r.id)) || proof.profile!==run.profile || records.length>150
      || (run.format==='xlsx' && records.filter(r=>r.kind==='workbook_cell').length!==75)))) errors.push('OFFICE_SOURCE_SCOPE_MISMATCH');
  for (const unit of run.units) {
    const source = records.find(r => r.id === unit.record_id);
    if (!source) continue;
    if (unit.physical_page !== null) errors.push('OFFICE_PHYSICAL_PAGE_CLAIM_INVALID');
    if (unit.parser_coordinate_mapping !== 'unmapped') errors.push('OFFICE_CELL_MAPPING_UNSUPPORTED');
    const rebuilt = makeUnit(source, proof.parser.anchors, run.side, proof.source, proof.source_binding);
    if (!same(unit.parser_links, rebuilt.parser_links) || unit.text !== rebuilt.text || unit.mapping_status !== rebuilt.mapping_status) errors.push('OFFICE_POINTER_MISMATCH');
    if (!same(unit.fields, rebuilt.fields)) errors.push('OFFICE_PARSER_ORIGIN_CLAIM_INVALID');
    if (!same(unit.source_locator, rebuilt.source_locator)) errors.push('OFFICE_SOURCE_SCOPE_MISMATCH');
    if (real && unit.centrality!==proof.centralities[records.indexOf(source)]) errors.push('OFFICE_SOURCE_SCOPE_MISMATCH');
  }
  return { ok: !errors.length, errors: [...new Set(errors)] };
}

export function validateOfficeOriginalRun(run) {
  try { return validateRun(run); } catch { return {ok:false,errors:['OFFICE_RUN_SCHEMA_INVALID']}; }
}

function validateReference(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || manifest.schema_version !== 'phase21-office-original-reference-1.0'
    || !['docx', 'xlsx'].includes(manifest.format) || !Array.isArray(manifest.records) || manifest.records.some(r => !r || typeof r !== 'object'))
    return { ok: false, errors: ['OFFICE_REFERENCE_SCHEMA_INVALID'] };
  const acceptance = manifest.acceptance;
  if (acceptance?.status !== 'accepted' || acceptance.corpus_id !== 'phase21-office-original-synthetic-r1'
    || acceptance.paper_id !== `synthetic-${manifest.format}` || !acceptance.authorization_fingerprint || !acceptance.check_fingerprint
    || fingerprint(manifest.check) !== acceptance.check_fingerprint || manifest.check?.ok !== true
    || manifest.check.authorization_fingerprint !== acceptance.authorization_fingerprint
    || !Array.isArray(manifest.check.checks) || !manifest.check.checks.length || manifest.check.checks.some(c => c?.ok !== true)) errors.push('OFFICE_REFERENCE_ACCEPTANCE_REQUIRED');
  if (manifest.records.length !== (manifest.format === 'docx' ? 238 : 11)
    || !same(manifest.records.map(r => r.record_id), manifest.required_record_ids)
    || new Set(manifest.required_record_ids).size !== manifest.records.length
    || !Array.isArray(manifest.scope?.category_dispositions) || manifest.scope.category_dispositions.some(d => !d)
    || !same(manifest.scope.category_dispositions.map(d => d.category), categories)) errors.push('OFFICE_REFERENCE_SCOPE_INCOMPLETE');
  const { reference_identity, ...body } = manifest;
  if (fingerprint(body) !== reference_identity) errors.push('OFFICE_REFERENCE_SCOPE_INCOMPLETE');
  if (!same(manifest.method, referenceMethod)) errors.push('OFFICE_REFERENCE_PROVENANCE_MISMATCH');
  if (!Array.isArray(manifest.field_obligations) || manifest.records.some(r => typeof r.record_id !== 'string' || !r.expected || !Array.isArray(r.fields)
    || !same(r.fields, metadataKeys(r.expected)) || r.category !== category(r.expected) || r.centrality !== central(r.expected)
    || r.kind !== r.expected.kind || r.record_id !== r.expected.id || r.text_required !== (typeof r.expected.text === 'string' && r.expected.text !== '')))
    errors.push('OFFICE_REFERENCE_SCOPE_INCOMPLETE');
  if (manifest.check?.source_records_fingerprint !== fingerprint(manifest.records.map(r => r.expected))) errors.push('OFFICE_REFERENCE_SCOPE_INCOMPLETE');
  const expectedObligations = manifest.records.filter(r => r.expected.formula?.present).flatMap(r => ['formula','cache'].map(field => ({
    evidence_id: `${r.record_id}#${field}`, record_id: r.record_id, field, category: 'formula', centrality: 'central' })));
  if (!same(manifest.field_obligations, expectedObligations)) errors.push('OFFICE_REFERENCE_SCOPE_INCOMPLETE');
  for (const disposition of manifest.scope?.category_dispositions ?? []) {
    const count = manifest.records.filter(r => r.category === disposition.category).length + expectedObligations.filter(r => r.category === disposition.category).length;
    if (disposition.count !== count || disposition.disposition !== (count ? 'covered' : 'inapplicable') || typeof disposition.reason !== 'string' || !disposition.reason.trim()) errors.push('OFFICE_REFERENCE_SCOPE_INCOMPLETE');
  }
  return { ok: !errors.length, errors: [...new Set(errors)] };
}

export function validateOfficeOriginalReference(manifest) {
  try { return validateReference(manifest); } catch { return {ok:false,errors:['OFFICE_REFERENCE_SCHEMA_INVALID']}; }
}

function makeUnit(record, anchors, side, source, sourceBinding) {
  const hits = typeof record.text === 'string' && record.text !== '' ? anchors.filter(a => a.text === record.text) : [];
  // Cell and paragraph often duplicate one source string: that is not a unique link.
  const duplicates = source.records.filter(r => typeof r.text === 'string' && r.text !== '' && r.text === record.text).length;
  const status = !hits.length ? 'missing' : hits.length !== 1 || duplicates !== 1 ? 'ambiguous' : 'mapped';
  const links = status === 'mapped' ? clone(hits) : [];
  const origin = field => ({ kind: 'saved_source_metadata', path: sourceBinding.path, sha256: sourceBinding.sha256,
    record_id: record.id, json_pointer: `/records/${source.records.indexOf(record)}/${field}` });
  const fields = Object.fromEntries(metadataKeys(record).map(field => [field, side === 'candidate'
    ? { status: 'observed', value: clone(record[field]), origin: origin(field) }
    : { status: 'not_observed', value: null, origin: null }]));
  return { record_id: record.id, kind: record.kind, category: category(record), centrality: central(record),
    mapping_status: status, text: links[0]?.text ?? null, parser_links: links, physical_page: null,
    parser_coordinate_mapping: 'unmapped', source_locator: side === 'candidate' ? clone(record.locator) : null, fields };
}

async function checkedReference(format, source, context, persist) {
  const historicalReview = await json(`${saved}/SOURCE-PARSER-REVIEW.json`);
  const validation = await json(`${saved}/VALIDATION.json`);
  const historicalSource = historicalReview.reviews.find(r => r.format === format)?.source_only;
  const selection = (await json(`${saved}/INPUTS.json`)).source_scope[format];
  const checks = [
    { name: 'saved_source_matches_historical_review', ok: same(source, historicalSource) },
    { name: 'all_unique_original_record_ids', ok: new Set(source.records.map(r => r.id)).size === source.records.length },
    { name: 'fixed_original_count', ok: source.records.length === (format === 'docx' ? 238 : 11) },
    { name: 'source_scope_matches_original_selection', ok: same(source.scope, format === 'docx' ? {parts: selection.parts, coverage: selection.coverage} : {ranges: selection.ranges, coverage: selection.coverage}) },
    { name: 'saved_record_and_reader_fingerprint_in_historical_validation', ok: validation.files.some(b => b.path === `${saved}/SOURCE-EVIDENCE-${format}.json` && b.sha256 === context.manifest.bindings.find(x => x.path === b.path)?.sha256)
      && validation.files.some(b => b.path === 'scripts/v3/office-source-evidence-reader.py' && b.sha256 === source.reader.code_sha256) },
    { name: 'source_only_and_no_physical_pages', ok: source.records.every(r => r.evidence_origin === 'source_only' && r.physical_page === null) },
  ];
  if (format === 'docx') {
    const footnote = source.records.find(r => r.kind === 'footnote');
    const ref = source.records.find(r => r.kind === 'footnote_reference');
    checks.push({ name: 'footnote_definition_and_reference', ok: footnote?.text === 'OFFLINE synthetic footnote obligation.' && ref?.footnote_id === '1' && same(ref.definition_locator, footnote.locator) },
      { name: 'page_break_present', ok: source.records.some(r => r.kind === 'layout_break' && r.break_type === 'page') });
  } else {
    const cell = address => source.records.find(r => r.address === address && r.sheet.name === 'Visible');
    checks.push({ name: 'B1_formula_cached_2', ok: cell('B1')?.formula.text === 'A1+1' && cell('B1').cache.raw_value === '2' },
      { name: 'C1_uncached_formula', ok: cell('C1')?.formula.text === 'A1+2' && cell('C1').cache.element_present === false },
      { name: 'D1_error_E1_explicit_empty', ok: cell('D1')?.raw_value === '#N/A' && cell('E1')?.state === 'explicit_empty' && cell('E1').serialized === true },
      { name: 'unserialized_merge_distinct', ok: ['A2','B2'].every(a => cell(a)?.state === 'unserialized' && cell(a).serialized === false && same(cell(a).merges,['A2:B2'])) },
      { name: 'hidden_A1_99', ok: source.records.some(r => r.address === 'A1' && r.sheet.name === 'Hidden' && r.sheet.visibility === 'hidden' && r.raw_value === '99') });
  }
  const check = { format, ok: checks.every(c => c.ok), evidence_level: 'current_saved_record_review', source_structure_reread: false,
    source_records_fingerprint: fingerprint(source.records), source_identity: fingerprint(source.source),
    method_identity: context.method_identity, authorization_fingerprint: context.authorization_identity, checks };
  if (persist) await save(`REFERENCE-CHECK-${format}.json`, check);
  if (!check.ok || context.authorization.reference_authorization?.limited_acceptance_authorized !== true) fail('OFFICE_REFERENCE_ACCEPTANCE_REQUIRED');
  const records = source.records.map(record => ({ record_id: record.id, kind: record.kind, category: category(record), centrality: central(record),
    expected: clone(record), fields: metadataKeys(record), text_required: typeof record.text === 'string' && record.text !== '' }));
  const field_obligations = source.records.filter(r => r.formula?.present).flatMap(r => ['formula','cache'].map(field => ({ evidence_id: `${r.id}#${field}`, record_id: r.id, field, category: 'formula', centrality: 'central' })));
  const manifest = { schema_version: 'phase21-office-original-reference-1.0', format,
    acceptance: { status: 'accepted', corpus_id: 'phase21-office-original-synthetic-r1', paper_id: `synthetic-${format}`,
      decision_ref: `${output}/AUTHORIZATION.json`, authorization_fingerprint: context.authorization_identity, check_fingerprint: fingerprint(check) },
    method: clone(referenceMethod),
    scope: { status: 'complete_within_fixed_synthetic_selection', category_dispositions: categories.map(c => {
      const count = records.filter(r => r.category === c).length + field_obligations.filter(r => r.category === c).length;
      return { category: c, disposition: count ? 'covered' : 'inapplicable', count,
        reason: count ? 'Pre-registered saved source records and field obligations.' : 'No distinct source obligation of this category within the fixed synthetic selection.' };
    }) }, source: clone(source.source), required_record_ids: records.map(r => r.record_id), records, field_obligations, check };
  manifest.reference_identity = fingerprint(manifest);
  if (persist) await save(`REFERENCE-${format}.json`, manifest); // Freeze BEFORE candidate construction.
  return manifest;
}

export async function buildOfficeOriginalComparisonInputs({ format, context, persist = false } = {}) {
  if (persist) await requireOfficeOriginalWriteAuthority();
  if (!['docx','xlsx'].includes(format)) fail('OFFICE_FORMAT_REQUIRED');
  const current = await validateOfficeSavedConsumptionContext(context ?? contextPaths);
  if (!current.ok) fail(current.errors[0]);
  const source = await json(`${saved}/SOURCE-EVIDENCE-${format}.json`);
  const referenceManifest = await checkedReference(format, source, current, persist);
  const result = await buildOfficeSourceEvidenceReview({ format, evidence: source, consumptionContext: current });
  if (!result.ok) fail(result.errors[0]);
  const parser = result.review.parser;
  const packet = await json(`${native}/PACKET-${format}.json`);
  const observation = await json(`${native}/OBSERVATION-${format}.json`);
  const oldRun = await json(`${native}/RUN.json`);
  const source_binding = current.manifest.bindings.find(b => b.path === `${saved}/SOURCE-EVIDENCE-${format}.json`);
  const proof = { source, parser, source_binding, method_identity: current.method_identity,
    source_bytes: await readFile(path.join(root, source_binding.path), 'utf8'),
    parser_content_bytes: await readFile(path.join(root, parser.outputs.find(o => o.path.endsWith('/input_content_list.json')).path), 'utf8'),
    authorization_identity: current.authorization_identity, code_bindings: current.manifest.bindings.filter(b => current.manifest.code_paths.includes(b.path)),
    saved_input_bindings: current.manifest.bindings, scope_sha256: current.manifest.scope_sha256,
    reference_identity: referenceManifest.reference_identity };
  const makeRun = side => {
    const run = { schema_version: OFFICE_CONTRACT, format, side, status: 'accepted_for_comparison', source: clone(source.source),
      backend: clone(parser.backend), method: side === 'baseline' ? 'saved_output_reconstruction' : current.manifest.method,
      original_run_id: parser.run_id, original_parse_observation: clone(observation), original_execution_clock: clone(oldRun.budget ?? null),
      representation_constructed_at: new Date().toISOString(), configuration_fingerprint: packet.configuration_fingerprint,
      independent_backend: false, saved_output_bindings: clone(parser.outputs), observations: clone(parser.anchors),
      construction_proof: clone(proof), construction_fingerprint: fingerprint(proof),
      units: source.records.map(record => makeUnit(record, parser.anchors, side, source, source_binding)) };
    run.run_identity = deriveOfficeOriginalRunIdentity(run);
    return run;
  };
  const baselineRun = makeRun('baseline');
  const candidateRun = makeRun('candidate');
  const input = { baselineRun, candidateRun, referenceManifest,
    comparisonPolicy: { location_contract: OFFICE_CONTRACT, central_evidence_rule: 'reject', method_identity: current.method_identity,
      reference_identity: referenceManifest.reference_identity, source_identity: fingerprint(source.source), physical_page: 'inapplicable_unknown_no_inference' },
    candidateDescriptor: { method: current.manifest.method, independent_backend: false, scientific_eligible: false,
      authorization_fingerprint: current.authorization_identity, method_identity: current.method_identity } };
  const after = await validateOfficeSavedConsumptionContext(current);
  if (!after.ok || after.method_identity !== current.method_identity) fail(after.errors?.[0] ?? 'OFFICE_METHOD_BINDING_MISMATCH');
  return input;
}

function scoreRun(run, reference) {
  const units = reference.records.map(required => {
    const observed = run.units.find(u => u.record_id === required.record_id);
    const fields = Object.fromEntries(required.fields.map(field => {
      const value = observed?.fields?.[field];
      return [field, { ...value, outcome: value?.status !== 'observed' ? 'missing' : same(value.value, required.expected[field]) ? 'matched' : 'mismatch' }];
    }));
    let outcome = required.text_required ? observed?.mapping_status ?? 'missing' : 'matched';
    if (outcome === 'mapped') outcome = observed.text === required.expected.text ? 'matched' : 'mismatch';
    if (run.format === 'xlsx' && required.text_required && outcome === 'matched' && !(run.profile===OFFICE_HTML_PROFILE&&run.side==='candidate'&&observed?.derived_source_mapping?.status==='mapped')) outcome = 'unmapped';
    if (!required.text_required && Object.values(fields).some(f => f.outcome !== 'matched')) outcome = 'missing';
    return { record_id: required.record_id, kind: required.kind, category: required.category, centrality: required.centrality,
      mapping_status: outcome === 'matched' ? 'mapped' : outcome, outcome, text_required: required.text_required,
      expected_text: required.text_required ? required.expected.text : null, observed_text: observed?.text ?? null,
      parser_coordinate_mapping: observed?.parser_coordinate_mapping ?? 'unmapped', source_locator: observed?.source_locator ?? null, fields };
  });
  const field_obligations = reference.field_obligations.map(item => ({ ...item, outcome: units.find(u => u.record_id === item.record_id)?.fields[item.field]?.outcome ?? 'missing' }));
  const metricsFor = items => ({ denominator: items.length, matched: items.filter(i => i.outcome === 'matched').length,
    missing: items.filter(i => i.outcome === 'missing').length, mismatch: items.filter(i => i.outcome === 'mismatch').length,
    ambiguous: items.filter(i => i.outcome === 'ambiguous').length, unmapped: items.filter(i => i.outcome === 'unmapped').length,
    accuracy: items.length ? items.filter(i => i.outcome === 'matched').length / items.length : null });
  const all = [...units, ...field_obligations];
  return { units, field_obligations, metrics: metricsFor(units), category_metrics: categories.map(c => ({ category: c,
    ...metricsFor(all.filter(i => i.category === c)), disposition: reference.scope.category_dispositions.find(d => d.category === c).disposition,
    reason: reference.scope.category_dispositions.find(d => d.category === c).reason })),
    text_metrics: metricsFor(units.filter(u => u.text_required)), structure_field_metrics: metricsFor(units.flatMap(u => Object.values(u.fields))),
    critical_missing: all.filter(u => u.centrality === 'central' && u.outcome !== 'matched').map(u => u.evidence_id ?? u.record_id) };
}

function compareRuns(input = {}) {
  const errors = [];
  if (!input || typeof input !== 'object') input = {};
  if (Object.hasOwn(input, 'goldManifest')) errors.push('OFFICE_REFERENCE_AND_GOLD_MUTUALLY_EXCLUSIVE');
  for (const run of [input.baselineRun, input.candidateRun]) errors.push(...validateOfficeOriginalRun(run).errors);
  const representation=input.baselineRun?.profile===OFFICE_REPRESENTATION_PROFILE||input.candidateRun?.profile===OFFICE_REPRESENTATION_PROFILE;
  const real = input.baselineRun?.profile === 'paper03_real_office_pilot' || input.candidateRun?.profile === 'paper03_real_office_pilot'||representation;
  errors.push(...(representation?validateOfficeRepresentationReference(input.referenceManifest):real?validateOfficeRealPilotReference(input.referenceManifest):validateOfficeOriginalReference(input.referenceManifest)).errors);
  const { baselineRun: baseline, candidateRun: candidate, referenceManifest: reference, comparisonPolicy: policy, candidateDescriptor: descriptor } = input;
  if (!errors.length) {
    if (baseline.side !== 'baseline' || candidate.side !== 'candidate' || baseline.format !== candidate.format || reference.format !== candidate.format
      || !same(baseline.source, candidate.source) || !same(reference.source, candidate.source)) errors.push('OFFICE_SOURCE_SCOPE_MISMATCH');
    if (policy?.location_contract !== OFFICE_CONTRACT || policy.method_identity !== candidate.construction_proof.method_identity
      || descriptor?.method_identity !== policy.method_identity || policy.reference_identity !== reference.reference_identity
      || candidate.construction_proof.reference_identity !== reference.reference_identity || baseline.construction_proof.reference_identity !== reference.reference_identity
      || !same(candidate.construction_proof, baseline.construction_proof)
      || reference.check.source_identity !== fingerprint(candidate.source)
      || reference.check.method_identity !== policy.method_identity
      || candidate.construction_proof.parser.source_sha256 !== candidate.source.sha256
      || candidate.construction_proof.authorization_identity !== reference.acceptance.authorization_fingerprint
      || descriptor.independent_backend !== false || descriptor.scientific_eligible !== false
      || descriptor.method !== (representation?OFFICE_REPRESENTATION_METHOD:real?OFFICE_REAL_METHOD:hybridMethod)
      || descriptor.authorization_fingerprint !== reference.acceptance.authorization_fingerprint
      || !same(reference.records.map(r => r.expected), candidate.construction_proof.source.records)) errors.push('OFFICE_METHOD_BINDING_MISMATCH');
  }
  if(real && !errors.length && (baseline.profile!==candidate.profile || candidate.profile!==reference.profile
    || candidate.construction_proof.check_fingerprint!==reference.acceptance.check_fingerprint
    || !same(candidate.construction_proof.centralities,reference.records.map(r=>r.centrality)))) errors.push('OFFICE_REAL_METHOD_MISMATCH');
  const result = { schema_version: 'phase21-reference-comparison-office-original-1.0', reference_kind: representation?'accepted_assisted_source_representation_pilot':real?'accepted_assisted_source_verified_pilot':'accepted_assisted_synthetic',
    scientific_eligible: false, independent_backend: false, status: 'not_comparable', comparison_identity: null, errors: [...new Set(errors)] };
  if (errors.length) return result;
  result.baseline = scoreRun(baseline, reference); result.candidate = scoreRun(candidate, reference);
  result.status = result.candidate.critical_missing.length || result.candidate.metrics.matched !== result.candidate.metrics.denominator ? 'rejected' : 'compared';
  Object.assign(result, { source_identity: fingerprint(candidate.source), baseline_run_fingerprint: fingerprint(baseline), candidate_run_fingerprint: fingerprint(candidate),
    reference_manifest_fingerprint: fingerprint(reference), comparison_policy_fingerprint: fingerprint(policy), candidate_descriptor_fingerprint: fingerprint(descriptor),
    method_identity: policy.method_identity, reference_method: reference.method, original_required_records: reference.records.length,
    physical_page_accuracy: null, physical_page_reason: 'DOCX physical pages unknown; XLSX uses source cells; no physical-page inference.',
    scientific_acceptance: 'not_assessed', limitations: ['Nonblind assisted synthetic reference; shared reader and source records, not independent gold.',
      'Source-derived structure agreement proves calculation consistency, not independent accuracy.', 'Missing parser footnote and hidden-cell text remain missing.',
      'XLSX text coincidence never establishes parser coordinates.', 'No new original ZIP/XML read or MinerU run; historical source parts not reread.',
      'Approval JSON fingerprints do not authenticate a platform signature; P20-E12 remains unverified.'] });
  if(real) result.limitations=['Nonblind current source-facing assisted review; parser access used; shared reader/source records, not independent gold.',
    'Raw XML is text/structure evidence, not visual layout verification.','Hybrid structure is source-only; missing parser text stays missing.',
    'XLSX numeric/text matches do not establish cell coordinates.','Only two selected members; 20 other data members and six locks unread.',
    'No whole-paper reference adoption or scientific handoff; P20-E12 remains unverified.'];
  if(representation)Object.assign(result,{evaluation_scope:'source_representation_fidelity',representation_verified:true,computation_verified:false,
    retained_scientific_uncertainties:clone(reference.retained_scientific_uncertainties),formula_cache_metric_scope:'serialized_field_fidelity_only_not_formula_evaluation_or_cache_validity',
    current_review_scientific_uncertainties:clone(reference.current_review_scientific_uncertainties),current_review_issues:clone(reference.current_review_issues),current_review_limitations:clone(reference.current_review_limitations),
    current_review_computational_assessment:clone(reference.current_review_computational_assessment),reviewed_method_identity:reference.reviewed_method_identity,current_consumption_method_identity:reference.current_consumption_method_identity,
    scientific_acceptance:'not_assessed'});
  result.comparison_identity = fingerprint(result);
  return result;
}

export function compareOfficeOriginalRuns(input = {}) {
  if(input?.candidateRun?.profile===OFFICE_HTML_PROFILE||input?.baselineRun?.profile===OFFICE_HTML_PROFILE)return compareHtmlRuns(input);
  try { return compareRuns(input); } catch { return {schema_version:'phase21-reference-comparison-office-original-1.0',reference_kind:'accepted_assisted_synthetic',
    scientific_eligible:false,independent_backend:false,status:'not_comparable',comparison_identity:null,errors:['OFFICE_COMPARISON_INPUT_INVALID']}; }
}

async function cli() {
  await requireOfficeOriginalWriteAuthority();
  const args = process.argv.slice(2);
  const method = args[args.indexOf('--qualify') + 1];
  const format = args[args.indexOf('--format') + 1];
  if (!args.includes('--qualify') || !['docx','xlsx'].includes(format)) fail('OFFICE_CLI_ARGUMENTS_REQUIRED');
  const before = await validateOfficeSavedConsumptionContext({ ...contextPaths, manifestPath: path.resolve(method) });
  if (!before.ok) fail(before.errors[0]);
  const input = await buildOfficeOriginalComparisonInputs({ format, context: before, persist: true });
  const { compareParserRuns } = await import('./parser-comparison.mjs');
  const result = compareParserRuns(input);
  if (result.status === 'not_comparable') fail(result.errors.join(','));
  const after = await validateOfficeSavedConsumptionContext(before);
  if (!after.ok || before.method_identity !== after.method_identity) fail('OFFICE_METHOD_BINDING_MISMATCH');
  for (const [name, value] of [['BASELINE',input.baselineRun],['CANDIDATE',input.candidateRun],['COMPARISON-INPUTS',input],['COMPARISON',result]]) await save(`${name}-${format}.json`, value);
  await requireOfficeOriginalWriteAuthority();
  await appendFile(path.join(root, output, 'TESTS.txt'), `\nCLI ${process.argv.slice(1).join(' ')}\n${JSON.stringify({status: result.status, identity: result.comparison_identity, baseline: result.baseline.metrics, candidate: result.candidate.metrics})}\n`);
  console.log(JSON.stringify({ format, status: result.status, comparison_identity: result.comparison_identity, baseline: result.baseline.metrics, candidate: result.candidate.metrics }));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli().catch(error => { console.error(error.message); process.exitCode = 1; });
