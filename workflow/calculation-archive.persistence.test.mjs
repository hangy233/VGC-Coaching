// Storage roundtrip only; fixture payloads do not claim numerical evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {registerTeamFromText} from '../metrics/import.mjs';
import {choiceFixtureRegistration} from '../simulation/choice-fixture.mjs';
import {recordCalculation,readCalculation} from './calculations.mjs';

test('large compact evidence remains team-owned and transparently lossless under the existing file limit',async()=>{
  const workspace=await mkdtemp(join(tmpdir(),'vgc-archive-persistence-'));
  try{
    const {teamText}=choiceFixtureRegistration(),{teamId}=await registerTeamFromText({workspace,teamText,name:'Synthetic storage fixture'});
    const input={request:{ourActions:[{type:'move',slot:4},{type:'move',slot:4}]},records:Array.from({length:1200},(_,i)=>({id:i,text:'Exact synthetic storage record; not a numerical result. '.repeat(10)}))};
    const result={kind:'synthetic-storage-only',value:'Original complete output'};
    const receipt=await recordCalculation({workspace,tool:'simulate_choices',input,result,context:{teamId,roomId:'battle-gen9championsvgc2026regmcbo3-919',turn:1}});
    const path=join(workspace,receipt.path),bytes=await readFile(path),stored=JSON.parse(bytes);
    assert(bytes.length<=512*1024);assert(stored.payloadArchive);assert.equal(stored.input,undefined);
    const restored=await readCalculation({workspace,teamId,id:receipt.id});assert.deepEqual(restored.input,input);assert.deepEqual(restored.result,result);
    assert.equal(restored.sha256,receipt.sha256);assert.equal(restored.payloadArchive,undefined);
    stored.payloadArchive.rawBytes++;await writeFile(path,JSON.stringify(stored));
    await assert.rejects(readCalculation({workspace,teamId,id:receipt.id}),/byte count|digest/);
    await assert.rejects(recordCalculation({workspace,tool:'calculate_damage',input,result,context:{teamId,roomId:'battle-gen9championsvgc2026regmcbo3-919'}}),/size limit/);
  }finally{
    assert(resolve(workspace).startsWith(resolve(tmpdir())+sep));
    await rm(workspace,{recursive:true,force:true});
  }
});
