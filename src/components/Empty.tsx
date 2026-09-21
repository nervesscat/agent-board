import type { ReactNode } from 'react'

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed px-4 py-10 text-center text-sm text-muted-foreground">
      {children}
    </div>
  )
}
