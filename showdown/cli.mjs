import {ShowdownClient, FIXED_TEAM_SHA256} from './client.mjs';
import {runControl} from './control.mjs';
import {createTTYBroker} from './tty-login.mjs';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {createInterface} from 'node:readline';
import {attachTerminalLog} from './terminal-log.mjs';
const require = createRequire(import.meta.url);
const argv = process.argv.slice(2);
let expectedTeamHash = FIXED_TEAM_SHA256;
const hashFlag = argv.indexOf('--team-sha256');
if (hashFlag !== -1) {
  if (hashFlag !== argv.length - 2 || !/^[a-f0-9]{64}$/.test(argv[hashFlag + 1])) throw new Error('Supply one lowercase SHA-256 team hash as the final option');
  expectedTeamHash = argv[hashFlag + 1]; argv.splice(hashFlag,2);
}
const mode = argv[0] || 'help';
if (mode === 'pack-team') {
  const path = argv[1]; if (!path) throw new Error('Supply team file path');
  const text = await readFile(path,'utf8');
  const {Teams} = require('pokemon-showdown');
  const team = Teams.import(text); if (!team || team.length !== 6) throw new Error('Expected six Pokemon');
  const packed = Teams.pack(team);
  console.log(JSON.stringify({packed,sha256:createHash('sha256').update(packed).digest('hex'),count:team.length}));
} else if (mode === 'smoke' || mode === 'observe' || mode === 'control' || mode === 'login') {
  if(mode === 'login' && (argv.length !== 2 || !/^[A-Za-z0-9 _-]{1,18}$/.test(argv[1]) || !process.stdin.isTTY || !process.stderr.isTTY)) throw new Error('Usage: node showdown/cli.mjs login USERNAME in a user-operated TTY. No password arguments, pipes or redirects.');
  const client = new ShowdownClient({expectedTeamHash, log: row => console.error(JSON.stringify(row))});
  for (const event of ['search-state','server-notice','choice-status','request','battle-event','sheet','timer','result','ready','server-error','replay-url','replay-verified']) client.on(event,data => console.log(JSON.stringify({event,...data})));
  const challenge = new Promise(resolve => client.once('challenge',resolve));
  try {
    await client.connect();
    await Promise.race([challenge,new Promise((_,reject) => setTimeout(() => reject(new Error('No server challenge within 10 seconds')),10000).unref())]);
    console.log(JSON.stringify({connected:true,challengeReceived:true,authenticated:false}));
    if (mode === 'login') {
      client.broker=createTTYBroker();
      let loginTimer, identityListener;
      const acknowledgement = new Promise((resolve,reject)=>{
        identityListener = state => { if(state.authenticated){clearTimeout(loginTimer);client.off('identity',identityListener);resolve();} };
        loginTimer=setTimeout(()=>{client.off('identity',identityListener);reject(new Error('Authenticated identity was not acknowledged'));},150000);
        client.on('identity',identityListener);
      });
      // Install a rejection handler while the user is entering their password.
      acknowledgement.catch(()=>{});
      try {
        await client.authenticate(argv[1],{approved:true});
        await acknowledgement;
      } finally { clearTimeout(loginTimer); client.off('identity',identityListener); }
      console.log(JSON.stringify({event:'authenticated',authenticated:true}));
      const detachLog=attachTerminalLog(client);
      try {await runControl(client);}finally{detachLog();}
    }
    if (mode === 'control') await runControl(client);
    if (mode === 'observe') {
      // Deliberately no login, generic raw-command, or live-action CLI in this build.
      const lines = createInterface({input:process.stdin});
      for await (const line of lines) {
        if (line === 'status') console.log(JSON.stringify(client.snapshot()));
        else if (line === 'quit') break;
        else console.log(JSON.stringify({error:'Read-only CLI supports status and quit only; secure auth adapter required for action API'}));
      }
    }
  } catch (error) { console.error(JSON.stringify({error:error.message})); process.exitCode = 1; }
  finally { client.close(); }
} else {
  console.log('node showdown/cli.mjs smoke | observe | control | login USERNAME | pack-team FILE\nSmoke is anonymous and never queues a battle. Observe accepts status and quit.');
}
