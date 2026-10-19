import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadUserConfig } from '../src/host/config-store.ts'

/**
 * `maestro.getConfig` is review's OWN Settings endpoint, on review's own channel
 * (`/maestro-reviewer`), but `loadUserConfig()` returned the whole flat store
 * view — every `DOMAIN_KEY_MAP` key, not just review's. So the GitLab settings
 * card was answered with remote's tunnel identity: `tunnelHostname`, `tunnelId`,
 * `tunnelCredentialsFile`, `lanPort`, `lanPinEnabled`, `proxyPort`,
 * `pinSessionTtlHours`.
 *
 * Nothing in review reads those keys (`grep userConfig\.(tunnel|lan|proxy|quick|pin)`
 * is empty), and `SAVABLE_KEYS` already rejects them on a WRITE — so the leak
 * was one-directional: review could never set them, but it happily returned
 * them, including the local path of the machine's Cloudflare credentials file.
 */
let home: string
beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'rscope-')) })
afterEach(async () => { await rm(home, { recursive: true, force: true }) })

/** Write the store the way another plugin would, bypassing review entirely. */
async function seedSharedStore(): Promise<void> {
  await mkdir(join(home, 'dsh-maestro-config'), { recursive: true })
  await writeFile(
    join(home, 'dsh-maestro-config', 'settings.json'),
    JSON.stringify({
      version: 1,
      domains: {
        gitlab: {
          baseUrl: 'https://git.example.com',
          botUsername: 'maestro',
          webhookPort: 3000,
        },
        review: { model: { provider: 'openai', model: 'gpt-x' } },
        tunnel: {
          hostname: 'tunnel.example.invalid',
          id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
          // A path-shaped value on purpose: the leak that matters is the
          // credentials-file path, so the fixture must carry one.
          credentialsFile: '/srv/secrets/aaaaaaaa-credentials.json',
          mode: 'named',
          lanPort: 3080,
          lanHost: '0.0.0.0',
          lanPinEnabled: true,
          proxyPort: 3081,
          proxyHost: '127.0.0.1',
          pinSessionTtlHours: 720,
        },
        notifier: { telegram: { botToken: 'tg-secret', chatId: '42' } },
      },
    }, null, 2),
    'utf8',
  )
}

describe('loadUserConfig scope', () => {
  it('returns only the keys review owns', async () => {
    await seedSharedStore()
    const cfg = await loadUserConfig(home)

    expect(cfg.gitlabBaseUrl).toBe('https://git.example.com')
    expect(cfg.botUsername).toBe('maestro')
    expect(cfg.webhookPort).toBe(3000)
    expect(cfg.reviewModel).toEqual({ provider: 'openai', model: 'gpt-x' })
  })

  it('does not leak the tunnel domain through the GitLab settings channel', async () => {
    await seedSharedStore()
    const cfg = await loadUserConfig(home) as Record<string, unknown>

    // The tell is not one key, it is the credential file path: review's RPC
    // hands this object straight to the client.
    for (const key of [
      'tunnelHostname', 'tunnelId', 'tunnelCredentialsFile', 'tunnelMode',
      'lanPort', 'lanHost', 'lanPinEnabled',
      'proxyPort', 'proxyHost', 'quickTarget', 'pinSessionTtlHours',
      'lastTunnelRunning',
    ]) {
      expect(cfg, key).not.toHaveProperty(key)
    }

    // And nothing anywhere in the payload may name the machine's cloudflared
    // credentials path or the tunnel UUID.
    const serialised = JSON.stringify(cfg)
    expect(serialised).not.toContain('/srv/secrets/')
    expect(serialised).not.toContain('aaaaaaaa-bbbb-cccc')
  })

  it('does not leak the notifier domain either', async () => {
    // Telegram ownership moved to dsh-maestro-notifier; OWNER_OF already names
    // it on a rejected save, but the read side handed the values over.
    await seedSharedStore()
    const cfg = await loadUserConfig(home) as Record<string, unknown>

    for (const key of [
      'telegramBotToken', 'telegramChatId', 'telegramReviewNotifications',
    ]) {
      expect(cfg, key).not.toHaveProperty(key)
    }
    expect(JSON.stringify(cfg)).not.toContain('tg-secret')
  })

  it('never returns a key outside the review-owned set', async () => {
    // The general rule, so a future store key cannot leak by default: the
    // scope is an allowlist, not a denylist of the keys that leaked today.
    await seedSharedStore()
    const cfg = await loadUserConfig(home) as Record<string, unknown>

    const REVIEW_OWNS = new Set([
      'gitlabBaseUrl', 'gitlabToken', 'botUsername', 'webhookSecret', 'webhookPort',
      'projectMappings', 'autoRereviewOnPush', 'autoReviewOnAssign',
      'reviewModel', 'agentTimeoutMs', 'reviewSessionRetentionDays',
      'lastTunnelRunning',
    ])
    for (const key of Object.keys(cfg)) {
      expect(REVIEW_OWNS.has(key), `leaked key: ${key}`).toBe(true)
    }
  })
})
