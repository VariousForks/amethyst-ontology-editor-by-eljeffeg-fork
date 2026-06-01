import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  CircleDot,
  MessageSquare,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import { marked } from "marked";
import { createElement, useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../App.jsx";
import { api } from "../lib/api.js";
import { useProject } from "./OntologyPicker.jsx";

marked.setOptions({ gfm: true, breaks: true });

// Allowlist of tags we'll render. Anything else is dropped.
const SAFE_TAGS = new Set([
  "p",
  "br",
  "hr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "code",
  "strong",
  "em",
  "del",
  "s",
  "a",
  "img",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "span",
  "div",
]);

const ATTR_MAP = { class: "className", for: "htmlFor", colspan: "colSpan", rowspan: "rowSpan" };

function domToReact(node, key) {
  if (node.nodeType === 3) return node.textContent; // text
  if (node.nodeType !== 1) return null;
  const tag = node.tagName.toLowerCase();
  if (!SAFE_TAGS.has(tag)) return null;
  const props = { key };
  for (const { name, value } of node.attributes) {
    if (name.startsWith("on")) continue; // drop event handlers
    props[ATTR_MAP[name] ?? name] = value;
  }
  if (tag === "a") {
    props.target = "_blank";
    props.rel = "noreferrer noopener";
  }
  const children = Array.from(node.childNodes)
    .map(domToReact)
    .filter((c) => c != null);
  return createElement(tag, props, ...children);
}

function Markdown({ text }) {
  const nodes = useMemo(() => {
    if (!text) return [];
    const html = marked.parse(text);
    const doc = new DOMParser().parseFromString(html, "text/html");
    return Array.from(doc.body.childNodes)
      .map(domToReact)
      .filter((c) => c != null);
  }, [text]);
  return createElement(
    "div",
    { className: "prose-github text-sm text-slate-300 leading-relaxed" },
    ...nodes,
  );
}

function timeAgo(dateStr) {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function Label({ name, color }) {
  const bg = color ? `#${color}22` : undefined;
  const border = color ? `#${color}66` : undefined;
  const text = color ? `#${color}` : undefined;
  return (
    <span
      className="inline-block px-1.5 py-0.5 rounded text-[10px] font-medium border"
      style={{ backgroundColor: bg, borderColor: border, color: text }}
    >
      {name}
    </span>
  );
}

function IssueStateIcon({ state }) {
  if (state === "closed") {
    return <CheckCircle2 size={14} className="text-purple-400 shrink-0" />;
  }
  return <CircleDot size={14} className="text-emerald-400 shrink-0" />;
}

// ── Issue list item ───────────────────────────────────────────────────────────

function IssueListItem({ issue, selected, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left px-4 py-3 border-b border-ink-700/50 transition hover:bg-ink-800/60 ${
        selected ? "bg-ink-800/80 border-l-2 border-l-brand-500" : ""
      }`}
    >
      <div className="flex items-start gap-2">
        <IssueStateIcon state={issue.state} />
        <div className="min-w-0 flex-1">
          <div className="text-sm text-slate-200 font-medium truncate">{issue.title}</div>
          <div className="text-[11px] text-slate-500 mt-0.5 flex items-center gap-2 flex-wrap">
            <span>#{issue.number}</span>
            <span>·</span>
            <span>{timeAgo(issue.created_at)}</span>
            {issue.user && <span>by @{issue.user.login}</span>}
            {issue.comments > 0 && (
              <span className="flex items-center gap-1">
                <MessageSquare size={10} />
                {issue.comments}
              </span>
            )}
          </div>
          {issue.labels?.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {issue.labels.map((l) => (
                <Label key={l.id} name={l.name} color={l.color} />
              ))}
            </div>
          )}
        </div>
      </div>
    </button>
  );
}

// ── Issue detail ──────────────────────────────────────────────────────────────

function IssueDetail({ projectId, issue: initialIssue, isEditor, onBack }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [commentBody, setCommentBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [commentErr, setCommentErr] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await api.getProjectIssue(projectId, initialIssue.number);
      setData(r);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [projectId, initialIssue.number]);

  useEffect(() => {
    load();
  }, [load]);

  const submitComment = async (e) => {
    e.preventDefault();
    if (!commentBody.trim()) return;
    setBusy(true);
    setCommentErr(null);
    try {
      await api.createIssueComment(projectId, initialIssue.number, commentBody.trim());
      setCommentBody("");
      await load();
    } catch (e) {
      setCommentErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const issue = data?.issue || initialIssue;
  const comments = data?.comments || [];

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="shrink-0 px-4 py-3 border-b border-ink-700 flex items-start gap-3">
        <button
          type="button"
          onClick={onBack}
          className="md:hidden btn-ghost text-xs flex items-center gap-1 mt-0.5"
        >
          <ChevronLeft size={14} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-2">
            <IssueStateIcon state={issue.state} />
            <h2 className="text-base font-semibold text-slate-100 leading-snug">{issue.title}</h2>
          </div>
          <div className="text-[11px] text-slate-500 mt-1 flex items-center gap-2 flex-wrap">
            <span
              className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium ${
                issue.state === "closed"
                  ? "bg-purple-500/20 text-purple-300"
                  : "bg-emerald-500/20 text-emerald-300"
              }`}
            >
              {issue.state}
            </span>
            <span>#{issue.number}</span>
            <span>·</span>
            <span>opened {timeAgo(issue.created_at)}</span>
            {issue.user && <span>by @{issue.user.login}</span>}
            {issue.html_url && (
              <a
                href={issue.html_url}
                target="_blank"
                rel="noreferrer"
                className="text-brand-400 hover:underline"
              >
                View on GitHub ↗
              </a>
            )}
          </div>
          {issue.labels?.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {issue.labels.map((l) => (
                <Label key={l.id} name={l.name} color={l.color} />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Body + comments */}
      <div className="flex-1 overflow-y-auto">
        {loading && <div className="p-4 text-sm text-slate-500">Loading…</div>}
        {err && <div className="p-4 text-sm text-red-300">{err}</div>}
        {!loading && (
          <>
            {/* Issue body */}
            {issue.body && (
              <div className="px-4 py-4 border-b border-ink-700/50">
                <div className="flex items-center gap-2 text-[11px] text-slate-500 mb-2">
                  <span className="font-medium text-slate-400">@{issue.user?.login}</span>
                  <span>·</span>
                  <span>{timeAgo(issue.created_at)}</span>
                </div>
                <Markdown text={issue.body} />
              </div>
            )}

            {/* Comments */}
            {comments.map((c) => (
              <div key={c.id} className="px-4 py-4 border-b border-ink-700/50">
                <div className="flex items-center gap-2 text-[11px] text-slate-500 mb-2">
                  <span className="font-medium text-slate-400">@{c.user?.login}</span>
                  <span>·</span>
                  <span>{timeAgo(c.created_at)}</span>
                  {c.html_url && (
                    <a
                      href={c.html_url}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-auto text-brand-400 hover:underline"
                    >
                      ↗
                    </a>
                  )}
                </div>
                <Markdown text={c.body} />
              </div>
            ))}

            {comments.length === 0 && !issue.body && (
              <div className="p-6 text-sm text-slate-500 text-center">No content yet.</div>
            )}
          </>
        )}
      </div>

      {/* Comment form */}
      {isEditor && (
        <div className="shrink-0 border-t border-ink-700 px-4 py-3">
          <form onSubmit={submitComment} className="space-y-2">
            <textarea
              className="input w-full text-sm min-h-20 resize-none"
              placeholder="Leave a comment…"
              value={commentBody}
              onChange={(e) => setCommentBody(e.target.value)}
              disabled={busy}
            />
            {commentErr && <div className="text-xs text-red-300">{commentErr}</div>}
            <div className="flex justify-end">
              <button
                type="submit"
                className="btn-primary text-xs"
                disabled={busy || !commentBody.trim()}
              >
                {busy ? "Posting…" : "Comment"}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}

// ── New issue form ────────────────────────────────────────────────────────────

function NewIssueForm({ projectId, onCreated, onCancel }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.createProjectIssue(projectId, { title: title.trim(), body: body.trim() });
      onCreated(r.issue);
    } catch (e) {
      setErr(e.message);
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="shrink-0 px-4 py-3 border-b border-ink-700 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-200">New Issue</h2>
        <button type="button" onClick={onCancel} className="btn-ghost p-1">
          <X size={14} />
        </button>
      </div>
      <form onSubmit={submit} className="flex-1 flex flex-col gap-3 p-4 overflow-y-auto">
        <label className="block">
          <span className="label">Title</span>
          <input
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Issue title"
            required
            disabled={busy}
          />
        </label>
        <label className="block flex-1">
          <span className="label">Description</span>
          <textarea
            className="input w-full min-h-40 resize-none"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="Describe the issue…"
            disabled={busy}
          />
        </label>
        {err && <div className="text-sm text-red-300">{err}</div>}
        <div className="flex gap-2 justify-end">
          <button type="button" className="btn-ghost text-sm" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn-primary text-sm" disabled={busy || !title.trim()}>
            {busy ? "Creating…" : "Submit issue"}
          </button>
        </div>
      </form>
    </div>
  );
}

// ── Main view ─────────────────────────────────────────────────────────────────

export default function GitHubIssuesView() {
  const { user } = useAuth();
  const { currentProject, currentProjectId } = useProject();
  const [issues, setIssues] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);
  const [stateFilter, setStateFilter] = useState("open");
  const [selected, setSelected] = useState(null);
  const [showNew, setShowNew] = useState(false);

  const isEditor =
    user?.role === "admin" ||
    currentProject?.userRole === "editor" ||
    currentProject?.userRole === "manager";

  const load = useCallback(async () => {
    if (!currentProjectId || !currentProject?.github_repo) return;
    setLoading(true);
    setErr(null);
    try {
      const r = await api.getProjectIssues(currentProjectId, { state: stateFilter });
      setIssues(r.issues || []);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [currentProjectId, currentProject?.github_repo, stateFilter]);

  useEffect(() => {
    load();
    setSelected(null);
    setShowNew(false);
  }, [load]);

  if (!currentProject?.github_repo) {
    return (
      <div className="flex-1 grid place-items-center text-slate-500 text-sm select-none p-8 text-center">
        <div>
          <CircleDot size={32} className="mx-auto mb-3 opacity-30" />
          <p>This project is not linked to a GitHub repository.</p>
          <p className="text-xs mt-1 text-slate-600">
            Connect a repo in Project Settings to use GitHub Issues.
          </p>
        </div>
      </div>
    );
  }

  const [owner, repo] = currentProject.github_repo.split("/");

  return (
    <div className="flex-1 flex min-h-0 min-w-0">
      {/* Left pane — issue list */}
      <div
        className={`flex flex-col border-r border-ink-700 ${
          selected || showNew
            ? "hidden md:flex md:w-80 lg:w-96 shrink-0"
            : "flex-1 md:w-80 lg:w-96 md:flex-none md:shrink-0"
        }`}
      >
        {/* List header */}
        <div className="shrink-0 px-4 py-3 border-b border-ink-700 flex items-center gap-2">
          <CircleDot size={14} className="text-slate-400 shrink-0" />
          <span className="text-sm font-medium text-slate-200 truncate">
            {owner}/{repo}
          </span>
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={load}
              disabled={loading}
              className="btn-ghost p-1.5"
              title="Refresh"
            >
              <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
            </button>
            {isEditor && (
              <button
                type="button"
                onClick={() => {
                  setShowNew(true);
                  setSelected(null);
                }}
                className="btn-ghost p-1.5"
                title="New issue"
              >
                <Plus size={12} />
              </button>
            )}
          </div>
        </div>

        {/* State filter */}
        <div className="shrink-0 flex border-b border-ink-700/60">
          {["open", "closed", "all"].map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStateFilter(s)}
              className={`flex-1 py-2 text-xs font-medium transition border-b-2 ${
                stateFilter === s
                  ? "border-brand-500 text-brand-300"
                  : "border-transparent text-slate-500 hover:text-slate-300"
              }`}
            >
              {s.charAt(0).toUpperCase() + s.slice(1)}
            </button>
          ))}
        </div>

        {/* Issues */}
        <div className="flex-1 overflow-y-auto">
          {loading && <div className="p-4 text-sm text-slate-500">Loading…</div>}
          {err && (
            <div className="p-4 flex items-start gap-2 text-sm text-red-300">
              <AlertCircle size={14} className="shrink-0 mt-0.5" />
              {err}
            </div>
          )}
          {!loading && !err && issues.length === 0 && (
            <div className="p-6 text-sm text-slate-500 text-center">
              No {stateFilter === "all" ? "" : stateFilter} issues.
            </div>
          )}
          {issues.map((issue) => (
            <IssueListItem
              key={issue.id}
              issue={issue}
              selected={selected?.id === issue.id}
              onClick={() => {
                setSelected(issue);
                setShowNew(false);
              }}
            />
          ))}
        </div>
      </div>

      {/* Right pane — detail or new issue */}
      <div className="flex-1 flex flex-col min-h-0 min-w-0">
        {showNew ? (
          <NewIssueForm
            projectId={currentProjectId}
            onCreated={(issue) => {
              setShowNew(false);
              setStateFilter("open");
              load();
              setSelected(issue);
            }}
            onCancel={() => setShowNew(false)}
          />
        ) : selected ? (
          <IssueDetail
            key={selected.number}
            projectId={currentProjectId}
            issue={selected}
            isEditor={isEditor}
            onBack={() => setSelected(null)}
          />
        ) : (
          <div className="flex-1 grid place-items-center text-slate-600 text-sm select-none">
            Select an issue to view details
          </div>
        )}
      </div>
    </div>
  );
}
