import {createHash} from 'node:crypto';
import {MAX_CONTEXT_BYTES} from './context-limits.mjs';
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const bytes=value=>Buffer.byteLength(typeof value==='string'?value:JSON.stringify(value));
export function prepareCodexDecisionContext({instructions,input,schema}={}){
  if(typeof instructions!=='string'||typeof input!=='string'||!schema||typeof schema!=='object'||bytes(input)+bytes(instructions)+bytes(schema)>MAX_CONTEXT_BYTES)throw Object.assign(new Error('Complete bounded native Codex context required.'),{code:'CODEX_DECISION_WIRE'});
  return {instructions,input,schema:structuredClone(schema),metadata:{version:1,format:'native',reason:'native-model-tool-interface',nativeSchemaSha256:hash(schema),inputSha256:hash(input),sourceInputBytes:bytes(input),sourceInstructionsBytes:bytes(instructions),outputSchemaBytes:bytes(schema),preparedInstructionsBytes:bytes(instructions),sourceDeadlineUnchanged:true}};
}
export function decodeCodexDecision(value){return {decision:value,metadata:{format:'native',nativeValidationRequired:true}};}
