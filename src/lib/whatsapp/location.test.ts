import { describe, expect, it } from 'vitest';

import { mapsLink, parseLocation } from './location';

describe('parseLocation', () => {
  it("reads the ?q=LAT,LNG share link (Alex's own paste, %2C-encoded)", () => {
    const url =
      'https://maps.google.com/maps?q=-20.413976669311523%2C-54.567100524902344&z=17&hl=pt-BR';
    expect(parseLocation(url)).toEqual({
      lat: -20.413976669311523,
      lng: -54.567100524902344,
    });
  });

  it('reads a plain (non-encoded) q= link', () => {
    expect(parseLocation('https://maps.google.com/maps?q=-20.41,-54.56')).toEqual(
      { lat: -20.41, lng: -54.56 },
    );
  });

  it('reads the /@LAT,LNG,zoom map-view URL', () => {
    expect(
      parseLocation('https://www.google.com/maps/@-23.5505,-46.6333,17z'),
    ).toEqual({ lat: -23.5505, lng: -46.6333 });
  });

  it('reads a raw "lat, lng" pair', () => {
    expect(parseLocation('-20.41, -54.56')).toEqual({ lat: -20.41, lng: -54.56 });
  });

  it('rejects a shortened goo.gl link (no coords in the URL)', () => {
    expect(parseLocation('https://maps.app.goo.gl/abc123XYZ')).toBeNull();
  });

  it('rejects out-of-range coordinates', () => {
    expect(parseLocation('999, 999')).toBeNull();
  });

  it('does not mistake a number inside other text for coordinates', () => {
    expect(parseLocation('rua 15, número 20')).toBeNull();
  });

  it('is null for empty input', () => {
    expect(parseLocation('')).toBeNull();
  });
});

describe('mapsLink', () => {
  it('round-trips: a stored link parses back to the same point', () => {
    const loc = { lat: -20.41, lng: -54.56 };
    expect(parseLocation(mapsLink(loc))).toEqual(loc);
  });
});
