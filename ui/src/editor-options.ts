// Single source for Monaco appearance across every editor surface (practice
// room + dispute diff) so the two never drift again (NEE-283).
export const EDITOR_THEME = 'catppuccin-macchiato';

// JetBrains Mono is bundled via @fontsource imports in main.tsx; the chain
// behind it means a font-load failure degrades to system monospace.
export const EDITOR_APPEARANCE = {
  fontSize: 16,
  fontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace",
  fontLigatures: true,
};
