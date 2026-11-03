import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {QUALIFICATION_RESEARCH_ENV, QUALIFICATION_SETUP_TOOL} from '../observability/qualification-research.mjs';
import {digest} from '../planning/identity.mjs';

// A fresh, offline numerical MCP child with synthetic test-only source bindings.
// This never reads a live descriptor, calls a model, creates a battle, or claims
// that these fixture bindings qualify a selected provider for production.
const client = new Client({name: 'offline-last-respects-regression', version: '1'}, {capabilities: {}});
const transport = new StdioClientTransport({command: process.execPath,
  args: [process.env.VGC_DAMAGE_TEST_SERVER || fileURLToPath(new URL('../dist/index.js', import.meta.url))],
  cwd: fileURLToPath(new URL('../', import.meta.url)),
  env: {...process.env, [QUALIFICATION_RESEARCH_ENV]: '1'},
});
before(async () => client.connect(transport));
after(async () => client.close());
let rqid = 0;
const text = reply => reply.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
async function fixtureContext() {
  const source = {sessionId: 'offline-last-respects-test-only', teamId: 'a'.repeat(64),
    room: 'battle-gen9championsvgc2026regmcbo3-9981', rqid: ++rqid, token: digest({fixture: 'last-respects', rqid})};
  const researchContext = {source, analysis: 'current'};
  const registered = await client.callTool({name: QUALIFICATION_SETUP_TOOL, arguments: {
    caseId: randomUUID(), contexts: [researchContext], turn: 11, kind: 'turn',
    sourceSha256: digest({testOnlySource: source}), factsSha256: digest({testOnlyFacts: rqid}), deadlineAt: Date.now() + 30000,
  }});
  assert.ok(!registered.isError, text(registered));
  return researchContext;
}
// Entirely synthetic numerical snapshot: not a retained team, played board,
// actual selected opponent, or production qualification source.
const syntheticInputs = {
  gen: 0, attacker: 'Basculegion',
  attackerOptions: {nature: 'Jolly', ability: 'Mold Breaker', item: 'Mystic Water', evs: {hp: 16, atk: 24, spe: 26}, alliesFainted: 3},
  defender: 'Slowbro',
  defenderOptions: {nature: 'Bold', ability: 'Own Tempo', item: 'Sitrus Berry', evs: {hp: 20, def: 26, spd: 20}, boosts: {def: 1}, curHP: 135},
  move: 'Last Respects', field: {gameType: 'Doubles'},
};
async function damage(arguments_, researchContext) {
  const reply = await client.callTool({name: 'calculate_damage', arguments: {...arguments_, researchContext}});
  assert.ok(!reply.isError, text(reply));
  assert.equal(reply.structuredContent.gen, 0);
  assert.equal(reply.researchBudget.status, 'completed');
  assert.equal(reply.researchBudget.choiceAuthority, false);
  const {researchBudget, ...nativeReply} = reply;
  assert.equal(researchBudget.resultSha256, digest(nativeReply));
  return reply.structuredContent;
}

test('actual MCP applies three-faint Last Respects in a synthetic material countercase with a source-labeled native result', async t => {
  const researchContext = await fixtureContext();
  const result = await damage(syntheticInputs, researchContext);
  const zero = await damage({...syntheticInputs, attackerOptions: {...syntheticInputs.attackerOptions, alliesFainted: 0}}, researchContext);
  assert.equal(result.contractVersion, 'champions-damage-v2');
  assert.equal(result.moveStateProjection.basePower, 200);
  assert.equal(result.moveStateProjection.alliesFainted, 3);
  assert.equal(result.moveStateProjection.source.callback, 'lastrespects.basePowerCallback');
  assert.equal(result.defenderHP.current, 135);
  assert.equal(result.defenderHP.max, 190);
  assert.deepEqual(result.range, [138, 164]);
  assert.ok(result.range[0] > zero.range[1], JSON.stringify({zero: zero.range, three: result.range}));
  assert.ok(result.range[0] >= result.defenderHP.current, JSON.stringify(result));
  assert.match(result.description, /guaranteed OHKO/);
  t.diagnostic(JSON.stringify({fixture: 'synthetic', zeroFaintRange: zero.range, threeFaintRange: result.range}));
});

test('actual MCP preserves the explicit zero-faint native normal case and does not infer it from omission', async () => {
  const researchContext = await fixtureContext();
  const result = await damage({...syntheticInputs, attackerOptions: {...syntheticInputs.attackerOptions, alliesFainted: 0}}, researchContext);
  assert.deepEqual(result.range, [36, 44]);
  assert.equal(result.moveStateProjection.basePower, 50);
  const {alliesFainted, ...missing} = syntheticInputs.attackerOptions;
  const refused = await client.callTool({name: 'calculate_damage', arguments: {...syntheticInputs, attackerOptions: missing, researchContext}});
  assert.equal(refused.isError, true);
  assert.match(text(refused), /requires explicit attackerOptions.alliesFainted/);
  assert.equal(refused.structuredContent, undefined);
});

test('actual MCP refuses unsupported faint state and arbitrary model power overrides', async () => {
  const researchContext = await fixtureContext();
  for (const alliesFainted of [6, null]) {
    const reply = await client.callTool({name: 'calculate_damage', arguments: {...syntheticInputs,
      attackerOptions: {...syntheticInputs.attackerOptions, alliesFainted}, researchContext}});
    assert.equal(reply.isError, true);
    assert.match(text(reply), /alliesFainted/);
  }
  const overridden = await client.callTool({name: 'calculate_damage', arguments: {...syntheticInputs,
    moveOptions: {overrides: {basePower: 999}}, researchContext}});
  assert.equal(overridden.isError, true);
  assert.match(text(overridden), /Unrecognized key|unrecognized_keys/);
});

test('actual MCP leaves ordinary moves and native Supreme Overlord faint scaling intact', async () => {
  const ordinaryContext = await fixtureContext();
  const ordinary = {...syntheticInputs, move: 'Shadow Ball'};
  const zero = await damage({...ordinary, attackerOptions: {...ordinary.attackerOptions, alliesFainted: 0}}, ordinaryContext);
  const three = await damage(ordinary, ordinaryContext);
  assert.deepEqual(three.range, zero.range);
  assert.equal(three.moveStateProjection, undefined);
  const supremeContext = await fixtureContext();
  const supreme = {...syntheticInputs, attacker: 'Kingambit', move: 'Kowtow Cleave',
    attackerOptions: {...syntheticInputs.attackerOptions, ability: 'Supreme Overlord'}};
  const noAllies = await damage({...supreme, attackerOptions: {...supreme.attackerOptions, alliesFainted: 0}}, supremeContext);
  const allies = await damage(supreme, supremeContext);
  assert.ok(allies.range[0] > noAllies.range[1]);
  assert.match(allies.description, /Supreme Overlord/);
  assert.equal(allies.moveStateProjection, undefined);
});
