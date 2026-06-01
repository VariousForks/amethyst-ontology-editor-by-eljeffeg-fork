import { ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../App.jsx";
import { api } from "../lib/api.js";
import { Field, Modal } from "./ClassesView.jsx";

export default function AdminView() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [tab, setTab] = useState("system");
  const [system, setSystem] = useState(null);
  const [systemErr, setSystemErr] = useState(null);
  const [users, setUsers] = useState([]);
  const [projects, setProjects] = useState([]);
  const [changes, setChanges] = useState([]);
  const [filterAction, setFilterAction] = useState("");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState(null);

  const loadSystem = useCallback(() => {
    setSystemErr(null);
    api
      .adminSystem()
      .then(setSystem)
      .catch((e) => setSystemErr(e.message));
    api
      .adminSystemStorage()
      .then(({ data_dir_bytes }) =>
        setSystem((prev) =>
          prev ? { ...prev, storage: { ...prev.storage, data_dir_bytes } } : prev,
        ),
      )
      .catch(() => {});
  }, []);
  const loadUsers = useCallback(() => {
    api
      .users()
      .then((r) => setUsers(r.users || []))
      .catch(() => {});
  }, []);
  const loadProjects = useCallback(() => {
    api
      .adminProjects()
      .then((r) => setProjects(r.projects || []))
      .catch(() => {});
  }, []);
  const loadChanges = useCallback(() => {
    api
      .adminChanges({ limit: 200, action: filterAction || undefined })
      .then((r) => setChanges(r.changes || []))
      .catch(() => {});
  }, [filterAction]);

  // Initial load when switching tabs.
  useEffect(() => {
    if (!isAdmin) return;
    if (tab === "system") loadSystem();
    if (tab === "users") loadUsers();
    if (tab === "projects") loadProjects();
    if (tab === "changes") loadChanges();
  }, [tab, isAdmin, loadSystem, loadUsers, loadProjects, loadChanges]);

  if (!isAdmin) {
    return (
      <div className="h-full grid place-items-center p-8">
        <div className="panel p-6 max-w-md text-center">
          <h2 className="text-base font-semibold mb-2">Administration</h2>
          <p className="text-sm text-slate-400">
            You need the <span className="text-brand-300 font-medium">admin</span> role to access
            this area. Ask an administrator to elevate your account.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="border-b border-ink-700 bg-ink-900/70 backdrop-blur-sm px-5 py-3 flex items-center gap-3">
        <div className="flex items-center gap-2">
          <ShieldCheck size={18} className="text-brand-300" aria-hidden="true" />
          <h1 className="text-base font-semibold">Administration</h1>
        </div>
        <div className="ml-4 flex items-center gap-1 p-0.5 bg-ink-800 rounded-md border border-ink-600/50">
          {[
            ["system", "System"],
            ["users", "Users"],
            ["projects", "All Projects"],
            ["changes", "Audit log"],
          ].map(([k, label]) => (
            <button
              type="button"
              key={k}
              onClick={() => setTab(k)}
              className={`px-3 py-1 text-xs rounded-sm ${tab === k ? "bg-brand-600 text-white" : "text-slate-300 hover:bg-ink-700"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {flash && (
        <div className="px-5 pt-3">
          <div className="panel px-3 py-2 text-sm text-brand-200 border-brand-500/40">{flash}</div>
        </div>
      )}

      <div className="flex-1 overflow-auto p-5 space-y-5">
        {tab === "system" && (
          <SystemPanel
            system={system}
            err={systemErr}
            onRefresh={loadSystem}
            onVacuum={async () => {
              setBusy(true);
              setFlash(null);
              try {
                await api.adminVacuum();
                setFlash("Database vacuumed.");
                loadSystem();
              } catch (e) {
                setFlash(`Vacuum failed: ${e.message}`);
              } finally {
                setBusy(false);
              }
            }}
            busy={busy}
          />
        )}
        {tab === "users" && (
          <UsersPanel users={users} currentUser={user} onChange={loadUsers} setFlash={setFlash} />
        )}
        {tab === "projects" && <ProjectsPanel projects={projects} onRefresh={loadProjects} />}
        {tab === "changes" && (
          <ChangesPanel
            changes={changes}
            filterAction={filterAction}
            setFilterAction={setFilterAction}
            onRefresh={loadChanges}
          />
        )}
      </div>
    </div>
  );
}

// ─── System ──────────────────────────────────────────────────────────────
function SystemPanel({ system, err, onRefresh, onVacuum, busy }) {
  if (err) return <div className="panel p-4 text-red-300">{err}</div>;
  if (!system) return <div className="text-slate-500 text-sm">Loading system info…</div>;
  const { server, storage, mail, counts } = system;

  return (
    <>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-400">Server</h2>
        <div className="flex gap-2">
          <button type="button" className="btn-ghost text-xs" onClick={onRefresh}>
            Refresh
          </button>
          <button
            type="button"
            className="btn text-xs"
            disabled={busy}
            onClick={onVacuum}
            title="Compact the SQLite database on disk."
          >
            {busy ? "Working…" : "Vacuum DB"}
          </button>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <Card title="Runtime">
          <KV k="Node" v={server.node} />
          <KV k="Env" v={server.env} mono />
          <KV k="Uptime" v={fmtUptime(server.uptime_s)} />
          <KV k="Platform" v={server.platform} mono />
          <KV k="Hostname" v={server.hostname} mono />
          <KV k="Load avg" v={server.load_avg.join("  ")} mono />
          <KV k="Memory RSS" v={`${server.memory_rss_mb} MB`} />
          <KV k="Heap used" v={`${server.memory_heap_mb} MB`} />
        </Card>

        <Card title="Storage">
          <KV k="Data dir" v={storage.data_dir} mono />
          <KV
            k="Disk used"
            v={storage.data_dir_bytes === null ? "Computing…" : fmtBytes(storage.data_dir_bytes)}
          />
          <div className="h-px bg-ink-700 my-2" />
          <KV k="Users" v={counts.users} />
          <KV k="Ontologies" v={counts.ontologies} />
          <KV k="Open invites" v={counts.invites} />
          <KV k="Comments" v={counts.comments} />
          <KV k="Audit events" v={counts.changes} />
        </Card>

        <Card title="Mail (SMTP)">
          <KV
            k="Configured"
            v={mail.configured ? "Yes" : "No"}
            tone={mail.configured ? "ok" : "warn"}
          />
          <KV k="Host" v={mail.host || "—"} mono />
          <KV k="Port" v={mail.port || "—"} mono />
          <KV k="From" v={mail.from || "—"} mono />
          {!mail.configured && (
            <div className="mt-2 text-xs text-amber-300/80">
              Invite emails will not be delivered. Set{" "}
              <code className="text-amber-200">SMTP_HOST</code>,
              <code className="text-amber-200"> SMTP_PORT</code>,
              <code className="text-amber-200"> SMTP_USER</code>,
              <code className="text-amber-200"> SMTP_PASS</code>, and{" "}
              <code className="text-amber-200"> SMTP_FROM </code>
              in the server environment.
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

// ─── Users ───────────────────────────────────────────────────────────────
function UsersPanel({ users, currentUser, onChange, setFlash }) {
  const [showNew, setShowNew] = useState(false);
  const [settings, setSettings] = useState(null);
  const [settingsBusy, setSettingsBusy] = useState(false);

  const loadSettings = useCallback(() => {
    api
      .adminGetSettings()
      .then((r) => setSettings(r.settings))
      .catch(() => {});
  }, []);
  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  const toggleRegistration = async () => {
    if (!settings) return;
    setSettingsBusy(true);
    try {
      const r = await api.adminUpdateSettings({
        registrationDisabled: !settings.registrationDisabled,
      });
      setSettings(r.settings);
      setFlash(`Self-registration ${r.settings.registrationDisabled ? "disabled" : "enabled"}.`);
    } catch (e) {
      setFlash(`Failed: ${e.message}`);
    } finally {
      setSettingsBusy(false);
    }
  };

  const changeRole = async (u, role) => {
    if (role === u.role) return;
    if (!confirm(`Change ${u.username}'s role from ${u.role} to ${role}?`)) return;
    try {
      await api.adminSetRole(u.id, role);
      setFlash(`Updated ${u.username} → ${role}.`);
      onChange();
    } catch (e) {
      setFlash(`Failed: ${e.message}`);
    }
  };
  const deleteUser = async (u) => {
    if (!confirm(`Delete ${u.username}? This cannot be undone.`)) return;
    try {
      await api.adminDeleteUser(u.id);
      setFlash(`Deleted ${u.username}.`);
      onChange();
    } catch (e) {
      setFlash(`Failed: ${e.message}`);
    }
  };

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
            <input
              type="checkbox"
              checked={settings ? !settings.registrationDisabled : true}
              disabled={!settings || settingsBusy}
              onChange={toggleRegistration}
              className="h-4 w-4 accent-brand-500"
            />
            <span>
              Allow self-registration
              <span className="ml-2 text-xs text-slate-500">
                {settings?.registrationDisabled
                  ? "disabled — admins must create users manually"
                  : "anyone can create an account from the sign-in page"}
              </span>
            </span>
          </label>
        </div>
        <button type="button" className="btn-primary text-xs" onClick={() => setShowNew(true)}>
          + Add user
        </button>
      </div>

      <div className="panel">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wider text-slate-500">
            <tr>
              <th className="text-left px-4 py-2">Username</th>
              <th className="text-left px-4 py-2">Email</th>
              <th className="text-left px-4 py-2">Role</th>
              <th className="text-left px-4 py-2">Created</th>
              <th className="text-left px-4 py-2">Last Active</th>
              <th className="text-right px-4 py-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-700">
            {users.map((u) => (
              <tr key={u.id}>
                <td className="px-4 py-2 font-medium">
                  {u.username}
                  {u.id === currentUser?.id && (
                    <span className="ml-1 text-[10px] text-brand-300">(you)</span>
                  )}
                </td>
                <td className="px-4 py-2 text-slate-400 font-mono text-xs">{u.email || "—"}</td>
                <td className="px-4 py-2">
                  <select
                    className="input py-0.5 px-2 text-xs w-28"
                    value={u.role}
                    disabled={u.id === currentUser?.id}
                    onChange={(e) => changeRole(u, e.target.value)}
                  >
                    <option value="admin">admin</option>
                    <option value="user">user</option>
                  </select>
                </td>
                <td className="px-4 py-2 text-xs text-slate-400">{fmtDate(u.created_at)}</td>
                <td className="px-4 py-2 text-xs text-slate-400">
                  {u.last_active_at ? (
                    fmtDate(u.last_active_at)
                  ) : (
                    <span className="text-slate-600">Never</span>
                  )}
                </td>
                <td className="px-4 py-2 text-right">
                  <button
                    type="button"
                    className="btn-danger text-xs py-0.5 px-2"
                    disabled={u.id === currentUser?.id}
                    onClick={() => deleteUser(u)}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
            {!users.length && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-500 text-xs">
                  No users.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {showNew && (
        <NewUserModal
          onClose={() => setShowNew(false)}
          onCreated={(u) => {
            setShowNew(false);
            setFlash(`Created ${u.username}.`);
            onChange();
          }}
        />
      )}
    </>
  );
}

function NewUserModal({ onClose, onCreated }) {
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("user");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await api.adminCreateUser({
        username: username.trim(),
        email: email.trim() || undefined,
        password,
        role,
      });
      onCreated(r.user);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Add user" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3">
        <Field label="Username">
          <input
            className="input"
            value={username}
            required
            onChange={(e) => setUsername(e.target.value)}
          />
        </Field>
        <Field label="Email (optional)">
          <input
            className="input"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Temporary password">
          <input
            className="input"
            type="text"
            value={password}
            required
            minLength={6}
            onChange={(e) => setPassword(e.target.value)}
          />
          <div className="text-xs text-slate-500 mt-1">
            Share this with the user. They can change it from Settings once signed in.
          </div>
        </Field>
        <Field label="Role">
          <select className="input" value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="user">user</option>
            <option value="admin">admin</option>
          </select>
        </Field>
        {err && <div className="text-sm text-red-300">{err}</div>}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn-primary" disabled={busy}>
            {busy ? "…" : "Create user"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ─── All Projects ────────────────────────────────────────────────────────
function ProjectsPanel({ projects, onRefresh }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <button type="button" className="btn-ghost text-xs" onClick={onRefresh}>
          Refresh
        </button>
        <span className="text-xs text-slate-500 ml-auto">{projects.length} project(s)</span>
      </div>
      <div className="panel">
        <table className="w-full text-sm">
          <thead className="text-xs uppercase tracking-wider text-slate-500">
            <tr>
              <th className="text-left px-4 py-2">Name</th>
              <th className="text-left px-4 py-2">Description</th>
              <th className="text-left px-4 py-2">Created by</th>
              <th className="text-left px-4 py-2">Created</th>
              <th className="text-right px-4 py-2">Ontologies</th>
              <th className="text-right px-4 py-2">Members</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-700">
            {projects.map((p) => (
              <tr key={p.id}>
                <td className="px-4 py-2 font-medium">{p.name}</td>
                <td className="px-4 py-2 text-slate-400 text-xs">
                  {p.description || <span className="text-slate-600">—</span>}
                </td>
                <td className="px-4 py-2 text-slate-400 text-xs">
                  {p.created_by_username || <span className="text-slate-600">—</span>}
                </td>
                <td className="px-4 py-2 text-xs text-slate-400">{fmtDate(p.created_at)}</td>
                <td className="px-4 py-2 text-right text-xs">{p.ontology_count}</td>
                <td className="px-4 py-2 text-right text-xs">{p.member_count}</td>
              </tr>
            ))}
            {!projects.length && (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-slate-500 text-xs">
                  No projects.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Audit log ───────────────────────────────────────────────────────────
function ChangesPanel({ changes, filterAction, setFilterAction, onRefresh }) {
  const actions = Array.from(new Set(changes.map((c) => c.action))).sort();
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-400">Filter by action:</span>
        <select
          className="input py-1 px-2 text-xs w-52"
          value={filterAction}
          onChange={(e) => setFilterAction(e.target.value)}
        >
          <option value="">(all)</option>
          {actions.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <button type="button" className="btn-ghost text-xs" onClick={onRefresh}>
          Refresh
        </button>
        <span className="text-xs text-slate-500 ml-auto">{changes.length} event(s)</span>
      </div>

      <div className="panel">
        <table className="w-full text-xs">
          <thead className="text-[10px] uppercase tracking-wider text-slate-500">
            <tr>
              <th className="text-left px-3 py-2 w-44">When</th>
              <th className="text-left px-3 py-2 w-32">User</th>
              <th className="text-left px-3 py-2 w-40">Ontology</th>
              <th className="text-left px-3 py-2 w-44">Action</th>
              <th className="text-left px-3 py-2">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-ink-700 font-mono">
            {changes.map((c) => (
              <tr key={c.id}>
                <td className="px-3 py-1.5 text-slate-400">{fmtDate(c.created_at)}</td>
                <td className="px-3 py-1.5">
                  {c.username || <span className="text-slate-600">system</span>}
                </td>
                <td className="px-3 py-1.5 text-slate-400">
                  {c.ontology_name || <span className="text-slate-600">—</span>}
                </td>
                <td className="px-3 py-1.5 text-brand-200">{c.action}</td>
                <td className="px-3 py-1.5 text-slate-500 whitespace-pre-wrap break-all">
                  {truncateJson(c.details)}
                </td>
              </tr>
            ))}
            {!changes.length && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-slate-500">
                  No events.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── helpers ─────────────────────────────────────────────────────────────
function Card({ title, children }) {
  return (
    <div className="panel p-4">
      <div className="text-xs uppercase tracking-wider text-slate-500 mb-3">{title}</div>
      <div className="space-y-1.5 text-sm">{children}</div>
    </div>
  );
}

function KV({ k, v, mono, tone }) {
  const toneCls =
    tone === "ok" ? "text-emerald-300" : tone === "warn" ? "text-amber-300" : "text-slate-100";
  return (
    <div className="flex items-baseline gap-2">
      <span className="w-32 shrink-0 text-slate-400 text-xs">{k}</span>
      <span className={`flex-1 ${toneCls} ${mono ? "font-mono text-xs break-all" : ""}`}>{v}</span>
    </div>
  );
}

function fmtBytes(n) {
  if (!n && n !== 0) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

function fmtUptime(s) {
  if (!s) return "0s";
  const d = Math.floor(s / 86400);
  s %= 86400;
  const h = Math.floor(s / 3600);
  s %= 3600;
  const m = Math.floor(s / 60);
  s = s % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(" ");
}

function fmtDate(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  return d.toLocaleString();
}

function truncateJson(raw) {
  if (!raw) return "";
  let s = raw;
  try {
    const parsed = JSON.parse(raw);
    s = JSON.stringify(parsed);
  } catch {
    /* already a plain string */
  }
  return s.length > 140 ? `${s.slice(0, 140)}…` : s;
}
