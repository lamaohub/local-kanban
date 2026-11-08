// Latin words and numbers are turned into Russian before the voice gets them. A leaf: no imports, the test runs it.

/* The words of the voice, the only place with Russian in this file: names it knows, the letters of a word it does
   not, numbers. */
const WORDS = {
  known: {
    claude: 'клод', readme: 'ридми', chrome: 'хром', safari: 'сафари', mac: 'мак', macos: 'мак о эс', github: 'гитхаб',
    git: 'гит', telegram: 'телеграм', ok: 'окей', okay: 'окей', api: 'апи', js: 'джей эс', css: 'си эс эс', html: 'эйч ти эм эл',
    json: 'джейсон', npm: 'эн пэ эм', node: 'ноуд', ssh: 'эс эс эйч', url: 'ю ар эл', ui: 'ю ай', wifi: 'вай фай',
    dev: 'дев', main: 'мейн', commit: 'коммит', push: 'пуш', deploy: 'деплой', review: 'ревью', bug: 'баг', test: 'тест',
    tests: 'тесты', sql: 'эс кью эл', sqlite: 'эс кью лайт', python: 'пайтон', silero: 'силеро', webkit: 'вебкит',
    iphone: 'айфон', ios: 'ай о эс', android: 'андроид', google: 'гугл', apple: 'эппл', openai: 'опен эй ай', tmux: 'ти макс',
    kanban: 'канбан', kb: 'кей би', pm2: 'пэ эм два', md: 'эм дэ', pr: 'пи ар', ck: 'си кей', id: 'ай ди', ai: 'эй ай',
    claudecode: 'клод код', code: 'код', terminal: 'терминал', chat: 'чат', board: 'борд', server: 'сервер', backup: 'бэкап',
    style: 'стайл', fastify: 'фастифай', playwright: 'плейрайт', figma: 'фигма', docker: 'докер', nginx: 'энджинкс', linux: 'линукс',
  },
  // the name of a letter, for a short word in capitals (an abbreviation)
  letters: {
    a: 'эй', b: 'би', c: 'си', d: 'ди', e: 'и', f: 'эф', g: 'джи', h: 'эйч', i: 'ай', j: 'джей', k: 'кей', l: 'эл', m: 'эм',
    n: 'эн', o: 'оу', p: 'пи', q: 'кью', r: 'ар', s: 'эс', t: 'ти', u: 'ю', v: 'ви', w: 'дабл ю', x: 'экс', y: 'уай', z: 'зед',
  },
  // a word it does not know, by its sounds: pairs first, then single letters
  pairs: [['sh', 'ш'], ['ch', 'ч'], ['th', 'т'], ['ph', 'ф'], ['oo', 'у'], ['ee', 'и'], ['ck', 'к'], ['qu', 'кв'], ['wh', 'у'],
    ['kh', 'х'], ['zh', 'ж'], ['ts', 'ц'], ['ya', 'я'], ['yu', 'ю'], ['yo', 'ё'], ['ai', 'ай'], ['ay', 'эй'], ['ea', 'и'], ['ou', 'ау']],
  sounds: {
    a: 'а', b: 'б', c: 'к', d: 'д', e: 'е', f: 'ф', g: 'г', h: 'х', i: 'и', j: 'дж', k: 'к', l: 'л', m: 'м', n: 'н', o: 'о',
    p: 'п', q: 'к', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в', w: 'в', x: 'кс', y: 'и', z: 'з',
  },
  softC: 'с', // c before e, i, y
  units: ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять', 'десять', 'одиннадцать', 'двенадцать',
    'тринадцать', 'четырнадцать', 'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать'],
  unitsF: ['', 'одна', 'две'],
  tens: ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'],
  hundreds: ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'],
  zero: 'ноль',
  thousand: ['тысяча', 'тысячи', 'тысяч'],
  million: ['миллион', 'миллиона', 'миллионов'],
  percent: ['процент', 'процента', 'процентов'],
  and: 'и',
  feminine: /^(задач|минут|секунд|строк|недел|ошибк|ошибок|проверк|правк|копи|верси|тысяч|кнопк|колонк|карточк|сесси|част)/,
};

export function plural(n, [one, few, many]) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

export function numberWords(n, feminine = false) {
  if (!Number.isInteger(n) || n < 0 || n > 999999999) return String(n);
  if (n === 0) return WORDS.zero;
  const three = (x, fem) => {
    const out = [WORDS.hundreds[Math.floor(x / 100)]];
    const r = x % 100;
    if (r < 20) out.push(fem && r < 3 ? WORDS.unitsF[r] : WORDS.units[r]);
    else {
      out.push(WORDS.tens[Math.floor(r / 10)]);
      const u = r % 10;
      out.push(fem && u < 3 ? WORDS.unitsF[u] : WORDS.units[u]);
    }
    return out.filter(Boolean).join(' ');
  };
  const parts = [];
  const mil = Math.floor(n / 1e6);
  const th = Math.floor((n % 1e6) / 1000);
  const rest = n % 1000;
  if (mil) parts.push(`${three(mil, false)} ${plural(mil, WORDS.million)}`);
  if (th) parts.push(th === 1 ? WORDS.thousand[0] : `${three(th, true)} ${plural(th, WORDS.thousand)}`);
  if (rest) parts.push(three(rest, feminine));
  return parts.join(' ');
}

/** A Latin word said in Russian: one it knows, a short one in capitals letter by letter, else by its sounds. */
export function latinWord(word) {
  const low = word.toLowerCase();
  if (Object.hasOwn(WORDS.known, low)) return WORDS.known[low];
  if (/^[A-Z]{2,4}$/.test(word)) return [...low].map((c) => WORDS.letters[c]).join(' ');
  let out = '';
  for (let i = 0; i < low.length;) {
    const pair = WORDS.pairs.find(([p]) => low.startsWith(p, i));
    if (pair) { out += pair[1]; i += pair[0].length; continue; }
    const c = low[i];
    out += c === 'c' && /[eiy]/.test(low[i + 1] || '') ? WORDS.softC : (WORDS.sounds[c] ?? '');
    i += 1;
  }
  return out;
}

/** The text with every Latin word and number in Russian words, ready for a Russian voice. */
export function speechText(text) {
  let s = String(text ?? '');
  s = s.replace(/\b(\d{1,2}):(\d{2})\b/g, (m, h, mm) => `${numberWords(Number(h))} ${Number(mm) ? numberWords(Number(mm), true) : WORDS.zero + ' ' + WORDS.zero}`);
  s = s.replace(/(\d+)\s?%/g, (m, d) => (d.length > 9 ? m : `${numberWords(Number(d))} ${plural(Number(d), WORDS.percent)}`));
  s = s.replace(/(\d+)[.,](\d+)/g, (m, a, b) => (a.length > 9 || b.length > 9 ? m : `${numberWords(Number(a))} ${WORDS.and} ${numberWords(Number(b))}`));
  s = s.replace(/\d{1,3}(?:[ \u00a0]\d{3})+|\d+/g, (m, at) => {
    const n = Number(m.replace(/[ \u00a0]/g, ''));
    if (!Number.isSafeInteger(n) || n > 999999999) return m.split('').map((d) => numberWords(Number(d))).join(' ');
    const next = s.slice(at + m.length).match(/^\s*([^\s.,!?;:]+)/u)?.[1]?.toLowerCase() || '';
    return numberWords(n, WORDS.feminine.test(next));
  });
  s = s.replace(/([A-Za-z])\.([A-Za-z])/g, '$1 $2');
  // a Latin word — Claude, README, drawer
  s = s.replace(/[A-Za-z][A-Za-z']*/g, (w) => latinWord(w.replace(/'/g, '')));
  return s.replace(/\s+/g, ' ').trim();
}
