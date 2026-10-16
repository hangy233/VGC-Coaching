import test from 'node:test';
import assert from 'node:assert/strict';
import { previewTerminalProof } from './preview-terminal.mjs';

const game = () => ({teamId:'a'.repeat(64),roomId:'battle-gen9championsvgc2026regmcbo3-123',username:'Fixture',ownSide:'p1',players:{p1:'Fixture',p2:'Opponent'},completed:true,outcome:'loss',turns:0,leads:[],pokemon:[]});
const events = () => [
  {type:'gametype',data:['doubles']},{type:'tier',data:['[Gen 9 Champions] VGC 2026 Reg M-C (Bo3)']},
  {type:'player',data:['p1','Fixture']},{type:'player',data:['p2','Opponent']},{type:'teampreview',data:['4']},
  {type:'request',request:{teamPreview:true,side:{id:'p1',name:'Fixture',pokemon:Array.from({length:6},()=>({}))}}},
  {type:'win',data:['Opponent']},
];
test('private completed preview proof binds exact player pair, zero progress and official outcome',()=>{
  const proof=previewTerminalProof(events(),game());
  assert.equal(proof.kind,'preview-terminal');assert.equal(proof.outcome,'loss');assert.deepEqual(proof.players,{p1:'fixture',p2:'opponent'});
  assert(previewTerminalProof([...events(),{type:'player',data:['p2','']}],game()));
  const mutations=[
    e=>e.filter(v=>v.type!=='request'),e=>e.filter(v=>v.type!=='teampreview'),e=>e.filter(v=>v.type!=='tier'),
    e=>{e[1].data=['[Gen 9] OU'];return e;},e=>{e[3].data=['p2','Other'];return e;},e=>{e[6].data=['Fixture'];return e;},
    e=>[...e,{type:'win',data:['Opponent']}],e=>{e[5].request.active=[];return e;},
    e=>{e[5].request.forceSwitch=[false,false];return e;},e=>{e[5].request.teamPreview=false;return e;},
    e=>{e[5].request.side.pokemon.pop();return e;},e=>{e[6]={type:'tie',data:[]};return e;},
  ];
  for(const mutate of mutations)assert.equal(previewTerminalProof(mutate(events()),game()),null);
  for(const type of ['start','turn','switch','move','cant','faint','-damage','-weather']){
    const list=events();list.splice(6,0,{type,data:['1']});assert.equal(previewTerminalProof(list,game()),null,type);
  }
  for(const patch of [{turns:1},{completed:false},{outcome:'win'},{leads:['Golisopod']},{pokemon:[{lead:false,switchIns:1,moves:[]}]},{pokemon:[{moves:[{uses:1}]}]}])assert.equal(previewTerminalProof(events(),{...game(),...patch}),null);
});
