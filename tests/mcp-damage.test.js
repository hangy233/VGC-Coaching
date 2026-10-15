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
