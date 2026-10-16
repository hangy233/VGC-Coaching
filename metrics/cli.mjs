#!/usr/bin/env node
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {getTeamReport, listTeams, MAX_ACTIVE_TEAMS} from './store.mjs';
import {importBattleFiles, refreshMetricsSources, registerTeamFromFile} from './import.mjs';
import {importReplayUrls} from './replays.mjs';
import {exportReport, addTeamProfileLinks} from './dashboard.mjs';
import {updateTeamReport} from './live-reports.mjs';
import {getAgentTeamReport} from './agent-service.mjs';
import {deleteTeamReport} from './team-cleanup.mjs';
import {listMetricsTeamDeletions} from './catalog.mjs';

const help=`Private team metrics

  node metrics/cli.mjs list [--include-archived]
  node metrics/cli.mjs register --team-file teams/team.txt [--name NAME]
  node metrics/cli.mjs import --file cache/battles.jsonl --username NAME --team TEAM_ID [--ledger cache/results.json] [--name NAME]
  node metrics/cli.mjs import --url https://replay.pokemonshowdown.com/REPLAY_ID --username NAME --team TEAM_ID
  Use --team-file teams/team.txt instead of --team to register an export during import.
  node metrics/cli.mjs report [--team TEAM_ID] [filters]
  node metrics/cli.mjs review [--team TEAM_ID] [filters] [--include-games] [--max-evidence 5]
  node metrics/cli.mjs export [--team TEAM_ID] --format html|csv|json [--output review.html] [filters]
  node metrics/cli.mjs delete --team TEAM_ID [--confirm]

Filters: --opponent-species NAME --selected-species NAME --outcome win|loss|tie|unknown
         --from YYYY-MM-DD --to YYYY-MM-DD --include-incomplete --include-operational
         --include-manually-excluded (opt in to audited review exclusions)
Use --file or --url repeatedly, up to 20 inputs. These input types cannot be mixed in one import.
--workspace PATH defaults to this repository. URL import reads existing replays; it never publishes them.
Imports remember local sources for query-time refresh; --no-remember disables this for that import.
Review returns an evidence-backed JSON brief for agents. Its stable team profile includes agent JSON and Markdown.
Manual exports write new files only in cache/team-metrics/reports. No login, battle search or upload.
Delete previews the exact team's permanent cascade by default; --confirm applies it.
The ten-team LRU permanently cleans evicted reports and owned data. Blocked cleanup remains explicit.
`;

export function parseArguments(argv) {
  let [command='help',...tokens]=argv;
  if(command==='--help'||command==='-h')command='help';
  const values={files:[],urls:[]};
  const single=new Map([['--workspace','workspace'],['--team','teamId'],['--username','username'],['--team-file','teamFile'],['--ledger','ledgerFile'],['--name','name'],['--format','format'],['--output','output'],['--opponent-species','opponentSpecies'],['--selected-species','selectedSpecies'],['--outcome','outcome'],['--from','from'],['--to','to'],['--max-evidence','maxEvidence']]);
  for (let i=0;i<tokens.length;i++) {
    const key=tokens[i];
    if (key==='--include-incomplete'||key==='--include-operational') {values[key==='--include-incomplete'?'includeIncomplete':'includeOperational']=true;continue;}
    if(key==='--include-manually-excluded'){if(Object.hasOwn(values,'includeManuallyExcluded'))throw new Error('Duplicate option: --include-manually-excluded');values.includeManuallyExcluded=true;continue;}
    if(key==='--include-archived'){values.includeArchived=true;continue;}
    if(key==='--include-games'){values.includeGames=true;continue;}
    if(key==='--confirm'){if(Object.hasOwn(values,'confirmed'))throw new Error('Duplicate option: --confirm');values.confirmed=true;continue;}
    if(key==='--remember'||key==='--no-remember') {if(Object.hasOwn(values,'remember'))throw new Error('Use only one remember option.');values.remember=key==='--remember';continue;}
    if(key==='--help'||key==='-h') return {command:'help',values:{files:[],urls:[]}};
    if(!['--file','--url'].includes(key)&&!single.has(key)) throw new Error(`Unknown option: ${key}`);
    const value=tokens[++i];
    if(!value||value.startsWith('--')) throw new Error(`Missing value for ${key}.`);
    if(key==='--file') values.files.push(value);
    else if(key==='--url')values.urls.push(value);
    else {const field=single.get(key);if(Object.hasOwn(values,field))throw new Error(`Duplicate option: ${key}`);values[field]=value;}
  }
  if(values.teamId&&!/^[a-f0-9]{64}$/.test(values.teamId)) throw new Error('--team must be a full team fingerprint from list.');
  if(values.outcome&&!['win','loss','tie','unknown'].includes(values.outcome)) throw new Error('Invalid --outcome.');
  if(values.format&&!['html','csv','json'].includes(values.format)) throw new Error('Invalid --format.');
  if(Object.hasOwn(values,'maxEvidence')){if(!/^(?:[1-9]|1[0-9]|20)$/.test(values.maxEvidence))throw new Error('--max-evidence must be an integer from 1 to 20.');values.maxEvidence=Number(values.maxEvidence);}
  if(values.files.length>20)throw new Error('Import supports at most 20 local files.');
  if(values.urls.length>20)throw new Error('Import supports at most 20 replay URLs.');
  if(values.files.length&&values.urls.length)throw new Error('Use either --file or --url in one import.');
  if(values.urls.length&&Object.hasOwn(values,'remember'))throw new Error('Replay URL imports do not remember private access URLs.');
  if(command==='import'&&values.teamId&&values.teamFile)throw new Error('Supply exactly one of --team or --team-file.');
  if(values.username&&values.username.length>30)throw new Error('Username must be at most 30 characters.');
  for (const key of ['from','to']) if(values[key]&&!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(values[key])) throw new Error(`Invalid --${key}; use an ISO date or timestamp.`);
  for (const key of ['from','to']) if(values[key]&&!Number.isFinite(Date.parse(values[key]))) throw new Error(`Invalid --${key}.`);
  const common=['workspace'];
  const reportOptions=['teamId','opponentSpecies','selectedSpecies','outcome','from','to','includeIncomplete','includeOperational','includeManuallyExcluded'];
  const allowed={list:[...common,'includeArchived'],register:[...common,'teamFile','name'],report:[...common,...reportOptions],review:[...common,...reportOptions,'includeGames','maxEvidence'],export:[...common,...reportOptions,'format','output'],import:[...common,'username','teamFile','teamId','ledgerFile','name','remember'],delete:[...common,'teamId','confirmed']};
  if(command!=='help'&&!allowed[command]) throw new Error(`Unknown command: ${command}`);
  if(command!=='help') for(const field of Object.keys(values)) {
    if(field==='files') {if(values.files.length&&command!=='import')throw new Error('--file is only supported by import.');}
    else if(field==='urls') {if(values.urls.length&&command!=='import')throw new Error('--url is only supported by import.');}
    else if(!allowed[command].includes(field))throw new Error(`Option ${field} is not supported by ${command}.`);
  }
  return {command,values};
}

export async function runCli(argv,{write=value=>process.stdout.write(value+'\n'),replayImporter=importReplayUrls,teamDeleter=deleteTeamReport}={}) {
  const {command,values}=parseArguments(argv);
  if(command==='help'||command==='--help'||command==='-h') {write(help);return;}
  const {workspace=resolve(fileURLToPath(new URL('..',import.meta.url))),files,urls,format='html',output,...args}=values;
  let result;
  let refresh;
  if(['list','report','review','export'].includes(command))refresh=await refreshMetricsSources({workspace});
  if(command==='list'){const [all,pendingCleanupTeams]=await Promise.all([listTeams({workspace,includeArchived:true}),listMetricsTeamDeletions({workspace})]);const teams=await addTeamProfileLinks({workspace,teams:args.includeArchived?all:all.filter(team=>team.active!==false)});result={teams,pendingCleanupTeams,capacity:{maxActiveTeams:MAX_ACTIVE_TEAMS,activeTeams:all.filter(team=>team.active!==false).length,archivedTeams:all.filter(team=>team.archived).length},refresh};}
  if(command==='register'){if(!args.teamFile)throw new Error('Register requires --team-file.');result=await registerTeamFromFile({workspace,...args});}
  if(command==='delete'){
    if(!args.teamId)throw new Error('Delete requires --team with the full team fingerprint.');
    result=await teamDeleter({workspace,...args,dryRun:args.confirmed!==true});
  }
  if(command==='import') {
    if((!files.length&&!urls.length)||!args.username||Boolean(args.teamFile)===Boolean(args.teamId)) throw new Error('Import requires --file or --url, --username and exactly one of --team or --team-file.');
    if(urls.length){try{result=await replayImporter({workspace,urls,...args});}catch{throw new Error('Replay import failed. Check the supported replay URLs, owner username and saved team ID or local team file.');}}
    else result=await importBattleFiles({workspace,files,remember:true,...args});
  }
  if(command==='report'||command==='export') {
    const data=await getTeamReport({workspace,...args});
    const stableReport=data.team?.teamId?await updateTeamReport({workspace,teamId:data.team.teamId}):null;
    const report={...data,stableReport,refresh};
    result=command==='report'?report:{...await exportReport({workspace,report,format,output}),stableReport,refresh};
  }
  if(command==='review') {
    const brief=await getAgentTeamReport({workspace,...args});
    const stableReport=brief.team?.teamId?await updateTeamReport({workspace,teamId:brief.team.teamId}):null;
    result={...brief,stableReport,refresh};
  }
  write(JSON.stringify(result,null,2));
  return result;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  runCli(process.argv.slice(2)).catch(error=>{process.stderr.write(`Team metrics: ${error.message}\n`);process.exitCode=1;});
}
