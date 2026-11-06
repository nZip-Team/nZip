import type { PageModule } from './Pages'
import { LIVE_RELOAD_CLIENT } from './LiveReload'

import Config from '../../Config'

const NO_BLUR_SCRIPT = "if (/(?:^|;\\s*)blur=0(?:;|$)/.test(document.cookie)) document.documentElement.classList.add('no-blur')"

/**
 * Frame component that wraps around each page's content to provide a consistent HTML structure.
 * @param page The page object containing title, description, keywords, and content.
 * @param args Additional arguments, including optional analytics script URL.
 * @returns A complete HTML document as a string.
 */
export default (page: ReturnType<PageModule>, args: { analytics?: string | null; lang?: string }) => {
  const htmlLang = args.lang ? args.lang.replace('_', '-') : 'en'
  const html = (
    <html lang={htmlLang}>
      <head>
        <title>{page.title}</title>
        <meta name="title" content={page.title} />
        <meta name="description" content={page.description} />
        <meta property="og:title" content={page.title} />
        <meta property="og:description" content={page.description} />
        {page.keywords && <meta name="keywords" content={page.keywords} />}

        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta charset="utf-8" />

        <link rel="icon" href="/Images/icon.ico" />
        <link rel="stylesheet" href="/Styles/Main.css" />
        <script dangerouslySetInnerHTML={{ __html: NO_BLUR_SCRIPT }} />
      </head>
      <body>{page.content}</body>
      {Config.development && <script dangerouslySetInnerHTML={{ __html: LIVE_RELOAD_CLIENT }}></script>}
    </html>
  ).toString()

  return '<!DOCTYPE html>' + html.replace('</head>', (args.analytics || '') + '</head>')
}
