import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

// Standard shadcn/ui `cn()` helper -- merges conditional class lists
// (clsx) then dedupes conflicting Tailwind utilities (tailwind-merge),
// e.g. `cn('px-2', condition && 'px-4')` keeps only `px-4` when
// `condition` is true instead of emitting both.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
