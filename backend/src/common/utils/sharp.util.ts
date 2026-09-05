import * as sharpModule from 'sharp';
import type sharpFactory from 'sharp';

// Bun loads Sharp as an ES module while the production Webpack bundle keeps
// the CommonJS package external. Normalize that boundary in one place.
export const sharp = (
  (sharpModule as unknown as { default?: typeof sharpFactory }).default ?? sharpModule
) as typeof sharpFactory;
