"use client"

import { createContext, useContext, useEffect, useState } from "react"

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

export function ColorModeProvider({ children }: { children: React.ReactNode }) {
  const [colorMode, setColorModeState] = useState<ColorMode>("light")

  useEffect(() => {
    const stored = localStorage.getItem("color-mode") as ColorMode | null
    const preferred = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
    const initial = stored ?? preferred
    setColorModeState(initial)
    document.documentElement.classList.toggle("dark", initial === "dark")
  }, [])

  const setColorMode = (mode: ColorMode) => {
    setColorModeState(mode)
    localStorage.setItem("color-mode", mode)
    document.documentElement.classList.toggle("dark", mode === "dark")
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