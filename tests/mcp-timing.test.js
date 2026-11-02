import assert from 'node:assert/strict';
import {after,before,test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {openingFixture} from '../simulation/fixtures.mjs';

const client=new Client({name:'offline-native-timing-tests',version:'1'},{capabilities:{}});
before(()=>client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/index.js',import.meta.url))],env:{VGC_TIMING_TEAM:''}})));
after(()=>client.close());
const speedInput={pokemon:[{species:'Farigiraf',nature:'Sassy',ability:'Armor Tail',statPoints:{hp:32,def:16,spd:18}}]};

test('actual calculator MCP metadata returns bounded correlated phases without changing public schemas',async()=>{
  const tools=(await client.listTools()).tools;
  assert.equal(tools.find(tool=>tool.name==='calculate_speed').inputSchema.properties.timing,undefined);
  for(const [name,args,required] of [
    ['calculate_speed',speedInput,['calculator.validation','calculator.reconstruction','calculator.engine','calculator.serialization']],
    ['calculate_damage',{gen:0,attacker:'Farigiraf',defender:'Rillaboom',move:'Psychic Noise',field:{gameType:'Doubles'}},['calculator.reconstruction','calculator.engine','calculator.serialization']],
    ['simulate_turn',{request:{kind:'explicit',...openingFixture()}},['simulation.worker_startup','simulation.worker_roundtrip','simulation.native_engine','simulation.serialization']],
  ]){
    const traceId=randomUUID(),requestKey='b'.repeat(64),roomId='battle-gen9championsvgc2026regmcbo3-123';
    const reply=await client.callTool({name,arguments:args,_meta:{'vgc/timing':{returnEvents:true,traceId,requestKey,roomId,rqid:7,turn:1,requestReceivedAt:Date.now(),cutoffAt:Date.now()+30000,token:'private-test-token',capabilities:{secret:'never-copy'}}}});
    assert.equal(reply.isError,undefined,JSON.stringify(reply));
    const events=reply._meta?.['vgc/timing-events'];assert.ok(Array.isArray(events));assert.ok(events.length>0&&events.length<=512);
    assert.ok(events.every(event=>event.traceId===traceId&&event.requestKey===requestKey&&event.roomId===roomId&&event.rqid===7));
    for(const phase of required)assert.ok(events.some(event=>event.name===phase&&event.event==='span.end'&&event.status==='ok'),phase);
    assert.ok(events.some(event=>event.name==='mcp.tool'&&event.event==='span.end'));
    assert.doesNotMatch(JSON.stringify(events),/private-test-token|never-copy|capabilities/);
  }
  const normal=await client.callTool({name:'calculate_speed',arguments:speedInput});
  assert.equal(normal._meta,undefined,'ordinary calculator output does not acquire trace metadata');
});

test('actual Speed validation failure reports an error with no native-engine span',async()=>{
  const reply=await client.callTool({name:'calculate_speed',arguments:{pokemon:[{...speedInput.pokemon[0],species:'UnknownSpecies'}]},_meta:{'vgc/timing':{returnEvents:true}}});
  assert.equal(reply.isError,true);
  const events=reply._meta['vgc/timing-events'];
  assert.ok(events.some(event=>event.name==='calculator.validation'&&event.event==='span.end'&&event.status==='error'));
  assert.equal(events.filter(event=>event.name==='calculator.engine').length,0);
  assert.equal(events.find(event=>event.name==='mcp.tool'&&event.event==='span.end').status,'error');
});
