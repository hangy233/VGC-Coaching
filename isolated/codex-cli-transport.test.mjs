import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdir, mkdtemp, readdir, rm, writeFile} from 'node:fs/promises';
import {basename, dirname, join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {createCodexCliPreflight, codexCliEnvironment, discoverCodexCliExecutable, CODEX_PROMPT_SOURCE_DELIMITER} from './codex-cli-transport.mjs';

const workspace = resolve('.');
const schema = {type:'object',properties:{choice:{type:'string',enum:['protect','attack']}},required:['choice'],additionalProperties:false};
const selected = {choice:'protect'};
const asLine = value => `${JSON.stringify(value)}\n`;

async function fixture(t, {auth = 'Logged in using ChatGPT', generation, now = Date.now, termination = true, serviceTier} = {}) {
  await mkdir(join(workspace,'cache'),{recursive:true});
  const directory = await mkdtemp(join(workspace,'cache','codex-cli-test-'));
  const executable = join(directory,'fixture-codex.exe');await writeFile(executable,'synthetic fixture; never executed');
  const calls = [], children = []; let killed = 0;
  t.after(async () => {
    await rm(directory,{recursive:true,force:true});
    // All children in this fixture are synthetic. Clean its deliberately
    // retained empty cwd only after the uncertain-termination assertion.
    for (const cwd of new Set(calls.map(call=>call.options.cwd))) {
      if (resolve(dirname(cwd)).toLowerCase()===resolve(tmpdir()).toLowerCase()&&basename(cwd).startsWith('vgc-codex-cwd-')) await rm(cwd,{recursive:true,force:true});
    }
  });
  const spawn = (executable,args,options) => {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
    child.exitCode = null; child.signalCode = null; child.pid = 100 + calls.length;
    const call = {executable,args,options,stdin:''}; calls.push(call); children.push(child);
    child.close = code => {child.exitCode = code; child.emit('close',code);};
    child.stdin.on('data',chunk => {call.stdin += chunk.toString();});
    child.stdin.on('finish', () => {
      queueMicrotask(async () => {
        try {
          if (args.includes('--version')) {child.stdout.write('codex-cli 0.146.0\n'); child.close(0);}
          else if (args.includes('status')) {child.stderr.write(auth); child.close(0);}
          else if (generation) await generation({call,child});
          else throw Error('Preflight fixture cannot generate');
        } catch (error) {child.emit('error',error);}
      });
    });
    return child;
  };
  const transport = createCodexCliPreflight({workspace,artifactDirectory:join(directory,'artifacts'),
    executable, model:'gpt-6-luna',reasoningEffort:'low',spawn,now,...(serviceTier===undefined?{}:{serviceTier}),
    environment:{Path:'fixture-path',SystemRoot:'C:\\Windows',CODEX_HOME:'opaque-cached-login',OPENAI_API_KEY:'SECRET_API',
      CODEX_API_KEY:'SECRET_CODEX',OPENAI_BASE_URL:'SECRET_PROVIDER',GH_TOKEN:'SECRET_GH',CODEX_THREAD_ID:'SECRET_THREAD'},
    terminateProcess:async child => {killed++; if (termination) child.close(1); return termination;}});
  return {transport,calls,children,directory,killed:()=>killed,
    request:overrides => ({instructions:'Use the complete supplied source and output one legal action.',input:JSON.stringify({board:'unchanged',legal:['protect','attack']}),schema,deadlineAt:now()+1000,...overrides})};
}
test('whitelist removes all provider keys, overrides and parent-agent metadata',()=>{
  assert.deepEqual(codexCliEnvironment({PATH:'path',CODEX_HOME:'cache',OPENAI_API_KEY:'secret',CODEX_API_KEY:'secret',
    OPENAI_BASE_URL:'remote',HTTPS_PROXY:'secret',GH_TOKEN:'secret',CODEX_THREAD_ID:'thread'}),{PATH:'path',CODEX_HOME:'cache'});
});
test('owned current CLI installation is preferred using its platform distribution layout',async t=>{
  const f=await fixture(t),fakeWorkspace=join(f.directory,'installation-fixture');
  const expected=join(fakeWorkspace,'cache','tooling','codex-cli','node_modules','@openai','codex-win32-x64','vendor','x86_64-pc-windows-msvc','bin','codex.exe');
  await mkdir(dirname(expected),{recursive:true});await writeFile(expected,'fixture only');
  assert.equal(discoverCodexCliExecutable(fakeWorkspace,{platform:'win32',architecture:'x64'}),expected);
  assert.equal(discoverCodexCliExecutable(fakeWorkspace,{platform:'linux',architecture:'x64'}),undefined);
});
test('preflight checks existing official version and opaque ChatGPT login without model generation',async t=>{const f=await fixture(t);const result=await f.transport.preflight();assert.equal(result.authMode,'chatgpt');assert.equal(result.generationQualified,false);assert.equal(f.calls.length,2);assert.equal(typeof f.transport.callDecision,'undefined');assert(f.calls.every(c=>!c.args.includes('exec')));});
test('API login cannot satisfy subscription preflight or cause a fallback',async t=>{const f=await fixture(t,{auth:'Logged in using an API key TEST_SECRET'});await assert.rejects(f.transport.preflight(),e=>e.code==='api_auth_forbidden'&&!String(e).includes('TEST_SECRET'));assert.equal(f.calls.length,2);});
test('explicit unsupported service tiers refuse before a process is created',async t=>{for(const serviceTier of ['auto','priority',null])await assert.rejects(fixture(t,{serviceTier}),{code:'invalid_configuration'});});
test('PATH discovery is portable, resolves an existing executable and never returns a personal fallback',async t=>{const directory=await mkdtemp(join(tmpdir(),'codex-discovery-'));t.after(()=>rm(directory,{recursive:true,force:true}));const executable=join(directory,process.platform==='win32'?'codex.exe':'codex');await writeFile(executable,'never executed');assert.equal(discoverCodexCliExecutable(undefined,{environment:{PATH:directory}}),executable);assert.equal(discoverCodexCliExecutable(undefined,{environment:{PATH:''}}),undefined);});
