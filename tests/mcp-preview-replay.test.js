import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {registerMetricsTools} from '../metrics/mcp-tools.mjs';

test('replay import wiring supplies only a fixed read-only owned-session status reader',async()=>{
  const handlers=new Map(),definitions=new Map(),calls=[],workspace='E:/isolated-fixture';
  registerMetricsTools({registerTool(name,definition,handler){handlers.set(name,handler);definitions.set(name,definition);}}, {
    workspace,
    call:async(descriptor,command)=>{calls.push({descriptor,command});return {ok:true,result:{sessionId:'fixture',rooms:[]}};},
    replayImporter:async args=>{assert.equal(typeof args.sessionReader,'function');return {snapshot:await args.sessionReader(),teamId:args.teamId};},
  });
  const args={urls:['https://replay.pokemonshowdown.com/gen9championsvgc2026regmcbo3-123'],username:'Fixture',teamId:'a'.repeat(64)};
  assert.equal(definitions.get('team_metrics_import_replays').inputSchema.safeParse({...args,allowMissingStart:true}).success,false);
  const reply=await handlers.get('team_metrics_import_replays')(args);
  assert.notEqual(reply.isError,true);assert.equal(calls.length,1);assert.equal(calls[0].descriptor,join(workspace,'cache','showdown-session.json'));
  assert.equal(calls[0].command.op,'status');assert.match(calls[0].command.id,/^[a-f0-9-]{36}$/u);assert.deepEqual(Object.keys(calls[0].command).sort(),['id','op']);
});
