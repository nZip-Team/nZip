/**
 * Download page
 * @param args Arguments
 * @param args.id Gallery ID
 * @param args.title Gallery title
 * @param args.cover Gallery cover
 * @param args.t Translation function
 * @returns Object containing the page title, description, and content
 */
// prettier-ignore
export default (args: { id: string, title: string, cover: string, t: (key: string) => string }) => {
  const t = args.t

  return {
    title: `nZip | ${args.id}`,
    description: args.title,
    content: (
      <body data-dynamic-minheight="4rem" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--background_color)', margin: '0', width: '100%', height: '100dvh', minHeight: '100dvh' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '2rem' }}>
          <img id="image-cover" className="cover-image" src={args.cover} style={{ borderRadius: '0.25rem', height: '35rem', filter: 'blur(2.5px)', transition: 'filter 0.5s', cursor: 'pointer' }} />
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <h1 className="text title" style={{ fontSize: '1.75rem', margin: '0', marginBottom: '0.75rem', maxWidth: '50dvw' }}>{args.title}</h1>
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              <div style={{ flexShrink: '0', backgroundColor: 'var(--text_color)', width: '100%', height: '0.075rem', marginTop: '1.25rem', opacity: '0.25' }}></div>
              <div className="progress-container" style={{ flex: '1', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                <div style={{ marginBottom: '5rem' }}>
                  <div id="step-connect-container" style={{ display: 'flex', alignItems: 'center', marginBottom: '0.5rem', opacity: '1', transition: 'opacity 0.5s' }}>
                    <div id="step-connect-status" style={{ border: '0.1rem solid var(--text_color)', borderRadius: '100%', width: '0.75rem', height: '0.75rem', marginRight: '1rem', animation: '1s flashing infinite' }}></div>
                    <h1 className="text" style={{ fontSize: '1.25rem' }}>{t('Connecting to the server...')}</h1>
                  </div>
                  <div id="step-download-container" style={{ display: 'flex', alignItems: 'center', marginBottom: '0.5rem', opacity: '0.25', transition: 'opacity 0.5s' }}>
                    <div id="step-download-status" style={{ border: '0.1rem solid var(--text_color)', borderRadius: '100%', width: '0.75rem', height: '0.75rem', marginRight: '1rem' }}></div>
                    <h1 className="text" style={{ fontSize: '1.25rem' }}>{t('Downloading the images...')}</h1>
                  </div>
                  <div id="step-pack-container" style={{ display: 'flex', alignItems: 'center', marginBottom: '0.5rem', opacity: '0.25', transition: 'opacity 0.5s' }}>
                    <div id="step-pack-status" style={{ border: '0.1rem solid var(--text_color)', borderRadius: '100%', width: '0.75rem', height: '0.75rem', marginRight: '1rem' }}></div>
                    <h1 className="text" style={{ fontSize: '1.25rem' }}>{t('Packing the images...')}</h1>
                  </div>
                  <div id="step-finish-container" style={{ display: 'flex', alignItems: 'center', marginBottom: '0.5rem', opacity: '0.25', transition: 'opacity 0.5s' }}>
                    <div id="step-finish-status" style={{ border: '0.1rem solid var(--text_color)', borderRadius: '100%', width: '0.75rem', height: '0.75rem', marginRight: '1rem' }}></div>
                    <h1 className="text" style={{ fontSize: '1.25rem' }}>{t('Finish!')}</h1>
                  </div>
                </div>
                <div style={{ width: 'calc(75% + (5rem - 2vw))' }}>
                  <div style={{ display: 'flex', marginBottom: '0.5rem' }}>
                    <h1 id="progress-text" className="text" style={{ flex: '1', fontSize: '1.25rem' }}>0%</h1>
                    <a id="progress-result" className="text" style={{ fontSize: '1.25rem', transition: 'opacity 0.5s', opacity: '0' }}>{t('Download')}</a>
                  </div>
                  <div style={{ backgroundColor: 'color-mix(in srgb, var(--text_color), var(--background_color) 85%)', borderRadius: '1rem', width: '100%', height: '0.3rem', overflow: 'hidden' }}>
                    <div id="progress-bar" style={{ backgroundColor: 'var(--text_color)', width: '0%', height: '100%', transition: 'width 0.5s' }}></div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <script type="module" src="/Scripts/Download.js"></script>
      </body>
    )
  }
}
