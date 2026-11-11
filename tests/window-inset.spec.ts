// @vitest-environment jsdom
/**
 * Caption-inset helper: reserve top padding ONLY when the plugin view really
 * starts at the window top (overlay titlebar). The DSH Desktop compatibility
 * mode puts its own control bar above the content, so the view starts much
 * lower — reserving there produced ~44px of dead space (the shell never
 * defines the titlebar-area env vars, so the CSS fell back to 36px).
 */
import { afterEach, expect, it, vi } from 'vitest'
import { installWindowInset, needsCaptionInset } from '../src/client/window-inset.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
  document.body.removeAttribute('data-dsh-desktop-platform')
  window.history.replaceState(null, '', '/')
})

it('decides purely on platform and measured top', () => {
  expect(needsCaptionInset('win32', 0)).toBe(true)
  expect(needsCaptionInset('win32', 4)).toBe(true)
  // The shell already offset us: nothing to reserve.
  expect(needsCaptionInset('win32', 36)).toBe(false)
  expect(needsCaptionInset('win32', 96)).toBe(false)
  expect(needsCaptionInset('darwin', 0)).toBe(false)
  expect(needsCaptionInset('', 0)).toBe(false)
})

it('marks the view only while it sits at the window top, and follows moves', async () => {
  vi.useFakeTimers()
  window.history.replaceState(null, '', '/?dsh-desktop-platform=win32')
  const view = document.createElement('div')
  document.body.append(view)
  let top = 0
  vi.spyOn(view, 'getBoundingClientRect').mockImplementation(() => ({ top }) as DOMRect)
  const dispose = installWindowInset(view)
  await vi.advanceTimersByTimeAsync(30)
  expect(view.getAttribute('data-dsh-atb-inset')).toBe('caption')
  expect(view.style.getPropertyValue('--dsh-atb-viewport-top')).toBe('0px')

  // The shell's control bar appears: the view is pushed down, so stop reserving.
  top = 96
  view.dispatchEvent(new Event('dsh-atb-probe'))
  await vi.advanceTimersByTimeAsync(30)
  window.dispatchEvent(new Event('resize'))
  await vi.advanceTimersByTimeAsync(30)
  expect(view.getAttribute('data-dsh-atb-inset')).toBeNull()

  dispose()
  top = 0
  window.dispatchEvent(new Event('resize'))
  await vi.advanceTimersByTimeAsync(30)
  expect(view.getAttribute('data-dsh-atb-inset')).toBeNull()
  expect(view.style.getPropertyValue('--dsh-atb-viewport-top')).toBe('')
})

it('leaves Web and macOS alone, handles late Desktop activation', async () => {
  vi.useFakeTimers()
  const view = document.createElement('div')
  document.body.append(view)
  vi.spyOn(view, 'getBoundingClientRect').mockImplementation(() => ({ top: 0 }) as DOMRect)
  const dispose = installWindowInset(view)
  await vi.advanceTimersByTimeAsync(30)
  expect(view.getAttribute('data-dsh-atb-inset')).toBeNull()
  document.body.setAttribute('data-dsh-desktop-platform', 'darwin')
  await vi.advanceTimersByTimeAsync(30)
  expect(view.getAttribute('data-dsh-atb-inset')).toBeNull()
  document.body.setAttribute('data-dsh-desktop-platform', 'win32')
  await vi.advanceTimersByTimeAsync(30)
  expect(view.getAttribute('data-dsh-atb-inset')).toBe('caption')
  document.body.removeAttribute('data-dsh-desktop-platform')
  await vi.advanceTimersByTimeAsync(30)
  expect(view.getAttribute('data-dsh-atb-inset')).toBeNull()
  dispose()
})
