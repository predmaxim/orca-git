// English and Russian message catalogs. Imports nothing: shared by the frame and the worker.
export type Locale = 'en' | 'ru'

type Plural = { one: string; few?: string; many?: string; other: string }
type Message = string | Plural

export const en = {
  commitsSelected: { one: '{count} commit selected', other: '{count} commits selected' },
  sectionBranches: 'Branches',
  sectionCommits: 'Commits',
  sectionFiles: 'Files',
  sectionDetails: 'Details',
  selectedCount: { one: '{count} selected', other: '{count} selected' },
  filesPlaceholder: 'Select commits to see their files',
  detailsPlaceholder: 'Select a commit to see its details',
  commitsCount: { one: '{count} commit', other: '{count} commits' },
  detailsCommittedBy: 'committed by {name} on {date}',
  detailsParents: { one: 'Parent', other: 'Parents' },
  detailsBranches: { one: 'In {n} branch', other: 'In {n} branches' },
  detailsNoBranches: 'Not in any branch',
  filesCount: { one: '{count} file', other: '{count} files' },
  expandAll: 'Expand all',
  collapseAll: 'Collapse all',
  refresh: 'Refresh',
  fetch: 'Fetch',
  diffSelectFile: 'Select a file to see its changes',
  diffPrevChange: '↑ Change',
  diffNextChange: '↓ Change',
  diffPrevChangeTip: 'Previous change (Shift+F7)',
  diffNextChangeTip: 'Next change (F7)',
  diffPrevFile: 'Previous file (Alt+↑)',
  diffNextFile: 'Next file (Alt+↓)',
  diffFileCounter: '{index}/{count} files',
  diffSplit: 'Split',
  diffUnified: 'Unified',
  diffSplitTip: 'Show the two versions side by side',
  diffUnifiedTip: 'Show the changes in one column',
  diffWholeFile: 'Whole file',
  diffWholeFileTip: 'Show the whole file instead of the changed regions',
  diffFromEmpty: 'empty',
  diffBinary: 'Binary file',
  diffRenamedOnly: 'File renamed without content changes.',
  diffNoChanges: 'No content changes.',
  diffTruncated: 'This diff is too large: only the beginning is shown.',
  diffLoading: 'Loading…',
  openInTab: 'Open in editor tab'
} satisfies Record<string, Message>

export const ru: Record<keyof typeof en, Message> = {
  commitsSelected: {
    one: 'Выбран {count} коммит',
    few: 'Выбрано {count} коммита',
    many: 'Выбрано {count} коммитов',
    other: 'Выбрано {count} коммита'
  },
  sectionBranches: 'Ветки',
  sectionCommits: 'Коммиты',
  sectionFiles: 'Файлы',
  sectionDetails: 'Описание',
  selectedCount: { one: '{count} выбран', few: '{count} выбрано', many: '{count} выбрано', other: '{count} выбрано' },
  filesPlaceholder: 'Выберите коммиты, чтобы увидеть их файлы',
  detailsPlaceholder: 'Выберите коммит, чтобы увидеть его описание',
  commitsCount: { one: '{count} коммит', few: '{count} коммита', many: '{count} коммитов', other: '{count} коммита' },
  detailsCommittedBy: 'закоммитил {name}, {date}',
  detailsParents: { one: 'Родитель', few: 'Родители', many: 'Родители', other: 'Родители' },
  detailsBranches: { one: 'В {n} ветке', few: 'В {n} ветках', many: 'В {n} ветках', other: 'В {n} ветках' },
  detailsNoBranches: 'Не входит ни в одну ветку',
  filesCount: { one: '{count} файл', few: '{count} файла', many: '{count} файлов', other: '{count} файла' },
  expandAll: 'Развернуть всё',
  collapseAll: 'Свернуть всё',
  refresh: 'Обновить',
  fetch: 'Получить',
  diffSelectFile: 'Выберите файл, чтобы увидеть его изменения',
  diffPrevChange: '↑ Изменение',
  diffNextChange: '↓ Изменение',
  diffPrevChangeTip: 'Предыдущее изменение (Shift+F7)',
  diffNextChangeTip: 'Следующее изменение (F7)',
  diffPrevFile: 'Предыдущий файл (Alt+↑)',
  diffNextFile: 'Следующий файл (Alt+↓)',
  diffFileCounter: '{index}/{count} файлов',
  diffSplit: 'Рядом',
  diffUnified: 'Вместе',
  diffSplitTip: 'Показать две версии рядом',
  diffUnifiedTip: 'Показать изменения в одной колонке',
  diffWholeFile: 'Весь файл',
  diffWholeFileTip: 'Показать весь файл, а не только изменённые места',
  diffFromEmpty: 'пусто',
  diffBinary: 'Двоичный файл',
  diffRenamedOnly: 'Файл переименован, содержимое не изменилось.',
  diffNoChanges: 'Содержимое не изменилось.',
  diffTruncated: 'Дифф слишком большой: показано только начало.',
  diffLoading: 'Загрузка…',
  openInTab: 'Открыть во вкладке'
}

export type MessageKey = keyof typeof en

// Module-level: the worker sets it per request, so concurrent requests in different languages can race.
let current: Locale = 'en'

export const pickLocale = (tag: string | undefined): Locale => (/^ru(-|_|$)/i.test(tag ?? '') ? 'ru' : 'en')
export const setLocale = (locale: Locale): void => {
  current = locale
}
export const getLocale = (): Locale => current

export function t(key: MessageKey, params: Record<string, string | number> = {}): string {
  const catalog = (current === 'ru' ? ru : en) as Record<string, Message>
  let message = catalog[key] ?? (en as Record<string, Message>)[key]
  if (typeof message === 'object') {
    const form = new Intl.PluralRules(current).select(Number(params.count))
    message = message[form as keyof Plural] ?? message.other
  }
  return message.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole))
}
