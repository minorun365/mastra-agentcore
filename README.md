# Mastra with AgentCore CLI

AgentCore CLIでMastraをデプロイする最小限のサンプルコードと手順です。

## 前提

- Node.js v24
- BedrockのAnthropicユースケース提出

## 手順

これをベースに、Mastra用のミニマム手順に修正したもの。
https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-cli-typescript.html

```sh
npm install -g @aws/agentcore

agentcore create --name MastraApp --no-agent
# その後、aws-targets.jsonを更新（ファイル参照）

cd MastraApp

agentcore add agent --name MastraAgent --type byo --build Container --language TypeScript --framework Strands --model-provider Bedrock --code-location app/MastraAgent

cd app/MastraAgent
npm init -y

touch agent.ts Dockerfile .gitignore .dockerignore
# その後、各ファイルの内容を記載（ファイル参照）

npm install zod @mastra/core @ai-sdk/amazon-bedrock @aws-sdk/credential-providers bedrock-agentcore
npm install --save-dev typescript @types/node

npx tsc --init --target ES2022 --outDir dist --module NodeNext --moduleResolution NodeNext
npm pkg set type=module scripts.build=tsc

cd ../../
aws login
agentcore deploy
agentcore invoke "元気？"
```