/**
 * maestro-reviewer — client bundle entry.
 *
 * Registers `settings.section` id `maestro-review` (order 32): the GitLab and
 * Review keys this package owns.
 *
 * Every field here is a key review still saves. The tunnel, proxy, PIN and
 * telegram fields left with their owners in wave 2, and the Secrets tab that
 * used to render the Telegram token went with them: a plugin that cannot save
 * a value has no business rendering its field.
 */
import * as React from 'react'
import { ReviewSettings } from './review/ReviewSettings.js'
import { REVIEW_CSS } from './review/styles.js'
import { registerSettingsNavIcon, SETTINGS_NAV_MARKER } from './settings-nav-icon.js'

/** This package's own channel; the endpoints it serves. */
export const REVIEW_CHANNEL = '/maestro-reviewer'

export type RpcCall = (endpoint: string, payload?: unknown) => Promise<any>

/**
 * Unwrap the `RpcResult` envelope. A bare `{ ok: true }` is not a usable
 * answer: the value is what the form renders, so an endpoint that forgets it
 * produces an empty card that saves nothing and reports no error.
 */
function unwrap(res: any): any {
  return res && typeof res === 'object' && 'ok' in res ? (res.ok ? res.value : null) : res
}

export function makeRpcCall(ctx: any): RpcCall {
  return async (endpoint, payload) => {
    const conn = ctx.get?.('connection')
    if (conn?.rpc?.call === undefined) throw new Error('RPC not available')
    const res = await conn.rpc.call(REVIEW_CHANNEL, endpoint, payload ?? {})
    const value = unwrap(res)
    if (value === null) {
      throw new Error(String(res?.error?.message ?? res?.error ?? endpoint))
    }
    return value
  }
}

const REVIEW_NAV_CSS = `
[${SETTINGS_NAV_MARKER}] > svg:first-child,
[${SETTINGS_NAV_MARKER}] > svg.zWKi1a_navIcon {
  display: none !important;
}

[${SETTINGS_NAV_MARKER}]::before {
  content: '';
  flex: none;
  width: 16px;
  height: 16px;
  display: inline-block;
  background: currentColor;
  -webkit-mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M2 11 L5 4 L8 9 L11 4 L14 11'/%3E%3C/svg%3E") center / contain no-repeat;
  mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M2 11 L5 4 L8 9 L11 4 L14 11'/%3E%3C/svg%3E") center / contain no-repeat;
}
`

function installStyleTag(css: string, pluginCss: string): () => void {
  if (typeof document === 'undefined') return () => {}
  const tag = document.createElement('style')
  tag.dataset.plugin = '@ddtcorex/maestro-reviewer'
  tag.dataset.pluginCss = pluginCss
  tag.textContent = css
  document.head.appendChild(tag)
  return () => {
    document.querySelector(`style[data-plugin-css="${pluginCss}"]`)?.remove()
  }
}

export const inject = ['slots', 'connection'] as const

export function apply(ctx: any): void {
  const slots = ctx.get?.('slots')
  if (!slots?.inject || !slots?.register) return

  const rpcCall = makeRpcCall(ctx)

  ctx.effect(() => registerSettingsNavIcon(() => 'Maestro Review'), 'maestro-review: settings nav icon')
  ctx.effect(() => installStyleTag(REVIEW_NAV_CSS, 'maestro-review/settings-nav.css'), 'maestro-review: settings nav css')
  ctx.effect(() => installStyleTag(REVIEW_CSS, 'maestro-review/settings.css'), 'maestro-review: settings css')

  ctx.effect(() => {
    const dispose = slots.inject('settings.section', () =>
      slots.register(
        {
          name: 'settings.section',
          id: 'maestro-review',
          order: 32,
          label: () => 'Maestro Review',
          inject: () => ({ rpcCall }),
        },
        (props: { rpcCall: RpcCall }) => React.createElement(ReviewSettings, props),
      ),
    )
    return () => {
      try {
        ;(dispose as any)?.()
      } catch {
        // Teardown must never throw.
      }
    }
  }, 'maestro-review: settings')
}

export default { inject, apply }