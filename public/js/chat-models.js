export const MODELS = [
  { id: 'claude-fable-5-1', label: 'Fable 5.1', cost: '$$$$' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', cost: '$$$' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', cost: '$$' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', cost: '$' },
];

// a dated id (claude-sonnet-5-5-20261001) and a long-context one (…[1m]) are the same model to the person
const base = (id) => String(id || '').trim().replace(/\[1m\]$/i, '').replace(/-\d{8}$/, '');

/** The short name of a model: «Opus 5.5»; an unknown one by its id's own words, '' for none. */
export function modelLabel(id) {
  const b = base(id);
  if (!b) return '';
  const known = MODELS.find((m) => m.id === b);
  if (known) return known.label;
  const m = /^claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?$/i.exec(b);
  if (!m) return b;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

/** Whether the transcript's model is the one picked. */
export const sameModel = (a, b) => Boolean(a) && base(a) === base(b);
