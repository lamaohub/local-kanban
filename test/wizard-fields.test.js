import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sidebar = readFileSync(new URL('../public/js/sidebar.js', import.meta.url), 'utf8');
const project = readFileSync(new URL('../public/js/project.js', import.meta.url), 'utf8');

test('the deploy skill is chosen from a list, not typed in', () => {
  assert.doesNotMatch(sidebar, /<input id="wiz-skill"/, 'the free-text skill field is back');
  assert.match(sidebar, /buildSelect\(skillHost/, 'the wizard stopped building a select for the skill');
});

test('nothing is assigned a deploy skill behind the user\'s back', () => {
  assert.match(sidebar, /const skill = selVal\(\$\('wiz-skill'\)\);\s*\n\s*if \(skill\) body\.deploy_skill = skill;/,
    'the wizard is substituting a default skill again instead of saving what was picked');
  assert.doesNotMatch(sidebar, /deploy_skill = .*\|\| 'deploy'/, 'a silent fallback to the shared skill is back');
});

test('the option list lives in one place, not two', () => {
  assert.match(project, /export function skillOptions\(/, 'the shared builder for skill options is gone');
  assert.match(sidebar, /skillOptions/, 'the wizard stopped using the shared builder and will drift from the project page');
});

test('the wizard offers deploy skills, not everything in the skills folder', () => {
  assert.match(sidebar, /s\.name === generic \|\| s\.used_by\?\.length \|\| own\.has\(s\.name\)/,
    'the wizard would offer the board skill and every unrelated skill as a way to deploy');
});

test('the sync section warns that tasks leave the machine, and that the repo should be private', () => {
  const settings = readFileSync(new URL('../public/js/settings.js', import.meta.url), 'utf8');
  assert.match(settings, /make it private/i, 'the privacy warning next to the sync fields is gone');
  assert.match(settings, /leaves your machine/i, 'the section no longer says that this is what sends data out');
  assert.match(settings, /One repository for the whole board, not one per project/,
    'the section stopped explaining that the setting is board-wide, which was the first question asked about it');
  assert.match(settings, /gh auth refresh -s project/, 'the scope people forget is no longer mentioned');
  const anchor = settings.match(/local-kanban#([\w-]+)"[^>]*>[^<]*README/)?.[1];
  assert.ok(anchor, 'the sync section no longer links to the README');

  for (const name of ['README.md', 'README.ru.md']) {
    const readme = readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
    assert.match(readme, /gh auth refresh -s project/, `${name} does not mention the scope the sync needs`);
  }
  const slug = (h) => h.toLowerCase().replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-');
  const heads = [...readFileSync(new URL('../README.md', import.meta.url), 'utf8').matchAll(/^#{2,3} (.+)$/gm)].map((m) => slug(m[1]));
  assert.ok(heads.includes(anchor), `README.md has no heading for the anchor #${anchor} — the link lands nowhere`);
});
