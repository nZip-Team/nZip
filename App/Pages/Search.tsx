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
  t: (key: string) => string
  tr: (section: string, key: string) => string
  script: (name: string) => string
}) => {
  const t = args.t

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

  const fieldStyle = { outline: 'none', backgroundColor: 'var(--background_color)', color: 'var(--text_color)', border: '0.1rem solid var(--text_color)', borderRadius: '0.25rem', fontSize: '1.1rem', padding: '0.4rem 0.5rem' }

  return {
    title: args.query ? `nZip | ${t('Search')}: ${args.query}` : `nZip | ${t('Search')}`,
    description: t('Search doujinshi and download them as an archive.'),
    content: (
      <body style={{ backgroundColor: 'var(--background_color)', margin: '0px', minHeight: '100dvh' }}>
        <Preferences tr={args.tr} />
        <div style={{ maxWidth: '80rem', margin: '0 auto', padding: '1rem 4rem 1rem 1rem' }}>
          <form action="/search" method="get" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
            <a href="/" className="text" style={{ fontSize: '2rem', fontWeight: 'bold', textDecoration: 'none', textWrap: 'nowrap' }}>
              <span style={{ color: '#d83e57ff' }}>n</span>Zip
            </a>
            <div style={{ flex: '1', minWidth: '12rem' }}>
              <input name="q" type="search" value={args.query} placeholder={t('Search')} autocomplete="off" autocapitalize="off" spellcheck={false} data-api={args.api} data-suggest={suggestStrings(args.tr)} style={{ ...fieldStyle, width: '100%', boxSizing: 'border-box' }} />
            </div>
            <select name="sort" style={fieldStyle}>
              {sorts.map(([value, label]) => <option value={value} selected={value === args.sort}>{label}</option>)}
            </select>
            <button type="submit" className="text" style={{ ...fieldStyle, cursor: 'pointer' }}>{t('Search')}</button>
          </form>

          {args.error && <h1 className="text" style={{ fontSize: '1.25rem', fontWeight: 'normal', color: '#ff4444' }}>{args.error}</h1>}

          {!args.error && args.query && (
            <h1 className="text" style={{ fontSize: '1rem', fontWeight: 'normal', opacity: '0.6', marginBottom: '1rem' }}>
              {args.total.toLocaleString('en-US')} {t('results')}
            </h1>
          )}

          {!args.error && args.query && args.results.length === 0 && (
            <h1 className="text" style={{ fontSize: '1.25rem', fontWeight: 'normal' }}>{t('No results.')}</h1>
          )}

          <div className="search-grid" data-packing={t('Packing…')} data-failed={t('Download failed, click to try again')}>
            {args.results.map((gallery) => (
              <div className="search-card text">
                <a href={`/g/${gallery.id}`} className="search-card-link" title={gallery.title}>
                  <img src={gallery.thumbnail} loading="lazy" alt="" width={gallery.width} height={gallery.height} />
                  <span className="search-card-title">{gallery.title}</span>
                </a>
                <div className="search-card-meta">
                  <span>{gallery.id} · {gallery.pages} {t('pages')}</span>
                  <button type="button" className="search-card-download text" data-id={String(gallery.id)} aria-label={`${t('Download')} ${gallery.id}`}>ZIP</button>
                </div>
              </div>
            ))}
          </div>

          {args.numPages > 1 && (
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '1.5rem', margin: '1.5rem 0', fontSize: '1.1rem' }}>
              {args.page > 1 ? <a className="text" href={pageLink(args.page - 1)}>{t('Previous')}</a> : <span className="text" style={{ opacity: '0.3' }}>{t('Previous')}</span>}
              <span className="text">{args.page} / {args.numPages}</span>
              {args.page < args.numPages ? <a className="text" href={pageLink(args.page + 1)}>{t('Next')}</a> : <span className="text" style={{ opacity: '0.3' }}>{t('Next')}</span>}
            </div>
          )}
        </div>
        <script type="module" src={args.script('Preferences')}></script>
        <script type="module" src={args.script('Suggest')}></script>
        <script type="module" src={args.script('Search')}></script>
      </body>
    )
  }
}
