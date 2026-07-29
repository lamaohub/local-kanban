
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '../src/db.js';

const SEED = join(dirname(fileURLToPath(import.meta.url)), 'seed-projects.json');

if (!existsSync(SEED)) {
  console.error('no seed-projects.json — run node contrib/seed-from-panel.js first');
  process.exit(1);
}

const seed = JSON.parse(readFileSync(SEED, 'utf8'));
const upsert = db.prepare(`
  INSERT INTO projects (slug, name, path, server_path, deploy_skill, server, pm2_services, domain, category)
  VALUES (@slug, @name, @path, @server_path, @deploy_skill, @server, @pm2_services, @domain, @category)
  ON CONFLICT(slug) DO UPDATE SET
    path = COALESCE(projects.path, excluded.path),
    server_path = COALESCE(projects.server_path, excluded.server_path),
    deploy_skill = COALESCE(projects.deploy_skill, excluded.deploy_skill),
    server = COALESCE(projects.server, excluded.server),
    pm2_services = COALESCE(projects.pm2_services, excluded.pm2_services),
    domain = COALESCE(projects.domain, excluded.domain),
    category = COALESCE(projects.category, excluded.category),
    updated_at = datetime('now')
`);

for (const p of seed) {
  upsert.run({
    slug: p.slug, name: p.name, path: p.path ?? null, server_path: p.server_path ?? null,
    deploy_skill: p.deploy_skill ?? null, server: p.server ?? null,
    pm2_services: p.pm2_services?.length ? JSON.stringify(p.pm2_services) : null,
    domain: p.domain ?? null, category: p.category ?? null,
  });
}
console.log(`registry: ${seed.length} projects loaded`);

if (process.argv.includes('--github')) {
  const { ghAvailable, ensureProject, ensureLabels } = await import('../src/sync/github.js');
  if (!(await ghAvailable())) {
    console.error('gh is unavailable. Once, by hand:\n  brew install gh\n  gh auth login\n  gh auth refresh -s project');
    process.exit(0);
  }
  await ensureLabels();
  console.log('labels: ok');
  for (const slug of JSON.parse(process.env.KB_EAGER_PROJECTS || '[]')) {
    const p = db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug);
    if (!p) continue;
    const fresh = await ensureProject(p);
    console.log(`gh project "kb: ${slug}": #${fresh.gh_project_number}, statuses: ${fresh.gh_status_options}`);
  }
}
