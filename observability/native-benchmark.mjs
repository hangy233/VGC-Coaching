import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createTimingRecorder, timingSpan, timingImport, currentTimingContext} from './timing.mjs';
import {analyzeEvents, summarize} from './analyze.mjs';
import {openingFixture} from '../simulation/fixtures.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
function requests() {
  const invalid = openingFixture();
  return [
    {id: 'damage', name: 'calculate_damage', arguments: {gen: 0, attacker: 'Golisopod-Mega',
      attackerOptions: {nature: 'Brave', ability: 'Tough Claws', item: 'Golisopite', evs: {hp: 32, atk: 32, spd: 2}},
      defender: 'Archaludon', defenderOptions: {nature: 'Timid', ability: 'Stamina', item: 'Choice Scarf', evs: {spa: 32, spd: 2, spe: 32}},
      move: 'Leech Life', field: {gameType: 'Doubles', weather: 'Rain'}}},
    {id: 'speed', name: 'calculate_speed', arguments: {gen: 0, pokemon: [
      {label: 'Fixture A', species: 'Kommo-o', nature: 'Modest', ability: 'Soundproof', statPoints: {hp: 32, def: 12, spa: 22}},
      {label: 'Fixture B', species: 'Garchomp', nature: 'Jolly', ability: 'Rough Skin', statPoints: {hp: 2, atk: 32, spe: 32}},
    ]}},
    {id: 'simulation', name: 'simulate_turn', arguments: {request: {kind: 'explicit', ...openingFixture()}}},
    {id: 'simulation-refusal', name: 'simulate_turn', arguments: {request: {kind: 'explicit', ...invalid},
      evidenceContext: {teamId: 'a'.repeat(64), roomId: 'battle-gen9championsvgc2026regmcbo3-123', turn: 2}}, expectedRefusal: true},
  ];
}

/** The actual maintained stdio MCP server, fixed synthetic inputs and no model.
 * Only the three numerical tools are called. No session descriptor, login,
 * source battle, roster change, report import or live request is accessed.
 */
export async function runNativeBenchmark({repeats = 3, client, transport} = {}) {
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 20) throw new TypeError('repeats must be 1..20');
  const cases = requests();
  const recorder = createTimingRecorder({component: 'native-benchmark'}), samples = [];
  let sdk = client;
  if (!sdk) {
    sdk = new Client({name: 'vgc-offline-native-timing', version: '1'}, {capabilities: {}});
    transport = new StdioClientTransport({command: process.execPath,
      args: [resolve(ROOT, 'dist/index.js')], cwd: ROOT, stderr: 'pipe',
      // This benchmark exports per-call in-memory spans. It never appends
      // synthetic measurements into a real team's report via inherited config.
      env: {VGC_TIMING_TEAM: ''}});
    transport.stderr?.resume();
  }
  let startupMs, halted = false;
  try {
    await recorder.run({operation: 'native-benchmark'}, async () => {
      const startup = timingSpan('benchmark.server_start');
      await startup.run(async () => { if (transport) await sdk.connect(transport); });
      startupMs = recorder.snapshot().find(event => event.name === 'benchmark.server_start' && event.event === 'span.end')?.durationMs;
      for (let repeat = 0; repeat < repeats; repeat++) {
        for (const request of cases) {
          await recorder.run({commandId: `${request.id}-${repeat}`, operation: 'native-benchmark'}, async () => {
            const call = timingSpan('operator.mcp_call', {tool: request.name});
            let reply, callFailed = false;
            await call.run(async () => {
              reply = await sdk.callTool({name: request.name, arguments: request.arguments,
                _meta: {'vgc/timing': {...currentTimingContext(), returnEvents: true}}}, undefined, {timeout: 15000});
              timingImport(reply._meta?.['vgc/timing-events']);
              if (reply.isError) call.end('refused');
            }).catch(() => { callFailed = true; });
            const event = recorder.snapshot().findLast(item => item.name === 'operator.mcp_call' && item.event === 'span.end');
            samples.push({request: request.id, tool: request.name, repeat, firstCallInProcess: repeat === 0,
              outcome: callFailed ? 'error' : reply.isError ? 'refused' : 'completed', expectedOutcome: request.expectedRefusal ? 'refused' : 'completed',
              elapsedMs: event.durationMs});
            if (callFailed) halted = true;
          });
          if (halted) return;
        }
      }
    });
  } finally { await sdk.close(); }
  const events = recorder.snapshot();
  const outcomeMismatches = samples.filter(sample => sample.outcome !== sample.expectedOutcome).map(sample => ({request: sample.request, repeat: sample.repeat, outcome: sample.outcome, expectedOutcome: sample.expectedOutcome}));
  return {schemaVersion: 1, kind: 'offline-native-mcp-benchmark', modelUsed: false, battlesStarted: 0,
    valid: !halted && outcomeMismatches.length === 0 && samples.length === cases.length * repeats,
    halted, outcomeMismatches, plannedCalls: cases.length * repeats, repeats, startupMs, samples,
    byRequest: Object.fromEntries(cases.map(request => [request.id, {
      firstCall: samples.find(sample => sample.request === request.id),
      subsequentCalls: summarize(samples.filter(sample => sample.request === request.id && sample.repeat > 0).map(sample => sample.elapsedMs)),
    }])), analysis: analyzeEvents(events), events,
    limitations: ['Fixed synthetic positions and seeds exercise real maintained MCP calculators/simulator; these are local performance samples, not battle or model results.',
      'Every simulator call constructs a new worker. Later calls warm the server process, not a persistent simulation worker.',
      'Small-sample p95 values are descriptive. Server startup/handshake is separate from per-call round trips.',
      'No durable calculation receipts are requested; evidence-lock/write overhead is measured separately by storage tests and traced when real calls request evidence.']};
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--repeats' || !/^\d+$/.test(args[1]))) {
    process.stderr.write('Usage: node observability/native-benchmark.mjs [--repeats 1..20]\n'); process.exitCode = 2;
  } else {
    runNativeBenchmark({repeats: args.length ? Number(args[1]) : 3}).then(result => {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      if (!result.valid) process.exitCode = 1;
    }).catch(() => { process.stderr.write('Offline native benchmark failed; build the maintained server and inspect its offline tests.\n'); process.exitCode = 1; });
  }
}
