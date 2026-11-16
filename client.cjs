window.__ModuleLoader__.load({
  id: '@bambooroute/dsh-provider',
  factory: require => {
    const { createElement: h, useEffect, useState } = require('react')

    function AccountPanel({ call, t }) {
      const [state, setState] = useState()
      const [selectedCurrency, setSelectedCurrency] = useState()
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const connecting = state?.connecting === true

      useEffect(() => {
        const controller = new AbortController()
        let timer
        const update = async () => {
          try {
            const next = await call('status', {}, controller.signal)
            if (!controller.signal.aborted) {
              setState(next)
              setError('')
              timer = setTimeout(update, next.connecting ? 1_000 : 60_000)
            }
          } catch {
            if (!controller.signal.aborted) setError(t('statusError'))
          }
        }
        void update()
        return () => {
          controller.abort()
          clearTimeout(timer)
        }
      }, [call, connecting, t])

      async function perform(method, args = {}) {
        setBusy(true)
        setError('')
        try {
          const next = await call(method, args)
          if (method === 'disconnect' && !next.currency) setSelectedCurrency(undefined)
          setState(next)
        } catch {
          setError(t('actionError'))
        } finally {
          setBusy(false)
        }
      }

      if (!state) {
        return h('section', null, error
          ? h('p', { role: 'alert' }, error, ' ', h('button', { type: 'button', onClick: () => void perform('status') }, t('retry')))
          : h('p', { role: 'status' }, t('loading')))
      }

      const connectedCurrency = state.connected ? state.currency : undefined
      const currency = selectedCurrency ?? connectedCurrency ?? 'CNY'

      return h('section', { style: { display: 'grid', gap: '0.75rem', maxWidth: '36rem' } },
        h('p', { role: 'status', style: { margin: 0 } },
          connecting ? t('waiting') + ' · ' + state.pendingCurrency
            : state.connected ? t('connected') + ' · ' + state.currency
              : state.expiresAt <= Date.now() ? t('expired') : t('disconnected'),
          state.modelCount === undefined || connecting ? null : ' · ' + state.modelCount + ' ' + t(state.modelCount === 1 ? 'model' : 'models')),
        state.error || error ? h('p', { role: 'alert', style: { margin: 0 } }, error || state.error) : null,
        connecting ? h('div', { style: { display: 'flex', gap: '1rem', alignItems: 'center' } },
          state.code ? h('code', null, state.code) : null,
          state.url ? h('a', { href: state.url, target: '_blank', rel: 'noopener noreferrer' }, t('open')) : null,
          h('button', { type: 'button', disabled: busy, onClick: () => void perform('cancel') }, t('cancel')),
        ) : h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '0.75rem', alignItems: 'center' } },
          h('label', null, t('currency'), ' ',
            h('select', { value: currency, disabled: busy, onChange: event => setSelectedCurrency(event.target.value) },
              h('option', { value: 'CNY' }, 'CNY'),
              h('option', { value: 'USD' }, 'USD'))),
          h('button', { type: 'button', disabled: busy, onClick: () => void perform('start', { currency }) },
            state.connected ? t('reconnect') : t('connect')),
          state.connected ? h('button', { type: 'button', disabled: busy, onClick: () => void perform('refresh') }, t('refresh')) : null,
          state.expiresAt ? h('button', { type: 'button', disabled: busy, onClick: () => void perform('disconnect') }, t('disconnect')) : null,
        ),
      )
    }

    const en = {
      loading: 'Loading BambooRoute connection…',
      statusError: 'Could not check the BambooRoute connection.',
      actionError: 'The operation could not be confirmed. Check the connection before trying again.',
      retry: 'Check connection',
      waiting: 'Waiting for browser authorization…',
      connected: 'Connected',
      disconnected: 'Connect your BambooRoute account.',
      expired: 'Your connection has expired. Connect again.',
      models: 'available models',
      model: 'available model',
      open: 'Open BambooRoute authorization',
      cancel: 'Cancel',
      currency: 'Billing currency',
      connect: 'Connect',
      reconnect: 'Reconnect',
      refresh: 'Refresh models',
      disconnect: 'Disconnect',
    }
    const zh = {
      loading: '正在读取 BambooRoute 连接…',
      statusError: '无法检查 BambooRoute 连接。',
      actionError: '暂时无法确认操作结果。请先查看连接状态，再决定是否重试。',
      retry: '检查连接',
      waiting: '等待在浏览器中授权…',
      connected: '已连接',
      disconnected: '连接你的 BambooRoute 账号。',
      expired: '连接已过期，请重新连接。',
      models: '个可用模型',
      model: '个可用模型',
      open: '打开 BambooRoute 授权页',
      cancel: '取消',
      currency: '扣费币种',
      connect: '连接',
      reconnect: '重新连接',
      refresh: '刷新模型',
      disconnect: '断开连接',
    }

    return {
      inject: ['slots', 'connection', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register('bambooroute', { en, zh }))
        const t = ctx.locale.bind('bambooroute')
        const call = async (method, args, signal) => {
          const result = await ctx.connection.rpc.call('/api', 'bambooRoute/' + method, { args }, signal)
          if (!result.ok) throw new Error('BambooRoute Host operation failed.')
          return result.value
        }
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: '@bambooroute/dsh-provider',
          locale: 'bambooroute',
          inject: () => ({ call, t }),
        }, AccountPanel))
      },
    }
  },
})
