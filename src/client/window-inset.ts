/**
 * Reserve top padding for Windows Desktop's caption controls — but only when
 * the plugin view actually sits at the window top.
 *
 * The compatibility shell puts its own control bar above the content and never
 * defines the `titlebar-area-*` environment variables, so a CSS-only
 * `env(titlebar-area-height, 36px)` reservation always fell back to 36px and
 * pushed the whole board ~44px down. The decision therefore lives in JS: look at
 * the measured top instead of guessing from env().
 *
 * @module dsh-taskboard/client/window-inset
 */

/** A view this close to the window top is under the caption buttons. */
const CAPTION_ZONE_PX = 8

/**
 * Whether the view needs a caption inset.
 * @param platform - desktop platform marker ('win32' enables it).
 * @param top - measured viewport offset of the plugin view.
 * @returns true when padding must be reserved for the caption controls.
 */
export function needsCaptionInset(platform: string, top: number): boolean {
  return platform === 'win32' && Number.isFinite(top) && top < CAPTION_ZONE_PX
}

/** Keep injected content below Windows Desktop's native caption controls. */
export function installWindowInset(view: HTMLElement): () => void {
  const platformOf = (): string => document.body.getAttribute('data-dsh-desktop-platform')
    ?? new URLSearchParams(window.location.search).get('dsh-desktop-platform')
    ?? ''

  const update = (): void => {
    const platform = platformOf()
    if (platform !== 'win32') {
      delete view.dataset.dshAtbInset
      view.style.removeProperty('--dsh-atb-viewport-top')
      return
    }
    const top = view.getBoundingClientRect().top
    view.style.setProperty('--dsh-atb-viewport-top', `${top}px`)
    if (needsCaptionInset(platform, top)) view.dataset.dshAtbInset = 'caption'
    else delete view.dataset.dshAtbInset
  }

  let frame: number | undefined
  const schedule = (): void => {
    if (frame !== undefined) return
    frame = requestAnimationFrame(() => { frame = undefined; update() })
  }
  const mutations = new MutationObserver(schedule)
  mutations.observe(document.body, {
    attributes: true, childList: true, subtree: true,
    attributeFilter: ['class', 'data-dsh-desktop-platform', 'data-dsh-desktop-mode', 'data-details-collapsed'],
  })
  const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule)
  resize?.observe(view)
  if (view.parentElement !== null) resize?.observe(view.parentElement)
  window.addEventListener('resize', schedule)
  // The shell lays out its control bar AFTER our first measurement; a couple of
  // delayed probes settle the answer without polling forever.
  const probes = [120, 400, 1_200].map(delay => setTimeout(update, delay))
  schedule()
  return () => {
    mutations.disconnect()
    resize?.disconnect()
    window.removeEventListener('resize', schedule)
    for (const probe of probes) clearTimeout(probe)
    if (frame !== undefined) cancelAnimationFrame(frame)
    delete view.dataset.dshAtbInset
    view.style.removeProperty('--dsh-atb-viewport-top')
  }
}
