import { Engagement, OnEvent } from "@cef-ai/agent-sdk";
import type { Context, VaultEvent } from "@cef-ai/agent-sdk";
import { transcribeFromUrl } from "./lib/transcribe";
import { SYSTEM_PROMPT } from "./prompts/system-prompt-v1";

const MIN_ANALYSIS_CHARS = 20;

interface AudioChunkPayload {
  conversationId: string;
  segmentIndex: number;
  audio_url: string;
}

interface AudioCompletePayload {
  conversationId: string;
  totalSegments: number;
}

async function analyzeWithGemini(
  transcript: string,
  ctx: Context,
): Promise<{ summary: string; topics: string[]; action_items: string[] } | null> {
  const apiKey = (ctx.settings as any)?.geminiApiKey;
  if (!apiKey) { ctx.log.error('[gemini] geminiApiKey not set in agent settings'); return null; }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const res = await ctx.fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `${SYSTEM_PROMPT}\n\nTranscript:\n---\n${transcript}\n---` }] }],
      generationConfig: { maxOutputTokens: 8192, temperature: 0.2, responseMimeType: 'application/json' },
    }),
  });
  const data = await res.json() as any;
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
  if (!text) { ctx.log.error('[gemini] no text returned', { error: data?.error?.message }); return null; }
  try {
    return JSON.parse(text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim());
  } catch (e: any) {
    ctx.log.error('[gemini] JSON parse failed', { error: e.message, preview: text.slice(0, 200) });
    return null;
  }
}

@Engagement({
  id: 'phrase-handler',
  goal: 'Transcribe audio via AssemblyAI per chunk, summarize via Gemini on completion',
})
export default class PhraseHandler {
  @OnEvent('conversation_start')
  async onConversationStart(event: VaultEvent, ctx: Context) {
    const raw = event.payload?.payload ?? event.payload;
    const p = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const { conversationId } = p;
    ctx.log.info('[cs] conversation_start', { conversationId });

    const db = ctx.cubby('voice_agent');
    const now = new Date().toISOString();
    await db.exec(
      `INSERT OR REPLACE INTO nodes (id, type, created_at, attribute) VALUES (?, 'conversation', ?, ?)`,
      [`conversation:${conversationId}`, now, JSON.stringify({ conversationId, status: 'recording' })],
    );
    return { ok: true, conversationId };
  }

  @OnEvent('audio_chunk')
  async onAudioChunk(event: VaultEvent, ctx: Context) {
    const raw = event.payload?.payload ?? event.payload;
    const p = (typeof raw === 'string' ? JSON.parse(raw) : raw) as AudioChunkPayload;
    const { conversationId, segmentIndex, audio_url } = p;

    if (!audio_url) { ctx.log.warn('[ac] no audio_url — skipping'); return { ok: true, skipped: true }; }

    const assemblyAiKey = (ctx.settings as any)?.assemblyAiKey;
    if (!assemblyAiKey) { ctx.log.error('[ac] assemblyAiKey not set in agent settings'); return { ok: true, skipped: true }; }

    ctx.log.info('[ac] transcribing chunk', { segmentIndex });
    let result;
    try {
      result = await transcribeFromUrl(audio_url, assemblyAiKey, ctx);
    } catch (e: any) {
      ctx.log.warn('[ac] transcription failed — skipping', { segmentIndex, error: e.message });
      return { ok: true, skipped: true };
    }

    if (!result.text.trim()) { ctx.log.info('[ac] silent chunk — skipping', { segmentIndex }); return { ok: true, skipped: true }; }

    const db = ctx.cubby('voice_agent');
    const now = new Date().toISOString();
    const offsetMs = segmentIndex * 5000;
    await db.exec(
      `INSERT OR IGNORE INTO transcript_chunks (id, conversation_id, segment_index, text, start_ms, end_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [`tc:${conversationId}:${segmentIndex}`, conversationId, segmentIndex, result.text, offsetMs, offsetMs + 5000, now],
    );
    ctx.log.info('[ac] chunk stored', { segmentIndex, chars: result.text.length });
    return { ok: true, segmentIndex };
  }

  @OnEvent('audio.complete')
  async onAudioComplete(event: VaultEvent, ctx: Context) {
    const raw = event.payload?.payload ?? event.payload;
    const p = (typeof raw === 'string' ? JSON.parse(raw) : raw) as AudioCompletePayload;
    const { conversationId, totalSegments } = p;
    if (!conversationId) { ctx.log.warn('[acp] no conversationId'); return { ok: true, skipped: true }; }

    const db = ctx.cubby('voice_agent');
    let rows: any[] = [];
    for (let i = 0; i < 30; i++) {
      rows = await db.query(
        `SELECT text FROM transcript_chunks WHERE conversation_id = ? ORDER BY start_ms ASC`,
        [conversationId],
      );
      if (rows.length >= totalSegments) break;
      await new Promise((r) => setTimeout(r, 2000));
    }

    if (!rows.length) {
      ctx.log.warn('[acp] no transcript chunks — skipping', { conversationId, totalSegments });
      return { ok: true, skipped: true };
    }

    const fullText = rows.map((r: any) => r.text).join(' ');
    ctx.log.info('[acp] transcript ready — calling Gemini', { conversationId, chars: fullText.length });

    if (fullText.length < MIN_ANALYSIS_CHARS) {
      await db.exec(`UPDATE nodes SET attribute = ? WHERE id = ?`, [
        JSON.stringify({ conversationId, status: 'complete', summary: 'Too short to analyze.', topics: [], action_items: [] }),
        `conversation:${conversationId}`,
      ]);
      return { ok: true, skipped: true };
    }

    const analysis = await analyzeWithGemini(fullText, ctx);
    if (!analysis) { ctx.log.warn('[acp] Gemini returned null'); return { ok: true, skipped: true }; }

    const now = new Date().toISOString();
    await db.exec(`UPDATE nodes SET attribute = ? WHERE id = ?`, [
      JSON.stringify({
        conversationId,
        status: 'complete',
        ai_analyzed: true,
        ai_analyzed_at: now,
        summary: analysis.summary ?? '',
        topics: analysis.topics ?? [],
        action_items: analysis.action_items ?? [],
      }),
      `conversation:${conversationId}`,
    ]);

    ctx.log.info('[acp] analysis written', { conversationId, topics: analysis.topics?.length ?? 0 });
    return { ok: true, conversationId };
  }
}
