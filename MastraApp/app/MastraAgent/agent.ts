import { z } from "zod";
import { Agent } from "@mastra/core/agent";
import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";

const bedrock = createAmazonBedrock({
  credentialProvider: fromNodeProviderChain()
});

const agent = new Agent({
  id: "assistant",
  name: "Assistant",
  instructions: "あなたは親切なアシスタントです。",
  model: bedrock("jp.anthropic.claude-sonnet-4-6"),
});

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    requestSchema: z.object({ prompt: z.string() }),
    process: async ({ prompt }) => {
      const result = await agent.generate(prompt);
      return result.text;
    },
  },
});

app.run();