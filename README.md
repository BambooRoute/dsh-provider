# BambooRoute for DeepSeek Harness

Connect a BambooRoute account to DeepSeek Harness and use its models from the model picker.

## Install

Use DeepSeek Harness `0.2.2-rc.3`, Node.js 24.9 or later, and pnpm. From the repository root, run:

```sh
npm pack
dsh plugin --profile web add ./bambooroute-dsh-provider-0.1.0.tgz
dsh web
```

## Connect

In Harness, open **Plugins → BambooRoute**, choose USD or CNY, and select **Connect**. Open the authorization page in your browser, check the displayed code, and approve the connection.

Harness shows the models available for your selected wallet. Tool calling follows each model's published BambooRoute capabilities.
