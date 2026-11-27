import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { isContentCompleteReadingProfile } from '../lib/reading-profiles.mjs';

const legacyProfile = 'translation-progress-1.0';
const structureProfile = 'reading-translation-progress-1.1';
const fingerprint = value => 'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = () => { throw new Error('READING_TRANSLATION_PROGRESS_RECONCILE'); };
const invalidStructure = details => {
  const code = 'READING_FIRST_TRANSLATION_STRUCTURE_INVALID';
  throw Object.assign(new Error(code), { code, details });
};
const pathFor = (root, path) => {
  if (typeof path !== 'string' || !path || isAbsolute(path)) fail();
  const full = resolve(root, path), rel = relative(resolve(root), full);
  if (!rel || rel === '..' || rel.startsWith('..\\') || rel.startsWith('../') || isAbsolute(rel)) fail();
  return full;
};
const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { fail(); } };
const writeJson = (path, value, options) => { mkdirSync(dirname(path), { recursive:true }); writeFileSync(path, JSON.stringify(value, null, 2) + '\n', options); };
const items = (view, key, invalid = fail) => {
  const rows = view?.[key] ?? [];
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row.id !== 'string' || !row.id) || new Set(rows.map(row=>row.id)).size !== rows.length) invalid({ collection: key, field: 'id' });
  return new Map(rows.map(row=>[row.id,row]));
};
const pairs = (source, target, key) => {
  const originals = items(source,key), translated = items(target,key), result = {};
  for (const [id, row] of translated) {
    if (!originals.has(id)) fail();
    result[id] = { source_fingerprint:fingerprint(originals.get(id)), translation_fingerprint:fingerprint(row) };
  }
  return result;
};

/** Compare complete segments by ID. During checkpointing a present ID represents a whole segment. */
export function assertTranslationStructure(source, value, { partial = false } = {}) {
  const text = value => typeof value === 'string' && value.trim().length > 0;
  const paragraphs = list => Array.isArray(list) && list.length > 0 && list.every(text);
  const sameParagraphs = (original, translated) => paragraphs(original) && paragraphs(translated) && original.length === translated.length;
  for (const key of ['sections', 'knowledge_content']) {
    const originals = items(source, key, invalidStructure), translated = items(value, key, invalidStructure);
    if (!partial && originals.size !== translated.size) invalidStructure({ collection: key, field: 'id' });
    for (const [id, row] of translated) {
      const original = originals.get(id);
      if (!original) invalidStructure({ collection: key, id, field: 'id' });
      if (!sameParagraphs(original.paragraphs, row.paragraphs)) invalidStructure({ collection: key, id, field: 'paragraphs' });
      if (key === 'sections') {
        if (!text(row.heading)) invalidStructure({ collection: key, id, field: 'heading' });
        if (original.module_id !== undefined && original.module_id !== row.module_id) invalidStructure({ collection: key, id, field: 'module_id' });
        continue;
      }
      if (!isDeepStrictEqual(original.application_section_ids, row.application_section_ids)) {
        invalidStructure({ collection: key, id, field: 'application_section_ids' });
      }
      const sourceSections = original.sections === undefined ? [] : original.sections;
      const targetSections = row.sections === undefined ? [] : row.sections;
      if (!Array.isArray(sourceSections) || !Array.isArray(targetSections) || sourceSections.length !== targetSections.length) {
        invalidStructure({ collection: key, id, field: 'sections' });
      }
      for (const [index, section] of sourceSections.entries()) {
        const target = targetSections[index];
        if (!sameParagraphs(section?.paragraphs, target?.paragraphs)) {
          invalidStructure({ collection: key, id, field: 'sections.paragraphs', index });
        }
        if (!text(target.heading)) invalidStructure({ collection: key, id, field: 'sections.heading', index });
      }
    }
  }
}

function boundProgressManifest({ artifactRoot, task, instructionProfile }) {
  const path = pathFor(artifactRoot, task.progress_path);
  const manifest = existsSync(path) ? readJson(path) : null;
  const profile = manifest?.profile;
  if (isContentCompleteReadingProfile(instructionProfile)) {
    if (profile !== structureProfile) fail();
  } else if (manifest && profile !== legacyProfile && !(instructionProfile === undefined && profile === structureProfile)) fail();
  return { path, manifest };
}

function checkProgress(manifest, { task, runId, sourceView, nativeOutput, expectedCompleted }) {
  const source_fingerprint = fingerprint(sourceView);
  const sourceSections = items(sourceView,'sections'), sourceKnowledge = items(sourceView,'knowledge_content');
  let completed_sections = {}, completed_knowledge = {};
  if (manifest) {
    const strict = manifest.profile === structureProfile;
    if (manifest.run_id !== runId || manifest.task_id !== task.task_id || manifest.source_fingerprint !== source_fingerprint || !strict && !nativeOutput) fail();
    const currentSections = pairs(sourceView,nativeOutput,'sections'), currentKnowledge = pairs(sourceView,nativeOutput,'knowledge_content');
    for (const [stored,current] of [[manifest.completed_sections,currentSections],[manifest.completed_knowledge,currentKnowledge]]) {
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) fail();
      for (const [id, value] of Object.entries(stored)) if (JSON.stringify(current[id]) !== JSON.stringify(value)) fail();
    }
    completed_sections = manifest.completed_sections; completed_knowledge = manifest.completed_knowledge;
    if (strict) {
      // Unlocked draft fragments can still be corrected by the original task.
      const locked = (key, complete) => (nativeOutput?.[key] ?? []).filter(row => Object.hasOwn(complete, row.id));
      assertTranslationStructure(sourceView, { sections: locked('sections', completed_sections), knowledge_content: locked('knowledge_content', completed_knowledge) }, { partial: true });
    }
  }
  if (expectedCompleted) {
    if (source_fingerprint !== expectedCompleted.source_fingerprint) fail();
    for (const [oldRows,newRows] of [[expectedCompleted.completed_sections,completed_sections],[expectedCompleted.completed_knowledge,completed_knowledge]])
      for (const [id,value] of Object.entries(oldRows ?? {})) if (JSON.stringify(newRows[id]) !== JSON.stringify(value)) fail();
  }
  return { source_fingerprint, progress_fingerprint:manifest ? fingerprint(manifest) : null, completed_sections, completed_knowledge,
    remaining_sections:[...sourceSections.keys()].filter(id=>!Object.hasOwn(completed_sections,id)), remaining_knowledge:[...sourceKnowledge.keys()].filter(id=>!Object.hasOwn(completed_knowledge,id)) };
}

export function checkTranslationProgress(options = {}) {
  const { manifest } = boundProgressManifest(options);
  return checkProgress(manifest, options);
}

export function writeTranslationProgress({ artifactRoot, task, runId, sourceView, nativeOutput, instructionProfile } = {}) {
  const options = { artifactRoot, task, runId, sourceView, nativeOutput, instructionProfile };
  const { path, manifest: saved } = boundProgressManifest(options);
  checkProgress(saved, options);
  const profile = saved?.profile ?? legacyProfile;
  if (profile === structureProfile) assertTranslationStructure(sourceView, nativeOutput, { partial: true });
  const manifest = {profile, run_id:runId, task_id:task.task_id, source_fingerprint:fingerprint(sourceView), completed_sections:pairs(sourceView,nativeOutput,'sections'), completed_knowledge:pairs(sourceView,nativeOutput,'knowledge_content')};
  writeJson(path, manifest);
  return checkTranslationProgress(options);
}

/** Decide only from checked fragment progress and separately attributed stop evidence. */
export function evaluateTranslationContinuation({ progress, previousProgress, priorUnknownZeroProgress = 0, stopReason } = {}) {
  if (!progress || !Array.isArray(progress.remaining_sections) || !Array.isArray(progress.remaining_knowledge)) fail();
  const kind = stopReason?.kind ?? 'unknown';
  if (!['unknown', 'role_report', 'host_confirmed'].includes(kind)
    || kind !== 'unknown' && (typeof stopReason.detail !== 'string' || !stopReason.detail.trim())
    || kind === 'host_confirmed' && (typeof stopReason.source_reference !== 'string' || !stopReason.source_reference.trim())) {
    throw new Error('READING_TRANSLATION_STOP_REASON_INVALID');
  }
  const count = value => Object.keys(value?.completed_sections ?? {}).length + Object.keys(value?.completed_knowledge ?? {}).length;
  const result = { reason_kind:kind, completed_sections:progress.completed_sections, completed_knowledge:progress.completed_knowledge,
    remaining_sections:progress.remaining_sections, remaining_knowledge:progress.remaining_knowledge };
  if (!progress.remaining_sections.length && !progress.remaining_knowledge.length) return { ...result, action:'complete', unknown_zero_progress_retry:false };
  const unexplained = kind === 'unknown' && count(progress) <= count(previousProgress);
  if (unexplained && priorUnknownZeroProgress > 0) return { ...result, action:'reconcile', code:'READING_TRANSLATION_ZERO_PROGRESS', unknown_zero_progress_retry:false };
  return { ...result, action:'continue', unknown_zero_progress_retry:unexplained };
}

export function prepareTranslationInputs({artifactRoot,task,runId,payload,instructionProfile} = {}) {
  const {source_view, language, ...context} = payload;
  const ref = (name, value) => {
    const path = pathFor(artifactRoot,task[name]);
    const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
    mkdirSync(dirname(path),{recursive:true});
    if (existsSync(path)) { if (!readFileSync(path).equals(bytes)) fail(); } else writeFileSync(path,bytes,{flag:'wx'});
    return {path,sha256:'sha256:' + createHash('sha256').update(bytes).digest('hex'),byte_length:bytes.length};
  };
  const source_view_ref = ref('source_view_path',source_view), translation_context_ref = ref('translation_context_path',context);
  const progressPath = pathFor(artifactRoot, task.progress_path);
  if (isContentCompleteReadingProfile(instructionProfile) && !existsSync(progressPath)) {
    writeJson(progressPath, { profile: structureProfile, run_id: runId, task_id: task.task_id, source_fingerprint: fingerprint(source_view),
      completed_sections: {}, completed_knowledge: {} }, { flag: 'wx' });
  }
  const nativePath = pathFor(artifactRoot,task.native_path);
  const nativeOutput = existsSync(nativePath) ? readJson(nativePath) : undefined;
  const progress = checkTranslationProgress({artifactRoot,task,runId,sourceView:source_view,nativeOutput,instructionProfile});
  return {instructionPayload:{language,source_view_ref,translation_context_ref,progress_path:progressPath,progress_checkpoint:{artifact_root:resolve(artifactRoot),run_id:runId,task_id:task.task_id,source_path:task.source_view_path,native_path:task.native_path,progress_path:task.progress_path},remaining_sections:progress.remaining_sections,remaining_knowledge:progress.remaining_knowledge},progress};
}

export function verifyTranslationInputReferences(input) {
  for (const ref of [input?.source_view_ref, input?.translation_context_ref]) {
    if (!ref || !isAbsolute(ref.path ?? '') || !Number.isSafeInteger(ref.byte_length)) fail();
    let bytes;
    try { bytes = readFileSync(ref.path); } catch { fail(); }
    if (bytes.length !== ref.byte_length || 'sha256:' + createHash('sha256').update(bytes).digest('hex') !== ref.sha256) fail();
  }
}

export function validateTranslationInputPayload(input, payload) {
  verifyTranslationInputReferences(input);
  const { source_view, language, ...context } = payload;
  if (input.language !== language || !isDeepStrictEqual(readJson(input.source_view_ref.path), source_view)
    || !isDeepStrictEqual(readJson(input.translation_context_ref.path), context)) fail();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, artifactRoot, runId, taskId, sourcePath, nativePath, progressPath] = process.argv.slice(2);
  if (command !== 'checkpoint' || !progressPath) throw new Error('Usage: checkpoint <artifactRoot> <runId> <taskId> <sourcePath> <nativePath> <progressPath>');
  const task = {task_id:taskId,progress_path:progressPath};
  const result = writeTranslationProgress({artifactRoot,task,runId,sourceView:readJson(pathFor(artifactRoot,sourcePath)),nativeOutput:readJson(pathFor(artifactRoot,nativePath))});
  process.stdout.write(JSON.stringify(result) + '\n');
}
