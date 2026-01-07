/**
 * Home page
 * @param args Arguments
 * @param args.version Version of nZip
 * @param args.t Translation function
 * @returns Object containing the page title, description, keywords and content
 */
// prettier-ignore
export default (args: { version: string; t: (key: string) => string }) => {
  const t = args.t

  return {
    title: `nZip | ${t('Home')}`,
    description: t('Easily download the doujinshi you like.'),
    keywords: 'nhentai downloader, nhentai download, nhentai zip, download nhentai, n hentai downloader, nhentai downloader online, download from nhentai, nhentai.net downloader, nzip nhentai, hentai zip, nhentai manga downloader, doujinshi, manga, batch download, gallery, adult manga, h-manga, doujin, comic, japanese manga',
    content: (
      <body style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--background_color)', margin: '0px', width: '100dvw', height: '100dvh' }}>
        <div style={{ position: 'fixed', top: '1rem', right: '1rem', zIndex: '10', cursor: 'pointer' }}>
          <img src="/Images/languages.svg" alt="Languages" style={{ width: '2rem', height: '2rem', filter: 'brightness(0) invert(1)' }} id="language_selector" />
        </div>
        <div id="language_modal" style={{ position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh', background: 'rgba(0, 0, 0, 0.8)', display: 'none', alignItems: 'center', justifyContent: 'center', zIndex: '1000' }}>
          <div id="language_modal_content" style={{ background: 'var(--background_color)', border: '0.15rem solid var(--text_color)', borderRadius: '0.5rem', padding: '2rem', maxWidth: '20rem' }}>
            <h2 className="text" style={{ fontSize: '1.5rem', marginBottom: '1.5rem', textAlign: 'center' }}>Select Language</h2>
            <div id="language_list"></div>
          </div>
        </div>
        <div style={{ position: 'fixed', display: 'flex', alignItems: 'center', justifyContent: 'center', left: '0px', top: '0px', width: '100dvw', height: '100dvh', zIndex: '-1' }}>
          <h1 id="text_sauce" className="text" style={{ userSelect: 'none', fontSize: '20rem', opacity: '0.075' }}></h1>
        </div>
        <div style={{ marginLeft: '1rem', marginRight: '1rem' }}>
          <h1 className="text" style={{ fontSize: '2.75rem', textWrap: 'nowrap', margin: '0px' }}>
            <span style={{ color: '#d83e57ff' }}>n</span>Zip
          </h1>
          <h1 className="text" id="subtitle" style={{ fontSize: '1.25rem', fontWeight: 'normal', margin: '0px', marginBottom: '0.75rem' }}>
            {t('Easily download the doujinshi you like.')}
          </h1>
          <input id="input_sauce" type="text" placeholder={t('The Sauce')} style={{ outline: 'none', backgroundColor: 'var(--background_color)', color: 'var(--text_color)', border: '0.1rem solid var(--text_color)', borderRadius: '0.25rem', fontSize: '1.25rem', fontWeight: 'normal', padding: '0.5rem 0.5rem', width: 'calc(100% - 1.5rem)', minWidth: '20rem' }} />
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', marginTop: '1rem', gap: '0.5rem' }}>
            <a className="text" href="/terms" style={{ fontSize: '1rem' }}>{t('Terms')}</a>
            <h1 className="text" style={{ fontSize: '1rem', fontWeight: 'normal' }}>{t('and')}</h1>
            <a className="text" href="/privacy" style={{ fontSize: '1rem' }}>{t('Privacy')}</a>
          </div>
        </div>
        <div style={{ position: 'fixed', display: 'flex', flexWrap: 'wrap', gap: '0.5rem', fontSize: '1rem', bottom: '0.6rem', width: 'calc(100dvw - 2rem)' }}>
          <div style={{ flex: '1', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <h1 className="text" style={{ fontSize: '1rem' }}>nZip {args.version}</h1>
          </div>
          <a className="text" href="https://github.com/nZip-Team/nZip" target="_blank" style={{ flexShrink: '0', fontSize: '1rem', fontWeight: 'bold', textWrap: 'nowrap' }}>{t('GitHub')}</a>
        </div>
        <script src="/Scripts/Home.js"></script>
      </body>
    )
  }
}
