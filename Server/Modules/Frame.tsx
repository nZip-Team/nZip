import type { PageModule } from './Pages'
import { LIVE_RELOAD_CLIENT } from './LiveReload'
import { toLocaleTag } from './Language'

import { readFileSync } from 'fs'
import path from 'path'

import Config from '../../Config'
import { PRECONNECT_ORIGINS } from '../Tools/Preconnect'

// Changes with the file, so CDN and browser caches never serve an old stylesheet
const STYLE_VERSION = Bun.hash(readFileSync(path.join(process.cwd(), 'App/Styles/Main.css'))).toString(36)

// Absolute URLs (canonical, og:url, og:image) only when HOST is a real public origin
const ORIGIN = /^https?:\/\/(localhost|127\.|\[::1\])/i.test(Config.httpHost) ? '' : Config.httpHost.replace(/\/+$/, '')

const THEME_COLORS = { dark: '#000000', light: '#ffffff' }

// Cookie preferences applied before paint (blur off, forced theme); Server/Scripts/Preferences.ts keeps them in sync
const PREFERENCES_SCRIPT = `(function(){var c=document.cookie,r=document.documentElement;if(/(?:^|;\\s*)blur=0(?:;|$)/.test(c))r.classList.add('no-blur');var m=c.match(/(?:^|;\\s*)theme=(light|dark)(?:;|$)/);if(m){r.setAttribute('data-theme',m[1]);document.querySelectorAll('meta[name="theme-color"]').forEach(function(e){e.setAttribute('content',m[1]==='light'?'${THEME_COLORS.light}':'${THEME_COLORS.dark}')})}})()`

/**
 * Frame component that wraps around each page's content to provide a consistent HTML structure.
 * @param page The page object containing title, description, keywords, and content.
 * @param args Additional arguments, including optional analytics script URL.
 * @returns A complete HTML document as a string.
 */
export default (page: ReturnType<PageModule>, args: { analytics?: string | null; lang?: string }) => {
  const code = args.lang || 'en_us'
  const url = ORIGIN && page.path ? ORIGIN + page.path : ''

  const html = (
    <html lang={toLocaleTag(code)} data-language={code}>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        {PRECONNECT_ORIGINS.map((origin) => (
          <link rel="preconnect" href={origin} />
        ))}
        <title>{page.title}</title>
        <meta name="title" content={page.title} />
        <meta name="description" content={page.description} />
        {page.keywords && <meta name="keywords" content={page.keywords} />}
        {page.noindex && <meta name="robots" content="noindex" />}
        {url && <link rel="canonical" href={url} />}

        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="nZip" />
        <meta property="og:title" content={page.title} />
        <meta property="og:description" content={page.description} />
        <meta property="og:locale" content={toLocaleTag(code).replace('-', '_')} />
        {url && <meta property="og:url" content={url} />}
        {/* Only ever the site logo, never a gallery cover */}
        {ORIGIN && <meta property="og:image" content={`${ORIGIN}/Images/logo.png`} />}
        <meta name="twitter:card" content="summary" />

        <meta name="color-scheme" content="dark light" />
        <meta name="theme-color" content={THEME_COLORS.dark} media="(prefers-color-scheme: dark)" />
        <meta name="theme-color" content={THEME_COLORS.light} media="(prefers-color-scheme: light)" />

        <link rel="icon" href="/Images/icon.ico" />
        <link rel="apple-touch-icon" href="/Images/icon.png" />
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="stylesheet" href={`/Styles/Main.css?v=${STYLE_VERSION}`} />
        <script dangerouslySetInnerHTML={{ __html: PREFERENCES_SCRIPT }} />
      </head>
      <body className={page.bodyClass}>
        {page.content}
        {Config.development && <script dangerouslySetInnerHTML={{ __html: LIVE_RELOAD_CLIENT }}></script>}
      </body>
    </html>
  ).toString()

  return '<!DOCTYPE html>' + html.replace('</head>', (args.analytics || '') + '</head>')
}
