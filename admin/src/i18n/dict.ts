/**
 * Every dictionary, merged: Hinglish label → [English, Hindi]. One file per part of the site, so
 * each can be filled without touching the others; a key in more than one keeps the later one.
 */
import { ENTRIES } from './entries'
import { INSIGHTS } from './insights'
import { REPORTS } from './reports'
import { SHELL } from './shell'

export const DICT: Record<string, readonly [string, string]> = { ...SHELL, ...REPORTS, ...ENTRIES, ...INSIGHTS }
