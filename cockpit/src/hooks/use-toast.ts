"use client"

// Inspired by react-hot-toast library
import * as React from "react"

import type {
  ToastActionElement,
  ToastProps,
} from "@/components/ui/toast"

const TOAST_LIMIT = 1
const TOAST_REMOVE_DELAY = 1000000

type ToasterToast = ToastProps & {
  id: string
  title?: React.ReactNode
  description?: React.ReactNode
  action?: ToastActionElement
}

let count = 0

function genId() {
  count = (count + 1) % Number.MAX_SAFE_INTEGER
  return count.toString()
}

// Action type literals are inlined directly in the `Action` union — the
// reducer's `switch` cases match the union members, keeping exhaustiveness
// without a runtime const.
type Action =
  | {
    type: "ADD_TOAST"
    toast: ToasterToast
  }
  | {
    type: "UPDATE_TOAST"
    toast: Partial<ToasterToast>
  }
  | {
    type: "DISMISS_TOAST"
    toastId?: ToasterToast["id"]
  }
  | {
    type: "REMOVE_TOAST"
    toastId?: ToasterToast["id"]
  }

interface State {
  toasts: ToasterToast[]
}

const toastTimeouts = new Map<string, ReturnType<typeof setTimeout>>()

const addToRemoveQueue = (toastId: string) => {
  if (toastTimeouts.has(toastId)) {
    return
  }

  const timeout = setTimeout(() => {
    toastTimeouts.delete(toastId)
    dispatch({
      type: "REMOVE_TOAST",
      toastId: toastId,
    })
  }, TOAST_REMOVE_DELAY)

  toastTimeouts.set(toastId, timeout)
}

// Clear any pending removal timer for a toast that is leaving state, so its
// timer handle is not orphaned (e.g. when evicted by the toast limit or
// removed before its timer fires).
const removeFromRemoveQueue = (toastId: string) => {
  const timeout = toastTimeouts.get(toastId)
  if (timeout !== undefined) {
    clearTimeout(timeout)
    toastTimeouts.delete(toastId)
  }
}

export const reducer = (state: State, action: Action): State => {
  switch (action.type) {
    case "ADD_TOAST": {
      const newToasts = [action.toast, ...state.toasts].slice(0, TOAST_LIMIT)
      // Toasts evicted by the limit may still have a pending removal timer;
      // clear those so their timer handles are not left orphaned.
      const keptIds = new Set(newToasts.map((t) => t.id))
      state.toasts.forEach((t) => {
        if (!keptIds.has(t.id)) {
          removeFromRemoveQueue(t.id)
        }
      })
      return {
        ...state,
        toasts: newToasts,
      }
    }

    case "UPDATE_TOAST":
      return {
        ...state,
        toasts: state.toasts.map((t) =>
          t.id === action.toast.id ? { ...t, ...action.toast } : t
        ),
      }

    case "DISMISS_TOAST": {
      const { toastId } = action

      // ! Side effects ! - This could be extracted into a dismissToast() action,
      // but I'll keep it here for simplicity
      if (toastId) {
        addToRemoveQueue(toastId)
      } else {
        state.toasts.forEach((toast) => {
          addToRemoveQueue(toast.id)
        })
      }

      return {
        ...state,
        toasts: state.toasts.map((t) =>
          t.id === toastId || toastId === undefined
            ? {
              ...t,
              open: false,
            }
            : t
        ),
      }
    }
    case "REMOVE_TOAST":
      if (action.toastId === undefined) {
        toastTimeouts.forEach((timeout) => clearTimeout(timeout))
        toastTimeouts.clear()
        return {
          ...state,
          toasts: [],
        }
      }
      removeFromRemoveQueue(action.toastId)
      return {
        ...state,
        toasts: state.toasts.filter((t) => t.id !== action.toastId),
      }
  }
}

const listeners: Array<(state: State) => void> = []

let memoryState: State = { toasts: [] }

function dispatch(action: Action) {
  memoryState = reducer(memoryState, action)
  listeners.forEach((listener) => {
    listener(memoryState)
  })
}

type Toast = Omit<ToasterToast, "id">

function toast({ ...props }: Toast) {
  const id = genId()

  const update = (props: ToasterToast) =>
    dispatch({
      type: "UPDATE_TOAST",
      toast: { ...props, id },
    })
  const dismiss = () => dispatch({ type: "DISMISS_TOAST", toastId: id })

  dispatch({
    type: "ADD_TOAST",
    toast: {
      ...props,
      id,
      open: true,
      onOpenChange: (open) => {
        if (!open) dismiss()
      },
    },
  })

  return {
    id: id,
    dismiss,
    update,
  }
}

function useToast() {
  const [state, setState] = React.useState<State>(memoryState)

  React.useEffect(() => {
    listeners.push(setState)
    return () => {
      const index = listeners.indexOf(setState)
      if (index > -1) {
        listeners.splice(index, 1)
      }
    }
  }, [])

  return {
    ...state,
    toast,
    dismiss: (toastId?: string) => dispatch({ type: "DISMISS_TOAST", toastId }),
  }
}

export { useToast }