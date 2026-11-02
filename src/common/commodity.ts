// What a shop sells (shops.commodity). Nariyal is sold by the piece out of the shop's own gaadis;
// amrud, angoor and cheeku on commission, by the box, out of each party's lots.
export const COMMODITIES = ['nariyal', 'amrud', 'angoor', 'cheeku'] as const;
export type Commodity = (typeof COMMODITIES)[number];

/** Angoor (grapes) only. Grape code checks this and nothing else. */
export const isAngoor = (commodity: string | null | undefined): boolean => commodity === 'angoor';

/**
 * Cheeku (sapota) only. Cheeku started as a copy of the angoor flow but owns every line of it
 * (src/cheeku/): grapes and cheeku never share grape code, so a change to one never moves the other.
 */
export const isCheeku = (commodity: string | null | undefined): boolean => commodity === 'cheeku';

/** The fruit's name, as the voice assistant and printed documents say it. */
export const commodityName = (commodity: string | null | undefined): string =>
  commodity === 'amrud' ? 'amrud (guava)' : commodity === 'angoor' ? 'angoor (grapes)' : commodity === 'cheeku' ? 'cheeku (sapota)' : 'tender coconut (nariyal)';
