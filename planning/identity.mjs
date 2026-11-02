import {createHash} from 'node:crypto';
export const canonical=value=>Array.isArray(value)?'['+value.map(canonical).join(',')+']':value&&typeof value==='object'?'{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical(value[key])).join(',')+'}':JSON.stringify(value);
export const digest=value=>createHash('sha256').update(canonical(value)).digest('hex');
// Only mechanical board fields: reader clocks and repeated log presentation do
// not establish a different board; changed HP, field, legality or identity does.
export function boardDigest(board,legalActions){
  return digest({turn:board?.turn,ownSide:board?.ownSide,field:board?.field,sides:board?.sides,request:board?.request,legalActions});
}
export function requestDigest({sessionId,teamId,room,rqid,token,boardHash}){return digest({sessionId,teamId,room,rqid,token,boardHash});}
