import Schema from '@deepseek-ai/schemastery'
import { TypertRemoteService, createTypertRemoteInfo } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import { BambooAccount, currencies } from './account.mjs'
import { BambooAdapter, providerId } from './adapter.mjs'

export const name = 'bambooroute'
export const inject = ['llm', 'credentials', 'authorization', 'typert']
export const Config = Schema.object({
  site: Schema.string().default('https://bambooroute.com'),
  gateway: Schema.string().default('https://api.bambooroute.com'),
})

const packageName = '@bambooroute/dsh-provider'
const currencyCodec = { mode: 'strict', typeSymbol: packageName + '#BillingCurrency', create: () => z.enum(currencies) }
const stateCodec = { mode: 'strict', typeSymbol: packageName + '#ConnectionState', create: () => z.object({
  connected: z.boolean().optional(),
  currency: z.enum(currencies).optional(),
  expiresAt: z.number().optional(),
  connecting: z.boolean().optional(),
  pendingCurrency: z.enum(currencies).optional(),
  url: z.string().optional(),
  code: z.string().optional(),
  modelCount: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
}) }
const stateMethod = { service: 'bambooRoute', invocation: { kind: 'direct' }, parameters: [], result: stateCodec }
const startMethod = {
  ...stateMethod,
  parameters: [{ name: 'currency', source: 'json', codec: currencyCodec, strictCodec: currencyCodec }],
}
const remote = createTypertRemoteInfo({
  package: packageName,
  methods: {
    'bambooRoute/status': stateMethod,
    'bambooRoute/start': startMethod,
    'bambooRoute/cancel': stateMethod,
    'bambooRoute/disconnect': stateMethod,
    'bambooRoute/refresh': stateMethod,
  },
}, z)

class BambooSettings extends TypertRemoteService {
  constructor(ctx, { account, adapter }) {
    super(ctx, 'bambooRoute')
    this.account = account
    this.adapter = adapter
  }

  async status(refresh = false) {
    const status = await this.account.status()
    if (!status.connected || status.connecting) return status
    try {
      const modelCount = refresh ? await this.adapter.synchronize() : (await this.adapter.catalog())?.models.size ?? 0
      return { ...status, modelCount }
    } catch (error) {
      return { ...status, connected: error.code !== 'MISSING_CREDENTIAL', error: error.message }
    }
  }

  start(currency) {
    return this.account.start(currency)
  }

  cancel() {
    return this.account.cancel()
  }

  disconnect() {
    return this.account.disconnect()
  }

  refresh() {
    return this.status(true)
  }
}

export function apply(ctx, config) {
  const account = new BambooAccount(ctx, config)
  const adapter = new BambooAdapter(ctx, account)
  account.register()
  ctx.llm.registerAdapter([providerId], adapter)
  ctx.plugin(BambooSettings, { account, adapter })
  ctx.typert.register({ package: packageName, face: 'host', schemas: [], invocations: remote.descriptors })
  ctx.on('credentials/record-updated', key => {
    if (key === account.key) void adapter.synchronize().catch(() => {})
  })
  ctx.effect(() => {
    const timer = setInterval(() => { void adapter.synchronize().catch(() => {}) }, 60_000)
    timer.unref()
    return () => clearInterval(timer)
  })
}
