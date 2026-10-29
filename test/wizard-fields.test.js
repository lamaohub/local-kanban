import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  assert.match(core, /closest\?\.\('\.modal(, \.settings-modal)?'\)/,
    'placement stopped measuring against the dialog — a list fits the window and still leaves the modal');
  assert.match(board, /popoverPlacement\(host\.querySelector\('\.kbsel-btn'\)\)/,
    'buildSelect no longer checks for room and can reopen under the modal buttons');
  assert.match(chaos, /popoverPlacement\(anchor\)/, 'chaosPopover grew its own copy of the rule again');
  assert.match(css, /\.kbsel-list\.up \{[^}]*bottom: calc\(100% \+ 4px\)/, 'a dropdown can no longer flip up');
  assert.doesNotMatch(css, /\.wiz-body \{[^}]*max-height: \d+vh/,
    'the wizard body is back to a fixed share of the window, which cut the last field off');
});

test('the server fields say whether they mean the server or this computer', () => {
  const core = readFileSync(new URL('../public/js/core.js', import.meta.url), 'utf8');
  assert.match(sidebar, /class="wiz-h">\$\{tr\('Server'\)\}/, 'the server group lost its heading');
  assert.match(project, /the server this project is deployed to/i,
    'the project page stopped saying which side these fields are about');
  assert.match(sidebar, /Not about this computer/i,
    'the wizard stopped saying these fields are not about this computer');

  for (const [src, name] of [[sidebar, 'the wizard'], [project, 'the project page']]) {
    assert.match(src, /no key or password is entered here/i,
      `${name} no longer answers where the ssh key or password goes`);
    assert.match(src, /a password will not do/i, `${name} stopped saying a password cannot work at all`);
    assert.match(src, /~\/\.ssh\/config/, `${name} no longer says where access comes from`);
  }
  const routes = readFileSync(new URL('../src/routes/projects.js', import.meta.url), 'utf8');
  assert.match(routes, /'BatchMode=yes'/, 'ssh can prompt for a password again, and the hint now lies');

  const ssh = sidebar.match(/id="wiz-server"[^>]*placeholder="([^"]*)"/)?.[1];
  assert.ok(ssh && /^\d{1,3}(\.\d{1,3}){3}$/.test(ssh), `the ssh field lost its address example: ${ssh}`);
  assert.match(ssh, /^(127\.|10\.|192\.168\.)/, `a routable IP in the source fails the release audit: ${ssh}`);

  const prose = [...sidebar.matchAll(/placeholder="([^"$][^"]*)"/g)].map((m) => m[1])
    .filter((t) => /\s(for|or|in|the)\s/.test(t));
  assert.deepEqual(prose, [], `these placeholders bypass tr() and stay English on a Russian board: ${prose}`);
  assert.match(project, /id="ps-spath"[^>]*placeholder=/, 'the server path field on the project page lost its example again');

  for (const name of ['README.md', 'README.ru.md']) {
    const readme = readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
    assert.match(readme, /ssh <[^>]+>/, `${name} does not explain how the board reaches a server`);
    assert.match(readme, /~\/\.ssh\/config/, `${name} stopped saying credentials are not kept by the board`);
  }
  for (const key of ['where the project lies ON THE SERVER', 'no key or password is entered here', 'Server']) {
    assert.ok(core.includes(key), `no Russian translation for: ${key}`);
  }
});

test('the prefix the wizard promises is the prefix the server will give', async (t) => {
  const data = mkdtempSync(join(tmpdir(), 'kb-test-'));
  process.env.KB_DATA_DIR = data;
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const { genPrefix } = await import('../src/db.js');
  const src = sidebar.match(/function wizPrefix\([\s\S]*?\) \{\n([\s\S]*?)\n\}/);
  assert.ok(src, 'wizPrefix is gone from the wizard, or its shape changed beyond the guard');
  const mirror = new Function('slug', 'used', src[1]);
  const cases = ['kanban', 'a', 'my-project', 'demo', 'totally-new-thing', 'a-b-c-d', 'x1', 'z', 'server-panel', '2gis', 'ab-', 'x--', 'my.site', 'my_app'];
  for (const slug of cases) {
    assert.equal(mirror(slug, new Set()), genPrefix(slug, new Set()), `wizard and server disagree on "${slug}"`);
  }
  const used = new Set([genPrefix('my-project', new Set())]);
  assert.equal(mirror('my-project', used), genPrefix('my-project', used), 'the mirror ignores taken prefixes');
});

test('the wizard can check the ssh host and the folder before creating anything', () => {
  const routes = readFileSync(new URL('../src/routes/projects.js', import.meta.url), 'utf8');
  const handler = routes.match(/app\.post\('\/api\/projects\/ssh-check'[\s\S]*?\n  \}\);/);
  assert.ok(handler, 'the connection check endpoint is gone');
  const body = handler[0];
  assert.match(body, /'BatchMode=yes'/,
    'the check can prompt for a password again, which the hint says is impossible');
  assert.match(body, /\[\\w\.@\]\[\\w\.@-\]\*/, 'a host starting with a hyphen would be taken by ssh as an option');
  assert.match(body, /\/\["'`;\|&\$\\\\\]\//, 'the server path is no longer checked for shell metacharacters');
  assert.match(body, /'--', server, cmd/, 'the host is no longer separated from options by --');
  for (const [what, re] of [['ssh', /id="wiz-ssh-check"/], ['folder', /id="wiz-path-check"/]]) {
    assert.match(sidebar, re, `the ${what} check button is gone`);
  }
  assert.match(sidebar, /checkSsh|wiz-ssh-check'\)\.onclick/, 'the ssh button is not wired to anything');
  assert.match(sidebar, /checkPath\(\$\('wiz-path'\)\.value\.trim\(\)\)/, 'the folder button is not wired to anything');
  assert.match(sidebar, /\$\('wiz-server'\)\.oninput = \(\) => setState\('wiz-ssh-state', ''\)/,
    'a stale "connected" can now sit next to a freshly typed host');
});

test('the clone mode says where the repository will land', () => {
  assert.match(sidebar, /git clone puts it on THIS computer at/i, 'the clone hint is gone');
  assert.match(sidebar, /state\.folders\.root/, 'the hint stopped showing the real destination path');
  assert.match(sidebar, /An existing folder is refused, not overwritten/i,
    'the hint no longer says what happens when the folder is already there');
});

test('the wizard offers to hand the setup to Claude', () => {
  const core = readFileSync(new URL('../public/js/core.js', import.meta.url), 'utf8');
  const block = core.match(/export const ADD_PROJECT_PROMPT = \{[\s\S]*?\n\};/);
  assert.ok(block, 'the prompt is gone');
  for (const lang of ['ru', 'en']) {
    assert.match(block[0], new RegExp(`\\n  ${lang}: \``), `the add-project prompt has no ${lang} version`);
  }
  assert.match(block[0], /BatchMode=yes/, 'the prompt no longer tells Claude how to verify the ssh access itself');
  assert.match(block[0], /POST \/api\/projects/, 'the prompt no longer tells Claude how to register the project');
  assert.match(sidebar, /wiz-ai-copy/, 'the copy button is gone from the first step');
  assert.match(sidebar, /copyText\(addProjectPrompt\(\)\)/, 'the button copies something other than the prompt');
});

test('the sync section warns that tasks leave the machine, and that the repo should be private', () => {
  const settings = readFileSync(new URL('../public/js/settings.js', import.meta.url), 'utf8');
  assert.match(settings, /make it private/i, 'the privacy warning next to the sync fields is gone');
  assert.match(settings, /leaves your machine/i, 'the section no longer says that this is what sends data out');
  assert.match(settings, /One repository for the whole board, not one per project/,
    'the section stopped explaining that the setting is board-wide, which was the first question asked about it');
  assert.match(settings, /gh auth refresh -s project/, 'the scope people forget is no longer mentioned');
  const shown = settings.slice(settings.indexOf('<div class="sync-about">'), settings.indexOf('moreHTML(', settings.indexOf('<div class="sync-about">')));
  assert.ok(shown.length > 30, 'the sync section lost the words above its fold');
  assert.match(shown, /private GitHub repository you create yourself first/, 'what leaves the machine, or that the repo is made by hand, is hidden under More');
  assert.match(shown, /in full/);
  assert.match(shown, /gh auth refresh -s project/, 'the scope people forget is hidden under More');
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

test('the folder check tells "not there" apart from "no permission" and "could not check"', () => {
  const fn = sidebar.slice(sidebar.indexOf('export async function checkPath'), sidebar.indexOf('const SSH_WHY'));
  assert.match(fn, /e\.status/, 'the folder check stopped looking at the answer code — every refusal reads as "no such folder" again');
  assert.match(fn, /404:/, 'the "no such folder" case lost its own code');
  assert.match(fn, /403:/, 'a folder the board may not read is called missing again');
  assert.match(fn, /400:/, 'a file given instead of a folder is called missing again');
  assert.match(fn, /could not check the folder/, 'an unknown failure (a dead server) still claims the folder is not there');
  // each code keeps its own words: with the texts swapped every check above still passes
  assert.match(fn, /404: tr\('no such folder on this computer'\)/, '404 no longer says "no such folder"');
  assert.match(fn, /400: tr\('this path is not a folder'\)/, '400 no longer says "not a folder"');
  assert.match(fn, /403: tr\('the folder is there, but the board cannot read it/, '403 no longer says "no permission"');
});

// «a key from ~/.ssh/config» from the first letter; a filled wizard went away on Esc without a word.
test('an empty answer brings the hint under the field back, and a filled wizard asks before it closes', async () => {
  const vm = await import('node:vm');
  const head = sidebar.indexOf('function setState(');
  const fn = sidebar.slice(head, sidebar.indexOf('\n}\n', head) + 2);
  const cls = new Set();
  const el = { innerHTML: 'a key is <b>required</b>', set textContent(t) { this.innerHTML = t; }, classList: { remove: (...a) => a.forEach((c) => cls.delete(c)), add: (c) => cls.add(c) } };
  const box = { $: () => el };
  vm.runInNewContext(`${fn}\nthis.setState = setState;`, box);
  box.setState('wiz-ssh-state', 'connecting…');
  assert.equal(el.innerHTML, 'connecting…');
  box.setState('wiz-ssh-state', '');
  assert.equal(el.innerHTML, 'a key is <b>required</b>', 'typing in the server field wipes the standing ssh hint');
  const wiz = sidebar.slice(sidebar.indexOf('function openProjectWizard('), sidebar.indexOf('\n}\n', sidebar.indexOf('function openProjectWizard(')));
  assert.match(wiz, /overlayLayer\(overlay, \{ confirmClose: \(\) => created \|\| !filled\(\) \|\| confirmDiscard\(\) \}\)/, 'a filled wizard closes on Esc without asking');
  assert.match(wiz, /created = true;\s*\n\s*close\(\);/, 'a created project would ask «discard?» over the wizard it closes');
});
