import { Bot, RotateCcw, Send, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "../App.jsx";
import { api } from "../lib/api.js";

const STARTER_PROMPTS = [
  "Summarize this ontology",
  "Explain the class hierarchy",
  "What are the key properties defined here?",
  "Review this ontology for common modeling issues",
];

const DEFAULT_MODEL = "gpt-4o-mini";

const MODELS = [
  { id: "gpt-4o-mini", label: "GPT-4o mini" },
  { id: "gpt-4o", label: "GPT-4o" },
  { id: "Meta-Llama-3.1-70B-Instruct", label: "Llama 3.1 70B" },
  { id: "Mistral-large", label: "Mistral Large" },
  { id: "Phi-4", label: "Phi-4" },
];

let _msgId = 0;
function nextMsgId() {
  _msgId += 1;
  return _msgId;
}

// Streaming AI chat panel using GitHub Models API.
// ontologyId and entityIri are passed in by the parent to provide context.
export default function AIChatPanel({ ontologyId, entityIri, onClose }) {
  const { githubConnection } = useAuth();
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [err, setErr] = useState(null);
  const bottomRef = useRef(null);
  const abortRef = useRef(null);
  const msgCountRef = useRef(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on message count change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgCountRef.current]);

  const sendMessage = async (text) => {
    const userText = (text || input).trim();
    if (!userText || streaming) return;

    setInput("");
    setErr(null);

    const userId = nextMsgId();
    const assistantId = nextMsgId();
    const userMsg = { id: userId, role: "user", content: userText };

    setMessages((prev) => {
      msgCountRef.current = prev.length + 1;
      return [...prev, userMsg];
    });
    setStreaming(true);

    // nextMessages for the API (no id field needed)
    const apiMessages = messages.map(({ role, content }) => ({ role, content }));
    apiMessages.push({ role: "user", content: userText });

    // Add placeholder assistant message
    setMessages((prev) => {
      msgCountRef.current = prev.length + 1;
      return [...prev, { id: assistantId, role: "assistant", content: "" }];
    });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await api.chatStream(
        apiMessages,
        { model, ontologyId, entityIri },
        controller.signal,
      );

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "AI service error");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed?.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(trimmed.slice(6));
            if (event.type === "delta") {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId ? { ...m, content: m.content + event.content } : m,
                ),
              );
            } else if (event.type === "error") {
              setErr(event.message || "AI error");
            }
          } catch {
            // skip malformed SSE line
          }
        }
      }
    } catch (e) {
      if (e.name !== "AbortError") {
        setErr(e.message || "Request failed");
        setMessages((prev) => prev.filter((m) => m.id !== assistantId));
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  };

  const stop = () => {
    abortRef.current?.abort();
    setStreaming(false);
  };

  const clear = () => {
    if (streaming) stop();
    setMessages([]);
    setErr(null);
  };

  if (!githubConnection) {
    return (
      <aside className="w-80 shrink-0 border-l border-ink-700 flex flex-col bg-ink-950/95">
        <PanelHeader
          model={model}
          models={MODELS}
          onModelChange={setModel}
          onClose={onClose}
          onClear={clear}
        />
        <div className="flex-1 flex justify-center p-6 text-center">
          <div className="space-y-2">
            <Bot size={32} className="mx-auto text-slate-600" aria-hidden="true" />
            <p className="text-sm text-slate-400">
              Connect your GitHub account in{" "}
              <a href="/settings#github" className="text-brand-300">
                Settings
              </a>{" "}
              to use AI chat.
            </p>
          </div>
        </div>
      </aside>
    );
  }

  return (
    <aside className="w-80 shrink-0 border-l border-ink-700 flex flex-col bg-ink-950/95">
      <PanelHeader
        model={model}
        models={MODELS}
        onModelChange={setModel}
        onClose={onClose}
        onClear={clear}
      />

      {/* Context indicator */}
      {(ontologyId || entityIri) && (
        <div className="px-3 py-1.5 border-b border-ink-700/50 flex items-center gap-1.5 text-[10px] text-slate-500 truncate">
          <Bot size={10} aria-hidden="true" />
          {entityIri ? `Entity: ${entityIri.split(/[#/]/).pop()}` : "Ontology context active"}
        </div>
      )}

      {/* Message thread */}
      <div className="flex-1 overflow-auto p-3 space-y-3">
        {messages.length === 0 && (
          <div className="space-y-2">
            <p className="text-xs text-slate-500">Suggested questions:</p>
            {STARTER_PROMPTS.map((p) => (
              <button
                key={p}
                type="button"
                className="w-full text-left text-xs px-2.5 py-1.5 rounded border border-ink-600 text-slate-300 hover:border-brand-400 hover:text-brand-200 transition-colors"
                onClick={() => sendMessage(p)}
              >
                {p}
              </button>
            ))}
          </div>
        )}
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        {err && (
          <div className="text-xs text-red-300 px-2 py-1 rounded bg-red-900/20 border border-red-800/40">
            {err}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input area */}
      <form
        className="p-3 border-t border-ink-700 space-y-2 bg-ink-900/40"
        onSubmit={(e) => {
          e.preventDefault();
          sendMessage();
        }}
      >
        <textarea
          className="input min-h-15 text-sm resize-none"
          placeholder="Ask about this ontology…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              sendMessage();
            }
          }}
          disabled={streaming}
        />
        <div className="flex justify-end gap-2">
          {streaming && (
            <button type="button" className="btn-ghost text-xs" onClick={stop}>
              Stop
            </button>
          )}
          <button
            type="submit"
            className="btn-primary text-xs flex items-center gap-1"
            disabled={streaming || !input.trim()}
          >
            <Send size={12} aria-hidden="true" />
            Send
          </button>
        </div>
      </form>
    </aside>
  );
}

function PanelHeader({ model, models, onModelChange, onClose, onClear }) {
  return (
    <header className="p-3 border-b border-ink-700 flex items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        <Bot size={14} className="text-brand-400 shrink-0" aria-hidden="true" />
        <span className="text-sm font-semibold">AI Chat</span>
      </div>
      <div className="flex items-center gap-1">
        <select
          className="text-[10px] bg-ink-800 border border-ink-600 rounded px-1 py-0.5 text-slate-300"
          value={model}
          onChange={(e) => onModelChange(e.target.value)}
          title="Model"
        >
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <button type="button" className="btn-ghost p-1" onClick={onClear} title="Clear chat">
          <RotateCcw size={12} aria-hidden="true" />
        </button>
        {onClose && (
          <button type="button" className="btn-ghost p-1" onClick={onClose} title="Close">
            <X size={12} aria-hidden="true" />
          </button>
        )}
      </div>
    </header>
  );
}

function MessageBubble({ message }) {
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[90%] text-sm rounded-lg px-3 py-2 whitespace-pre-wrap wrap-break-word ${
          isUser
            ? "bg-brand-600/30 text-brand-100 border border-brand-600/40"
            : "bg-ink-800/60 text-slate-200 border border-ink-600/40"
        }`}
      >
        {message.content || <span className="text-slate-500 animate-pulse">▋</span>}
      </div>
    </div>
  );
}
