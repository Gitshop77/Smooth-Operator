"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Sparkles, Send, Bot, User, Loader2, Trash2 } from "lucide-react";

import { useSendChat, type ChatMessage } from "@/hooks/use-cowork-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { ViewHeader } from "@/components/cowork/shared/view-header";

const SUGGESTIONS = [
  "Summarise the open tabs",
  "Find the cheapest flight to Tokyo",
  "Refactor my auth middleware",
  "Watch the github.com tab for changes",
];

export function ChatView() {
  const sendChat = useSendChat();
  const { toast } = useToast();
  // `timestamp: 0` avoids an SSR/client hydration mismatch (`Date.now()`
  // differs between server render and client hydration). The greeting is
  // static so the exact timestamp doesn't matter.
  const [messages, setMessages] = React.useState<ChatMessage[]>(() => [
    {
      id: "m0",
      role: "assistant",
      text: "Hi — I'm Wingman, your in-browser agent. Ask me to research, automate, or inspect anything across your tabs.",
      timestamp: 0,
    },
  ]);
  const [input, setInput] = React.useState("");
  const [streaming, setStreaming] = React.useState<string | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  // AbortController for the in-flight chat fetch, kept in a ref (not state)
  // so `.abort()` from the Clear handler doesn't trigger a re-render.
  const abortRef = React.useRef<AbortController | null>(null);
  // Track the typewriter setTimeout chain so `clearChat` can cancel it.
  const typewriterTimeouts = React.useRef<number[]>([]);
  // Boolean flag checked at the top of every `tick`. Set by `clearChat` so
  // any tick already in the microtask queue returns immediately without
  // writing to state.
  const typewriterAborted = React.useRef(false);

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, streaming]);

  // On unmount, clear any pending typewriter timeouts so they don't fire
  // after the component is gone.
  React.useEffect(() => {
    return () => {
      typewriterTimeouts.current.forEach((id) => clearTimeout(id));
      typewriterTimeouts.current = [];
    };
  }, []);

  // On unmount, abort any in-flight chat fetch. The `useSendChat` mutation's
  // `onError` callback fires the "Chat backend offline" toast — without
  // aborting on unmount, navigating away from the Chat view while a request
  // is in flight would surface that toast on the next view. Aborting causes
  // `fetch` to reject with an `AbortError`, which the `onError` handler
  // short-circuits via the `isAbort` check.
  React.useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const finishAssistantReply = (text: string) => {
    // Reset the abort flag for this fresh reply. A previous Clear may have
    // set it true; we flip it back so ticks aren't no-ops.
    typewriterAborted.current = false;
    let i = 0;
    setStreaming("");
    const tick = () => {
      // If Clear was clicked between scheduling and firing, bail immediately.
      if (typewriterAborted.current) return;
      i += Math.max(1, Math.round(Math.random() * 4));
      setStreaming(text.slice(0, i));
      if (i < text.length) {
        // Track every scheduled timeout so `clearChat` can cancel the
        // whole chain in O(N).
        const id = window.setTimeout(tick, 18);
        typewriterTimeouts.current.push(id);
      } else {
        setMessages((m) => [
          ...m,
          { id: `m${Date.now()}`, role: "assistant", text, timestamp: Date.now() },
        ]);
        setStreaming(null);
      }
    };
    const id = window.setTimeout(tick, 250);
    typewriterTimeouts.current.push(id);
  };

  // `send` is defined in the render body, so the purity rule flags
  // `Date.now()` calls inside it. We take the timestamp as a parameter
  // from the caller (an event-handler lambda, exempt from the rule)
  // instead of computing it here. The id and timestamp are derived from
  // the same `ts` so they stay consistent.
  const send = (text: string, ts: number) => {
    const trimmed = text.trim();
    if (!trimmed || streaming) return;
    const userMsg: ChatMessage = {
      id: `u${ts}`,
      role: "user",
      text: trimmed,
      timestamp: ts,
    };
    setMessages((m) => [...m, userMsg]);
    setInput("");

    // Create a fresh AbortController for this run. Abort the previous
    // controller (if any) before creating a new one so rapid Enter keypresses
    // don't fire concurrent fetches whose replies clobber each other.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    // Pass conversation history so the LLM has context for follow-up questions.
    // Filter out the greeting (id "m0") and error messages (id "e...") so the
    // LLM doesn't receive fabricated prior assistant replies as context.
    const history = messages
      .filter((m) => m.id !== "m0" && !m.id.startsWith("e"))
      .map((m) => ({ role: m.role, content: m.text }));
    sendChat.mutate(
      { text: trimmed, history, signal: controller.signal },
      {
        onSuccess: (data) => {
          const reply =
            data && typeof data.content === "string" ? data.content.trim() : "";
          if (!reply) {
            // The mini-service answered but returned no content. Surface the
            // real error (if any) instead of fabricating a reply.
            const apiError =
              data && typeof data.error === "string" ? data.error : "No content returned.";
            setMessages((m) => [
              ...m,
              {
                id: `e${Date.now()}`,
                role: "assistant",
                text: `The wingman service returned an empty response. ${apiError}`,
                timestamp: Date.now(),
              },
            ]);
            toast({
              title: "Empty response",
              description: apiError,
              variant: "destructive",
            });
            return;
          }
          finishAssistantReply(reply);
        },
        onError: (err: unknown) => {
          // If the fetch was aborted (user clicked Clear), don't surface an
          // error toast — the abort was intentional.
          const isAbort =
            err instanceof DOMException && err.name === "AbortError";
          if (isAbort) return;
          const msg = err instanceof Error ? err.message : String(err);
          setMessages((m) => [
            ...m,
            {
              id: `e${Date.now()}`,
              role: "assistant",
              text: `Couldn't reach the wingman service (port 3003). ${msg}`,
              timestamp: Date.now(),
            },
          ]);
          toast({
            title: "Chat backend offline",
            description: msg,
            variant: "destructive",
          });
        },
      },
    );
  };

  // Clear button handler. Aborts the in-flight fetch (if any) AND cancels
  // the typewriter setTimeout chain so pending ticks can't re-show the
  // typing indicator or append a ghost reply after Clear.
  const clearChat = () => {
    // 1. Cancel the in-flight LLM fetch.
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    // 2. Cancel the typewriter setTimeout chain.
    typewriterAborted.current = true;
    typewriterTimeouts.current.forEach((id) => clearTimeout(id));
    typewriterTimeouts.current = [];
    // 3. Reset the visible state. `setStreaming(null)` hides the typing
    //    indicator; `setMessages([greeting])` resets the list. With the
    //    timeouts cleared + the abort flag set, no pending tick can
    //    re-populate either.
    setStreaming(null);
    setMessages([
      {
        id: "m0",
        role: "assistant",
        text: "Cleared. What next?",
        timestamp: Date.now(),
      },
    ]);
  };

  return (
    <div className="space-y-4 h-full flex flex-col">
      <ViewHeader
        title="AI Chat"
        description="Wingman — your in-browser agent (streaming via port 3003)"
        icon={<Sparkles className="size-5" />}
        actions={
          <Button
            size="sm"
            variant="outline"
            onClick={clearChat}
          >
            <Trash2 className="size-4" /> Clear
          </Button>
        }
      />

      <Card className="flex-1 p-0 gap-0 overflow-hidden flex flex-col min-h-[60vh]">
        {/* Messages */}
        <div ref={scrollRef} className="flex-1 overflow-auto cowork-scroll p-4 space-y-4">
          <AnimatePresence initial={false}>
            {messages.map((m) => (
              <motion.div
                key={m.id}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                className={`flex gap-3 ${m.role === "user" ? "justify-end" : ""}`}
              >
                {m.role === "assistant" ? (
                  <div className="size-8 rounded-full bg-primary text-primary-foreground grid place-items-center shrink-0">
                    <Bot className="size-4" />
                  </div>
                ) : null}
                <div
                  className={`max-w-[80%] rounded-2xl px-4 py-2.5 text-sm ${
                    m.role === "user"
                      ? "bg-primary text-primary-foreground rounded-br-sm"
                      : "bg-muted text-foreground rounded-bl-sm"
                  }`}
                >
                  <p className="whitespace-pre-wrap leading-relaxed">{m.text}</p>
                  {m.id !== "m0" && (
                    <p className={`text-[10px] mt-1.5 ${m.role === "user" ? "text-primary-foreground" : "text-muted-foreground"}`}>
                      {new Date(m.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </p>
                  )}
                </div>
                {m.role === "user" ? (
                  <div className="size-8 rounded-full bg-muted text-muted-foreground grid place-items-center shrink-0">
                    <User className="size-4" />
                  </div>
                ) : null}
              </motion.div>
            ))}
          </AnimatePresence>

          {streaming !== null ? (
            <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="flex gap-3">
              <div className="size-8 rounded-full bg-primary text-primary-foreground grid place-items-center shrink-0">
                <Bot className="size-4" />
              </div>
              <div className="max-w-[80%] rounded-2xl px-4 py-2.5 text-sm bg-muted rounded-bl-sm">
                <p className="whitespace-pre-wrap leading-relaxed">
                  {streaming}
                  <span className="inline-block w-1.5 h-3.5 bg-foreground ml-0.5 cowork-pulse align-middle" />
                </p>
              </div>
            </motion.div>
          ) : null}

          {sendChat.isPending && streaming === null ? (
            <div className="flex gap-3">
              <div className="size-8 rounded-full bg-primary text-primary-foreground grid place-items-center shrink-0">
                <Bot className="size-4" />
              </div>
              <div className="rounded-2xl px-4 py-2.5 text-sm bg-muted rounded-bl-sm flex items-center gap-2 text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> thinking…
              </div>
            </div>
          ) : null}
        </div>

        {/* Suggestions */}
        {messages.length <= 1 ? (
          <div className="px-4 pb-2 flex flex-wrap gap-2">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                onClick={() => send(s, Date.now())}
                className="text-xs px-3 py-1.5 rounded-full border bg-background hover:bg-accent transition-colors"
              >
                {s}
              </button>
            ))}
          </div>
        ) : null}

        {/* Composer */}
        <div className="border-t p-3 flex items-center gap-2">
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                // Guard Enter the same way the Send button is guarded
                // (`disabled={... || streaming !== null}`).
                if (streaming !== null) return;
                send(input, Date.now());
              }
            }}
            placeholder="Message Wingman…"
            aria-label="Message Wingman"
            className="h-10"
            disabled={streaming !== null}
          />
          <Button
            size="icon"
            className="size-10 shrink-0"
            onClick={() => send(input, Date.now())}
            disabled={!input.trim() || streaming !== null}
            aria-label="Send"
          >
            <Send className="size-4" />
          </Button>
        </div>
      </Card>
    </div>
  );
}
