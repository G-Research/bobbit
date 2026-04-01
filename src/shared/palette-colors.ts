/** Primary color values for each palette, extracted from CSS --primary variables. */
export const PALETTE_PRIMARY_COLORS: Record<string, { light: string; dark: string }> = {
  forest: { light: "oklch(0.42 0.14 148)", dark: "oklch(0.72 0.12 140)" },
  ocean:  { light: "oklch(0.42 0.14 230)", dark: "oklch(0.72 0.12 230)" },
  dusk:   { light: "oklch(0.42 0.14 300)", dark: "oklch(0.72 0.12 300)" },
  ember:  { light: "oklch(0.42 0.14 65)",  dark: "oklch(0.72 0.12 65)"  },
  rose:   { light: "oklch(0.42 0.14 10)",  dark: "oklch(0.72 0.12 10)"  },
  slate:  { light: "oklch(0.38 0.04 260)", dark: "oklch(0.72 0.06 260)" },
  sand:   { light: "oklch(0.42 0.14 85)",  dark: "oklch(0.72 0.12 85)"  },
  teal:   { light: "oklch(0.42 0.14 195)", dark: "oklch(0.72 0.12 195)" },
  copper: { light: "oklch(0.42 0.14 50)",  dark: "oklch(0.72 0.12 50)"  },
  mono:   { light: "oklch(0.38 0 0)",      dark: "oklch(0.72 0 0)"      },
};

export const DEFAULT_PROJECT_COLOR_LIGHT = "oklch(0.45 0.03 260)";
export const DEFAULT_PROJECT_COLOR_DARK = "oklch(0.65 0.03 260)";

export const PALETTE_IDS = ["forest", "ocean", "dusk", "ember", "rose", "slate", "sand", "teal", "copper", "mono"] as const;
export type PaletteId = typeof PALETTE_IDS[number];
