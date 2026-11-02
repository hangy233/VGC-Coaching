import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createAttentionAlert} from './attention-alert.mjs';

const parent='game-bestof3-gen9championsvgc2026regmcbo3-812';
async function fixture(t){const directory=await mkdtemp(join(tmpdir(),'vgc-attention-'));t.after(()=>rm(directory,{recursive:true,force:true}));return {directory,alert:createAttentionAlert({directory})};}
const manual=()=>({manualOnly:true,command:{id:'contain-'+'a'.repeat(24),op:'call',name:'battle_forfeit',args:{confirmed:true,commandId:'contain-'+'a'.repeat(24),room:parent}}});

test('the independent alarm is readable immediately before any stream consumer or cleanup',async t=>{
  const {alert,directory}=await fixture(t);
  const value={state:'controller-attention',code:'deadline_exceeded',stage:'first-provider',detectedAt:1234,runId:'fixture-run',
    token:'PRIVATE-TOKEN',controllerLease:'PRIVATE-LEASE',source:{password:'PRIVATE-PASSWORD'},reason:'PRIVATE-REASON'};
  assert.deepEqual(alert.accept(value),{updated:true,preserved:true});
  const text=await readFile(alert.path,'utf8'),record=JSON.parse(text);
  assert.equal(record.active,true);assert.equal(record.firstDetectedAt,1234);assert.equal(record.code,'deadline_exceeded');
  assert(!text.includes('PRIVATE'));assert.equal(record.automaticActions,false);assert.equal(record.choiceAuthority,false);
  assert(Buffer.byteLength(text)<8192);assert.deepEqual(await readdir(directory),['attention-alert.json']);
});

test('manual command enrichment is exact, keeps the first detection, and never sends anything',async t=>{
  const {alert}=await fixture(t);alert.accept({state:'controller-attention',detectedAt:1234,code:'aborted'});
  const command=manual();alert.accept({state:'attention-required',detectedAt:1400,parentId:parent,manualContainment:command});
  command.command.args.room='modified';
  const value=JSON.parse(await readFile(alert.path,'utf8'));assert.equal(value.firstDetectedAt,1234);
  assert.deepEqual(value.manualContainment,manual());assert.equal(value.parentId,parent);
  assert.equal(value.automaticActions,false);
});

test('capabilities, private room suffixes and altered manual command contracts cannot enter the alarm',async t=>{
  for(const change of [m=>{m.command.args.controllerLease='PRIVATE';},m=>{m.command.args.room=parent+'-privatepw';},
    m=>{m.command.name='battle_start';},m=>{m.manualOnly=false;}]){
    const {alert}=await fixture(t),m=manual();change(m);
    alert.accept({state:'attention-required',manualContainment:m,parentId:parent+'-privatepw'});
    const text=await readFile(alert.path,'utf8'),value=JSON.parse(text);assert.equal(value.manualContainment,undefined);assert(!text.includes('privatepw'));assert(!text.includes('PRIVATE'));
  }
});

test('healthy progress writes no repeated alarm, and proven ownership loss retires its manual command',async t=>{
  const {alert}=await fixture(t);const initial=await readFile(alert.path,'utf8');
  assert.deepEqual(alert.accept({state:'watch-link',url:'PRIVATE'}),{updated:false});assert.equal(await readFile(alert.path,'utf8'),initial);
  alert.accept({state:'attention-required',manualContainment:manual()});
  alert.accept({state:'attention-ownership-lost',runId:'fixture-run',parentId:parent});
  const value=JSON.parse(await readFile(alert.path,'utf8'));assert.equal(value.active,false);assert.equal(value.status,'ownership-lost');assert.equal(value.manualContainment,undefined);
  assert.equal(value.authorityRetired,true);assert.equal(value.cleanupVerified,false);assert.equal(value.oldOwnerClosed,undefined);
});

test('failed alarm replacement retains the last successful evidence and reports failure explicitly',async t=>{
  const {alert}=await fixture(t);await rm(alert.path);await mkdir(alert.path);
  assert.deepEqual(alert.accept({state:'controller-attention',code:'aborted'}),{updated:true,preserved:false,code:'ATTENTION_ALERT_WRITE_FAILED'});
  assert.equal(alert.status().status,'monitoring');
});
