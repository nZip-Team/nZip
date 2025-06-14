import type { RenderScope } from '../../Server/Types'

/**
 * Home page
 * @param args Arguments
 * @param args.version Version of nZip
 * @returns Object containing the page title, description, keywords and content
 */
// prettier-ignore
export default (scope: RenderScope, args: { version: string }) => {
  const { Element } = scope

  return {
    title: 'nZip | Home',
    description: 'Easily download the doujinshi you like.',
    keywords: 'nhentai, hentai, doujinshi, manga, download, zip, archive, batch download, gallery, adult manga, h-manga, nhentai downloader, doujin, comic, japanese manga',
    content: new Element('body', { style: { display: 'flex', flexDirection: 'column', center: 'horizontal vertical', backgroundColor: '$background_color', margin: '0px', width: '100dvw', height: '100dvh' } }, [
      new Element('div', { style: { position: 'fixed', display: 'flex', center: 'horizontal vertical', left: '0px', top: '0px', width: '100dvw', height: '100dvh', zIndex: '-1' } }, [
        new Element('h1', { id: 'text_sauce', class: 'text', style: { userSelect: 'none', fontSize: '20rem', opacity: '0.075' } })
      ]),
      new Element('div', { style: { marginLeft: '1rem', marginRight: '1rem' } }, [
        new Element('h1', { class: 'text', innerHTML: '<span style="color: #d83e57ff">n</span>Zip', style: { fontSize: '2.75rem', textWrap: 'nowrap', margin: '0px' } }),
        new Element('h1', { class: 'text', innerHTML: 'Easily download the doujinshi you like.', style: { fontSize: '1.25rem', fontWeight: 'normal', margin: '0px', marginBottom: '0.75rem' } }),
        new Element('input', { id: 'input_sauce', type: 'text', placeholder: 'The Sauce', style: { outline: 'none', backgroundColor: '$background_color', color: '$text_color', border: '0.1rem solid $text_color', borderRadius: '0.25rem', fontSize: '1.25rem', fontWeight: 'normal', padding: '0.5rem 0.5rem', width: '100% - 1.5rem' } }),
        new Element('div', { style: { display: 'flex', flexDirection: 'row', center: 'vertical', marginTop: '1rem', gap: '0.5rem' } }, [
          new Element('a', { class: 'text', href: '/terms', innerHTML: 'Terms', style: { fontSize: '1rem' } }),
          new Element('h1', { class: 'text', innerHTML: 'and', style: { fontSize: '1rem', fontWeight: 'normal' } }),
          new Element('a', { class: 'text', href: '/privacy', innerHTML: 'Privacy', style: { fontSize: '1rem' } })
       ])
      ]),
      new Element('div', { style: { position: 'fixed', display: 'flex', flexWrap: 'wrap', gap: '0.5rem', fontSize: '1rem', bottom: '0.6rem', width: '100dvw - 2rem' } }, [
        new Element('div', { style: { flex: '1', display: 'flex', flexShrink: '0', center: 'vertical', gap: '0.5rem' } }, [
          new Element('h1', { class: 'text', style: { fontSize: '1rem', textWrap: 'nowrap' }, innerHTML: 'Made by' }),
          new Element('a', { class: 'text', href: 'https://github.com/noticebrick', target: '_blank', innerHTML: 'IceBrick', style: { fontSize: '1rem', fontWeight: 'bold', textWrap: 'nowrap' } }),
          new Element('h1', { class: 'text', innerHTML: 'and', style: { fontSize: '1rem', textWrap: 'nowrap' } }),
          new Element('a', { class: 'text', href: 'https://github.com/LmanTW', target: '_blank', innerHTML: 'LmanTW', style: { fontSize: '1rem', fontWeight: 'bold', textWrap: 'nowrap' } }),
          new Element('h1', { class: 'text', innerHTML: 'with ❤️', style: { fontSize: '1rem', textWrap: 'nowrap' } })
        ]),
        new Element('a', { href: 'https://github.com/nZip-Team/nZip', target: '_blank', innerHTML: `nZip ${args.version}`, style: { flexShrink: '0', fontSize: '1rem', fontWeight: 'bold', textWrap: 'nowrap' } })
      ]),
      new Element('script', { src: '/Scripts/Home.mjs' })
    ])
  }
}
