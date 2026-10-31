import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const imageName = name => typeof name === 'string' && /(?:^|[._:/-])(?:view_image|imageview|image_view)$/i.test(name);
function matchCall(row) {
  const p=row.payload ?? row, name=p.name ?? p.tool_name ?? p.tool ?? p.type ?? row.type;
  let args=p.arguments ?? p.args ?? p.input ?? p;
  if (typeof args === 'string') { try { args=JSON.parse(args); } catch { args={code:args}; } }
  if (imageName(name)) return {tool:name,object:args?.path ?? args?.image_path ?? args?.file ?? p.path ?? p.image_path ?? p.file ?? p.data?.path ?? null};
  if (typeof name === 'string' && /(?:^|[._:/-])exec$/i.test(name) && typeof args?.code === 'string' && /(?:tools\.)?view_image\s*\(/.test(args.code)) {
    const path=args.code.match(/(?:path|image_path)\s*:\s*['"]([^'"]+)['"]/);
    return {tool:`${name}:view_image`,object:path?.[1] ?? null};
  }
  return null;
}
export async function auditControllerLog({logPath,threadId}={}) {
  if (!logPath || !threadId) throw new Error('CONTROLLER_AUDIT_INPUT_INVALID');
  let content; try { content=await readFile(logPath,'utf8'); } catch (error) { if (error.code === 'ENOENT') return {coverage:'unknown',reason:'log_missing',events:[]}; throw error; }
  let context=null, malformed=false, unsupported=false, recognized=false, matchedThread=false; const events=[];
  let document;
  try { document=JSON.parse(content); } catch { /* JSONL is handled below. */ }
  if (Array.isArray(document) || document?.thread || Array.isArray(document?.turns) || Array.isArray(document?.items)) {
    const visit=(node, inheritedThread=null, inheritedStage=null, inheritedTime=null, threadContainer=false) => {
      if (Array.isArray(node)) { for (const item of node) visit(item,inheritedThread,inheritedStage,inheritedTime); return; }
      if (!node || typeof node !== 'object') { unsupported=true; return; }
      const thread=node.thread_id ?? node.threadId ?? (threadContainer ? node.id : null) ?? inheritedThread;
      const stage=node.stage ?? node.phase ?? inheritedStage, timestamp=node.timestamp ?? node.time ?? node.startedAt ?? inheritedTime;
      const children=['turns','items','events','entries'].filter(key=>Array.isArray(node[key]));
      if (node.thread && typeof node.thread === 'object') visit(node.thread,thread,stage,timestamp,true);
      for (const key of children) visit(node[key],thread,stage,timestamp);
      if (thread !== threadId) return;
      matchedThread=true;
      const hit=matchCall(node);
      if (hit) { recognized=true; events.push({timestamp,stage,object:hit.object,tool:hit.tool}); }
      else if (!children.length && !node.thread && !['message','userMessage','agentMessage','commandExecution','fileChange','subAgentActivity','plan','mcpToolCall','function_call','function_call_output','reasoning'].includes(node.type)) unsupported=true;
      else recognized=true;
      if (node.type === 'mcpToolCall' && node.argumentsPreview !== undefined && node.arguments === undefined) unsupported=true;
    };
    visit(document,document?.thread?.id ?? null);
    return {coverage:unsupported || document?.page ? 'incomplete' : !recognized || !matchedThread ? 'unknown' : events.length ? 'complete' : 'incomplete',events};
  }
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row; try { row=JSON.parse(line); } catch { malformed=true; continue; }
    if (!row || typeof row !== 'object' || Array.isArray(row)) { malformed=true; continue; }
    if (row.type === 'session_meta' && typeof row.payload?.id === 'string') {context=row.payload.id; recognized=true;}
    const thread=row.thread_id ?? row.threadId ?? row.payload?.thread_id ?? context;
    if (thread !== threadId) continue;
    matchedThread=true;
    const hit=matchCall(row);
    if (hit) {recognized=true; events.push({timestamp:row.timestamp ?? row.time ?? null,stage:row.stage ?? row.payload?.stage ?? null,object:hit.object,tool:hit.tool});}
    if (row.type === 'response_item' && row.payload?.type === 'function_call') recognized=true;
    if (row.type === 'response_item' && !hit && !['message','function_call','function_call_output','custom_tool_call','custom_tool_call_output','reasoning'].includes(row.payload?.type)) unsupported=true;
    if (!hit && !['session_meta','response_item','event_msg','turn_context','compacted'].includes(row.type)) unsupported=true;
  }
  return {coverage:malformed || unsupported ? 'incomplete' : !recognized || !matchedThread ? 'unknown' : events.length ? 'complete' : 'incomplete',events};
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [logPath,threadId]=process.argv.slice(2);
  auditControllerLog({logPath,threadId}).then(result=>process.stdout.write(JSON.stringify(result,null,2)+'\n')).catch(error=>{process.stderr.write(`${error.code ?? error.message}\n`);process.exitCode=1;});
}
