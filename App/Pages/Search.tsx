/**
 * Search page
 * @param args Arguments
 * @param args.query Search query
 * @param args.sort Sort order
 * @param args.page Current page number
 * @param args.numPages Number of result pages
 * @param args.total Number of results
 * @param args.results Galleries on this page
 * @param args.error Error message when the search failed
 * @param args.api API origin, for tag suggestions
 * @param args.t Translation function
 * @returns Object containing the page title, description and content
 */
import Preferences from '../Components/Preferences'
import suggestStrings from '../Components/SuggestStrings'

// prettier-ignore
export default (args: {
  query: string
  sort: string
  page: number
  numPages: number
  total: number
  results: { id: number; title: string; thumbnail: string; width: number; height: number; pages: number }[]
  error?: string
  api: string
  language?: string
  languages?: { code: string; name: string; symbol: string; tag: string }[]
  locale?: string
  t: (key: string) => string
  tr: (section: string, key: string) => string
  script: (name: string) => string
}) => {
  const t = args.t
  const number = new Intl.NumberFormat(args.locale || 'en-US')

  const sorts = [
    ['date', t('Recent')],
    ['popular-today', t('Popular today')],
    ['popular-week', t('Popular this week')],
    ['popular-month', t('Popular this month')],
    ['popular', t('Popular all time')]
  ]

  const pageLink = (page: number) => {
    const params = new URLSearchParams({ q: args.query })
    if (args.sort !== 'date') params.set('sort', args.sort)
    if (page > 1) params.set('page', String(page))
    return `/search?${params}`
  }

  const fieldStyle = { backgroundColor: 'var(--background_color)', color: 'var(--text_color)', border: '0.1rem solid var(--text_color)', borderRadius: '0.25rem', fontSize: '1.1rem', padding: '0.4rem 0.5rem' }

  const pageNav = (page: number, label: string, rel?: string) =>
    page >= 1 && page <= args.numPages && page !== args.page
      ? <a className="text" href={pageLink(page)} rel={rel}>{label}</a>
      : <span className="text pagination-disabled">{label}</span>

  // Strings for the card download queue in Server/Scripts/Search.ts
  const cardStrings = JSON.stringify({
    packing: t('Packing…'),
    failed: t('Download failed, click to try again'),
    queued: t('Queued'),
    rateLimited: t('Too many downloads at once. Waiting a minute before continuing…'),
    busy: t('Server busy or rate limited. Try again later.'),
    missing: t('{count} pages missing'),
    all: t('Download all on this page'),
    allRunning: t('Downloading this page…')
  })

  return {
    title: args.query ? `nZip | ${t('Search')}: ${args.query}` : `nZip | ${t('Search')}`,
    description: t('Search doujinshi and download them as an archive.'),
    noindex: true,
    content: (
      <>
        <Preferences tr={args.tr} language={args.language} languages={args.languages} />
        <main style={{ maxWidth: '80rem', margin: '0 auto', padding: '1rem 4rem 1rem 1rem' }}>
          <h1 className="visually-hidden">{args.query ? `${t('Search')}: ${args.query}` : t('Search')}</h1>
          <form action="/search" method="get" role="search" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
            <a href="/" className="text" style={{ fontSize: '2rem', fontWeight: 'bold', textDecoration: 'none', textWrap: 'nowrap' }}>
              <span style={{ color: '#d83e57ff' }}>n</span>Zip
            </a>
            <div style={{ flex: '1', minWidth: '12rem' }}>
              <input name="q" type="search" value={args.query} placeholder={t('Search')} aria-label={t('Search')} autocomplete="off" autocapitalize="off" spellcheck={false} data-api={args.api} data-suggest={suggestStrings(args.tr)} style={{ ...fieldStyle, width: '100%', boxSizing: 'border-box' }} />
            </div>
            <select name="sort" aria-label={t('Sort')} style={fieldStyle}>
              {sorts.map(([value, label]) => <option value={value} selected={value === args.sort}>{label}</option>)}
            </select>
            <button type="submit" className="text" style={{ ...fieldStyle, cursor: 'pointer' }}>{t('Search')}</button>
          </form>

          {args.error && <p className="text" role="alert" style={{ fontSize: '1.25rem', color: 'var(--error_color)', marginBottom: '1rem' }}>{args.error}</p>}

          {!args.error && args.query && (
            <div className="search-toolbar">
              <p className="text" style={{ fontSize: '1rem', opacity: '0.6' }}>
                {number.format(args.total)} {t('results')}
              </p>
              {args.results.length > 0 && <button id="search-batch" type="button" className="text search-batch" hidden>{t('Download all on this page')}</button>}
            </div>
          )}

          {!args.error && args.query && args.results.length === 0 && (
            <p className="text" style={{ fontSize: '1.25rem' }}>{t('No results.')}</p>
          )}

          <p id="search-status" className="text search-status" role="status" aria-live="polite"></p>

          <div className="search-grid" data-strings={cardStrings}>
            {args.results.map((gallery) => (
              <div className="search-card text">
                <a href={`/g/${gallery.id}`} className="search-card-link" title={gallery.title}>
                  <img src={gallery.thumbnail} loading="lazy" alt="" width={gallery.width} height={gallery.height} />
                  <span className="search-card-title">{gallery.title}</span>
                </a>
                <div className="search-card-meta">
                  <span>{gallery.id} · {gallery.pages} {t('pages')}</span>
                  <button type="button" className="search-card-download text" data-id={String(gallery.id)} data-title={gallery.title} aria-label={`${t('Download')} ${gallery.id}`}>ZIP</button>
                </div>
                <span className="search-card-message" role="status"></span>
              </div>
            ))}
          </div>

          {args.numPages > 1 && (
            <nav className="pagination" aria-label={t('Pages')}>
              {pageNav(1, t('First'))}
              {pageNav(args.page - 1, t('Previous'), 'prev')}
              <form action="/search" method="get" className="page-jump">
                <input type="hidden" name="q" value={args.query} />
                {args.sort !== 'date' && <input type="hidden" name="sort" value={args.sort} />}
                <input type="number" name="page" min={1} max={args.numPages} value={String(args.page)} inputmode="numeric" aria-label={t('Page number')} />
                <span className="text">/ {number.format(args.numPages)}</span>
              </form>
              {pageNav(args.page + 1, t('Next'), 'next')}
              {pageNav(args.numPages, t('Last'))}
            </nav>
          )}
        </main>
        <script type="module" src={args.script('Preferences')}></script>
        <script type="module" src={args.script('Suggest')}></script>
        <script type="module" src={args.script('Search')}></script>
      </>
    )
  }
}
