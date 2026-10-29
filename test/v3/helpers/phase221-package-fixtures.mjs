import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { collectLanguageSpans } from '../../../scripts/v3/phase22-language.mjs';
import { createOwnedArtifactBroker } from '../../../scripts/v3/owned-artifact-store.mjs';
import { acceptReaderQuantityEquivalence } from '../../../scripts/v3/phase221-display.mjs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readerReviewFixture, makeReaderReview } from './phase221-runtime-fixtures.mjs';
import { assessReaderReview } from '../../../scripts/v3/phase221-reading-review.mjs';
import { getReaderPresentationContent } from '../../../scripts/v3/phase221-presentation.mjs';
import { buildBilingualIndex } from '../../../scripts/v3/phase22-search.mjs';
import { buildBilingualReview } from '../../../scripts/v3/phase22-review.mjs';
import { canonicalizeV3Json, fingerprintV3Json as hash } from '../../../scripts/v3/semantic-package-validator.mjs';

export const sha = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');
export const jsonBytes = value => Buffer.from(canonicalizeV3Json(value) + '\n');

const readerQuantityFields = ['raw_precision', 'unit', 'denominator', 'groups', 'timepoint', 'analysis_set', 'metric_definition', 'uncertainty_type', 'uncertainty_value'];
function countScience(science){
 const q=science.scientific_details.quantities[0],unit=science.core.units[0];
 Object.assign(q,{raw_value:'2,001,140',raw_precision:'integer count as reported',unit:'cases',denominator:'100',groups:['A','B'],timepoint:'day 7',analysis_set:'Invented seedlings',metric_definition:'reported count'});
 unit.quantity[0]={name:q.metric_definition,value:2001140,unit:q.unit,denominator:100};
 for(const occurrence of q.source_occurrences){Object.assign(occurrence,Object.fromEntries(['raw_value',...readerQuantityFields].map(key=>[key,q[key]])));occurrence.raw_excerpt='Synthetic count 2,001,140.';science.scientific_details.source_blocks.find(block=>block.source_block_id===occurrence.source_block_id).text+='\n'+occurrence.raw_excerpt;}
 science.scientific_details.source_blocks[0].text+='\nSynthetic count 2,001,140 (2001140), day 7, A versus B, denominator 100.';
}
function countView(view,language,f){
 const unit=f.data.core.units[0];
 for(const {span} of collectLanguageSpans(view)){
  if(span.core_quantity_bindings.length){span.text=language==='en'?'Synthetic count 2001140 cases.':'合成计数2001140例。';const start=span.text.indexOf('2001140');span.core_quantity_bindings[0].token={start,end:start+7};}
  if(span.quantity_bindings.length){
   span.text=language==='en'?'Synthetic count 2,001,140 (2001140) cases; day 7.':'合成计数2,001,140（2001140）例；第7天。';
   let start=span.text.indexOf('2,001,140');span.quantity_bindings[0].token={start,end:start+9};start=span.text.indexOf('2001140');
   span.core_quantity_bindings=[{unit_id:unit.unit_id,quantity_index:0,quantity:structuredClone(unit.quantity[0]),...Object.fromEntries(['population','comparison','conditions','uncertainty'].map(key=>[key,structuredClone(unit[key])])),token:{start,end:start+7}}];
   if(!span.boundary_refs.includes(unit.unit_id))span.boundary_refs.push(unit.unit_id);
  }
 }
}
async function ownedCountProof({input,science,basis,context,views,artifactRoot,identity},id){
 const dependencies={basis:basis??input.original_review.basis_fingerprint,context:context??input.original_review.context_fingerprint,science:hash(science),core:hash(science.core),views:Object.fromEntries(Object.entries(views).map(([language,view])=>[language,hash(view)]))};
 const payload={schema_version:'phase221-quantity-equivalence-1.0',identity,dependencies,pairs:[]};
 for(const [language,view] of Object.entries(views))for(const row of collectLanguageSpans(view).filter(row=>row.span.quantity_bindings.length&&row.span.core_quantity_bindings.length)){
  const q=row.span.quantity_bindings[0],c=row.span.core_quantity_bindings[0];
  const fullIdentity={...Object.fromEntries(readerQuantityFields.map(key=>[key,structuredClone(q[key])])),...Object.fromEntries(['comparison','population','conditions','uncertainty'].map(key=>[key,structuredClone(c[key])])),qualifiers:{scientific:science.scientific_details.quantities.find(item=>item.quantity_id===q.quantity_id),core:science.core.units.find(item=>item.unit_id===c.unit_id)}};
  payload.pairs.push({language,section_id:row.section_id,paragraph_id:row.paragraph_id,span_id:row.span.span_id,scientific_binding:q,core_binding:c,scientific_identity:fullIdentity,core_identity:structuredClone(fullIdentity),source_refs:[fullIdentity.qualifiers.scientific.source_block_id],same_assertion:{judgment:'same',reason:'Synthetic owned Integrator binds both count spellings to the same assertion and full identity.'}});
 }
 const bytes=Buffer.from(JSON.stringify(payload)),path='proof/'+id+'.json',runId=identity.run_id;
 const binding={artifact_root:artifactRoot,artifact_id:id,owner_actor_id:'integrator',role:'integration',path,revision:'r1',payload_sha256:sha(bytes)};
 const broker=createOwnedArtifactBroker({control_actor_id:'controller',artifact_root:artifactRoot,authorized_bindings:[{run_id:runId,actor_id:'integrator',role:'integration',artifact_path:path,revision:'r1'}],run_controls:[{run_id:runId,phase221_quantity_equivalence:binding}]});
 await broker.artifactStore.commitOwnedArtifact({artifactRoot,dispatchContext:broker.dispatchContext,capability:broker.issueCapability({runId,actorId:'integrator',role:'integration',artifactPath:path,revision:'r1'}),expectedRevision:'r1',artifact:{artifact_id:id,content:bytes}});
 const integratorReceipt={artifactRoot,dispatchContext:broker.dispatchContext,runId,artifactId:id};
 return {capability:await acceptReaderQuantityEquivalence({input,integratorReceipt}),integratorReceipt,payload};
}

export function readerQuantityOptions() {
  return { fixtureOptions: { contextOptions: { mutateScientificInput: countScience } }, mutateView: countView,
    async preparePresentationOptions(f) {
      const proof = await ownedCountProof({ input: f.rendererInput, science: f.data, basis: f.basis.basis_fingerprint,
        context: f.context.context_fingerprint, views: f.views, artifactRoot: f.artifactRoot, identity: f.basis.identity }, 'registered-reader-quantity-proof');
      return { presentationOptions: { quantityEquivalence: proof.capability }, quantityProofReceipt: proof.integratorReceipt };
    } };
}


export function readerAssetOptions() {
  return {
    fixtureOptions: { contextOptions: { presentation: science => {
      const block = science.scientific_details.source_blocks[0];
      return { assets: [{ asset_id: 'reader-asset', artifact_id: 'reader-source-image', media_type: 'image/png',
        source_document_id: block.source_document_id, source_hash: block.source_hash, source_block_ids: [block.source_block_id],
        evidence_ids: [science.core.evidence[0].evidence_id], origin: 'registered_source_asset',
        qualification_reason: 'Owned synthetic source image; no actual visual or scientific acceptance.',
        bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJ1sAAAAASUVORK5CYII=', 'base64') }] };
    } } },
    mutateView(view, language, f) {
      const asset = f.basis.source_presentation.assets[0], id = 'reader-asset-' + language;
      view.sections[5].paragraphs.push({ paragraph_id: id, spans: [{ span_id: id, kind: 'asset', text: asset.target_path,
        explain_only: false, semantic_refs: [], claim_refs: [], evidence_refs: asset.evidence_ids, quantity_refs: [], term_refs: [],
        applicability_refs: [], boundary_refs: ['asset:' + asset.asset_id], quantity_bindings: [], core_quantity_bindings: [], asset_refs: [asset.asset_id],
        immutable_ref: { authority: 'source_asset', id: asset.asset_id, start: 0, end: asset.target_path.length } }] });
    },
  };
}

/** Actual owned synthetic Writer/parity/final-review producers; no hand-minted capability. */
export async function readerPackageFixture(t, options = {}) {
  const f = await readerReviewFixture(t, options), request = f.reviewRequest;
  const value = makeReaderReview(f.payload, request);
  f.start(request); const receipt = await f.commit(request, value);
  const ownedReview = { request, receipt, value, currentDependencies: f.reviewDependencies };
  const assessed = await assessReaderReview({ prepared: f.prepared, ownedReview });
  assert.equal(assessed.ok, true, JSON.stringify(assessed));
  const readingReview = { prepared: f.prepared, review: assessed.review };
  const presentation = f.presentation, manifest = presentation.manifest;
  const data = await getReaderPresentationContent(presentation);
  const notes = { en: presentation.en, 'zh-CN': presentation.zhCN };
  const readingPath = '.apa-v3/phase221/reading-review/' + f.prepared.prepared_fingerprint.slice(7) + '.json';
  const files = [{ path: manifest.targets.presentation, kind: 'reader-presentation', bytes: presentation.presentationBytes },
    { path: readingPath, kind: 'reading-review', bytes: jsonBytes(assessed.review) },
    ...presentation.readingRecords.map(row => ({ path: row.target_path, kind: 'reader-record', bytes: row.bytes })),
    ...await Promise.all(presentation.supportNotes.map(async row => ({ path: row.target_path ?? row.path, kind: 'support',
      bytes: row.bytes ?? await readFile(join(options.vaultRoot, row.target_path ?? row.path)) }))),
    ...presentation.assets.map(row => ({ path: row.target_path, kind: 'asset', bytes: row.bytes })),
    ...(presentation.stylesheet ? [{ path: presentation.stylesheet.path, kind: 'reader-style', bytes: presentation.stylesheet.bytes }] : [])];
  const paper = { ...manifest.identity, pipeline_version: '3.0', profile: manifest.profile, core_hash: hash(data.core),
    dependencies: manifest.dependencies, paths: manifest.target_registry.paper_targets,
    reader_presentation: { path: manifest.targets.presentation, sha256: sha(presentation.presentationBytes) } };
  const generation = { schema_version: 'phase22/active-index-1.0', kind: 'active', generation_id: options.generation ?? 'reader-package-g1', evidence_mode: 'synthetic', papers: [paper],
    objects: [...Object.entries(notes).map(([language]) => ({ path: paper.paths[language], kind: 'v3-note', sha256: manifest.targets.notes[language].managed_hash })),
      ...files.map(row => ({ path: row.path, kind: row.kind, sha256: sha(row.bytes) }))],
    shared_nodes: presentation.supportNotes.map(row => ({ entity_id: row.entity_id, path: row.target_path ?? row.path })) };
  const built = await buildBilingualIndex({ validatedInputs: { papers: [{ presentation, notes }], v2: [], files }, generation });
  const base = '.apa-v3/phase22/generations/' + generation.generation_id;
  const existingTargets = await Promise.all([...Object.values(paper.paths), ...files.map(row => row.path), base + '/active.json', base + '/index.json', base + '/manifest.json']
    .map(async path => {
      const existing = f.existingTargets?.find(row => row.path === path);
      if (existing) return existing;
      if (options.vaultRoot) {
        try { return { path, bytes: await readFile(join(options.vaultRoot, path)) }; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      return { path, bytes: null };
    }));
  const candidate = value => { const bytes = jsonBytes(value); return { bytes, byte_sha256: sha(bytes) }; };
  const activeSnapshot = { generation: generation.generation_id, previous_generation: options.previousGeneration ?? null,
    candidateActive: candidate(built.generation), candidateIndex: candidate(built.index) };
  const reviewArgs = { presentation, readingReview, existingTargets, activeSnapshot };
  const review = await buildBilingualReview(reviewArgs);
  return { ...f, ownedReview, readingReview, readingPath, notes, files, paper, built, existingTargets, activeSnapshot, reviewArgs, review };
}
