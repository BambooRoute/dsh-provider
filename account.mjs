import { setTimeout as delay } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import { credentialKey } from '@deepseek-ai/dsh-credentials'

export const currencies = ['CNY', 'USD']
const validToken = value => typeof value === 'string' && /^bbr-[A-Za-z0-9_-]{32,128}$/.test(value)
const validCode = value => typeof value === 'string' && /^[A-Z2-7]{4}-[A-Z2-7]{4}$/.test(value)

export function serviceOrigin(value) {
  const url = new URL(value)
  const local = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
  if ((!local && url.protocol !== 'https:') || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('BambooRoute service URLs must be HTTPS origins or local development origins.')
  }
  return url.origin
}

class BambooClientError extends Error {
  constructor(message, status = 0) {
    super(message)
    this.status = status
  }
}

async function request(origin, path, { method = 'GET', token, body, signal } = {}) {
  const timeout = AbortSignal.timeout(20_000)
  let response
  try {
    response = await fetch(new URL(path, origin), {
      method,
      headers: {
        accept: 'application/json',
        ...(token ? { authorization: 'Bearer ' + token } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
  } catch {
    signal?.throwIfAborted()
    throw new BambooClientError('BambooRoute could not be reached. Try again.')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    const messages = {
      401: 'Your BambooRoute connection has expired or was revoked. Connect again.',
      403: 'BambooRoute declined the request. Check your authorization and account.',
      410: 'This connection request expired. Start again.',
      429: 'BambooRoute received too many requests. Wait a moment and try again.',
    }
    throw new BambooClientError(messages[response.status] ?? 'BambooRoute could not complete the request. Try again.', response.status)
  }
  try {
    return await response.json()
  } catch {
    signal?.throwIfAborted()
    throw new BambooClientError('BambooRoute returned an unreadable response.')
  }
}

export class BambooAccount {
  constructor(ctx, config) {
    this.ctx = ctx
    this.site = serviceOrigin(config.site)
    this.gateway = serviceOrigin(config.gateway)
    const originId = createHash('sha256').update(this.site + '\n' + this.gateway).digest('hex').slice(0, 12)
    this.key = credentialKey('bambooroute', 'device-' + originId)
  }

  register() {
    this.ctx.effect(() => this.ctx.authorization.registerFlow({
      key: this.key,
      label: 'BambooRoute',
      methods: [{ id: 'browser', label: 'Connect in browser' }],
      run: session => this.authorize(session),
    }))
    this.ctx.effect(() => () => this.attempt?.controller.abort())
  }

  grantFrom(record) {
    const grant = record?.kind === 'grant' ? record.payload : undefined
    if (!grant || grant.site !== this.site || grant.gateway !== this.gateway || !validToken(grant.token)
      || !currencies.includes(grant.currency) || !Number.isFinite(grant.expiresAt)) return undefined
    return grant
  }

  async grant() {
    return this.grantFrom(await this.ctx.credentials.readRecord(this.key))
  }

  async status() {
    const grant = await this.grant()
    const attempt = this.attempt
    const credential = !grant ? {} : {
      currency: grant.currency,
      expiresAt: grant.expiresAt,
      connected: grant.expiresAt > Date.now(),
    }
    return {
      ...credential,
      ...(attempt && {
        connecting: true,
        pendingCurrency: attempt.currency,
        ...(attempt.url && { url: attempt.url, code: attempt.code }),
      }),
      ...(this.error && { error: this.error }),
    }
  }

  start(currency) {
    if (!currencies.includes(currency)) throw new Error('Choose USD or CNY.')
    if (this.attempt || this.disconnecting) return this.status()
    if (this.activeCalls > 0) {
      this.error = 'Finish or stop the current BambooRoute response before reconnecting.'
      return this.status()
    }
    const attempt = { currency, controller: new AbortController() }
    this.attempt = attempt
    this.error = undefined
    this.ctx.authorization.begin({
      key: this.key,
      method: 'browser',
      signal: attempt.controller.signal,
      interaction: {
        prompt: async () => currency,
        notify: ({ url, code }) => { Object.assign(attempt, { url, code }) },
      },
    }).catch(error => {
      if (!attempt.controller.signal.aborted) {
        this.error = error instanceof BambooClientError ? error.message : 'BambooRoute could not save the connection. Try again.'
      }
    }).finally(() => {
      if (this.attempt === attempt) this.attempt = undefined
    })
    return this.status()
  }

  cancel() {
    this.attempt?.controller.abort()
    return this.status()
  }

  async authorize(session) {
    const currency = await session.prompt({
      kind: 'select',
      message: 'Choose a billing currency.',
      options: currencies.map(id => ({ id, label: id })),
    })
    if (!currencies.includes(currency)) throw new BambooClientError('Choose USD or CNY.')
    session.signal.throwIfAborted()
    const started = await request(this.site, '/api/desktop/authorizations', {
      method: 'POST', body: { name: 'DeepSeek Harness — BambooRoute', currency }, signal: session.signal,
    })
    const deviceCode = started?.device_code
    const expiresIn = started?.expires_in
    const interval = started?.interval
    if (started?.currency !== currency || typeof deviceCode !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(deviceCode)
      || !validCode(started.user_code) || started.verification_uri !== this.site + '/desktop/authorize'
      || !Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 900
      || !Number.isInteger(interval) || interval < 1 || interval > expiresIn) {
      throw new BambooClientError('BambooRoute returned an invalid connection request.')
    }
    const body = { device_code: deviceCode }
    const expiresAt = Date.now() + expiresIn * 1000
    const url = new URL(started.verification_uri)
    url.searchParams.set('code', started.user_code)
    let exchanged = false
    try {
      session.notify({ message: 'Continue on BambooRoute to authorize this connection.', url: url.href, code: started.user_code })
      while (Date.now() < expiresAt) {
        await delay(Math.min(interval * 1000, Math.max(0, expiresAt - Date.now())), undefined, { signal: session.signal })
        if (Date.now() >= expiresAt) break
        const result = await request(this.site, '/api/desktop/token', { method: 'POST', body })
        if (result?.status === 'pending') continue
        exchanged = true
        await this.saveGrant(result, currency, session.signal)
        return
      }
      throw new BambooClientError('This connection request expired. Start again.')
    } finally {
      if (!exchanged) await request(this.site, '/api/desktop/cancel', { method: 'POST', body }).catch(() => {})
    }
  }

  async saveGrant(result, currency, signal) {
    const token = result?.token
    const expiresAt = Date.parse(result?.expires_at)
    let previous
    try {
      if (!validToken(token) || result.currency !== currency || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        throw new BambooClientError('BambooRoute returned an invalid connection.')
      }
      const grant = { token, currency, expiresAt, site: this.site, gateway: this.gateway }
      await this.ctx.credentials.modifyRecord(this.key, async current => {
        signal.throwIfAborted()
        previous = this.grantFrom(current)
        return { kind: 'grant', payload: grant }
      })
    } catch (error) {
      if (validToken(token)) await this.revoke(token).catch(() => {})
      throw error
    }
    if (previous && previous.token !== token) {
      await this.revoke(previous.token).catch(() => {
        this.error = 'The previous connection could not be revoked. Manage it on the BambooRoute API keys page.'
      })
    }
  }

  async revoke(token) {
    try {
      await request(this.site, '/api/desktop/session', { method: 'DELETE', token })
    } catch (error) {
      if (error.status !== 401) throw error
    }
  }

  async disconnect() {
    if (this.attempt || this.disconnecting) return this.status()
    if (this.activeCalls > 0) {
      this.error = 'Finish or stop the current BambooRoute response before disconnecting.'
      return this.status()
    }
    this.disconnecting = true
    this.error = undefined
    try {
      const grant = await this.grant()
      if (grant) {
        await this.revoke(grant.token)
        await this.ctx.credentials.modifyRecord(this.key, async current => {
          if (this.grantFrom(current)?.token === grant.token) return { kind: 'grant', payload: null }
        })
      }
    } catch {
      this.error = 'BambooRoute could not disconnect this device. Try again or revoke the key on BambooRoute.'
    } finally {
      this.disconnecting = false
    }
    return this.status()
  }

  async listModels(grant) {
    return request(this.site, '/api/desktop/models', { token: grant.token })
  }
}
