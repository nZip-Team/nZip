/**
 * Home page
 * @param args Arguments
 * @param args.version Version of nZip
 * @returns Object containing the page title, description, keywords and content
 */
// prettier-ignore
export default (args: { version: string }) => {
  return {
    title: 'nZip | Home',
    description: 'Easily download the doujinshi you like.',
    keywords: 'nhentai downloader, nhentai download, nhentai zip, download nhentai, n hentai downloader, nhentai downloader online, download from nhentai, nhentai.net downloader, nzip nhentai, hentai zip, nhentai manga downloader, doujinshi, manga, batch download, gallery, adult manga, h-manga, doujin, comic, japanese manga',
    content: (
      <body style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--background_color)', margin: '0px', width: '100dvw', height: '100dvh' }}>
        <div style={{ position: 'fixed', display: 'flex', alignItems: 'center', justifyContent: 'center', left: '0px', top: '0px', width: '100dvw', height: '100dvh', zIndex: '-1' }}>
          <h1 id="text_sauce" className="text" style={{ userSelect: 'none', fontSize: '20rem', opacity: '0.075' }}></h1>
        </div>
        <div style={{ marginLeft: '1rem', marginRight: '1rem' }}>
          <h1 className="text" style={{ fontSize: '2.75rem', textWrap: 'nowrap', margin: '0px' }}>
            <span style={{ color: '#d83e57ff' }}>n</span>Zip
          </h1>
          <h1 className="text" style={{ fontSize: '1.25rem', fontWeight: 'normal', margin: '0px', marginBottom: '0.75rem' }}>
            Easily download the doujinshi you like.
          </h1>
          <input id="input_sauce" type="text" placeholder="The Sauce" style={{ outline: 'none', backgroundColor: 'var(--background_color)', color: 'var(--text_color)', border: '0.1rem solid var(--text_color)', borderRadius: '0.25rem', fontSize: '1.25rem', fontWeight: 'normal', padding: '0.5rem 0.5rem', width: 'calc(100% - 1.5rem)' }} />
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', marginTop: '1rem', gap: '0.5rem' }}>
            <a className="text" href="/terms" style={{ fontSize: '1rem' }}>Terms</a>
            <h1 className="text" style={{ fontSize: '1rem', fontWeight: 'normal' }}>and</h1>
            <a className="text" href="/privacy" style={{ fontSize: '1rem' }}>Privacy</a>
          </div>
        </div>
        <div style={{ position: 'fixed', display: 'flex', flexWrap: 'wrap', gap: '0.5rem', fontSize: '1rem', bottom: '0.6rem', width: 'calc(100dvw - 2rem)' }}>
          <div style={{ flex: '1', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <h1 className="text" style={{ fontSize: '1rem' }}>nZip {args.version}</h1>
          </div>
          <a className="text" href="https://github.com/nZip-Team/nZip" target="_blank" style={{ flexShrink: '0', fontSize: '1rem', fontWeight: 'bold', textWrap: 'nowrap' }}>GitHub</a>
        </div>
        <script src="/Scripts/Home.js"></script>
      </body>
    )
  }
}
