import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createReadingSession, resumeReadingSession, nextReadingAction, recordReadingEvent } from './reading-session.mjs';
import { capturedHostEvidence, normalizeHostReceipt } from './reading-host-evidence.mjs';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function immutableWrite(path, bytes) {
  try { await writeFile(path, bytes, {flag:'wx'}); }
  catch (error) { if (error.code !== 'EEXIST') throw error; if (!(await readFile(path)).equals(bytes)) throw Object.assign(new Error('READING_EXPORT_CONFLICT'),{code:'READING_EXPORT_CONFLICT'}); }
}
export async function exportReadingAction(directory, action) {
  if (typeof action?.action_id !== 'string' || !action.action_id.trim()) throw new Error('READING_EXPORT_ACTION_INVALID');
  await mkdir(directory,{recursive:true});
  const prefix = action.action_id.replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,48) || 'action';
  const path = join(resolve(directory),`${prefix}-${hash(action.action_id).slice(0,16)}.json`);
  await immutableWrite(path,Buffer.from(JSON.stringify(action,null,2)+'\n'));
  return path;
}
async function inputBytes(path) {
  if (path && path !== '-') return readFile(path);
  const chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk); return Buffer.concat(chunks);
}
async function run() {
  const [command,...args]=process.argv.slice(2); const options={};
  for (let i=0;i<args.length;i+=2) { if (!args[i]?.startsWith('--') || args[i+1] === undefined) throw new Error('READING_CLI_ARGUMENT_INVALID'); options[args[i].slice(2)]=args[i+1]; }
  let session;
  if (command === 'create') session=await createReadingSession(JSON.parse((await inputBytes(options.input)).toString('utf8')));
  else if (['resume','next','event'].includes(command)) session=await resumeReadingSession({runRoot:options['run-root']});
  else throw new Error('READING_CLI_COMMAND_INVALID');
  if (options['runtime-input']) {
    const runtimeEvent = JSON.parse((await inputBytes(options['runtime-input'])).toString('utf8'));
    if (runtimeEvent.kind !== 'runtime-evidence') throw new Error('READING_CLI_RUNTIME_INPUT_INVALID');
    await recordReadingEvent(session,runtimeEvent);
  }
  let result;
  if (command === 'event') {
    const event=JSON.parse((await inputBytes(options.input)).toString('utf8'));
    if (options['raw-result'] && options.source) throw new Error('READING_CLI_EVIDENCE_CONFLICT');
    if (options['raw-result']) {
      if (!options['export-dir'] || options['raw-result'] === '-' && (!options.input || options.input === '-')) throw new Error('READING_CLI_EVIDENCE_INPUT_INVALID');
      const bytes=await inputBytes(options['raw-result']), body=bytes.toString('utf8');
      if (!Buffer.from(body,'utf8').equals(bytes)) throw new Error('READING_CLI_UTF8_INVALID');
      await mkdir(options['export-dir'],{recursive:true});
      const path=join(resolve(options['export-dir']),`host-result-${hash(bytes)}.txt`); await immutableWrite(path,bytes);
      event.observation={...event.observation,raw_result_text:body,evidence:{...capturedHostEvidence(body),source_reference:path}};
    }
    if (options.source) {
      const path=resolve(options.source), bytes=await readFile(path);
      event.observation={...event.observation,evidence:{kind:'transcribed',source_reference:path,source_sha256:hash(bytes)}};
    }
    if (event.observation && (options['raw-result'] || options.source)) event.observation=normalizeHostReceipt(event.observation,{strict:true});
    result=await recordReadingEvent(session,event);
  } else {
    result=await nextReadingAction(session);
    if (result.action === 'dispatch') {
      if (!options['export-dir']) throw new Error('READING_CLI_EXPORT_DIRECTORY_REQUIRED');
      const path=await exportReadingAction(options['export-dir'],result); result={...result,export_path:path};
    }
  }
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) run().catch(error=>{process.stderr.write(`${error.code ?? error.message}\n`);process.exitCode=1;});
