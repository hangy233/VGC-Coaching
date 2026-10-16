import {lstat, mkdir, realpath, writeFile} from 'node:fs/promises';
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {replayUrlForGame} from './report-replays.mjs';

const CREDIT = 'https://devoncorp.press/resources/the-release-of-pasrs-7-0';
const html = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const scriptJson = value => JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4,'0')}`);

/** Report links are metadata only; listing never generates a snapshot or touches LRU usage. */
export async function addTeamProfileLinks({workspace,teams}) {
  return Promise.all(teams.map(async team=>{
    if(!/^[a-f0-9]{64}$/.test(team.teamId))return team;
    const path=join(resolve(workspace),'cache','team-metrics','reports','teams',`${team.teamId}.html`);
    let exists=false;
    try{const info=await lstat(path);exists=info.isFile()&&!info.isSymbolicLink();}catch(error){if(error.code!=='ENOENT')throw error;}
    return {...team,stableReportPath:exists?path:null,viewerPath:`/?team=${team.teamId}`};
  }));
}

/** Recompute the displayed sample from included game rows; no excluded records are inferred. */
export function aggregateFilteredGames(source, games) {
  if (!games.every(game => Array.isArray(game.pokemon))) return null;
  const key = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g,'');
  const species = value => typeof value === 'string' ? value : value?.species;
  const rate = (value,total) => total ? value / total * 100 : null;
  const counters = ['switchIns','faints','couldNotAct','knockouts','indirectKnockouts','itemRemovals'];
  const moveCounters = ['uses','calledUses','failed','missed','blocked','knockouts','itemRemovals'];
  const counts = () => ({games:0,wins:0,losses:0,ties:0,unknown:0});
  const add = (row,outcome) => {row.games++;row[{win:'wins',loss:'losses',tie:'ties',unknown:'unknown'}[outcome] || 'unknown']++;};
  const finish = row => ({...row,winRate:rate(row.wins,row.wins+row.losses),winRateDenominator:row.wins+row.losses});
  const selection = {gamesWithSelection:games.filter(game=>game.selectionKnown).length,gamesWithoutSelection:games.filter(game=>!game.selectionKnown).length,gamesWithKnownLeads:games.filter(game=>game.leads?.length).length,gamesWithKnownLeadPairs:0};
  const pokemon = new Map(),opponents = new Map(),leadPairs = new Map(),sets = new Map(),totals = counts();
  const ensurePokemon = (name,template={}) => {
    if(!pokemon.has(key(name)))pokemon.set(key(name),{key:template.key||name,species:name,forms:new Set(),observedGames:0,observedSelectedGames:0,selectedGames:0,selectionDenominator:selection.gamesWithSelection,leadGames:0,leadDenominator:selection.gamesWithKnownLeads,winsWhenSelected:0,lossesWhenSelected:0,tiesWhenSelected:0,unknownWhenSelected:0,megaGames:0,megaWins:0,megaLosses:0,megaTies:0,megaUnknown:0,...Object.fromEntries(counters.map(field=>[field,0])),moves:new Map((template.moves||[]).map(move=>[key(move.move),{move:move.move,...Object.fromEntries(moveCounters.map(field=>[field,0]))}]))});
    return pokemon.get(key(name));
  };
  for(const row of source.pokemon||[])ensurePokemon(row.species,row);
  for(const name of source.team?.roster||[])ensurePokemon(name);
  const knownSets = new Map((source.totals?.sets?.records||[]).map(set=>[set.parentId,set]));
  for(const game of games) {
    add(totals,game.outcome);
    const selected = new Set((game.selected||[]).map(value=>key(species(value))));
    const leads = [...new Map((game.leads||[]).map(value=>[key(species(value)),species(value)])).values()];
    for(const entry of game.pokemon)ensurePokemon(entry.species,entry);
    for(const name of [...(game.selected||[]),...(game.leads||[])].map(species))ensurePokemon(name);
    for(const row of pokemon.values()) {
      const entries=game.pokemon.filter(value=>key(value.species)===key(row.species));
      const isSelected=selected.has(key(row.species))||entries.some(entry=>entry.selected);
      if(isSelected)row.observedSelectedGames++;
      if(isSelected&&game.selectionKnown){row.selectedGames++;row[{win:'winsWhenSelected',loss:'lossesWhenSelected',tie:'tiesWhenSelected',unknown:'unknownWhenSelected'}[game.outcome]||'unknownWhenSelected']++;}
      if(leads.some(value=>key(value)===key(row.species))||entries.some(entry=>entry.lead))row.leadGames++;
      if(entries.some(entry=>entry.selected||entry.moves?.some(move=>move.uses>0||move.calledUses>0)||counters.some(field=>entry[field])))row.observedGames++;
      if(entries.some(entry=>entry.megaEvolved)){row.megaGames++;row[{win:'megaWins',loss:'megaLosses',tie:'megaTies',unknown:'megaUnknown'}[game.outcome]||'megaUnknown']++;}
      for(const entry of entries){
        for(const form of entry.forms||[])row.forms.add(form);
        for(const field of counters)row[field]+=entry[field]||0;
        for(const move of entry.moves||[]) {
          if(!row.moves.has(key(move.move)))row.moves.set(key(move.move),{move:move.move,...Object.fromEntries(moveCounters.map(field=>[field,0]))});
          const result=row.moves.get(key(move.move));for(const field of moveCounters)result[field]+=move[field]||0;
        }
      }
    }
    if(leads.length===2){selection.gamesWithKnownLeadPairs++;leads.sort((a,b)=>key(a).localeCompare(key(b)));const pairKey=leads.map(key).join('|');if(!leadPairs.has(pairKey))leadPairs.set(pairKey,{species:leads,...counts()});add(leadPairs.get(pairKey),game.outcome);}
    for(const name of new Map([...(game.opponentRoster||[]),...(game.opponentSelected||[]),...(game.opponentLeads||[]),...(game.opponentMega||[])].map(value=>[key(species(value)),species(value)])).values()) {if(!opponents.has(key(name)))opponents.set(key(name),{species:name,...counts()});add(opponents.get(key(name)),game.outcome);}
    if(game.parentId){if(!sets.has(game.parentId))sets.set(game.parentId,[]);const result=game.setResult||knownSets.get(game.parentId);if(result?.completed)sets.get(game.parentId).push(result.outcome);}
  }
  const setCounts={observed:sets.size,played:0,wins:0,losses:0,ties:0,unknown:0,incomplete:0,excludedOperational:0,excludedIncomplete:0,records:[]};
  for(const [parentId,results] of sets){
    const known=knownSets.get(parentId),observed=[...new Set(results)],outcome=observed.length===1?observed[0]:'unknown',completed=outcome!=='unknown';
    const operational=Boolean(known?.operational||games.some(game=>game.parentId===parentId&&game.setOperational)),included=!(operational&&!source.filters?.includeOperational)&&known?.included!==false;
    setCounts.records.push({...known,parentId,outcome,completed,operational,included});
    if(!completed)setCounts.incomplete++;
    if(!included){if(operational)setCounts.excludedOperational++;else setCounts.excludedIncomplete++;continue;}
    setCounts.played++;setCounts[{win:'wins',loss:'losses',tie:'ties',unknown:'unknown'}[outcome]||'unknown']++;
  }
  const rows=[...pokemon.values()].map(row=>{const usageDenominator=[...row.moves.values()].reduce((sum,move)=>sum+move.uses,0),selectionWinRateDenominator=row.winsWhenSelected+row.lossesWhenSelected,megaWinRateDenominator=row.megaWins+row.megaLosses;return {...row,forms:[...row.forms],selectionRate:rate(row.selectedGames,row.selectionDenominator),selectionWinRate:rate(row.winsWhenSelected,selectionWinRateDenominator),selectionWinRateDenominator,megaWinRate:rate(row.megaWins,megaWinRateDenominator),megaWinRateDenominator,moves:[...row.moves.values()].map(move=>({...move,usagePercent:rate(move.uses,usageDenominator),usageDenominator})).sort((a,b)=>b.uses-a.uses||a.move.localeCompare(b.move))};});
  return {...source,totals:{...finish(totals),sets:{...setCounts,winRate:rate(setCounts.wins,setCounts.wins+setCounts.losses),winRateDenominator:setCounts.wins+setCounts.losses}},selection,pokemon:rows,leadPairs:[...leadPairs.values()].map(pair=>({...finish(pair),usagePercent:rate(pair.games,selection.gamesWithKnownLeadPairs),usageDenominator:selection.gamesWithKnownLeadPairs})).sort((a,b)=>b.games-a.games||a.species.join('/').localeCompare(b.species.join('/'))),opponents:[...opponents.values()].map(finish).sort((a,b)=>b.games-a.games||a.species.localeCompare(b.species)),games,quality:{...source.quality,includedGames:games.length}};
}

export function renderDashboard(report) {
  if (!report || !Array.isArray(report.pokemon) || !Array.isArray(report.games)) throw new Error('A team metrics report is required.');
  const name = report.team?.name || report.team?.teamId || 'Team metrics';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${html(name)} — team metrics</title><style>
:root{color-scheme:light;--ink:#183235;--muted:#536b6b;--line:#d4e2df;--paper:#f1f6f3;--accent:#176c60}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 system-ui,sans-serif}main{max-width:1280px;margin:auto;padding:32px 22px 64px}h1{font-size:clamp(25px,4vw,39px);line-height:1.15;margin:10px 0}h2{font-size:21px;margin:0 0 15px}h3{font-size:17px;margin:0 0 12px}p{max-width:100ch}.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:.13em;color:var(--accent);font-weight:700}.muted{color:var(--muted)}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:12px;margin:24px 0}.card,section{background:white;border:1px solid var(--line);border-radius:14px;padding:20px}.value{font-size:30px;font-weight:700;line-height:1.2}.label{font-size:13px;color:var(--muted)}section{margin-top:18px}.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);white-space:nowrap}th{font-size:12px;color:var(--muted);background:#f7faf8}tr:last-child td{border-bottom:0}details{border-top:1px solid var(--line);padding:13px 0}summary{cursor:pointer;font-weight:650}label{display:inline-flex;flex-direction:column;gap:5px;font-size:13px;margin:0 14px 14px 0}select,input{font:inherit;padding:8px;border:1px solid #abc2bb;border-radius:7px;background:white;max-width:100%}.note{border-left:3px solid #dfad54;padding-left:14px}.filters{font-size:13px;overflow-wrap:anywhere}a{color:var(--accent)}footer{margin-top:22px;font-size:13px}.pill{display:inline-block;background:#e2f1e9;border-radius:5px;padding:2px 6px;font-size:12px}
</style></head><body><main><div class="eyebrow">Private battle notebook</div><h1>${html(name)}</h1>
<p class="muted">Exact team version <abbr title="${html(report.team?.teamId||'Unknown')}">${html(String(report.team?.teamId||'Unknown').slice(0,12))}</abbr></p>
<p class="muted">Team selection, executed moves, direct knockouts and item removals from your saved battle records.</p>
<section><h2>Explore included games</h2><p id="filter-help" class="muted">Filters update every summary and table below using the included game records.</p><label>Opponent species<select id="opponent-filter"><option value="">All opponent species</option></select></label><label>Outcome<select id="outcome-filter"><option value="">All outcomes</option><option>win</option><option>loss</option><option>tie</option><option>unknown</option></select></label></section>
<div id="overview" class="cards"></div><p id="quality" class="note"></p><p id="report-filters" class="filters muted"></p>
<section><h2>Pokémon</h2><div id="pokemon" class="scroll"></div></section>
<section><h2>Lead pairs</h2><p class="muted">Only games with two distinct observed leads contribute. Pair order is ignored.</p><div id="lead-pairs" class="scroll"></div></section>
<section><h2>Moves by Pokémon</h2><p class="muted">Uses count executed move announcements, including moves that fail, miss or are blocked. Those outcome counts can overlap and must not be added to uses. Direct KOs and attributed indirect KOs are separate. Item removals count observed removals, including Knock Off.</p><div id="moves"></div></section>
<section><h2>Opponent matchups</h2><p class="muted">An opponent species can appear in several games. These rows describe observed matchups, not causal strength.</p><div id="opponents" class="scroll"></div></section>
<section><h2>Games</h2><p id="game-count" class="muted"></p><div id="games" class="scroll"></div></section>
<footer>Inspired by <a href="${CREDIT}" target="_blank" rel="noopener noreferrer">PASRS 7.0</a>. Viewing this local report never uploads replays or searches for battles. Replay links open separately; the report loads no network assets. Win rates use wins ÷ (wins + losses); ties and unknown outcomes are shown separately. Small samples are descriptive.</footer>
</main><script type="application/json" id="report-data">${scriptJson(report)}</script><script>
const report=JSON.parse(document.getElementById('report-data').textContent);
const text=(tag,value,cls)=>{const e=document.createElement(tag);e.textContent=value??'—';if(cls)e.className=cls;return e};
const pct=value=>typeof value==='number'?value.toFixed(1)+'%':'—';
const count=value=>typeof value==='number'?value:0;
const table=(headers,rows)=>{const t=document.createElement('table'),head=document.createElement('thead'),hr=document.createElement('tr');headers.forEach(h=>hr.append(text('th',h)));head.append(hr);t.append(head);const b=document.createElement('tbody');rows.forEach(row=>{const tr=document.createElement('tr');row.forEach(v=>{const td=text('td','');if(v?.nodeType===1)td.append(v);else td.textContent=v??'—';tr.append(td)});b.append(tr)});if(!rows.length){const tr=document.createElement('tr'),td=text('td','No records for these filters.');td.colSpan=headers.length;tr.append(td);b.append(tr)}t.append(b);return t};
const aggregateFilteredGames=${aggregateFilteredGames.toString()};
const replayUrlForGame=${replayUrlForGame.toString()};
const replayLink=game=>{const url=replayUrlForGame(game);if(!url)return 'Not saved';const link=text('a','Watch replay');link.href=url;link.target='_blank';link.rel='noreferrer noopener';return link};
const opposingSpecies=g=>[...(g.opponentRoster||[]),...(g.opponentSelected||[]),...(g.opponentLeads||[]),...(g.opponentMega||[])].map(p=>typeof p==='string'?p:p.species);
const species=[...new Set(report.games.flatMap(opposingSpecies).filter(Boolean))].sort();const select=document.getElementById('opponent-filter');species.forEach(s=>{const option=text('option',s);option.value=s;select.append(option)});
const names=value=>(value||[]).map(p=>typeof p==='string'?p:p.species||p.name||'?').join(', ');
const canAggregate=report.games.every(game=>Array.isArray(game.pokemon));
if(!canAggregate)document.getElementById('filter-help').textContent='This older export lacks per-game metrics. Filters update the game table only; regenerate the export for aggregate filtering.';
const render=()=>{
  const opponent=select.value,outcome=document.getElementById('outcome-filter').value;
  const rows=report.games.filter(g=>(!outcome||g.outcome===outcome)&&(!opponent||opposingSpecies(g).includes(opponent)));
  const view=(opponent||outcome)&&canAggregate?aggregateFilteredGames(report,rows):report;
  const totals=view.totals||{},quality=report.quality||{};
  document.getElementById('overview').replaceChildren();
  [['Games',totals.games],['Record (W–L–T)',count(totals.wins)+'–'+count(totals.losses)+'–'+count(totals.ties)],['Game win rate',pct(totals.winRate)],['Eligible / observed sets',count(totals.sets?.played)+' / '+count(totals.sets?.observed??totals.sets?.played)],['Set win rate',pct(totals.sets?.winRate)]].forEach(([label,value])=>{const c=document.createElement('div');c.className='card';c.append(text('div',value??'—','value'),text('div',label,'label'));document.getElementById('overview').append(c)});
  document.getElementById('quality').textContent='Games shown: '+count(totals.games)+' of '+count(quality.storedGames)+' recorded. Base exclusions: '+count(quality.excludedIncomplete)+' incomplete; '+count(quality.excludedOperational)+' with client or timer issues. Sets excluded from the set win rate: '+count(totals.sets?.excludedOperational)+'. Games with known selections: '+count(view.selection?.gamesWithSelection)+'. '+[...(quality.warnings||[]).filter(w=>!w.startsWith('Ledger flags')),...(report.refresh?.warnings||[])].join(' ');
  const filterLabels=[opponent||report.filters?.opponentSpecies||'All opponent species',outcome||report.filters?.outcome||'All outcomes'];
  if(report.filters?.selectedSpecies)filterLabels.push('Selected: '+report.filters.selectedSpecies);
  if(report.filters?.from)filterLabels.push('From '+report.filters.from.slice(0,10));
  if(report.filters?.to)filterLabels.push('Through '+report.filters.to.slice(0,10));
  filterLabels.push(report.filters?.includeOperational?'Client and timer issues included':'Client and timer issues excluded');
  document.getElementById('report-filters').textContent=filterLabels.join(' · ');
  document.getElementById('pokemon').replaceChildren(table(['Pokémon','Selected / known games','Selection','Led / known lead games','Win rate when selected','Mega games','Mega win rate','Direct KOs','Indirect KOs','Faints','Unable to act','Items removed'],view.pokemon.map(p=>[p.species,p.selectedGames+' / '+p.selectionDenominator,pct(p.selectionRate),p.leadGames+' / '+p.leadDenominator,pct(p.selectionWinRate),p.megaGames??0,pct(p.megaWinRate),p.knockouts,p.indirectKnockouts,p.faints,p.couldNotAct??'—',p.itemRemovals])));
  document.getElementById('lead-pairs').replaceChildren(table(['Lead pair','Games','W','L','T','Unknown','Win rate'],(view.leadPairs||[]).map(pair=>[names(pair.species||pair.pokemon),pair.games,pair.wins,pair.losses,pair.ties,pair.unknown,pct(pair.winRate)])));
  document.getElementById('moves').replaceChildren();
  view.pokemon.forEach(p=>{const d=document.createElement('details');d.open=true;d.append(text('summary',p.species));const s=document.createElement('div');s.className='scroll';s.append(table(['Move','Uses','Called uses','Use share','Failed','Missed','Blocked','Direct KOs','Items removed'],(p.moves||[]).map(m=>[m.move,m.uses,m.calledUses??'—',pct(m.usagePercent),m.failed,m.missed,m.blocked,m.knockouts,m.itemRemovals])));d.append(s);document.getElementById('moves').append(d)});
  document.getElementById('opponents').replaceChildren(table(['Opponent species','Games','W','L','T','Unknown','Win rate'],(view.opponents||[]).map(p=>[p.species,p.games,p.wins,p.losses,p.ties,p.unknown,pct(p.winRate)])));
  document.getElementById('game-count').textContent=rows.length+' of '+report.games.length+' included games shown.';
  document.getElementById('games').replaceChildren(table(['Battle','Replay','Date','Opponent','Result','Selected','Leads','Mega evolved','Turns','Quality'],rows.map(g=>[g.roomId,replayLink(g),g.playedAt||'Unknown',g.opponent||'Unknown',g.outcome,names(g.selected),names(g.leads),names((g.pokemon||[]).filter(p=>p.megaEvolved)),g.turns??'—',g.quality?.operational?'Operational':g.completed?'Completed':'Incomplete'])));
};
select.addEventListener('change',render);document.getElementById('outcome-filter').addEventListener('change',render);render();
</script></body></html>`;
}

export function csvCell(value) {
  let result = value == null ? '' : String(value);
  if (typeof value === 'string' && (/^[\s]*[=+@-]/.test(result) || /^[\t\r\n]/.test(result))) result = `'${result}`;
  return /[",\r\n]/.test(result) ? `"${result.replace(/"/g,'""')}"` : result;
}

export function renderCsv(report) {
  const columns = ['section','teamId','team','pokemon','move','opponent','roomId','parentId','outcome','metric','value','denominator','replayUrl'];
  const rows = [columns];
  const add = (section,fields,metric,value,denominator) => rows.push(columns.map(key => ({section,teamId:report.team?.teamId,team:report.team?.name,...fields,metric,value,denominator})[key]));
  for (const key of ['games','wins','losses','ties','unknown','winRate']) add('summary',{},key,report.totals?.[key],key==='winRate'?report.totals?.winRateDenominator:undefined);
  for (const key of ['observed','played','wins','losses','ties','unknown','incomplete','excludedOperational','excludedIncomplete','winRate','winRateDenominator']) add('sets',{},key,report.totals?.sets?.[key],key==='winRate'?report.totals.sets.winRateDenominator:undefined);
  for (const set of report.totals?.sets?.records||[]) for(const metric of ['completed','operational','included'])add('set',{parentId:set.parentId,outcome:set.outcome},metric,set[metric]);
  for (const key of ['storedGames','includedGames','excludedIncomplete','excludedOperational']) add('quality',{},key,report.quality?.[key]);
  for (const p of report.pokemon||[]) {
    for (const key of ['selectedGames','observedSelectedGames','selectionRate','leadGames','selectionWinRate','megaGames','megaWins','megaLosses','megaTies','megaUnknown','megaWinRate','switchIns','faints','couldNotAct','knockouts','indirectKnockouts','itemRemovals']) add('pokemon',{pokemon:p.species},key,p[key],key==='selectionRate'?p.selectionDenominator:key==='selectionWinRate'?p.selectionWinRateDenominator:key==='megaWinRate'?p.megaWinRateDenominator:key==='leadGames'?p.leadDenominator:undefined);
    for (const m of p.moves||[]) for (const key of ['uses','calledUses','usagePercent','failed','missed','blocked','knockouts','itemRemovals']) add('move',{pokemon:p.species,move:m.move},key,m[key],key==='usagePercent'?m.usageDenominator:undefined);
  }
  for (const p of report.opponents||[]) for (const key of ['games','wins','losses','ties','unknown','winRate']) add('opponent',{opponent:p.species},key,p[key],key==='winRate'?p.winRateDenominator:undefined);
  for (const pair of report.leadPairs||[])for(const key of ['games','wins','losses','ties','unknown','winRate'])add('leadPair',{pokemon:(pair.species||pair.pokemon||[]).join(' + ')},key,pair[key],key==='winRate'?pair.winRateDenominator:undefined);
  for (const g of report.games||[]) { const fields={roomId:g.roomId,parentId:g.parentId,outcome:g.outcome,opponent:g.opponent,replayUrl:replayUrlForGame(g)};add('game',fields,'selected',(g.selected||[]).map(p=>typeof p==='string'?p:p.species).join('; '));add('game',fields,'selectionKnown',g.selectionKnown); }
  for (const [key,value] of Object.entries(report.filters||{}))add('filter',{},key,value);
  for (const warning of [...(report.quality?.warnings||[]),...(report.refresh?.warnings||[])])add('warning',{},'warning',warning);
  return rows.map(row => row.map(csvCell).join(',')).join('\r\n')+'\r\n';
}

function within(root,path) { const rel=relative(root,path);return !isAbsolute(rel)&&rel!=='..'&&!rel.startsWith(`..${sep}`); }

/** Create only dedicated report directories, refusing symbolic links/junctions. */
export async function exportReport({workspace,report,format='html',output}) {
  if (!['html','csv','json'].includes(format)) throw new Error('Export format must be html, csv or json.');
  const root=await realpath(resolve(workspace));
  let dir=root;
  for (const part of ['cache','team-metrics','reports']) {
    dir=join(dir,part);
    try { await mkdir(dir); } catch (error) { if(error.code!=='EEXIST') throw error; }
    const stat=await lstat(dir);
    if (!stat.isDirectory()||stat.isSymbolicLink()||!within(root,await realpath(dir))) throw new Error('Reports directory must stay inside the workspace without symbolic links.');
  }
  const defaultName=`team-${String(report.team?.teamId||'report').slice(0,12)}-${new Date().toISOString().replace(/[:.]/g,'-')}.${format}`;
  const supplied=output||defaultName;
  const file=isAbsolute(supplied)?resolve(supplied):join(dir,supplied);
  if (dirname(file)!==dir || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,179}$/.test(basename(file)) || basename(file).startsWith('.') || !file.endsWith(`.${format}`)) throw new Error(`Use a safe .${format} filename directly in cache/team-metrics/reports.`);
  const content=format==='html'?renderDashboard(report):format==='csv'?renderCsv(report):JSON.stringify(report,null,2)+'\n';
  await writeFile(file,content,{encoding:'utf8',flag:'wx'});
  return {path:file,format,bytes:Buffer.byteLength(content),games:report.totals?.games??0};
}
