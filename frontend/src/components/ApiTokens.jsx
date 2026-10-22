// Settings → Account → API tokens (/settings/tokens): long-lived ogr_/ogw_ tokens for outside
// integrations (api/read-tokens.js). Listed and revoked with the session; the secret is in the
// create answer only, so it is shown once and never again.
import { useEffect, useRef, useState } from 'react'
import { useUI } from '../store/useUI.js'
import { api } from '../lib/api.js'
import { copyText } from '../lib/clipboard.js'
import { t, tn } from '../lib/i18n.js'
import { dateLocale } from '../lib/i18n-core.js'
import { Button } from './ui.jsx'
import Icon from './Icon.jsx'

const ui = () => useUI.getState()
const toast = m => ui().toast(m)
const DAY = 86400000
const WARN_DAYS = 7
// Wide enough for the create form to be a dialog rather than a bottom sheet (index.css uses
// the same breakpoint for its desktop layout).
const desktop = () => !!window.matchMedia?.('(min-width: 1000px)').matches

const Spinner = () => <span className="tok-spin" aria-hidden="true" />

// "hace 2 horas", "ayer": Intl gets plurals and word order right in every pack.
function ago(ms) {
  const rtf = new Intl.RelativeTimeFormat(dateLocale(), { numeric: 'auto' })
  if (ms < 60000) return rtf.format(0, 'second')
  if (ms < 3600000) return rtf.format(-Math.floor(ms / 60000), 'minute')
  if (ms < DAY) return rtf.format(-Math.floor(ms / 3600000), 'hour')
  return rtf.format(-Math.floor(ms / DAY), 'day')
}

// Counts up, so a token due in 2.9 days says 3: "Vence en 3 días", never "pasado mañana".
export function expiryOf(expiresIso, now = Date.now()) {
  if (!expiresIso) return { state: 'none', text: t('Never expires') }
  const at = new Date(expiresIso).getTime(), left = at - now
  if (left <= 0) return { state: 'expired', text: t('Expired token') }
  if (left <= WARN_DAYS * DAY) {
    const text = left < 3600000 ? t('Expires in under an hour')
      : left < DAY ? tn('Expires in 1 hour', 'Expires in {0} hours', Math.ceil(left / 3600000))
      : tn('Expires in 1 day', 'Expires in {0} days', Math.ceil(left / DAY))
    return { state: 'soon', text }
  }
  return { state: 'later', text: t('Expires on {0}', new Date(at).toLocaleDateString(dateLocale())) }
}

// ⋯ with the token's one action. Revoking is never on the card itself.
function TokenMenu({ name, onRevoke }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const away = e => { if (!ref.current?.contains(e.target)) setOpen(false) }
    const key = e => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', key) }
  }, [open])
  return (
    <div className="tok-menu" ref={ref}>
      <button type="button" className="tok-more" aria-label={t('Options for {0}', name)} aria-haspopup="menu"
        aria-expanded={open} onClick={() => setOpen(o => !o)}>⋯</button>
      {open && <div className="tok-pop" role="menu">
        <button type="button" role="menuitem" className="tok-pop-i danger" onClick={() => { setOpen(false); onRevoke() }}>
          {t('Revoke token')}
        </button>
      </div>}
    </div>
  )
}

function TokenCard({ token, onRevoke }) {
  const exp = expiryOf(token.expires)
  const expired = exp.state === 'expired'
  const now = Date.now()
  return (
    <div className={'tok-card' + (expired ? ' expired' : '')}>
      <div className="tok-head">
        <div className="tok-name tok-dim">{token.name}</div>
        <TokenMenu name={token.name} onRevoke={() => onRevoke(token)} />
      </div>
      <div className="tok-badges">
        <span className={'tok-badge ' + (token.scope === 'routines' ? 'routines' : 'read')}>
          {token.scope === 'routines' ? t('Routines') : t('Read-only')}
        </span>
        {expired && <span className="tok-badge expired">{exp.text}</span>}
      </div>
      <div className="tok-meta tok-dim">{t('Created {0}', ago(now - new Date(token.created).getTime()))}</div>
      <div className="tok-meta tok-dim">
        {token.lastUsed ? t('Last use: {0}', ago(now - new Date(token.lastUsed).getTime())) : t('Never used')}
      </div>
      {!expired && <div className={'tok-meta' + (exp.state === 'soon' ? ' tok-warn' : ' tok-dim')}>{exp.text}</div>}
    </div>
  )
}

function SheetHead({ title, close }) {
  return (
    <div className="tok-sheet-h">
      <h3>{title}</h3>
      <button type="button" className="tok-x" aria-label={t('Close')} onClick={close}><Icon name="xmark" /></button>
    </div>
  )
}

export function CreateTokenForm({ close, onCreated }) {
  const nameRef = useRef(null)
  const [name, setName] = useState('')
  const [scope, setScope] = useState('read')
  const [expDays, setExpDays] = useState(90)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  useEffect(() => { nameRef.current?.focus() }, [])

  const submit = async e => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true); setErr(null)
    try {
      const body = { name: trimmed, scope }
      if (expDays > 0) body.expiresAt = new Date(Date.now() + expDays * DAY).toISOString()
      const res = await api('/api/account/read-tokens', { method: 'POST', body: JSON.stringify(body) })
      close()
      onCreated(res.readToken, res.token)
    } catch {
      setErr(t('Could not create token'))
      setBusy(false)
    }
  }

  const radio = (value, title, subtitle) => (
    <label className={'tok-radio' + (scope === value ? ' on' : '')}>
      <input type="radio" name="token-scope" value={value} checked={scope === value}
        onChange={() => setScope(value)} disabled={busy} />
      <span>
        <span className="tok-radio-t">{title}</span>
        <span className="tok-radio-s">{subtitle}</span>
      </span>
    </label>
  )

  return (
    <form className="tok-form" onSubmit={submit}>
      <SheetHead title={t('Create API token')} close={close} />
      <div className="tok-field">
        <label className="tok-label" htmlFor="tok-name">{t('Name')}</label>
        <input id="tok-name" ref={nameRef} className="field tok-input" value={name} maxLength={60}
          onChange={e => setName(e.target.value)} placeholder={t('My integration')} disabled={busy} autoComplete="off" />
      </div>
      <fieldset className="tok-field">
        <legend className="tok-label">{t('Permissions')}</legend>
        {radio('read', t('Read-only'), t('Read routines, workouts, and settings. Cannot make changes.'))}
        {radio('routines', t('Routines'), t('Create, edit, and delete routines. Cannot touch workouts or settings.'))}
      </fieldset>
      <div className="tok-field">
        <label className="tok-label" htmlFor="tok-exp">{t('Expiration')}</label>
        <select id="tok-exp" className="field tok-input" value={expDays} disabled={busy}
          onChange={e => setExpDays(Number(e.target.value))}>
          <option value={30}>{t('30 days')}</option>
          <option value={90}>{t('90 days')}</option>
          <option value={365}>{t('1 year')}</option>
          <option value={0}>{t('Never expires')}</option>
        </select>
      </div>
      {err && <div className="tok-err" role="alert">{err}</div>}
      <div className="tok-actions">
        <Button type="button" variant="secondary" onClick={close} disabled={busy}>{t('Cancel')}</Button>
        <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
          {busy ? <><Spinner />{t('Creating…')}</> : t('Create')}
        </Button>
      </div>
    </form>
  )
}

export const createTokenSheet = onCreated => ui().openSheet(close => (
  <CreateTokenForm close={close} onCreated={onCreated} />
), { kind: desktop() ? 'center' : 'sheet' })

export function TokenCreatedSheet({ token, tokenValue, close }) {
  const [copied, setCopied] = useState(false)
  const [copyErr, setCopyErr] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)

  const copy = async () => {
    const ok = await copyText(tokenValue)
    setCopied(ok)
    setCopyErr(!ok)
  }
  const done = () => { if (copied) close(); else setConfirmClose(true) }

  // The sheet is locked (Modals' Esc and backdrop would skip the not-copied check), so Esc is ours.
  useEffect(() => {
    const key = e => {
      if (e.key !== 'Escape') return
      if (confirmClose) setConfirmClose(false)
      else if (copied) close()
      else setConfirmClose(true)
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [confirmClose, copied])

  if (confirmClose) {
    return <div className="tok-created">
      <h3 className="tok-dialog-t">{t('Close without copying?')}</h3>
      <p className="tok-dialog-p">{t("You won't be able to see this token again. Make sure you've saved it somewhere safe.")}</p>
      <div className="tok-actions">
        <Button variant="secondary" onClick={() => setConfirmClose(false)}>{t('Go back')}</Button>
        <Button variant="destructive" onClick={close}>{t('Close anyway')}</Button>
      </div>
    </div>
  }

  return <div className="tok-created">
    <h3 className="tok-dialog-t">{t('Token created')}</h3>
    <div className="tok-alert">{t("Copy it now — you won't see it again.")}</div>
    <div className="tok-label">{token.name}</div>
    <div className="tok-secret">{tokenValue}</div>
    <div className="tok-copy-live" aria-live="polite">
      <Button variant="primary" className="tok-copy" onClick={copy}>{copied ? t('Copied ✓') : t('Copy token')}</Button>
      {copyErr && <div className="tok-err">{t('Could not copy. Select the token and copy it by hand.')}</div>}
    </div>
    <Button variant="secondary" onClick={done}>{t("I've saved it")}</Button>
  </div>
}

export const showTokenCreated = (token, tokenValue) => ui().openSheet(close => (
  <TokenCreatedSheet token={token} tokenValue={tokenValue} close={close} />
), { kind: 'center', locked: true })

function RevokeDialog({ token, close, onDone }) {
  const [busy, setBusy] = useState(false)
  const revoke = async () => {
    setBusy(true)
    try {
      const res = await api(`/api/account/read-tokens?id=${encodeURIComponent(token.id)}`, { method: 'DELETE' })
      close()
      toast(t('Token revoked'))
      onDone(Array.isArray(res?.tokens) ? res.tokens : null)
    } catch {
      toast(t('Could not revoke token'))
      setBusy(false)
    }
  }
  return <>
    <h3 className="tok-dialog-t">{t('Revoke "{0}"?', token.name)}</h3>
    <p className="tok-dialog-p">{t('Anything using this token will stop working immediately. This cannot be undone.')}</p>
    <div className="tok-actions">
      <Button variant="secondary" onClick={close} disabled={busy}>{t('Cancel')}</Button>
      <Button variant="destructive" onClick={revoke} disabled={busy}>
        {busy ? <><Spinner />{t('Revoking…')}</> : t('Revoke token')}
      </Button>
    </div>
  </>
}

export const confirmRevoke = (token, onDone) => ui().openSheet(close => (
  <RevokeDialog token={token} close={close} onDone={onDone} />
), { kind: 'center' })

/** The page body: skeleton, error, empty state or the list. */
export function ApiTokensPage() {
  const [tokens, setTokens] = useState(null)
  const [error, setError] = useState(false)

  const load = async () => {
    setError(false)
    try {
      const res = await api('/api/account/read-tokens')
      setTokens(res.tokens || [])
    } catch {
      setError(true)
    }
  }
  useEffect(() => { load() }, [])

  const create = () => createTokenSheet((token, value) => {
    setTokens(list => [...(list || []), token])
    showTokenCreated(token, value)
  })
  const revoke = token => confirmRevoke(token, list => {
    if (list) setTokens(list)
    else setTokens(cur => (cur || []).filter(x => x.id !== token.id))
  })

  if (error && !tokens) {
    return <div className="tok-error" role="alert">
      <p className="tok-empty">{t('Could not load tokens')}</p>
      <Button variant="secondary" onClick={() => { setTokens(null); load() }}>{t('Retry')}</Button>
    </div>
  }
  if (!tokens) {
    return <div aria-busy="true">
      <div className="tok-skel" /><div className="tok-skel" />
    </div>
  }
  if (!tokens.length) {
    return <>
      <p className="tok-empty">
        {t('API tokens let external apps read your routines or make changes on your behalf. Each token has its own permissions and can be revoked anytime.')}
      </p>
      <Button variant="primary" onClick={create}>{t('Create token')}</Button>
    </>
  }
  return <>
    <Button variant="primary" onClick={create}>{t('Create token')}</Button>
    <div className="tok-list">
      {tokens.map(token => <TokenCard key={token.id} token={token} onRevoke={revoke} />)}
    </div>
  </>
}
