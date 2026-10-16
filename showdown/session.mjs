import {ShowdownClient, FORMAT} from './client.mjs';
import {AgentSession} from './agent-session.mjs';
import {serveLocalSession} from './local-bridge.mjs';
import {createTTYBroker} from './tty-login.mjs';
import {createWindowsCredentialBroker} from './windows-credential-login.mjs';
import {attachTerminalLog} from './terminal-log.mjs';
import {attachMetricsRecorder} from '../metrics/recorder.mjs';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve, join, basename, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const require = createRequire(import.meta.url);
const workspace = fileURLToPath(new URL('..',import.meta.url));

function eventOnce(client,event,predicate,timeoutMs) {
  let timer, onEvent, onLoss;
  const cleanup=()=>{clearTimeout(timer);client.off(event,onEvent);client.off('disconnected',onLoss);};
  const promise=new Promise((resolvePromise,reject)=>{
    onEvent=value=>{if(predicate(value)){cleanup();resolvePromise(value);}};
    onLoss=()=>{cleanup();reject(new Error('Connection lost'));};
    client.on(event,onEvent);client.on('disconnected',onLoss);
    timer=setTimeout(()=>{cleanup();reject(new Error('Session setup timed out'));},timeoutMs);
  });
  promise.catch(()=>{});return {promise,cancel:cleanup};
}

/** The explicit saved-login option does not grant permission to queue battles. */
export function parseSessionArgs(argv) {
  const args=[...argv], username=args.shift();let teamFile,authorizedSets=1,autoReady=true,loginMethod='terminal';
  const valueFor=()=>{const value=args.shift();if(!value || value.startsWith('--'))throw new Error('Missing session option value');return value;};
  while(args.length){
    const key=args.shift();
    if(key==='--team')teamFile=valueFor();
    else if(key==='--sets')authorizedSets=Number(valueFor());
    else if(key==='--manual-ready')autoReady=false;
    else if(key==='--saved-login')loginMethod='windows-credential-manager';
    else throw new Error('Unknown session option');
  }
  if(!/^[A-Za-z0-9 _-]{1,18}$/.test(username || '') || !teamFile || !Number.isInteger(authorizedSets) || authorizedSets<1 || authorizedSets>100)
    throw new Error('Usage: node --use-env-proxy showdown/session.mjs USERNAME --team TEAM_FILE [--sets 1] [--manual-ready] [--saved-login]');
  return {username,teamFile:resolve(teamFile),authorizedSets,autoReady,loginMethod};
}

/** Login stays in a visible user terminal; MCP controls only the authenticated object. */
export async function runSession({username,teamFile,authorizedSets=1,autoReady=true,loginMethod='terminal',input=process.stdin,output=process.stderr,signals=process,clientFactory=options=>new ShowdownClient(options),brokerFactory,descriptorPath=join(workspace,'cache','showdown-session.json'),metrics=true,metricsWorkspace}={}) {
  if(!/^[A-Za-z0-9 _-]{1,18}$/.test(username || '') || !teamFile || !Number.isInteger(authorizedSets) || authorizedSets<1 || authorizedSets>100) throw new Error('Supply a valid username, team file and set limit (1–100)');
  if(!['terminal','windows-credential-manager'].includes(loginMethod))throw new Error('Unsupported login method');
  if(!input.isTTY || !output.isTTY || typeof input.setRawMode!=='function')throw new Error('Run this command in a visible user-operated terminal; password pipes and redirects are not supported');
  const {Teams,TeamValidator}=require('pokemon-showdown');
  const team=Teams.import(await readFile(teamFile,'utf8'));
  if(!team || team.length!==6)throw new Error('Expected a six-Pokémon team');
  const problems=new TeamValidator('gen9championsvgc2026regmc').validateTeam(team);
  if(problems?.length)throw new Error('Team validation failed: '+problems.join('; '));
  const packed=Teams.pack(team), expectedTeamHash=createHash('sha256').update(packed).digest('hex');
  const broker=brokerFactory ? brokerFactory({username,loginMethod}) : loginMethod==='windows-credential-manager' ? createWindowsCredentialBroker({username}) : createTTYBroker();
  const client=clientFactory({expectedTeamHash,broker,log:()=>{}});
  let session, bridge, challenge, identity, recorder, detachLog=()=>{};
  const stop=()=>{client.close();};
  for(const signal of ['SIGINT','SIGTERM','SIGHUP'])signals.on(signal,stop);
  try {
    challenge=eventOnce(client,'challenge',()=>!!client.challenge,25000);
    await client.connect();await challenge.promise;
    output.write(`Sign in as ${username}${loginMethod==='windows-credential-manager' ? ' using Windows Credential Manager' : ''}. Team validated for M-C; set limit: ${authorizedSets}. Signing in does not queue.\n`);
    identity=eventOnce(client,'identity',()=>client.authenticated,150000);
    await client.authenticate(username,{approved:true});await identity.promise;
    session=new AgentSession(client,{username,packed,authorizedSets,autoReady});
    if(metrics){
      const metricRoot=metricsWorkspace||(basename(dirname(descriptorPath))==='cache'?resolve(dirname(descriptorPath),'..'):dirname(descriptorPath));
      let warned=false;
      recorder=attachMetricsRecorder(client,{workspace:metricRoot,username,teamId:expectedTeamHash,team,name:basename(teamFile,'.txt'),session,onError:()=>{if(!warned){warned=true;output.write('Team metrics could not be saved; battle controls remain available.\n');}}});
    }
    let onDisconnected;
    const disconnected=new Promise(resolvePromise=>{onDisconnected=resolvePromise;client.once('disconnected',onDisconnected);});
    // Credentials and login events never enter the terminal battle formatter.
    detachLog=attachTerminalLog(client,{output});
    // Never permit hidden reconnect/authentication through the control interface.
    client.connect=async()=>{throw new Error('Start a new user-operated login after disconnect');};
    try {
      bridge=await serveLocalSession(session,{descriptorPath});
      if(client.connected && client.authenticated){
        output.write(`Signed in. MCP battle controls are ready; live battle events will appear here.\nFormat: ${FORMAT}. Auto-ready within the authorized set: ${autoReady ? 'on' : 'off'}. Ctrl-C closes the session.\n`);
        await disconnected;
      }
    }finally{client.off('disconnected',onDisconnected);}
    // Allow the local stop RPC to flush its result before shutting down the listener.
    await new Promise(resolvePromise=>setTimeout(resolvePromise,50));
  } finally {
    challenge?.cancel();identity?.cancel();
    await bridge?.close();detachLog();await recorder?.close();session?.dispose();client.close();
    for(const signal of ['SIGINT','SIGTERM','SIGHUP'])signals.off(signal,stop);
  }
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    await runSession(parseSessionArgs(process.argv.slice(2)));
  }catch(error){process.stderr.write(`Battle session stopped: ${error.message}\n`);process.exitCode=1;}
}
