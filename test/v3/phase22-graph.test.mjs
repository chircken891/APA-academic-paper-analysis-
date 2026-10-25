import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { fingerprintV3Json as hash } from '../../scripts/v3/semantic-package-validator.mjs';
import { PHASE22_REGIONS } from '../../scripts/v3/phase22-render-context.mjs';
import { PHASE22_COMMIT_PATH, phase22GenerationPaths, getIndexManagedBinding, readCommittedGeneration } from '../../scripts/v3/phase22-active-version.mjs';
import { buildGraphProposal } from '../../scripts/v3/phase22-graph.mjs';
import { createTopicFixture, publishTopicFixture } from './helpers/topic-fixtures.mjs';
import { readingFirstPublicationFixture, applyReadingFirstFixture } from './helpers/reading-first-publication-fixtures.mjs';
import { applyBilingualPublication } from '../../scripts/v3/phase22-publication.mjs';
const digest = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
const h = hash({ synthetic: true });

async function graphFixture(t, { empty = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'phase22-graph-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = { en: 'Wiki/sources/current-v3.en.md', 'zh-CN': 'Wiki/sources/current-v3.zh-CN.md' };
  const v3 = { paper_id:'current-v3',run_id:'run-v3',analysis_revision:'revision-v3',core_hash:h,pipeline_version:'3.0',
    basis_fingerprint:h,context_fingerprint:h,view_fingerprints:{en:h,'zh-CN':h},paths };
  const generation = {schema_version:'phase22/active-index-1.0',kind:'active',generation_id:'graph-g1',evidence_mode:'synthetic',papers:[],objects:[],shared_nodes:[]};
  const files = new Map();
  const note = fm => Buffer.from('---\n'+YAML.stringify(fm)+'---\n'+PHASE22_REGIONS.map(id=>
    '<!-- AUTO:START '+id+' -->\n## '+id+'\nSynthetic graph fixture '+id+'\n<!-- AUTO:END '+id+' -->').join('\n\n')+'\n\n## Personal Notes\nprivate\n');
  if (!empty) {
    generation.papers.push(v3);
    for (const language of ['en','zh-CN']) {
      const bytes = note({ type:'paper',pipeline_version:'3.0',rendering_profile:'phase22-managed-note-1.0',
        paper_id:v3.paper_id,run_id:v3.run_id,analysis_revision:v3.analysis_revision,language,core_fingerprint:h,
        basis_fingerprint:h,context_fingerprint:h,view_fingerprint:h,evidence_mode:'synthetic',review_ready:false,
        alternate_language_path:paths[language==='en'?'zh-CN':'en'] });
      files.set(paths[language], bytes);
      generation.objects.push({path:paths[language],kind:'v3-note',sha256:getIndexManagedBinding(bytes).managedHash});
    }
    const v2Path='Wiki/sources/current v2.md',v2Bytes=note({type:'paper',title:'Current V2 orphan',pipeline_version:'2.5',graph_scope:'v2-canonical'});
    files.set(v2Path,v2Bytes);
    for(const [entity_id,path] of [['method','Wiki/methods/shared.md'],['orphan','Wiki/concepts/orphan [a](b)+.md']]) {
      const bytes=Buffer.from('---\ntype: concept\npipeline_version: "3.0"\ngraph_scope: v3-candidate\n---\nA legitimate committed support node.');
      files.set(path,bytes);generation.objects.push({path,kind:'support',sha256:digest(bytes)});generation.shared_nodes.push({entity_id,path});
    }
  }
  const excluded=['Wiki/sources/current v2.md','Wiki/sources/replaced-v2.md','Wiki/sources/old-v3.zh-CN.md','Wiki/sources/half-package.zh-CN.md','Wiki/concepts/legacy.md'];
  for(const path of excluded)files.set(path,Buffer.from('Historical or uncommitted graph fixture; immutable.'));
  const index={schema_version:'phase22/active-index-1.0',kind:'index',generation_id:generation.generation_id,evidence_mode:'synthetic',active_fingerprint:hash(generation),
    documents:generation.papers.flatMap(p=>Object.entries(p.paths).flatMap(([language,path])=>
      getIndexManagedBinding(files.get(path),{pipelineVersion:p.pipeline_version}).regions.map(region=>({
        id:hash({path,section:region.id}),paper_id:p.paper_id,run_id:p.run_id,analysis_revision:p.analysis_revision,core_hash:p.core_hash,pipeline_version:p.pipeline_version,
        language,path,section_id:region.id,span_id:'section:'+region.id,unit_ids:[],anchor:null,content:region.content,aliases:'',title:''
      }))))};
  generation.index_manifest=index.documents.map(doc=>({id:doc.id,sha256:hash(doc)}));
  index.active_fingerprint=hash(generation);
  const pathsForGeneration=phase22GenerationPaths(generation.generation_id),activeBytes=Buffer.from(JSON.stringify(generation)),indexBytes=Buffer.from(JSON.stringify(index));
  files.set(pathsForGeneration.active,activeBytes);files.set(pathsForGeneration.index,indexBytes);
  const marker={schema_version:'phase22/active-index-1.0',kind:'commit',status:'COMMITTED',generation_id:generation.generation_id,evidence_mode:'synthetic',
    active:{path:pathsForGeneration.active,sha256:digest(activeBytes)},index:{path:pathsForGeneration.index,sha256:digest(indexBytes)},
    approval:{review_hash:h,output_inventory_hash:h,evidence_mode:'synthetic'}};
  files.set(PHASE22_COMMIT_PATH,Buffer.from(JSON.stringify(marker)));
  const configPath='.obsidian/graph.json',configBytes=Buffer.from('{"search":"original","showOrphans":true}');
  files.set(configPath,configBytes);
  for(const [path,bytes] of files){ await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),bytes); }
  const activeSnapshot=await readCommittedGeneration({vaultRoot:root});assert.equal(activeSnapshot.ok,true,JSON.stringify(activeSnapshot));
  const inventory=[...files.keys()].filter(path=>path.startsWith('Wiki/')).map(path=>({path}));
  return {root,activeSnapshot,inventory,paths,files,configPath,configBytes,excluded};
}
function filterRegex(filter) {
  assert.ok(filter.startsWith('path:/')&&filter.endsWith('/'),filter);
  return new RegExp(filter.slice(6,-1));
}

test('V3-only graph includes current Chinese/shared/orphans and excludes English/history/replaced/half packages',async t=>{
  const f=await graphFixture(t),before=new Map(await Promise.all([...f.files.keys()].map(async path=>[path,await readFile(join(f.root,path))])));
  const proposal=buildGraphProposal({activeSnapshot:f.activeSnapshot,entityInventory:f.inventory});
  assert.deepEqual(proposal.expectedNodes,['Wiki/concepts/orphan [a](b)+.md','Wiki/methods/shared.md',f.paths['zh-CN']].sort());
  assert.deepEqual(proposal.excludedNodes,[...f.excluded,f.paths.en].sort());
  assert.equal(proposal.logicalPaperCount,1);assert.equal(proposal.nativeNodeCount,3);
  assert.equal(proposal.showOrphans,true);assert.equal(proposal.hideUnresolved,true);
  assert.deepEqual(proposal.expectedLanguageLinks,[{paper_id:'current-v3',from:f.paths['zh-CN'],to:f.paths.en},{paper_id:'current-v3',from:f.paths.en,to:f.paths['zh-CN']}]);
  assert.equal(proposal.native_gui,'not_run');assert.equal(proposal.production_config,'not_switched');
  for(const [path,bytes]of before)assert.deepEqual(await readFile(join(f.root,path)),bytes,path);
});

for (const sourceLanguage of ['en', 'zh-CN']) {
  test(`source-language graph selects ${sourceLanguage} original and excludes its translation`, async t => {
    const f = await readingFirstPublicationFixture(t, { controlOptions: { sourceLanguage } });
    assert.equal((await applyBilingualPublication(applyReadingFirstFixture(f))).status, 'committed');
    const activeSnapshot = await readCommittedGeneration({ vaultRoot: f.vaultRoot });
    assert.equal(activeSnapshot.ok, true, JSON.stringify(activeSnapshot.errors));
    const paper = activeSnapshot.generation.papers[0];
    const original = paper.paths[sourceLanguage], translation = paper.paths[sourceLanguage === 'en' ? 'zh-CN' : 'en'];
    const inventory = activeSnapshot.generation.objects.filter(row => row.path.endsWith('.md')).map(({ path }) => ({ path }));
    const proposal = buildGraphProposal({ activeSnapshot, entityInventory: inventory });
    assert.deepEqual(proposal.expectedNodes, [...activeSnapshot.generation.shared_nodes.map(row => row.path), original].sort());
    assert.ok(proposal.excludedNodes.includes(translation));
    assert.ok(original.startsWith('Wiki/sources/'));
    assert.ok(translation.startsWith('Wiki/translations/'));
    assert.equal(filterRegex(proposal.filter).test(original), true);
    assert.equal(filterRegex(proposal.filter).test(translation), false);
    assert.deepEqual(proposal.expectedLanguageLinks, [
      { paper_id: paper.paper_id, from: paper.paths['zh-CN'], to: paper.paths.en },
      { paper_id: paper.paper_id, from: paper.paths.en, to: paper.paths['zh-CN'] },
    ]);
    assert.throws(() => buildGraphProposal({ activeSnapshot,
      entityInventory: inventory.filter(row => row.path !== original) }), /P22_GRAPH_INVENTORY_INCOMPLETE/);
  });
}

test('filter escapes regex metacharacters and Windows separators, and is exact for every positive/negative path',async t=>{
  const f=await graphFixture(t),windows=f.inventory.map(item=>({path:item.path.replaceAll('/','\\')}));
  const proposal=buildGraphProposal({activeSnapshot:f.activeSnapshot,entityInventory:windows}),regex=filterRegex(proposal.filter);
  for(const path of proposal.expectedNodes)assert.equal(regex.test(path),true,path);
  for(const path of [...proposal.excludedNodes,'Wiki/concepts/orphan ab.md','prefix/Wiki/methods/shared.md','Wiki/methods/shared.md.backup','Wiki/sources/current-v3.zh-CN.md.extra'])assert.equal(regex.test(path),false,path);
});
test('empty committed collection proposes an empty graph without broad fallback',async t=>{
  const f=await graphFixture(t,{empty:true}),p=buildGraphProposal({activeSnapshot:f.activeSnapshot,entityInventory:f.inventory});
  assert.deepEqual(p.expectedNodes,[]);assert.equal(p.logicalPaperCount,0);assert.equal(filterRegex(p.filter).test('Wiki/sources/arbitrary.md'),false);
});

test('committed topics enter the graph as separate nodes without increasing the paper count', async t => {
  const fixture = await createTopicFixture(t);
  const activeSnapshot = await publishTopicFixture(fixture);
  const topic = activeSnapshot.generation.topics[0];
  const extras = ['Wiki/topics/uncommitted.md', 'Wiki/topics/old-revision.md'];
  const entityInventory = [...activeSnapshot.generation.objects.filter(row => row.path.startsWith('Wiki/') && row.path.endsWith('.md')),
    ...extras.map(path => ({ path }))].map(({ path }) => ({ path }));
  const before = await readFile(join(fixture.vaultRoot, PHASE22_COMMIT_PATH));
  const proposal = buildGraphProposal({ activeSnapshot, entityInventory });
  assert.ok(proposal.expectedNodes.includes(topic.path));
  assert.equal(proposal.logicalPaperCount, 2);
  assert.equal(proposal.logicalTopicCount, 1);
  assert.equal(proposal.nativeNodeCount, activeSnapshot.generation.papers.length + activeSnapshot.generation.shared_nodes.length + 1);
  for (const path of extras) {
    assert.ok(proposal.excludedNodes.includes(path));
    assert.equal(filterRegex(proposal.filter).test(path), false);
  }
  assert.equal(proposal.production_config, 'not_switched');
  assert.deepEqual(await readFile(join(fixture.vaultRoot, PHASE22_COMMIT_PATH)), before);
});
test('uncommitted snapshots, absent expected members, colliding inventory and changed pointer reject',async t=>{
  const f=await graphFixture(t);
  assert.throws(()=>buildGraphProposal({activeSnapshot:JSON.parse(JSON.stringify(f.activeSnapshot)),entityInventory:f.inventory}),/P22_SNAPSHOT_NOT_COMMITTED/);
  assert.throws(()=>buildGraphProposal({activeSnapshot:f.activeSnapshot,entityInventory:f.inventory.filter(i=>i.path!==f.paths['zh-CN'])}),/P22_GRAPH_INVENTORY_INCOMPLETE/);
  assert.throws(()=>buildGraphProposal({activeSnapshot:f.activeSnapshot,entityInventory:[...f.inventory,{path:f.paths['zh-CN'].toUpperCase()}]}),/P22_GRAPH_PATH_COLLISION/);
  await writeFile(join(f.root,PHASE22_COMMIT_PATH),'{"status":"promoting"}');
  assert.throws(()=>buildGraphProposal({activeSnapshot:f.activeSnapshot,entityInventory:f.inventory}),/P22_SNAPSHOT_NOT_CURRENT/);
});



test('V3 committed reader refuses a rehashed legacy shared node',async t=>{
  const f=await graphFixture(t),generation=structuredClone(f.activeSnapshot.generation),index=structuredClone(f.activeSnapshot.index);
  const path='Wiki/methods/shared.md',old=await readFile(join(f.root,path));
  const legacy=Buffer.from(old.toString('utf8').replace('pipeline_version: "3.0"','pipeline_version: 2.5'));
  generation.objects.find(row=>row.path===path).sha256=digest(legacy);
  index.active_fingerprint=hash(generation);
  const paths=phase22GenerationPaths(generation.generation_id),activeBytes=Buffer.from(JSON.stringify(generation)),indexBytes=Buffer.from(JSON.stringify(index));
  const marker=JSON.parse(await readFile(join(f.root,PHASE22_COMMIT_PATH)));
  marker.active.sha256=digest(activeBytes);marker.index.sha256=digest(indexBytes);
  for(const [target,bytes]of [[path,legacy],[paths.active,activeBytes],[paths.index,indexBytes],[PHASE22_COMMIT_PATH,Buffer.from(JSON.stringify(marker))]])await writeFile(join(f.root,target),bytes);
  const rejected=await readCommittedGeneration({vaultRoot:f.root,maxAttempts:1});
  assert.equal(rejected.ok,false);assert.equal(rejected.errors[0].code,'P22_SUPPORT_VERSION_INVALID');
  assert.deepEqual(await readFile(join(f.root,path)),legacy);
});
