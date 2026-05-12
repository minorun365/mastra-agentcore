# Mastra on AgentCore — ハマりどころメモ

AgentCore CLI（`@aws/agentcore`）で TypeScript の Mastra エージェントをコンテナデプロイしたときに踏んだ落とし穴と対処。
基本は AWS 公式チュートリアル（[runtime-get-started-cli-typescript](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-cli-typescript.html)）に沿っているが、Mastra で使うとそのままでは動かない箇所がいくつかある。

---

## 1. TypeScript チュートリアルは Strands 前提

`agentcore add agent ... --language TypeScript` 自体は `agentcore.json` への登録と空のコードディレクトリ作成だけ（`package.json` / `tsconfig.json` / `Dockerfile` / `agent.ts` / `.dockerignore` はテンプレート生成されず、AWS ドキュメント通りに自分で作る）。そしてその AWS ドキュメントが Strands 前提なので、作る `package.json` と `agent.ts` も Strands 仕様になっている。

Mastra で書く場合は依存を差し替える：

```sh
npm uninstall @strands-agents/sdk @opentelemetry/auto-instrumentations-node
npm install zod @mastra/core @ai-sdk/amazon-bedrock @aws-sdk/credential-providers bedrock-agentcore
```

`package.json` を手編集したら必ず `npm install` で `package-lock.json` を追従させること。Dockerfile が `npm ci`（lock とズレてると即エラー）を使うため。

---

## 2. 公式ドキュメントの Dockerfile が `useradd` でビルド失敗する

ドキュメントの Dockerfile はこうなっている：

```dockerfile
FROM node:20-slim
...
RUN useradd -m -u 1000 bedrock_agentcore   # ← ここで落ちる
```

`node:20-slim` には最初から UID 1000 の `node` ユーザーが入っているため、`useradd: UID 1000 is not unique` で `exit code 1`（= 「Container build failed」）。Python チュートリアルの Dockerfile をそのまま流用したことによるドキュメント側のバグ。

**対処**：`-u 1000` を外す（OS が空き UID を自動割当）。

```dockerfile
RUN useradd -m bedrock_agentcore
```

---

## 3. `bedrock-agentcore@0.2.3` はエラー時に不透明な 500 を返す

ハンドラやバリデーションでエラーが起きると、SDK が `reply.send({error: ...})` でエラー JSON を返そうとするが、SDK が内蔵する `@fastify/sse` プラグインのせいで `Attempted to send payload of invalid type 'object'` で死ぬ。結果、UI には「Error: 500」としか出ず原因がわからない。

**対処**：UI のエラー表示は当てにせず、ログを直接見る（ローカルは `docker logs`、デプロイ後は `agentcore logs`。下の「デバッグの基本動作」参照）。

ハンドラの戻り値はオブジェクトより**文字列**を返す方が安全（`reply.send(string)` はこのバグ経路を踏まない）。

---

## 4. リクエストのキーは `prompt`

AgentCore Inspector のチャットUIも `agentcore invoke "..."` も、ペイロードを **`{"prompt": "..."}`** で送る。`requestSchema` を `message` 等で定義すると zod バリデーションが失敗し、3 のバグも相まって不透明な 500 になる。

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

`agentcore dev` はローカルの AWS **クレデンシャル**はコンテナに渡すが、**`AWS_REGION` は渡さない**（`~/.aws/config` のプロファイルもコンテナには入らない）。そのため `@ai-sdk/amazon-bedrock` がリージョンを解決できず、こうなる：

```
AI_LoadSettingError: AWS region setting is missing. Pass it using the 'region' parameter or the AWS_REGION environment variable.
```

**対処**：Dockerfile の実行ステージに `ENV` でリージョンを焼き込む（`agent.ts` のコード変更は不要。SDK が `AWS_REGION` を自動で拾う）。

```dockerfile
FROM node:20-slim
WORKDIR /app
ENV AWS_REGION=ap-northeast-1
...
```

モデルIDのプレフィックス（`jp.` = 日本 / `us.` = 米国）と `AWS_REGION` は揃えること。`jp.anthropic.claude-sonnet-4-6` を使うなら `AWS_REGION=ap-northeast-1`、`us.` 系なら `us-east-1` 等。ズレると `ValidationException: inference profile not found` 系で落ちる。

---

## 6. `@ai-sdk/amazon-bedrock` のクレデンシャルは `credentialProvider` を明示する

`@ai-sdk/amazon-bedrock` はデフォルトだと `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` 環境変数からしかクレデンシャルを読まない（AWS SDK の通常の解決チェーン＝設定ファイル・SSO・IAMロール等を使わない）。一方：

- `agentcore dev` はクレデンシャルを `~/.aws` のマウント＋`AWS_CONFIG_FILE` で渡す（環境変数では渡さない）
- 本番の AgentCore Runtime は実行ロールをコンテナロール方式で渡す（環境変数では渡さない）

どちらも `AWS_ACCESS_KEY_ID` 環境変数が無いので、デフォルトのままだと両方で `AWS SigV4 authentication requires AWS credentials` / `AWS access key ID setting is missing` になる。

**対処**：AWS SDK の解決チェーンを `credentialProvider` に渡す（`@aws-sdk/credential-providers` が必要）。「環境変数 → 設定ファイル → SSO → コンテナ/EC2ロール」の順で解決され、ローカルでも本番でも動く。

```ts
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";

const bedrock = createAmazonBedrock({ credentialProvider: fromNodeProviderChain() });
```

（`agentcore dev` のローカル実行だけなら、別解として `eval "$(aws configure export-credentials --format env)"` で環境変数に展開してから `agentcore dev` を起動する手もある。ただし本番デプロイには上記の `credentialProvider` が必須。）

---

## 7. その他

- `.gitignore`：`agentcore add agent` が作るコードディレクトリには `.gitignore` が無いので、`node_modules/` と `dist/` を自分で追加する。
- AWS 認証：`agentcore dev` はローカルの AWS クレデンシャルをコンテナに渡すだけ。SSO セッションが切れていると Bedrock 呼び出しが失敗する。先に `aws login`。

---

## デバッグの基本動作

`agentcore dev` / Inspector / `agentcore invoke` のエラー表示は薄い。詰まったら一段下のレイヤーの生ログを見る：

| 症状 | 見るもの |
|------|---------|
| 「Container build failed」 | コードディレクトリで `docker build .` を直接実行 |
| 「Error: 500」（ローカル実行時） | `docker logs <devコンテナ名>`（`{"level":50,...,"err":{...}}` の行に真因。level:50 = error） |
| 「Received error (500) from runtime」（デプロイ後） | `agentcore logs --runtime <名前> --since 30m` |
| TypeScript が怪しい | `npm run build`（= `tsc`）をローカルで実行 |
