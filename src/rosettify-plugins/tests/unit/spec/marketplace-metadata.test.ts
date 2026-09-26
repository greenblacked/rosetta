// Regression for D11: hand-maintained marketplace.json descriptions must not drift from the
// generated plugin content.
//   1. Each "-light" plugin entry's suffix must match profiles/lightweight.json's
//      pluginDescriptionSuffix EXACTLY (the generated plugin.json carries that same suffix).
//   2. The Copilot entries must not claim "Includes Rosetta MCP for knowledge base access" — no
//      .mcp.json ships in core-copilot/core-copilot-light or their preserved source.
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const PROFILES_DIR = path.join(REPO_ROOT, 'src', 'rosettify-plugins', 'profiles');

const MARKETPLACE_FILES = [
  path.join(REPO_ROOT, '.claude-plugin', 'marketplace.json'),
  path.join(REPO_ROOT, '.cursor-plugin', 'marketplace.json'),
  path.join(REPO_ROOT, '.github', 'plugin', 'marketplace.json'),
];

interface MarketplacePlugin {
  name: string;
  source: string;
  description: string;
}

function readMarketplace(file: string): MarketplacePlugin[] {
  return (JSON.parse(fs.readFileSync(file, 'utf-8')) as { plugins: MarketplacePlugin[] }).plugins;
}

describe('marketplace metadata does not drift from generated plugin content (D11)', () => {
  const lightweightSuffix = (
    JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, 'lightweight.json'), 'utf-8')) as {
      pluginDescriptionSuffix: string;
    }
  ).pluginDescriptionSuffix;

  for (const file of MARKETPLACE_FILES) {
    it(`${path.relative(REPO_ROOT, file)}: every "-light" entry description ends with the lightweight profile's suffix`, () => {
      const lightEntries = readMarketplace(file).filter((p) => p.name.endsWith('-light'));
      expect(lightEntries.length).toBeGreaterThan(0);
      for (const entry of lightEntries) {
        expect(entry.description.endsWith(lightweightSuffix), entry.description).toBe(true);
      }
    });
  }

  it('no Copilot marketplace entry claims "Includes Rosetta MCP" (no .mcp.json ships with core-copilot)', () => {
    const copilotEntries = readMarketplace(
      path.join(REPO_ROOT, '.github', 'plugin', 'marketplace.json'),
    );
    for (const entry of copilotEntries) {
      expect(entry.description).not.toContain('Includes Rosetta MCP');
    }
  });
});
