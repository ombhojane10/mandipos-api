import type { ReactNode } from 'react'

/** The label with its hotkey letter underlined — the capital that starts a word first, as Tally bolds it. */
export function Hot({ label, k }: { label: string; k: string }): ReactNode {
  if (!k) return label
  const lower = label.toLowerCase()
  let i = -1
  for (let j = 0; j < label.length; j++) if (lower[j] === k && (j === 0 || label[j - 1] === ' ' || label[j - 1] === '/')) { i = j; break }
  if (i < 0) i = lower.indexOf(k)
  if (i < 0) return label
  return <>{label.slice(0, i)}<span className="hk">{label[i]}</span>{label.slice(i + 1)}</>
}
