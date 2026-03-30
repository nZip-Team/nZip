/**
 * DMCA page
 * @param args Arguments
 * @param args.t Translation function
 * @returns Object containing the page title, description, and content
 */
// prettier-ignore
export default (args: { t: (key: string) => string }) => {
  const t = args.t

  return {
    title: `nZip | ${t('DMCA Policy')}`,
    description: 'DMCA policy for nZip',
    content: (
      <body style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--background_color)', margin: '0', width: '100dvw', height: '100dvh' }}>
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', width: '90dvw' }}>
          <h1 className="text" style={{ fontSize: '2.75rem', marginBottom: '1rem' }}>{t('DMCA Policy')}</h1>
          <p className="text" style={{ fontSize: '1.25rem', marginBottom: '1rem' }}>
            {t('nZip respects the intellectual property rights of others. If you believe that your copyrighted work has been copied in a way that constitutes copyright infringement and is accessible via this project, please contact us.')}
          </p>
          <h1 className="text" style={{ fontSize: '1.25rem' }}>1. {t('How to File a Notice')}</h1>
          <p className="text" style={{ fontSize: '1.25rem', marginBottom: '1rem' }}>
            {t('To file a takedown notice, include your contact information, identification of the copyrighted work, identification of the allegedly infringing material, a statement of good-faith belief, and a statement under penalty of perjury that the information is accurate.')}
          </p>
          <h1 className="text" style={{ fontSize: '1.25rem' }}>2. {t('Send Notices')}</h1>
          <p className="text" style={{ fontSize: '1.25rem', marginBottom: '1rem' }}>
            {t('Send DMCA notices to contact [at] nhentai [dot] zip. We will review valid notices and take appropriate action.')}
          </p>
        </div>
        <div style={{ display: 'flex', justifyContent: 'center', width: '90dvw', marginTop: '1.5rem' }}>
          <a className="text" style={{ fontSize: '1.5rem' }} href="javascript:history.back()">{t('Back')}</a>
        </div>
      </body>
    )
  }
}
