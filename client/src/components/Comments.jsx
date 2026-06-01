import { GitBranch, Pencil, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../App.jsx";
import { api, shortLabel } from "../lib/api.js";

// Google Docs–style threaded comments.
// `targetIri` is the entity being discussed; pass null for an ontology-wide thread.
// `projectGithubRepo` — if provided and the user has write:discussion scope, shows the
// "Post to GitHub Discussions" toggle on new root comments.
export default function Comments({ targetIri, title = "Discussion", projectGithubRepo }) {
  const { user, githubConnection } = useAuth();
  const canPostToGitHub =
    !!projectGithubRepo && !!githubConnection?.scope?.includes("write:discussion");

  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);
  const [newBody, setNewBody] = useState("");
  const [postToGitHub, setPostToGitHub] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await api.comments(targetIri);
      setComments(r.comments);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }, [targetIri]);

  useEffect(() => {
    load();
  }, [load]);

  const submit = async (e) => {
    e.preventDefault();
    if (!newBody.trim()) return;
    setBusy(true);
    try {
      await api.createComment({
        target_iri: targetIri || null,
        body: newBody,
        post_to_github: canPostToGitHub && postToGitHub,
      });
      setNewBody("");
      setPostToGitHub(false);
      await load();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const roots = comments.filter((c) => !c.parent_id);
  const repliesOf = (id) => comments.filter((c) => c.parent_id === id);

  return (
    <aside className="w-80 shrink-0 border-l border-ink-700 flex flex-col bg-ink-950/95">
      <header className="p-3 border-b border-ink-700 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold">{title}</div>
          <div className="text-[10px] tracking-wider text-slate-500 truncate">
            {targetIri ? shortLabel(targetIri) : "General discussion"}
          </div>
        </div>
        <button type="button" className="btn-ghost p-1 text-xs" onClick={load} title="Refresh">
          <RefreshCw size={14} aria-hidden="true" />
        </button>
      </header>
      <form onSubmit={submit} className="p-3 border-t border-ink-700 space-y-2 bg-ink-900/40">
        <textarea
          className="input min-h-15 text-sm"
          placeholder="Start a new thread…"
          value={newBody}
          onChange={(e) => setNewBody(e.target.value)}
        />
        <div className="flex items-center justify-between">
          {canPostToGitHub && (
            <label className="flex items-center gap-1.5 text-xs text-slate-400 cursor-pointer select-none">
              <input
                type="checkbox"
                className="rounded border-ink-600"
                checked={postToGitHub}
                onChange={(e) => setPostToGitHub(e.target.checked)}
              />
              <GitBranch size={11} aria-hidden="true" />
              Post to GitHub
            </label>
          )}
          <button
            type="submit"
            className="btn-primary text-xs ml-auto"
            disabled={busy || !newBody.trim()}
          >
            {busy ? "…" : "Comment"}
          </button>
        </div>
      </form>
      <hr className="border-ink-700" />
      <div className="flex-1 overflow-auto p-3 space-y-3">
        {loading && <div className="text-xs text-slate-500">Loading…</div>}
        {err && <div className="text-xs text-red-300">{err}</div>}
        {!loading && roots.length === 0 && (
          <div className="text-xs text-slate-500">No comments yet. Start the discussion above.</div>
        )}
        {roots.map((root) => (
          <Thread
            key={root.id}
            root={root}
            replies={repliesOf(root.id)}
            currentUser={user}
            onChanged={load}
          />
        ))}
      </div>
    </aside>
  );
}

export function Thread({ root, replies, currentUser, onChanged }) {
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyBody, setReplyBody] = useState("");
  const [busy, setBusy] = useState(false);

  const resolved = root.resolved === 1;

  const toggleResolved = async () => {
    await api.updateComment(root.id, { resolved: !resolved });
    onChanged();
  };

  const submitReply = async (e) => {
    e.preventDefault();
    if (!replyBody.trim()) return;
    setBusy(true);
    try {
      await api.createComment({ parent_id: root.id, body: replyBody });
      setReplyBody("");
      setReplyOpen(false);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={`rounded-md border ${
        resolved ? "border-ink-700/60 bg-ink-800/30 opacity-70" : "border-ink-600/60 bg-ink-800/60"
      }`}
    >
      <CommentRow c={root} currentUser={currentUser} onChanged={onChanged} />
      {replies.length > 0 && (
        <div className="pl-4 border-l border-ink-700 ml-3 space-y-1 pb-1">
          {replies.map((r) => (
            <CommentRow key={r.id} c={r} currentUser={currentUser} onChanged={onChanged} />
          ))}
        </div>
      )}
      <div className="px-3 py-2 flex items-center gap-2 text-xs border-t border-ink-700/50">
        <button
          type="button"
          className="text-brand-300 hover:underline"
          onClick={() => setReplyOpen((o) => !o)}
        >
          Reply
        </button>
        <button
          type="button"
          className={`hover:underline ${resolved ? "text-emerald-300" : "text-slate-400"}`}
          onClick={toggleResolved}
        >
          {resolved ? "Reopen" : "Resolve"}
        </button>
      </div>
      {replyOpen && (
        <form onSubmit={submitReply} className="px-3 pb-3 space-y-2">
          <textarea
            className="input min-h-12.5 text-sm"
            value={replyBody}
            onChange={(e) => setReplyBody(e.target.value)}
            placeholder="Reply…"
          />
          <div className="flex items-center justify-end gap-2">
            <button type="button" className="btn-ghost text-xs" onClick={() => setReplyOpen(false)}>
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary text-xs"
              disabled={busy || !replyBody.trim()}
            >
              {busy ? "…" : "Reply"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

function CommentRow({ c, currentUser, onChanged }) {
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(c.body);
  const canEdit = currentUser && (currentUser.id === c.user_id || currentUser.role === "admin");

  const save = async (e) => {
    e.preventDefault();
    await api.updateComment(c.id, { body });
    setEditing(false);
    onChanged();
  };
  const del = async () => {
    if (!confirm("Delete this comment?")) return;
    await api.deleteComment(c.id);
    onChanged();
  };

  return (
    <div className="px-3 py-2">
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-2">
          <div className="h-5 w-5 rounded-full bg-brand-600/50 grid place-items-center text-[10px] text-white">
            {(c.username || "?")[0]?.toUpperCase()}
          </div>
          <span className="font-medium text-slate-200">{c.username || "unknown"}</span>
          <span className="text-slate-500">{relativeTime(c.created_at)}</span>
          {c.github_discussion_id && (
            <span title="Synced with GitHub Discussions" className="text-slate-500">
              <GitBranch size={11} aria-hidden="true" />
            </span>
          )}
        </div>
        {canEdit && !editing && (
          <div className="flex gap-1 text-slate-500">
            <button
              type="button"
              className="hover:text-slate-200"
              onClick={() => setEditing(true)}
              title="Edit"
            >
              <Pencil size={12} aria-hidden="true" />
            </button>
            <button type="button" className="hover:text-rose-300" onClick={del} title="Delete">
              <Trash2 size={12} aria-hidden="true" />
            </button>
          </div>
        )}
      </div>
      {editing ? (
        <form onSubmit={save} className="mt-2 space-y-1">
          <textarea
            className="input min-h-12.5 text-sm"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
          <div className="flex justify-end gap-2 text-xs">
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setEditing(false);
                setBody(c.body);
              }}
            >
              Cancel
            </button>
            <button type="submit" className="btn-primary">
              Save
            </button>
          </div>
        </form>
      ) : (
        <div className="mt-1 text-sm text-slate-200 whitespace-pre-wrap">{c.body}</div>
      )}
    </div>
  );
}

function relativeTime(ts) {
  const diff = (Date.now() - ts) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d`;
  return new Date(ts).toLocaleDateString();
}
