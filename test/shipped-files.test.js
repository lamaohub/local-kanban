import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAYCAST = join(ROOT, 'scripts', 'raycast', 'open-kanban.sh');

test('the Raycast command keeps the directives Raycast needs to register it', () => {
  assert.ok(existsSync(RAYCAST), 'scripts/raycast/open-kanban.sh is part of the package');
  const text = readFileSync(RAYCAST, 'utf8');
  // schemaVersion and title are mandatory; without title the command does not appear at all
  for (const directive of ['@raycast.schemaVersion', '@raycast.title', '@raycast.mode']) {
    const line = text.split('\n').find((l) => l.trim().startsWith(`# ${directive}`));
    assert.ok(line, `${directive} is missing — Raycast would not register the command`);
    assert.ok(line.trim().length > `# ${directive}`.length + 1, `${directive} has no value`);
  }
  assert.match(text, /^#!/, 'the shebang survives');
  assert.doesNotMatch(text, /[\u0430-\u044f\u0451\u0410-\u042f\u0401]/,
    'a shipped shell script is English, so nothing gets stripped out of it');
});
