// Voice preview and the voice catalogue for the on-air engines.
// Part of the settings/ route split - see ../settings.ts.

import express from 'express';
import { readFile, unlink } from 'node:fs/promises';
import { extname } from 'node:path';
import * as tts from '../../audio/tts.js';
import { requireAdmin } from '../../middleware/auth.js';

// Mounted onto the parent settings router in ../settings.ts.
export const router = express.Router();

// Auditions an EXPLICIT engine + voice, not the on-air persona. `corrections`,
// `voiceSettings` and `fishSettings` are UNSAVED overrides for this call only
// (#696); synthesizeSample sanitizes and clamps them like settings.update() does.
// A synth failure returns 422 rather than falling back to Piper, so the operator
// sees why. The temp file is unlinked once sent.
router.post('/settings/tts/preview', requireAdmin, async (req, res) => {
  const body = req.body || {};
  const engine = typeof body.engine === 'string' ? body.engine : '';
  if (!engine || !tts.ENGINES.includes(engine)) {
    return res.status(400).json({ ok: false, message: `Unknown engine: ${engine || '(none)'}` });
  }
  // Carry a client disconnect into the provider call so a discarded preview does
  // not continue as invisible metered synthesis. `close` also fires after a
  // normal send, where writableEnded makes the abort a no-op.
  const previewAbort = new AbortController();
  const abortOnDisconnect = () => {
    if (!res.writableEnded) previewAbort.abort();
  };
  res.once('close', abortOnDisconnect);
  let filePath: string | null = null;
  try {
    filePath = await tts.synthesizeSample({
      engine,
      voice: typeof body.voice === 'string' ? body.voice : '',
      speed: typeof body.speed === 'number' ? body.speed : undefined,
      lang: typeof body.lang === 'string' ? body.lang : undefined,
      language: typeof body.language === 'string' ? body.language : undefined,
      text: typeof body.text === 'string' ? body.text : undefined,
      corrections: Array.isArray(body.corrections) ? body.corrections : undefined,
      signal: previewAbort.signal,
    });
    const buf = await readFile(filePath);
    res.type(extname(filePath) || '.wav').send(buf);
  } catch (err: unknown) {
    if (!previewAbort.signal.aborted && !res.destroyed) {
      res.status(422).json({ ok: false, message: (err as { message?: string })?.message || 'Preview synthesis failed' });
    }
  } finally {
    res.off('close', abortOnDisconnect);
    if (filePath) unlink(filePath).catch(() => {});
  }
});


