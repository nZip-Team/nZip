import type { PageModule } from './Pages'

/**
 * Frame component that wraps around each page's content to provide a consistent HTML structure.
 * @param page The page object containing title, description, keywords, and content.
 * @param args Additional arguments, including optional analytics script URL.
 * @returns A complete HTML document as a string.
 */
export default (page: ReturnType<PageModule>, args: { analytics?: string | null }) => {
  const html = (
    <html lang="en">
      <head>
        <title>{page.title}</title>
        <meta name="title" content={page.title} />
        <meta name="description" content={page.description} />
        <meta name="og:title" content={page.title} />
        <meta name="og:description" content={page.description} />
        {page.keywords && <meta name="keywords" content={page.keywords} />}

        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta charset="utf-8" />

        <link rel="icon" href="/Images/icon.ico" />
        <link rel="stylesheet" href="/Styles/Main.css" />
      </head>
      <body>{page.content}</body>
    </html>
  ).toString()

  return '<!DOCTYPE html>' + html.replace('</head>', (args.analytics || '') + '</head>')
}
