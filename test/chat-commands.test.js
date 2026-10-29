// `/model <id>`, «Compact» and a skill of the menu went after the task's key, and Claude read them as words
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'kb-chat-cmd-'));
process.env.KB_CLAUDE_DIR = dir;
process.env.KB_SKILLS_EXTRA = '';
process.env.KB_DATA_DIR = join(dir, 'data'); // terminal-say reaches the board's database
for (const name of ['demo-skill', 'clear']) {
  mkdirSync(join(dir, 'skills', name), { recursive: true });
  writeFileSync(join(dir, 'skills', name, 'SKILL.md'), `---\nname: ${name}\n---\n`);
}
const { chatWords, chatSkill } = await import('../src/terminal-say.js');

test('the model picker and «Compact» go to Claude Code as commands', () => {
  assert.equal(chatWords('CH-1', '/model claude-sonnet-5-5'), '/model claude-sonnet-5-5');
  assert.equal(chatWords('CH-1', '/model claude-opus-5-5[1m]'), '/model claude-opus-5-5[1m]');
  assert.equal(chatWords('CH-1', '/compact'), '/compact');
  assert.equal(chatWords('CH-1', '/compact keep the plan'), '/compact keep the plan');
  // a model that is no id of Claude's stays words
  assert.equal(chatWords('CH-1', '/model ; rm -rf ~'), 'CH-1: /model ; rm -rf ~');
  assert.equal(chatWords('CH-1', '/model'), 'CH-1: /model');
});

test('a skill on the disk goes as a command, a command of Claude Code that wipes or leaves does not', () => {
  assert.equal(chatWords('CH-1', '/demo-skill fix the docs'), '/demo-skill fix the docs');
  assert.equal(chatSkill('/demo-skill'), 'demo-skill');
  assert.equal(chatWords('CH-1', '/clear'), 'CH-1: /clear', 'a skill named «clear» let /clear wipe the session');
  assert.equal(chatWords('CH-1', '/no-such-skill'), 'CH-1: /no-such-skill');
  assert.equal(chatWords('CH-1', '/../demo-skill'), 'CH-1: /../demo-skill');
  assert.equal(chatWords('CH-1', '!rm -rf /'), 'CH-1: !rm -rf /');
});
