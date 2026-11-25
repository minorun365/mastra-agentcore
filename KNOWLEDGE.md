# Mastra on AgentCore — ハマりどころメモ

AgentCore CLI（`@aws/agentcore`）で TypeScript の Mastra エージェントをコンテナデプロイしたときにつまずいた点と、その対処をまとめた。
基本は AWS 公式チュートリアル（[runtime-get-started-cli-typescript](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-cli-typescript.html)）に沿っているが、Mastra で使うとそのままでは動かない箇所がいくつかある。

---

## 1. TypeScript チュートリアルは Strands 前提

`agentcore add agent ... --language TypeScript` が行うのは `agentcore.json` への登録と空のコードディレクトリの作成だけで、`package.json` / `tsconfig.json` / `Dockerfile` / `agent.ts` / `.dockerignore` のテンプレートは生成されない。これらは AWS ドキュメント通りに自分で用意することになるが、ドキュメントが Strands 前提なので、作る `package.json` と `agent.ts` も Strands 仕様になっている。

Mastra で書く場合は、次のように依存パッケージを差し替える。

```sh
npm uninstall @strands-agents/sdk @opentelemetry/auto-instrumentations-node
npm install zod @mastra/core @ai-sdk/amazon-bedrock @aws-sdk/credential-providers bedrock-agentcore
```

`package.json` を手で編集したら、必ず `npm install` を実行して `package-lock.json` を更新しておく。Dockerfile 内で `npm ci` を使っており、lock ファイルとズレていると即座にエラーになるためだ。

---

## 2. 公式ドキュメントの Dockerfile が `useradd` でビルド失敗する

ドキュメントに載っている Dockerfile には次の記述がある。

```dockerfile
FROM node:20-slim
...
RUN useradd -m -u 1000 bedrock_agentcore   # ← ここで落ちる
```

`node:20-slim` には最初から UID 1000 の `node` ユーザーが入っているため、`useradd: UID 1000 is not unique` が出て `exit code 1` で終了し、「Container build failed」になる。Python チュートリアルの Dockerfile をそのまま流用したことによるドキュメント側のバグである。

回避するには `-u 1000` を外す。これで OS が空いている UID を自動で割り当てる。

```dockerfile
RUN useradd -m bedrock_agentcore
```

---

## 3. `bedrock-agentcore@0.2.3` はエラー時に不透明な 500 を返す

ハンドラやバリデーションでエラーが起きると、SDK は `reply.send({error: ...})` でエラー JSON を返そうとする。しかし内蔵の `@fastify/sse` プラグインのせいで `Attempted to send payload of invalid type 'object'` が出て失敗する。そのため UI には「Error: 500」としか表示されず、原因がわからない。

UI のエラー表示は当てにせず、ログを直接確認する。ローカルでは `docker logs`、デプロイ後は `agentcore logs` を使う。詳しくは下の「デバッグの基本動作」にある。

ハンドラの戻り値は、オブジェクトではなく文字列を返す方が安全だ。`reply.send(string)` であればこのバグに当たらない。

---

## 4. リクエストのキーは `prompt`

AgentCore Inspector のチャットUIも `agentcore invoke "..."` も、ペイロードを `{"prompt": "..."}` で送る。`requestSchema` を `message` などで定義すると zod バリデーションが失敗し、3 のバグも重なって不透明な 500 になる。

```ts
const app = new BedrockAgentCoreApp({
  invocationHandler: {
    requestSchema: z.object({ prompt: z.string() }),   // ← prompt で受ける
    process: async ({ prompt }) => {
      const result = await agent.generate(prompt);
      return result.text;                               // ← 文字列で返す
    },
  },
});
app.run();
```

---

## 5. AWS リージョンは Dockerfile の `ENV` で渡す

`agentcore dev` はローカルの AWS クレデンシャルはコンテナに渡すが、**`AWS_REGION` は渡さない**。`~/.aws/config` のプロファイルもコンテナには入らないため、`@ai-sdk/amazon-bedrock` がリージョンを解決できず次のエラーになる。

```
AI_LoadSettingError: AWS region setting is missing. Pass it using the 'region' parameter or the AWS_REGION environment variable.
```

Dockerfile の実行ステージに `ENV` でリージョンを設定して対処する。`agent.ts` はそのままでよく、SDK が `AWS_REGION` を自動で読み込む。

```dockerfile
FROM node:20-slim
WORKDIR /app
ENV AWS_REGION=ap-northeast-1
...
```

モデルIDのプレフィックス（`jp.` は日本、`us.` は米国）と `AWS_REGION` は揃える必要がある。`jp.anthropic.claude-sonnet-4-6` を使うなら `AWS_REGION=ap-northeast-1`、`us.` 系なら `us-east-1` などを指定する。ここがズレると `ValidationException: inference profile not found` 系のエラーで落ちる。

---

## 6. `@ai-sdk/amazon-bedrock` のクレデンシャルは `credentialProvider` を明示する

`@ai-sdk/amazon-bedrock` はデフォルトでは `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` 環境変数からしかクレデンシャルを読まず、設定ファイル・SSO・IAMロールといった AWS SDK 通常の解決チェーンを使わない。一方で、実行環境側の渡し方は次のようになっている。

- `agentcore dev` は `~/.aws` のマウントと `AWS_CONFIG_FILE` でクレデンシャルを渡しており、環境変数には入れない
- 本番の AgentCore Runtime は実行ロールをコンテナロール方式で渡すため、こちらも環境変数は使わない

どちらも `AWS_ACCESS_KEY_ID` 環境変数がないため、デフォルトのままだとローカル・本番の両方で `AWS SigV4 authentication requires AWS credentials` / `AWS access key ID setting is missing` のエラーになる。

`@aws-sdk/credential-providers` を入れたうえで、AWS SDK の解決チェーンを `credentialProvider` に渡せばよい。これで「環境変数 → 設定ファイル → SSO → コンテナ/EC2ロール」の順に解決され、ローカルでも本番でも動くようになる。

```ts
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";

const bedrock = createAmazonBedrock({ credentialProvider: fromNodeProviderChain() });
```

なお、`agentcore dev` のローカル実行に限れば、`eval "$(aws configure export-credentials --format env)"` で環境変数に展開してから `agentcore dev` を起動する方法もある。ただし本番デプロイでは上記の `credentialProvider` が必須になる。

---

## 7. その他

- `agentcore add agent` が作るコードディレクトリには `.gitignore` がないため、`node_modules/` と `dist/` を自分で追加しておく。
- AWS 認証については、`agentcore dev` がローカルの AWS クレデンシャルをそのままコンテナに渡すだけなので、SSO セッションが切れていると Bedrock の呼び出しに失敗する。事前に `aws login` を済ませておく。

---

## デバッグの基本動作

`agentcore dev` / Inspector / `agentcore invoke` は画面に出るエラー情報が少ない。詰まったら一段下のレイヤーの生ログを確認する。

| 症状 | 見るもの |
|------|---------|
| 「Container build failed」 | コードディレクトリで `docker build .` を直接実行 |
| ローカル実行時の「Error: 500」 | `docker logs <devコンテナ名>` を確認。`{"level":50,...,"err":{...}}` の行に原因があり、`level:50` が error を示す |
| デプロイ後の「Received error (500) from runtime」 | `agentcore logs --runtime <名前> --since 30m` |
| TypeScript が怪しい | `npm run build`（`tsc`）をローカルで実行 |
