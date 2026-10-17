import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const service = new URL('../workflow/skill-service.mjs', import.meta.url).href;
const script = fileURLToPath(new URL('../skills/champions-mc-matchups/scripts/sync-skill.mjs', import.meta.url));
const skills = ['champions-mc-matchups', 'champions-mc-teambuilding'];
const envFor = (overrides = {}) => {
  const env = { ...process.env, ...overrides };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  return env;
};
const runModule = (code, env) => spawnSync(process.execPath, ['--input-type=module', '--eval', code], { env: envFor(env), encoding: 'utf8', timeout: 20000 });
const success = result => {
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
};

async function fixture(t) {
  const parent = await realpath(tmpdir());
  const workspace = await realpath(await mkdtemp(join(parent, 'vgc-skill-root-')));
  assert.equal(dirname(workspace), parent);
  t.after(async () => {
    assert.equal(await realpath(workspace), workspace);
    assert.equal(dirname(workspace), parent);
    await rm(workspace, { recursive: true, force: true });
  });
  for (const skill of skills) {
    const source = join(workspace, 'skills', skill);
    await mkdir(join(source, 'references'), { recursive: true });
    await writeFile(join(source, 'SKILL.md'), `# ${skill}\nRead the required guidance.\n`);
    await writeFile(join(source, 'references', 'cycle.md'), 'Review evidence before the next search.\n');
  }
  const scripts = join(workspace, 'skills', skills[0], 'scripts');
  await mkdir(scripts);
  await writeFile(join(scripts, 'sync-skill.mjs'), await readFile(script));
  return { workspace, root: join(workspace, 'another-agent', 'skills'), codexHome: join(workspace, 'codex-home') };
}

test('another host can sync both skills and verify adoption using its startup root', async t => {
  const { workspace, root, codexHome } = await fixture(t);
  const result = success(runModule(`
    import { getSkillStatus, syncSkill, readSkill, verifySkillRead } from ${JSON.stringify(service)};
    const workspace = ${JSON.stringify(workspace)}, results = [];
    for (const skill of ${JSON.stringify(skills)}) {
      const before = await getSkillStatus({ workspace, skill });
      const plan = await syncSkill({ workspace, skill });
      const after = await syncSkill({ workspace, skill, dryRun: false, confirmed: true });
      results.push({ target: before.target, missing: before.installedSha256 === null, dryRun: plan.dryRun, synchronized: after.synchronized });
    }
    const read = await readSkill({ workspace });
    const adoption = await verifySkillRead({ workspace, readReceipt: read.readReceipt });
    process.env.VGC_COACHING_SKILLS_ROOT = ${JSON.stringify(join(workspace, 'changed-after-startup'))};
    console.log(JSON.stringify({ results, files: read.filesRead.length, adoption: adoption.syncVerified, targetAfterEnvChange: (await getSkillStatus({ workspace })).target }));
  `, { VGC_COACHING_SKILLS_ROOT: root, CODEX_HOME: codexHome }));
  assert.deepEqual(result.results, skills.map(skill => ({ target: join(root, skill), missing: true, dryRun: true, synchronized: true })));
  assert.equal(result.files, 3);
  assert.equal(result.adoption, true);
  assert.equal(result.targetAfterEnvChange, join(root, skills[0]));
});

test('unset startup root preserves the Codex default', async t => {
  const { workspace, codexHome } = await fixture(t);
  const status = success(runModule(`
    import { getSkillStatus } from ${JSON.stringify(service)};
    console.log(JSON.stringify(await getSkillStatus({ workspace: ${JSON.stringify(workspace)} })));
  `, { VGC_COACHING_SKILLS_ROOT: undefined, CODEX_HOME: codexHome }));
  assert.equal(status.target, join(codexHome, 'skills', skills[0]));
  assert.equal(status.synchronized, false);
});

test('manual sync uses the same configured parent and preserves explicit --target', async t => {
  const { workspace, root } = await fixture(t), source = join(workspace, 'skills', skills[0]);
  const invoke = extra => spawnSync(process.execPath, [script, '--check', '--source', source, ...extra], { env: envFor({ VGC_COACHING_SKILLS_ROOT: root }), encoding: 'utf8', timeout: 20000 });
  const check = invoke([]);
  assert.equal(check.status, 1);
  assert.equal(JSON.parse(check.stdout).target, join(root, skills[0]));
  const explicitTarget = join(workspace, 'explicit-install');
  const explicit = invoke(['--target', explicitTarget]);
  assert.equal(explicit.status, 1);
  assert.equal(JSON.parse(explicit.stdout).target, explicitTarget);
});

test('invalid configured roots fail clearly instead of silently changing destination', async () => {
  for (const root of ['', '   ', 'relative/skills']) {
    const loaded = runModule(`await import(${JSON.stringify(service)});`, { VGC_COACHING_SKILLS_ROOT: root });
    assert.notEqual(loaded.status, 0);
    assert.match(loaded.stderr, /VGC_COACHING_SKILLS_ROOT must be a non-empty absolute path/);
    const manual = spawnSync(process.execPath, [script, '--check'], { env: envFor({ VGC_COACHING_SKILLS_ROOT: root }), encoding: 'utf8', timeout: 20000 });
    assert.equal(manual.status, 2);
    assert.match(JSON.parse(manual.stdout).error, /VGC_COACHING_SKILLS_ROOT must be a non-empty absolute path/);
  }
});

test('a configured root cannot overlap maintained source folders', async t => {
  const { workspace } = await fixture(t);
  const loaded = runModule(`
    import { getSkillStatus } from ${JSON.stringify(service)};
    await getSkillStatus({ workspace: ${JSON.stringify(workspace)} });
  `, { VGC_COACHING_SKILLS_ROOT: join(workspace, 'skills') });
  assert.notEqual(loaded.status, 0);
  assert.match(loaded.stderr, /source and installed folders must be separate/);
});

test('installing one skill cannot write inside the other maintained source skill', async t => {
  const { workspace } = await fixture(t);
  for (const [selected, other] of [skills, [...skills].reverse()]) {
    const root = join(workspace, 'skills', other, 'installed-parent');
    const loaded = runModule(`
      import { getSkillStatus } from ${JSON.stringify(service)};
      await getSkillStatus({ workspace: ${JSON.stringify(workspace)}, skill: ${JSON.stringify(selected)} });
    `, { VGC_COACHING_SKILLS_ROOT: root });
    assert.notEqual(loaded.status, 0);
    assert.match(loaded.stderr, /source and installed folders must be separate/);
    const manual = spawnSync(process.execPath, [script, '--check', '--source', join(workspace, 'skills', selected)], { env: envFor({ VGC_COACHING_SKILLS_ROOT: root }), encoding: 'utf8', timeout: 20000 });
    assert.equal(manual.status, 2);
    assert.match(JSON.parse(manual.stdout).error, /Paths must not overlap/);
  }
});
