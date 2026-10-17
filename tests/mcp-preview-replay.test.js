import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {registerMetricsTools} from '../metrics/mcp-tools.mjs';
import {CAPTURE_ATTESTATION} from '../metrics/preview-terminal.mjs';

test('replay import wiring supplies only a fixed read-only owned-session status reader',async()=>{
  const handlers=new Map(),definitions=new Map(),calls=[],workspace='E:/isolated-fixture';
  registerMetricsTools({registerTool(name,definition,handler){handlers.set(name,handler);definitions.set(name,definition);}}, {
    workspace,
    call:async(descriptor,command)=>{calls.push({descriptor,command});return {ok:true,result:{sessionId:'fixture',rooms:[]}};},
    replayImporter:async args=>{assert.equal(typeof args.sessionReader,'function');return {snapshot:await args.sessionReader(),teamId:args.teamId};},
  });
  const args={urls:['https://replay.pokemonshowdown.com/gen9championsvgc2026regmcbo3-123'],username:'Fixture',teamId:'a'.repeat(64)};
  for(const extra of [{allowMissingStart:true},{previewObservation:{kind:'owned-parent-preview-terminal'}},{sessionReader:'caller-supplied'},{snapshotFile:'cache/status.json'}])assert.equal(definitions.get('team_metrics_import_replays').inputSchema.safeParse({...args,...extra}).success,false);
  const reply=await handlers.get('team_metrics_import_replays')(args);
  assert.notEqual(reply.isError,true);assert.equal(calls.length,1);assert.equal(calls[0].descriptor,join(workspace,'cache','showdown-session.json'));
  assert.equal(calls[0].command.op,'status');assert.match(calls[0].command.id,/^[a-f0-9-]{36}$/u);assert.deepEqual(Object.keys(calls[0].command).sort(),['id','op']);
});

test('historical recovery has an explicit strict attestation schema and never wires a live session reader',async()=>{
  const handlers=new Map(),definitions=new Map(),calls=[],workspace='E:/isolated-fixture';
  registerMetricsTools({registerTool(name,definition,handler){handlers.set(name,handler);definitions.set(name,definition);}}, {
    workspace,call:async()=>{throw new Error('Historical adoption must not contact the battle client.');},
    previewRecoverer:async args=>{calls.push(args);assert.equal(args.sessionReader,undefined);return {complete:true,source:'historical_mcp_battle_status'};},
  });
  const args={teamId:'a'.repeat(64),roomId:'battle-gen9championsvgc2026regmcbo3-123',statusFile:'cache/captured-status.json',statusSha256:'b'.repeat(64),url:'https://replay.pokemonshowdown.com/gen9championsvgc2026regmcbo3-123',confirmed:true,captureAttestation:{statement:CAPTURE_ATTESTATION,operator:'Fixture operator',capturedAt:'2026-01-01T00:00:00.000Z',provenance:'Synthetic observed MCP status capture in test command.',reason:'The ended room expired; retain an explicitly historical observation.'}};
  const definition=definitions.get('team_metrics_recover_preview'),schema=definition.inputSchema;
  assert.equal(schema.safeParse(args).success,true);assert.equal(definition.annotations.readOnlyHint,false);assert.equal(definition.annotations.openWorldHint,true);
  for(const patch of [{confirmed:false},{captureAttestation:undefined},{previewProof:true},{previewObservation:{}},{sessionReader:'injected'},{allowMissingStart:true}])assert.equal(schema.safeParse({...args,...patch}).success,false);
  assert.equal(schema.safeParse({...args,captureAttestation:{...args.captureAttestation,independentlyVerified:true}}).success,false);
  const reply=await handlers.get('team_metrics_recover_preview')(args);assert.notEqual(reply.isError,true);assert.equal(calls.length,1);assert.deepEqual(calls[0],{workspace,...args});
});
