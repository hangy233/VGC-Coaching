import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Exercise the public MCP boundary, not a second local damage calculator.
// The override permits isolated verification without replacing a running server's build.
const client = new Client({ name: 'mcp-damage-tests', version: '1.0.0' }, { capabilities: {} });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [process.env.VGC_DAMAGE_TEST_SERVER || fileURLToPath(new URL('../dist/index.js', import.meta.url))],
  cwd: fileURLToPath(new URL('../', import.meta.url)),
});
before(async () => client.connect(transport));
after(async () => client.close());

const base = {
  attacker: 'Rillaboom', attackerOptions: { level: 50, ability: 'Overgrow' },
  defender: 'Mew', defenderOptions: { level: 50 },
  move: 'Wood Hammer', gen: 9,
};
function text(result) {
  return result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
}
async function damage(args) {
  const result = await client.callTool({ name: 'calculate_damage', arguments: args });
  assert.ok(!result.isError, text(result));
  const description = text(result);
  const match = description.match(/: (\d+)-(\d+) \(/);
  assert.ok(match, `Damage range present: ${description}`);
  return { range: match.slice(1).map(Number), description };
}

test('MCP advertises optional validated status codes for both combatants', async () => {
  const { tools } = await client.listTools();
  const schema = tools.find(tool => tool.name === 'calculate_damage').inputSchema;
  for (const side of ['attackerOptions', 'defenderOptions']) {
    const options = schema.properties[side];
    assert.deepEqual(options.properties.status.enum, ['', 'brn', 'par', 'psn', 'tox', 'slp', 'frz']);
    assert.ok(!options.required?.includes('status'));
  }
});

test('actual MCP damage publishes its native range as numeric structured content while preserving text',async()=>{
  const result=await client.callTool({name:'calculate_damage',arguments:base});
  assert.ok(!result.isError,text(result));
  assert.equal(result.structuredContent.description,text(result));
  assert.ok(Array.isArray(result.structuredContent.range));
  assert.equal(result.structuredContent.range.length,2);
  assert.ok(result.structuredContent.range.every(Number.isFinite));
  const shown=text(result).match(/: (\d+)-(\d+) \(/);
  assert.deepEqual(result.structuredContent.range,shown.slice(1).map(Number));
});

test('native Champions gen0 structured damage accepts explicit legal 66-point current-form snapshots',async()=>{
  const result=await client.callTool({name:'calculate_damage',arguments:{
    gen:0,attacker:'Golisopod-Mega',attackerOptions:{nature:'Brave',ability:'Tough Claws',item:'Golisopite',evs:{hp:32,atk:32,spd:2}},
    defender:'Archaludon',defenderOptions:{nature:'Timid',ability:'Stamina',item:'Choice Scarf',evs:{spa:32,spd:2,spe:32}},
    move:'Leech Life',field:{gameType:'Doubles',weather:'Rain'},
  }});
  assert.ok(!result.isError,text(result));
  assert.match(result.structuredContent.description,/Golisopod-Mega/);
  assert.equal(result.structuredContent.description,text(result));
  assert.ok(Array.isArray(result.structuredContent.range));
  assert.equal(result.structuredContent.range.length,2);
  assert.ok(result.structuredContent.range.every(Number.isFinite));
  assert.ok(result.structuredContent.range[0]<=result.structuredContent.range[1]);
});

test('burn reduces physical damage through MCP and is identified in the description', async () => {
  const healthy = await damage(base);
  const burned = await damage({ ...base, attackerOptions: { ...base.attackerOptions, status: 'brn' } });
  assert.deepEqual(burned.range, healthy.range.map(value => Math.floor(value / 2)));
  assert.match(burned.description, /burned/);
});

test('burn leaves ordinary special damage unchanged', async () => {
  const special = { ...base, move: 'Energy Ball' };
  const healthy = await damage(special);
  const burned = await damage({ ...special, attackerOptions: { ...base.attackerOptions, status: 'brn' } });
  assert.deepEqual(burned.range, healthy.range);
});

test('Guts overrides the burn penalty and boosts physical damage', async () => {
  const guts = { ...base, attacker: 'Machamp', move: 'Close Combat', attackerOptions: { level: 50, ability: 'Guts' } };
  const healthy = await damage(guts);
  const burned = await damage({ ...guts, attackerOptions: { ...guts.attackerOptions, status: 'brn' } });
  assert.ok(burned.range[0] > healthy.range[1]);
  assert.match(burned.description, /Guts/);
  assert.doesNotMatch(burned.description, /burned/);
});

test('Facade receives its status boost without a burn damage penalty', async () => {
  const facade = { ...base, move: 'Facade' };
  const healthy = await damage(facade);
  const burned = await damage({ ...facade, attackerOptions: { ...base.attackerOptions, status: 'brn' } });
  assert.ok(burned.range[0] > healthy.range[1]);
  assert.match(burned.description, /Facade \(140 BP\)/);
  assert.doesNotMatch(burned.description, /burned/);
});

test('defender status reaches the calculator (Hex doubles against a burned target)', async () => {
  const hex = { ...base, attacker: 'Gengar', move: 'Hex', attackerOptions: { level: 50 } };
  const healthy = await damage(hex);
  const burned = await damage({ ...hex, defenderOptions: { ...base.defenderOptions, status: 'brn' } });
  assert.ok(burned.range[0] > healthy.range[1]);
  assert.match(burned.description, /Hex \(130 BP\)/);
});

test('omitting options or status preserves the existing healthy behavior', async () => {
  const args = { attacker: 'Rillaboom', defender: 'Mew', move: 'Wood Hammer' };
  const omitted = await damage(args);
  const explicitHealthy = await damage({ ...args, attackerOptions: { status: '' }, defenderOptions: { status: '' } });
  assert.deepEqual(omitted, explicitHealthy);
  const oldOptions = await damage(base);
  const healthyOptions = await damage({ ...base, attackerOptions: { ...base.attackerOptions, status: '' }, defenderOptions: { ...base.defenderOptions, status: '' } });
  assert.deepEqual(oldOptions, healthyOptions);
});

test('invalid status values are rejected rather than silently ignored', async () => {
  for (const side of ['attackerOptions', 'defenderOptions']) {
    for (const status of ['burn', 'BRN', 'healthy', 'confusion', 1, null]) {
      const result = await client.callTool({ name: 'calculate_damage', arguments: { ...base, [side]: { ...base[side], status } } });
      assert.equal(result.isError, true, `${side} rejects ${JSON.stringify(status)}: ${text(result)}`);
      assert.match(text(result), /status/);
    }
  }
});

const champions = {
  gen:0,attacker:'Torkoal',attackerOptions:{nature:'Modest',ability:'Drought',item:'Charcoal',evs:{hp:32,spa:32,spd:2}},
  defender:'Blastoise',defenderOptions:{nature:'Serious',ability:'Torrent',item:'',evs:{hp:32,def:2,spd:32}},
  move:'Eruption',field:{gameType:'Doubles'},
};
async function nativeDamage(args) {
  const reply=await client.callTool({name:'calculate_damage',arguments:args});
  assert.ok(!reply.isError,text(reply));
  assert.equal(reply.structuredContent.gen,0);
  return reply.structuredContent;
}

test('native Champions current HP reaches HP-dependent moves and publishes actual engine HP',async()=>{
  const full=await nativeDamage(champions);
  const damaged=await nativeDamage({...champions,attackerOptions:{...champions.attackerOptions,curHP:40}});
  assert.equal(damaged.attackerHP.current,40);
  assert.equal(damaged.attackerHP.max,full.attackerHP.max);
  assert.equal(damaged.defenderHP.unit,'actual-hp');
  assert.ok(damaged.range[1]<full.range[0]);
  assert.equal(damaged.percent,null);
  assert.match(damaged.percentUnavailable,/numeric percentage/);
  assert.match(damaged.description,/Eruption/);
});

test('native Champions screens and partner Helping Hand/ Friend Guard modifiers reach the engine',async()=>{
  const plain=await nativeDamage({...champions,move:'Flamethrower'});
  const screen=await nativeDamage({...champions,move:'Flamethrower',field:{...champions.field,defenderSide:{isLightScreen:true}}});
  const veil=await nativeDamage({...champions,move:'Flamethrower',field:{...champions.field,defenderSide:{isAuroraVeil:true}}});
  const helped=await nativeDamage({...champions,move:'Flamethrower',field:{...champions.field,attackerSide:{isHelpingHand:true}}});
  const guarded=await nativeDamage({...champions,move:'Flamethrower',field:{...champions.field,defenderSide:{isFriendGuard:true}}});
  assert.ok(screen.range[1]<plain.range[1]);assert.deepEqual(veil.range,screen.range);
  assert.ok(helped.range[0]>plain.range[1]);assert.ok(guarded.range[1]<plain.range[1]);
  assert.match(screen.description,/Light Screen/);assert.match(helped.description,/Helping Hand/);assert.match(guarded.description,/Friend Guard/);
});

test('move state includes critical hits and native multi-hit selection without manual adjustment',async()=>{
  const plain=await nativeDamage({...champions,move:'Flamethrower'});
  const critical=await nativeDamage({...champions,move:'Flamethrower',moveOptions:{isCrit:true}});
  assert.ok(critical.range[0]>plain.range[1]);assert.match(critical.description,/critical hit/);
  const two=await nativeDamage({...champions,attacker:'Heracross',move:'Rock Blast',moveOptions:{hits:2}});
  const five=await nativeDamage({...champions,attacker:'Heracross',move:'Rock Blast',moveOptions:{hits:5}});
  assert.ok(five.range[0]>two.range[1]);
});

test('native Champions rejects invalid point budgets and impossible current HP',async()=>{
  for(const attackerOptions of [
    {...champions.attackerOptions,evs:{spa:33}},
    {...champions.attackerOptions,evs:{hp:32,spa:32,spe:3}},
    {...champions.attackerOptions,evs:{sp:32}},
    {...champions.attackerOptions,curHP:0},
    {...champions.attackerOptions,curHP:99999},
    {...champions.attackerOptions,teraType:'Fire'},
  ]) {
    const reply=await client.callTool({name:'calculate_damage',arguments:{...champions,attackerOptions}});
    assert.equal(reply.isError,true,text(reply));
  }
});

test('native Champions Move receives Skill Link ability rather than defaulting to a guessed multi-hit count',async()=>{
  const args={...champions,attacker:'Heracross-Mega',attackerOptions:{nature:'Adamant',ability:'Skill Link',item:'Heracronite',evs:{hp:32,atk:32,spd:2}},move:'Rock Blast'};
  const actual=await nativeDamage(args),five=await nativeDamage({...args,moveOptions:{hits:5}});
  assert.deepEqual(actual.range,five.range);
  assert.match(actual.description,/5 hits/);
});
