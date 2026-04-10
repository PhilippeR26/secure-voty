"use client"

import { ChakraProvider, defaultSystem } from "@chakra-ui/react"
import { ChakraEmotionCache } from "./chakra-cache"
import { ColorModeProvider } from "./color-mode"

export function Provider({ children }: { children: React.ReactNode }) {
  return (
    <ChakraEmotionCache>
      <ChakraProvider value={defaultSystem}>
        <ColorModeProvider>
          {children}
        </ColorModeProvider>
      </ChakraProvider>
    </ChakraEmotionCache>
  )
}