// Settings → Account → API tokens: long-lived ogr_/ogw_ tokens for outside integrations
// (api/read-tokens.js). Listed and revoked with the session; the secret is shown once at create.
import { useEffect, useState, useRef } from 'react'
import { useUI } from '../store/useUI.js'
import { api } from '../lib/api.js'
import { copyText } from '../lib/clipboard.js'
import { t } from '../lib/i18n.js'
import { Button, Row, Section } from './ui.jsx'
import Icon from './Icon.jsx'

const ui = () => useUI.getState()
const toast = m => ui().toast(m)

const spin = {
  display: 'inline-block', width: 16, height: 16, marginRight: 8,
  border: '2px solid color-mix(in srgb, currentColor 30%, transparent)',
  borderTopColor: 'currentColor', borderRadius: '50%',
  animation: 'og-spin .7s linear infinite', verticalAlign: '-2px',
}

function timeAgo(isoDate) {
  if (!isoDate) return null
  const ms = Date.now() - new Date(isoDate).getTime()
  const sec = Math.floor(ms / 1000)
  const min = Math.floor(sec / 60)
  const hr = Math.floor(min / 60)
  const day = Math.floor(hr / 24)
  if (day > 0) return t('{0} days ago', day)
  if (hr > 0) return t('{0} hours ago', hr)
  if (min > 0) return t('{0} minutes ago', min)
  return t('Just now')
}

function expirationInfo(expiresIso) {
  if (!expiresIso) return { text: t('Never expires'), warn: false, expired: false }
  const now = Date.now()
  const exp = new Date(expiresIso).getTime()
  const daysLeft = Math.floor((exp - now) / 86400000)
  if (exp < now) return { text: t('Expired'), warn: false, expired: true }
  if (daysLeft <= 7) return { text: t('Expires in {0} days', Math.max(daysLeft, 0)), warn: true, expired: false }
  return { text: t('Expires {0}', new Date(expiresIso).toLocaleDateString()), warn: false, expired: false }
}

function TokenCard({ token, onRevoke }) {
  const exp = expirationInfo(token.expires)
  const scopeLabel = token.scope === 'routines' ? t('Routines') : t('Read-only')
  const lastUse = token.lastUsed ? timeAgo(token.lastUsed) : t('Never used')
  const [menuOpen, setMenuOpen] = useState(false)

  return (
    <div style={{
      padding: 16, borderRadius: 'var(--r-card)', background: 'var(--surface)',
      marginBottom: 12, opacity: exp.expired ? 0.65 : 1, minWidth: 0,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8, marginBottom: 12 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 16, fontWeight: 600, marginBottom: 8, color: 'var(--label)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {token.name}
          </div>
          <div style={{
            display: 'inline-block', padding: '4px 10px', borderRadius: 6, fontSize: 13, fontWeight: 600,
            background: token.scope === 'routines'
              ? 'color-mix(in srgb, var(--green) 16%, transparent)'
              : 'color-mix(in srgb, var(--blue) 16%, transparent)',
            color: token.scope === 'routines' ? 'var(--green)' : 'var(--blue)',
          }}>
            {scopeLabel}
          </div>
        </div>
        <button
          type="button"
          onClick={() => setMenuOpen(o => !o)}
          style={{
            flex: 'none', width: 44, height: 44, margin: '-8px -8px 0 0',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--label-2)', fontSize: 22, lineHeight: 1,
          }}
          aria-label={t('Options')}
          aria-expanded={menuOpen}
        >
          ⋯
        </button>
      </div>

      <div style={{ fontSize: 13, color: 'var(--label-2)', marginBottom: 4, lineHeight: 1.4 }}>
        {t('Created')} {timeAgo(token.created)}
      </div>
      <div style={{ fontSize: 13, color: 'var(--label-2)', marginBottom: 4, lineHeight: 1.4 }}>
        {t('Last use')}: {lastUse}
      </div>
      <div style={{
        fontSize: 13, lineHeight: 1.4,
        color: exp.expired ? 'var(--label-3)' : exp.warn ? 'var(--orange)' : 'var(--label-2)',
        fontWeight: exp.warn ? 600 : 400,
      }}>
        {exp.text}
      </div>

      {menuOpen && (
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: 'var(--hair) solid var(--sep)' }}>
          <button
            type="button"
            onClick={() => { setMenuOpen(false); onRevoke(token) }}
            style={{
              width: '100%', minHeight: 44, padding: '12px 4px',
              background: 'none', border: 'none', color: 'var(--red)',
              fontSize: 15, fontWeight: 600, cursor: 'pointer', textAlign: 'left',
            }}
          >
            {t('Revoke token')}
          </button>
        </div>
      )}
    </div>
  )
}

function CreateTokenForm({ close, onCreated }) {
  const nameRef = useRef(null)
  const [name, setName] = useState('')
  const [scope, setScope] = useState('read')
  const [expDays, setExpDays] = useState(90)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState(null)

  useEffect(() => { nameRef.current?.focus() }, [])

  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      setErr(t('Enter a name for this token'))
      nameRef.current?.focus()
      return
    }
    setLoading(true)
    setErr(null)
    try {
      const body = { name: trimmed, scope }
      if (expDays > 0) body.expiresAt = new Date(Date.now() + expDays * 86400000).toISOString()
      const res = await api('/api/account/read-tokens', { method: 'POST', body: JSON.stringify(body) })
      close()
      onCreated(res.readToken, res.token)
    } catch {
      setErr(t('Could not create token'))
      setLoading(false)
    }
  }

  const radio = (value, title, subtitle) => (
    <label style={{
      display: 'flex', alignItems: 'flex-start', gap: 12, padding: 14,
      border: `2px solid ${scope === value ? 'var(--acc)' : 'var(--sep)'}`,
      borderRadius: 'var(--r)', cursor: loading ? 'default' : 'pointer', minHeight: 44,
      background: scope === value ? 'var(--acc-soft)' : 'transparent',
    }}>
      <input
        type="radio" name="token-scope" checked={scope === value}
        onChange={() => setScope(value)} disabled={loading}
        style={{ marginTop: 3, width: 18, height: 18, flex: 'none', accentColor: 'var(--acc)' }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4, color: 'var(--label)' }}>{title}</div>
        <div style={{ fontSize: 13, color: 'var(--label-2)', lineHeight: 1.4 }}>{subtitle}</div>
      </div>
    </label>
  )

  return <>
    <div style={{ marginBottom: 20 }}>
      <label style={{ display: 'block', marginBottom: 8, fontSize: 14, fontWeight: 600, color: 'var(--label)' }}>
        {t('Name')}
      </label>
      <input
        ref={nameRef}
        className="field"
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder={t('My integration')}
        maxLength={60}
        disabled={loading}
        style={{ width: '100%', fontSize: 15, minHeight: 44 }}
      />
    </div>

    <div style={{ marginBottom: 20 }}>
      <div style={{ marginBottom: 12, fontSize: 14, fontWeight: 600, color: 'var(--label)' }}>
        {t('Permissions')}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {radio('read', t('Read-only'), t('Read routines, workouts, and settings. Cannot make changes.'))}
        {radio('routines', t('Routines'), t('Create, edit, and delete routines. Cannot touch workouts or settings.'))}
      </div>
    </div>

    <div style={{ marginBottom: 24 }}>
      <label style={{ display: 'block', marginBottom: 8, fontSize: 14, fontWeight: 600, color: 'var(--label)' }}>
        {t('Expiration')}
      </label>
      <select
        value={expDays}
        onChange={e => setExpDays(Number(e.target.value))}
        className="field"
        disabled={loading}
        style={{ width: '100%', fontSize: 15, minHeight: 44 }}
      >
        <option value={30}>{t('30 days')}</option>
        <option value={90}>{t('90 days')}</option>
        <option value={365}>{t('1 year')}</option>
        <option value={0}>{t('Never expires')}</option>
      </select>
    </div>

    {err && <div style={{ color: 'var(--red)', fontSize: 14, marginBottom: 12 }}>{err}</div>}

    <Button variant="primary" onClick={submit} disabled={loading} style={{ minHeight: 44 }}>
      {loading ? <><span style={spin} aria-hidden />{t('Creating…')}</> : t('Create')}
    </Button>
  </>
}

export const createTokenSheet = (onCreated) => ui().openSheet(close => (
  <CreateTokenForm close={close} onCreated={onCreated} />
), { title: t('Create API token') })

function TokenCreatedSheet({ token, tokenValue, close, onDone }) {
  const [copied, setCopied] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)

  const copy = async () => {
    try { await copyText(tokenValue) } catch { /* still mark copied so close is not blocked */ }
    setCopied(true)
    toast(t('Token copied'))
  }

  const finish = () => { close(); onDone?.() }

  const handleClose = () => {
    if (!copied && !confirmClose) setConfirmClose(true)
    else finish()
  }

  if (confirmClose) {
    return <>
      <h3 style={{ marginBottom: 12, textAlign: 'center' }}>{t('Close without copying?')}</h3>
      <div style={{ fontSize: 15, color: 'var(--label-2)', marginBottom: 24, lineHeight: 1.5, textAlign: 'center' }}>
        {t("You won't be able to see this token again. Make sure you've saved it somewhere safe.")}
      </div>
      <Button onClick={() => setConfirmClose(false)} style={{ marginBottom: 8, minHeight: 44 }}>{t('Go back')}</Button>
      <Button variant="danger" onClick={finish} style={{ minHeight: 44 }}>{t('Close anyway')}</Button>
    </>
  }

  return <>
    <div style={{
      padding: 12,
      background: 'color-mix(in srgb, var(--yellow) 16%, var(--surface))',
      border: '1px solid color-mix(in srgb, var(--yellow) 40%, transparent)',
      borderRadius: 'var(--r)', marginBottom: 20, fontSize: 14, lineHeight: 1.5, color: 'var(--label)',
    }}>
      <strong>{t("Copy it now — you won't see it again.")}</strong>
    </div>

    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 13, color: 'var(--label-2)', marginBottom: 8 }}>{token.name}</div>
      <div style={{
        padding: 16, background: 'var(--surface-2)', borderRadius: 'var(--r)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        fontSize: 13, wordBreak: 'break-all', overflowWrap: 'anywhere', lineHeight: 1.6,
        color: 'var(--label)', maxWidth: '100%',
      }}>
        {tokenValue}
      </div>
    </div>

    <div aria-live="polite" style={{ marginBottom: 8 }}>
      <Button variant="primary" onClick={copy} style={{ minHeight: 48, width: '100%' }}>
        {copied
          ? <><Icon name="check" style={{ marginRight: 8 }} />{t('Copied!')}</>
          : t('Copy token')}
      </Button>
    </div>
    <Button onClick={handleClose} style={{ minHeight: 44 }}>{t("I've saved it")}</Button>
  </>
}

export const showTokenCreated = (token, tokenValue, onDone) => ui().openSheet(close => (
  <TokenCreatedSheet token={token} tokenValue={tokenValue} close={close} onDone={onDone} />
), { title: t('Token created'), kind: 'center' })

function RevokeDialog({ token, close, onDone }) {
  const [loading, setLoading] = useState(false)

  const revoke = async () => {
    setLoading(true)
    try {
      await api(`/api/account/read-tokens?id=${encodeURIComponent(token.id)}`, { method: 'DELETE' })
      toast(t('Token revoked'))
      close()
      onDone?.()
    } catch {
      toast(t('Could not revoke token'))
      setLoading(false)
    }
  }

  return <>
    <h3 style={{ marginBottom: 12, textAlign: 'center' }}>{t('Revoke "{0}"?', token.name)}</h3>
    <div style={{ fontSize: 15, color: 'var(--label-2)', marginBottom: 24, lineHeight: 1.5, textAlign: 'center' }}>
      {t('Anything using this token will stop working immediately. This cannot be undone.')}
    </div>
    <Button onClick={close} disabled={loading} style={{ marginBottom: 8, minHeight: 44 }}>{t('Cancel')}</Button>
    <Button variant="danger" onClick={revoke} disabled={loading} style={{ minHeight: 44 }}>
      {loading ? <><span style={spin} aria-hidden />{t('Revoking…')}</> : t('Revoke token')}
    </Button>
  </>
}

export const confirmRevoke = (token, onDone) => ui().openSheet(close => (
  <RevokeDialog token={token} close={close} onDone={onDone} />
), { kind: 'center' })

/** Settings → Account row that opens the tokens sheet. */
export function ApiTokensRow() {
  return (
    <Row
      icon="key"
      iconTint="var(--teal)"
      title={t('API tokens')}
      subtitle={t('For apps and scripts that read or change your routines.')}
      accessory="chevron"
      onClick={() => ui().openSheet(close => <ApiTokensSheet close={close} />, { title: t('API tokens') })}
    />
  )
}

function ApiTokensSheet({ close }) {
  return <>
    <ApiTokensSection embedded />
    <div style={{ height: 8 }} />
    <Button onClick={close} style={{ minHeight: 44 }}>{t('Done')}</Button>
  </>
}

/** Full tokens UI: empty / list / create / revoke. `embedded` skips the Section chrome in a sheet. */
export function ApiTokensSection({ embedded = false }) {
  const [tokens, setTokens] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const loadTokens = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await api('/api/account/read-tokens')
      setTokens(res.tokens || [])
    } catch (e) {
      setError(e.message || t('Could not load tokens'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { loadTokens() }, [])

  const handleCreate = () => {
    createTokenSheet((token, tokenValue) => {
      loadTokens()
      showTokenCreated(token, tokenValue)
    })
  }

  const handleRevoke = (token) => confirmRevoke(token, loadTokens)

  const wrap = (body) => embedded ? <div style={{ minWidth: 0 }}>{body}</div> : <Section title={t('API tokens')}>{body}</Section>

  if (loading && !tokens) {
    return wrap(
      <div aria-busy="true" aria-label={t('API tokens')}>
        {[1, 2].map(i => (
          <div key={i} style={{
            height: 120, background: 'var(--surface)', borderRadius: 'var(--r-card)',
            marginBottom: 12, opacity: 0.45,
          }} />
        ))}
      </div>
    )
  }

  if (error) {
    return wrap(
      <div style={{ padding: '12px 0', textAlign: 'center' }}>
        <div style={{ fontSize: 15, color: 'var(--label-2)', marginBottom: 16, lineHeight: 1.4 }}>{error}</div>
        <Button onClick={loadTokens} style={{ minHeight: 44 }}>{t('Retry')}</Button>
      </div>
    )
  }

  if (!tokens || tokens.length === 0) {
    return wrap(
      <div style={{ padding: embedded ? '8px 0 4px' : '12px 0', textAlign: 'center' }}>
        <div style={{
          fontSize: 15, lineHeight: 1.5, color: 'var(--label-2)', marginBottom: 24,
          maxWidth: 400, marginLeft: 'auto', marginRight: 'auto',
        }}>
          {t('API tokens let external apps read your routines or make changes on your behalf. Each token has its own permissions and can be revoked anytime.')}
        </div>
        <Button variant="primary" onClick={handleCreate} style={{ minHeight: 48 }}>{t('Create token')}</Button>
      </div>
    )
  }

  return wrap(
    <>
      <div style={{ marginBottom: 16 }}>
        <Button variant="primary" onClick={handleCreate} style={{ minHeight: 44 }}>{t('Create token')}</Button>
      </div>
      {tokens.map(token => (
        <TokenCard key={token.id} token={token} onRevoke={handleRevoke} />
      ))}
    </>
  )
}
