import type { Context } from "@cef-ai/agent-sdk";

export interface TranscriptResult {
  text: string;
}

export async function transcribeFromUrl(
  audioUrl: string,
  assemblyAiKey: string,
  ctx: Context,
): Promise<TranscriptResult> {
  ctx.log.info('[aai] submitting transcript job from URL');
  const txRes = await (ctx as any).fetch('https://api.assemblyai.com/v2/transcript', {
    method: 'POST',
    headers: { Authorization: assemblyAiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ audio_url: audioUrl, speech_models: ['universal-2'] }),
  });
  const txText = await txRes.text();
  let txBody: any;
  try { txBody = JSON.parse(txText); } catch { txBody = null; }
  if (!txRes.ok || !txBody?.id) {
    throw new Error(`AssemblyAI transcript submit failed: HTTP ${txRes.status} — ${txText.slice(0, 200)}`);
  }
  const id: string = txBody.id;
  ctx.log.info('[aai] transcript job created', { id });

  for (let i = 0; i < 40; i++) {
    const poll = await (ctx as any).fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
      headers: { Authorization: assemblyAiKey },
    });
    const r = await poll.json() as any;
    if (r.status === 'completed') {
      ctx.log.info('[aai] transcript completed', { id, polls: i + 1, words: r.words?.length ?? 0 });
      return { text: r.text ?? '' };
    }
    if (r.status === 'error') throw new Error(r.error ?? 'AssemblyAI error');
    ctx.log.info('[aai] polling', { id, poll: i + 1, status: r.status });
  }
  throw new Error('AssemblyAI timed out after 40 polls');
}
