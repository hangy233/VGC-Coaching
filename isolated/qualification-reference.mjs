// An explicit reference-team transition separates technical interface evidence
// from the exact live roster. It never changes archived inputs or provider receipts.
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {digest} from '../planning/identity.mjs';

const HASH=/^[a-f0-9]{64}$/u,admissions=new WeakMap();
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const exact=(value,keys)=>object(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const sha=value=>createHash('sha256').update(value).digest('hex');
const need=(ok)=>{if(!ok)throw Object.assign(new Error('The explicit qualification reference does not match this live scope, source or saved input.'),{code:'QUALIFICATION_REFERENCE'});};
const PROFILE=Object.freeze({provider:'codex-cli',model:'gpt-6.1-sol',reasoningEffort:'low',serviceTier:'fast',contextMode:'session',authenticationMethod:'chatgpt'});
const text=value=>typeof value==='string'&&value.length>0&&value.length<=2048&&!/[\x00-\x1f]/u.test(value);
const binding=({identity,scope,ownTeamText,requests,profile})=>digest({identity,scope,ownTeamText,requests,profile});
const {Teams,TeamValidator}=createRequire(import.meta.url)('pokemon-showdown');

export function validateQualificationReferenceShape(value){
  need(exact(value,['version','purpose','reference','live','authorizationSha256','sourcePinsSha256','skillVersion','skillSha256','profile'])&&value.version===1&&value.purpose==='interface-only');
  need(exact(value.reference,['teamId','file','sha256'])&&HASH.test(value.reference.teamId)&&text(value.reference.file)&&HASH.test(value.reference.sha256));
  need(exact(value.live,['sessionId','account','teamId','teamFile','teamTextSha256'])&&text(value.live.sessionId)&&text(value.live.account)&&HASH.test(value.live.teamId)&&text(value.live.teamFile)&&HASH.test(value.live.teamTextSha256));
  need(['authorizationSha256','sourcePinsSha256','skillSha256'].every(key=>HASH.test(value[key]))&&text(value.skillVersion));
  need(exact(value.profile,Object.keys(PROFILE))&&digest(value.profile)===digest(PROFILE));
  return structuredClone(value);
}

/** Called independently by the launcher and runner before native control. */
export function admitQualificationReference({identity,scope,ownTeamText,document,referenceFile,referenceText,sourcePins,profile}={}){
  need(HASH.test(identity?.teamId??'')&&HASH.test(document?.teamId??''));
  const crossTeam=identity.teamId!==document.teamId,declared=scope?.qualificationReference;
  need(crossTeam?declared!==undefined:declared===undefined);
  if(crossTeam){
    const value=validateQualificationReferenceShape(declared);
    need(value.reference.teamId===document.teamId&&value.reference.file===referenceFile&&typeof referenceText==='string'&&value.reference.sha256===sha(referenceText));
    need(exact(value.live,['sessionId','account','teamId','teamFile','teamTextSha256'])&&['sessionId','account','teamId','teamFile'].every(key=>value.live[key]===identity[key]));
    need(scope.sessionId===identity.sessionId&&scope.account===identity.account&&scope.teamId===identity.teamId&&typeof ownTeamText==='string'&&value.live.teamTextSha256===sha(ownTeamText));
    const team=Teams.import(ownTeamText);
    need(team?.length===6&&sha(Teams.pack(team))===identity.teamId);
    need(!new TeamValidator('gen9championsvgc2026regmc').validateTeam(team)&&sha(Teams.pack(team))===identity.teamId);
    need(typeof scope.authorization==='string'&&value.authorizationSha256===sha(scope.authorization));
    need(value.sourcePinsSha256===sourcePins?.sha256&&value.skillSha256===sourcePins?.skillSha256&&value.skillVersion===sourcePins?.skillVersion);
    need(object(profile)&&object(sourcePins?.profile)&&digest(value.profile)===digest(profile)&&digest(value.profile)===digest(sourcePins.profile));
    need(document.kind==='saved-model-tool-qualification-requests'&&Array.isArray(document.requests)&&document.requests.length>=3&&document.skillSha256===value.skillSha256&&document.skillVersion===value.skillVersion);
    need(typeof referenceText==='string'&&digest(JSON.parse(referenceText))===digest(document));
  }
  const proof=Object.freeze({kind:'qualification-reference-admission',mode:crossTeam?'explicit-reference-team':'same-team',liveTeamId:identity.teamId,referenceTeamId:document.teamId,
    interfaceOnly:true,exactLiveTeamSavedRequests:!crossTeam,
    ...(crossTeam?{referenceFileSha256:declared.reference.sha256,liveTeamTextSha256:declared.live.teamTextSha256,sourcePinsSha256:sourcePins.sha256}:{}),
    limitation:crossTeam?'Technical interface evidence uses the unchanged historical reference team; no saved-position or tactical result is claimed for the live team.':'Saved-position technical evidence uses this team; qualification establishes no tactical score guarantee.'});
  admissions.set(proof,{binding:binding({identity,scope,ownTeamText,requests:document.requests,profile}),referenceTeamId:document.teamId});
  return proof;
}

/** A parsed report or caller-authored referenceTeamId cannot authorize a transition. */
export function verifyQualificationReferenceAdmission(proof,{identity,scope,ownTeamText,requests,profile}={}){
  const receipt=admissions.get(proof);
  need(receipt&&receipt.binding===binding({identity,scope,ownTeamText,requests,profile}));
  return receipt.referenceTeamId;
}
