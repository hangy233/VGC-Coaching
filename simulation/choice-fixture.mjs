// Deterministic synthetic native-engine fixtures for offline integration only.
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const {Teams}=createRequire(import.meta.url)('pokemon-showdown');
export const choiceFixtureSet=(name,species,ability,item,moves,evs={hp:32,atk:0,def:0,spa:32,spd:2,spe:0})=>({name,species,ability,item,moves,evs,nature:'Modest',level:50,ivs:{hp:31,atk:31,def:31,spa:31,spd:31,spe:31}});
export function choiceFixtureTeams(){const set=choiceFixtureSet;return {
  p1:[
    set('toed','Politoed','Drizzle','Leftovers',['Weather Ball','Muddy Water','Ice Beam','Protect']),
    set('fari','Farigiraf','Armor Tail','Grassy Seed',['Psychic','Helping Hand','Trick Room','Protect']),
    set('gol','Golisopod','Emergency Exit','Golisopite',['Sucker Punch','Iron Head','Leech Life','Protect'],{hp:32,atk:32,def:0,spa:0,spd:2,spe:0}),
    set('arch','Archaludon','Stamina','Choice Scarf',['Dragon Pulse','Flash Cannon','Aura Sphere','Electro Shot'],{hp:0,atk:0,def:0,spa:32,spd:2,spe:32}),
    set('sylv','Sylveon','Pixilate','Fairy Feather',['Hyper Voice','Quick Attack','Mystical Fire','Protect']),
    set('rilla','Rillaboom','Grassy Surge','Miracle Seed',['Wood Hammer','High Horsepower','Grassy Glide','Protect'],{hp:32,atk:32,def:2,spa:0,spd:0,spe:0}),
  ],p2:[
    set('rai','Raichu','Lightning Rod','Raichunite Y',['Zap Cannon','Focus Blast','Fake Out','Protect'],{hp:2,atk:0,def:0,spa:32,spd:0,spe:32}),
    set('foe-fari','Farigiraf','Armor Tail','Sitrus Berry',['Psychic','Helping Hand','Trick Room','Protect']),
    set('foe-toed','Politoed','Drizzle','Expert Belt',['Weather Ball','Muddy Water','Ice Beam','Protect']),
    set('foe-sylv','Sylveon','Pixilate','Fairy Feather',['Hyper Voice','Quick Attack','Mystical Fire','Protect']),
    set('foe-rilla','Rillaboom','Grassy Surge','Miracle Seed',['Wood Hammer','High Horsepower','Grassy Glide','Protect'],{hp:32,atk:32,def:2,spa:0,spd:0,spe:0}),
    set('volc','Volcarona','Flame Body','Leftovers',['Heat Wave','Quiver Dance','Giga Drain','Protect']),
  ],
};}
export function choiceFixtureRegistration(team=choiceFixtureTeams().p1){
  const teamText=Teams.export(team),teamId=createHash('sha256').update(Teams.pack(Teams.import(teamText))).digest('hex');return {teamText,teamId};
}
export function choiceFixtureSheet(team=choiceFixtureTeams().p2){return team.map(p=>({species:p.species,ability:p.ability,item:p.item,moves:[...p.moves],nature:p.nature,level:p.level}));}
