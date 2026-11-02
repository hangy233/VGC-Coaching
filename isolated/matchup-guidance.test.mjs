import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {lstatSync,readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadMaintainedMatchupGuidance,prepareMatchupGuidance,verifyMatchupGuidance,renderMatchupGuidance} from './matchup-guidance.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const version='fixture.112';
function nativeRead(contents={
  'SKILL.md':`---\nname: champions-mc-matchups\n---\nCycle revision: **${version}**.\nA full main instruction.\n`,
  'references/headless-battle-cycle.md':'A complete cycle instruction.\n',
  'references/é/paired.md':'A full Unicode-path paired instruction without a trailing newline',
}) {
  const filesRead=Object.entries(contents).map(([path,content])=>({path,sha256:hash(content),content}));
  const rows=new Map();
  for(const file of filesRead){
    const parts=file.path.split('/');
    for(let index=1;index<parts.length;index++) rows.set(parts.slice(0,index).join('/'),['directory','']);
    rows.set(file.path,['file',file.sha256]);
  }
  const source=createHash('sha256');
  for(const path of [...rows.keys()].sort()) {const [type,digest]=rows.get(path);source.update(`${type}:${Buffer.byteLength(path)}:${path}:${digest}\n`);}
  const sha256=source.digest('hex');
  return {skill:'champions-mc-matchups',synchronized:true,sourceSha256:sha256,installedSha256:sha256,files:filesRead.length,filesRead,differences:[],readReceipt:'secret-control-receipt',target:'private-installed-directory'};
}
const expected=guidance=>({skillVersion:version,skillSha256:guidance.sourceSha256});
const fails=(code,operation)=>assert.throws(operation,{code:`MATCHUP_GUIDANCE_${code}`});

test('prepares an immutable complete folder and renders every exact file once',()=>{
  const native=nativeRead(), bundle=prepareMatchupGuidance(native,expected(native));
  assert.deepEqual(Object.keys(bundle),['version','sha256','files']);
  assert.equal(bundle.version,version); assert.equal(bundle.sha256,native.sourceSha256);
  assert.deepEqual(bundle.files.map(file=>file.path),native.filesRead.map(file=>file.path).sort());
  assert.ok(Object.isFrozen(bundle) && Object.isFrozen(bundle.files) && bundle.files.every(Object.isFrozen));
  const rendered=renderMatchupGuidance(bundle);
  for(const file of native.filesRead){
    assert.equal(rendered.split(file.content).length-1,1);
    assert.ok(rendered.includes(`\n${file.content}\n--- END SKILL FILE ${file.path} ---`));
  }
  assert.match(rendered,/Use champions-mc-matchups as the battle matchup skill/u);
  assert.match(rendered,/resolve skill-relative references/u);
  assert.match(rendered,/runtime host handles battle lifecycle/u);
  assert.match(rendered,/provided native research contracts/u);
  assert.ok(!rendered.includes(native.readReceipt) && !rendered.includes(native.target));
  assert.equal(renderMatchupGuidance(bundle),rendered);
  native.filesRead[0].content='mutated outside prepared bundle';
  assert.equal(renderMatchupGuidance(bundle),rendered);
  assert.throws(()=>{bundle.files[0].content='mutation';},TypeError);
});

test('verifies deserialized bundles, binds expected pins and rejects tampering',()=>{
  const native=nativeRead(), pins=expected(native), bundle=prepareMatchupGuidance(native,pins);
  assert.equal(verifyMatchupGuidance(bundle,pins),bundle);
  const clone=structuredClone(bundle);
  fails('UNVERIFIED',()=>renderMatchupGuidance(clone));
  assert.deepEqual(verifyMatchupGuidance(clone,pins),bundle);
  assert.deepEqual(prepareMatchupGuidance(clone,pins),bundle);
  fails('METADATA',()=>verifyMatchupGuidance(bundle,{...pins,skillSha256:'f'.repeat(64)}));
  fails('METADATA',()=>verifyMatchupGuidance(bundle,{...pins,skillVersion:'other'}));
  clone.files[0].content+='damaged';
  fails('FILE_HASH',()=>verifyMatchupGuidance(clone,pins));
  fails('PINS',()=>prepareMatchupGuidance(native,{}));
});

test('native metadata must prove exact synchronization and declared completeness',()=>{
  for(const mutate of [
    value=>{value.skill='other-skill';}, value=>{value.synchronized=false;},
    value=>{value.sourceSha256='f'.repeat(64);}, value=>{value.installedSha256='e'.repeat(64);},
    value=>{value.differences=[{path:'SKILL.md',status:'changed'}];},
  ]) {const native=nativeRead(), pins=expected(native);mutate(native);fails('METADATA',()=>prepareMatchupGuidance(native,pins));}
  for(const mutate of [value=>{value.files++;},value=>{value.filesRead.pop();},value=>{delete value.files;}]){
    const native=nativeRead(), pins=expected(native);mutate(native);fails('SHAPE',()=>prepareMatchupGuidance(native,pins));
  }
});

test('file hash and complete folder hash independently reject missing or changed facts',()=>{
  const native=nativeRead(), pins=expected(native);
  native.filesRead[2].content+='unverified';
  fails('FILE_HASH',()=>prepareMatchupGuidance(native,pins));
  native.filesRead[2].sha256=hash(native.filesRead[2].content);
  fails('FOLDER_HASH',()=>prepareMatchupGuidance(native,pins));
  const missing=nativeRead(), missingPins=expected(missing);
  missing.filesRead.pop();missing.files--;
  fails('FOLDER_HASH',()=>prepareMatchupGuidance(missing,missingPins));
  const extra=nativeRead(), extraPins=expected(extra);
  extra.filesRead.push({path:'extra.md',content:'extra',sha256:hash('extra')});extra.files++;
  fails('FOLDER_HASH',()=>prepareMatchupGuidance(extra,extraPins));
});

test('required skill/cycle and exact Cycle revision are mandatory',()=>{
  const noCycle=nativeRead({'SKILL.md':`Cycle revision: **${version}**.`});
  fails('SHAPE',()=>prepareMatchupGuidance(noCycle,expected(noCycle)));
  for(const main of ['No cycle revision.', 'Cycle revision: **different**.',`Cycle revision: **${version}**.\nCycle revision: **${version}**.`]){
    const native=nativeRead({'SKILL.md':main,'references/headless-battle-cycle.md':'cycle'});
    fails('VERSION',()=>prepareMatchupGuidance(native,expected(native)));
  }
});

test('unsafe, ambiguous and colliding paths are rejected before rendering',()=>{
  for(const path of ['/absolute.md','../escape.md','a/../escape.md','a/./x.md','a//x.md','C:/x.md','a\\x.md','a\nx.md','a./x.md','a /x.md','a.md/']){
    const native=nativeRead(), pins=expected(native);native.filesRead[2].path=path;
    fails('PATH',()=>prepareMatchupGuidance(native,pins));
  }
  for(const path of ['SKILL.md','skill.md','references','references/HEADLESS-BATTLE-CYCLE.md']){
    const native=nativeRead(), pins=expected(native);native.filesRead.push({...native.filesRead[2],path});native.files++;
    fails('PATH',()=>prepareMatchupGuidance(native,pins));
  }
});

test('text and native reading bounds fail closed',()=>{
  for(const content of ['a\0b','a\ud800b']){
    const native=nativeRead(), pins=expected(native);native.filesRead[2]={...native.filesRead[2],content,sha256:hash(content)};
    fails('CONTENT',()=>prepareMatchupGuidance(native,pins));
  }
  const large=nativeRead(), pins=expected(large), content='a'.repeat(1024*1024+1);
  large.filesRead[2]={...large.filesRead[2],content,sha256:hash(content)};
  fails('LIMIT',()=>prepareMatchupGuidance(large,pins));
  const many=nativeRead();many.filesRead=Array.from({length:513},()=>many.filesRead[0]);many.files=513;
  fails('LIMIT',()=>prepareMatchupGuidance(many,expected(many)));
  const aggregate=nativeRead(), aggregatePins=expected(aggregate);
  const chunk='a'.repeat(1024*1024), chunkHash=hash(chunk);
  aggregate.filesRead.push(...Array.from({length:9},(_,index)=>({path:`large-${index}.md`,content:chunk,sha256:chunkHash})));
  aggregate.files=aggregate.filesRead.length;
  fails('LIMIT',()=>prepareMatchupGuidance(aggregate,aggregatePins));
});

test('local offline preparation matches the maintained complete-folder algorithm and caches immutable content',()=>{
  const root=fileURLToPath(new URL('../skills/champions-mc-matchups/',import.meta.url)), rows=[], actual=[];
  const visit=(directory,prefix='')=>{
    for(const name of readdirSync(directory).sort()){
      const path=prefix?`${prefix}/${name}`:name, absolute=join(directory,name), info=lstatSync(absolute);
      assert.ok(!info.isSymbolicLink());
      if(info.isDirectory()){rows.push([path,'directory','']);visit(absolute,path);}
      else {const content=readFileSync(absolute,'utf8'), sha256=hash(readFileSync(absolute));rows.push([path,'file',sha256]);actual.push({path,sha256,content});}
    }
  };
  visit(root);
  const source=createHash('sha256');
  for(const [path,type,sha256] of rows.sort(([left],[right])=>left<right?-1:left>right?1:0))source.update(`${type}:${Buffer.byteLength(path)}:${path}:${sha256}\n`);
  const skillVersion=/Cycle revision:\s*\*\*([^*]+)\*\*/u.exec(actual.find(file=>file.path==='SKILL.md').content)[1];
  const pins={skillVersion,skillSha256:source.digest('hex')};
  const bundle=loadMaintainedMatchupGuidance(pins);
  assert.deepEqual(bundle.files,actual.sort((left,right)=>left.path<right.path?-1:left.path>right.path?1:0));
  assert.equal(loadMaintainedMatchupGuidance(pins),bundle);
  assert.ok(renderMatchupGuidance(bundle).includes(actual.find(file=>file.path==='SKILL.md').content));
  fails('FOLDER_HASH',()=>loadMaintainedMatchupGuidance({...pins,skillSha256:'0'.repeat(64)}));
});
