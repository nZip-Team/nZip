// "Back" links point home so they work without JS; after a page of this site they go back instead

function cameFromThisSite(): boolean {
  try {
    return !!document.referrer && new URL(document.referrer).origin === location.origin && history.length > 1
  } catch {
    return false
  }
}

if (cameFromThisSite()) {
  document.querySelectorAll<HTMLAnchorElement>('a[data-back]').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault()
      history.back()
    })
  })
}

export {}
