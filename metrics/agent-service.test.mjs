import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {registerTeamFromFile} from './import.mjs';
import {saveBattle,getTeamReport,listTeams} from './store.mjs';
import {getAgentTeamReport,createAgentTeamReport} from './agent-service.mjs';

const TEAM=[['Golisopod','Emergency Exit'],['Kommo-o','Soundproof'],['Rillaboom','Grassy Surge'],['Politoed','Drizzle'],['Farigiraf','Armor Tail'],['Sylveon','Pixilate']].map(([name,ability])=>`${name}\nAbility: ${ability}\nLevel: 50\nEVs: 32 HP / 32 SpA / 2 SpD\nModest Nature\n- Protect`).join('\n\n');
const record=(id,teamId,opponent,source,operational=false)=>({schemaVersion:1,roomId:'battle-fixture-'+id,parentId:null,teamId,username:'Fixture',ownSide:'p1',players:{p1:'Fixture',p2:'Opponent'},outcome:'win',completed:true,turns:1,opponentRoster:[opponent],selected:['Golisopod'],selectionKnown:true,leads:['Golisopod'],pokemon:[{key:'golisopod:1',species:'Golisopod',forms:[],selected:true,lead:true,moves:[{move:'Protect',uses:1}]}],quality:{complete:true,operational,warnings:[]},team:{name:'Rain',format:'gen9championsvgc2026regmc',roster:['Golisopod','Kommo-o','Rillaboom','Politoed','Farigiraf','Sylveon']},metadata:{sources:[source],endedAt:'2026-10-15T20:00:00Z'}});

test('agent evidence follows the exact cached team and filtered included games without changing background LRU',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'vgcm-agent-service-'));
  try{
    await mkdir(join(workspace,'teams'));await writeFile(join(workspace,'teams/team.txt'),TEAM);
    const registered=await registerTeamFromFile({workspace,teamFile:'teams/team.txt'}),teamId=registered.teamId;
    await saveBattle({workspace,record:record(1,teamId,'Archaludon','cache/archaludon.jsonl')});
    await saveBattle({workspace,record:record(2,teamId,'Charizard','cache/charizard.jsonl')});
    await saveBattle({workspace,record:record(3,teamId,'Archaludon','cache/default-only.jsonl',true)});
    await saveBattle({workspace,record:record(4,'b'.repeat(64),'Archaludon','cache/other-team.jsonl')});
    await writeFile(join(workspace,'teams/team.txt'),TEAM.replace('32 HP / 32 SpA / 2 SpD','31 HP / 32 SpA / 3 SpD'));
    const report=await getTeamReport({workspace,teamId,opponentSpecies:'Archaludon',touch:false});
    const order=(await listTeams({workspace})).find(team=>team.teamId===teamId).usageOrder;
    const brief=await createAgentTeamReport({workspace,report});
    assert.equal(brief.team.teamId,teamId);assert.equal(brief.totals.games,1);assert.equal(brief.quality.excludedOperational,1);
    assert.equal(brief.provenance.teamSnapshot.status,'available');
    assert.equal(brief.team.teamSheet.pokemon[0].evs.hp,32);
    assert.deepEqual(brief.provenance.sourceFiles.map(source=>source.path),['cache/archaludon.jsonl']);
    assert(brief.provenance.gameSources.every(game=>game.roomId==='battle-fixture-1'));
    assert.equal(brief.provenance.latestGameAt,'2026-10-15T20:00:00.000Z');
    assert.equal(brief.provenance.turnEvidenceIncluded,false);assert.equal(brief.provenance.decisionEvidenceIncluded,false);
    assert.equal((await listTeams({workspace})).find(team=>team.teamId===teamId).usageOrder,order);
    const accessed=await getAgentTeamReport({workspace,teamId,opponentSpecies:'Archaludon',includeGames:true});
    assert.equal(accessed.games.length,1);assert.equal(accessed.games[0].roomId,'battle-fixture-1');
  }finally{await rm(workspace,{recursive:true,force:true});}
});

test('missing team snapshots are explicit and never invent a set from the roster',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'vgcm-agent-missing-'));
  try{
    const teamId='a'.repeat(64);await saveBattle({workspace,record:record(1,teamId,'Archaludon','live-client')});
    const brief=await getAgentTeamReport({workspace,teamId});
    assert.equal(brief.provenance.teamSnapshot.status,'missing');
    assert.equal(brief.team.teamSheet.pokemon.length,0);
    assert.equal(brief.provenance.sourceFiles[0].kind,'client-observation');
    assert.equal(brief.totals.games,1);
  }finally{await rm(workspace,{recursive:true,force:true});}
});
