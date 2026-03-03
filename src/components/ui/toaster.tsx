"use client"

import {
  Toaster as ChakraToaster,
  Portal,
  Spinner,
  Stack,
  Toast,
  createToaster,
} from "@chakra-ui/react"

export const toaster = createToaster({
  placement: "bottom-end",
  pauseOnPageIdle: true,
})

type ToastType = "success" | "error" | "warning" | "info" | "loading";

type ToastStyle = {
  rootBg: string;
  rootColor?: string;
  indicatorColor?: string;
  titleColor?: string;
  descColor?: string;
};

export const Toaster = () => {
  return (
    <Portal>
      <ChakraToaster toaster={toaster} insetInline={{ mdDown: "4" }}>
        {(toast) => {
          const statusStyles: Record<ToastType, ToastStyle> = {
            success: {
              rootBg: "green.600",
              rootColor: "white",
              indicatorColor: "white",
              titleColor: "white",
              descColor: "whiteAlpha.900",
            },
            error: {
              rootBg: "red.600",
              rootColor: "white",
              indicatorColor: "white",
              titleColor: "white",
              descColor: "whiteAlpha.900",
            },
            warning: {
              rootBg: "orange.600",
              rootColor: "white", // croix de fermeture
              indicatorColor: "white", // logo à gauche
              titleColor: "white",
              descColor: "whiteAlpha.900", // text

            },
            info: {
              rootBg: "blue.600",
              rootColor: "white",
              indicatorColor: "white",
              titleColor: "white",
              descColor: "whiteAlpha.900",
            },
            loading: {
              rootBg: "gray.700",
              rootColor: "white",
            },
          } as const // fallback sur info
          const styles = statusStyles[toast.type as ToastType] ?? statusStyles.info;

          return (
            <Toast.Root
              width={{ md: "sm" }}
              bg={styles.rootBg}
              color={styles.rootColor}
              borderRadius="md"
              boxShadow="lg"
              p={4}
              gap={3}
            >
              {toast.type === "loading" ? (
                <Spinner size="sm" color={styles.indicatorColor || "blue.500"} />
              ) : (
                <Toast.Indicator color={styles.indicatorColor} />
              )}

              <Stack gap="1" flex="1" maxWidth="100%">
                {toast.title && (
                  <Toast.Title
                    fontWeight="semibold"
                    color={styles.titleColor}
                  >
                    {toast.title}
                  </Toast.Title>
                )}

                {toast.description && (
                  <Toast.Description
                    color={styles.descColor}
                    opacity={0.9}
                  >
                    {toast.description}
                  </Toast.Description>
                )}
              </Stack>

              {toast.action && (
                <Toast.ActionTrigger asChild>
                  {toast.action.label}
                </Toast.ActionTrigger>
              )}

              {toast.closable && <Toast.CloseTrigger />}
            </Toast.Root>
          )
        }}
      </ChakraToaster>
    </Portal>
  )
}