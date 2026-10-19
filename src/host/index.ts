import type { Context } from '@deepseek-ai/cordis'
import { makeSkillProvider, resolveSkillsDir } from './skill-provider.js'

export const name = '@ddtcorex/maestro-reviewer'

export function apply(ctx: Context): void {
  // The bundled DSH tool map is served from here, not from the public
  // `maestro-skills` plugin: that repo's catalog test requires its skill content
  // to stay tool-neutral, and this map names harness tools. Wrapped like the
  // rest of apply(): a missing service or a throwing registration must never
  // take down the whole plugin tree.
  try {
    const skills = (ctx as unknown as { get?: (key: string) => any }).get?.('skills')
    if (skills?.registerProvider) {
      ctx.effect(() => {
        let unregister: (() => void) | undefined
        try {
          // Package-root skills/ is resolved at runtime by walking to the
          // nearest package.json (robust to lib/ vs src/host/ layouts).
          unregister = skills.registerProvider(() => makeSkillProvider(resolveSkillsDir(__dirname)))
        } catch (e: any) {
          try { (ctx as any).logger?.warn?.(`[review] skill provider failed: ${e?.message ?? String(e)}`) } catch {}
        }
        return () => { try { unregister?.() } catch {} }
      }, 'maestro-review:skill')
    }
  } catch (e: any) {
    try { (ctx as any).logger?.warn?.(`[review] skill provider effect failed: ${e?.message ?? String(e)}`) } catch {}
  }

  // No RPC registration here on purpose. The channel belongs to settings-rpc.ts
  // (row `maestro-review-settings-rpc`), which implements the real endpoints. A
  // stub in this file used to claim the same channel; that stayed invisible only
  // because apply() was never mounted. Once the `maestro-review-host` row made
  // apply() run, both registrations collided and the Settings card died with:
  //   webserver: duplicate prefix route "/maestro-reviewer" (then named after the package)
}
