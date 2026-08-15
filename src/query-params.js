
export function scalarParam(value, name) {
  if (value === undefined || value === null) return { value: undefined };
  if (Array.isArray(value)) return { error: `${name}: given more than once` };
  if (typeof value === 'object') return { error: `${name}: expected a single value` };
  return { value: String(value) };
}

export function scalarQuery(query, names) {
  const out = {};
  for (const name of names) {
    const r = scalarParam(query?.[name], name);
    if (r.error) return { error: r.error };
    out[name] = r.value;
  }
  return { values: out };
}
