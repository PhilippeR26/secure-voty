"use client"

import createCache from "@emotion/cache"
import { CacheProvider } from "@emotion/react"
import { useState } from "react"

export function ChakraEmotionCache({ children }: { children: React.ReactNode }) {
  const [cache] = useState(() =>
    createCache({ key: "css", prepend: true })
  )
  return <CacheProvider value={cache}>{children}</CacheProvider>
}
