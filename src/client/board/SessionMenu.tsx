/**
 * The card's conversation slot (P3 v2).
 *
 * A task can run many times and reuse a session, so the card shows the newest
 * CONVERSATION: click it for every conversation the card ran in (aggregated by
 * session, with round counts), or — when the card has none — to compose the
 * opening message and start the first one.
 *
 * The composer previews exactly what the execution would send (`openingBody`):
 * the plugin framing line is injected on top and is never part of this text.
 *
 * @module dsh-taskboard/client/board/SessionMenu
 */
import { useState } from 'react'
import type { BoardController } from '../controller.ts'
import { sessionsOf, type TaskRecord } from '../../shared/protocol.ts'
import { useT } from '../i18n/runtime.ts'

/** Short id shown on the chip (session ids are long UUIDs). */
const shortId = (id: string): string => (id.length > 12 ? `${id.slice(0, 8)}…` : id)

/** The session slot rendered inside a task card. */
export function SessionMenu({ controller, task }: { controller: BoardController; task: TaskRecord }) {
  const t = useT()
  const sessions = sessionsOf(task)
  const latest = sessions[0]
  const [panel, setPanel] = useState<'list' | 'compose'>()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  const openCompose = (): void => {
    setPanel('compose')
    setText('')
    void controller.openingBodyFor(task.id).then(body => { if (body !== undefined) setText(body) })
  }

  const send = (): void => {
    setBusy(true)
    void controller.startWithOpeningBody(task.id, text).then(ok => {
      setBusy(false)
      if (ok) setPanel(undefined)
    })
  }

  const copy = (): void => {
    void navigator.clipboard?.writeText(text).catch(() => undefined)
  }

  return (
    <span className="dsh-atb-sessmenu" onClick={event => event.stopPropagation()}>
      {latest === undefined
        ? (
          <button
            type="button"
            className="dsh-atb-sess-slot"
            data-empty="true"
            title={t('card.sessions.openTitle')}
            onClick={() => (panel === 'compose' ? setPanel(undefined) : openCompose())}
          >＋ {t('card.sessions.open')}</button>
        )
        : (
          <button
            type="button"
            className="dsh-atb-sess-slot"
            data-outcome={latest.outcome}
            title={t('card.sessions.listTitle')}
            onClick={() => setPanel(panel === 'list' ? undefined : 'list')}
          >🤖 {shortId(latest.sessionId)}</button>
        )}

      {panel === 'list' && (
        <div className="dsh-atb-sess-panel" role="dialog" aria-label={t('detail.sessions.title')}>
          <div className="dsh-atb-sess-head">
            <span>{t('detail.sessions.title')}</span>
            <span className="dsh-atb-sess-count">{sessions.length}</span>
            <button type="button" className="dsh-atb-sess-x" aria-label={t('shared.close')} onClick={() => setPanel(undefined)}>✕</button>
          </div>
          {sessions.map(session => (
            <button
              key={session.sessionId}
              type="button"
              className="dsh-atb-sess-row"
              data-outcome={session.outcome}
              title={t('detail.sessions.jump')}
              onClick={() => { void controller.openSession(session.sessionId) }}
            >
              <code>{shortId(session.sessionId)}</code>
              <span className="dsh-atb-sess-state">{t(`outcome.${session.outcome}`)}</span>
              <span className="dsh-atb-sess-rounds">{t('detail.sessions.rounds', { n: session.rounds })}</span>
            </button>
          ))}
          <button
            type="button"
            className="dsh-atb-sess-foot"
            onClick={() => { setPanel(undefined); controller.select(task.id) }}
          >{t('detail.sessions.footer')}</button>
        </div>
      )}

      {panel === 'compose' && (
        <div className="dsh-atb-sess-panel" role="dialog" aria-label={t('compose.title')}>
          <div className="dsh-atb-sess-head">
            <span>{t('compose.title')}</span>
            <button type="button" className="dsh-atb-sess-x" aria-label={t('shared.close')} onClick={() => setPanel(undefined)}>✕</button>
          </div>
          <p className="dsh-atb-sess-hint">{t('compose.emptyHint')}</p>
          <p className="dsh-atb-sess-note">{t('compose.framingNote')}</p>
          <textarea
            className="dsh-atb-sess-text"
            aria-label={t('compose.body')}
            value={text}
            rows={8}
            onChange={event => setText(event.target.value)}
          />
          <div className="dsh-atb-sess-actions">
            <button type="button" className="dsh-atb-btn" onClick={copy} disabled={text.trim().length === 0}>{t('compose.copy')}</button>
            <button
              type="button"
              className="dsh-atb-btn"
              data-primary="true"
              disabled={busy || text.trim().length === 0}
              onClick={send}
            >{t('compose.send')}</button>
          </div>
        </div>
      )}
    </span>
  )
}
