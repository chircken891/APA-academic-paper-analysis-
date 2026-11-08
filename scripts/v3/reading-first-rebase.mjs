import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import MarkdownIt from 'markdown-it';
import { fingerprintV3Json as fingerprint } from './semantic-package-validator.mjs';
import { draftReadingFirstKnowledgeComparisons, extractOwnKnowledge, compareOwnKnowledge, matchReadingFirstKnowledgeIdentity } from './reading-first-knowledge.mjs';
import { inspectManagedNote } from './phase22-managed-markdown.mjs';
const sha = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const fail = (code, details) => { throw Object.assign(new Error(code), {code,details}); };
const strip = value => value.replace(/<!-- KNOWLEDGE_STATE [A-Za-z0-9+/=]+ -->/, '');
const entry = (registry, path) => registry.find(row => row.path === path || row.canonical_path === path);
const key = note => note.id + ':' + (note.language ?? 'shared');
const markdown = new MarkdownIt();
const relHref = (from, to) => posix.relative(posix.dirname(from), to).split('/').map(part => encodeURIComponent(part)
  .replaceAll('(', '%28').replaceAll(')', '%29')).join('/');

function counts(value) {
  const result = new Map();
  for (const token of markdown.parse(value, {})) for (const child of token.children ?? []) {
    if (child.type !== 'link_open') continue;
    const href = child.attrGet('href');
    result.set(href, (result.get(href) ?? 0) + 1);
  }
  return result;
}

function linkOnlyRegion(old, next, destinations) {
  const links = value => [...value.matchAll(/\]\(([^\s)<]+)(?=[\s)])/g)];
  const before = links(old), after = links(next), delta = new Map();
  if (before.length !== after.length) return false;
  let oldOffset = 0, newOffset = 0;
  for (let i = 0; i < before.length; i++) {
    const a = before[i], b = after[i];
    if (old.slice(oldOffset, a.index) !== next.slice(newOffset, b.index)) return false;
    oldOffset = a.index + a[0].length; newOffset = b.index + b[0].length;
    if (a[1] === b[1]) continue;
    const at = a[1].search(/[?#]/), originalPath = at < 0 ? a[1] : a[1].slice(0, at), suffix = at < 0 ? '' : a[1].slice(at);
    const target = destinations.get(originalPath);
    if (!target || b[1] !== target + suffix) return false;
    delta.set(a[1], (delta.get(a[1]) ?? 0) - 1);
    delta.set(b[1], (delta.get(b[1]) ?? 0) + 1);
  }
  if (old.slice(oldOffset) !== next.slice(newOffset)) return false;
  const oldCounts = counts(old), newCounts = counts(next);
  return [...delta].every(([href, change]) => (newCounts.get(href) ?? 0) - (oldCounts.get(href) ?? 0) === change);
}

function verifyPaperLinks(before, after, mappings) {
  const { content: old, managedHash: oldHash, ...oldMetadata } = before;
  const { content: next, managedHash: newHash, ...newMetadata } = after;
  if (fingerprint(oldMetadata) !== fingerprint(newMetadata)) return false;
  const a = inspectManagedNote(Buffer.from(old)), b = inspectManagedNote(Buffer.from(next));
  const untouched = note => note.humanRanges.map(range => range.bytes.toString('utf8'));
  if (a.managedHash !== oldHash || b.managedHash !== newHash || fingerprint(a.frontmatter) !== fingerprint(b.frontmatter)
    || fingerprint(untouched(a)) !== fingerprint(untouched(b))) return false;
  const destinations = new Map(mappings.map(row => [relHref(before.path, row.from_path), relHref(before.path, row.to_path)]));
  return a.regions.every((region, index) => {
    const other = b.regions[index];
    return region.id === other?.id && (region.bytes.equals(other.bytes) || (['reading', 'resources'].includes(region.id)
      && linkOnlyRegion(region.bytes.toString('utf8'), other.bytes.toString('utf8'), destinations)));
  });
}

/** Recompute the complete proof from signed original inputs and the recorded current-node bytes. */
export function computeKnowledgeRebase({recipe, rendering, render, presentation, identity, readingReviewFingerprint, generationId}) {
  for (const row of rendering.knowledgeRegistry) {
    if (row.content !== undefined && row.content_sha256 !== sha(row.content)) fail('RF_REBASE_RECORD_INVALID',{path:row.path});
  }
  const original = recipe.candidate, content = render(rendering);
  const {profile,identity:unused,review_status,publishable,presentation_fingerprint,notes:oldNotes,supportNotes:oldNodes,
    knowledgeProposals:oldProposals,knowledgeMergeCandidates:oldDrafts,...originalContent} = original;
  const {notes:nextNotes,supportNotes:nextNodes,knowledgeProposals:nextProposals,knowledgeMergeCandidates:nextDrafts,...nextContent} = content;
  if (fingerprint(originalContent) !== fingerprint(nextContent)) fail('RF_REBASE_PAPER_NOTE_CHANGED');
  const candidate = {...original,...content,presentation_fingerprint:fingerprint(content)};
  if (nextDrafts === undefined) delete candidate.knowledgeMergeCandidates;
  const nodes = [], papers = [], identityAmbiguities = [];
  const nextByIdentity = new Map((nextNodes ?? []).map(note => [key(note), note]));
  if (nextByIdentity.size !== (oldNodes ?? []).length || nextByIdentity.size !== (nextNodes ?? []).length) fail('RF_REBASE_OWN_KNOWLEDGE_CHANGED');
  const identityMappings = (oldNodes ?? []).flatMap(note => {
    const output = nextByIdentity.get(key(note));
    if (!output) fail('RF_REBASE_OWN_KNOWLEDGE_CHANGED',{path:note.path});
    const item = presentation.knowledge.find(row => row.id === note.id);
    const match = item && matchReadingFirstKnowledgeIdentity({ item, knowledgeRegistry: rendering.knowledgeRegistry });
    const wasReused = entry(recipe.rendering.knowledgeRegistry,note.path);
    if (note.path === output.path) {
      if (wasReused && match?.ambiguous_paths?.length) fail('RF_REBASE_AMBIGUOUS_NEW_TARGET_OCCUPIED',{path:output.path});
      return [];
    }
    const after = entry(rendering.knowledgeRegistry,output.path);
    if (wasReused && match?.ambiguous_paths?.length) {
      if (after) fail('RF_REBASE_AMBIGUOUS_NEW_TARGET_OCCUPIED',{path:output.path});
      const own = extractOwnKnowledge({content:output.content,paperId:identity.paper_id,item,mode:'created'});
      const draft_pairs = draftReadingFirstKnowledgeComparisons({item:{...item,paragraphs:own.paragraphs},knowledgeRegistry:rendering.knowledgeRegistry,match,target:output.path})
        .map(draft=>({...draft,generation_id:generationId,candidate_sha256:sha(output.content)}));
      identityAmbiguities.push({id:note.id,from_path:note.path,to_path:output.path,ambiguous_paths:match.ambiguous_paths,draft_pairs});
    } else if (match?.paths[0] !== output.path || after?.current_content !== true || typeof after.content !== 'string') {
      fail('RF_REBASE_KNOWLEDGE_TARGET_MISSING',{path:note.path});
    }
    return [{id:note.id,from_path:note.path,to_path:output.path}];
  });
  for (const note of oldNodes ?? []) {
    const output = nextByIdentity.get(key(note));
    const before = entry(recipe.rendering.knowledgeRegistry,note.path), after = entry(rendering.knowledgeRegistry,output.path);
    const item = presentation.knowledge.find(row => row.id === note.id);
    const mapped = note.path !== output.path;
    const ambiguous = identityAmbiguities.some(row=>row.id===note.id && row.to_path===output.path);
    if (before && !ambiguous && (!after || after.unavailable || after.content === undefined)) fail('RF_REBASE_KNOWLEDGE_TARGET_MISSING',{path:note.path});
    const changed = mapped || (before?.content ?? null) !== (after?.content ?? null);
    if (!changed) {
      if (fingerprint(note) === fingerprint(output)) continue;
      const {content:old,...oldMetadata}=note, {content:next,...nextMetadata}=output;
      const destinations=new Map(identityMappings.map(row=>[relHref(note.path,row.from_path),relHref(note.path,row.to_path)]));
      if (!identityMappings.length || fingerprint(oldMetadata)!==fingerprint(nextMetadata) || !linkOnlyRegion(old,next,destinations)) {
        fail('RF_REBASE_UNAFFECTED_NODE_CHANGED',{path:note.path});
      }
    }
    if (!item) fail('RF_REBASE_OWN_KNOWLEDGE_CHANGED',{path:note.path});
    const modeBefore = before ? 'reused' : 'created', modeAfter = after ? 'reused' : 'created';
    const own = extractOwnKnowledge({content:note.content,paperId:identity.paper_id,item,mode:modeBefore});
    const rebased = extractOwnKnowledge({content:output.content,paperId:identity.paper_id,item,mode:modeAfter});
    const existing = after?.content ? extractOwnKnowledge({content:after.content,paperId:identity.paper_id,item,mode:'reused'}) : undefined;
    const originalExisting = ambiguous ? extractOwnKnowledge({content:before.content,paperId:identity.paper_id,item,mode:'reused'}) : undefined;
    const compared = compareOwnKnowledge({original:own,rebased,existing,originalExisting,path:note.path});
    if (after?.content !== undefined) {
      const base = strip(after.content), result = strip(output.content), end = '<!-- AUTO:END shared-knowledge -->', index = base.indexOf(end);
      const prefix = index >= 0 ? base.slice(0,index) : base;
      const suffix = index >= 0 ? base.slice(index) : '';
      if (!result.startsWith(prefix) || !result.endsWith(suffix) || result.length < prefix.length + suffix.length) fail('RF_REBASE_CURRENT_CONTENT_NOT_PRESERVED',{path:note.path});
    }
    nodes.push({path:output.path,...(mapped ? {previous_path:note.path,previous_output_sha256:sha(note.content)} : {}),mode_before:modeBefore,mode_after:modeAfter,
      render_sha256:before?.content === undefined ? null : sha(before.content),base_sha256:after?.content === undefined ? null : sha(after.content),output_sha256:sha(output.content),dropped_paragraphs:compared.dropped_paragraphs});
  }
  if (oldNotes.length !== nextNotes.length) fail('RF_REBASE_PAPER_NOTE_CHANGED');
  for (const before of oldNotes) {
    const after = nextNotes.find(note => note.path === before.path && note.language === before.language);
    if (!after) fail('RF_REBASE_PAPER_NOTE_CHANGED');
    if (fingerprint(before) === fingerprint(after)) continue;
    if (!identityMappings.length || !verifyPaperLinks(before, after, identityMappings)) fail('RF_REBASE_PAPER_NOTE_CHANGED',{path:before.path});
    papers.push({path:before.path,before_sha256:sha(before.content),after_sha256:sha(after.content)});
  }
  const record = {schema_version:'reading-first-knowledge-rebase-1.0',original_recipe_fingerprint:recipe.recipe_fingerprint,
    original_presentation_fingerprint:original.presentation_fingerprint,reading_review_fingerprint:readingReviewFingerprint,
    base_generation_id:generationId,rendering,candidate,nodes,...(identityMappings.length ? {identity_mappings:identityMappings,papers} : {}),
    ...(identityAmbiguities.length ? {review_required:true,identity_ambiguities:identityAmbiguities} : {}),model_calls:0};
  record.rebase_fingerprint = fingerprint(record);
  const diff = nodes.map(row => {
    const old = original.supportNotes.find(note => note.path === (row.previous_path ?? row.path)).content;
    const next = content.supportNotes.find(note => note.path === row.path).content;
    return `--- original/${row.previous_path ?? row.path}\n+++ rebased/${row.path}\n@@ -1,${old.split('\n').length} +1,${next.split('\n').length} @@\n` + old.split('\n').map(line=>'-'+line).join('\n')+'\n'+next.split('\n').map(line=>'+'+line).join('\n');
  }).join('\n\n');
  return {record,diff};
}
