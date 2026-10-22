// @vitest-environment happy-dom
// Settings → API tokens: the create form refuses an empty name and closes on Esc (Modals' own
// handler, as in the app), and the one-time secret's copy button says so where a screen reader
// hears it.
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => {
  const listeners = new Set()
  const state = {
    sheets: [],
    toast: () => {},
    openSheet(render, { kind = 'sheet', locked = false } = {}) {
      const id = Math.random().toString(36).slice(2)
      state.sheets = [...state.sheets, { id, render, kind, locked }]
      listeners.forEach(l => l())
      return { id, close: () => state.closeSheet(id) }
    },
    closeSheet(id) {
      state.sheets = state.sheets.filter(s => s.id !== id)
      listeners.forEach(l => l())
    },
  }
  return { state, listeners, api: null, copy: null }
})

vi.mock('../store/useUI.js', async () => {
  const React = await import('react')
  const subscribe = l => { mocks.listeners.add(l); return () => mocks.listeners.delete(l) }
  const useUI = (selector = s => s) => React.useSyncExternalStore(subscribe, () => selector(mocks.state), () => selector(mocks.state))
  useUI.getState = () => mocks.state
  return { useUI }
})
vi.mock('../lib/api.js', () => ({ api: (...a) => mocks.api(...a) }))
vi.mock('../lib/clipboard.js', () => ({ copyText: (...a) => mocks.copy(...a) }))

import Modals from './Modals.jsx'
import { createTokenSheet, expiryOf, showTokenCreated } from './ApiTokens.jsx'

let host, root
beforeEach(() => {
  mocks.state.sheets = []
  mocks.api = vi.fn(() => Promise.resolve({}))
  mocks.copy = vi.fn(() => Promise.resolve(true))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() => root.render(<Modals />))
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const button = label => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === label)
const type = (input, value) => {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
const escape = () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

describe('expiry', () => {
  const NOW = Date.UTC(2026, 9, 22, 12)
  const at = ms => new Date(NOW + ms).toISOString()
  const H = 3600000, DAY = 24 * H
  it('warns from seven days out, counting up, and calls a past date expired', () => {
    expect(expiryOf(null, NOW)).toEqual({ state: 'none', text: 'Never expires' })
    expect(expiryOf(at(2.9 * DAY), NOW)).toEqual({ state: 'soon', text: 'Expires in 3 days' })
    expect(expiryOf(at(7 * DAY), NOW).state).toBe('soon')
    expect(expiryOf(at(0.5 * DAY), NOW).text).toBe('Expires in 12 hours')
    expect(expiryOf(at(20 * 60000), NOW).text).toBe('Expires in under an hour')
    expect(expiryOf(at(8 * DAY), NOW).state).toBe('later')
    expect(expiryOf(at(-1), NOW)).toEqual({ state: 'expired', text: 'Expired token' })
  })
})

describe('create a token', () => {
  it('keeps Create disabled until the name has more than blanks, with the focus on the name', () => {
    act(() => { createTokenSheet(vi.fn()) })
    const name = document.querySelector('#tok-name')
    expect(document.activeElement).toBe(name)
    expect(button('Create').disabled).toBe(true)
    act(() => type(name, '   '))
    expect(button('Create').disabled).toBe(true)
    act(() => type(name, 'Pulso'))
    expect(button('Create').disabled).toBe(false)
  })

  it('closes on Esc, and with its own X and Cancel', () => {
    act(() => { createTokenSheet(vi.fn()) })
    expect(document.querySelector('.tok-form')).not.toBeNull()
    act(() => escape())
    expect(mocks.state.sheets).toHaveLength(0)
    expect(document.querySelector('.tok-form')).toBeNull()

    act(() => { createTokenSheet(vi.fn()) })
    act(() => document.querySelector('.tok-x').click())
    expect(mocks.state.sheets).toHaveLength(0)
    act(() => { createTokenSheet(vi.fn()) })
    act(() => button('Cancel').click())
    expect(mocks.state.sheets).toHaveLength(0)
  })
})

describe('the new token', () => {
  const token = { id: 't1', name: 'Pulso', scope: 'routines', created: new Date().toISOString(), expires: null, lastUsed: null }

  it('turns Copy into "Copied ✓" inside a polite live region', async () => {
    act(() => { showTokenCreated(token, 'ogw_secret') })
    const copy = button('Copy token')
    expect(copy.closest('[aria-live="polite"]')).not.toBeNull()
    await act(async () => { copy.click() })
    expect(mocks.copy).toHaveBeenCalledWith('ogw_secret')
    const done = button('Copied ✓')
    expect(done).toBeTruthy()
    expect(done.closest('[aria-live="polite"]')).not.toBeNull()
    expect(button('Copy token')).toBeUndefined()
  })

  it('does not claim a copy that failed', async () => {
    mocks.copy = vi.fn(() => Promise.resolve(false))
    act(() => { showTokenCreated(token, 'ogw_secret') })
    await act(async () => { button('Copy token').click() })
    expect(button('Copied ✓')).toBeUndefined()
    expect(document.querySelector('[aria-live="polite"] .tok-err')).not.toBeNull()
  })

  it('asks before Esc or "I\'ve saved it" closes it uncopied', async () => {
    act(() => { showTokenCreated(token, 'ogw_secret') })
    act(() => escape())
    expect(mocks.state.sheets).toHaveLength(1)
    expect(button('Close anyway')).toBeTruthy()
    act(() => button('Go back').click())
    await act(async () => { button('Copy token').click() })
    act(() => button("I've saved it").click())
    expect(mocks.state.sheets).toHaveLength(0)
  })
})
