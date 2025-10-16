/**
 * Terms of Service page
 * @returns Object containing the page title, description, and content
 */
// prettier-ignore
export default () => {
  return {
    title: 'nZip | Terms of Service',
    description: 'Terms of Service of nZip',
    content: (
      <body style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--background_color)', margin: '0', width: '100dvw', height: '100dvh' }}>
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', width: '90dvw' }}>
          <h1 className="text" style={{ fontSize: '2.75rem', marginBottom: '1rem' }}>Terms of Service</h1>
          <h1 className="text" style={{ fontSize: '1.25rem' }}>1. Content Ownership</h1>
          <p className="text" style={{ fontSize: '1.25rem', marginBottom: '1rem' }}>
            We do not own any of the content available on nhentai.net. All content is owned by the original illustrators and creators. Users are responsible for ensuring that their use of this tool complies with applicable copyright laws.
          </p>
          <h1 className="text" style={{ fontSize: '1.25rem' }}>2. Educational Use Only</h1>
          <p className="text" style={{ fontSize: '1.25rem', marginBottom: '1rem' }}>
            This project is intended for educational purposes only and should not be used for any other purposes.
          </p>
          <h1 className="text" style={{ fontSize: '1.25rem' }}>3. No Affiliation</h1>
          <p className="text" style={{ fontSize: '1.25rem', marginBottom: '2rem' }}>
            This project is not affiliated with or endorsed by nhentai.net.
          </p>
        </div>
        <div style={{ backgroundColor: 'var(--text_color)', width: '90dvw', height: '0.075rem', opacity: '0.25' }}></div>
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', width: '90dvw', marginTop: '2rem' }}>
          <p className="text" style={{ fontSize: '1.25rem' }}>
            By using nZip, you acknowledge that you have read and understood this Terms of Service and <a href="/privacy">Privacy Policy</a> document. If you do not agree with these terms, please refrain from using the service.
          </p>
          <p className="text" style={{ fontSize: '1.25rem', marginTop: '1rem' }}>
            If you have any questions or concerns about these terms, please contact us at contact [at] nhentai [dot] zip.
          </p>
        </div>
        <div style={{ display: 'flex', justifyContent: 'center', width: '90dvw', marginTop: '1.5rem' }}>
          <a className="text" style={{ fontSize: '1.5rem' }} href="javascript:history.back()">Back</a>
        </div>
      </body>
    )
  }
}
