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
  assert.match(project, /s\.name === generic \|\| s\.used_by\?\.length \|\| own\.has\(s\.name\)/,
    'the rule that tells a deploy skill from the rest of the skills folder is gone');
  assert.match(sidebar, /deploySkills\(info\)/,
    'the wizard would offer the board skill and every unrelated skill as a way to deploy');
});

test('the project page filters deploy skills the same way the wizard does', () => {
  assert.match(project, /export function deploySkills\(/, 'the shared filter is gone');
  assert.match(project, /buildSkillSelect\(p, deploySkills\(info\)\)/,
    'the project page is back to listing every skill in the skills folder, the board own skill included');
  assert.doesNotMatch(project, /buildSkillSelect\(p, info\.items/, 'the unfiltered list came back');
  assert.match(project, /if \(cur && !names\.includes\(cur\)\) names\.unshift\(cur\)/,
    'a project pointing at a skill outside the filter would silently lose it on save');
});

test('a dropdown opens where there is room, and the wizard form is not cut off', () => {
  const core = readFileSync(new URL('../public/js/core.js', import.meta.url), 'utf8');
  const board = readFileSync(new URL('../public/js/board.js', import.meta.url), 'utf8');
  const chaos = readFileSync(new URL('../public/js/chaos.js', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
  assert.match(core, /export function popoverPlacement\(/, 'the placement rule is gone');
  assert.match(core, /closest\?\.\('\.modal'\)/,
    'placement stopped measuring against the dialog — a list fits the window and still leaves the modal');
  assert.match(board, /popoverPlacement\(host\.querySelector\('\.kbsel-btn'\)\)/,
    'buildSelect no longer checks for room and can reopen under the modal buttons');
  assert.match(chaos, /popoverPlacement\(anchor\)/, 'chaosPopover grew its own copy of the rule again');
  assert.match(css, /\.kbsel-list\.up \{[^}]*bottom: calc\(100% \+ 4px\)/, 'a dropdown can no longer flip up');
  assert.doesNotMatch(css, /\.wiz-body \{[^}]*max-height: \d+vh/,
    'the wizard body is back to a fixed share of the window, which cut the last field off');
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
