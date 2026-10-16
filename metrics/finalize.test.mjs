import test from 'node:test';
import assert from 'node:assert/strict';
import {cp,mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join,dirname} from 'node:path';
import {tmpdir} from 'node:os';
import {saveBattle,getTeamReport} from './store.mjs';
import {finalizeBo3} from './finalize.mjs';
import {readGameEvidence,saveGameEvidence,buildCleanupPlan,cleanupBo3Files} from './retention.mjs';
import {registerTeamFromText} from './import.mjs';
import {attachVerifiedReplay} from './replay-evidence.mjs';
import {annotateGame} from './annotations.mjs';
import {readSkill} from '../workflow/skill-service.mjs';
import {saveReview} from '../workflow/reviews.mjs';

const teamId='a'.repeat(64),parentId='game-bestof3-gen9championsvgc2026regmcbo3-100';
const room=n=>'battle-gen9championsvgc2026regmcbo3-'+n;
const sourceFile='cache/bo3-runs/'+parentId+'/events.jsonl',checkpointFile='cache/champions-mc-reviews/set.json';
const protocol=n=>`|gametype|doubles\n|tier|[Gen 9] Champions VGC 2026 Reg M-C (Bo3)\n|player|p1|Fixture\n|player|p2|Opponent\n|start\n|switch|p1a: Sylveon|Sylveon, L50|100/100\n|switch|p2a: Pikachu|Pikachu, L50|100/100\n|turn|1\n|move|p1a: Sylveon|Protect|p1a: Sylveon\n|win|Fixture`;
const events=n=>protocol(n).split('\n').map(line=>{const [,type,...data]=line.split('|');return {room:room(n),event:'battle-event',type,data};});
const record=n=>({schemaVersion:1,roomId:room(n),parentId,teamId,username:'Fixture',ownSide:'p1',players:{p1:'Fixture',p2:'Opponent'},outcome:'win',completed:true,turns:1,opponentRoster:['Pikachu'],selected:['Sylveon'],selectionKnown:true,leads:['Sylveon'],pokemon:[{key:'sylveon:1',species:'Sylveon',forms:[],selected:true,lead:true,moves:[{move:'Protect',uses:1}]}],quality:{complete:true,operational:false,warnings:[]},team:{name:'Fixture',format:'gen9championsvgc2026regmc',roster:['Sylveon']},metadata:{setResult:{outcome:'win',completed:true},sources:[sourceFile]}});
async function setup(){
  const workspace=await mkdtemp(join(tmpdir(),'vgcm-finalize-'));
  await mkdir(join(workspace,'cache','bo3-runs',parentId),{recursive:true});await mkdir(join(workspace,'cache','champions-mc-reviews'),{recursive:true});
  await writeFile(join(workspace,sourceFile),[...events(101),...events(102)].map(value=>JSON.stringify(value)).join('\n'));
  await writeFile(join(workspace,checkpointFile),JSON.stringify({parentId,teamSha256:teamId,status:'review-complete',reviewedAt:'2026-10-15T20:00:00Z',decisionReview:{reviewed:true},reusableOutcome:{action:'no-change',reason:'Fixture'},adoption:{sourceSha256:'b'.repeat(64),installedSha256:'b'.repeat(64),syncVerified:true},children:[{id:room(101)},{id:room(102)}]}));
  await saveBattle({workspace,record:record(101)});await saveBattle({workspace,record:record(102)});return workspace;
}
const args=workspace=>({workspace,teamId,parentId,checkpointFile,sourceFiles:[sourceFile],cleanupFiles:[sourceFile]});
const call=async(_descriptor,command)=>{assert.equal(command.op,'save-replays');assert.equal(command.room,parentId);assert.equal(command.confirmed,true);return {ok:true,result:{parentId,complete:true,failures:[],replays:[101,102].map(n=>({roomId:room(n),verified:true,url:'https://replay.pokemonshowdown.com/'+room(n).slice(7)+'-privatepw',verifiedAt:'2026-10-15T20:00:00Z'}))}};};
const fetchImpl=async url=>{const n=Number(/-(\d+)(?:-privatepw)?\.json$/.exec(url)[1]);return new Response(JSON.stringify({id:room(n).slice(7),formatid:'gen9championsvgc2026regmcbo3',log:protocol(n)}));};

test('BO3 finalization preserves replay links and readable compressed evidence before removing a closed run log',async()=>{
  const workspace=await setup();try{
    const result=await finalizeBo3({...args(workspace),dryRun:false,confirmed:true,saveReplays:true,call,fetchImpl});
    assert.equal(result.replayFailures.length,0);assert.equal(result.archiveFailures.length,0);
    assert.equal(result.cleanup.removed.length,1);await assert.rejects(readFile(join(workspace,sourceFile)),{code:'ENOENT'});
    const report=await getTeamReport({workspace,teamId});assert.equal(report.totals.games,2);
    assert(report.games.every(game=>game.replay?.verified&&game.evidence?.complete));
    const evidence=await readGameEvidence({workspace,teamId,roomId:room(101),fromTurn:1,toTurn:1});
    assert(evidence.events.some(event=>event.type==='move'&&event.data.includes('Protect')));
    assert((await readFile(result.stableReport.path,'utf8')).includes('Watch replay'));
  }finally{await rm(workspace,{recursive:true,force:true});}
});
test('finalization dry run neither uploads, writes evidence nor deletes files',async()=>{
  const workspace=await setup();try{
    const before=await readFile(join(workspace,sourceFile),'utf8');
    const result=await finalizeBo3({...args(workspace),saveReplays:true,call:()=>assert.fail('Dry run must not call a live client')});
    assert.equal(result.dryRun,true);assert.equal(await readFile(join(workspace,sourceFile),'utf8'),before);
    assert((await getTeamReport({workspace,teamId})).games.every(game=>!game.replay&&!game.evidence));
  }finally{await rm(workspace,{recursive:true,force:true});}
});
test('replay failure keeps the raw run log while retaining useful local evidence',async()=>{
  const workspace=await setup();try{
    const result=await finalizeBo3({...args(workspace),dryRun:false,confirmed:true,saveReplays:true,call:async()=>({ok:false,error:'Unavailable'})});
    assert.equal(result.replayFailures.length,1);assert.equal(result.cleanup.removed.length,0);
    assert((await readFile(join(workspace,sourceFile),'utf8')).length>0);
    assert((await getTeamReport({workspace,teamId})).games.every(game=>game.evidence?.complete));
  }finally{await rm(workspace,{recursive:true,force:true});}
});
test('an invalid or wrong-team checkpoint cannot publish replays or remove data',async()=>{
  const workspace=await setup();try{
    const checkpoint=JSON.parse(await readFile(join(workspace,checkpointFile),'utf8'));checkpoint.teamSha256='c'.repeat(64);await writeFile(join(workspace,checkpointFile),JSON.stringify(checkpoint));
    await assert.rejects(finalizeBo3({...args(workspace),dryRun:false,confirmed:true,saveReplays:true,call:()=>assert.fail('Invalid review cannot publish')}),/checkpoint/);
    assert((await readFile(join(workspace,sourceFile),'utf8')).length>0);
  }finally{await rm(workspace,{recursive:true,force:true});}
});
async function structuredFixture(t){
  const workspace=await mkdtemp(join(tmpdir(),'vgcm-finalize-current-'));t.after(()=>rm(workspace,{recursive:true,force:true}));
  const source=join(workspace,'skills/champions-mc-matchups'),target=join(workspace,'installed/champions-mc-matchups');
  await mkdir(join(source,'references'),{recursive:true});await writeFile(join(source,'SKILL.md'),'---\nname: champions-mc-matchups\ndescription: Fixture\n---\nReview observed facts.\n');await writeFile(join(source,'references/headless-battle-cycle.md'),'Keep review evidence.\n');await cp(source,target,{recursive:true});
  const teamText=[['Golisopod','Emergency Exit'],['Kommo-o','Soundproof'],['Rillaboom','Grassy Surge'],['Politoed','Drizzle'],['Farigiraf','Armor Tail'],['Sylveon','Pixilate']].map(([species,ability])=>`${species}\nAbility: ${ability}\nLevel: 50\nEVs: 32 HP / 32 SpA / 2 SpD\nModest Nature\n- Protect`).join('\n\n');
  const {teamId:exactTeam}=await registerTeamFromText({workspace,teamText});
  await mkdir(dirname(join(workspace,sourceFile)),{recursive:true});await writeFile(join(workspace,sourceFile),[...events(101),...events(102)].map(value=>JSON.stringify(value)).join('\n'));
  for(const n of [101,102]){const base=record(n);await saveBattle({workspace,record:{...base,teamId:exactTeam,team:{...base.team,roster:['Golisopod','Kommo-o','Rillaboom','Politoed','Farigiraf','Sylveon']},metadata:{...base.metadata,setResult:{outcome:'win',completed:true,expectedChildIds:[room(101),room(102)]}}}});await saveGameEvidence({workspace,teamId:exactTeam,roomId:room(n),events:events(n)});await attachVerifiedReplay({workspace,teamId:exactTeam,roomId:room(n),url:'https://replay.pokemonshowdown.com/'+room(n).slice(7)+'-privatepw',fetchImpl});}
  const skillOptions={target},readReceipt=(await readSkill({workspace,target})).readReceipt;
  const saved=await saveReview({workspace,teamId:exactTeam,parentId,skillOptions,readReceipt,decisionReview:[{roomId:room(101),turn:1,knownBefore:'Protect is on the registered sheet.',opposingRead:'Either target could be attacked.',selected:'Unknown private choice.',executed:'Protect executed.',partnerProgress:'Unknown.',limitation:'Abbreviated fixture cannot validate alternatives.'}],positiveEvidence:[{roomId:room(101),turn:1,observation:'Protect executed.',whyPreserve:'Keep intent and execution separate.'}],executionAndVariance:[],reusableOutcome:{kind:'no-change',reason:'No supported new tactical lesson.',evidence:[{roomId:room(102),turn:1,observation:'Protect executed in the second game.'}]},validation:[{check:'Evidence scope',result:'Checked',evidence:'No numerical claims or invented selected choices.'}]});
  return {workspace,teamId:exactTeam,parentId,checkpointFile:saved.checkpointFile,sourceFiles:[sourceFile],cleanupFiles:[sourceFile],skillOptions,source};
}
test('current structured review validates for finalization, then new annotations block all cleanup and replay publication',async t=>{
  const value=await structuredFixture(t),preview=await finalizeBo3(value);assert.equal(preview.cleanup.ready,true);assert.equal(preview.cleanup.reviewValidation.mode,'structured-current-review');
  await annotateGame({workspace:value.workspace,teamId:value.teamId,roomId:room(101),reason:'A newly reviewed decision annotation changes the evidence revision.'});
  const dry=await finalizeBo3(value);assert.equal(dry.cleanup.ready,false);assert.match(dry.cleanup.blockers.join(' '),/changed after this review/);
  const cleanup=await cleanupBo3Files({...value,files:[sourceFile],confirmed:true});assert.equal(cleanup.removedCount,0);
  await assert.rejects(finalizeBo3({...value,dryRun:false,confirmed:true,saveReplays:true,call:()=>assert.fail('Stale review cannot publish')}),/current completed.*changed after this review/);
  assert((await readFile(join(value.workspace,sourceFile),'utf8')).length>0);
});
test('changed current guidance and noncanonical structured checkpoint copies block cleanup',async t=>{
  const value=await structuredFixture(t),copy='cache/champions-mc-reviews/copied-current.json';await writeFile(join(value.workspace,copy),await readFile(join(value.workspace,value.checkpointFile)));
  const copied=await buildCleanupPlan({...value,checkpointFile:copy,files:[sourceFile]});assert.equal(copied.ready,false);assert.match(copied.blockers.join(' '),/canonical current/);
  await writeFile(join(value.source,'SKILL.md'),'Changed maintained guidance.\n');const stale=await buildCleanupPlan({...value,files:[sourceFile]});assert.equal(stale.ready,false);assert.match(stale.blockers.join(' '),/current repository and installed guidance/);
  assert((await readFile(join(value.workspace,sourceFile),'utf8')).length>0);
});
test('an unchanged structured service review allows confirmed finalization with current retained evidence',async t=>{
  const value=await structuredFixture(t),result=await finalizeBo3({...value,dryRun:false,confirmed:true});assert.equal(result.cleanup.reviewValidation.complete,true);assert.equal(result.cleanup.reviewValidation.mode,'structured-current-review');assert.equal(result.cleanup.removedCount,1);await assert.rejects(readFile(join(value.workspace,sourceFile)),{code:'ENOENT'});
});
