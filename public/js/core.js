
const ICONS = {
  pin: 'M9.6 2.2 13.8 6.4M11 4 7.6 7.4l-3 .6 4.4 4.4.6-3L13 6M5.2 10.8 2.6 13.4',
  gear: 'M2.5 4.6h11M2.5 11.4h11',
  git: 'M4.6 6.2v6.2M4.6 3.6v.2M11.4 6.2c0 2.4-1.9 3.6-4 4M11.4 3.6v.2',
  chart: 'M2.5 13.5h11M4.6 11.4V7.6M8 11.4V3.4M11.4 11.4V6',
  trend: 'M2.5 11.5 6 8l2.6 2.4L13.5 5M13.5 5H10M13.5 5v3.4',
  copy: 'M5.5 5.5V3.2a1 1 0 0 1 1-1h6.3a1 1 0 0 1 1 1v6.3a1 1 0 0 1-1 1h-2.3M2.2 6.5h6.3a1 1 0 0 1 1 1v6.3a1 1 0 0 1-1 1H2.2a1 1 0 0 1-1-1V7.5a1 1 0 0 1 1-1Z',
  link: 'M6.6 9.4a2.8 2.8 0 0 0 4 0l2-2a2.8 2.8 0 0 0-4-4l-1 1M9.4 6.6a2.8 2.8 0 0 0-4 0l-2 2a2.8 2.8 0 0 0 4 4l1-1',
  attach: 'M11 5.2 6.3 9.9a1.7 1.7 0 0 0 2.4 2.4l4.7-4.7a3.2 3.2 0 0 0-4.6-4.5L4 7.9a4.8 4.8 0 0 0 6.8 6.8l3-3',
  comment: 'M13.8 8.6a5.2 5.2 0 0 1-5.2 5.2H5.4L2.2 15.4l.9-3A5.2 5.2 0 1 1 13.8 8.6Z',
  timer: 'M8 4.8V8l2 1.6M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12ZM6.2 1.4h3.6',
  warn: 'M8 2.6 14.4 13.4H1.6L8 2.6ZM8 6.6v3M8 11.4v.1',
  trash: 'M2.8 4.4h10.4M6.4 4.4V2.9h3.2v1.5M4.2 4.4l.6 8.7a1 1 0 0 0 1 .9h4.4a1 1 0 0 0 1-.9l.6-8.7M6.7 6.9v4.6M9.3 6.9v4.6',
  plus: 'M8 3.4v9.2M3.4 8h9.2',
  download: 'M8 2.6v7.8M5 7.4 8 10.4l3-3M2.8 12.6v.8a1 1 0 0 0 1 1h8.4a1 1 0 0 0 1-1v-.8',
  duplicate: 'M3.4 10.6H2.6a1 1 0 0 1-1-1V2.6a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v.8M6.4 5.4h7a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z',
  person: 'M8 8.4a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2ZM3.2 14a4.8 4.8 0 0 1 9.6 0',
  bot: 'M4.4 6.4h7.2a1 1 0 0 1 1 1v4.6a1 1 0 0 1-1 1H4.4a1 1 0 0 1-1-1V7.4a1 1 0 0 1 1-1ZM8 6.4V4M6.2 9.4v.1M9.8 9.4v.1M1.6 8.6v1.8M14.4 8.6v1.8',
  soundOff: 'M8.4 3.2 4.9 6H2.4v4h2.5l3.5 2.8V3.2ZM11.2 6.4l3.2 3.2M14.4 6.4l-3.2 3.2',
  lock: 'M3.6 7.2h8.8a.9.9 0 0 1 .9.9v4.7a.9.9 0 0 1-.9.9H3.6a.9.9 0 0 1-.9-.9V8.1a.9.9 0 0 1 .9-.9ZM5.4 7.2V5.3a2.6 2.6 0 0 1 5.2 0v1.9',
  status: 'M8 13.4a5.4 5.4 0 1 0 0-10.8 5.4 5.4 0 0 0 0 10.8Z',
  flag: 'M4 14V2.6M4 3.2h7.5l-1.6 2.4 1.6 2.4H4',
  tag: 'M8 2.2H3.2a1 1 0 0 0-1 1V8l5.6 5.6a1.2 1.2 0 0 0 1.7 0l3.9-3.9a1.2 1.2 0 0 0 0-1.7L8 2.2Z',
  chevron: 'M4.2 6.2 8 10l3.8-3.8',
};
const ICON_EXTRA = {
  status: '<path d="M8 2.6v10.8a5.4 5.4 0 0 0 0-10.8Z" fill="currentColor" stroke="none"/>',
  tag: '<circle cx="5.4" cy="5.4" r="1" fill="currentColor" stroke="none"/>',
  gear: '<circle cx="5.8" cy="4.6" r="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/>'
    + '<circle cx="10.4" cy="11.4" r="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/>',
  git: '<circle cx="4.6" cy="13.2" r="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/>'
    + '<circle cx="4.6" cy="2.8" r="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/>'
    + '<circle cx="11.4" cy="2.8" r="1.5" fill="none" stroke="currentColor" stroke-width="1.3"/>',
};
export function ic(name, size = 14) {
  const d = ICONS[name];
  if (!d) return '';
  return `<svg class="ic" viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true">`
    + `<path d="${d}" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>`
    + `${ICON_EXTRA[name] || ''}</svg>`;
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export const LANG = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem('kb.set.lang'));
    if (saved === 'ru' || saved === 'en') return saved;
  } catch {  }
  return (navigator.language || 'ru').toLowerCase().startsWith('ru') ? 'ru' : 'en';
})();
const I18N_RU = {
  '(grooming mode):': '(режим «разбор бэклога»):',
  '+ add task': '+ добавить задачу',
  '+ label': '+ лейбл',
  '+ link': '+ связать',
  '/path/to/the/folder — may be empty': '/путь/к/папке — можно пусто',
  'a folder on this computer — or just a task board without one': 'папка на этом компьютере — или просто доска-список задач без папки',
  'a server project needs an SSH host and a path': 'для серверного проекта обязательны SSH-хост и путь',
  'A task is ready for review': 'Задача готова к проверке',
  'About': 'О доске',
  'action menu (status, priority, labels, duplicate…)': 'меню действий (статус, приоритет, метки, дублировать…)',
  'Active': 'Активных',
  'Activity by day': 'Активность по дням',
  'Add': 'Добавить',
  'add': 'добавить',
  'Add a label to all': 'Добавить метку всем',
  'Add a subtask': 'Добавить подзадачу',
  'Add checklist item': 'Добавить чек-бокс',
  'Add project': 'Добавить проект',
  'Add subtask': 'Добавить подзадачу',
  'Add to the board': 'Добавить на доску',
  'Add your own project with the "＋ Add project" row in the sidebar — or create a demo project with example tasks to look around. The demo can be deleted later in the project settings.': 'Заведи свой проект строкой «＋ Добавить проект» в сайдбаре — или создай демо-проект с примерами задач, чтобы осмотреться. Демо потом удаляется в настройках проекта.',
  'Add…': 'Добавить…',
  'All clear — nothing needs your decision': 'Всё разобрано — ничего не ждёт твоего решения',
  'All projects': 'Все проекты',
  'all self-healed': 'всё починилось само',
  'All set!': 'Готово!',
  'Appearance': 'Оформление',
  'applies after page reload': 'применится после перезагрузки страницы',
  'Archive': 'Архивировать',
  'at': 'от',
  'Attach a screenshot': 'Приложить скриншот',
  'attachment': 'вложение',
  'attachments:': 'вложений:',
  'audio:': 'аудио:',
  'awaiting release': 'ждут релиза',
  'Back up now': 'Сделать бэкап',
  'Backlog': 'Бэклог',
  'Backups': 'Бэкапы',
  'Bell': 'Колокольчик',
  'Blocked': 'Заблокировано',
  'blocked by autoplay': 'заблокирован автоплеем',
  'blocked flag': 'блокировка',
  'Board updates': 'Обновление доски',
  'board(s) will move to “Other”.': 'досок(и) переедут в «Прочее».',
  'Branch': 'Ветка',
  'browser': 'браузер',
  'built-in section — cannot be deleted': 'служебный раздел — удалить нельзя',
  'built-in section — the name cannot be changed': 'служебный раздел — имя менять нельзя',
  'Busiest around': 'Жарче всего около',
  'Calendar': 'Календарь',
  'Cancel': 'Отмена',
  'Cancel task': 'Отменить задачу',
  'Cancel the task': 'Отменить задачу',
  'Cancel the task? The issue will be closed as not planned.': 'Отменить задачу? Issue закроется как not planned.',
  'Cancelled': 'Отменено',
  'cannot check (no network, or the repo is private/not a git checkout)': 'не проверить (нет сети, либо репо приватный/без git)',
  'Card actions': 'Управление карточкой',
  'change status': 'сменить статус',
  'Chaos': 'Хаос',
  'Check': 'Проверить',
  'Check board is up': 'Проверочная доска поднята',
  'Check for updates': 'Проверить обновления',
  'Check the backup': 'Проверить бэкап',
  'checking git on the server…': 'проверяю git на сервере…',
  'Checking the file and starting the board…': 'Проверяю файл и поднимаю доску…',
  'checking…': 'проверяю…',
  'Chime': 'Перезвон',
  'Chord': 'Аккорд',
  'Claude can finish the setup for you — copy this and paste it into its chat:': 'Дальше настройку может провести сам Claude — скопируй это и вставь ему в чат:',
  'Claude Code skills live in skills/ — symlink or copy them into ~/.claude/skills:': 'Скиллы Claude Code лежат в папке skills/ — симлинк или копия в ~/.claude/skills:',
  'Claude is working on this task — fields are locked, comments are open': 'Задача в работе у Claude — поля заблокированы, комментарии доступны',
  'Claude will ask clarifying questions first and wait for your answer': 'Claude сперва задаст уточняющие вопросы по задаче и дождётся ответа',
  'Clear': 'Очистить',
  'Clear selection': 'Снять выделение',
  'Clear the error log?': 'Очистить журнал ошибок?',
  'Clear the log': 'Очистить журнал',
  'clear the mark': 'снять отметку',
  'Click': 'Щелчок',
  'click the rows above to assign your own shortcut (Esc cancels); the ones below are fixed': 'клик по верхним строкам — назначить свою комбинацию (Esc — отмена); нижние фиксированы',
  'click to assign your own shortcut': 'кликните, чтобы назначить свою комбинацию',
  'clone from a git URL…': 'клонировать по git-URL…',
  'cloning…': 'клонирую…',
  'Close': 'Закрыть',
  'close issue': 'закрытие issue',
  'close the card · clear the selection': 'закрыть карточку · снять выделение',
  'Close the check board': 'Закрыть проверочную доску',
  'closed': 'закрыт',
  'closes in': 'закроется через',
  'Code version': 'Версия кода',
  'comment': 'комментарий',
  'Comment…': 'Комментарий…',
  'commit': 'коммит',
  'Compact cards': 'Компактные карточки',
  'Completed': 'Доведено до конца',
  'Copied': 'Скопировано',
  'copy and paste into Claude chat — it will run the setup and ask you questions': 'скопируй и вставь Claude в чат — он проведёт настройку и задаст вопросы',
  'Copy link': 'Копировать ссылку',
  'Copy the backlog as a grooming job for Claude': 'Скопировать бэклог как задание на разбор для Claude',
  'Copy the prompt': 'Скопировать промпт',
  'Copy the tasks as a job for Claude': 'Скопировать задачи как задание для Claude',
  'could not attach': 'не удалось приложить',
  'could not attach the screenshot': 'не удалось приложить скрин',
  'could not create it': 'не удалось создать',
  'Could not duplicate': 'Не удалось дублировать',
  'Could not load the dashboard.': 'Не удалось загрузить дашборд.',
  'Create': 'Создать',
  'Create (⌘/Ctrl+Enter)': 'Создать (⌘/Ctrl+Enter)',
  'Create a project folder': 'Создать папку проекта',
  'Create an example project with tasks in every column? It shows links, checklists and labels, and can be deleted with one click in the project settings.': 'Создать проект-пример с задачами по всем колонкам? Он показывает связи, чек-листы и метки, и удаляется одной кнопкой в настройках проекта.',
  'Create demo': 'Создать демо',
  'Create demo project': 'Создать демо-проект',
  'create issue': 'создание issue',
  'Created': 'Создана',
  'created': 'создано',
  'creating issue…': 'issue создаётся…',
  'creating…': 'создаю…',
  'Custom deploy skill': 'Свой deploy-скилл',
  'd': 'д',
  'd ago': 'д назад',
  'Dark': 'Тёмная',
  'Dashboard': 'Дашборд',
  'Database': 'База данных',
  'Database backups': 'Бэкапы базы',
  'Database path': 'Путь к базе',
  'Days': 'Дни',
  'Default dashboard range': 'Окно дашборда по умолчанию',
  'Delete': 'Удалить',
  'delete': 'удалить',
  'Delete demo project entirely': 'Удалить демо-проект целиком',
  'delete issue': 'удаление issue',
  'delete item': 'удалить пункт',
  'Delete section': 'Удалить раздел',
  'Delete the comment': 'Удалить комментарий',
  'Delete the comment?': 'Удалить комментарий?',
  'Delete the demo project and all its tasks?': 'Удалить демо-проект со всеми его задачами?',
  'delete the selected cards / the one under the cursor': 'удалить выбранные / карточку под курсором',
  'delete the selection / the card under the cursor': 'удалить выбранные / карточку под курсором',
  'Delete the task permanently (comments included)?': 'Удалить задачу навсегда (вместе с комментариями)?',
  'Demo project': 'Демо-проект',
  'Deploy skill': 'Deploy-скилл',
  'Deploying': 'Деплою',
  'Description': 'Описание',
  'Description…': 'Описание…',
  'Details are in the README. Enjoy!': 'Подробности — в README. Хорошей работы!',
  'dev branch': 'Ветка dev',
  'dev has no commits beyond main': 'в dev нет коммитов сверх main',
  'Diagnostics': 'Диагностика',
  'did not work': 'не получилось',
  'Did not work out': 'Не получилось',
  'did not work — select and copy manually': 'не вышло — выдели и скопируй вручную',
  'Ding': 'Динь',
  'Do the tasks from': 'Сделай задачи из',
  'Do the tasks with the to-do status:': 'Сделай задачи со статусом сделать:',
  'Doing': 'Делаю',
  'Domain': 'Домен',
  'Domain (to verify after deploy)': 'Домен (для проверки после деплоя)',
  'Done': 'Готово',
  'Done by day': 'Сделано по дням',
  'Done in the last 7 days': 'Готово за последние 7 дней',
  'Download backup': 'Скачать бэкап',
  'draw lines between linked cards; when off, links show as a chain badge': 'рисовать линии между связанными карточками; выключены — связь видна значком-звеном',
  'Drop': 'Капля',
  'Duplicate': 'Дублировать',
  'edit issue': 'правка issue',
  'empty': 'пусто',
  'empty = no deploy / deploy = the generic one': 'пусто = без деплоя / deploy = универсальный',
  'empty — sync is off, the board runs locally': 'пусто — синк выключен, доска работает локально',
  'Enable sync': 'Включить синк',
  'enter the folder path…': 'путь к папке вручную…',
  'Errors': 'Ошибки',
  'errors': 'ошибок',
  'events': 'событ.',
  'Every task can be mirrored to an issue and every project to a GitHub Project. Requires the gh CLI authenticated with the project scope (gh auth login && gh auth refresh -s project). You can also enable this later in Settings.': 'Каждая задача может зеркалиться в issue, а проект — в GitHub Project. Нужен установленный gh CLI с правом project (gh auth login && gh auth refresh -s project). Это можно включить и позже — в Настройках.',
  'Everything lands here: a server failure, a failed sync op, an error in the browser. Empty means the board runs clean.': 'Сюда попадает всё: сбой сервера, упавшая синхронизация, ошибка в браузере. Пусто — значит доска работает без сбоев.',
  'everything synced ✓': 'всё синхронизировано ✓',
  'failed in the queue': 'ошибок в очереди',
  'File': 'Файл',
  'folder': 'папка',
  'folder is gone — click to archive': 'папка удалена — клик чтобы архивировать',
  'Fri': 'Пт',
  'from': 'от',
  'from created to done': 'от создания до готово',
  'General': 'Основные',
  'gh CLI found and authenticated ✓': 'gh CLI найден и авторизован ✓',
  'gh CLI missing or not authenticated — you can enable sync later': 'gh CLI не найден или не авторизован — синк можно включить позже',
  'GitHub is not set up (gh auth needed)': 'GitHub не настроен (нужен gh auth)',
  'GitHub sync': 'Синхронизация с GitHub',
  'GitHub sync (optional)': 'Синхронизация с GitHub (опционально)',
  'GitHub sync queue': 'Очередь синка с GitHub',
  'give the folder path': 'укажи путь к папке',
  'give the git URL': 'укажи git-URL',
  'Go to project': 'Перейти к проекту',
  'goal': 'цель',
  'Goal for the day': 'Цель на день',
  'goals by time horizon': 'цели по периодам времени',
  'Got it': 'Понятно',
  'Groom the backlog (grooming mode):': 'Разбери бэклог (режим «разбор бэклога»):',
  'Groom the backlog of': 'Разбери бэклог из',
  'h': 'ч',
  'h ago': 'ч назад',
  'h without movement': 'ч без движения',
  'Half a year': 'Полгода',
  'hide the description preview — more cards fit on screen': 'скрывать превью описания — на экран влезает больше',
  'Hide the project from the list': 'Скрыть проект из списка',
  'high': 'высокий',
  'Horizon': 'Горизонт',
  'Hotkeys': 'Горячие клавиши',
  'in 6 months': 'за полгода',
  'in dev': 'в dev',
  'in review — waiting for you': 'на проверке — ждёт тебя',
  'in the backlog': 'в бэклоге',
  'Install the kb command for Claude like this:': 'Команда kb для Claude ставится так:',
  'Interface language': 'Язык интерфейса',
  'is gone from disk. Archive the project? Tasks are kept.': 'удалена с диска. Архивировать проект? Задачи сохранятся.',
  'it has to go through work first': 'сначала через работу',
  'It will be checked and opened as a SEPARATE board on a neighbouring port. This board and its tasks will not change.': 'Он будет проверен и открыт ОТДЕЛЬНОЙ доской на соседнем порту. Текущая доска и её задачи не изменятся.',
  'item': 'пункт',
  'Jot a task down quickly — it lands in the project you pick.': 'Быстро запиши задачу — она уйдёт в выбранный проект.',
  'just now': 'только что',
  'keep changes local and catch up with GitHub later': 'копить изменения локально и догнать GitHub позже',
  'keep the right panel visible even with no task selected': 'держать панель справа, даже когда задача не выбрана',
  'Key (slug + task prefix)': 'Ключ (slug + префикс задач)',
  'key: lowercase latin letters, digits and hyphens': 'ключ: латиница строчными, цифры и дефис',
  'Label': 'Метка',
  'Labels': 'Метки',
  'labels': 'метки',
  'last 7 days:': 'за 7 дней:',
  'last at': 'последний в',
  'Last opened': 'Последний открытый',
  'last successful sync:': 'последний успешный синк:',
  'less': 'меньше',
  'Let’s jot down some tasks?': 'Накидаем задач?',
  'Life': 'Жизнь',
  'Light': 'Светлая',
  'light, dark or in Claude colors': 'светлая, тёмная или в цветах Claude',
  'line break in the comment field': 'перенос строки в поле комментария',
  'Link': 'Связать',
  'Link a parent task': 'Связать родительскую задачу',
  'Link a task': 'Связать задачу',
  'Link lines': 'Линии связей',
  'Link parent task': 'Связать родительскую задачу',
  'Link task': 'Связать задачу',
  'linked to:': 'связано:',
  'Local': 'Локальные',
  'Local + server': 'Локальный + сервер',
  'local copy of the code + deploy to a server over ssh': 'локальная копия кода + деплой на сервер по ssh',
  'Local folder': 'Локальная папка',
  'Local project': 'Локальный',
  'Lock off: the choice resets after creating': 'Замок выключен: после создания выбор сбрасывается',
  'Lock on: status/priority/labels are kept after creating': 'Замок включён: статус/приоритет/метки сохраняются после создания',
  'Lock the selection': 'Замок выбора',
  'low': 'низкий',
  'm': 'м',
  'm ago': 'м назад',
  'mark as done': 'отметить выполненным',
  'matches GitHub': 'совпадает с GitHub',
  'matches main ✓': 'совпадает с main ✓',
  'max': 'макс',
  'MB': 'МБ',
  'me': 'я',
  'medium': 'средний',
  'min': 'мин',
  'Mon': 'Пн',
  'Month': 'Месяц',
  'Months': 'Месяцы',
  'more': 'больше',
  'move a card (between columns / by position)': 'перенести карточку (между колонками / по позиции)',
  'move the selection across cards': 'перемещать выделение по карточкам',
  'Move to status': 'Перевести в статус',
  'Name': 'Имя',
  'name (created in ~/claude-projects)': 'имя (создастся в ~/claude-projects)',
  'name of the new section': 'название нового раздела',
  'needs attention': 'требует внимания',
  'new': 'новая',
  'new folder': 'новая папка',
  'New project folder': 'Новая папка проекта',
  'New section': 'Новый раздел',
  'New section…': 'Новый раздел…',
  'new task': 'новая задача',
  'New task +': 'Новая задача +',
  'New task in': 'Новая задача в',
  'new tasks go to “Backlog” or “To do” only': 'новую задачу заводим только в «Бэклог» или «Сделать»',
  'Next': 'Далее',
  'next project (in the sidebar)': 'следующий проект (в сайдбаре)',
  'no activity yet': 'пока нет событий',
  'no backups yet': 'пока нет бэкапов',
  'no errors ✓': 'ошибок не было ✓',
  'no folder — just a task list': 'без папки — просто список задач',
  'no git on the server — the project was not created': 'на сервере нет git — проект не создан',
  'No git repository on the server at': 'На сервере нет git-репозитория в',
  'no label': 'без метки',
  'no local copy — Claude works over ssh; git required on the server': 'без локальной копии — Claude работает по ssh; на сервере нужен git',
  'no manual tasks in backlog/to do yet': 'пока нет ручных задач в бэклоге/сделать',
  'no movement — the chat is probably closed': 'нет движения — чат, вероятно, закрыт',
  'no priority': 'без приоритета',
  'No priority': 'Без приоритета',
  'No sound': 'Без звука',
  'no successful syncs yet': 'успешных синков ещё не было',
  'noclaude label — done by hand': 'Метка noclaude — сделано вручную',
  'not created': 'не создан',
  'not on the board yet': 'ещё не на доске',
  'not saved': 'не сохранилось',
  'nothing finished yet': 'пока нет завершённых задач',
  'nothing found': 'ничего не найдено',
  'of': 'из',
  'Open': 'Открыть',
  'open the all-projects board': 'открыть доску всех проектов',
  'open the selected card': 'открыть выделенную карточку',
  'Or do it by hand. Everything is already installed with the package:': 'Или руками. Всё уже приехало вместе с пакетом:',
  'Or do it by hand. Install the kb command for Claude like this:': 'Или руками. Команда kb для Claude ставится так:',
  'Other': 'Прочее',
  'owner (GitHub user)': 'owner (юзер GitHub)',
  'Owner and issues repository': 'Owner и репозиторий issues',
  'owner/repo for issues': 'owner/repo для issues',
  'page loaded at': 'страница загружена в',
  'parent task': 'родительская задача',
  'paste a screenshot into the open task or a comment': 'вставить скриншот в открытую задачу или комментарий',
  'Paths & deploy ▴': 'Пути и деплой ▴',
  'Paths & deploy ▾': 'Пути и деплой ▾',
  'Pause sync': 'Пауза синка',
  'permanently?': 'навсегда?',
  'pick a project': 'выбери проект',
  'pick a project first': 'сначала выбери проект',
  'piling up': 'копится',
  'Pin': 'Закрепить',
  'Pin to board': 'Закрепить на доске',
  'Pin to the top': 'Закрепить наверху',
  'Pinned': 'Закреплённые',
  'pinned': 'закреплён',
  'Planning': 'Планирование',
  'pm2 processes (comma-separated)': 'pm2-процессы (через запятую)',
  'Pop': 'Поп',
  'Prep': 'Подготовка',
  'press a key…': 'нажмите…',
  'previous project (in the sidebar)': 'предыдущий проект (в сайдбаре)',
  'Priority': 'Приоритет',
  'priority': 'приоритет',
  'priority:': 'приоритет:',
  'Priority:': 'Приоритет:',
  'Priority: none': 'Приоритет: нет',
  'project': 'проект',
  'Project code': 'Код проекта',
  'Project key': 'Код проекта',
  'Project name': 'Имя проекта',
  'Project settings': 'Настройки проекта',
  'Projects': 'Проекты',
  'projects': 'проектов',
  'queued': 'в очереди',
  'queued and in progress': 'в очереди и работе',
  'quick task capture': 'быстрое создание задач',
  're-read branch state from GitHub': 'перечитать состояние веток с GitHub',
  're-read the board code right now': 'перечитать код доски прямо сейчас',
  'ready to work on': 'готовы к работе',
  'Recent activity': 'Последние события',
  'Recent errors': 'Последние ошибки',
  'recovered on retry': 'починилось повторной попыткой',
  'related': 'связана',
  'Reload now': 'Обновить сейчас',
  'Reload the page': 'Обновить страницу',
  'remove': 'убрать',
  'remove link': 'убрать связь',
  'reopen issue': 'переоткрытие issue',
  'Reset to defaults': 'Сбросить по умолчанию',
  'Retry failed': 'Повторить ошибки',
  'Return to work': 'Вернуть в работу',
  'Review': 'Проверяю',
  'Review notifications': 'Уведомления о проверке',
  'right-click on a card': 'правый клик по карточке',
  'Run git init? Without git a server project cannot be created.': 'Инициализировать git init? Без git серверный проект не заводится.',
  'Run the kanban skill': 'Запусти скилл kanban',
  'running': 'работает',
  'running out of tasks soon — time to plan': 'скоро встанет без задач — пора планировать',
  'Russian': 'Русский',
  's ago': 'с назад',
  'Sat': 'Сб',
  'Save': 'Сохранить',
  'save edits in the open card': 'сохранить правки в открытой карточке',
  'screenshot': 'скрин',
  'search boards…': 'поиск доски…',
  'Search tasks…': 'Поиск задач…',
  'Search, or the title of a new task…': 'Поиск или заголовок новой задачи…',
  'Section': 'Раздел',
  'section name': 'название раздела',
  'Sections': 'Разделы',
  'Sections group boards in the sidebar. A new name applies to every board in the section.': 'Разделы группируют доски в сайдбаре. Новое имя применится ко всем доскам раздела.',
  'Select a task — details will show up here': 'Выберите задачу — её детали появятся здесь',
  'Selected': 'Выбрано',
  'self-healed': 'починилось само',
  'Send back': 'Вернуть',
  'server': 'сервер',
  'Server only': 'Только сервер',
  'Server path': 'Путь на сервере',
  'server signal:': 'сигнал сервера:',
  'Server uptime': 'Аптайм сервера',
  'set via env KB_GH_OWNER/KB_GH_REPO — edit your launch config': 'задано через env KB_GH_OWNER/KB_GH_REPO — правится в конфиге запуска',
  'Settings': 'Настройки',
  'Setup via Claude': 'Настройка через Claude',
  'Skip': 'Пропустить',
  'Skip — work locally': 'Пропустить — работать локально',
  'Sound diagnostics': 'Диагностика звука',
  'Sound for Done': 'Звук на «Готово»',
  'Sound for Review': 'Звук на «Проверяю»',
  'Sound notifications': 'Звуковые уведомления',
  'sound off': 'звук выкл',
  'sound on Review and Done': 'звук при «Проверяю» и «Готово»',
  'sounds missed:': 'пропущено звуков:',
  'ssh alias or address': 'алиас/адрес для ssh',
  'SSH host': 'SSH-хост',
  'Stalled': 'Висит',
  'Start screen': 'Стартовый экран',
  'Start working': 'Начать работу',
  'Status': 'Статус',
  'Streak': 'Серия',
  'status': 'статус',
  'Status:': 'Статус:',
  'stuck': 'висит',
  'subtask': 'подзадача',
  'Sun': 'Вс',
  'Sync': 'Синхронизация',
  'sync': 'синк',
  'sync is off — the board runs locally': 'синк выключен — доска работает локально',
  'sync paused': 'синк на паузе',
  'sync: ok': 'синк: ок',
  'System': 'Системная',
  'system notification when a task reaches Review': 'системное уведомление, когда задача уезжает в «Проверяю»',
  'tag': 'тег',
  'taken': 'занято',
  'Task cycle': 'Цикл задачи',
  'Task sidebar always open': 'Сайдбар задачи всегда открыт',
  'Task title': 'Заголовок задачи',
  'tasks': 'задач',
  'Tasks are kept, the project leaves the list.': 'Задачи сохранятся, проект скроется из списка.',
  'Tasks closed:': 'Закрыто задач:',
  'Tasks · projects': 'Задач · проектов',
  'the arrow keys are taken': 'стрелки заняты',
  'The board is empty': 'Доска пока пустая',
  'the board is fresh ✓': 'доска свежая ✓',
  'the kb command came with it, and the wizard copied the Claude Code skills into ~/.claude/skills. To update later:': 'команда kb приехала вместе с ним, а скиллы Claude Code мастер скопировал в ~/.claude/skills. Обновиться потом:',
  'The browser blocked sound until the first click — click to enable': 'Браузер заблокировал звук до первого клика — нажмите, чтобы включить',
  'the fix commit': 'коммит исправления',
  'The project folder': 'Папка проекта',
  'the project needs a name': 'нужно имя проекта',
  'The uploaded file opens as a separate board on a neighbouring port — this board and its tasks stay untouched.': 'Загруженный файл откроется отдельной доской на соседнем порту — текущая доска и её задачи не меняются.',
  'Theme': 'Тема',
  'This is a local kanban board built to work in tandem with Claude Code. A couple of steps and you are ready.': 'Это локальная канбан-доска для работы в паре с Claude Code. Пара шагов — и можно работать.',
  'this month': 'за месяц',
  'This snapshot has already been rotated out — refreshing the list.': 'Этот снимок уже удалён ротацией — обновляю список.',
  'this takes a few seconds': 'это занимает несколько секунд',
  'this week': 'за неделю',
  'this year': 'за год',
  'Thu': 'Чт',
  'time spent': 'время в работе',
  'To do': 'Сделать',
  'Today': 'Сегодня',
  'Top projects': 'Топ проектов',
  'Tue': 'Вт',
  'Unpin': 'Открепить',
  'unresolved': 'без ответа',
  'untitled': 'без названия',
  'up to date ✓': 'последняя версия ✓',
  'update available': 'есть обновление',
  'update with: npm run update': 'обнови командой: npm run update',
  'Upload': 'Загрузить',
  'Waiting for you': 'Ждёт тебя',
  'Wed': 'Ср',
  'Week': 'Неделя',
  'Weeks': 'Недели',
  'Welcome!': 'Добро пожаловать!',
  'went back to work': 'возвращалась в работу',
  'Show the rest': 'Развернуть остальные',
  Collapse: 'Свернуть',
  'What are we working on?': 'Чем займёмся?',
  'What do we note before it slips?': 'Что запишем, пока не забыл?',
  'What do we take on?': 'За что возьмёмся?',
  'What goes into the queue?': 'Что закинем в работу?',
  'What is wrong? (goes into the task)': 'Что не так? (попадёт в задачу)',
  'What needs doing?': 'Что нужно сделать?',
  'What shall we turn into a task?': 'Что превратим в задачу?',
  'what this project is, notes…': 'что за проект, заметки…',
  'what to do': 'что сделать',
  'what to open on launch': 'что открывать при запуске',
  'What’s on for today?': 'Что на сегодня?',
  'What’s on your mind?': 'Что не даёт покоя?',
  'When work happens': 'Когда идёт работа',
  'Where do we start?': 'С чего начнём?',
  'Which chaos do we sort out?': 'Какой хаос разгребём?',
  'with the to-do status:': 'со статусом сделать:',
  'Work time': 'Время в работе',
  'working columns are moved by Claude only': 'рабочие колонки двигает только Claude',
  'Year': 'Год',
  'Years': 'Годы',
  'Yesterday': 'Вчера',
  '“Ready to work on” are tasks in the To do column — they can be picked up right now. “In the backlog” are ideas not yet selected for work.': '«Готово к работе» — задачи в колонке «Сделать», их можно брать сейчас. «В бэклоге» — идеи, ещё не отобранные в работу.',
  '‹ Back': '‹ Назад',
  '↑ High': '↑ Высокий',
  '↓ Low': '↓ Низкий',
  '↩ Send back to work': '↩ Вернуть в работу',
  '✓ Accept task': '✓ Принять задачу',
  '⟳ a new version is available': '⟳ доступна новая версия',
  '＋ Add project': '＋ Добавить проект',
  '＋ New section': '＋ Новый раздел',
  '＝ Medium': '＝ Средний',
};
export function tr(s) { return LANG === 'ru' ? (I18N_RU[s] ?? s) : s; }

for (const [was, now] of [['kb.slug', 'kb.ui.project'], ['kb.lastProject', 'kb.ui.lastProject']]) {
  const v = localStorage.getItem(was);
  if (v !== null && localStorage.getItem(now) === null) localStorage.setItem(now, v);
  if (v !== null) localStorage.removeItem(was);
}

// static strings of index.html are English in the markup; this patches them to Russian
// (the script loads at the end of body, so the DOM is already there)
function applyLang() {
  if (LANG !== 'ru') return;
  document.documentElement.lang = 'ru';
  const set = (sel, prop, src) => { const el = document.querySelector(sel); if (el) el[prop] = tr(src); };
  set('.sidebar-head', 'textContent', 'Projects');
  set('#search', 'placeholder', 'Search tasks…');
  set('#new-task', 'textContent', 'New task +');
  set('#sound-badge', 'innerHTML', `${ic('soundOff', 13)} ${esc(tr('sound off'))}`);
  set('#drawer-empty', 'textContent', 'Select a task — details will show up here');
  set('#d-lock-note', 'innerHTML', `${ic('lock', 13)} ${esc(tr('Claude is working on this task — fields are locked, comments are open'))}`);
  set('#d-title', 'placeholder', 'Task title');
  set('#d-desc', 'placeholder', 'Description…');
  set('#c-input', 'placeholder', 'Comment…');
  set('#d-accept-btn', 'textContent', '✓ Accept task');
  set('#d-return-icon', 'title', 'Return to work');
  set('#drawer-menu', 'title', 'Card actions');
  set('#drawer-close', 'title', 'Close');
  set('#project-menu', 'title', 'Project settings');
  set('#d-checklist-add', 'title', 'Add checklist item');
  set('#week-stats', 'title', 'Done in the last 7 days');
  set('#sound-badge', 'title', 'The browser blocked sound until the first click — click to enable');
  set('#sync-badge', 'title', 'GitHub sync queue');
}
applyLang();

export const ALL_STATUSES = [
  ['backlog', tr('Backlog')],
  ['todo', tr('To do')],
  ['prep', tr('Prep')],
  ['doing', tr('Doing')],
  ['deploy', tr('Deploying')],
  ['review', tr('Review')],
  ['done', tr('Done')],
  ['cancelled', tr('Cancelled')],
];
export const PRI_ICON = { 1: ['↓', 'p1', tr('low')], 2: ['＝', 'p2', tr('medium')], 3: ['↑', 'p3', tr('high')] };
export const PRI_LEVELS = [[3, tr('↑ High')], [2, tr('＝ Medium')], [1, tr('↓ Low')], [0, tr('No priority')]];
export let LABEL_COLORS = {};
export let LABEL_SELECTABLE = [];
export async function loadLabelPalette() {
  const d = await api('GET', '/api/labels');
  LABEL_COLORS = d.palette || {};
  LABEL_SELECTABLE = d.selectable || [];
}
export const TITLE_LABEL_WORDS = {
  баг: 'bug', bug: 'bug',
  фича: 'feature', feature: 'feature', фикча: 'feature',
  ui: 'ui', юай: 'ui', юй: 'ui',
  доки: 'documentation', docs: 'documentation', документация: 'documentation', дока: 'documentation',
  вопрос: 'question', question: 'question',
  noclaude: 'noclaude', руками: 'noclaude', вручную: 'noclaude',
};
export const DONE_LIMIT = 30;
export const ALL = '*';
export const DASH = '#dash';
export const SETTINGS = '#settings';
export const HORIZON = '#horizon';
export const CALENDAR = '#calendar';
export const CHAOS = '#chaos';
export const HIDDEN_SECTIONS = [HORIZON, CALENDAR];
export const SIDEBAR_SECTIONS = [[HORIZON, 'Horizon'], [CALENDAR, 'Calendar'], [CHAOS, 'Chaos']]
  .filter(([slug]) => !HIDDEN_SECTIONS.includes(slug))
  .map(([slug, name]) => [slug, tr(name)]);

export const state = {
  projects: [], slug: DASH,
  tasks: [], drawerKey: null, search: '',
  folders: { unregistered: [], missing: [] },
  categories: [],
  dashRange: 'week',
  kbCursor: null,
};

export function $(id) { return document.getElementById(id); }

export const SETUP_PROMPT = {
  ru: `Запусти скилл kanban.

Ты помогаешь мне настроить только что установленную доску local-kanban. Проведи настройку сам, задавая мне вопросы ПО ОДНОМУ и дожидаясь ответа — не додумывай за меня.

1. Проверь, что команда kb работает (kb p). Если нет — скажи, что выполнить, и дождись меня.
2. Спроси, зеркалить ли задачи в GitHub. Если да — проверь gh auth status и право project, спроси owner и репозиторий, включи синк и убедись, что очередь не встала (kb sync).
3. Спроси, какие проекты завести. По каждому уточни: имя, где лежит код, есть ли сервер и деплой. Заведи их и покажи kb info по каждому.
4. В конце покажи, что получилось, и коротко объясни рабочий цикл: я планирую и принимаю задачи, ты берёшь их из очереди и доводишь до «Проверяю».

Мои файлы и серверы без вопроса не трогай.`,
  en: `Run the kanban skill.

You are helping me set up a freshly installed local-kanban board. Run the setup yourself, asking me questions ONE AT A TIME and waiting for the answer — do not assume anything on my behalf.

1. Check that the kb command works (kb p). If it does not, tell me what to run and wait for me.
2. Ask whether to mirror tasks to GitHub. If yes, check gh auth status and the project scope, ask for the owner and repository, enable sync and confirm the queue is moving (kb sync).
3. Ask which projects to register. For each one, ask: name, where the code lives, whether there is a server and a deploy. Register them and show me kb info for each.
4. At the end, show what we got and briefly explain the loop: I plan and accept tasks, you take them from the queue and bring them to Review.

Do not touch my files or servers without asking.`,
};
export const setupPrompt = () => SETUP_PROMPT[LANG] || SETUP_PROMPT.ru;

export const seg = (s) => encodeURIComponent(String(s));
export let ghSyncOn = true;
const reportedErrors = new Map();
const REPORT_WINDOW_MS = 10000;
function reportError(scope, message, detail) {
  const msg = String(message || '').slice(0, 500);
  if (!msg) return;
  const now = Date.now();
  if (now - (reportedErrors.get(msg) || 0) < REPORT_WINDOW_MS) return;
  for (const [k, at] of reportedErrors) { if (now - at >= REPORT_WINDOW_MS) reportedErrors.delete(k); }
  reportedErrors.set(msg, now);
  fetch('/api/errors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scope, message: msg, detail: detail ? String(detail).slice(0, 2000) : null }),
  }).catch(() => {  });
}
window.addEventListener('error', (e) => reportError(e.filename ? `${e.filename}:${e.lineno}` : 'window.onerror', e.message, e.error?.stack));
window.addEventListener('unhandledrejection', (e) => reportError('unhandledrejection', e.reason?.message || String(e.reason), e.reason?.stack));

export const apiBlob = async (path, blob, opts = {}) => {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': blob.type }, body: blob })
    .catch((e) => { if (!opts.quiet) reportError(`POST ${path}`, `network: ${e.message}`); throw e; });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (!opts.quiet) reportError(`POST ${path}`, `HTTP ${res.status}: ${data.error || ''}`.trim());
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
};

export const api = async (method, path, body, opts = {}) => {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).catch((e) => { if (!opts.quiet) reportError(`${method} ${path}`, `network: ${e.message}`); throw e; });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (!opts.quiet && path !== '/api/errors') reportError(`${method} ${path}`, `HTTP ${res.status}: ${data.error || ''}`.trim());
    throw new Error(data.error || res.status);
  }
  return data;
};
