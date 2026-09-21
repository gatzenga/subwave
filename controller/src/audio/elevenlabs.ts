// ElevenLabs API key for the SFX / bed GENERATORS (sfx-gen.ts, bed-gen.ts).
// The ElevenLabs TTS engine is gone; only the sound-generation and music
// endpoints remain, and they read the key from the environment alone — there
// is no cloud-TTS settings block to inherit it from any more.
export function elevenLabsKey(): string {
  return process.env.ELEVENLABS_API_KEY || '';
}

export function isConfigured(): boolean {
  return !!elevenLabsKey();
}
