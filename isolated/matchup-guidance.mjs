import {createHash} from 'node:crypto';
import {lstatSync,readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

const SKILL = 'champions-mc-matchups';
const MAX_ENTRIES = 512;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/u;
const maintainedRoot = fileURLToPath(new URL('../skills/champions-mc-matchups/',import.meta.url));
const verifiedBundles = new WeakSet();
const renderedBundles = new WeakMap();
const maintainedCache = new Map();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = value => createHash('sha256').update(value).digest('hex');

export class MatchupGuidanceError extends Error {
  constructor(code,message) { super(message); this.name='MatchupGuidanceError'; this.code=`MATCHUP_GUIDANCE_${code}`; }
}
function check(condition,code,message) { if (!condition) throw new MatchupGuidanceError(code,message); }
function pins({skillVersion,skillSha256} = {}) {
  check(typeof skillVersion === 'string' && skillVersion.length > 0 && skillVersion.length <= 128 && skillVersion.trim() === skillVersion && !/[\u0000-\u001f\u007f]/u.test(skillVersion),'PINS','An explicit bounded skill version is required');
  check(typeof skillSha256 === 'string' && HASH.test(skillSha256),'PINS','An explicit lowercase SHA-256 skill source pin is required');
  return {skillVersion,skillSha256};
}
function safePath(path) {
  check(typeof path === 'string' && path.length > 0 && Buffer.byteLength(path) <= 4096 && !/[\\:\u0000-\u001f\u007f]/u.test(path),'PATH','Skill paths must be safe relative POSIX paths');
  const parts=path.split('/');
  check(parts.every(part => part && part !== '.' && part !== '..' && !/[. ]$/u.test(part)),'PATH','Skill paths cannot be absolute, empty or traverse directories');
  check(Buffer.from(path,'utf8').toString('utf8') === path,'PATH','Skill paths must contain well-formed Unicode');
  return parts;
}
// This is the maintained sync service's exact complete-folder digest. Parent
// directories are reconstructed because native filesRead contains only files.
function folderDigest(entries) {
  const hash=createHash('sha256');
  for (const [path,{type,sha256:hashValue}] of [...entries].sort(([left],[right]) => left < right ? -1 : left > right ? 1 : 0)) {
    hash.update(`${type}:${Buffer.byteLength(path)}:${path}:${hashValue || ''}\n`);
  }
  return hash.digest('hex');
}
function validateFiles(files,{skillVersion,skillSha256}) {
  check(Array.isArray(files) && files.length > 0 && files.length <= MAX_ENTRIES,'LIMIT','A bounded complete skill file list is required');
  const entries=new Map(), portablePaths=new Map(), copied=[];
  let totalBytes=0;
  const add=(path,type,hashValue='') => {
    const prior=entries.get(path), portable=path.toLowerCase();
    check(!portablePaths.has(portable) || portablePaths.get(portable) === path,'PATH','Skill paths cannot differ only by case');
    check(!prior || (type === 'directory' && prior.type === 'directory'),'PATH','Skill paths must be unique and cannot conflict with directories');
    if (!prior) { entries.set(path,{type,sha256:hashValue}); portablePaths.set(portable,path); }
    check(entries.size <= MAX_ENTRIES,'LIMIT','Skill folder exceeds its complete entry limit');
  };
  for (const file of files) {
    check(object(file),'SHAPE','Each skill file must contain a path, hash and exact text');
    const {path,sha256:hashValue,content}=file, parts=safePath(path);
    check(typeof hashValue === 'string' && HASH.test(hashValue),'FILE_HASH','Every skill file requires its exact lowercase SHA-256');
    check(typeof content === 'string' && !content.includes('\0') && Buffer.from(content,'utf8').toString('utf8') === content,'CONTENT','Skill files must contain exact well-formed text without NUL bytes');
    const size=Buffer.byteLength(content);
    totalBytes+=size;
    check(size <= MAX_FILE_BYTES && totalBytes <= MAX_TOTAL_BYTES,'LIMIT','Skill text exceeds the bounded native reading limit');
    check(sha256(content) === hashValue,'FILE_HASH',`Skill file content differs from its SHA-256: ${path}`);
    for (let index=1;index<parts.length;index++) add(parts.slice(0,index).join('/'),'directory');
    add(path,'file',hashValue);
    copied.push(Object.freeze({path,sha256:hashValue,content}));
  }
  check(entries.get('SKILL.md')?.type === 'file' && entries.get('references/headless-battle-cycle.md')?.type === 'file','SHAPE','The complete matchup skill and required BO3 cycle must be included');
  check(folderDigest(entries) === skillSha256,'FOLDER_HASH','Skill files do not reproduce the complete pinned folder digest');
  const main=copied.find(file => file.path === 'SKILL.md').content;
  const versions=[...main.matchAll(/Cycle revision:\s*\*\*([^*]+)\*\*/gu)].map(match => match[1]);
  check(versions.length === 1 && versions[0] === skillVersion,'VERSION','Skill Cycle revision differs from the expected version');
  return Object.freeze(copied.sort((left,right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}
function prepareFiles(files,expected) {
  const bundle=Object.freeze({version:expected.skillVersion,sha256:expected.skillSha256,files:validateFiles(files,expected)});
  verifiedBundles.add(bundle);
  return bundle;
}

/** Verify content and expected pins after a bundle crosses a serialization boundary. */
export function verifyMatchupGuidance(bundle,expectedPins) {
  const expected=pins(expectedPins);
  check(object(bundle) && bundle.version === expected.skillVersion && bundle.sha256 === expected.skillSha256,'METADATA','Matchup bundle differs from the expected version or source hash');
  if (verifiedBundles.has(bundle)) return bundle;
  return prepareFiles(bundle.files,expected);
}

/** Strip receipt/control metadata and retain only the verified complete skill. */
export function prepareMatchupGuidance(guidance,expectedPins) {
  const expected=pins(expectedPins);
  check(object(guidance),'SHAPE','A complete native skill read or verified bundle is required');
  if (!Object.hasOwn(guidance,'filesRead') && Array.isArray(guidance.files)) return verifyMatchupGuidance(guidance,expected);
  check(guidance.skill === SKILL && guidance.synchronized === true && guidance.sourceSha256 === expected.skillSha256 && guidance.installedSha256 === expected.skillSha256,'METADATA','Native matchup guidance must be synchronized to the expected source hash');
  check(Array.isArray(guidance.filesRead) && Number.isInteger(guidance.files) && guidance.files === guidance.filesRead.length,'SHAPE','Native skill read must include every declared file exactly once');
  check(guidance.differences === undefined || (Array.isArray(guidance.differences) && guidance.differences.length === 0),'METADATA','Native matchup guidance reports unresolved installed differences');
  return prepareFiles(guidance.filesRead,expected);
}

/** No filesystem work or rehashing occurs when rendering a prepared bundle. */
export function renderMatchupGuidance(bundle) {
  check(object(bundle) && verifiedBundles.has(bundle),'UNVERIFIED','Prepare or verify the matchup bundle before rendering it');
  if (renderedBundles.has(bundle)) return renderedBundles.get(bundle);
  const text=[
    `Use ${SKILL} as the battle matchup skill.`,
    'The complete verified skill folder is inline below, unabridged. Read and apply all of it; resolve skill-relative references using the labeled files in this bundle. Do not attempt to load skill files or discover another copy.',
    'The runtime host handles battle lifecycle, authorization, clocks, research execution, review persistence, installation and shutdown. Apply the skill through the supplied decision interface; use the provided native research contracts for required or model-detected research. Do not attempt host lifecycle actions or call unavailable tools.',
    `Skill version: ${bundle.version}\nComplete folder SHA-256: ${bundle.sha256}\nFiles: ${bundle.files.length}`,
    ...bundle.files.map(file => `--- BEGIN SKILL FILE ${file.path} SHA256 ${file.sha256} ---\n${file.content}\n--- END SKILL FILE ${file.path} ---`),
    '--- END COMPLETE MATCHUP SKILL BUNDLE ---',
  ].join('\n\n');
  renderedBundles.set(bundle,text);
  return text;
}

/**
 * Offline-fixture/preparation fallback, never a timed file lookup. The caller's
 * ordinary preflight still verifies current source freshness before live use.
 */
export function loadMaintainedMatchupGuidance(expectedPins) {
  const expected=pins(expectedPins), key=`${expected.skillVersion}:${expected.skillSha256}`;
  if (maintainedCache.has(key)) return maintainedCache.get(key);
  const files=[], entries=new Map();
  let totalBytes=0;
  const rootInfo=lstatSync(maintainedRoot);
  check(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(),'FILESYSTEM','Maintained matchup skill root must be an unlinked directory');
  const visit=(directory,prefix='') => {
    for (const name of readdirSync(directory).sort()) {
      const path=prefix ? `${prefix}/${name}` : name, absolute=join(directory,name), info=lstatSync(absolute);
      safePath(path);
      check(entries.size < MAX_ENTRIES && !info.isSymbolicLink(),'FILESYSTEM','Maintained skill cannot contain links or exceed its entry limit');
      if (info.isDirectory()) { entries.set(path,{type:'directory'}); visit(absolute,path); }
      else {
        check(info.isFile(),'FILESYSTEM','Maintained skill must contain regular files only');
        check(info.size <= MAX_FILE_BYTES && totalBytes + info.size <= MAX_TOTAL_BYTES,'LIMIT','Maintained skill exceeds the bounded native reading limit');
        const bytes=readFileSync(absolute); totalBytes+=bytes.length;
        check(bytes.length <= MAX_FILE_BYTES && totalBytes <= MAX_TOTAL_BYTES,'LIMIT','Maintained skill grew beyond its bounded reading limit');
        const hashValue=sha256(bytes);
        entries.set(path,{type:'file',sha256:hashValue});
        files.push({path,sha256:hashValue,content:bytes.toString('utf8')});
      }
    }
  };
  visit(maintainedRoot);
  check(folderDigest(entries) === expected.skillSha256,'FOLDER_HASH','Maintained skill differs from the expected complete folder digest');
  const bundle=prepareFiles(files,expected);
  while (maintainedCache.size >= 8) maintainedCache.delete(maintainedCache.keys().next().value);
  maintainedCache.set(key,bundle);
  return bundle;
}
