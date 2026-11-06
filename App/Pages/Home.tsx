import Preferences from '../Components/Preferences'
import suggestStrings from '../Components/SuggestStrings'

/**
 * Home page
 * @param args Arguments
 * @param args.version Version of nZip
 * @param args.t Translation function
 * @returns Object containing the page title, description and content
 */
// prettier-ignore
export default (args: { version: string; api: string; language?: string; languages?: { code: string; name: string; symbol: string; tag: string }[]; t: (key: string) => string; tr: (section: string, key: string) => string; script: (name: string) => string }) => {
  const t = args.t

  return {
    title: `nZip | ${t('Home')}`,
    description: t('Easily download the doujinshi you like.'),
    path: '/',
    bodyClass: 'page-center',
    content: (
      <>
        <Preferences tr={args.tr} language={args.language} languages={args.languages} />
        <div className="home-backdrop" aria-hidden="true">
          <div id="text_sauce" className="text home-counter"></div>
        </div>
        <main style={{ marginLeft: '1rem', marginRight: '1rem', paddingBottom: '2rem' }}>
          <h1 className="text" style={{ fontSize: '2.75rem', textWrap: 'nowrap', margin: '0px' }}>
            <span style={{ color: '#d83e57ff' }}>n</span>Zip
          </h1>
          <p className="text" id="subtitle" style={{ fontSize: '1.25rem', fontWeight: 'normal', margin: '0px', marginBottom: '0.75rem' }}>
            {t('Easily download the doujinshi you like.')}
          </p>
          {/* Works without JS: /search redirects IDs and gallery links to /g/:id */}
          <form id="form_sauce" action="/search" method="get" role="search">
            <input id="input_sauce" name="q" type="text" className="home-input" enterkeyhint="go" autocomplete="off" autocapitalize="off" spellcheck={false} data-api={args.api} data-suggest={suggestStrings(args.tr)} placeholder={t('The Sauce or a search')} aria-label={t('The Sauce or a search')} />
          </form>
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', marginTop: '1rem', gap: '0.5rem' }}>
            <a className="text" href="/terms" style={{ fontSize: '1rem' }}>{t('Terms')}</a>
            <span className="text" style={{ fontSize: '1rem', fontWeight: 'normal' }}>{t('and')}</span>
            <a className="text" href="/privacy" style={{ fontSize: '1rem' }}>{t('Privacy')}</a>
          </div>
          <section id="history" className="history text" aria-labelledby="history_title" hidden>
            <div className="history-header">
              <h2 id="history_title" className="text" style={{ fontSize: '1rem' }}>{t('Recent downloads')}</h2>
              <button id="history_clear" type="button" className="link-button" style={{ fontSize: '0.9rem' }}>{t('Clear')}</button>
            </div>
            <ul id="history_list" className="history-list"></ul>
          </section>
        </main>
        <footer className="home-footer">
          <div style={{ flex: '1', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span className="text" style={{ fontSize: '1rem', fontWeight: 'bold' }}>nZip {args.version}</span>
          </div>
          <a className="text" href="https://github.com/nZip-Team/nZip" target="_blank" rel="noopener" style={{ flexShrink: '0', fontSize: '1rem', fontWeight: 'bold', textWrap: 'nowrap' }}>{t('GitHub')}</a>
        </footer>
        <script type="module" src={args.script('Home')}></script>
        <script type="module" src={args.script('Preferences')}></script>
        <script type="module" src={args.script('Suggest')}></script>
      </>
    )
  }
}
