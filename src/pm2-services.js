// pm2_services: one tolerant parser for every reader.
// The column stores a JSON array of process names, but both the "add project" wizard and
// PATCH /api/projects document the field as "a comma-separated string <-> JSON", so a plain
// string is a legal value that really occurs in existing databases. Every reader used to call
// JSON.parse unconditionally, so such a row crashed `kb info` (exit 3, SyntaxError) and made
// GET /api/projects/:slug/status answer 500.

// Accepts a JSON array, a comma-separated string or an array; always returns string names.
export function parsePm2Services(raw) {
  if (!raw) return [];
  const list = Array.isArray(raw) ? raw : parseRaw(String(raw));
  return list.map((s) => String(s).trim()).filter(Boolean);
}

function parseRaw(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
    } catch { /* not JSON after all — fall through to the comma-separated form */ }
  }
  return trimmed.split(',');
}

// Canonical storage form. Returns null for an empty list so the column is cleared, not set to "[]".
export function serializePm2Services(raw) {
  const list = parsePm2Services(raw);
  return list.length ? JSON.stringify(list) : null;
}
