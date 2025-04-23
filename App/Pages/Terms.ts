import { Element } from '@lightbery/scope'

/**
 * Terms of Service page
 * @returns Object containing the page title, description, and content
 */
// prettier-ignore
export default () => {
  return {
    title: 'nZip | Terms of Service',
    description: 'Terms of Service of nZip',
    content: new Element('body', { style: { display: 'flex', flexDirection: 'column', center: 'horizontal vertical', backgroundColor: '$background_color', margin: '0', width: '100dvw', height: '100dvh' } }, [
      new Element('div', { style: { display: 'flex', flexDirection: 'column', center: 'vertical', width: '90dvw' } }, [
        new Element('h1', { class: 'text', style: { fontSize: '2.75rem', marginBottom: '1rem' }, innerHTML: 'Terms of Service' }),
        new Element('h1', { class: 'text', style: { fontSize: '1.25rem' }, innerHTML: '1. Content Ownership' }),
        new Element('p', { class: 'text', style: { fontSize: '1.25rem', marginBottom: '1rem' }, innerHTML: 'We do not own any of the content available on nhentai.net. All content is owned by the original illustrators and creators. Users are responsible for ensuring that their use of this tool complies with applicable copyright laws.' }),
        new Element('h1', { class: 'text', style: { fontSize: '1.25rem' }, innerHTML: '2. Educational Use Only' }),
        new Element('p', { class: 'text', style: { fontSize: '1.25rem', marginBottom: '1rem' }, innerHTML: 'This project is intended for educational purposes only and should not be used for any other purposes.' }),
        new Element('h1', { class: 'text', style: { fontSize: '1.25rem' }, innerHTML: '3. No Affiliation' }),
        new Element('p', { class: 'text', style: { fontSize: '1.25rem', marginBottom: '1rem' }, innerHTML: 'This project is not affiliated with or endorsed by nhentai.net.' })
      ]),
      new Element('div', { style: { backgroundColor: '$text_color', width: '90dvw', height: '0.075rem', opacity: '0.25' } }),
      new Element('div', { style: { display: 'flex', flexDirection: 'column', center: 'vertical', width: '90dvw', marginTop: '1rem' } }, [
        new Element('p', { class: 'text', style: { fontSize: '1.25rem' }, innerHTML: 'By using nZip, you acknowledge that you have read and understood this Terms of Service and <a href="/privacy">Privacy Policy</a> document. If you do not agree with these terms, please refrain from using the service.' }),
        new Element('p', { class: 'text', style: { fontSize: '1.25rem', marginTop: '1rem' }, innerHTML: 'If you have any questions or concerns about these terms, please contact us at contact [at] nhentai [dot] zip.' })
      ]),
      new Element('div', { style: { display: 'flex', center: 'horizontal', width: '90dvw', marginTop: '1.5rem' } }, [
        new Element('a', { class: 'text', style: { fontSize: '1.5rem' }, href: 'javascript:history.back()', innerHTML: 'Back' })
      ])
    ])
  }
}
