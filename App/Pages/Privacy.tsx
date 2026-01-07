/**
 * Privacy Policy page
 * @param args Arguments
 * @param args.t Translation function
 * @returns Object containing the page title, description, and content
 */
// prettier-ignore
export default (args: { t: (key: string) => string }) => {
  const t = args.t

  return {
    title: `nZip | ${t('Privacy Policy')}`,
    description: 'Privacy Policy of nZip',
    content: (
      <body style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--background_color)', margin: '0', width: '100dvw', height: '100dvh' }}>
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', width: '90dvw' }}>
          <h1 className="text" style={{ fontSize: '2.75rem', marginBottom: '1rem' }}>{t('Privacy Policy')}</h1>
          <h1 className="text" style={{ fontSize: '1.25rem' }}>1. {t('Data We Collect')}</h1>
          <p className="text" style={{ fontSize: '1.25rem', marginBottom: '1rem' }}>{t('Geolocation information, Browser type and version, Referrer URL, Device information.')}</p>
          <h1 className="text" style={{ fontSize: '1.25rem' }}>2. {t('Data We Do Not Collect')}</h1>
          <p className="text" style={{ fontSize: '1.25rem', marginBottom: '1rem' }}>{t('We do not collect any information that can directly identify users, such as IP addresses.')}</p>
          <h1 className="text" style={{ fontSize: '1.25rem' }}>3. {t('Purpose of Data Collection')}</h1>
          <p className="text" style={{ fontSize: '1.25rem', marginBottom: '1rem' }}>{t('The data we collect is used solely for improving the service and ensuring its proper functionality.')}</p>
          <h1 className="text" style={{ fontSize: '1.25rem' }}>4. {t('Data Sharing')}</h1>
          <p className="text" style={{ fontSize: '1.25rem', marginBottom: '2rem' }}>{t('We do not share or sell any collected data to third parties.')}</p>
        </div>
        <div style={{ backgroundColor: 'var(--text_color)', width: '90dvw', height: '0.075rem', opacity: '0.25' }}></div>
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', width: '90dvw', marginTop: '2rem' }}>
          <p className="text" style={{ fontSize: '1.25rem' }} dangerouslySetInnerHTML={{ __html: t('By using nZip, you acknowledge that you have read and understood Terms of Service and this Privacy Policy document. If you do not agree with these terms, please refrain from using the service.').replace(t('Terms of Service'), `<a href="/terms">${t('Terms of Service')}</a>`) }} />
          <p className="text" style={{ fontSize: '1.25rem', marginTop: '1.25rem' }}>
            {t('If you have any questions or concerns about these terms, please contact us at contact [at] nhentai [dot] zip.')}
          </p>
        </div>
        <div style={{ display: 'flex', justifyContent: 'center', width: '90dvw', marginTop: '1.5rem' }}>
          <a className="text" style={{ fontSize: '1.5rem', marginTop: '0.5rem' }} href="javascript:history.back()">{t('Back')}</a>
        </div>
      </body>
    )
  }
}
