import { t } from './i18n'

/** Angoor (grapes) only. Grape code checks this and nothing else. Mirrors the API's src/common/commodity.ts. */
export const isAngoor = (commodity?: string | null): boolean => commodity === 'angoor'

/**
 * Cheeku (sapota) only. Cheeku started as a copy of the grapes pages but owns every line of
 * them (pages/Cheeku.tsx, entries/Cheeku.tsx, CheekuScan.tsx, pages/CheekuLabour.tsx,
 * pages/CheekuCreditors.tsx, cheeku.ts): grapes and cheeku never share grape code.
 */
export const isCheeku = (commodity?: string | null): boolean => commodity === 'cheeku'

/** The fruit's name in the reader's language: Nariyal, Amrud, Angoor or Cheeku. */
export const commodityLabel = (commodity?: string | null): string =>
  commodity === 'amrud' ? t('Amrud') : commodity === 'angoor' ? t('Angoor') : commodity === 'cheeku' ? t('Cheeku') : t('Nariyal')
