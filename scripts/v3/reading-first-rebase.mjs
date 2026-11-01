import { createHash } from 'node:crypto';
import { fingerprintV3Json as fingerprint } from './semantic-package-validator.mjs';
import { extractOwnKnowledge, compareOwnKnowledge } from './reading-first-knowledge.mjs';
const sha = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const fail = (code, details) => { throw Object.assign(new Error(code), {code,details}); };
const strip = value => value.replace(/<!-- KNOWLEDGE_STATE [A-Za-z0-9+/=]+ -->/, '');
const entry = (registry, path) => registry.find(row => row.path === path || row.canonical_path === path);

/** Recompute the complete proof from signed original inputs and the recorded current-node bytes. */
export function computeKnowledgeRebase({recipe, rendering, render, presentation, identity, readingReviewFingerprint, generationId}) {
  for (const row of rendering.knowledgeRegistry) {
    if (row.content !== undefined && row.content_sha256 !== sha(row.content)) fail('RF_REBASE_RECORD_INVALID',{path:row.path});
  }
  for (const note of recipe.candidate.supportNotes ?? []) {
    const before=entry(recipe.rendering.knowledgeRegistry,note.path), after=entry(rendering.knowledgeRegistry,note.path);
    if (before && (!after || after.unavailable || after.content === undefined)) fail('RF_REBASE_KNOWLEDGE_TARGET_MISSING',{path:note.path});
  }
  const original = recipe.candidate, content = render(rendering);
  if (fingerprint(content.notes) !== fingerprint(original.notes)) fail('RF_REBASE_PAPER_NOTE_CHANGED');
  const {profile,identity:unused,review_status,publishable,presentation_fingerprint,...originalContent} = original;
  const candidate = {...original,...content,presentation_fingerprint:fingerprint(content)};
  const nodes = [];
  for (const note of original.supportNotes ?? []) {
    const before = entry(recipe.rendering.knowledgeRegistry,note.path), after = entry(rendering.knowledgeRegistry,note.path);
    const output = content.supportNotes?.find(row => row.path === note.path);
    if (!output) fail('RF_REBASE_OWN_KNOWLEDGE_CHANGED',{path:note.path});
    const changed = (before?.content ?? null) !== (after?.content ?? null);
    if (!changed) {
      if (fingerprint(note) !== fingerprint(output)) fail('RF_REBASE_UNAFFECTED_NODE_CHANGED',{path:note.path});
      continue;
    }
    if (before && (!after || after.unavailable)) fail('RF_REBASE_KNOWLEDGE_TARGET_MISSING',{path:note.path});
    const item = presentation.knowledge.find(row => row.id === note.id);
    if (!item) fail('RF_REBASE_OWN_KNOWLEDGE_CHANGED',{path:note.path});
    const modeBefore = before ? 'reused' : 'created', modeAfter = after ? 'reused' : 'created';
    const own = extractOwnKnowledge({content:note.content,paperId:identity.paper_id,item,mode:modeBefore});
    const rebased = extractOwnKnowledge({content:output.content,paperId:identity.paper_id,item,mode:modeAfter});
    const existing = after?.content ? extractOwnKnowledge({content:after.content,paperId:identity.paper_id,item,mode:'reused'}) : undefined;
    const compared = compareOwnKnowledge({original:own,rebased,existing,path:note.path});
    if (after?.content !== undefined) {
      const base = strip(after.content), result = strip(output.content), end = '<!-- AUTO:END shared-knowledge -->', index = base.indexOf(end);
      const prefix = index >= 0 ? base.slice(0,index) : base;
      const suffix = index >= 0 ? base.slice(index) : '';
      if (!result.startsWith(prefix) || !result.endsWith(suffix) || result.length < prefix.length + suffix.length) fail('RF_REBASE_CURRENT_CONTENT_NOT_PRESERVED',{path:note.path});
    }
    nodes.push({path:note.path,mode_before:modeBefore,mode_after:modeAfter,render_sha256:before?.content === undefined ? null : sha(before.content),base_sha256:after?.content === undefined ? null : sha(after.content),output_sha256:sha(output.content),dropped_paragraphs:compared.dropped_paragraphs});
  }
  const record = {schema_version:'reading-first-knowledge-rebase-1.0',original_recipe_fingerprint:recipe.recipe_fingerprint,
    original_presentation_fingerprint:original.presentation_fingerprint,reading_review_fingerprint:readingReviewFingerprint,
    base_generation_id:generationId,rendering,candidate,nodes,model_calls:0};
  record.rebase_fingerprint = fingerprint(record);
  const diff = nodes.map(row => {
    const old = original.supportNotes.find(note => note.path === row.path).content;
    const next = content.supportNotes.find(note => note.path === row.path).content;
    return `--- original/${row.path}\n+++ rebased/${row.path}\n@@ -1,${old.split('\n').length} +1,${next.split('\n').length} @@\n` + old.split('\n').map(line=>'-'+line).join('\n')+'\n'+next.split('\n').map(line=>'+'+line).join('\n');
  }).join('\n\n');
  return {record,diff};
}
