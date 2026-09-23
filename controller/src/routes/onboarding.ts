// The default station idents, rendered on request from the Doctor panel. What
// is left of the first-run wizard's routes: the wizard itself is gone — this is
// a one-operator station, set up from Settings.

import express from 'express';

import { requireAdmin } from '../middleware/auth.js';
import * as jingles from '../broadcast/jingles.js';
import { queue } from '../broadcast/queue.js';

export const router = express.Router();

// Mirrors scripts/generate-jingles.sh so both paths render the same idents.
const DEFAULT_JINGLES = [
  "You're listening to Subwave. Personal frequency from the homelab.",
  'Subwave radio. The signal continues.',
  'This is Subwave. Late night sounds for the connected few.',
  "You're tuned to Subwave. Single stream, one frequency.",
  'Subwave — broadcasting on whatever wavelength reaches you.',
];

// Synchronous: returns once every default jingle is rendered, or on the first
// failure.
router.post('/onboarding/generate-jingles', requireAdmin, async (req, res) => {
  try {
    const existing = await jingles.list();
    const existingTexts = new Set(existing.map((j: any) => j.text));
    const created: any[] = [];
    for (const text of DEFAULT_JINGLES) {
      if (existingTexts.has(text)) continue;
      const j = await jingles.create(text);
      queue.log('scheduler', `jingle rendered: "${text.slice(0, 60)}…"`);
      created.push(j);
    }
    res.json({ ok: true, created: created.length, total: (await jingles.list()).length });
  } catch (err: any) {
    res.status(500).json({ ok: false, error: err.message || 'jingle render failed' });
  }
});
