import type { RenderScope } from '../../Server/Types'

/**
 * Download page
 * @param args Arguments
 * @param args.id Gallery ID
 * @param args.title Gallery title
 * @param args.cover Gallery cover
 * @returns Object containing the page title, description, and content
 */
// prettier-ignore
export default (scope: RenderScope, args: { id: string, title: string, cover: string }) => {
  const { Element } = scope

  return {
    title: `nZip | ${args.id}`,
    description: args.title,
    content: new Element('body', { style: { display: 'flex', flexDirection: 'column', center: 'horizontal vertical', backgroundColor: '$background_color', margin: '0', width: '100%', height: '100dvh' }, 'style:dynamic:minHeight': '<height> + 4rem' }, [
      new Element('div', { style: { display: 'flex', flexWrap: 'wrap', center: 'horizontal', gap: '2rem' } }, [
        new Element('img', { id: 'image-cover', class: 'cover-image', src: `${args.cover}`, style: { borderRadius: '0.25rem', height: '35rem', filter: 'blur(2.5px)', transition: 'filter 0.5s', cursor: 'pointer' } }),
        new Element('div', { style: { display: 'flex', flexDirection: 'column' } }, [
          new Element('h1', { class: 'text title', style: { fontSize: '1.75rem', margin: '0', marginBottom: '0.75rem', maxWidth: '50dvw' }, innerHTML: `${args.title}` }),
          new Element('div', { style: { display: 'flex', flexDirection: 'column', height: '100%' } }, [
            new Element('div', { style: { flexShrink: '0', backgroundColor: '$text_color', width: '100%', height: '0.075rem', marginTop: '1.25rem', opacity: '0.25' } }),
            new Element('div', { class: 'progress-container', style: { flex: '1', display: 'flex', flexDirection: 'column', center: 'horizontal vertical' } }, [
              new Element('div', { style: { marginBottom: '5rem' } }, [
                new Element('div', { id: 'step-connect-container', style: { display: 'flex', center: 'vertical', marginBottom: '0.5rem', opacity: '1', transition: 'opacity 0.5s' } }, [
                  new Element('div', { id: 'step-connect-status', style: { border: '0.1rem solid $text_color', borderRadius: '100%', width: '0.75rem', height: '0.75rem', marginRight: '1rem', animation: '1s flashing infinite' } }),
                  new Element('h1', { class: 'text', innerHTML: 'Connecting to the server...', style: { fontSize: '1.25rem' } })
                ]),
                new Element('div', { id: 'step-download-container', style: { display: 'flex', center: 'vertical', marginBottom: '0.5rem', opacity: '0.25', transition: 'opacity 0.5s' } }, [
                  new Element('div', { id: 'step-download-status', style: { border: '0.1rem solid $text_color', borderRadius: '100%', width: '0.75rem', height: '0.75rem', marginRight: '1rem' } }),
                  new Element('h1', { class: 'text', innerHTML: 'Downloading the images...', style: { fontSize: '1.25rem' } })
                ]),
                new Element('div', { id: 'step-pack-container', style: { display: 'flex', center: 'vertical', marginBottom: '0.5rem', opacity: '0.25', transition: 'opacity 0.5s' } }, [
                  new Element('div', { id: 'step-pack-status', style: { border: '0.1rem solid $text_color', borderRadius: '100%', width: '0.75rem', height: '0.75rem', marginRight: '1rem' } }),
                  new Element('h1', { class: 'text', innerHTML: 'Packing the images...', style: { fontSize: '1.25rem' } })
                ]),
                new Element('div', { id: 'step-finish-container', style: { display: 'flex', center: 'vertical', marginBottom: '0.5rem', opacity: '0.25', transition: 'opacity 0.5s' } }, [
                  new Element('div', { id: 'step-finish-status', style: { border: '0.1rem solid $text_color', borderRadius: '100%', width: '0.75rem', height: '0.75rem', marginRight: '1rem' } }),
                  new Element('h1', { class: 'text', innerHTML: 'Finish!', style: { fontSize: '1.25rem' } })
                ]),
              ]),
              new Element('div', { style: { width: '75% + (5rem - 2vw)' } }, [
                new Element('div', { style: { display: 'flex', marginBottom: '0.5rem' } }, [
                  new Element('h1', { id: 'progress-text', class: 'text', innerHTML: '0%', style: { flex: '1', fontSize: '1.25rem' } }),
                  new Element('a', { id: 'progress-result', class: 'text', innerHTML: 'Download', style: { fontSize: '1.25rem', transition: 'opacity 0.5s', opacity: '0' } }),
                ]),
                new Element('div', { style: { backgroundColor: 'color-mix(in srgb, $text_color, $background_color 85%)', borderRadius: '1rem', width: '100%', height: '0.3rem', overflow: 'hidden' } }, [
                  new Element('div', { id: 'progress-bar', style: { backgroundColor: '$text_color', width: '0%', height: '100%', transition: 'width 0.5s' } })
                ])
              ])
            ])
          ])
        ])
      ]),
      new Element('script', { type: 'module', src: '/Scripts/Download.mjs' })
    ])
  }
}
