
/** A token count in a short form: [value, unit] — 999 → [999, ''], 12 345 → [12.3, 'k'],
    1 234 567 → [1.2, 'M'], 2.5e9 → [2.5, 'B']. Never shows 1000 of a unit: 999 950 → [1, 'M']. */
export function tokenParts(n) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v < 1000) return [v, ''];
  for (const [unit, size] of [['k', 1e3], ['M', 1e6], ['B', 1e9]]) {
    const x = Math.round((v / size) * 10) / 10;
    if (x < 1000 || unit === 'B') return [x, unit];
  }
  return [v, ''];
}

/** Tokens for people: "1.2M", "45.3k", "999" — through the board's number format and units. */
export function tokensText(n, f) {
  const [x, unit] = tokenParts(n);
  if (!unit) return f.num(x, 0);
  return `${f.num(x, Number.isInteger(x) ? 0 : 1)}${f.gap}${f.tr(unit)}`;
}

/** "N tokens", the word agreeing with the number: a short form takes the many-form ("1.2M tokens"). */
export const tokensPhrase = (n, f) => `${tokensText(n, f)} ${tokenParts(n)[1] ? f.plural(5, 'token', 'tokens') : f.plural(Math.round(n), 'token', 'tokens')}`;

/** Money in dollars, two decimals; less than a cent is "< $0.01"; nothing priced — null. */
export function moneyText(cost, f) {
  if (cost === null || cost === undefined || !Number.isFinite(cost)) return null;
  if (cost < 0.005) return `< $${f.num(0.01, 2)}`;
  return `$${f.num(cost, 2)}`;
}

/** How full the conversation memory was: a share of the model's window, or the tokens when the window
    is not known (a model the price table does not have). */
export function memoryText(ctx, f) {
  if (!ctx || !Number.isFinite(ctx.tokens)) return null;
  if (ctx.window) return `${Math.round((100 * ctx.tokens) / ctx.window)}%`;
  return tokensText(ctx.tokens, f);
}

/** The lines of the usage tooltip: what the tokens were, what the money means (with a subscription
    it is notional), what is not priced or not fully recorded, and the memory on the last answer. */
export function usageNotes(u, f) {
  const t = u.tokens;
  const out = [`${f.tr('Input')} ${tokensText(t.input, f)} · ${f.tr('output')} ${tokensText(t.output, f)} · `
    + `${f.tr('cache read')} ${tokensText(t.cache_read, f)} · ${f.tr('cache write')} ${tokensText(t.cache_write, f)}`];
  const money = moneyText(u.cost, f);
  if (money) {
    out.push(`≈ ${money} — ${f.tr('what these tokens cost on the API, at the prices of')} ${f.date(u.prices_as_of)}. `
      + f.tr('With a subscription the money is notional: the plan is paid, not the tokens.'));
  }
  if (u.unpriced > 0) {
    out.push(`${f.tr('No price for')} ${u.unpriced_models.join(', ')}: ${tokensPhrase(u.unpriced, f)} ${f.tr('counted without money.')}`);
  }
  // the number goes after a colon: in Russian a verb after a number has to agree with it
  if (u.partial_answers > 0) {
    out.push(`${f.tr('Answers recorded without their final count:')} ${f.num(u.partial_answers, 0)} — `
      + f.tr("Claude Code mostly writes helpers' answers this way, so the output and the money were higher."));
  }
  if (u.context) {
    const of = u.context.window ? ` ${f.tr('of')} ${tokensText(u.context.window, f)}` : '';
    out.push(`${f.tr('Conversation memory on the last answer:')} ${tokensText(u.context.tokens, f)}${of} (${u.context.model})`);
  }
  out.push(`${f.tr('Answers of Claude counted, helpers included:')} ${f.num(u.answers, 0)}`);
  return out;
}

/** The card's usage line: tokens first, then the money with "≈", then the memory; null — nothing counted. */
export function usageLine(u, f) {
  if (!u || (!u.total && !u.context)) return null;
  const parts = [f.tr('Usage'), tokensPhrase(u.total, f)];
  const money = moneyText(u.cost, f);
  if (money) parts.push(`≈ ${money}`);
  const memory = memoryText(u.context, f);
  if (memory) parts.push(`${f.tr('memory')} ${memory}`);
  return { text: parts.join(' · '), title: usageNotes(u, f).join('\n') };
}

/** The dashboard's usage block for the window: the totals, then the tasks that cost the most — each row
    opens its card (`data-key`). Titles and project names are the person's text: always escaped. */
export function usagePanel(u, f) {
  if (!u || !u.total) return `<div class="muted">${f.esc(f.tr('No Claude usage counted in this period yet'))}</div>`;
  const money = moneyText(u.cost, f);
  const t = u.tokens;
  const head = '<div class="us-head">'
    + `<span class="us-big">${f.esc(tokensText(u.total, f))}</span><span class="us-unit">${f.esc(f.plural(tokenParts(u.total)[1] ? 5 : u.total, 'token', 'tokens'))}</span>`
    + (money ? `<span class="us-money" title="${f.esc(f.tr('With a subscription the money is notional: the plan is paid, not the tokens.'))}">≈ ${f.esc(money)}</span>` : '')
    + '</div>'
    + `<div class="us-kinds">${f.esc(`${f.tr('input')} ${tokensText(t.input, f)} · ${f.tr('output')} ${tokensText(t.output, f)} · `
      + `${f.tr('cache read')} ${tokensText(t.cache_read, f)} · ${f.tr('cache write')} ${tokensText(t.cache_write, f)}`)}</div>`;
  const top = Math.max(...u.tasks.map((x) => x.cost ?? 0), 0);
  const topTokens = Math.max(...u.tasks.map((x) => x.total), 1);
  const rows = u.tasks.map((x) => {
    const share = top > 0 ? (x.cost ?? 0) / top : x.total / topTokens;
    const value = moneyText(x.cost, f);
    return `<div class="us-row" data-key="${f.esc(x.key)}" title="${f.esc(`${tokensPhrase(x.total, f)} · ${x.project}`)}">`
      + `<span class="wr-key">${f.esc(x.key)}</span><span class="us-title">${f.esc(x.title || x.key)}</span>`
      + `<span class="us-bar-wrap"><span class="us-bar" style="width:${Math.max(2, Math.round(share * 100))}%"></span></span>`
      + `<span class="us-n">${f.esc(value ? `≈ ${value}` : tokensText(x.total, f))}</span></div>`;
  }).join('');
  // a phone has no tooltip: what the money means is said in the block itself
  const notes = [`≈ — ${f.tr('what these tokens cost on the API, at the prices of')} ${f.date(u.prices_as_of)}`, f.tr('with a subscription the money is notional')];
  if (u.partial_answers > 0) notes.push(f.tr("helpers' output is recorded only in part, so their money is higher"));
  return head
    + (rows ? `<div class="us-sub-h">${f.esc(f.tr('Cost the most'))}</div>${rows}` : '')
    + `<div class="us-note">${f.esc(notes.join('; '))}</div>`;
}
