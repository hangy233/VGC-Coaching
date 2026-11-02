import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// A real JSONL pipe rehearsal, with no credentials, SDK, server or model call.
// It measures delivery/control plumbing; the parent is a scripted fixture, not
// a timed tactical operator. Controller tests separately exercise API routing.
test('fresh two-active recovery context and first complete input share one uninterrupted stream', async t => {
  const source = `
    import {serveAttentionMode} from './isolated/runner.mjs';
    import {validateChoice} from './showdown/choice-validation.mjs';
    const team='a'.repeat(64), token='b'.repeat(64), room='battle-gen9championsvgc2026regmcbo3-812', parent='game-bestof3-gen9championsvgc2026regmcbo3-811';
    const identity={sessionId:'synthetic-stream-session',teamId:team,account:'Synthetic'};
    const receivedAt=Date.now(), cutoffAt=receivedAt+45000;
    const legal={active:[{moves:[{move:'Tackle',target:'normal',pp:20},{move:'Protect',target:'self',pp:8}]},{moves:[{move:'Thunderbolt',target:'normal',pp:15},{move:'Protect',target:'self',pp:8}]}],
      pokemon:[{ident:'p1: One',details:'Corviknight, L50',condition:'150/150',active:true},{ident:'p1: Two',details:'Rotom-Wash, L50',condition:'150/150',active:true}]};
    const calls=[];
    const operator={async dispatch(q){calls.push(q.op);
      if(q.op==='turn')return {result:{ok:true,result:{sessionId:identity.sessionId,teamId:team,connected:true,authenticated:true,stopped:false,observedAt:Date.now(),autoReady:false,
        actions:[{kind:'turn',room,parentId:parent,rqid:8,revision:11,token,receivedAt,actionable:true,legalActions:legal}],
        rooms:[{id:room,parentId:parent,ended:false},{id:parent,ended:false}],
        controlPolicy:{enabled:true,halted:false,pending:[{room,rqid:8,token,receivedAt,cutoffAt,hasFallback:false,attempted:false}]},
        boards:[{room,parentId:parent,turn:4,request:{rqid:8},ownSide:'p1',sides:[],field:{},opponentSheets:{p2:[]}}]}}};
      if(q.op==='play-next'){
        if(q.room!==room||q.token!==token||q.rqid!==8)throw Error('stale fixture command');
        const result=validateChoice({rqid:8,active:legal.active,side:{pokemon:legal.pokemon}},q.actions);
        return {result:{ok:true,result:{fixtureLegal:true,actions:result.actions,calls,receivedAt:Date.now(),cutoffAt,serverUsed:false}}};
      }
      throw Error('unexpected fixture operation');
    }};
    await serveAttentionMode({operator,identity,scope:{controlPolicy:{}},runId:'offline-stream',failure:{code:'operator',message:'synthetic only',affectedParentId:parent},
      write:value=>process.stdout.write(JSON.stringify(value)+'\\n')});
  `;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^OPENAI_/u.test(key)));
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => {if (child.exitCode === null) child.kill();});
  const frames = []; let buffer = '', stderr = '', deliveredAt, inputSentAt;
  child.stderr.on('data', chunk => {stderr += chunk;});
  const done = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {child.kill(); reject(new Error('Offline recovery pipe did not finish'));}, 10000);
    child.once('error', error => {clearTimeout(timeout); reject(error);});
    child.once('close', code => {clearTimeout(timeout); code === 0 ? resolve() : reject(new Error('Offline child failed: ' + stderr.slice(0, 1000)));});
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      try {
        while (buffer.includes('\n')) {
          const end = buffer.indexOf('\n'), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (!line) continue;
          const frame = JSON.parse(line); frames.push(frame);
          if (frame.state !== 'recovery-context') continue;
          assert.equal(frame.disposition, 'actionable'); deliveredAt = Date.now();
          const current = frame.response.result.result.actions[0];
          assert.equal(current.legalActions.active.length, 2);
          assert(current.legalActions.active.every(slot => slot.moves.length >= 2));
          inputSentAt = Date.now();
          child.stdin.end(JSON.stringify({id: 'first-complete-pair', op: 'play-next', room: current.room, rqid: current.rqid, token: current.token,
            actions: [{type: 'move', slot: 2}, {type: 'move', slot: 1, target: 2}]}) + '\n');
        }
      } catch (error) {child.kill(); clearTimeout(timeout); reject(error);}
    });
  });
  await done;
  assert.deepEqual(frames.slice(0, 2).map(frame => frame.state), ['attention-required', 'recovery-context']);
  const packet = frames.find(frame => frame.state === 'recovery-context');
  const result = frames.find(frame => frame.state === 'manual-result');
  const receipt = result.response.result.result;
  assert.equal(receipt.fixtureLegal, true); assert.equal(receipt.actions.length, 2);
  assert.deepEqual(receipt.calls, ['turn', 'play-next']);
  assert.equal(receipt.serverUsed, false); assert(receipt.receivedAt < receipt.cutoffAt);
  assert(!JSON.stringify(frames).includes('synthetic-stream-session'));
  t.diagnostic(JSON.stringify({kind: 'offline-scripted-pipe-only', contextCaptureMs: packet.handoffDelayMs,
    emitToDeliveryMs: deliveredAt - packet.checkedAt, scriptedInputMs: inputSentAt - deliveredAt,
    inputToChildMs: result.inputReceivedAt - inputSentAt,
    limitation: 'No model generation, chat tactical judgment, actual MCP or server acceptance measured.'}));
});
