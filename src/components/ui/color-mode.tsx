"use client"

import { createContext, useContext, useEffect, useSyncExternalStore } from "react"

type ColorMode = "light" | "dark"

interface ColorModeContextType {
  colorMode: ColorMode
  toggleColorMode: () => void
  setColorMode: (mode: ColorMode) => void
}

const ColorModeContext = createContext<ColorModeContextType>({
  colorMode: "light",
  toggleColorMode: () => {},
  setColorMode: () => {},
})

// The color mode lives in localStorage (an external store): useSyncExternalStore reconciles
// the server render ("light") with the client value, without calling setState in an effect.
const listeners = new Set<() => void>()

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getSnapshot(): ColorMode {
  const stored = localStorage.getItem("color-mode") as ColorMode | null
  return stored ?? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
}

function getServerSnapshot(): ColorMode {
  return "light"
}

export function ColorModeProvider({ children }: { children: React.ReactNode }) {
  const colorMode = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  useEffect(() => {
    document.documentElement.classList.toggle("dark", colorMode === "dark")
  }, [colorMode])

  const setColorMode = (mode: ColorMode) => {
    localStorage.setItem("color-mode", mode)
    listeners.forEach((listener) => listener())
  }

  const toggleColorMode = () => {
    setColorMode(colorMode === "light" ? "dark" : "light")
  }

  return (
    <ColorModeContext.Provider value={{ colorMode, toggleColorMode, setColorMode }}>
      {children}
    </ColorModeContext.Provider>
  )
}

export function useColorMode() {
  return useContext(ColorModeContext)
}

export function useColorModeValue<T>(light: T, dark: T): T {
  const { colorMode } = useColorMode()
  return colorMode === "light" ? light : dark
}