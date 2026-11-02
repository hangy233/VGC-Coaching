// Mechanical source binding for tools explicitly selected by the battle model.
// Model tool projection and private binding only. Mechanical reconstruction
// hypotheses are supplied inside the compact tool, never tactical action pairs.
import {canonicalEvidenceRoom} from './evidence-room.mjs';
import {createHash} from 'node:crypto';

export const MODEL_TOOL_NAMES=Object.freeze(['get_pokemon','get_move','get_ability','get_movepool','calculate_damage','calculate_damage_range','calculate_speed','simulate_choices','simulate_turn','battle_check_plan']);
export const MODEL_TOOL_HOST_FIELDS=Object.freeze({
  calculate_damage:Object.freeze(['evidenceContext','researchContext']),calculate_damage_range:Object.freeze(['evidenceContext','researchContext']),calculate_speed:Object.freeze(['evidenceContext','researchContext']),
  simulate_turn:Object.freeze(['request.source','evidenceContext','researchContext']),battle_check_plan:Object.freeze(['request.source','researchContext']),
  simulate_choices:Object.freeze(['source','analysis','freezeId','evidenceContext']),
});
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const check=(condition,message)=>{if(!condition)throw new TypeError(message);};
function referencedSchema(root,ref){
  check(typeof ref==='string'&&ref.startsWith('#/'),'Model tool schemas require local references');
  let target=root;for(const part of ref.slice(2).split('/'))target=target?.[part.replace(/~1/gu,'/').replace(/~0/gu,'~')];
  check(plain(target),'Native model tool schema reference is unresolved');return target;
}
function removeSchemaPath(node,path,root,seen=new Map()){
  if(!plain(node))return;
  const key=path.join('.');let paths=seen.get(node);
  // The same referenced definition can occur through several union arms.
  if(!paths){paths=new Set();seen.set(node,paths);}if(paths.has(key))return;paths.add(key);
  if(typeof node.$ref==='string'){
    removeSchemaPath(referencedSchema(root,node.$ref),path,root,seen);
  }
  for(const union of ['anyOf','oneOf','allOf'])for(const item of node[union]??[])removeSchemaPath(item,path,root,seen);
  if(!plain(node.properties)||!Object.hasOwn(node.properties,path[0]))return;
  if(path.length===1){delete node.properties[path[0]];if(Array.isArray(node.required))node.required=node.required.filter(key=>key!==path[0]);}
  else removeSchemaPath(node.properties[path[0]],path.slice(1),root,seen);
}
function schemaKinds(node,root,seen=new Set()){
  if(!plain(node)||seen.has(node))return null;const next=new Set(seen).add(node);let result=null;
  const intersect=kinds=>{if(kinds)result=result?new Set([...result].filter(value=>kinds.has(value))):kinds;};
  if(node.$ref)intersect(schemaKinds(referencedSchema(root,node.$ref),root,next));
  const kind=node.properties?.kind;
  if(typeof kind?.const==='string')intersect(new Set([kind.const]));
  else if(Array.isArray(kind?.enum))intersect(new Set(kind.enum));
  for(const key of ['anyOf','oneOf'])if(Array.isArray(node[key])){
    const children=node[key].map(child=>schemaKinds(child,root,next));
    if(children.every(Boolean))intersect(new Set(children.flatMap(child=>[...child])));
  }
  for(const child of node.allOf??[])intersect(schemaKinds(child,root,next));
  return result;
}
function restrictObserved(node,root,seen=new Set()){
  if(!plain(node)||seen.has(node))return;seen.add(node);
  if(node.$ref)restrictObserved(referencedSchema(root,node.$ref),root,seen);
  for(const key of ['anyOf','oneOf'])if(Array.isArray(node[key])){
    const kinds=node[key].map(child=>schemaKinds(child,root));
    check(kinds.every(Boolean),'Native live simulation request kinds are not explicit');
    node[key]=node[key].filter((_child,index)=>kinds[index].has('observed'));
    check(node[key].length>0,'Native catalog has no supported observed simulation request');
    for(const child of node[key])restrictObserved(child,root,seen);
  }
  for(const child of node.allOf??[])restrictObserved(child,root,seen);
  const kind=node.properties?.kind;
  if(typeof kind?.const==='string')check(kind.const==='observed','Only observed current simulation requests are supported');
  else if(Array.isArray(kind?.enum)){check(kind.enum.includes('observed'),'Observed native request kind is unavailable');kind.enum=['observed'];}
}
function restrictObservedRequest(node,root,seen=new Set()){
  if(!plain(node)||seen.has(node))return false;seen.add(node);let found=false;
  if(node.$ref)found=restrictObservedRequest(referencedSchema(root,node.$ref),root,seen)||found;
  for(const key of ['anyOf','oneOf','allOf'])for(const child of node[key]??[])found=restrictObservedRequest(child,root,seen)||found;
  if(plain(node.properties?.request)){
    restrictObserved(node.properties.request,root);const kinds=schemaKinds(node.properties.request,root);
    check(kinds?.size===1&&kinds.has('observed'),'Live simulation schema must restrict requests to the observed source');found=true;
  }
  return found;
}
export function modelToolDefinition(tool){
  check(MODEL_TOOL_NAMES.includes(tool?.name)&&plain(tool.inputSchema),'An actual allowed native tool schema is required');
  check(tool.name!=='battle_check_plan'||tool.annotations?.readOnlyHint===true,'Native plan checks must be explicitly read-only');
  const native=structuredClone(tool.inputSchema),inputSchema=structuredClone(native),hostBoundFields=[...(MODEL_TOOL_HOST_FIELDS[tool.name]??[])];
  if(['simulate_turn','battle_check_plan'].includes(tool.name))check(restrictObservedRequest(inputSchema,inputSchema),'Native live simulation request schema is unavailable');
  for(const field of hostBoundFields)removeSchemaPath(inputSchema,field.split('.'),inputSchema,new Map());
  return {name:tool.name,description:tool.description??'',inputSchema,hostBoundFields,nativeSchemaSha256:createHash('sha256').update(JSON.stringify(native)).digest('hex')};
}
export function bindModelToolArguments(name,args,{source,turn}={}){
  check(MODEL_TOOL_NAMES.includes(name)&&plain(args),'An allowed model tool and explicit JSON arguments are required');
  const text=JSON.stringify(args);check(Buffer.byteLength(text)<=1048576,'Model tool arguments exceed the complete input bound');
  const value=JSON.parse(text);
  for(const field of ['controllerLease','readReceipt','authorization','password','token','sessionId','teamId'])check(!Object.hasOwn(value,field),'Private control and source fields must be omitted from model tool arguments');
  if(['get_pokemon','get_move','get_ability','get_movepool','calculate_damage','calculate_damage_range','calculate_speed'].includes(name)){
    check(value.gen===undefined||value.gen===0,'Model research requires native M-C gen:0');
    value.gen=0;
  }
  if(['calculate_damage','calculate_damage_range','calculate_speed'].includes(name)){
    check(!Object.hasOwn(value,'evidenceContext')&&!Object.hasOwn(value,'researchContext'),'Model numerical evidence and research scope are bound by the host');
    value.evidenceContext={teamId:source.teamId,roomId:canonicalEvidenceRoom(source.room),turn};
    value.researchContext={source:structuredClone(source),analysis:'current'};
  }
  if(['simulate_turn','battle_check_plan'].includes(name)){
    check(plain(value.request)&&value.request.kind==='observed','Live model simulation requires an explicit observed request');
    check(!Object.hasOwn(value.request,'source')&&!Object.hasOwn(value,'evidenceContext')&&!Object.hasOwn(value,'researchContext'),'Model simulation source, evidence and research scope are bound by the host');
    value.request.source=structuredClone(source);
    value.researchContext={source:structuredClone(source),analysis:'current'};
    if(name==='simulate_turn')value.evidenceContext={teamId:source.teamId,roomId:canonicalEvidenceRoom(source.room),turn};
  }
  if(name==='simulate_choices'){
    check(!['source','analysis','freezeId','evidenceContext'].some(key=>Object.hasOwn(value,key)),'Compact simulation state is supplied by the owned tool');
    value.source=structuredClone(source);value.analysis='current';
    value.evidenceContext={teamId:source.teamId,roomId:canonicalEvidenceRoom(source.room),turn};
  }
  return value;
}
