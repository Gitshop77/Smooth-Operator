"use client"

import { useToast } from "@/hooks/use-toast"
import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from "@/components/ui/toast"

export function Toaster() {
  const { toasts } = useToast()

  return (
    <ToastProvider swipeDirection="right" duration={5000}>
      {toasts.map(function ({ id, title, description, action, variant, duration, ...props }) {
        const effectiveDuration = variant === "destructive" ? 9000 : duration;
        return (
          <Toast
            key={id}
            variant={variant}
            duration={effectiveDuration}
            type={variant === "destructive" ? "foreground" : "background"}
            {...props}
          >
            <div className="grid gap-1">
              {title && <ToastTitle>{title}</ToastTitle>}
              {description && (
                <ToastDescription>{description}</ToastDescription>
              )}
            </div>
            {action}
            <ToastClose aria-label={title ? `Close: ${title}` : "Close notification"} />
          </Toast>
        )
      })}
      <ToastViewport />
    </ToastProvider>
  )
}