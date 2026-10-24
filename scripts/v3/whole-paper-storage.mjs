import {readFile} from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import {canonicalizeV3Json,fingerprintV3Json} from './semantic-package-validator.mjs';

const CONTRACT='phase21-whole-paper-storage-1.0';
const COMPACT_CONTRACT='phase21-whole-paper-storage-2.0';
const COMPACT_KINDS=['parser_run','comparison_input','comparison_result','source_evidence_bundle','source_evidence_scientific_input','source_evidence_visible_view'];
const EXPANDED_COMPACT_KINDS=['parser_run','comparison_input','comparison_result'];
const KINDS=['parser_run','accepted_reference','comparison_input','comparison_result','scientific_input','integration_role','source_evidence_bundle','source_evidence_scientific_input','source_evidence_visible_view'];
const CAPS=Object.freeze({encoded_bytes:256*1024*1024,unique_nodes:4000000,expanded_utf8_bytes:2*1024*1024*1024,expanded_node_visits:128000000,max_depth:128});
const EXPANDED_COMPACT_CAPS=Object.freeze({...CAPS,encoded_bytes:512*1024*1024,unique_nodes:6000000,expanded_utf8_bytes:4*1024*1024*1024});
const FIELDS=['encoded_bytes','unique_nodes','unique_strings','key_sets','expanded_utf8_bytes','expanded_node_visits','max_depth'];
const CODES={encoded_bytes:'SIZE_LIMIT',unique_nodes:'NODE_LIMIT',expanded_utf8_bytes:'EXPANSION_LIMIT',expanded_node_visits:'EXPANSION_LIMIT',max_depth:'DEPTH_LIMIT'};
const fail=code=>{const message='WHOLE_PAPER_STORAGE_'+code;throw Object.assign(new Error(message),{code:message});};
const schema=JSON.parse(await readFile(new URL('../../Schema/phase21/whole-paper-storage.schema.json',import.meta.url),'utf8'));
const shape=new Ajv2020({strict:false,allErrors:false}).compile(schema);
const checkCap=(name,value,caps=CAPS)=>{if(!Number.isSafeInteger(value)||value<0)fail('ACCOUNTING_INVALID');if(value>caps[name])fail(CODES[name]);return value;};

function profileCaps(storageContract,kind){
  if(storageContract===CONTRACT&&KINDS.includes(kind))return CAPS;
  if(storageContract===COMPACT_CONTRACT&&COMPACT_KINDS.includes(kind))return EXPANDED_COMPACT_KINDS.includes(kind)?EXPANDED_COMPACT_CAPS:CAPS;
  return null;
}
function accountingProfileCaps(profile){
  if(!profile||typeof profile!=='object'||Object.getOwnPropertySymbols(profile).length)return null;
  const descriptors=Object.getOwnPropertyDescriptors(profile),keys=Object.keys(descriptors);
  if(keys.length!==2||!keys.every(key=>['storageContract','kind'].includes(key))||keys.some(key=>!descriptors[key].enumerable||!Object.hasOwn(descriptors[key],'value')))return null;
  return profileCaps(descriptors.storageContract.value,descriptors.kind.value);
}

/** Fixed limits only; callers cannot pass these counters as authority to encode/decode. */
export function validateWholePaperStorageAccounting(a,profile){
  const errors=[];
  const caps=profile===undefined?CAPS:accountingProfileCaps(profile);
  if(!caps)return {ok:false,errors:['WHOLE_PAPER_STORAGE_PROFILE_INVALID']};
  if(!a||typeof a!=='object'||Object.keys(a).length!==FIELDS.length||FIELDS.some(k=>!Number.isSafeInteger(a[k])||a[k]<0)||['unique_nodes','expanded_utf8_bytes','expanded_node_visits','max_depth'].some(k=>a[k]<1))return {ok:false,errors:['WHOLE_PAPER_STORAGE_ACCOUNTING_INVALID']};
  for(const [key,cap]of Object.entries(caps))if(a[key]>cap)errors.push('WHOLE_PAPER_STORAGE_'+CODES[key]);
  return {ok:errors.length===0,errors:[...new Set(errors)].sort()};
}

function option(options,key){
  if(!options||typeof options!=='object'||Object.keys(options).length!==1||!Object.hasOwn(Object.getOwnPropertyDescriptor(options,key)??{},'value'))fail('OPTIONS_INVALID');
  const kind=options[key];if(!KINDS.includes(kind))fail('KIND_UNSUPPORTED');return kind;
}
function encodingOptions(options){
  if(!options||typeof options!=='object'||!Object.hasOwn(options,'storageContract'))return {kind:option(options,'kind'),compact:false};
  const fields=Object.getOwnPropertyDescriptors(options);
  if(Object.keys(fields).length!==2||Object.getOwnPropertySymbols(options).length||['kind','storageContract'].some(key=>!fields[key]?.enumerable||!Object.hasOwn(fields[key],'value'))||fields.storageContract.value!==COMPACT_CONTRACT)fail('OPTIONS_INVALID');
  const kind=fields.kind.value;if(!COMPACT_KINDS.includes(kind))fail('KIND_UNSUPPORTED');return {kind,compact:true};
}
// Adapt one node at a time; never allocate a second full node directory.
function nodeFields(node,compact){
  if(!compact)return node;
  if(node[0]===0)return {type:'scalar',value:node[1]};
  if(node[0]===1)return {type:'string',index:node[1]};
  if(node[0]===2)return {type:'array',children:node[1]};
  return {type:'object',keys:node[1],children:node[2]};
}
function matchesKind(value,kind){
  const field=(v,k)=>{if(!v||typeof v!=='object')return undefined;const d=Object.getOwnPropertyDescriptor(v,k);return d?.enumerable&&Object.hasOwn(d,'value')?d.value:undefined;};
  const versions={parser_run:'phase21-parser-run-whole-paper-1.0',accepted_reference:'phase21-accepted-reference-whole-paper-1.0',comparison_result:'phase21-reference-comparison-whole-paper-1.0',scientific_input:'phase21-scientific-input-whole-paper-1.0',source_evidence_bundle:'phase21-source-evidence-bundle-1.0',source_evidence_scientific_input:'phase21-scientific-input-source-evidence-1.0',source_evidence_visible_view:'phase21-source-evidence-visible-view-1.0'};
  if(Object.hasOwn(versions,kind))return field(value,'schema_version')===versions[kind];
  if(kind==='comparison_input')return field(field(value,'comparisonPolicy'),'location_contract')==='phase21-whole-paper-1.0'&&matchesKind(field(value,'baselineRun'),'parser_run')&&matchesKind(field(value,'candidateRun'),'parser_run')&&matchesKind(field(value,'referenceManifest'),'accepted_reference');
  return kind==='integration_role'&&matchesKind(field(value,'parser_comparison_inputs'),'comparison_input')&&matchesKind(field(value,'parser_comparison_result'),'comparison_result');
}
const textBytes=value=>Buffer.byteLength(canonicalizeV3Json(value));

// Count the compact JSON before creating its single string. It has no logical references here.
function wireLength(value,caps){
  if(value===null||typeof value!=='object')return checkCap('encoded_bytes',textBytes(value),caps);
  const array=Array.isArray(value),keys=Object.keys(value);let count=2;
  for(let i=0;i<keys.length;i++)count=checkCap('encoded_bytes',count+(i?1:0)+(array?0:textBytes(keys[i])+1)+wireLength(value[keys[i]],caps),caps);
  return count;
}

/** Topological resource/structure check runs before allocating decoded logical objects. */
function inspectGraph(envelope,encodedBytes){
  const {nodes,strings,key_sets:sets,root_node:root}=envelope;
  const compact=envelope.storage_contract===COMPACT_CONTRACT;
  const caps=profileCaps(envelope.storage_contract,envelope.logical_kind);if(!caps)fail('KIND_UNSUPPORTED');
  checkCap('encoded_bytes',encodedBytes,caps);checkCap('unique_nodes',nodes.length,caps);
  if(root!==nodes.length-1)fail('REFERENCE_INVALID');
  if(new Set(strings).size!==strings.length||strings.some(s=>!s.isWellFormed()))fail('REFERENCE_INVALID');
  const stringBytes=strings.map(textBytes),keyBytes=[];
  for(const keys of sets){
    let previous=null,total=0;
    for(const index of keys){
      if(index>=strings.length||previous!==null&&previous>=strings[index])fail('REFERENCE_INVALID');
      previous=strings[index];total+=stringBytes[index];
    }
    keyBytes.push(total);
  }
  const sizes=new Float64Array(nodes.length),visits=new Float64Array(nodes.length),depths=new Uint16Array(nodes.length);
  for(let i=0;i<nodes.length;i++){
    const n=nodeFields(nodes[i],compact);let size=0,count=1,depth=1;
    if(n.type==='scalar')size=textBytes(n.value);
    else if(n.type==='string'){if(n.index>=strings.length)fail('REFERENCE_INVALID');size=stringBytes[n.index];}
    else{
      if(n.type==='object'&&(n.keys>=sets.length||sets[n.keys].length!==n.children.length))fail('REFERENCE_INVALID');
      size=2+Math.max(0,n.children.length-1)+(n.type==='object'?keyBytes[n.keys]+n.children.length:0);
      for(const child of n.children){
        if(child>=i)fail('REFERENCE_INVALID');
        size=checkCap('expanded_utf8_bytes',size+sizes[child],caps);count=checkCap('expanded_node_visits',count+visits[child],caps);depth=Math.max(depth,depths[child]+1);
      }
    }
    sizes[i]=checkCap('expanded_utf8_bytes',size,caps);visits[i]=checkCap('expanded_node_visits',count,caps);depths[i]=checkCap('max_depth',depth,caps);
  }
  const usedNodes=new Uint8Array(nodes.length),usedStrings=new Uint8Array(strings.length),usedSets=new Uint8Array(sets.length),stack=[root];usedNodes[root]=1;
  while(stack.length){
    const n=nodeFields(nodes[stack.pop()],compact);
    if(n.type==='string')usedStrings[n.index]=1;
    if(n.type==='object'){usedSets[n.keys]=1;for(const key of sets[n.keys])usedStrings[key]=1;}
    for(const child of n.children??[])if(!usedNodes[child]){usedNodes[child]=1;stack.push(child);}
  }
  if(usedNodes.includes(0)||usedStrings.includes(0)||usedSets.includes(0))fail('REFERENCE_INVALID');
  const accounting={encoded_bytes:encodedBytes,unique_nodes:nodes.length,unique_strings:strings.length,key_sets:sets.length,expanded_utf8_bytes:sizes[root],expanded_node_visits:visits[root],max_depth:depths[root]};
  const checked=validateWholePaperStorageAccounting(accounting,{storageContract:envelope.storage_contract,kind:envelope.logical_kind});if(!checked.ok)throw Object.assign(new Error(checked.errors[0]),{code:checked.errors[0]});
  return accounting;
}

/** No files, permissions, parser, references or scoring are supplied by this transport. */
export function encodeWholePaperArtifact(logical,options){
  const {kind,compact}=encodingOptions(options);
  const caps=profileCaps(compact?COMPACT_CONTRACT:CONTRACT,kind);
  const strings=[],key_sets=[],nodes=[],stringIndex=new Map(),setIndex=new Map(),nodeIndex=new Map(),seen=new WeakMap(),active=new Set();
  const internString=value=>{if(!value.isWellFormed())fail('JSON_INVALID');if(stringIndex.has(value))return stringIndex.get(value);const index=strings.length;strings.push(value);stringIndex.set(value,index);return index;};
  const internNode=node=>{const key=JSON.stringify(node);if(nodeIndex.has(key))return nodeIndex.get(key);checkCap('unique_nodes',nodes.length+1,caps);const index=nodes.length;nodes.push(node);nodeIndex.set(key,index);return index;};
  const visit=(value,depth=1)=>{
    checkCap('max_depth',depth,caps);
    if(value===null||typeof value!=='object'){
      if(typeof value==='string'){if(!value.isWellFormed())fail('JSON_INVALID');return internNode(compact?[1,internString(value)]:{type:'string',index:internString(value)});}
      if(value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))return internNode(compact?[0,value]:{type:'scalar',value});
      fail('JSON_INVALID');
    }
    if(active.has(value))fail('JSON_INVALID');
    if(seen.has(value))return seen.get(value);
    const array=Array.isArray(value),descriptors=Object.getOwnPropertyDescriptors(value);
    if(!array&&![Object.prototype,null].includes(Object.getPrototypeOf(value))||Object.getOwnPropertySymbols(value).length||Object.values(descriptors).some(d=>!Object.hasOwn(d,'value')))fail('JSON_INVALID');
    active.add(value);
    let node;
    try{
      if(array){
        if(Object.keys(value).length!==value.length)fail('JSON_INVALID');const children=[];
        for(let i=0;i<value.length;i++){if(!Object.hasOwn(descriptors,i))fail('JSON_INVALID');children.push(visit(descriptors[i].value,depth+1));}
        node=compact?[2,children]:{type:'array',children};
      }else{
        const names=Object.keys(value).sort(),keys=names.map(internString),signature=JSON.stringify(keys);let index=setIndex.get(signature);
        if(index===undefined){index=key_sets.length;key_sets.push(keys);setIndex.set(signature,index);}
        const children=names.map(key=>visit(descriptors[key].value,depth+1));
        node=compact?[3,index,children]:{type:'object',keys:index,children};
      }
    }finally{active.delete(value);}
    const index=internNode(node);seen.set(value,index);return index;
  };
  const root_node=visit(logical);
  if(!matchesKind(logical,kind))fail('KIND_MISMATCH');
  const envelope={storage_contract:compact?COMPACT_CONTRACT:CONTRACT,logical_kind:kind,logical_fingerprint:'sha256:'+'0'.repeat(64),root_node,strings,key_sets,nodes};
  const count=wireLength(envelope,caps),accounting=inspectGraph(envelope,count);
  // Hash only after the graph proves that logical expansion is inside the fixed profile.
  const fingerprint=fingerprintV3Json(logical);envelope.logical_fingerprint=fingerprint;
  const bytes=Buffer.from(canonicalizeV3Json(envelope),'utf8');
  if(bytes.length!==count)fail('ACCOUNTING_INVALID');
  return {bytes,logical_fingerprint:fingerprint,accounting};
}

export function decodeWholePaperArtifact(input,options){
  const kind=option(options,'expectedKind');if(!(input instanceof Uint8Array))fail('STRUCTURE_INVALID');
  const preparseCaps=profileCaps(COMPACT_CONTRACT,kind)??CAPS;
  checkCap('encoded_bytes',input.byteLength,preparseCaps);const bytes=Buffer.from(input.buffer,input.byteOffset,input.byteLength);let text,envelope;
  try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);}catch{fail('UTF8_INVALID');}
  try{envelope=JSON.parse(text);}catch{fail('STRUCTURE_INVALID');}
  if(![CONTRACT,COMPACT_CONTRACT].includes(envelope?.storage_contract))fail('CONTRACT_UNSUPPORTED');
  if(envelope.logical_kind!==kind)fail('KIND_MISMATCH');
  const caps=profileCaps(envelope.storage_contract,kind);if(!caps)fail('KIND_UNSUPPORTED');
  checkCap('encoded_bytes',bytes.length,caps);if(Array.isArray(envelope.nodes))checkCap('unique_nodes',envelope.nodes.length,caps);
  if(!shape(envelope))fail('STRUCTURE_INVALID');
  let canonical;
  try{canonical=canonicalizeV3Json(envelope);}catch{fail('JSON_INVALID');}
  if(canonical!==text)fail('NONCANONICAL_WIRE');
  const accounting=inspectGraph(envelope,bytes.length),values=[];
  const compact=envelope.storage_contract===COMPACT_CONTRACT;
  for(const storedNode of envelope.nodes){
    const node=nodeFields(storedNode,compact);
    let value;
    if(node.type==='scalar')value=node.value;
    else if(node.type==='string')value=envelope.strings[node.index];
    else if(node.type==='array')value=Object.freeze(node.children.map(index=>values[index]));
    else{
      value={};envelope.key_sets[node.keys].forEach((key,index)=>Object.defineProperty(value,envelope.strings[key],{value:values[node.children[index]],enumerable:true,writable:false,configurable:false}));Object.freeze(value);
    }
    values.push(value);
  }
  const value=values[envelope.root_node];let fingerprint;
  try{fingerprint=fingerprintV3Json(value);}catch{fail('JSON_INVALID');}
  if(fingerprint!==envelope.logical_fingerprint)fail('FINGERPRINT_MISMATCH');
  if(!matchesKind(value,kind))fail('KIND_MISMATCH');
  return {value,logical_fingerprint:fingerprint,accounting};
}
