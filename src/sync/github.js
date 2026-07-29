import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { db, ghOwner, ghRepo, uiLang } from '../db.js';
const GH_CANDIDATES = [
  '/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh',
  '/home/linuxbrew/.linuxbrew/bin/gh', `${process.env.HOME}/.local/bin/gh`,
];
const GH = GH_CANDIDATES.find((p) => existsSync(p)) || 'gh';

export function gh(args, { timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(GH, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const e = new Error((stderr || err.message || '').trim().slice(0, 500));
        e.permanent = /not found|could not resolve|invalid|unprocessable/i.test(String(stderr));
        return reject(e);
      }
      resolve(stdout.trim());
    });
  });
}

export async function ghAvailable() {
  try { await gh(['auth', 'status'], { timeout: 15000 }); return true; }
  catch { return false; }
}

const GH_STATUS = [
  ['backlog',   { ru: 'Бэклог',     en: 'Backlog' },   'PINK'],
  ['todo',      { ru: 'Сделать',    en: 'To do' },     'GRAY'],
  ['prep',      { ru: 'Подготовка', en: 'Prep' },      'PURPLE'],
  ['doing',     { ru: 'Делаю',      en: 'Doing' },     'YELLOW'],
  ['deploy',    { ru: 'Деплою',     en: 'Deploying' }, 'BLUE'],
  ['review',    { ru: 'Проверяю',   en: 'Review' },    'ORANGE'],
  ['done',      { ru: 'Готово',     en: 'Done' },      'GREEN'],
  ['cancelled', { ru: 'Отменено',   en: 'Cancelled' }, 'RED'],
];
const statusName = (names) => names[uiLang()] || names.ru;
export const ghStatusName = (key) => statusName(GH_STATUS.find(([k]) => k === key)?.[1] || { ru: key });
export const NAME_TO_KEY = { Todo: 'todo', 'In Progress': 'doing', Done: 'done' };
for (const [key, names] of GH_STATUS) for (const n of Object.values(names)) NAME_TO_KEY[n] = key;
const PRIORITY_LABELS = { 1: 'p:low', 2: 'p:med', 3: 'p:high' };

export const LABELS = {
  bug: 'D73A4A', documentation: '0075CA', docs: '0075CA', duplicate: 'CFD3D7', enhancement: 'A2EEEF',
  'good first issue': '7057FF', 'help wanted': '008672', invalid: 'E4E669',
  question: 'D876E3', wontfix: 'FFFFFF', ui: '5319E7', feature: '0E8A16',
  blocked: 'D93F0B', 'p:low': 'C2E0C6', 'p:med': 'FBCA04', 'p:high': 'B60205',
  noclaude: '6E7681',
  security: 'EE0701',
  ask: '8250DF',
};

export const MANAGED_LABELS = new Set([...Object.values(PRIORITY_LABELS), 'blocked']);

let labelsEnsuredFor = null;
export async function ensureLabels() {
  const repo = ghRepo();
  if (labelsEnsuredFor === repo) return;
  for (const [name, color] of Object.entries(LABELS)) {
    await gh(['label', 'create', name, '-R', repo, '--color', color, '--force']);
  }
  labelsEnsuredFor = repo;
}

function statusOptions(project) {
  return JSON.parse(project.gh_status_options || '{}');
}

function optionsComplete(project) {
  const opts = statusOptions(project);
  return GH_STATUS.every(([key]) => opts[key]);
}

export async function ensureProject(project) {
  if (project.gh_project_id && project.gh_status_field_id && optionsComplete(project)) return project;

  let { gh_project_number: number, gh_project_id: pid } = project;
  if (!pid) {
    const created = JSON.parse(await gh(['project', 'create', '--owner', ghOwner(), '--title', `kb: ${project.slug}`, '--format', 'json']));
    number = created.number;
    pid = created.id;
  }

  const fields = JSON.parse(await gh(['project', 'field-list', String(number), '--owner', ghOwner(), '--format', 'json'])).fields;
  const statusField = fields.find((f) => f.name === 'Status');

  const keep = {};
  for (const o of statusField.options || []) {
    const key = NAME_TO_KEY[o.name];
    if (key && !keep[key]) keep[key] = o.id;
  }

  const optionsLiteral = '[' + GH_STATUS.map(([key, names, color]) => {
    const idPart = keep[key] ? `id: ${JSON.stringify(keep[key])}, ` : '';
    return `{${idPart}name: ${JSON.stringify(statusName(names))}, color: ${color}, description: ""}`;
  }).join(', ') + ']';

  const res = JSON.parse(await gh(['api', 'graphql', '-f',
    `query=mutation { updateProjectV2Field(input: {fieldId: ${JSON.stringify(statusField.id)}, singleSelectOptions: ${optionsLiteral}}) {
      projectV2Field { ... on ProjectV2SingleSelectField { id options { id name } } } } }`,
  ]));
  const out = res.data.updateProjectV2Field.projectV2Field;
  const map = {};
  for (const o of out.options) if (NAME_TO_KEY[o.name]) map[NAME_TO_KEY[o.name]] = o.id;

  db.prepare('UPDATE projects SET gh_project_number=?, gh_project_id=?, gh_status_field_id=?, gh_status_options=? WHERE id=?')
    .run(number, pid, out.id, JSON.stringify(map), project.id);
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(project.id);
}

export async function setItemStatus(project, itemId, statusKey) {
  const opt = statusOptions(project)[statusKey];
  if (!opt || !itemId) return;
  await gh(['project', 'item-edit', '--id', itemId, '--project-id', project.gh_project_id,
    '--field-id', project.gh_status_field_id, '--single-select-option-id', opt]);
}

function issueBody(project, payload) {
  return `${payload.description || ''}\n\n_project: ${project.slug} · ${payload.key} · created by local-kanban_`;
}

function issueTitle(project, payload) {
  const t = (payload.title || '').trim().split('\n')[0]
    || (payload.description || '').trim().split('\n')[0].slice(0, 80)
    || `task ${payload.key}`;
  const full = `[${project.slug}] ${t}`;
  return full.length > 200 ? `${full.slice(0, 199)}…` : full;
}

export async function createIssueOnly(project, payload) {
  await ensureLabels();
  const args = ['issue', 'create', '-R', ghRepo(),
    '--title', issueTitle(project, payload),
    '--body', issueBody(project, payload)];
  const labels = [...(payload.labels || [])];
  if (PRIORITY_LABELS[payload.priority]) labels.push(PRIORITY_LABELS[payload.priority]);
  if (payload.blocked) labels.push('blocked');
  for (const l of labels) args.push('--label', l);
  const url = await gh(args);
  const number = Number(url.match(/\/issues\/(\d+)/)?.[1]);
  return { number, url };
}

export async function addToProject(project, url) {
  const item = JSON.parse(await gh(['project', 'item-add', String(project.gh_project_number),
    '--owner', ghOwner(), '--url', url, '--format', 'json']));
  return item.id;
}

export async function updateIssue(payload, project) {
  await gh(['issue', 'edit', String(payload.gh_issue_number), '-R', ghRepo(),
    '--title', issueTitle(project, payload),
    '--body', issueBody(project, payload)]);
}

export async function setPriority(payload) {
  await ensureLabels();
  const args = ['issue', 'edit', String(payload.gh_issue_number), '-R', ghRepo()];
  for (const l of Object.values(PRIORITY_LABELS)) args.push('--remove-label', l);
  if (PRIORITY_LABELS[payload.priority]) args.push('--add-label', PRIORITY_LABELS[payload.priority]);
  await gh(args);
}

async function currentLabels(number) {
  try {
    const out = await gh(['issue', 'view', String(number), '-R', ghRepo(), '--json', 'labels']);
    return new Set(JSON.parse(out).labels.map((l) => l.name));
  } catch { return new Set(); }
}

export async function setLabels(payload) {
  await ensureLabels();
  const want = new Set(payload.labels || []);
  const cur = await currentLabels(payload.gh_issue_number);
  const args = ['issue', 'edit', String(payload.gh_issue_number), '-R', ghRepo()];
  let changed = false;
  for (const l of cur) if (!want.has(l) && !MANAGED_LABELS.has(l)) { args.push('--remove-label', l); changed = true; }
  for (const l of want) if (!cur.has(l)) { args.push('--add-label', l); changed = true; }
  if (changed) await gh(args);
}

export async function setBlocked(payload) {
  await ensureLabels();
  await gh(['issue', 'edit', String(payload.gh_issue_number), '-R', ghRepo(),
    payload.blocked ? '--add-label' : '--remove-label', 'blocked']);
}

export async function addComment(payload) {
  const prefix = payload.comment_author === 'claude' ? '🤖 ' : '';
  await gh(['issue', 'comment', String(payload.gh_issue_number), '-R', ghRepo(), '--body', prefix + payload.comment_body]);
}

// done → closed completed; cancelled → closed not planned
export async function closeIssue(payload, project) {
  await setItemStatus(project, payload.gh_item_id, payload.status);
  const reason = payload.status === 'cancelled' ? 'not planned' : 'completed';
  try {
    await gh(['issue', 'close', String(payload.gh_issue_number), '-R', ghRepo(), '--reason', reason]);
  } catch (err) {
    if (!/already closed/i.test(err.message)) throw err;
  }
}

export async function reopenIssue(payload, project) {
  try {
    await gh(['issue', 'reopen', String(payload.gh_issue_number), '-R', ghRepo()]);
  } catch (err) {
    if (!/already open/i.test(err.message)) throw err;
  }
  await setItemStatus(project, payload.gh_item_id, payload.status);
}

export async function deleteIssue(payload) {
  if (!payload.gh_issue_number) return;
  try {
    await gh(['issue', 'close', String(payload.gh_issue_number), '-R', ghRepo(), '--reason', 'not planned']);
  } catch (err) {
    if (!/already closed/i.test(err.message)) throw err;
  }
}
