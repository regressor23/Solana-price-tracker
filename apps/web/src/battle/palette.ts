/**
 * The design tokens, read once into plain objects.
 *
 * `tokens.css` is the only source of colour — DESIGN_BRIEF §4.4 keeps a
 * dedicated `--3d-*` block for precisely this handover — so nothing here
 * invents a value. The fallbacks cover one case: a renderer constructed before
 * the stylesheet has applied would otherwise draw an invisible battle.
 *
 * Read once, not per frame. These are custom properties, and `getComputedStyle`
 * is a layout read.
 */

const token = (styles: CSSStyleDeclaration, name: string, fallback: string): string =>
  styles.getPropertyValue(name).trim() || fallback;

/** What the 2D renderer needs: flat fills, no light. */
export interface Palette {
  orc: string;
  nexus: string;
  orcDim: string;
  nexusDim: string;
  line: string;
  ink: string;
}

export function paletteFrom(element: Element): Palette {
  const styles = getComputedStyle(element);
  return {
    orc: token(styles, '--orc', '#c4472c'),
    nexus: token(styles, '--nexus', '#00d4ff'),
    orcDim: token(styles, '--orc-deep', '#8b1a1a'),
    nexusDim: token(styles, '--nexus-deep', '#0a2a3a'),
    line: token(styles, '--line-strong', '#2a3542'),
    ink: token(styles, '--bg', '#07090c'),
  };
}

/**
 * What the 3D renderer needs: the same two factions, plus the things only a lit
 * scene has — sky, light temperature, the colour of a hit.
 */
export interface ScenePalette {
  orc: string;
  orcEmissive: string;
  orcGround: string;
  nexus: string;
  nexusEmissive: string;
  nexusGround: string;
  frontLine: string;
  skyStorm: string;
  skyNebula: string;
  lightWarm: string;
  lightCool: string;
  impactFlash: string;
}

export function scenePaletteFrom(element: Element): ScenePalette {
  const styles = getComputedStyle(element);
  return {
    orc: token(styles, '--3d-orc-base', '#c4472c'),
    orcEmissive: token(styles, '--3d-orc-emissive', '#ff7a2f'),
    orcGround: token(styles, '--3d-orc-ground', '#2e1a12'),
    nexus: token(styles, '--3d-nexus-base', '#00d4ff'),
    nexusEmissive: token(styles, '--3d-nexus-emissive', '#7fffd4'),
    nexusGround: token(styles, '--3d-nexus-ground', '#0a2a3a'),
    frontLine: token(styles, '--3d-front-line', '#f2e3c0'),
    skyStorm: token(styles, '--3d-sky-storm', '#191218'),
    skyNebula: token(styles, '--3d-sky-nebula', '#0b1b2e'),
    lightWarm: token(styles, '--3d-light-warm', '#ffb26b'),
    lightCool: token(styles, '--3d-light-cool', '#8fe8ff'),
    impactFlash: token(styles, '--3d-impact-flash', '#fff3d0'),
  };
}
