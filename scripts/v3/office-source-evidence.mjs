import { readFile, lstat, writeFile, mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createPhase21ContractValidator } from './phase21-contract-loader.mjs';
import { canonicalizeV3Json } from './semantic-package-validator.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const scopeRoot = 'Eval/apa-v3/phase21/office-source-evidence-scope-r1';
const nativeRoot = 'Eval/apa-v3/phase21/native-office-qualification-r1';
const comparisonRoot = 'Eval/apa-v3/phase21/office-original-comparison-r1';
const implementationRoot = 'Eval/apa-v3/phase21/office-formal-ingress-scope-r1';
const readerPath = path.join(root, 'scripts/v3/office-source-evidence-reader.py');
const modulePath = fileURLToPath(import.meta.url);
const python = 'D:/文献知识库/.runtime/mineru/venv/Scripts/python.exe';
const sha = data => 'sha256:' + createHash('sha256').update(data).digest('hex');
const same = (a, b) => canonicalizeV3Json(a) === canonicalizeV3Json(b);
const schemaId = 'phase21/office-source-evidence-r1';
const schema = {
  $id: schemaId, type: 'object', additionalProperties: false,
  required: ['format', 'source', 'scope', 'parts', 'records', 'reader', 'evidence_level'],
  properties: {
    format: { enum: ['docx', 'xlsx'] }, source: { type: 'object' }, scope: { type: 'object' },
    parts: { type: 'array', items: { type: 'object' } }, records: { type: 'array', items: { type: 'object' } },
    reader: { type: 'object' }, evidence_level: { const: 'local_source_only' },
  },
};
const validatorPromise = createPhase21ContractValidator({ schemas: [schema] });
const fail = code => { throw new Error(code); };
const jsonFile = async name => JSON.parse(await readFile(path.join(root, name), 'utf8'));

export const OFFICE_REAL_ROOT = 'Eval/apa-v3/phase21/paper03-office-pilot-r1';
const realPrepared = 'Eval/apa-v3/phase21/paper03-office-pilot-scope-r1';
export const OFFICE_REAL_METHOD = 'office-current-mineru-source-metadata-hybrid-paper03-r1';
export const OFFICE_REPRESENTATION_ROOT = 'Eval/apa-v3/phase21/paper03-office-representation-r2';
export const OFFICE_REPRESENTATION_PROFILE = 'paper03_office_representation_r2';
export const OFFICE_REPRESENTATION_METHOD = 'office-current-mineru-source-metadata-hybrid-paper03-representation-r2';
const representationPrepared = 'Eval/apa-v3/phase21/paper03-office-representation-scope-r2';
const reviewedMethodBinding={path:`${OFFICE_REPRESENTATION_ROOT}/REVIEWED-METHOD-01.json`,bytes:11960,sha256:'sha256:7d779af4fcc472cf0fa3e4fb5bc08d0bfe64f9d33974a93c025b62d6b768bbfe',method_identity:'sha256:daf125884a0e9d08d7a178d653e646ca8a51f4f0735a0eef697feb91691d70ed'};
const digest = value => sha(Buffer.from(canonicalizeV3Json(value)));

export const OFFICE_HTML_ROOT='Eval/apa-v3/phase21/paper03-office-html-mapping-r3';
export const OFFICE_HTML_PROFILE='paper03_office_html_mapping_r3';
export const OFFICE_HTML_METHOD='office-current-mineru-html-structure-hybrid-paper03-r3';
const htmlPrepared='Eval/apa-v3/phase21/paper03-office-html-mapping-scope-r3';

/** Limited strict parser for the cached table vocabulary; no layout or span expansion. */
export function parseOfficeHtmlStructure(html) {
  if(typeof html!=='string'||Buffer.byteLength(html)>524288)fail('OFFICE_HTML_LIMIT');
  const decode=s=>s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(_,v)=>v[0]==='#'?String.fromCodePoint(v[1].toLowerCase()==='x'?parseInt(v.slice(2),16):Number(v.slice(1))):({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:'\u00a0'})[v.toLowerCase()]);
  const stack=[];let table;const counters=new Map();let unsupported=false;
  for(const token of html.match(/<[^>]*>|[^<]+/g)??[]) {
    if(token.startsWith('<')) {
      const close=/^<\/([a-z]+)\s*>$/i.exec(token);
      if(close){if(stack.at(-1)?.tag!==close[1].toLowerCase())fail('OFFICE_HTML_MALFORMED');stack.pop();continue;}
      const start=/^<([a-z]+)([^>]*)>$/i.exec(token);if(!start)fail('OFFICE_HTML_MALFORMED');
      const tag=start[1].toLowerCase();if(!['table','tr','td','th','p','strong','b','em','i','span','br'].includes(tag))fail('OFFICE_HTML_UNSUPPORTED');
      const attrs={};for(const m of start[2].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s/]+))/g)){if(Object.hasOwn(attrs,m[1]))fail('OFFICE_HTML_DUPLICATE_ATTRIBUTE');attrs[m[1].toLowerCase()]=decode(m[2]??m[3]??m[4]);}
      const parent=stack.at(-1);if(tag==='table'&&parent)unsupported=true;
      if(tag==='tr'&&parent?.tag!=='table'||['td','th'].includes(tag)&&parent?.tag!=='tr'||tag==='p'&&!['td','th'].includes(parent?.tag))fail('OFFICE_HTML_MALFORMED');
      const key=(parent?.path??'')+'/'+tag;const ordinal=(counters.get(key)??0)+1;counters.set(key,ordinal);
      const node={tag,path:(parent?.path??'')+'/'+tag+'['+ordinal+']',parent_path:parent?.path??null,attrs,text:''};
      if(tag==='table'){if(table)fail('OFFICE_HTML_MULTIPLE_TABLES');table={...node,rows:[]};node.rows=table.rows;}
      if(tag==='tr'){node.cells=[];parent.rows.push(node);}
      if(['td','th'].includes(tag)){node.paragraphs=[];parent.cells.push(node);if(Object.hasOwn(attrs,'colspan')||Object.hasOwn(attrs,'rowspan'))unsupported=true;}
      if(tag==='p')parent.paragraphs.push(node);
      if(tag==='br'){const paragraph=stack.findLast(n=>n.tag==='p');if(paragraph)paragraph.text+='\n';continue;}
      stack.push(node);
    } else {const paragraph=stack.findLast(n=>n.tag==='p');if(paragraph)paragraph.text+=decode(token);else if(token.trim())fail('OFFICE_HTML_TEXT_OUTSIDE_PARAGRAPH');}
  }
  if(stack.length||!table)fail('OFFICE_HTML_MALFORMED');
  for(const row of table.rows)for(const cell of row.cells)cell.text=cell.paragraphs.map(p=>p.text).join('');
  return {table_path:table.path,attrs:table.attrs,rows:table.rows,unsupported};
}

async function htmlAuthorityData() {
  const bytes=await readFile(path.join(root,htmlPrepared,'INPUTS.json'));const inputs=JSON.parse(bytes);
  const authorizationBytes=await readFile(path.join(root,OFFICE_HTML_ROOT,'AUTHORIZATION.json'));const authorization=JSON.parse(authorizationBytes);const run=await jsonFile(`${OFFICE_HTML_ROOT}/RUN.json`);
  if(sha(bytes)!=='sha256:8e91be3e33b1d96890299a8b2f27d737675439fb2eb8084d7c02eb36fe130914'||authorization.proposal_id!=='P21-PAPER03-OFFICE-HTML-MAPPING-r3'||authorization.status!=='approved'||authorization.authorized!==true
    ||authorization.inputs_sha256!==sha(bytes)||authorization.scope_sha256!=='sha256:914b5571e1cb3acf9a99894a04ba8c6e37badb4db2b42cd29bc9b1482c02356d'
    ||sha(await readFile(path.join(root,htmlPrepared,'PROPOSAL.md')))!==authorization.scope_sha256||authorization.output_root!==OFFICE_HTML_ROOT||path.resolve(authorization.vault_root)!==path.resolve(root)
    ||!same(authorization.owned_source_files,inputs.owned_source_files)||!same(authorization.limits,inputs.limits)||!same(authorization.scope,inputs.scope)
    ||run.authorized!==true||run.proposal_id!==authorization.proposal_id||run.scope_sha256!==authorization.scope_sha256||run.inputs_sha256!==authorization.inputs_sha256)fail('OFFICE_HTML_AUTHORITY_REQUIRED');
  return {inputs,authorization,authorizationBytes,run};
}
export async function requireOfficeHtmlAuthority() {
  const a=await htmlAuthorityData();
  const clock={max_minutes:60,started_at:'2026-10-09T19:13:53Z',deadline_at:'2026-10-09T20:13:53Z'};
  if(!same(a.authorization.budget,clock)||a.run.budget.max_minutes!==60||a.run.budget.started_at!==clock.started_at||a.run.budget.deadline_at!==clock.deadline_at)fail('OFFICE_HTML_CLOCK_MISMATCH');
  if(a.run.status!=='running'||a.run.budget.status!=='active'||a.run.budget.closed_at)fail('OFFICE_HTML_BUDGET_CLOSED');
  if(Date.now()<Date.parse(clock.started_at)||Date.now()>=Date.parse(clock.deadline_at))fail('OFFICE_HTML_BUDGET_EXPIRED');
  return a;
}
export async function writeOfficeHtmlArtifact(name,value,{exclusive=true} = {}) {
  await requireOfficeHtmlAuthority();const target=path.resolve(root,OFFICE_HTML_ROOT,name);
  if(!target.startsWith(path.resolve(root,OFFICE_HTML_ROOT)+path.sep)||path.basename(target)==='AUTHORIZATION.json')fail('OFFICE_HTML_WRITE_PATH_REQUIRED');
  await mkdir(path.dirname(target),{recursive:true});await requireOfficeHtmlAuthority();await writeFile(target,Buffer.isBuffer(value)?value:JSON.stringify(value,null,2)+'\n',{flag:exclusive?'wx':'w'});
}
export async function createOfficeR2SavedRegressionContext({strictCode=false} = {}) {
  try {
    const a=await htmlAuthorityData();const allBindings=a.inputs.bindings.filter(b=>!a.inputs.owned_source_files.includes(b.path));
    const codeBindings=allBindings.filter(b=>b.path.startsWith('scripts/')||b.path.startsWith('test/'));
    // The active plan is not cached source data and grants no authority in this read-only context.
    const planningBindings=allBindings.filter(b=>b.path==='.planning/phases/21-parser-evaluation-and-multi-agent-proof-chain/21-07-PLAN.md');
    const bindings=strictCode?allBindings:allBindings.filter(b=>!codeBindings.includes(b)&&!planningBindings.includes(b));
    for(const b of bindings){const bytes=await readFile(path.resolve(root,b.path));if(bytes.length!==b.bytes||sha(bytes)!==b.sha256)fail('OFFICE_HTML_CACHE_DRIFT:'+b.path);}
    const current_code_bindings=[];
    if(!strictCode)for(const b of codeBindings){const bytes=await readFile(path.resolve(root,b.path));current_code_bindings.push({path:b.path,bytes:bytes.length,sha256:sha(bytes)});}
    const current_planning_bindings=[];
    if(!strictCode)for(const b of planningBindings){const bytes=await readFile(path.resolve(root,b.path));current_planning_bindings.push({path:b.path,bytes:bytes.length,sha256:sha(bytes)});}
    return {ok:true,errors:[],profile:'r2_saved_data_regression_readonly',bindings,...(!strictCode?{historical_code_bindings:codeBindings,current_code_bindings,historical_planning_bindings:planningBindings,current_planning_bindings}:{}),permissions:{persist:false,original_source_read:false,parser:false}};
  }catch(e){return {ok:false,errors:[e.message]};}
}
export async function prepareOfficeHtmlMethod() {
  const a=await requireOfficeHtmlAuthority();const bindings=[];
  for(const name of a.inputs.owned_source_files){const bytes=await readFile(path.join(root,name));bindings.push({path:name,bytes:bytes.length,sha256:sha(bytes)});}
  const method={profile:OFFICE_HTML_PROFILE,method:OFFICE_HTML_METHOD,authorization_sha256:sha(a.authorizationBytes),scope_sha256:a.authorization.scope_sha256,inputs_sha256:a.authorization.inputs_sha256,clock:a.authorization.budget,bindings,
    historical_code_bindings:a.inputs.bindings.filter(b=>a.inputs.owned_source_files.includes(b.path)),cache_bindings:a.inputs.bindings.filter(b=>!a.inputs.owned_source_files.includes(b.path))};
  await requireOfficeHtmlAuthority();await writeFile(path.join(root,OFFICE_HTML_ROOT,'METHOD.json'),JSON.stringify(method,null,2)+'\n');return validateOfficeHtmlContext();
}
export async function validateOfficeHtmlContext() {
  try {
    const a=await htmlAuthorityData();const readonly=await createOfficeR2SavedRegressionContext({strictCode:true});if(!readonly.ok)fail(readonly.errors[0]);
    const method=await jsonFile(`${OFFICE_HTML_ROOT}/METHOD.json`);
    if(method.profile!==OFFICE_HTML_PROFILE||method.method!==OFFICE_HTML_METHOD||method.authorization_sha256!==sha(a.authorizationBytes)||method.scope_sha256!==a.authorization.scope_sha256||method.inputs_sha256!==a.authorization.inputs_sha256
      ||!same(method.bindings.map(b=>b.path),a.inputs.owned_source_files)||!same(method.cache_bindings,readonly.bindings))fail('OFFICE_HTML_METHOD_MISMATCH');
    for(const b of method.bindings){const bytes=await readFile(path.join(root,b.path));if(bytes.length!==b.bytes||sha(bytes)!==b.sha256)fail('OFFICE_HTML_CODE_DRIFT');}
    return {ok:true,errors:[],profile:OFFICE_HTML_PROFILE,manifest:method,method_identity:digest(method),authorization_identity:sha(a.authorizationBytes)};
  }catch(e){return {ok:false,errors:[e.message]};}
}
export async function readOfficeHtmlObservedStructure(format) {
  if(!['docx','xlsx'].includes(format))fail('OFFICE_FORMAT_REQUIRED');
  const context=await validateOfficeHtmlContext();if(!context.ok)fail(context.errors[0]);
  const p=`${OFFICE_REAL_ROOT}/${format}-output/input/office/input_content_list.json`;const bytes=await readFile(path.join(root,p));const content=JSON.parse(bytes);
  const tables=content.map((b,n)=>({block:b,index:n})).filter(x=>typeof x.block.table_body==='string');
  if(tables.length!==1)fail('OFFICE_HTML_UNIQUE_TABLE_REQUIRED');
  const html=tables[0].block.table_body;const tree=parseOfficeHtmlStructure(html);
  const pythonTree=await invokeReader(['--html-structure'],JSON.stringify([html]));
  if(!same(tree,pythonTree[0]))fail('OFFICE_HTML_READER_RECONSTRUCTION_MISMATCH');
  return {format,output_path:p,output_sha256:sha(bytes),html_sha256:sha(Buffer.from(html)),json_pointer:`/${tables[0].index}/table_body`,block_index:tables[0].index,tree,reader_sha256:sha(await readFile(readerPath)),native_parser_coordinate_mapping:'unmapped',physical_page:null};
}

/** Every real action rechecks the one approved, absolute clock. */
export async function requireOfficeRealPilotAuthority() {
  const authorizationBytes = await readFile(path.join(root, OFFICE_REAL_ROOT, 'AUTHORIZATION.json'));
  const authorization = JSON.parse(authorizationBytes);
  const inputBytes = await readFile(path.join(root, realPrepared, 'INPUTS.json'));
  const inputs = JSON.parse(inputBytes);
  const run = await jsonFile(`${OFFICE_REAL_ROOT}/RUN.json`);
  if (authorization.proposal_id !== 'P21-PAPER03-OFFICE-PILOT-r1' || authorization.authorized !== true || authorization.status !== 'approved'
    || authorization.scope_sha256 !== 'sha256:93cc7b994b9ebcb03260d3a6bfa0c279231e72361a01d7fd95c54190a8723f11'
    || authorization.inputs_sha256 !== 'sha256:a2a8588a40f23aa13d1d3b42fe94ac8afada93979b925fb6dd12cafbe7130ed3'
    || sha(inputBytes) !== authorization.inputs_sha256 || sha(await readFile(path.join(root, realPrepared, 'PROPOSAL.md'))) !== authorization.scope_sha256
    || authorization.output_root !== OFFICE_REAL_ROOT || path.resolve(authorization.vault_root) !== path.resolve(root)
    || !same(authorization.owned_source_files, inputs.owned_source_files) || !same(authorization.source_scope, {archive:inputs.archive,members:inputs.members})
    || !same(authorization.limits, inputs.limits) || !same(authorization.runtime, inputs.runtime)
    || run.authorized !== true || run.proposal_id !== authorization.proposal_id || run.scope_sha256 !== authorization.scope_sha256 || run.inputs_sha256 !== authorization.inputs_sha256
    || authorization.reference_authorization?.kind !== 'accepted_assisted_source_verified_pilot' || authorization.reference_authorization.independent_gold !== false
    || authorization.reference_authorization.nonblind !== true || authorization.reference_authorization.shared_reader !== true
    || authorization.scientific_handoff_authorized !== false || authorization.whole_paper_reference_adoption !== false) fail('OFFICE_REAL_AUTHORITY_REQUIRED');
  const clock = authorization.budget;
  if (clock.max_minutes !== 120 || clock.started_at !== '2026-10-09T16:13:46Z' || clock.deadline_at !== '2026-10-09T18:13:46Z'
    || run.budget.max_minutes !== 120 || run.budget.started_at !== clock.started_at || run.budget.deadline_at !== clock.deadline_at) fail('OFFICE_REAL_CLOCK_MISMATCH');
  if (run.budget.status !== 'active' || run.budget.closed_at || run.status !== 'running') fail('OFFICE_REAL_BUDGET_CLOSED');
  if (Date.now() < Date.parse(clock.started_at) || Date.now() >= Date.parse(clock.deadline_at)) fail('OFFICE_REAL_BUDGET_EXPIRED');
  for (const binding of inputs.bindings.filter(b => !inputs.owned_source_files.includes(b.path))) {
    const bytes = await readFile(path.resolve(root, binding.path));
    if (bytes.length !== binding.bytes || sha(bytes) !== binding.sha256) fail(`OFFICE_REAL_CONTROL_DRIFT:${binding.path}`);
  }
  return {authorization, authorizationBytes, inputs, run};
}

export async function writeOfficeRealPilotArtifact(name, data, {exclusive = true} = {}) {
  await requireOfficeRealPilotAuthority();
  const target = path.resolve(root, OFFICE_REAL_ROOT, name);
  if (!target.startsWith(path.resolve(root, OFFICE_REAL_ROOT) + path.sep)) fail('OFFICE_REAL_PATH_MISMATCH');
  await mkdir(path.dirname(target), {recursive:true});
  await writeFile(target, Buffer.isBuffer(data) ? data : JSON.stringify(data,null,2)+'\n', {flag:exclusive?'wx':'w'});
}

export async function createOfficeSyntheticRegressionContext({snapshotManifestPath} = {}) {
  try {
    const expected = path.join(root,realPrepared,'INPUTS.json');
    if (path.resolve(snapshotManifestPath ?? '') !== expected) fail('OFFICE_REGRESSION_PATH_MISMATCH');
    const bytes = await readFile(expected);
    if (sha(bytes) !== 'sha256:a2a8588a40f23aa13d1d3b42fe94ac8afada93979b925fb6dd12cafbe7130ed3') fail('OFFICE_REGRESSION_MANIFEST_MISMATCH');
    const inputs = JSON.parse(bytes);
    const snapshot = inputs.synthetic_regression_snapshot;
    const bindings = snapshot.bindings ?? snapshot.files;
    if (!Array.isArray(bindings) || bindings.length !== 25) fail('OFFICE_REGRESSION_SNAPSHOT_MISMATCH');
    for (const binding of bindings) {
      const data = await readFile(path.resolve(root,binding.path));
      if (data.length !== (binding.bytes ?? binding.byte_length) || sha(data) !== binding.sha256) fail('OFFICE_REGRESSION_DATA_DRIFT');
    }
    const historical = await jsonFile(`${comparisonRoot}/METHOD.json`);
    const current_code_bindings = [];
    for (const name of inputs.owned_source_files) {
      const data = await readFile(path.join(root,name));
      current_code_bindings.push({path:name,bytes:data.length,sha256:sha(data)});
    }
    return {ok:true,errors:[],profile:'synthetic_saved_regression_readonly',snapshotManifestPath:expected,
      manifest:historical, method_identity:digest({snapshot,current_code_bindings}), current_code_bindings,
      historical_code_bindings:historical.bindings.filter(b=>historical.code_paths.includes(b.path)),
      authorization_identity:sha(await readFile(path.join(root,comparisonRoot,'AUTHORIZATION.json'))),
      permissions:{persist:false,source_read:false,parser:false,reference_acceptance:false}};
  } catch(error) { return {ok:false,errors:[error.message]}; }
}

export async function validateOfficeRealPilotContext({manifestPath,authorizationRecordPath,profile} = {}) {
  try {
    if (['synthetic_saved_regression_readonly',OFFICE_REPRESENTATION_PROFILE,OFFICE_HTML_PROFILE,'r2_saved_data_regression_readonly'].includes(profile)) fail('OFFICE_REAL_PROFILE_REQUIRED');
    if (path.resolve(manifestPath ?? '') !== path.join(root,OFFICE_REAL_ROOT,'METHOD.json')
      || path.resolve(authorizationRecordPath ?? '') !== path.join(root,OFFICE_REAL_ROOT,'AUTHORIZATION.json')) fail('OFFICE_REAL_PATH_MISMATCH');
    const manifest = JSON.parse(await readFile(manifestPath,'utf8'));
    // Read only the exact controlled METHOD metadata, then check the live clock and all controls.
    // This catches expiry during metadata access before any source IO or qualification write.
    const authority = await requireOfficeRealPilotAuthority();
    if (manifest.profile !== 'paper03_real_office_pilot' || manifest.method !== OFFICE_REAL_METHOD
      || manifest.authorization_sha256 !== sha(authority.authorizationBytes) || manifest.scope_sha256 !== authority.authorization.scope_sha256
      || manifest.inputs_sha256 !== authority.authorization.inputs_sha256 || !same(manifest.code_paths,authority.inputs.owned_source_files)) fail('OFFICE_REAL_METHOD_MISMATCH');
    for (const b of manifest.bindings) {
      const bytes = await readFile(path.resolve(root,b.path));
      if (bytes.length !== b.bytes || sha(bytes) !== b.sha256) fail(`OFFICE_REAL_BINDING_DRIFT:${b.path}`);
    }
    await requireOfficeRealPilotAuthority();
    return {ok:true,errors:[],profile:manifest.profile,manifest,authorization:authority.authorization,
      method_identity:digest(manifest),authorization_identity:sha(authority.authorizationBytes),manifestPath,authorizationRecordPath};
  } catch(error) { return {ok:false,errors:[error.message]}; }
}

/** Cache-only approval validation; an approved clock never grants original-source access. */
async function representationAuthorityData() {
  const inputBytes=await readFile(path.join(root,representationPrepared,'INPUTS.json'));
  const inputs=JSON.parse(inputBytes);
  const authorizationBytes=await readFile(path.join(root,OFFICE_REPRESENTATION_ROOT,'AUTHORIZATION.json'));
  const authorization=JSON.parse(authorizationBytes);
  const run=await jsonFile(`${OFFICE_REPRESENTATION_ROOT}/RUN.json`);
  if(sha(inputBytes)!=='sha256:5715e4f119200074319c60f77b0291e15b1542b53ce9b74a0ec6cd4233d05834'
    ||authorization.proposal_id!=='P21-PAPER03-OFFICE-REPRESENTATION-r2'||authorization.authorized!==true||authorization.status!=='approved'
    ||authorization.scope_sha256!=='sha256:668e79e75348045aeff44d7017af5ad5d41d5541092d289ee3ef894305cfaa04'
    ||authorization.inputs_sha256!==sha(inputBytes)||sha(await readFile(path.join(root,representationPrepared,'PROPOSAL.md')))!==authorization.scope_sha256
    ||authorization.output_root!==OFFICE_REPRESENTATION_ROOT||authorization.source_root!==OFFICE_REAL_ROOT||path.resolve(authorization.vault_root)!==path.resolve(root)
    ||!same(authorization.owned_source_files,inputs.owned_source_files)||!same(authorization.limits,inputs.limits)||!same(authorization.scope,inputs.scope)
    ||!same(authorization.budget,{max_minutes:75,started_at:'2026-10-09T18:01:11Z',deadline_at:'2026-10-09T19:16:11Z'})
    ||authorization.reference_authorization?.kind!=='accepted_assisted_source_representation_pilot'
    ||authorization.reference_authorization.evaluation_scope!=='source_representation_fidelity'||authorization.reference_authorization.computation_verified!==false
    ||authorization.reference_authorization.retain_scientific_uncertainties!==true||authorization.reference_authorization.actual_new_source_review_required!==true
    ||authorization.reference_authorization.nonblind!==true||authorization.reference_authorization.shared_reader!==true||authorization.reference_authorization.independent_gold!==false
    ||authorization.scientific_handoff_authorized!==false||authorization.whole_paper_reference_adoption!==false
    ||run.proposal_id!==authorization.proposal_id||run.authorized!==true||run.scope_sha256!==authorization.scope_sha256||run.inputs_sha256!==authorization.inputs_sha256)fail('OFFICE_REPRESENTATION_AUTHORITY_REQUIRED');
  return {inputs,authorization,authorizationBytes,run};
}

export async function requireOfficeRepresentationAuthority() {
  const authority=await representationAuthorityData();const {run,authorization}=authority;
  if(run.budget.max_minutes!==75||run.budget.started_at!==authorization.budget.started_at||run.budget.deadline_at!==authorization.budget.deadline_at)fail('OFFICE_REPRESENTATION_CLOCK_MISMATCH');
  if(run.budget.status!=='active'||run.budget.closed_at||run.status!=='running')fail('OFFICE_REPRESENTATION_BUDGET_CLOSED');
  if(Date.now()<Date.parse(run.budget.started_at)||Date.now()>=Date.parse(run.budget.deadline_at))fail('OFFICE_REPRESENTATION_BUDGET_EXPIRED');
  return authority;
}

export async function writeOfficeRepresentationArtifact(name,value) {
  await requireOfficeRepresentationAuthority();
  const target=path.resolve(root,OFFICE_REPRESENTATION_ROOT,name);
  if(!target.startsWith(path.resolve(root,OFFICE_REPRESENTATION_ROOT)+path.sep)||path.basename(target)==='AUTHORIZATION.json')fail('OFFICE_REPRESENTATION_WRITE_PATH_REQUIRED');
  await mkdir(path.dirname(target),{recursive:true});
  await requireOfficeRepresentationAuthority();
  await writeFile(target,Buffer.isBuffer(value)?value:JSON.stringify(value,null,2)+'\n',{flag:'wx'});
}

export async function prepareOfficeRepresentationMethod() {
  const authority=await requireOfficeRepresentationAuthority();
  const bindings=[];
  for(const name of authority.inputs.owned_source_files){const bytes=await readFile(path.join(root,name));bindings.push({path:name,bytes:bytes.length,sha256:sha(bytes),kind:'current_consumption_code'});}
  const method={profile:OFFICE_REPRESENTATION_PROFILE,method:OFFICE_REPRESENTATION_METHOD,code_paths:authority.inputs.owned_source_files,bindings,
    authorization_sha256:sha(authority.authorizationBytes),scope_sha256:authority.authorization.scope_sha256,inputs_sha256:authority.authorization.inputs_sha256,clock:authority.authorization.budget,
    cache_bindings:authority.inputs.bindings.filter(b=>!authority.inputs.owned_source_files.includes(b.path)),cached_outputs:authority.inputs.cached_output_registrations,
    source_root:OFFICE_REAL_ROOT,output_root:OFFICE_REPRESENTATION_ROOT,reference_kind:'accepted_assisted_source_representation_pilot',evaluation_scope:'source_representation_fidelity',scientific_eligible:false,
    historical_code_bindings:authority.inputs.bindings.filter(b=>authority.inputs.owned_source_files.includes(b.path)),
    reviewed_method:reviewedMethodBinding,derivation:'Actual-advice binding validation and tests tightened; same eight reviewed materials/schema/meaning; original request identity preserved.'};
  await requireOfficeRepresentationAuthority();
  await writeFile(path.join(root,OFFICE_REPRESENTATION_ROOT,'METHOD.json'),JSON.stringify(method,null,2)+'\n');
  return validateOfficeRepresentationContext({manifestPath:path.join(root,OFFICE_REPRESENTATION_ROOT,'METHOD.json'),authorizationRecordPath:path.join(root,OFFICE_REPRESENTATION_ROOT,'AUTHORIZATION.json')});
}

export async function validateOfficeRepresentationContext({manifestPath,authorizationRecordPath,profile} = {}) {
  try {
    if(profile && profile!==OFFICE_REPRESENTATION_PROFILE)fail('OFFICE_REPRESENTATION_PROFILE_REQUIRED');
    if(path.resolve(manifestPath??'')!==path.join(root,OFFICE_REPRESENTATION_ROOT,'METHOD.json')||path.resolve(authorizationRecordPath??'')!==path.join(root,OFFICE_REPRESENTATION_ROOT,'AUTHORIZATION.json'))fail('OFFICE_REPRESENTATION_PATH_REQUIRED');
    const authority=await representationAuthorityData();
    const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
    if(manifest.profile!==OFFICE_REPRESENTATION_PROFILE||manifest.method!==OFFICE_REPRESENTATION_METHOD||manifest.authorization_sha256!==sha(authority.authorizationBytes)
      ||manifest.scope_sha256!==authority.authorization.scope_sha256||manifest.inputs_sha256!==authority.authorization.inputs_sha256
      ||!same(manifest.code_paths,authority.inputs.owned_source_files)||!same(manifest.cache_bindings,authority.inputs.bindings.filter(b=>!authority.inputs.owned_source_files.includes(b.path)))
      ||!same(manifest.cached_outputs,authority.inputs.cached_output_registrations)||!same(manifest.clock,authority.authorization.budget)
      ||!same(manifest.bindings.map(b=>b.path),manifest.code_paths))fail('OFFICE_REPRESENTATION_METHOD_MISMATCH');
    if(!same(manifest.reviewed_method,reviewedMethodBinding))fail('OFFICE_REPRESENTATION_REVIEWED_METHOD_MISMATCH');
    const reviewedBytes=await readFile(path.join(root,reviewedMethodBinding.path));
    const reviewed=JSON.parse(reviewedBytes);
    if(reviewedBytes.length!==reviewedMethodBinding.bytes||sha(reviewedBytes)!==reviewedMethodBinding.sha256||digest(reviewed)!==reviewedMethodBinding.method_identity)fail('OFFICE_REPRESENTATION_REVIEWED_METHOD_MISMATCH');
    const {bindings:reviewedCode,...reviewedContext}=reviewed;
    const {bindings:currentCode,reviewed_method,derivation,...currentContext}=manifest;
    if(!same(reviewedContext,currentContext))fail('OFFICE_REPRESENTATION_REVIEWED_SCOPE_CHANGED');
    const all=[...manifest.bindings,...manifest.cache_bindings,...manifest.cached_outputs.flatMap(g=>g.inventory.map(b=>({...b,path:path.join(g.output_root,b.path)})))];
    for(const binding of all){const bytes=await readFile(path.resolve(root,binding.path));if(bytes.length!==(binding.bytes??binding.byte_length)||sha(bytes)!==binding.sha256)fail('OFFICE_REPRESENTATION_CACHE_DRIFT:'+binding.path);}
    return {ok:true,errors:[],profile:OFFICE_REPRESENTATION_PROFILE,manifest,authorization:authority.authorization,method_identity:digest(manifest),reviewed_method_identity:reviewedMethodBinding.method_identity,authorization_identity:sha(authority.authorizationBytes),manifestPath,authorizationRecordPath,permissions:{original_source_read:false,parser:false,write_root:OFFICE_REPRESENTATION_ROOT}};
  }catch(error){return {ok:false,errors:[error.message]};}
}

export async function readOfficeRepresentationCache({format,context} = {}) {
  const current=await validateOfficeRepresentationContext(context);if(!current.ok)fail(current.errors[0]);
  if(!['docx','xlsx'].includes(format))fail('OFFICE_FORMAT_REQUIRED');
  return {source:await jsonFile(`${OFFICE_REAL_ROOT}/SOURCE-EVIDENCE-${format}.json`),raw:await jsonFile(`${OFFICE_REAL_ROOT}/RAW-SOURCE-PARTS-${format}.json`),parser:await jsonFile(`${OFFICE_REAL_ROOT}/PARSER-EVIDENCE-${format}.json`)};
}

export async function extractOfficeRealPilotMembers() {
  const {inputs} = await requireOfficeRealPilotAuthority();
  const archive = await readFile(path.join(root,inputs.archive.path));
  if (archive.length !== inputs.archive.bytes || sha(archive) !== inputs.archive.registered_sha256) fail('OFFICE_REAL_ARCHIVE_MISMATCH');
  const result = await invokeReader(['--archive-member',path.join(root,inputs.archive.path),path.join(root,inputs.archive.inventory_ref),JSON.stringify(inputs.members)]);
  await requireOfficeRealPilotAuthority();
  await writeOfficeRealPilotArtifact('MEMBER-INVENTORY.json',result.inventory);
  const lineage = [];
  for (const member of result.members) {
    const relative = `${OFFICE_REAL_ROOT}/members/input.${member.format}`;
    const data = Buffer.from(member.base64,'base64');
    if (sha(data) !== member.sha256 || data.length !== member.byte_length) fail('OFFICE_REAL_MEMBER_MISMATCH');
    await writeOfficeRealPilotArtifact(`members/input.${member.format}`,data);
    lineage.push({...member,base64:undefined,path:relative,parent_document_id:inputs.archive.document_id,archive_sha256:sha(archive),kind:'source'});
  }
  await writeOfficeRealPilotArtifact('MEMBER-LINEAGE.json',lineage);
  return lineage;
}

export async function readOfficeRealPilotSourceEvidence({format,context} = {}) {
  const current = await validateOfficeRealPilotContext(context);
  if (!current.ok) fail(current.errors[0]);
  const {inputs} = await requireOfficeRealPilotAuthority();
  const selection = inputs.members.find(m=>m.format===format);
  if (!selection) fail('OFFICE_REAL_FORMAT_REQUIRED');
  const lineage = (await jsonFile(`${OFFICE_REAL_ROOT}/MEMBER-LINEAGE.json`)).find(m=>m.format===format);
  const sourcePath = path.join(root,lineage.path);
  const sourceBytes = await readFile(sourcePath);
  if (sha(sourceBytes) !== selection.registered_sha256 || sourceBytes.length !== selection.registered_bytes) fail('OFFICE_REAL_MEMBER_MISMATCH');
  const scope = {real_pilot:true,max_xml_bytes:selection.max_xml_bytes,max_source_records:selection.max_source_records,
    ...(format==='xlsx'?{ranges:[{sheet_index:0,sheet_name:'Supplementary Table 9',range:'A1:C25'}]}:{coverage:'whole_selected_body_and_referenced_footnotes'})};
  const result = await invokeReader([sourcePath,format,JSON.stringify(scope)]);
  await requireOfficeRealPilotAuthority();
  const after = await validateOfficeRealPilotContext(context);
  if (!after.ok || after.method_identity !== current.method_identity) fail('OFFICE_REAL_METHOD_MISMATCH');
  result.source = {...result.source,path:lineage.path,member_path:lineage.member_path,parent_document_id:lineage.parent_document_id,archive_sha256:lineage.archive_sha256};
  result.reader = {identity:'office-source-evidence-reader',version:'real-pilot-r1',code_sha256:sha(await readFile(readerPath)),consumer_code_sha256:sha(await readFile(modulePath)),runtime_path:python,dependencies:'python_standard_library_only'};
  result.evidence_level = 'local_source_only';
  const raw = {format,source:result.source,reader:result.reader,parts:result.raw_parts};
  delete result.raw_parts;
  if (result.records.length>150 || (format==='xlsx' && result.records.filter(r=>r.kind==='workbook_cell').length!==75)) fail('OFFICE_REAL_SCOPE_MISMATCH');
  await writeOfficeRealPilotArtifact(`RAW-SOURCE-PARTS-${format}.json`,raw);
  await writeOfficeRealPilotArtifact(`SOURCE-EVIDENCE-${format}.json`,result);
  return result;
}

export async function readOfficeRealPilotParserEvidence({format,context} = {}) {
  const current = await validateOfficeRealPilotContext(context);
  if (!current.ok) fail(current.errors[0]);
  const parser = await parserEvidence(format,OFFICE_REAL_ROOT);
  const source = await jsonFile(`${OFFICE_REAL_ROOT}/SOURCE-EVIDENCE-${format}.json`);
  if (parser.source_sha256 !== source.source.sha256) fail('OFFICE_REAL_PARSER_SOURCE_MISMATCH');
  return parser;
}

/** Component byte check; callers enforce production paths before reading bytes. */
export function validateOfficeBoundFileBytes({ binding, bytes } = {}) {
  if (!binding || !Buffer.isBuffer(bytes)) return { ok: false, errors: ['OFFICE_BOUND_BYTES_REQUIRED'] };
  const source = binding.kind === 'source' || /(?:synthetic\.(?:docx|xlsx)|input_origin\.(?:docx|xlsx))$/.test(binding.path ?? '');
  const code = source ? 'OFFICE_SOURCE_HASH_MISMATCH' : 'OFFICE_OUTPUT_HASH_MISMATCH';
  return bytes.length === (binding.bytes ?? binding.byte_length) && sha(bytes) === binding.sha256
    ? { ok: true, errors: [] } : { ok: false, errors: [code] };
}

/** Explicit current saved consumption, preserving historical reader identity. */
export async function validateOfficeSavedConsumptionContext({ manifestPath, authorizationRecordPath } = {}) {
  try {
    if (path.resolve(manifestPath ?? '') !== path.join(root, comparisonRoot, 'METHOD.json')
      || path.resolve(authorizationRecordPath ?? '') !== path.join(root, comparisonRoot, 'AUTHORIZATION.json')) fail('OFFICE_METHOD_PATH_MISMATCH');
    for (const target of [manifestPath, authorizationRecordPath]) {
      for (let current = path.resolve(target); current !== path.resolve(root); current = path.dirname(current)) {
        if ((await lstat(current)).isSymbolicLink()) fail('OFFICE_METHOD_PATH_MISMATCH');
      }
    }
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    const authorizationBytes = await readFile(authorizationRecordPath);
    const authorization = JSON.parse(authorizationBytes);
    const inputsBytes = await readFile(path.join(root, implementationRoot, 'INPUTS.json'));
    const approved = JSON.parse(inputsBytes);
    if (authorization.authorized !== true || authorization.status !== 'approved'
      || authorization.proposal_id !== 'P21-OFFICE-ORIGINAL-COMPARISON-r1'
      || authorization.scope_sha256 !== 'sha256:b6bfcb1a8eb600e0d12dc9f8c3f7f7789a86899fe5629f0e881264fcb8d5f40b'
      || authorization.inputs_sha256 !== 'sha256:809b447f40aa78e6d876a1c57904807f21ac6939e5c2a1c0445f40d1a0695c88'
      || sha(inputsBytes) !== authorization.inputs_sha256
      || sha(await readFile(path.join(root, implementationRoot, 'IMPLEMENTATION.md'))) !== authorization.scope_sha256
      || manifest.authorization_sha256 !== sha(authorizationBytes)
      || manifest.scope_sha256 !== authorization.scope_sha256 || manifest.inputs_sha256 !== authorization.inputs_sha256
      || manifest.method !== 'office-saved-mineru-source-metadata-hybrid-1.0') fail('OFFICE_METHOD_BINDING_MISMATCH');
    const owned = authorization.owned_source_files.map(item => item.path);
    if (!same(manifest.code_paths, owned) || !same(manifest.clock, authorization.budget)
      || authorization.output_root !== comparisonRoot || path.resolve(authorization.vault_root ?? '') !== path.resolve(root)
      || authorization.reference_authorization?.corpus_id !== 'phase21-office-original-synthetic-r1'
      || authorization.reference_authorization?.limited_acceptance_authorized !== true
      || !same(authorization.reference_authorization.paper_ids, ['synthetic-docx','synthetic-xlsx'])) fail('OFFICE_METHOD_BINDING_MISMATCH');
    const expectedPaths = [...approved.bindings.map(item => item.path), ...owned.filter(name => !approved.bindings.some(b => b.path === name))];
    if (!Array.isArray(manifest.bindings) || !same(manifest.bindings.map(b => b.path), expectedPaths)) fail('OFFICE_METHOD_BINDING_MISMATCH');
    for (const binding of manifest.bindings) {
      const original = approved.bindings.find(b => b.path === binding.path);
      if (!owned.includes(binding.path) && !same(binding, original)) fail('OFFICE_METHOD_BINDING_MISMATCH');
      const absolute = path.resolve(root, binding.path);
      if (!absolute.startsWith(path.resolve(root) + path.sep)) fail('OFFICE_METHOD_PATH_MISMATCH');
      for (let current = absolute; current !== path.resolve(root); current = path.dirname(current)) {
        if ((await lstat(current)).isSymbolicLink()) fail('OFFICE_METHOD_PATH_MISMATCH');
      }
      const check = validateOfficeBoundFileBytes({ binding, bytes: await readFile(absolute) });
      if (!check.ok) fail(check.errors[0]);
    }
    return { ok: true, errors: [], manifest, authorization, method_identity: sha(Buffer.from(canonicalizeV3Json(manifest))),
      authorization_identity: sha(authorizationBytes), manifestPath, authorizationRecordPath };
  } catch (error) { return { ok: false, errors: [error.message] }; }
}

function invokeReader(args, stdin, limits = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, ['-B', readerPath, ...args], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', error = '', outputBytes = 0, aborted = false;
    const timer = limits.deadline ? setTimeout(() => { aborted = true; child.kill(); reject(new Error('WHOLE_PAPER_BUDGET_EXPIRED')); }, Math.max(1, limits.deadline-Date.now())) : null;
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { outputBytes += Buffer.byteLength(chunk); if(outputBytes > (limits.maxOutputBytes ?? Infinity)) { aborted = true; child.kill(); reject(new Error('WHOLE_PAPER_RECORD_LIMIT')); } else output += chunk; });
    child.stderr.on('data', chunk => { error += chunk; });
    child.on('error', error => { if(timer)clearTimeout(timer);reject(error); });
    child.on('close', code => {
      if(timer)clearTimeout(timer);
      if(aborted)return;
      if (code !== 0) return reject(new Error(`SOURCE_READ_FAILED:${error.trim()}`));
      try { resolve(JSON.parse(output)); } catch { reject(new Error('SOURCE_READER_INVALID_JSON')); }
    });
    child.stdin.end(stdin ?? '');
  });
}

/** Exact registered sources only; legacy paper03 authority remains valid in its original scope. */
export async function readWholePaperOfficeEvidence({sourcePath,source,scope,context} = {}) {
  const empty = errors => ({ok:false,evidence:null,read_accounting:null,errors});
  let lock, lockPath, scopePath;
  try {
    if(!context?.manifestPath||!context?.authorizationRecordPath||!context?.runPath)fail('WHOLE_PAPER_AUTHORITY_REQUIRED');
    const authBytes=await readFile(context.authorizationRecordPath), auth=JSON.parse(authBytes);
    const manifest=JSON.parse(await readFile(context.manifestPath));
    const outputRoot=path.resolve(auth.output_root??'');
    if(auth.profile!=='whole-paper-source-1.0'||auth.authorized!==true||manifest.profile!==auth.profile||manifest.authorization_sha256!==sha(authBytes)
      ||[context.manifestPath,context.authorizationRecordPath,context.runPath].some(p=>path.dirname(path.resolve(p))!==outputRoot))fail('WHOLE_PAPER_AUTHORITY_REQUIRED');
    const entry=auth.source_reads?.find(e=>path.resolve(e.path)===path.resolve(sourcePath??''));
    if(!entry||!same(entry.source,source)||!same(entry.scope,scope)||!same(manifest.source_reads,auth.source_reads)
      ||scope.profile!==auth.profile||!['docx','xlsx'].includes(scope.format)||source.format!==scope.format)fail('WHOLE_PAPER_SOURCE_SCOPE_MISMATCH');
    if(auth.scope==='synthetic-only'&&!path.resolve(sourcePath).startsWith(outputRoot+path.sep))fail('WHOLE_PAPER_SOURCE_SCOPE_MISMATCH');
    if(!['synthetic-only','paper03-wholepaper-real','registered-wholepaper-real'].includes(auth.scope))fail('WHOLE_PAPER_AUTHORITY_REQUIRED');
    const readRun=async()=>{
      const run=JSON.parse(await readFile(context.runPath));
      if(run.budget?.status!=='active'||run.status!=='running')fail('WHOLE_PAPER_BUDGET_CLOSED');
      const start=Date.parse(run.budget.started_at),end=Date.parse(run.budget.deadline_at);
      if(!Number.isFinite(start)||!Number.isFinite(end)||start>Date.now()||Date.now()>=end)fail('WHOLE_PAPER_BUDGET_EXPIRED');
      if(end<=start||end-start>240*60000||run.budget.started_at!==auth.budget?.started_at||run.budget.deadline_at!==auth.budget?.deadline_at)fail('WHOLE_PAPER_BUDGET_MISMATCH');
      return run;
    };
    await readRun(); // No source or output IO before the authority and clock gates.
    lockPath=path.join(outputRoot,'.whole-paper-source.lock');
    try {lock=await open(lockPath,'wx');}catch(error){if(error.code==='EEXIST')fail('WHOLE_PAPER_SOURCE_BUSY');throw error;}
    let run=await readRun();
    const memberLimit=scope.max_xml_bytes??32*1024*1024;
    if(!Number.isSafeInteger(memberLimit)||memberLimit<=0||memberLimit>32*1024*1024)fail('WHOLE_PAPER_XML_LIMIT');
    const used=run.source_xml_bytes??0, passUsed=run.source_pass_xml_bytes??0, recordUsed=run.source_record_bytes??0;
    if(![used,passUsed,recordUsed].every(x=>Number.isSafeInteger(x)&&x>=0)||used+memberLimit>256*1024*1024||passUsed+memberLimit>64*1024*1024)fail('WHOLE_PAPER_XML_LIMIT');
    if(recordUsed>=512*1024*1024)fail('WHOLE_PAPER_RECORD_LIMIT');
    if((await lstat(sourcePath)).isSymbolicLink())fail('WHOLE_PAPER_SOURCE_SCOPE_MISMATCH');
    const bytes=await readFile(sourcePath);
    if(sha(bytes)!==source.source_sha256)fail('WHOLE_PAPER_SOURCE_BINDING_MISMATCH');
    // Reserve the declared read limit before invoking Python. An uncertain failure keeps the reservation.
    run.source_xml_bytes=used+memberLimit;run.source_pass_xml_bytes=passUsed+memberLimit;
    run.source_read_attempts=(run.source_read_attempts??0)+1;
    await writeFile(context.runPath,JSON.stringify(run,null,2)+'\n');
    scopePath=path.join(outputRoot,'.whole-paper-scope-'+randomUUID()+'.json');
    await writeFile(scopePath,JSON.stringify({...scope,max_xml_bytes:memberLimit}),{flag:'wx'});
    const evidence=await invokeReader(['--whole-paper-source',path.resolve(sourcePath),scopePath],undefined,{maxOutputBytes:256*1024*1024,deadline:Date.parse(run.budget.deadline_at)});
    await readRun();
    if(evidence.source?.sha256!==source.source_sha256||sha(await readFile(sourcePath))!==source.source_sha256)fail('WHOLE_PAPER_SOURCE_BINDING_MISMATCH');
    const xmlBytes=evidence.read_accounting?.xml_bytes, recordBytes=Buffer.byteLength(JSON.stringify(evidence));
    if(!Number.isSafeInteger(xmlBytes)||xmlBytes<0||xmlBytes>memberLimit)fail('WHOLE_PAPER_XML_LIMIT');
    if(recordBytes>256*1024*1024||recordUsed+recordBytes>512*1024*1024)fail('WHOLE_PAPER_RECORD_LIMIT');
    run.source_xml_bytes=used+xmlBytes;run.source_pass_xml_bytes=passUsed+xmlBytes;run.source_record_bytes=recordUsed+recordBytes;
    await writeFile(context.runPath,JSON.stringify(run,null,2)+'\n');
    evidence.source_binding=structuredClone(source);
    evidence.reader={profile:scope.profile,code_sha256:sha(await readFile(readerPath)),module_sha256:sha(await readFile(modulePath)),authority_sha256:sha(authBytes)};
    return {ok:true,evidence,read_accounting:{...evidence.read_accounting,record_bytes:recordBytes},errors:[]};
  }catch(error){return empty([error.message]);}
  finally {if(scopePath)await unlink(scopePath).catch(()=>{});if(lock){await lock.close();await unlink(lockPath).catch(()=>{});}}
}

/** All authority comes from the approved local manifest, never a submitted sidecar. */
async function controlledInputs(format) {
  if (!['docx', 'xlsx'].includes(format)) fail('OFFICE_FORMAT_REQUIRED');
  const inputs = await jsonFile(`${scopeRoot}/INPUTS.json`);
  const run = await jsonFile(`${scopeRoot}/RUN.json`);
  if (run.authorized !== true || run.proposal_id !== inputs.proposal_id || run.authorization?.scope_sha256 !== inputs.scope_document_sha256) fail('SCOPE_AUTHORITY_MISMATCH');
  const proposal = await readFile(path.join(root, scopeRoot, 'PROPOSAL.md'));
  if (sha(proposal) !== inputs.scope_document_sha256) fail('SCOPE_DOCUMENT_HASH_MISMATCH');
  for (const binding of inputs.bindings) {
    const actual = await readFile(path.resolve(root, binding.path));
    if (actual.length !== binding.bytes || sha(actual) !== binding.sha256) fail(`CONTROL_BINDING_MISMATCH:${binding.path}`);
  }
  if (inputs.runtime_python !== python) fail('SOURCE_RUNTIME_MISMATCH');
  return inputs;
}

export async function readOfficeSourceEvidence({ format } = {}) {
  const inputs = await controlledInputs(format);
  const selection = inputs.source_scope[format];
  const sourcePath = path.resolve(root, selection.path);
  const sourceRaw = await readFile(sourcePath);
  const scope = format === 'docx' ? { parts: selection.parts, coverage: selection.coverage } : { ranges: selection.ranges, coverage: selection.coverage };
  const readerBefore = await readFile(readerPath);
  const result = await invokeReader([sourcePath, format, JSON.stringify(scope)]);
  if (sha(await readFile(readerPath)) !== sha(readerBefore) || sha(await readFile(sourcePath)) !== sha(sourceRaw)) fail('SOURCE_READ_IDENTITY_DRIFT');
  if (result.source.sha256 !== sha(sourceRaw) || result.source.byte_length !== sourceRaw.length) fail('SOURCE_HASH_MISMATCH');
  result.source.path = selection.path;
  result.reader = { identity: 'office-source-evidence-reader', version: 'r1', code_sha256: sha(readerBefore),
    consumer_code_sha256: sha(await readFile(modulePath)), runtime_path: python, dependencies: 'python_standard_library_only' };
  result.evidence_level = 'local_source_only';
  return result;
}

export async function validateOfficeSourceEvidence(evidence, controlled) {
  const errors = [];
  const shape = (await validatorPromise).validate(schemaId, evidence);
  if (!shape.ok) return { ok: false, errors: ['SOURCE_EVIDENCE_SCHEMA_INVALID'] };
  if (!evidence || !controlled) return { ok: false, errors: [...errors, 'CONTROLLED_SOURCE_REQUIRED'] };
  for (const [key, code] of Object.entries({ source: 'SOURCE_IDENTITY_MISMATCH', reader: 'READER_IDENTITY_MISMATCH',
    scope: 'SOURCE_SELECTION_MISMATCH', parts: 'SOURCE_PART_HASH_MISMATCH', format: 'SOURCE_FORMAT_MISMATCH', evidence_level: 'SOURCE_ORIGIN_CLAIM_INVALID' })) {
    if (!same(evidence[key] ?? null, controlled[key] ?? null)) errors.push(code);
  }
  if (!same(evidence.records ?? null, controlled.records)) {
    const submitted = evidence.records ?? [];
    if (submitted.some((r, index) => !same(r.locator ?? null, controlled.records[index]?.locator ?? null))) errors.push('SOURCE_LOCATOR_MISMATCH');
    if (submitted.some(r => r.physical_page !== null)) errors.push('PHYSICAL_PAGE_CLAIM_INVALID');
    if (submitted.some(r => r.evidence_origin !== 'source_only')) errors.push('SOURCE_ORIGIN_CLAIM_INVALID');
    errors.push('SOURCE_RECORD_MISMATCH');
  }
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

async function parserEvidence(format, outputRootName = nativeRoot) {
  const packet = await jsonFile(`${outputRootName}/PACKET-${format}.json`);
  const observation = await jsonFile(`${outputRootName}/OBSERVATION-${format}.json`);
  const source = await readFile(packet.source.path);
  if (sha(source) !== packet.source.sha256 || packet.source.byte_length !== source.length) fail('PARSER_SOURCE_MISMATCH');
  if (observation.run_id !== packet.run_id || observation.output_path !== packet.allowed_output_root) fail('PARSER_RUN_MISMATCH');
  const outputRoot = path.resolve(packet.allowed_output_root);
  if ((await lstat(outputRoot)).isSymbolicLink()) fail('PARSER_OUTPUT_PATH_MISMATCH');
  const outputs = [];
  let contentBytes;
  for (const item of observation.output_inventory) {
    const full = path.resolve(outputRoot, item.path);
    if (!full.startsWith(outputRoot + path.sep)) fail('PARSER_OUTPUT_PATH_MISMATCH');
    for (let current = full; current !== outputRoot; current = path.dirname(current)) {
      if ((await lstat(current)).isSymbolicLink()) fail('PARSER_OUTPUT_PATH_MISMATCH');
    }
    const bytes = await readFile(full);
    if (bytes.length !== item.byte_length || sha(bytes) !== item.sha256) fail('PARSER_OUTPUT_HASH_MISMATCH');
    if (item.path.endsWith(`_origin.${format}`) && sha(bytes) !== packet.source.sha256) fail('PARSER_ORIGIN_MISMATCH');
    if (item.path === 'input/office/input_content_list.json') contentBytes = bytes;
    outputs.push({ ...item, path: path.relative(root, full).split(path.sep).join('/') });
  }
  const entry = outputs.find(o => o.path.endsWith('/input_content_list.json'));
  if (!entry) fail('PARSER_CONTENT_OUTPUT_MISSING');
  const content = JSON.parse(contentBytes.toString('utf8'));
  const tables = content.filter(block => typeof block.table_body === 'string').map(block => block.table_body);
  const readerBefore = sha(await readFile(readerPath));
  const tableUnits = await invokeReader(['--html-units'], JSON.stringify(tables));
  if (sha(await readFile(readerPath)) !== readerBefore) fail('SOURCE_READ_IDENTITY_DRIFT');
  let tableIndex = 0;
  const anchors = [];
  content.forEach((block, index) => {
    const base = { output_path: entry.path, output_sha256: entry.sha256, logical_group: block.page_idx ?? null,
      block_index: index, physical_page: null, coordinate_mapping: 'unmapped' };
    if (typeof block.text === 'string') anchors.push({ ...base, json_pointer: `/${index}/text`, text: block.text });
    if (typeof block.table_body === 'string') for (const unit of tableUnits[tableIndex++]) {
      anchors.push({ ...base, json_pointer: `/${index}/table_body`, ...unit });
    }
  });
  return { run_id: packet.run_id, backend: packet.backend, source_sha256: packet.source.sha256, outputs, anchors };
}

/** Exact complete units only; numeric coincidence never establishes a cell map. */
export function alignOfficeTextUnits(records, anchors) {
  const eligible = records.filter(r => ['paragraph', 'footnote', 'workbook_cell'].includes(r.kind) && typeof r.text === 'string' && r.text !== '');
  return eligible.map(record => {
    const hits = anchors.filter(a => a.text === record.text);
    const duplicates = eligible.filter(r => r.text === record.text).length;
    const sensitive = record.kind === 'workbook_cell' && (record.sheet.visibility !== 'visible' || record.formula.present);
    return { source_record_id: record.id, status: !hits.length ? 'not_observed_in_mineru' : hits.length > 1 || duplicates > 1 ? 'ambiguous' : 'unique_exact_text',
      links: hits.length === 1 && duplicates === 1 ? [hits[0]] : [],
      coordinate_mapping: 'unmapped', source_metadata: sensitive ? 'source_only' : 'source_only_locator' };
  });
}

export async function buildOfficeSourceEvidenceReview({ format, evidence, parser, candidateReview, consumptionContext } = {}) {
  try {
    if (!format || !evidence) return { ok: false, errors: ['SOURCE_EVIDENCE_REQUIRED'] };
    let savedContext;
    if (consumptionContext) {
      savedContext = consumptionContext.profile === 'synthetic_saved_regression_readonly'
        ? await createOfficeSyntheticRegressionContext(consumptionContext)
        : await validateOfficeSavedConsumptionContext(consumptionContext);
      if (!savedContext.ok) return savedContext;
    }
    const controlled = savedContext ? await jsonFile(`${scopeRoot}/SOURCE-EVIDENCE-${format}.json`) : await readOfficeSourceEvidence({ format });
    const validation = await validateOfficeSourceEvidence(evidence, controlled);
    if (!validation.ok) return validation;
    const observed = await parserEvidence(format);
    if (observed.source_sha256 !== controlled.source.sha256) fail('PARSER_SOURCE_MISMATCH');
    if (parser && !same(parser, observed)) {
      const errors = [];
      if (!same(parser.outputs, observed.outputs)) errors.push('PARSER_OUTPUT_BINDING_MISMATCH');
      if (!same(parser.anchors, observed.anchors)) errors.push('PARSER_ANCHOR_POINTER_MISMATCH');
      if (errors.length === 0) errors.push('PARSER_IDENTITY_MISMATCH');
      return { ok: false, errors };
    }
    const review = { format, evidence_level: savedContext ? 'new_saved_artifact_consumption' : 'local_source_vs_saved_parser', formal_comparison: false,
      scientific_acceptance: 'not_assessed', independent_second_backend: false,
      source_only: controlled, parser: observed, alignment: alignOfficeTextUnits(controlled.records, observed.anchors),
      metadata_observations: controlled.records.filter(r => ['footnote_reference', 'layout_break', 'workbook_cell', 'footnote'].includes(r.kind))
        .map(r => ({ source_record_id: r.id, origin: 'source_only', parser_metadata_status: 'not_observed_in_mineru', physical_page: null })),
      limitations: ['No physical DOCX pages inferred', 'No workbook cell coordinate map inferred from parser text',
        'Source-only formula/cache/hidden/footnote metadata does not repair parser scores', 'Not a formal SCI, comparison or workflow handoff'] };
    if (savedContext) review.consumption_identity = { method: savedContext.manifest.method, method_identity: savedContext.method_identity,
      historical_reader: controlled.reader, source_structure_read: 'not_replayed', current_consumer_sha256: sha(await readFile(modulePath)) };
    if (candidateReview && !same(candidateReview, review)) {
      const errors = [];
      if (candidateReview.formal_comparison !== false || candidateReview.independent_second_backend !== false || candidateReview.scientific_acceptance !== 'not_assessed') errors.push('FORMAL_COMPARISON_CLAIM_INVALID');
      if (!same(candidateReview.metadata_observations, review.metadata_observations)) errors.push('SOURCE_ONLY_OBSERVATION_CLAIM_INVALID');
      if (!same(candidateReview.alignment, review.alignment)) errors.push('ALIGNMENT_CLAIM_INVALID');
      return { ok: false, errors: errors.length ? errors : ['REVIEW_BINDING_MISMATCH'] };
    }
    return { ok: true, errors: [], review };
  } catch (error) { return { ok: false, errors: [error.message] }; }
}
