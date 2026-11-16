import { LlmAdapter, LlmError, resolveImageAttachmentAccess, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { createProvider, InMemoryCredentialStore } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'

export const providerId = 'bambooroute'
export const providerName = 'BambooRoute'
const protocol = 'openai-completions'
const retry = resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, providerId)
const positiveInteger = value => Number.isSafeInteger(value) && value > 0

function modelCatalog(value, currency) {
  if (!Array.isArray(value)) throw new LlmError('BambooRoute returned an invalid model list.', 'INVALID_CONFIG')
  const models = new Map()
  for (const model of value) {
    const capabilities = model?.capabilities
    if (capabilities?.chat !== true) continue
    const contextWindow = [model.context_window_tokens, model.max_input_tokens].find(positiveInteger)
    if (model.currency !== currency || typeof model.id !== 'string' || !model.id || models.has(model.id)
      || typeof model.name !== 'string' || !positiveInteger(model.max_output_tokens)) {
      throw new LlmError('BambooRoute returned an invalid model list.', 'INVALID_CONFIG')
    }
    if (!contextWindow) continue
    models.set(model.id, {
      id: model.id,
      name: model.name,
      contextWindow,
      maxTokens: model.max_output_tokens,
      vision: capabilities.vision === true,
      tools: capabilities.tools === true,
    })
  }
  return models
}

function createAdapter(ctx, grant, models) {
  const baseURL = grant.gateway + '/v1'
  const modelDescriptors = [...models.values()].map(model => ({
    id: model.id,
    name: model.name,
    api: protocol,
    provider: providerId,
    baseUrl: baseURL,
    reasoning: false,
    input: model.vision ? ['text', 'image'] : ['text'],
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: true,
      supportsStrictMode: false,
      maxTokensField: 'max_tokens',
      requiresReasoningContentOnAssistantMessages: true,
    },
  }))
  const piProvider = createProvider({
    id: providerId,
    name: providerName,
    baseUrl: baseURL,
    models: modelDescriptors,
    api: openAICompletionsApi(),
    auth: { apiKey: {
      name: providerName,
      resolve: async ({ credential }) => ({ auth: { apiKey: credential?.key }, source: providerName }),
    } },
  })
  const profiles = new Map([[providerId, {
    provider: providerId,
    displayName: providerName,
    baseURL,
    api: protocol,
    streamIdleTimeoutMs: 300_000,
    maxRequestImageBytes: 20 * 1024 * 1024,
    maxRequestImages: 50,
    imageOffloadCountQuantum: 10,
    requestImagePixelBudget: 2048 * 2048,
    requestImageMaxBytes: 1024 * 1024,
    retryPolicy: retry,
    piProvider,
    modelErrors: new Map(),
    configuredMaxTokens: new Map(modelDescriptors.map(model => [model.id, model.maxTokens])),
  }]])
  return new PiAiAdapter({
    profiles: () => profiles,
    resolveApiKey: async () => grant.token,
    auth: {
      credentials: new InMemoryCredentialStore(),
      authContext: { env: async () => undefined, fileExists: async () => false },
    },
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) =>
      resolveImageAttachmentAccess(attachments, filename => ctx.get('fs')?.processPathFromHostPath(filename), ref),
  })
}

export class BambooAdapter extends LlmAdapter {
  constructor(ctx, account) {
    super()
    this.ctx = ctx
    this.account = account
  }

  providerInfo(provider) {
    return { id: provider, name: providerName }
  }

  providerRetryPolicy() {
    return retry
  }

  async catalog(refresh = false) {
    const grant = await this.account.grant()
    if (!grant || grant.expiresAt <= Date.now()) {
      this.snapshot = undefined
      return undefined
    }
    const cached = this.snapshot
    if (!refresh && cached?.token === grant.token && cached.validUntil > Date.now()) return cached
    if (this.loading?.token === grant.token) return this.loading.promise
    const loading = { token: grant.token, promise: this.load(grant) }
    this.loading = loading
    try {
      return await loading.promise
    } finally {
      if (this.loading === loading) this.loading = undefined
    }
  }

  async load(grant) {
    let rows
    try {
      rows = await this.account.listModels(grant)
    } catch (error) {
      if (this.snapshot?.token === grant.token) this.snapshot = undefined
      throw new LlmError(error.message, error.status === 401 ? 'MISSING_CREDENTIAL' : 'TRANSPORT')
    }
    const models = modelCatalog(rows, grant.currency)
    const fingerprint = JSON.stringify([...models.values()])
    if ((await this.account.grant())?.token !== grant.token || grant.expiresAt <= Date.now()) return undefined
    const previous = this.snapshot
    const adapter = previous?.token === grant.token && previous.fingerprint === fingerprint
      ? previous.adapter : createAdapter(this.ctx, grant, models)
    const snapshot = { token: grant.token, models, fingerprint, adapter, validUntil: Date.now() + 60_000 }
    this.snapshot = snapshot
    return snapshot
  }

  async synchronize() {
    const previous = this.snapshot
    try {
      const current = await this.catalog(true)
      if (current?.fingerprint !== previous?.fingerprint || current?.token !== previous?.token) {
        this.ctx.emit('llm/models-updated', providerId)
      }
      return current?.models.size ?? 0
    } catch (error) {
      if (previous && !this.snapshot) this.ctx.emit('llm/models-updated', providerId)
      throw error
    }
  }

  async listModels(provider) {
    const snapshot = await this.catalog()
    if (!snapshot) return []
    return [...snapshot.models.values()].map(model => ({
      provider,
      id: model.id,
      name: model.name,
      inputModalities: model.vision ? ['text', 'image'] : ['text'],
      ...(!model.tools && { badge: { label: 'Chat only', tone: 'neutral' } }),
    }))
  }

  async selection(model, signal) {
    signal?.throwIfAborted()
    const snapshot = await this.catalog()
    signal?.throwIfAborted()
    if (!snapshot) throw new LlmError('Connect BambooRoute in the Plugins page.', 'MISSING_CREDENTIAL')
    const metadata = snapshot.models.get(model)
    if (!metadata) throw new LlmError('The selected BambooRoute model is unavailable. Choose another model.', 'UNKNOWN_MODEL')
    return { snapshot, metadata }
  }

  async resolveModel(provider, model, signal) {
    const { snapshot } = await this.selection(model, signal)
    return snapshot.adapter.resolveModel(provider, model, signal)
  }

  imageRequestTarget(provider, model, image) {
    return this.snapshot?.adapter.imageRequestTarget(provider, model, image)
      ?? super.imageRequestTarget(provider, model, image)
  }

  async prepareCall(provider, model, signal) {
    const { snapshot, metadata } = await this.selection(model, signal)
    const call = await snapshot.adapter.prepareCall(provider, model, signal)
    return { model: call.model, stream: options => this.runCall(snapshot, metadata, call, options) }
  }

  async *runCall(snapshot, metadata, call, options) {
    const current = await this.account.grant()
    if (current?.token !== snapshot.token || current.expiresAt <= Date.now() || this.account.attempt || this.account.disconnecting) {
      throw new LlmError('The BambooRoute connection changed. Check the connection and try again.', 'MISSING_CREDENTIAL')
    }
    this.account.activeCalls = (this.account.activeCalls ?? 0) + 1
    try {
      if (metadata.tools) {
        yield* call.stream(options)
        return
      }
      if (options.tools?.some(tool => tool.name === 'exit_plan_mode') ||
        options.messages.some(message => message.role === 'tool' || message.content.some(block => block.type === 'tool-call'))) {
        throw new LlmError('This model is for chat. Choose a model with tool calling for this session.', 'UNSUPPORTED_CONTENT')
      }
      const { tools, toolHistory, system, ...chat } = options
      const instruction = 'Answer conversationally. Workspace tools are unavailable for this model.'
      for await (const chunk of call.stream({ ...chat, system: system ? system + '\n\n' + instruction : instruction })) {
        if (chunk.type === 'tool-call-delta' || chunk.type === 'block-start' && chunk.blockType === 'tool-call'
          || chunk.type === 'block-end' && chunk.block.type === 'tool-call' || chunk.type === 'finish' && chunk.reason.kind === 'tool-calls') {
          throw new LlmError('The chat model returned an unsupported tool call.', 'UNSUPPORTED_CONTENT')
        }
        yield chunk
      }
    } finally {
      this.account.activeCalls--
    }
  }

  async *stream(options) {
    const call = await this.prepareCall(options.provider, options.model, options.signal)
    yield* call.stream(options)
  }
}
