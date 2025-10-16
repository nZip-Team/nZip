/**
 * Error page
 * @param args Arguments
 * @param args.error Error message to display on the page
 * @returns Object containing the page title, description, and content
 */
// prettier-ignore
export default (args: { error: string }) => {
  return {
    title: 'nZip | Error',
    description: 'Something went wrong.',
    content: (
      <body style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--background_color)', margin: '0px', width: '100dvw', height: '100dvh' }}>
        <div style={{ marginBottom: '1rem' }}>
          <h1 className="text" style={{ fontSize: '2.75rem' }}>Error</h1>
          <h1 className="text" style={{ fontSize: '1.25rem', fontWeight: 'normal', maxWidth: '90dvw' }} dangerouslySetInnerHTML={{ __html: args.error }} />
        </div>
        <a className="text" style={{ fontSize: '1.5rem', marginTop: '0.5rem' }} href="javascript:history.back()">Back</a>
      </body>
    )
  }
}
