import type { RenderScope } from '../../Server/Types'

/**
 * Error page
 * @param args Arguments
 * @param args.error Error message to display on the page
 * @returns Object containing the page title, description, and content
 */
// prettier-ignore
export default (scope: RenderScope, args: { error: string }) => {
  const { Element } = scope

  return {
    title: 'nZip | Error',
    description: 'Something went wrong.',
    content: new Element('body', { style: { display: 'flex', flexDirection: 'column', center: 'horizontal vertical', backgroundColor: '$background_color', margin: '0px', width: '100dvw', height: '100dvh' } }, [
      new Element('div', { style: { marginBottom: '1rem' } }, [
        new Element('h1', { class: 'text', style: { fontSize: '2.75rem' }, innerHTML: 'Error' }),
        new Element('h1', { class: 'text', style: { fontSize: '1.25rem', fontWeight: 'normal', maxWidth: '90dvw' }, innerHTML: `${args.error}` })
      ]),
      new Element('a', { class: 'text', style: { fontSize: '1.5rem', marginTop: '0.5rem' }, href: 'javascript:history.back()', innerHTML: 'Back' })
    ])
  }
}
