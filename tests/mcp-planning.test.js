import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {planningFixture} from '../planning/fixtures.mjs';
import {openingFixture} from '../simulation/fixtures.mjs';
import {boardDigest} from '../planning/identity.mjs';
const {Teams} = createRequire(import.meta.url)('pokemon-showdown');
const client = new Client({name:'offline-public-planning-tests',version:'1'},{capabilities:{}});
before(async() => client.connect(new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/index.js',import.meta.url))],cwd:fileURLToPath(new URL('../',import.meta.url))})));
after(async() => client.close());
const decode = reply => reply.structuredContent ?? JSON.parse(reply.content.find(item => item.type === 'text').text);
const text = reply => reply.content?.filter(item => item.type === 'text').map(item => item.text).join('\n');
const call = async(name,args) => {const reply = await client.callTool({name,arguments:args});assert.ok(!reply.isError,text(reply));return decode(reply);};
function fixture() {
  const data = planningFixture();data.ownTeam[2].item = 'Miracle Seed';data.ownTeam[3].item = 'Grassy Seed';data.opponentSheet[2].item = 'Grassy Seed';
  return {data,input:{request:{kind:'explicit',label:'Native public MCP fixture; no live battle',board:data.board,legalActions:data.legalActions,ownTeam:Teams.export(data.ownTeam),opponentSheet:data.opponentSheet},maxCalls:0,budgetMs:5000,view:'full'}};
}

test('public MCP advertises bounded planning and read-only delivery without granting battle control',async() => {
  const tools = (await client.listTools()).tools;
  const brief = tools.find(tool => tool.name === 'battle_turn_brief'), check = tools.find(tool => tool.name === 'battle_check_plan');
  assert(brief);assert(check);assert.equal(brief.inputSchema.additionalProperties,false);assert.equal(check.inputSchema.additionalProperties,false);
  assert.equal(brief.inputSchema.properties.maxCalls.minimum,0);assert.equal(check.annotations.readOnlyHint,true);
  assert.match(brief.description,/No authentication, control, staging, submission or search\./u);assert.match(check.description,/actual registered native simulate_turn/);
});

test('actual MCP qualitative brief preserves unknown stats, exact board hash and validated complete advisory pairs',async() => {
  const {data,input} = fixture(), result = await call('battle_turn_brief',input);
  assert.equal(result.kind,'champions-turn-brief');assert.equal(result.status,'advisory');assert.equal(result.source.liveFreshness,false);
  assert.equal(result.source.boardHash,boardDigest(data.board,data.legalActions));assert.equal(result.coverage.numerics.attemptedCalls,0);
  const foe = result.actors.find(actor => actor.id === 'p2-chomp');assert.equal(foe.nature,null);assert.equal(foe.statPoints,null);
  assert.equal(result.actors.find(actor => actor.species === 'Farigiraf').selected,'unknown');
  assert(result.candidates.length > 0);assert(result.candidates.every(candidate => candidate.actions.length === 2 && candidate.heuristic));
  assert(result.numericChecks.damage.every(row => row.status !== 'complete'));
  const invalid = structuredClone(input);invalid.request.ownTeam = invalid.request.ownTeam.replace('Miracle Seed','Assault Vest');
  const refused = await client.callTool({name:'battle_turn_brief',arguments:invalid});assert.equal(refused.isError,true);assert.match(text(refused),/native validation/);
});

test('actual MCP planning registration reuses a native calculation across briefs without another numerical call',async()=>{
  const {input,data}=fixture();data.ownTeam[0].nature='Relaxed';input.request.ownTeam=Teams.export(data.ownTeam);input.maxCalls=1;
  const first=await call('battle_turn_brief',input),second=await call('battle_turn_brief',input);
  assert.equal(first.coverage.numerics.attemptedCalls,1);assert.equal(second.coverage.numerics.attemptedCalls,0);assert.equal(second.coverage.numerics.cachedCalls,1);
  assert.equal(second.numericChecks.checks[0].receipt.reused,true);assert.deepEqual(second.order[0].pokemon,first.order[0].pokemon);assert.equal(second.source.boardHash,first.source.boardHash);
});

test('labeled opposing scenarios use actual registered native Speed and damage handlers',async() => {
  const {data,input} = fixture();
  // Obtain native exact own HP through the public Speed tool; do not substitute
  // handwritten stats or a second local calculator for the numerical fixture.
  const stats = await call('calculate_speed',{gen:0,pokemon:data.ownTeam.slice(0,3).map((set,index) => ({label:data.board.sides[0].pokemon[index].id,species:set.species,nature:set.nature,ability:set.ability,item:set.item,statPoints:set.evs}))});
  for (const entry of stats.pokemon) {
    const index = data.board.sides[0].pokemon.findIndex(actor => actor.id === entry.label);
    data.board.sides[0].pokemon[index].hp = {current:entry.rawStats.hp,max:entry.rawStats.hp,precision:'server-own-exact'};
    data.legalActions.pokemon[index].condition = `${entry.rawStats.hp}/${entry.rawStats.hp}`;
  }
  const points = {hp:0,atk:0,def:0,spa:0,spd:0,spe:0};
  input.maxCalls = 10;input.hypotheses = [{id:'named-opposing-spreads',label:'Explicit candidate spreads, not revealed facts',pokemon:{
    'p2-chomp':{nature:'Jolly',statPoints:{...points,hp:2,atk:32,spe:32}},
    'p2-wash':{nature:'Modest',statPoints:{...points,hp:32,spa:32,spd:2}},
  }}];
  const result = await call('battle_turn_brief',input);
  assert(result.coverage.numerics.completedCalls > 0);
  assert(result.numericChecks.checks.some(check => check.tool === 'calculate_speed' && check.status === 'complete'));
  assert(result.numericChecks.checks.some(check => check.tool === 'calculate_damage' && check.status === 'complete'));
  const completed = result.numericChecks.damage.filter(row => row.status === 'complete');assert(completed.length > 0);
  assert(completed.every(row => row.scenarioId === 'named-opposing-spreads' && row.range.length === 2));
  assert(completed.every(row => row.assumptions.some(value => value.includes('neither revealed facts nor universal bounds'))));
  assert.equal(result.actors.find(actor => actor.id === 'p2-chomp').statPoints,null,'Scenario assumptions must not overwrite observed knowledge');
  assert(result.order.some(order => order.scenarioId === 'named-opposing-spreads' && order.status === 'complete'));
});

test('public plan check uses actual native paired simulation and preserves failure versus checked switch delivery',async() => {
  const f = openingFixture();f.position.sides[0].pokemon[1].ability = 'Sap Sipper';f.position.sides[1].pokemon[1].moves[3] = 'Protect';
  Object.assign(f.branches[0],{ourActions:[{type:'move',slot:1,target:1},{type:'move',slot:4}],opposingActions:[{type:'move',slot:3,target:1},{type:'move',slot:4}]});
  const candidates = [{id:'exposed-attack',ourActions:f.branches[0].ourActions},{id:'switch-required-actor',ourActions:[{type:'switch',pokemonId:'toed'},{type:'move',slot:4}]}];
  const result = await call('battle_check_plan',{request:{kind:'explicit',...f},candidates,objective:{requiredActionsBy:['arch']},budgetMs:3500});
  assert.deepEqual(result.checkedCandidates.map(candidate => candidate.status),['sampled-failure','sampled-pass']);
  assert.equal(result.coverage.checkedCandidates,2);assert.equal(result.selectedCandidate,undefined);
  assert(result.uncoveredRequiredActors.some(warning => warning.actorId === 'arch'));
  assert.deepEqual(result.seeds,f.seeds);assert.deepEqual(result.hypotheses,f.hypotheses);
  const invalid = await client.callTool({name:'battle_check_plan',arguments:{request:{kind:'explicit',...f},candidates:[{id:'half-pair',ourActions:[{type:'move',slot:1,target:1}]}]}});
  assert.equal(invalid.isError,true);
});
