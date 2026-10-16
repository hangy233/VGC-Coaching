import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {saveBattle,getTeamReport} from './store.mjs';
import {finalizeBo3} from './finalize.mjs';
import {readGameEvidence} from './retention.mjs';

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
