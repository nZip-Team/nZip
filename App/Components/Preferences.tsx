/**
 * Preferences button and dialog, driven by Server/Scripts/Preferences.ts
 * @param args.tr Translation function for a language file section
 */
// prettier-ignore
export default (args: { tr: (section: string, key: string) => string }) => {
  const t = (key: string) => args.tr('Preferences', key)

  return (
    <>
      <button id="preferences_button" type="button" className="preferences-button" aria-haspopup="dialog" aria-controls="preferences_modal" title={t('Preferences')}>
        <img src="/Images/preferences.svg" alt={t('Preferences')} />
      </button>
      <div id="preferences_modal" className="preferences-modal" role="dialog" aria-modal="true" aria-labelledby="preferences_title" hidden>
        <div className="preferences-modal-content">
          <h1 id="preferences_title" className="text" style={{ fontSize: '1.5rem', marginBottom: '1.5rem', textAlign: 'center' }}>{t('Preferences')}</h1>
          <h2 className="text" style={{ fontSize: '1.25rem', marginBottom: '0.75rem' }}>{t('Covers')}</h2>
          <label className="text preference-toggle" style={{ marginBottom: '1.5rem' }}>
            <input id="preference_blur" type="checkbox" checked />
            <span>{t('Blur covers until clicked or hovered')}</span>
          </label>
          <h2 className="text" style={{ fontSize: '1.25rem', marginBottom: '0.75rem' }}>{t('Language')}</h2>
          <div id="language_list"></div>
          <h1 className="text" style={{ fontSize: '1rem', fontWeight: 'normal', marginTop: '1rem', textAlign: 'center', opacity: '0.75' }} dangerouslySetInnerHTML={{ __html: t('Open Pull Requests on GitHub to add your own language!').replace(t('GitHub'), `<a href="https://github.com/nZip-Team/nZip" target="_blank">${t('GitHub')}</a>`)}}></h1>
        </div>
      </div>
    </>
  )
}
