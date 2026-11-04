import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {admitQualificationReference,validateQualificationReferenceShape,verifyQualificationReferenceAdmission} from './qualification-reference.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const {Teams}=createRequire(import.meta.url)('pokemon-showdown');
const PROFILE={provider:'codex-cli',model:'gpt-6.1-sol',reasoningEffort:'low',serviceTier:'fast',contextMode:'session',authenticationMethod:'chatgpt'};
function fixture(){
  // Public, synthetic legal six; not a saved battle or a provider qualification.
  const ownTeamText=[['Garchomp','Rough Skin'],['Arcanine','Intimidate'],['Milotic','Competitive'],['Gengar','Cursed Body'],['Scizor','Technician'],['Dragonite','Multiscale']]
    .map(([species,ability])=>`${species}\nAbility: ${ability}\nLevel: 50\nEVs: 32 HP / 32 Def / 2 SpD\nSerious Nature\n- Protect`).join('\n\n');
  const identity={version:1,sessionId:'synthetic-live-session',account:'Fixture User',teamFile:'team.txt',teamId:sha(Teams.pack(Teams.import(ownTeamText)))};
  const scope={sessionId:identity.sessionId,account:identity.account,teamId:identity.teamId,authorization:'Explicit synthetic one-set transition authorization.'};
  const document={kind:'saved-model-tool-qualification-requests',teamId:'f'.repeat(64),skillVersion:'fixture-version',skillSha256:'b'.repeat(64),requests:[1,2,3].map(index=>({syntheticOnly:true,sourceIndex:index,identity:{teamId:'f'.repeat(64)}}))};
  const referenceText=JSON.stringify(document),referenceFile='cache/reference.json',sourcePins={sha256:'c'.repeat(64),skillVersion:document.skillVersion,skillSha256:document.skillSha256,profile:PROFILE};
  scope.qualificationReference={version:1,purpose:'interface-only',reference:{teamId:document.teamId,file:referenceFile,sha256:sha(referenceText)},
    live:{sessionId:identity.sessionId,account:identity.account,teamId:identity.teamId,teamFile:identity.teamFile,teamTextSha256:sha(ownTeamText)},authorizationSha256:sha(scope.authorization),sourcePinsSha256:sourcePins.sha256,skillVersion:document.skillVersion,skillSha256:document.skillSha256,profile:structuredClone(PROFILE)};
  return {identity,scope,ownTeamText,document,referenceText,referenceFile,sourcePins,profile:PROFILE};
}

test('an explicit technical reference preserves original source and grants no model or battle receipt',()=>{
  const input=fixture(),before=JSON.stringify(input),proof=admitQualificationReference(input);
  assert.equal(proof.mode,'explicit-reference-team');assert.equal(proof.referenceTeamId,input.document.teamId);assert.equal(proof.liveTeamId,input.identity.teamId);
  assert.equal(proof.exactLiveTeamSavedRequests,false);assert.equal(proof.interfaceOnly,true);assert.equal(Object.hasOwn(proof,'qualified'),false);
  assert.equal(JSON.stringify(input),before);assert.equal(Object.isFrozen(proof),true);
  assert.equal(verifyQualificationReferenceAdmission(proof,{...input,requests:input.document.requests}),input.document.teamId);
  assert.throws(()=>verifyQualificationReferenceAdmission(structuredClone(proof),{...input,requests:input.document.requests}),{code:'QUALIFICATION_REFERENCE'});
});

test('same-team admission stays the default and an undeclared cross-team transition refuses',()=>{
  const input=fixture();delete input.scope.qualificationReference;
  assert.throws(()=>admitQualificationReference(input),{code:'QUALIFICATION_REFERENCE'});
  input.document.teamId=input.identity.teamId;
  const proof=admitQualificationReference(input);assert.equal(proof.mode,'same-team');assert.equal(proof.exactLiveTeamSavedRequests,true);
  const redundant=fixture();redundant.document.teamId=redundant.identity.teamId;
  assert.throws(()=>admitQualificationReference(redundant),{code:'QUALIFICATION_REFERENCE'});
});

test('every explicit source, live export, authorization, profile and source pin is bound',()=>{
  const mutations=[
    input=>{input.referenceFile='cache/other.json';},input=>{input.referenceText+=' ';},input=>{input.document.requests[1].sourceIndex=99;},
    input=>{input.identity.sessionId='foreign';},input=>{input.identity.account='Foreign User';},input=>{input.identity.teamId='e'.repeat(64);},input=>{input.identity.teamFile='other.txt';},
    input=>{input.ownTeamText+='\n';},input=>{input.scope.authorization+=' Changed';},input=>{input.scope.teamId='e'.repeat(64);},input=>{input.scope.sessionId='foreign';},input=>{input.scope.account='Foreign User';},
    input=>{input.sourcePins.sha256='d'.repeat(64);},input=>{input.sourcePins.skillSha256='d'.repeat(64);},input=>{input.sourcePins.skillVersion='stale';},
    input=>{input.profile={...PROFILE,model:'other'};},input=>{input.sourcePins.profile={...PROFILE,serviceTier:'standard'};},
    input=>{input.scope.qualificationReference.purpose='new-team-proven';},input=>{input.scope.qualificationReference.reference.teamId='d'.repeat(64);},
    input=>{input.scope.qualificationReference.live.extra=true;},input=>{input.scope.qualificationReference.extra=true;},input=>{input.scope.qualificationReference.profile.extra=true;},
  ];
  for(const [index,mutate] of mutations.entries()){
    const input=fixture();mutate(input);assert.throws(()=>admitQualificationReference(input),{code:'QUALIFICATION_REFERENCE'},`mutation ${index}`);
  }
});

test('recomputing an export hash does not bypass exact live roster identity or native legality',()=>{
  for(const replacement of ['Garchomp','MissingNo']){
    const input=fixture();input.ownTeamText=input.ownTeamText.replace('Arcanine',replacement);
    input.identity.teamId=sha(Teams.pack(Teams.import(input.ownTeamText)));input.scope.teamId=input.identity.teamId;
    input.scope.qualificationReference.live.teamId=input.identity.teamId;input.scope.qualificationReference.live.teamTextSha256=sha(input.ownTeamText);
    assert.throws(()=>admitQualificationReference(input),{code:'QUALIFICATION_REFERENCE'});
  }
});

test('a branded transition cannot be carried across changed current scope, request bundle or provider profile',()=>{
  for(const mutate of [input=>{input.scope.authorization+=' changed';},input=>{input.identity.sessionId='other';},input=>{input.ownTeamText+='\n';},input=>{input.document.requests[0].sourceIndex=0;},input=>{input.profile={...PROFILE,reasoningEffort:'medium'};}]){
    const input=fixture(),proof=admitQualificationReference(input);mutate(input);
    assert.throws(()=>verifyQualificationReferenceAdmission(proof,{...input,requests:input.document.requests}),{code:'QUALIFICATION_REFERENCE'});
  }
  assert.throws(()=>validateQualificationReferenceShape({version:1}),{code:'QUALIFICATION_REFERENCE'});
});
