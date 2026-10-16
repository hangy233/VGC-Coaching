import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runInNewContext} from 'node:vm';
import {renderDashboard, renderCsv, csvCell, exportReport, aggregateFilteredGames} from './dashboard.mjs';

const id='a'.repeat(64);
function report() {
  return {schemaVersion:1,team:{teamId:id,name:'Rain team',roster:['Golisopod']},filters:{includeIncomplete:false,includeOperational:false},totals:{games:2,wins:1,losses:1,ties:0,unknown:0,winRate:50,winRateDenominator:2,sets:{played:1,wins:1,losses:0,ties:0,unknown:0,incomplete:0,winRate:100,winRateDenominator:1}},quality:{storedGames:3,includedGames:2,excludedIncomplete:1,excludedOperational:0,warnings:[]},selection:{gamesWithSelection:2,gamesWithoutSelection:0},pokemon:[{species:'Golisopod',selectedGames:2,selectionDenominator:2,selectionRate:100,leadGames:1,leadDenominator:2,selectionWinRate:50,selectionWinRateDenominator:2,switchIns:2,faints:1,knockouts:2,indirectKnockouts:0,itemRemovals:1,moves:[{move:'Knock Off',uses:3,usagePercent:75,usageDenominator:4,failed:0,missed:0,blocked:1,knockouts:1,itemRemovals:1}]}],opponents:[{species:'Incineroar',games:2,wins:1,losses:1,ties:0,unknown:0,winRate:50,winRateDenominator:2}],games:[{roomId:'battle-test-1',parentId:'game-bestof3-test-1',outcome:'win',completed:true,turns:4,opponent:'Example',opponentRoster:['Incineroar'],selected:['Golisopod'],leads:['Golisopod'],selectionKnown:true,quality:{operational:false},playedAt:'2026-10-15T00:00:00Z'}]};
}

test('dashboard safely embeds hostile names without executable markup or network assets',()=>{
  const data=report();
  const hostile='</script><img src=x onerror=alert(1)>&\u2028';
  data.team.name=hostile;data.pokemon[0].species=hostile;data.games[0].opponent=hostile;
  const result=renderDashboard(data);
  assert.equal(result.includes(hostile),false);
  assert.equal(result.includes('<img src=x'),false);
  assert.match(result,/\\u003c\/script\\u003e/);
  assert.match(result,/textContent/);
  assert.equal(result.includes('innerHTML'),false);
  assert.equal(/<script[^>]+src=/i.test(result),false);
  const json=result.match(/<script type="application\/json" id="report-data">(.*?)<\/script>/s)[1];
  assert.deepEqual(JSON.parse(json),data);
  assert.match(result,/Filters update every summary and table below/);
  assert.match(result,/older export lacks per-game metrics/);
});

test('CSV retains move and Pokemon attribution and neutralizes formula cells',()=>{
  const data=report();data.team.name='=WEBSERVICE("evil")';
  const result=renderCsv(data);
  assert.match(result,/'=WEBSERVICE/);
  assert.match(result,/Golisopod,Knock Off,,,,,uses,3,/);
  assert.match(result,/Golisopod,Knock Off,,,,,itemRemovals,1,/);
  assert.match(result,/excludedIncomplete,1,/);
  assert.equal(csvCell('\t=SUM(A1)'),"'\t=SUM(A1)");
  assert.equal(csvCell(' @SUM(A1)'),"' @SUM(A1)");
  assert.equal(csvCell(-2),'-2');
  assert.equal(csvCell('a,"b"'),'"a,""b"""');
});

test('dashboard and CSV show only exact verified game replay links, including private URLs',()=>{
  const data=report(),base=data.games[0],roomId='battle-gen9championsvgc2026regmcbo3-123',url='https://replay.pokemonshowdown.com/gen9championsvgc2026regmcbo3-123-privateaccesspw';
  data.games=[{...base,roomId,opponent:'<img src=x onerror=alert(1)>',opponentRoster:['Archaludon'],pokemon:[],replay:{url,verified:true}},{...base,roomId:'battle-gen9championsvgc2026regmcbo3-124',pokemon:[],replay:{url,verified:true}},{...base,roomId:'battle-gen9championsvgc2026regmcbo3-125',pokemon:[],replay:{url:'javascript:alert(1)',verified:true}},{...base,roomId:'battle-gen9championsvgc2026regmcbo3-126',pokemon:[],replay:{url:'https://replay.pokemonshowdown.com/gen9championsvgc2026regmcbo3-126',verified:false}}];
  data.totals.games=4;data.quality.storedGames=4;
  class Element {constructor(tag){this.tagName=tag.toUpperCase();this.nodeType=1;this.children=[];this.textContent='';this.value='';this.handlers={};}append(...children){this.children.push(...children);}replaceChildren(...children){this.children=[...children];}addEventListener(name,handler){this.handlers[name]=handler;}}
  const markup=renderDashboard(data),elements=new Map([...markup.matchAll(/id="([^"]+)"/g)].map(match=>[match[1],new Element('div')]));
  elements.get('report-data').textContent=JSON.stringify(data);
  const document={getElementById:name=>elements.get(name),createElement:tag=>new Element(tag)},script=[...markup.matchAll(/<script>(.*?)<\/script>/gs)].at(-1)[1];
  runInNewContext(script,{document,URL},{timeout:1000});
  let table=elements.get('games').children[0],rows=table.children[1].children;
  assert.equal(table.children[0].children[0].children[1].textContent,'Replay');
  const anchor=rows[0].children[1].children[0];assert.equal(anchor.tagName,'A');assert.equal(anchor.textContent,'Watch replay');assert.equal(anchor.href,url);assert.equal(anchor.target,'_blank');assert.equal(anchor.rel,'noreferrer noopener');
  assert.equal(rows[0].children[3].textContent,'<img src=x onerror=alert(1)>');
  for(const row of rows.slice(1)){assert.equal(row.children[1].textContent,'Not saved');assert.equal(row.children[1].children.length,0);}
  const opponentFilter=elements.get('opponent-filter');opponentFilter.value='Archaludon';opponentFilter.handlers.change();
  table=elements.get('games').children[0];rows=table.children[1].children;assert.equal(rows.length,1);assert.equal(rows[0].children[1].children[0].href,url);
  const csv=renderCsv(data),lines=csv.trimEnd().split('\r\n'),headers=lines[0].split(','),urlIndex=headers.indexOf('replayUrl');assert.equal(urlIndex,headers.length-1);
  const gameRows=lines.filter(line=>line.startsWith('game,')).map(line=>line.split(','));
  assert.equal(gameRows.length,8);assert(gameRows.filter(row=>row[6]===roomId).every(row=>row[urlIndex]===url));assert(gameRows.filter(row=>row[6]!==roomId).every(row=>row[urlIndex]===''));
  assert.equal(csv.includes('javascript:'),false);assert.equal(markup.includes('innerHTML'),false);
});

test('exports round trip JSON, reject traversal and overwrite, keep all writes in reports',async t=>{
  const workspace=await mkdtemp(join(tmpdir(),'team-metrics-tools-'));
  t.after(()=>rm(workspace,{recursive:true,force:true}));
  const saved=await exportReport({workspace,report:report(),format:'json',output:'review.json'});
  assert.equal(saved.path,join(workspace,'cache','team-metrics','reports','review.json'));
  assert.deepEqual(JSON.parse(await readFile(saved.path,'utf8')),report());
  await assert.rejects(exportReport({workspace,report:report(),format:'json',output:'review.json'}),{code:'EEXIST'});
  for(const output of ['../../source.json','../source.json','secret.txt','.hidden.json','nested/review.json'])await assert.rejects(exportReport({workspace,report:report(),format:'json',output}),/safe .json filename/);
});

test('export refuses a reports directory symbolic link',async t=>{
  const workspace=await mkdtemp(join(tmpdir(),'team-metrics-link-'));
  const outside=await mkdtemp(join(tmpdir(),'team-metrics-outside-'));
  t.after(()=>Promise.all([rm(workspace,{recursive:true,force:true}),rm(outside,{recursive:true,force:true})]));
  await mkdir(join(workspace,'cache','team-metrics'),{recursive:true});
  try{await symlink(outside,join(workspace,'cache','team-metrics','reports'),process.platform==='win32'?'junction':'dir');}catch(error){if(['EPERM','EACCES'].includes(error.code)){t.skip('Symbolic links are unavailable.');return;}throw error;}
  await assert.rejects(exportReport({workspace,report:report(),format:'html',output:'review.html'}),/without symbolic links/);
});

test('CLI rejects unknown options, invalid team IDs and unsupported command options',async()=>{
  const {parseArguments}=await import('./cli.mjs');
  assert.equal(parseArguments(['--help']).command,'help');
  assert.deepEqual(parseArguments(['import','--file','one.log','--file','two.log','--username','TofuRotom','--team-file','team.txt']).values.files,['one.log','two.log']);
  assert.deepEqual(parseArguments(['import','--url','https://replay.pokemonshowdown.com/a','--url','https://replay.pokemonshowdown.com/b']).values.urls,['https://replay.pokemonshowdown.com/a','https://replay.pokemonshowdown.com/b']);
  assert.equal(parseArguments(['list','--include-archived']).values.includeArchived,true);
  assert.equal(parseArguments(['register','--team-file','team.txt']).command,'register');
  const review=parseArguments(['review','--team',id,'--opponent-species','Archaludon','--include-games','--max-evidence','10']);
  assert.equal(review.command,'review');assert.equal(review.values.teamId,id);assert.equal(review.values.includeGames,true);assert.equal(review.values.maxEvidence,10);assert.equal(review.values.opponentSpecies,'Archaludon');
  for(const value of ['0','21','-1','2.5','2e0','NaN','Infinity'])assert.throws(()=>parseArguments(['review','--max-evidence',value]),/integer from 1 to 20/);
  assert.throws(()=>parseArguments(['report','--include-games']),/not supported/);
  assert.throws(()=>parseArguments(['export','--max-evidence','5']),/not supported/);
  assert.equal(parseArguments(['import','--url','https://replay.pokemonshowdown.com/a','--team',id]).values.teamId,id);
  assert.throws(()=>parseArguments(['import','--url','https://replay.pokemonshowdown.com/a','--team',id,'--team-file','team.txt']),/exactly one/);
  assert.throws(()=>parseArguments(['import','--file','one.log','--url','https://replay.pokemonshowdown.com/a']),/either --file or --url/);
  assert.throws(()=>parseArguments(['import','--url','https://replay.pokemonshowdown.com/a','--remember']),/do not remember/);
  assert.throws(()=>parseArguments(['report','--team','latest']),/fingerprint/);
  assert.throws(()=>parseArguments(['report','--unknown','x']),/Unknown option/);
  assert.throws(()=>parseArguments(['list','--output','report.json']),/not supported/);
  assert.throws(()=>parseArguments(['export','--format','xml']),/Invalid --format/);
});

test('MCP tools expose strict local-only schemas and no battle controls',async()=>{
  const {registerMetricsTools}=await import('./mcp-tools.mjs');
  const registrations=new Map();
  registerMetricsTools({registerTool(name,settings,handler){registrations.set(name,{settings,handler});}},{workspace:process.cwd()});
  for(const name of ['team_metrics_list','team_metrics_report','team_metrics_agent_report','team_metrics_register_team','team_metrics_game_evidence','team_metrics_finalize_bo3','team_metrics_import','team_metrics_import_replays','team_metrics_export'])assert(registrations.has(name));
  for(const [name,{settings}] of registrations)assert.equal(settings.annotations.openWorldHint,['team_metrics_import_replays','team_metrics_finalize_bo3'].includes(name));
  assert.equal(registrations.get('team_metrics_report').settings.annotations.readOnlyHint,true);
  assert.equal(registrations.get('team_metrics_import').settings.annotations.readOnlyHint,false);
  const schema=registrations.get('team_metrics_report').settings.inputSchema;
  assert.equal(schema.safeParse({teamId:id,includeOperational:true}).success,true);
  assert.equal(schema.safeParse({teamId:id,confirmed:true}).success,false);
  assert.equal(schema.safeParse({teamId:'anything'}).success,false);
  const agent=registrations.get('team_metrics_agent_report'),agentSchema=agent.settings.inputSchema;
  assert.equal(agent.settings.annotations.readOnlyHint,true);assert.equal(agent.settings.annotations.openWorldHint,false);
  assert.match(agent.settings.description,/cited turns and open sheets/);assert.match(agent.settings.description,/calculate_damage and calculate_speed/);
  assert.deepEqual(agentSchema.parse({teamId:id}),{teamId:id,includeIncomplete:false,includeOperational:false,includeGames:false,maxEvidence:5});
  assert.equal(agentSchema.safeParse({teamId:id,opponentSpecies:'Archaludon',includeGames:true,maxEvidence:20,includeOperational:true}).success,true);
  for(const maxEvidence of [0,21,2.5,'5'])assert.equal(agentSchema.safeParse({teamId:id,maxEvidence}).success,false);
  assert.equal(agentSchema.safeParse({teamId:id,applyChanges:true}).success,false);
  const finalizeSchema=registrations.get('team_metrics_finalize_bo3').settings.inputSchema;
  const finalizeArgs=finalizeSchema.parse({teamId:id,parentId:'game-bestof3-gen9championsvgc2026regmcbo3-123',checkpointFile:'cache/reviews/set.json'});
  assert.equal(finalizeArgs.dryRun,true);assert.equal(finalizeArgs.saveReplays,false);assert.deepEqual(finalizeArgs.sourceFiles,[]);assert.deepEqual(finalizeArgs.cleanupFiles,[]);
  assert.equal(finalizeSchema.safeParse({...finalizeArgs,confirmed:false}).success,false);assert.equal(finalizeSchema.safeParse({...finalizeArgs,room:'anything'}).success,false);
  const evidenceSchema=registrations.get('team_metrics_game_evidence').settings.inputSchema;
  assert.equal(evidenceSchema.safeParse({teamId:id,roomId:'battle-gen9championsvgc2026regmcbo3-123',fromTurn:0,toTurn:7}).success,true);
  for(const args of [{teamId:'latest',roomId:'battle-gen9championsvgc2026regmcbo3-123'},{teamId:id,roomId:'game-bestof3-gen9championsvgc2026regmcbo3-123'},{teamId:id,roomId:'battle-gen9championsvgc2026regmcbo3-123',fromTurn:1.5},{teamId:id,roomId:'battle-gen9championsvgc2026regmcbo3-123',toTurn:-1}])assert.equal(evidenceSchema.safeParse(args).success,false);
  const importSchema=registrations.get('team_metrics_import').settings.inputSchema;
  assert.equal(importSchema.safeParse({files:['cache/log.jsonl'],username:'TofuRotom',teamFile:'teams/team.txt'}).success,true);
  assert.equal(importSchema.safeParse({files:[],username:'TofuRotom',teamFile:'teams/team.txt'}).success,false);
  assert.equal(importSchema.safeParse({files:Array(21).fill('cache/log.jsonl'),username:'TofuRotom',teamFile:'teams/team.txt'}).success,false);
  assert.equal(importSchema.safeParse({files:['cache/log.jsonl'],username:'a'.repeat(31),teamFile:'teams/team.txt'}).success,false);
  assert.equal(importSchema.safeParse({files:['cache/log.jsonl'],username:'TofuRotom',teamId:id}).success,true);
  assert.equal(importSchema.safeParse({files:['cache/log.jsonl'],username:'TofuRotom'}).success,false);
  assert.equal(importSchema.safeParse({files:['cache/log.jsonl'],username:'TofuRotom',teamId:id,teamFile:'teams/team.txt'}).success,false);
  const replaySchema=registrations.get('team_metrics_import_replays').settings.inputSchema;
  assert.equal(replaySchema.safeParse({urls:['https://replay.pokemonshowdown.com/example'],username:'TofuRotom',teamFile:'teams/team.txt'}).success,true);
  assert.equal(replaySchema.safeParse({urls:['https://replay.pokemonshowdown.com/example'],username:'TofuRotom',teamFile:'teams/team.txt',remember:true}).success,false);
  assert.equal(replaySchema.safeParse({urls:['https://replay.pokemonshowdown.com/example'],username:'TofuRotom',teamId:id}).success,true);
  assert.equal(replaySchema.safeParse({urls:['https://replay.pokemonshowdown.com/example'],username:'TofuRotom'}).success,false);
  assert.equal(replaySchema.safeParse({urls:['https://replay.pokemonshowdown.com/example'],username:'TofuRotom',teamId:id,teamFile:'teams/team.txt'}).success,false);
});

test('MCP report filters, refresh metadata and CSV export work through real local storage',async t=>{
  const {registerMetricsTools}=await import('./mcp-tools.mjs');
  const {saveBattle}=await import('./store.mjs');
  const workspace=await mkdtemp(join(tmpdir(),'team-metrics-mcp-'));
  t.after(()=>rm(workspace,{recursive:true,force:true}));
  const summary=report(),p=summary.pokemon[0];
  const base={schemaVersion:1,roomId:'battle-test-1',parentId:'game-bestof3-test-1',teamId:id,username:'TofuRotom',ownSide:'p1',outcome:'win',completed:true,turns:4,players:{p1:'TofuRotom',p2:'Example'},opponentRoster:['Incineroar'],selected:['Golisopod'],selectionKnown:true,leads:['Golisopod'],pokemon:[{...p,key:'golisopod:1',selected:true,lead:true,forms:['Golisopod-Mega']}],quality:{complete:true,operational:false,warnings:[]},team:{name:'Rain team',format:'gen9championsvgc2026regmc',roster:['Golisopod']},metadata:{endedAt:'2026-10-15T00:00:00Z',setResult:{outcome:'win',completed:true}}};
  await saveBattle({workspace,record:base});
  await saveBattle({workspace,record:{...base,roomId:'battle-test-2',outcome:'loss',quality:{complete:true,operational:true,warnings:['Inactivity observed.']}}});
  const registrations=new Map();
  registerMetricsTools({registerTool(name,settings,handler){registrations.set(name,{settings,handler});}},{workspace});
  const invoke=async(name,args={})=>{const tool=registrations.get(name);const response=await tool.handler(tool.settings.inputSchema.parse(args));assert.notEqual(response.isError,true,response.content[0].text);return JSON.parse(response.content[0].text);};
  const listed=await invoke('team_metrics_list');
  assert.equal(listed.teams.length,1);assert.deepEqual(listed.refresh,{refreshed:0,warnings:[]});
  assert.equal(listed.capacity.maxActiveTeams,10);assert.equal(listed.capacity.activeTeams,1);
  const listedAgain=await invoke('team_metrics_list');
  assert.equal(listedAgain.teams[0].lastUsedAt,listed.teams[0].lastUsedAt);
  const result=await invoke('team_metrics_report',{teamId:id,opponentSpecies:'Incineroar'});
  assert.equal(result.totals.games,1);assert.equal(result.quality.excludedOperational,1);assert.equal(result.pokemon[0].moves[0].uses,3);assert.equal(result.pokemon[0].itemRemovals,1);
  assert.equal(result.stableReport.teamId,id);assert.match(result.stableReport.path,/reports[\\/]teams[\\/]/);
  assert.equal((await invoke('team_metrics_list')).teams[0].stableReportPath,result.stableReport.path);
  const included=await invoke('team_metrics_report',{teamId:id,includeOperational:true});
  assert.equal(included.totals.games,2);
  const brief=await invoke('team_metrics_agent_report',{teamId:id,opponentSpecies:'Incineroar',includeGames:true,maxEvidence:1});
  assert.equal(brief.team.teamId,id);assert.deepEqual(brief.refresh,{refreshed:0,warnings:[]});
  assert.equal(brief.kind,'vgc-team-agent-report');assert.equal(brief.totals.games,1);assert.equal(brief.scope.filters.opponentSpecies,'Incineroar');
  assert.equal(brief.quality.excludedOperational,1);assert.equal(brief.games.length,1);assert.equal(brief.games[0].roomId,'battle-test-1');
  assert.equal(brief.reviewSignalCoverage.maxEvidencePerSignal,1);
  for(const signal of brief.reviewSignals)assert.ok(signal.evidence.gameIds.length<=1);
  assert.equal(brief.provenance.turnEvidenceIncluded,false);assert.equal(brief.provenance.decisionEvidenceIncluded,false);
  const compact=await invoke('team_metrics_agent_report',{teamId:id});
  assert.equal(Object.hasOwn(compact,'games'),false);assert.equal(compact.totals.games,1);
  const emptyBrief=await invoke('team_metrics_agent_report',{teamId:id,opponentSpecies:'Charizard',includeGames:true});
  assert.equal(emptyBrief.totals.games,0);assert.equal(emptyBrief.games.length,0);
  assert.match(brief.stableReport.agentJsonPath,/reports[\\/]teams[\\/][a-f0-9]{64}\.agent\.json$/);
  assert.match(brief.stableReport.agentMarkdownPath,/reports[\\/]teams[\\/][a-f0-9]{64}\.agent\.md$/);
  const stableBrief=JSON.parse(await readFile(brief.stableReport.agentJsonPath,'utf8'));
  assert.equal(stableBrief.team.teamId,id);assert.match(await readFile(brief.stableReport.agentMarkdownPath,'utf8'),/Rain team/);
  const {runCli}=await import('./cli.mjs');
  const cliOutput=[];
  const cliBrief=await runCli(['review','--workspace',workspace,'--team',id,'--opponent-species','Incineroar','--include-games','--max-evidence','1'],{write:value=>cliOutput.push(value)});
  assert.equal(cliBrief.team.teamId,id);assert.equal(JSON.parse(cliOutput[0]).team.teamId,id);
  assert.equal(cliBrief.stableReport.agentJsonPath,brief.stableReport.agentJsonPath);
  const exported=await invoke('team_metrics_export',{teamId:id,format:'csv',output:'metrics.csv'});
  assert.equal(exported.games,1);assert.match(await readFile(exported.path,'utf8'),/Knock Off/);
});

test('replay MCP and CLI routing keep private URL values out of responses and errors',async()=>{
  const {registerMetricsTools}=await import('./mcp-tools.mjs');
  const {runCli}=await import('./cli.mjs');
  const secretUrl='https://replay.pokemonshowdown.com/gen9championsvgc2026regmc-123-secretpw';
  let observed;
  const replayImporter=async args=>{observed=args;return {imported:1,replayUrls:1};};
  const registrations=new Map();
  registerMetricsTools({registerTool(name,settings,handler){registrations.set(name,{settings,handler});}},{workspace:process.cwd(),replayImporter});
  const tool=registrations.get('team_metrics_import_replays');
  const response=await tool.handler(tool.settings.inputSchema.parse({urls:[secretUrl],username:'TofuRotom',teamFile:'teams/team.txt'}));
  assert.equal(observed.urls[0],secretUrl);assert.equal(JSON.stringify(response).includes('secretpw'),false);
  await tool.handler(tool.settings.inputSchema.parse({urls:[secretUrl],username:'TofuRotom',teamId:id}));
  assert.equal(observed.teamId,id);assert.equal(Object.hasOwn(observed,'teamFile'),false);
  const output=[];
  await runCli(['import','--url',secretUrl,'--username','TofuRotom','--team-file','teams/team.txt'],{write:value=>output.push(value),replayImporter});
  assert.equal(output.join('').includes('secretpw'),false);
  await runCli(['import','--url',secretUrl,'--username','TofuRotom','--team',id],{write:value=>output.push(value),replayImporter});
  assert.equal(observed.teamId,id);assert.equal(Object.hasOwn(observed,'teamFile'),false);
  await assert.rejects(runCli(['import','--url',secretUrl,'--username','TofuRotom'],{write:()=>{},replayImporter}),/exactly one of --team or --team-file/);
  const failing=async()=>{throw new Error(`Fetch failed for ${secretUrl}`);};
  registerMetricsTools({registerTool(name,settings,handler){registrations.set(name,{settings,handler});}},{workspace:process.cwd(),replayImporter:failing});
  const failure=await registrations.get('team_metrics_import_replays').handler({urls:[secretUrl],username:'TofuRotom',teamFile:'teams/team.txt'});
  assert.equal(failure.isError,true);assert.equal(JSON.stringify(failure).includes('secretpw'),false);
  await assert.rejects(runCli(['import','--url',secretUrl,'--username','TofuRotom','--team-file','teams/team.txt'],{write:()=>{},replayImporter:failing}),error=>!error.message.includes('secretpw')&&error.message.includes('Replay import failed'));
});

test('dashboard filtering agrees with stored reports for moves, Mega use, lead pairs and contaminated parent sets',async t=>{
  const {saveBattle,getTeamReport}=await import('./store.mjs');
  const workspace=await mkdtemp(join(tmpdir(),'team-metrics-filter-'));
  t.after(()=>rm(workspace,{recursive:true,force:true}));
  const p={key:'golisopod:1',species:'Golisopod',selected:true,lead:true,megaEvolved:true,forms:['Golisopod-Mega'],switchIns:1,faints:0,knockouts:1,indirectKnockouts:0,itemRemovals:1,couldNotAct:0,moves:[{move:'Knock Off',uses:3,calledUses:0,failed:0,missed:0,blocked:1,knockouts:1,itemRemovals:1},{move:'Protect',uses:0,calledUses:0,failed:0,missed:0,blocked:0,knockouts:0,itemRemovals:0}]};
  const partner={key:'politoed:2',species:'Politoed',selected:true,lead:true,megaEvolved:false,forms:[],switchIns:1,faints:0,knockouts:0,indirectKnockouts:0,itemRemovals:0,couldNotAct:0,moves:[{move:'Weather Ball',uses:1,calledUses:0,failed:0,missed:0,blocked:0,knockouts:0,itemRemovals:0}]};
  const base={schemaVersion:1,roomId:'battle-test-1',parentId:'game-bestof3-test-1',teamId:id,username:'TofuRotom',ownSide:'p1',outcome:'win',completed:true,turns:4,players:{p1:'TofuRotom',p2:'Example'},opponentRoster:['Archaludon'],selected:['Golisopod','Politoed'],selectionKnown:true,leads:['Golisopod','Politoed'],pokemon:[p,partner],quality:{complete:true,operational:false,warnings:[]},team:{name:'Rain team',format:'gen9championsvgc2026regmc',roster:['Golisopod','Politoed']},metadata:{endedAt:'2026-10-15T00:00:00Z',setResult:{outcome:'win',completed:true}}};
  await saveBattle({workspace,record:base});
  await saveBattle({workspace,record:{...base,roomId:'battle-test-2',parentId:'game-bestof3-test-2',outcome:'loss',opponentRoster:['Charizard'],pokemon:[{...p,megaEvolved:false,itemRemovals:0,moves:[{...p.moves[0],uses:1,itemRemovals:0},p.moves[1]]},partner],metadata:{...base.metadata,setResult:{outcome:'loss',completed:true}}}});
  await saveBattle({workspace,record:{...base,roomId:'battle-test-3',outcome:'loss',quality:{complete:true,operational:true,warnings:['Inactivity observed.']}}});
  const all=await getTeamReport({workspace,teamId:id});
  const expected=await getTeamReport({workspace,teamId:id,opponentSpecies:'Archaludon'});
  const view=aggregateFilteredGames(all,all.games.filter(game=>game.opponentRoster.includes('Archaludon')));
  assert.equal(view.totals.games,1);assert.equal(view.totals.sets.played,0);assert.equal(view.totals.sets.excludedOperational,1);
  for(const field of ['games','wins','losses','ties','unknown','winRate','winRateDenominator'])assert.deepEqual(view.totals[field],expected.totals[field],field);
  for(const field of ['observed','played','wins','losses','ties','unknown','incomplete','excludedOperational','winRate','winRateDenominator'])assert.deepEqual(view.totals.sets[field],expected.totals.sets[field],`sets.${field}`);
  for(const row of expected.pokemon){const actual=view.pokemon.find(p=>p.species===row.species);for(const field of ['selectedGames','selectionDenominator','selectionRate','leadGames','leadDenominator','selectionWinRate','megaGames','megaWins','megaWinRate','megaWinRateDenominator','knockouts','itemRemovals','couldNotAct'])assert.deepEqual(actual[field],row[field],`${row.species}.${field}`);assert.deepEqual(actual.moves,row.moves);}
  assert.deepEqual(view.leadPairs,expected.leadPairs);
  assert.equal(view.pokemon[0].moves.find(move=>move.move==='Protect').uses,0);
  const csv=renderCsv(expected);assert.match(csv,/megaGames,1,/);assert.match(csv,/leadPair/);
  const empty=aggregateFilteredGames(all,[]);assert.equal(empty.totals.games,0);assert.equal(empty.pokemon[0].megaWinRate,null);assert.equal(empty.pokemon[0].moves[0].usagePercent,null);
  // Exercise the exact exported inline script and change handlers, not just its reducer.
  class Element {constructor(){this.children=[];this.textContent='';this.value='';this.handlers={};}append(...children){this.children.push(...children);}replaceChildren(...children){this.children=[...children];}addEventListener(name,handler){this.handlers[name]=handler;}}
  const markup=renderDashboard(all),elements=new Map([...markup.matchAll(/id="([^"]+)"/g)].map(match=>[match[1],new Element()]));
  elements.get('report-data').textContent=JSON.stringify(all);
  const document={getElementById:name=>elements.get(name),createElement:()=>new Element()};
  const script=[...markup.matchAll(/<script>(.*?)<\/script>/gs)].at(-1)[1];
  runInNewContext(script,{document},{timeout:1000});
  assert.equal(elements.get('overview').children[0].children[0].textContent,2);
  const opponentFilter=elements.get('opponent-filter');opponentFilter.value='Archaludon';opponentFilter.handlers.change();
  assert.equal(elements.get('overview').children[0].children[0].textContent,1);
  assert.match(elements.get('game-count').textContent,/1 of 2/);
  assert.match(elements.get('quality').textContent,/Sets excluded from the set win rate: 1/);
});
