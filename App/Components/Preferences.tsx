/**
 * Preferences button and dialog, driven by Server/Scripts/Preferences.ts
 * @param args.tr Translation function for a language file section
 * @param args.language Current language code, to mark it in the list
 * @param args.languages Language menu (Pages.ts passes it to every page)
 */
// prettier-ignore
export default (args: { tr: (section: string, key: string) => string; language?: string; languages?: { code: string; name: string; symbol: string; tag: string }[] }) => {
  const t = (key: string) => args.tr('Preferences', key)

  const themes = [
    ['system', t('System')],
    ['dark', t('Dark')],
    ['light', t('Light')]
  ]

  return (
    <>
      <button id="preferences_button" type="button" className="preferences-button" aria-haspopup="dialog" aria-controls="preferences_modal" title={t('Preferences')}>
        <img src="/Images/preferences.svg" alt={t('Preferences')} />
      </button>
      <div id="preferences_modal" className="preferences-modal" role="dialog" aria-modal="true" aria-labelledby="preferences_title" hidden>
        <div className="preferences-modal-content">
          <h2 id="preferences_title" className="text" style={{ fontSize: '1.5rem', marginBottom: '1.5rem', textAlign: 'center' }}>{t('Preferences')}</h2>
          <h3 className="text" style={{ fontSize: '1.25rem', marginBottom: '0.75rem' }}>{t('Covers')}</h3>
          <label className="text preference-toggle" style={{ marginBottom: '1.5rem' }}>
            <input id="preference_blur" type="checkbox" checked />
            <span>{t('Blur covers until clicked or hovered')}</span>
          </label>
          <fieldset className="text preference-group">
            <legend>{t('Theme')}</legend>
            {themes.map(([value, label]) => (
              <label className="preference-toggle">
                <input type="radio" name="preference_theme" value={value} checked={value === 'system'} />
                <span>{label}</span>
              </label>
            ))}
          </fieldset>
          <div id="preference_notify_group" hidden>
            <h3 className="text" style={{ fontSize: '1.25rem', marginBottom: '0.75rem' }}>{t('Notifications')}</h3>
            <label className="text preference-toggle" style={{ marginBottom: '1.5rem' }}>
              <input id="preference_notify" type="checkbox" />
              <span>{t('Notify me when a download is ready')}</span>
            </label>
          </div>
          <h3 className="text" style={{ fontSize: '1.25rem', marginBottom: '0.75rem' }}>{t('Language')}</h3>
          <div id="language_list">
            {(args.languages ?? []).map((lang) => (
              <button type="button" className="text language-button" lang={lang.tag} data-code={lang.code} data-current={String(lang.code === args.language)} aria-current={lang.code === args.language ? 'true' : undefined}>
                {lang.symbol} {lang.name}
              </button>
            ))}
          </div>
          <p className="text" style={{ fontSize: '1rem', fontWeight: 'normal', marginTop: '1rem', textAlign: 'center', opacity: '0.75' }} dangerouslySetInnerHTML={{ __html: t('Open Pull Requests on GitHub to add your own language!').replace(t('GitHub'), `<a href="https://github.com/nZip-Team/nZip" target="_blank" rel="noopener">${t('GitHub')}</a>`)}}></p>
        </div>
      </div>
    </>
  )
}
