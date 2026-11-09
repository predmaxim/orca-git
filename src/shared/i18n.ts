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
  refresh: 'Refresh',
  fetch: 'Fetch',
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
  refresh: 'Обновить',
  fetch: 'Получить',
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
