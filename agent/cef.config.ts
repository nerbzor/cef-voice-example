import { defineAgent } from "@cef-ai/agent-sdk/config";

export default defineAgent({
  id: "voice-agent",
  version: "1.0.2",
  engagements: [{ id: "phrase-handler", entry: "./src/phrase-handler.ts" }],
  cubbies: [{ alias: "voice_agent", migrations: "./migrations/voice_agent" }],
  card: {
    name: "CEF Voice Example",
    description: "Records audio, transcribes via AssemblyAI, summarizes via Gemini.",
  },
  requiredScopes: ["default"],
  idleTimeout: "30m",
  settings: [
    { key: "assemblyAiKey", type: "string", label: "AssemblyAI API Key", required: true },
    { key: "geminiApiKey",  type: "string", label: "Gemini API Key",     required: true },
  ],
  fetch: {
    allow: [
      "https://api.assemblyai.com",
      "https://generativelanguage.googleapis.com",
    ],
  },
});
