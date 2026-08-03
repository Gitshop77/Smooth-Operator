/**
 * Multi-stage icon downscaler
 *
 * Renders the 128px Teal/Cyan SVG at high resolution, then downscales
 * in small steps (each capped at 2x) with Lanczos resampling and
 * Unsharp Mask at each stage to preserve edge contrast.
 *
 * Usage: node scripts/generate-icons.mjs
 */

import sharp from 'sharp';
import { mkdirSync, copyFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
// Tracked source icons: the build copies these into chrome-extension/icons/.
// Writing into the build dir would wipe them on the next build.
const ICONS_DIR = join(ROOT, 'src', 'extension', 'icons');
// The 128px Teal/Cyan Orbiting Steps SVG (master version)
const TEAL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <defs>
    <radialGradient id="bg" cx="50%" cy="50%" r="60%">
      <stop offset="0%" stop-color="#0f2035"/>
      <stop offset="100%" stop-color="#0a1628"/>
    </radialGradient>
    <linearGradient id="r1" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#00d4ff"/>
      <stop offset="100%" stop-color="#00b4d8"/>
    </linearGradient>
    <linearGradient id="r2" x1="0%" y1="100%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#00b4d8"/>
      <stop offset="100%" stop-color="#00d4ff"/>
    </linearGradient>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="nglow" x="-80%" y="-80%" width="260%" height="260%">
      <feGaussianBlur in="SourceGraphic" stdDeviation="2" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <rect width="128" height="128" rx="16" fill="url(#bg)"/>
  <ellipse cx="64" cy="64" rx="48" ry="22" fill="none" stroke="#00d4ff" stroke-width="0.6" opacity="0.15" transform="rotate(-25, 64, 64)"/>
  <ellipse cx="64" cy="64" rx="46" ry="20" fill="none" stroke="url(#r1)" stroke-width="1.8" transform="rotate(-25, 64, 64)"/>
  <ellipse cx="64" cy="64" rx="42" ry="18" fill="none" stroke="url(#r2)" stroke-width="1.5" transform="rotate(35, 64, 64)"/>
  <circle cx="64" cy="14" r="2" fill="#00d4ff" opacity="0.5"/>
  <circle cx="64" cy="114" r="2" fill="#00d4ff" opacity="0.5"/>
  <g filter="url(#glow)"><circle cx="64" cy="64" r="11" fill="#00d4ff"/></g>
  <circle cx="64" cy="64" r="7" fill="#ffffff"/>
  <g filter="url(#nglow)">
    <circle cx="110" cy="55.3" r="5" fill="#ffffff"/>
    <circle cx="18" cy="72.7" r="5" fill="#ffffff"/>
  </g>
  <g filter="url(#nglow)">
    <circle cx="75.1" cy="82.2" r="4" fill="#ffffff"/>
    <circle cx="52.9" cy="45.8" r="4" fill="#ffffff"/>
  </g>
</svg>`;

// Multi-stage downscale: each step reduces by ≤2x
// 128 → 48 → 32 → 16
const STAGES = [
  { target: 128, label: '128px' },
  { target: 48,  label: '48px' },
  { target: 32,  label: '32px' },
  { target: 16,  label: '16px' },
];

async function generateIcons() {
  mkdirSync(ICONS_DIR, { recursive: true });

  console.log('Rendering 128px SVG to high-res buffer...');
  // Render SVG at 512px (4x) for maximum quality source
  const hiRes = await sharp(Buffer.from(TEAL_SVG))
    .resize(512, 512, { kernel: sharp.kernel.lanczos3 })
    .png()
    .toBuffer();

  console.log('Hi-res buffer ready (512x512)');

  // Re-run for each target size to get clean outputs
  console.log('\nGenerating final PNGs...');

  for (const { target, label } of STAGES) {
    console.log(`  Generating ${label}...`);

    let img = sharp(hiRes);

    // Multi-stage downscale for this target
    if (target < 512) {
      // Determine the chain of sizes to go through
      const chain = [];
      let current = 512;
      while (current > target) {
        const next = Math.max(target, Math.floor(current / 2));
        chain.push(next);
        current = next;
      }

      for (let i = 0; i < chain.length; i++) {
        const sz = chain[i];
        const isLast = i === chain.length - 1;
        const scaleFactor = 512 / target;

        // Sharpen more aggressively as we get smaller
        const sharpenAmount = Math.min(2.0, 0.5 + (scaleFactor - 1) * 0.3);
        const sharpenSigma = Math.min(1.2, 0.3 + (scaleFactor - 1) * 0.15);

        img = img.resize(sz, sz, {
          kernel: sharp.kernel.lanczos3,
          fit: 'contain',
          background: { r: 10, g: 22, b: 40, alpha: 1 },
        });

        if (isLast) {
          img = img.sharpen({ sigma: sharpenSigma, m1: sharpenAmount, m2: sharpenAmount * 0.4 });
        }
      }
    }

    const outputPath = join(ICONS_DIR, `icon-${target}.png`);
    await img.png().toFile(outputPath);
    console.log(`  ✓ ${outputPath}`);
  }

  // Also write icon.png (same as 128px)
  const icon128 = join(ICONS_DIR, 'icon-128.png');
  const iconMain = join(ICONS_DIR, 'icon.png');
  copyFileSync(icon128, iconMain);
  console.log(`  ✓ ${iconMain} (copy of 128px)`);

  console.log('\nDone! All icons generated.');
}

generateIcons().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
