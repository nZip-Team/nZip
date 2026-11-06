import Preferences from '../Components/Preferences'

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
export default (args: { id: string, title: string | null, cover: string, language?: string; languages?: { code: string; name: string; symbol: string; tag: string }[], t: (key: string) => string, tr: (section: string, key: string) => string, script: (name: string) => string }) => {
  const t = args.t
  const title = args.title || args.id

  // Everything the client script sets at runtime; the markup above carries the rest
  const clientKeys = [
    'Preparing for {format}...',
    'Failed to prepare {format}',
    'Reconnecting...',
    'sec',
    'min',
    'Download failed',
    'Pack failed',
    'Connection failed or rate limited',
    'Connection lost before completion. Please try again.',
    'Connection closed before completion. Please try again.',
    'Server busy or rate limited. Try again later.',
    'Failed to parse server response',
    'Unexpected empty response from server',
    'Unexpected response from server',
    'Malformed download progress message',
    'Missing download link from server',
    '{count} of {total} pages are no longer available and were left out.',
    '(pages {pages})',
    'Link copied',
    'Copy link',
    'Ready to download'
  ]
  const i18n = Object.fromEntries(clientKeys.map((key) => [key, t(key)]))

  const step = (id: string, text: string, active = false) => (
    <li id={`step-${id}-container`} className="step" style={{ opacity: active ? '1' : '0.25' }}>
      <div id={`step-${id}-status`} className="step-status" style={active ? { animation: '1s flashing infinite' } : {}}></div>
      <span id={`step-${id}-text`} className="text step-text">{text}</span>
    </li>
  )

  return {
    title: `nZip | ${args.id}`,
    description: title,
    path: `/g/${args.id}`,
    bodyClass: 'page-center',
    content: (
      <>
        <main style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: '2rem' }} data-id={args.id} data-title={title}>
          <button id="cover-toggle" type="button" className="cover-toggle" aria-pressed="false" aria-label={t('Show cover')}>
            <img id="image-cover" className="cover-image" src={args.cover} alt={title} />
          </button>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <h1 className="text title download-title">{title}</h1>
            <button id="copy-link" type="button" className="link-button copy-link" hidden>{t('Copy link')}</button>
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
              <div style={{ flexShrink: '0', backgroundColor: 'var(--text_color)', width: '100%', height: '0.075rem', marginTop: '1.25rem', opacity: '0.25' }}></div>
              <div className="progress-container" style={{ flex: '1', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                <ol className="steps">
                  {step('connect', t('Connecting to the server...'), true)}
                  {step('download', t('Downloading the images...'))}
                  {step('pack', t('Preparing for ZIP...'))}
                  {step('finish', t('Finish!'))}
                </ol>
                <div style={{ width: 'calc(75% + (5rem - 2vw))' }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center', marginBottom: '0.5rem' }}>
                    <p id="progress-text" className="text progress-text" aria-live="polite" aria-atomic="true">0%</p>
                    <button id="retry-button" type="button" hidden className="text" style={{ flexShrink: '0', backgroundColor: 'var(--background_color)', color: 'var(--text_color)', border: '0.1rem solid var(--text_color)', borderRadius: '0.25rem', fontSize: '1rem', padding: '0.35rem 0.5rem', cursor: 'pointer' }}>{t('Retry')}</button>
                    <select id="progress-format" className="text" aria-label={t('Format')} style={{ backgroundColor: 'var(--background_color)', color: 'var(--text_color)', border: '0.1rem solid var(--text_color)', borderRadius: '0.25rem', fontSize: '1rem', padding: '0.35rem 0.5rem' }}>
                      <option value="zip">ZIP</option>
                      <option value="cbz">CBZ</option>
                      <option value="pdf">PDF</option>
                      <option value="epub">EPUB</option>
                    </select>
                    <a id="progress-result" className="text" aria-disabled="true" title={t('Download') + ' (D)'} style={{ fontSize: '1.25rem', transition: 'opacity 0.5s, color 0.5s', opacity: '0.45', color: 'color-mix(in srgb, var(--text_color), var(--background_color) 45%)', pointerEvents: 'none', cursor: 'default' }}>{t('Download')}</a>
                  </div>
                  <div id="progress-bar-track" role="progressbar" aria-label={t('Download')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={0} style={{ backgroundColor: 'color-mix(in srgb, var(--text_color), var(--background_color) 85%)', borderRadius: '1rem', width: '100%', height: '0.3rem', overflow: 'hidden' }}>
                    <div id="progress-bar" style={{ backgroundColor: 'var(--text_color)', width: '0%', height: '100%', transition: 'width 0.5s' }}></div>
                  </div>
                  <p id="progress-warning" className="text progress-warning" aria-live="polite"></p>
                </div>
              </div>
            </div>
          </div>
        </main>
        <Preferences tr={args.tr} language={args.language} languages={args.languages} />
        <script type="application/json" id="i18n-data" dangerouslySetInnerHTML={{ __html: JSON.stringify(i18n).replace(/</g, '\\u003c') }}></script>
        <script type="module" src={args.script('Download')}></script>
        <script type="module" src={args.script('Preferences')}></script>
      </>
    )
  }
}
