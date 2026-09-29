// SPDX-License-Identifier: GPL-3.0-or-later
export function savedDraftText(response: unknown): string | undefined {
  // Display only bounded, unambiguous transcript text. Never reuse its invalid word times.
  if (
    !response ||
    typeof response !== 'object' ||
    !('candidates' in response) ||
    !Array.isArray(response.candidates) ||
    response.candidates.length !== 1
  )
    return;
  const parts: unknown = response.candidates[0]?.content?.parts;
  if (!Array.isArray(parts)) return;
  const transcripts = parts.filter(
    (part) =>
      part &&
      typeof part === 'object' &&
      part.thought !== true &&
      part.audioTranscription &&
      typeof part.audioTranscription === 'object',
  );
  if (
    transcripts.length !== 1 ||
    typeof transcripts[0].audioTranscription.text !== 'string'
  )
    return;
  const text = transcripts[0].audioTranscription.text as string;
  if (text.trim() && new TextEncoder().encode(text).length <= 16000)
    return text;
}
