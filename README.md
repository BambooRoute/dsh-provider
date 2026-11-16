# BambooRoute for DeepSeek Harness

Connect a BambooRoute account to DeepSeek Harness and use its models from the model picker.

## Install / 安装

Use Node.js 24.9 or later and pnpm. These commands install the plugin from npm and start DeepSeek Harness Web `0.2.2-rc.3`.

需要 Node.js 24.9 或更新版本和 pnpm。以下命令从 npm 安装插件并启动 DeepSeek Harness Web `0.2.2-rc.3`。

```sh
npm exec --yes --package=@deepseek-ai/dsh@0.2.2-rc.3 -- dsh plugin --profile web add @bambooroute/dsh-provider@0.1.1
npm exec --yes --package=@deepseek-ai/dsh@0.2.2-rc.3 -- dsh web
```

## Connect the CNY wallet / 连接 CNY 钱包

### 中文

1. 在 Harness 中打开 **插件 → BambooRoute**。
2. 首次连接时，**扣费币种**默认选中 **CNY**，点击 **连接**。如果已有 USD 连接，把币种改为 **CNY**，再点击 **重新连接**。
3. 点击 **打开 BambooRoute 授权页**。如有提示，先登录 BambooRoute。核对网页和 Harness 显示的授权码，确认扣费币种为 **CNY**，然后批准授权。
4. 回到 Harness，状态显示 **已连接 · CNY** 后，在新会话的模型选择器中选择 BambooRoute 模型。模型请求从 CNY 钱包扣费。

Harness 会显示所选钱包可用的模型。能否调用工具取决于 BambooRoute 公布的模型能力。

### English

1. In Harness, open **Plugins → BambooRoute**.
2. **Billing currency** defaults to **CNY** on the first connection. Click **Connect**. If you're already connected to a USD wallet, select **CNY** and click **Reconnect**.
3. Click **Open BambooRoute authorization**. Sign in to BambooRoute if prompted. Check that the code on the page matches the code in Harness, confirm the billing currency is **CNY**, and approve the connection.
4. Return to Harness. Once it shows **Connected · CNY**, select a BambooRoute model from the model picker in a new session. Model requests are billed to your CNY wallet.

Harness shows the models available for your selected wallet. Tool calling follows each model's published BambooRoute capabilities.
