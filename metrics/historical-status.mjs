import {createHash,randomUUID} from 'node:crypto';
import {link,lstat,mkdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {promisify} from 'node:util';
import {gzip,gunzip} from 'node:zlib';
import {ownedParentStatusProjection,historicalOwnedParentPreviewProof} from './preview-terminal.mjs';

const compress=promisify(gzip),decompress=promisify(gunzip),MAX_BYTES=2*1024*1024,HASH=/^[a-f0-9]{64}$/u;
const fail=()=>new Error('Historical status capture could not be verified; retain its original evidence.');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const contained=(root,path)=>{const part=relative(root,path);return part!==''&&part!=='..'&&!part.startsWith('..'+sep)&&!isAbsolute(part);};
const sourceName=value=>typeof value==='string'&&/^cache\/(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.json$/iu.test(value)&&/status[^/]*\.json$/iu.test(value)&&!/(?:credential|password|secret|cookie|token|login|session|control|broker|lease)/iu.test(value);

async function checked(workspace,file,{create=false,missing=false}={}) {
  const root=await realpath(workspace),path=resolve(root,file);
  if(!contained(root,path))throw fail();
  let current=root;
  const parts=relative(root,path).split(sep);
  for(const [index,part]of parts.entries()){
    current=join(current,part);let info;
    try{info=await lstat(current);}catch(error){
      if(error.code!=='ENOENT')throw error;
      if(index<parts.length-1&&create){try{await mkdir(current);}catch(created){if(created.code!=='EEXIST')throw created;}info=await lstat(current);}
      else if(index===parts.length-1&&missing)return {root,path,relative:relative(root,path).replaceAll('\\','/'),info:null};
      else throw error;
    }
    if(info.isSymbolicLink()||(index<parts.length-1?!info.isDirectory():!info.isFile()||info.size>MAX_BYTES)||!contained(root,await realpath(current)))throw fail();
    if(index===parts.length-1)return {root,path,relative:relative(root,path).replaceAll('\\','/'),info};
  }
  throw fail();
}

function decode(bytes){
  let value;try{value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{throw fail();}
  const envelope=value&&Object.hasOwn(value,'ok');
  if(envelope&&(value.ok!==true||typeof value.id!=='string'||value.id.length>200||Object.keys(value).some(key=>!['id','ok','result'].includes(key))))throw fail();
  const status=envelope?value.result:value;
  if(!status||typeof status!=='object'||Array.isArray(status)||!Number.isSafeInteger(status.revision)||status.revision<0||['previewProof','previewObservation','previewCorroboration','captureAttestation'].some(key=>Object.hasOwn(status,key)))throw fail();
  return {status,envelope:envelope?'ipc-response':'raw-status',...(envelope?{replyId:value.id}:{})};
}

/** Read actual bytes; the expected hash is integrity, never an origin receipt. */
export async function readHistoricalCapture({workspace,statusFile,statusSha256}={}){
  if(!sourceName(statusFile)||!HASH.test(statusSha256??''))throw fail();
  const source=await checked(workspace,statusFile);
  const {readWorkspaceFile}=await import('./import.mjs');
  await readWorkspaceFile(workspace,source.relative,{extensions:['.json'],maxBytes:MAX_BYTES});
  const bytes=await readFile(source.path);
  if(bytes.length>MAX_BYTES||digest(bytes)!==statusSha256)throw fail();
  return {bytes,sourceFile:source.relative,sha256:statusSha256,...decode(bytes)};
}

export const historicalArchivePath=(teamId,roomId)=>`cache/team-metrics/evidence/${roomId}--${teamId}.owned-status.json.gz`;

/** Preserve original capture bytes immutably, separately from protocol facts. */
export async function archiveHistoricalCapture({workspace,teamId,roomId,capture}={}){
  if(!HASH.test(teamId??'')||!/^battle-gen9championsvgc2026regmcbo3-[1-9]\d*$/u.test(roomId??'')||!Buffer.isBuffer(capture?.bytes)||capture.bytes.length>MAX_BYTES||digest(capture.bytes)!==capture.sha256)throw fail();
  const target=await checked(workspace,historicalArchivePath(teamId,roomId),{create:true,missing:true});
  const matches=async()=>{const previous=await checked(workspace,target.relative),bytes=await decompress(await readFile(previous.path),{maxOutputLength:MAX_BYTES});if(digest(bytes)!==capture.sha256)throw new Error('Existing historical status evidence differs; retain it for review.');};
  if(target.info){await matches();return;}
  const pending=join(dirname(target.path),`.pending-${teamId}-${randomUUID()}.tmp`);
  try{
    await writeFile(pending,await compress(capture.bytes,{level:9}),{flag:'wx',mode:0o600});
    try{await link(pending,target.path);}catch(error){if(error.code!=='EEXIST')throw error;await matches();}
  }finally{await rm(pending,{force:true});}
}

/** Recheck archive integrity, original identity and the retained projection. */
export async function verifyHistoricalStatusArchive({workspace,game,observation}={}){
  if(!historicalOwnedParentPreviewProof(game,observation)||observation.snapshot.path!==historicalArchivePath(game.teamId,game.roomId)||!sourceName(observation.snapshot.sourceFile))throw fail();
  const source=await checked(workspace,observation.snapshot.path),bytes=await decompress(await readFile(source.path),{maxOutputLength:MAX_BYTES});
  if(digest(bytes)!==observation.snapshot.sha256)throw fail();
  const decoded=decode(bytes),projected=ownedParentStatusProjection(decoded.status,game);
  if(!projected||JSON.stringify(projected)!==JSON.stringify(observation.capturedStatus)||decoded.envelope!==observation.snapshot.envelope||(decoded.replyId??null)!==(observation.snapshot.replyId??null))throw fail();
  return {sha256:observation.snapshot.sha256,sessionId:projected.sessionId,revision:projected.revision};
}
