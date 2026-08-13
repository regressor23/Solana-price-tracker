// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';

import { paletteFrom, scenePaletteFrom } from './palette.js';

/**
 * The handover from `tokens.css` to the renderers.
 *
 * Worth testing for one reason: both failure modes are silent. A token read
 * under the wrong name returns an empty string rather than an error, and a
 * fallback that is wrong is still a colour — so a palette that has quietly
 * stopped following the design system looks exactly like one that has not.
 */

function element(tokens: Record<string, string>): HTMLElement {
  const node = document.createElement('div');
  for (const [name, value] of Object.entries(tokens)) {
    node.style.setProperty(name, value);
  }
  document.body.append(node);
  return node;
}

describe('the 2D palette', () => {
  it('reads the tokens the stylesheet declares', () => {
    const palette = paletteFrom(
      element({
        '--orc': '#111111',
        '--nexus': '#222222',
        '--orc-deep': '#333333',
        '--nexus-deep': '#444444',
        '--line-strong': '#555555',
        '--bg': '#666666',
      }),
    );

    expect(palette).toEqual({
      orc: '#111111',
      nexus: '#222222',
      orcDim: '#333333',
      nexusDim: '#444444',
      line: '#555555',
      ink: '#666666',
    });
  });

  it('falls back rather than drawing an invisible battle', () => {
    // A renderer built before the stylesheet has applied gets nothing back
    // from `getComputedStyle`, and empty strings would paint transparent.
    const palette = paletteFrom(element({}));
    for (const value of Object.values(palette)) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe('the 3D palette', () => {
  it('reads every colour the scene is given', () => {
    const scene = scenePaletteFrom(
      element({
        '--3d-orc-base': '#010101',
        '--3d-orc-emissive': '#020202',
        '--3d-orc-ground': '#030303',
        '--3d-nexus-base': '#040404',
        '--3d-nexus-emissive': '#050505',
        '--3d-nexus-ground': '#060606',
        '--3d-front-line': '#070707',
        '--3d-sky-storm': '#080808',
        '--3d-sky-nebula': '#090909',
        '--3d-light-warm': '#0a0a0a',
        '--3d-light-cool': '#0b0b0b',
        '--3d-impact-flash': '#0c0c0c',
      }),
    );

    // Every field, and no field left on its fallback: a token renamed in
    // `tokens.css` shows up here as one colour that did not move.
    expect(Object.values(scene)).toEqual([
      '#010101',
      '#020202',
      '#030303',
      '#040404',
      '#050505',
      '#060606',
      '#070707',
      '#080808',
      '#090909',
      '#0a0a0a',
      '#0b0b0b',
      '#0c0c0c',
    ]);
  });

  it('trims what the cascade hands back', () => {
    // Custom properties keep their leading whitespace, and `three` rejects
    // " #c4472c" as a style string.
    const scene = scenePaletteFrom(element({ '--3d-orc-base': '  #c4472c  ' }));
    expect(scene.orc).toBe('#c4472c');
  });

  it('falls back on every colour independently', () => {
    const scene = scenePaletteFrom(element({ '--3d-orc-base': '#abcdef' }));
    expect(scene.orc).toBe('#abcdef');
    for (const value of Object.values(scene)) {
      expect(value).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});
