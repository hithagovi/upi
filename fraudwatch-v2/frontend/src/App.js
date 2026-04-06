import { useState, useEffect, useCallback, useRef } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell, Legend
} from "recharts";

// ─────────────────────────────────────────────
// API HELPER — all calls go through proxy to backend
// ─────────────────────────────────────────────
const API = "/api";

async function apiFetch(path, options = {}) {
  const token = localStorage.getItem("fw_jwt");
  const isFormData = options.body instanceof FormData;
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      ...(isFormData ? {} : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || `HTTP ${res.status}`);
  }
  return res.json();
}

// ─────────────────────────────────────────────
// CSV PARSER (browser-side for instant heuristics)
// ─────────────────────────────────────────────
function parseCSV(text) {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.trim().split("\n").filter(l => l.trim());
  if (lines.length < 2) return [];
  const sep = lines[0].includes("\t") ? "\t" : ",";
  const headers = lines[0].split(sep).map(h => h.trim().replace(/^"|"$/g, "").trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(sep).map(v => v.trim().replace(/^"|"$/g, "").trim());
    if (vals.every(v => v === "")) continue;
    const row = { __id: i - 1 };
    headers.forEach((h, idx) => { row[h] = vals[idx] !== undefined ? vals[idx] : ""; });
    rows.push(row);
  }
  return rows;
}

// ─────────────────────────────────────────────
// HEURISTIC ENGINE (instant browser-side detection)
// ─────────────────────────────────────────────
const AMT_KEYS  = ["amount", "Amount", "AMOUNT", "transaction_amount", "Amount (INR)"];
const TYPE_KEYS = ["type", "Type", "transaction_type", "payment_type"];

function getVal(row, keys) {
  for (const k of keys) {
    const stripped = k.trim();
    if (row[stripped] !== undefined && row[stripped] !== "") return row[stripped];
  }
  return "";
}

function computeStats(rows) {
  const amounts = rows.map(r => parseFloat(getVal(r, AMT_KEYS)) || 0);
  const n   = amounts.length || 1;
  const avg = amounts.reduce((a, b) => a + b, 0) / n;
  const std = Math.sqrt(amounts.reduce((a, b) => a + Math.pow(b - avg, 2), 0) / n) || 1;
  return { avg, std };
}

function heuristicDetect(row, stats) {
  let score = 0;
  const flags = [];
  const amount = parseFloat(getVal(row, AMT_KEYS)) || 0;

  if (stats.std > 0) {
    const z = (amount - stats.avg) / stats.std;
    if (z > 3)        { score += 35; flags.push("Extremely high amount"); }
    else if (z > 2)   { score += 20; flags.push("Unusually high amount"); }
    else if (z > 1.5) { score += 10; flags.push("Above average amount"); }
  }
  if (amount > 4000)   { score += 10; flags.push("High value transaction"); }
  if (amount > 100000) { score += 15; flags.push("Amount > ₹1 Lakh"); }

  const type = getVal(row, TYPE_KEYS).toUpperCase();
  if (["TRANSFER","CASH_OUT","WITHDRAWAL"].includes(type)) { score += 15; flags.push("High-risk type: " + type); }

  const device = (row.device_type || row.device || "").toLowerCase();
  if (device === "mobile") { score += 5; flags.push("Mobile transaction"); }

  const ts = row.Timestamp || row.timestamp || row.time || "";
  if (ts.includes(" ")) {
    const hr = parseInt((ts.split(" ")[1] || "").split(":")[0]);
    if (!isNaN(hr)) {
      if (hr >= 0 && hr <= 5) { score += 25; flags.push("Late night (12AM-5AM)"); }
      else if (hr >= 22)      { score += 10; flags.push("Late evening"); }
    }
  }

  const loc = (row.location || row.Location || row.city || "").toUpperCase();
  if (["FL","NY","TX"].includes(loc)) { score += 5; flags.push("High-risk location: " + loc); }

  const oldBal = parseFloat(row.oldbalanceOrg || row.old_balance || 0) || 0;
  const newBal = parseFloat(row.newbalanceOrig || row.new_balance || 0) || 0;
  if (oldBal > 0 && newBal === 0 && amount > 0) { score += 25; flags.push("Account drained to zero"); }

  const labelKeys = ["is_fraud","isFraud","fraud","Class","label","Fraud","TARGET","target"];
  for (const k of labelKeys) {
    if (row[k] !== undefined && row[k] !== "") {
      if (parseInt(String(row[k]).trim()) === 1) { score = Math.max(score, 85); flags.unshift("Flagged in dataset"); }
      break;
    }
  }

  score = Math.min(score, 99);
  return {
    score,
    status: score >= 60 ? "Fraudulent" : score >= 30 ? "Suspicious" : "Safe",
    flags,
    amountINR: amount,
  };
}

// ─────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────
function formatINR(n) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(parseFloat(n) || 0);
}

// ─────────────────────────────────────────────
// ICONS
// ─────────────────────────────────────────────
const SZ  = { width: 20, height: 20, flexShrink: 0 };
const SZS = { width: 16, height: 16, flexShrink: 0 };
const Icons = {
  dashboard:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={SZ}><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>,
  transactions: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={SZ}><path d="M7 16V4m0 0L3 8m4-4 4 4M17 8v12m0 0 4-4m-4 4-4-4"/></svg>,
  analytics:    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={SZ}><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>,
  block:        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={SZ}><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>,
  upload:       <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={SZ}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>,
  alert:        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={SZ}><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
  shield:       <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={SZ}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
  logout:       <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={SZ}><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>,
  x:            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={SZS}><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>,
  cpu:          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={SZ}><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>,
  percent:      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={SZ}><line x1="19" y1="5" x2="5" y2="19"/><circle cx="6.5" cy="6.5" r="2.5"/><circle cx="17.5" cy="17.5" r="2.5"/></svg>,
  bell:         <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={SZ}><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>,
};

// ─────────────────────────────────────────────
// SMALL COMPONENTS
// ─────────────────────────────────────────────
function StatusBadge({ status }) {
  const map = {
    Fraudulent: "linear-gradient(135deg,#ef4444,#dc2626)",
    Suspicious:  "linear-gradient(135deg,#f59e0b,#d97706)",
    Safe:        "linear-gradient(135deg,#10b981,#059669)",
  };
  return <span style={{ background: map[status] || map.Safe, color: "#fff", padding: "3px 10px", borderRadius: 9999, fontSize: 12, fontWeight: 600 }}>{status}</span>;
}

function SourceBadge({ source }) {
  const isXgb = source === "xgboost";
  return <span style={{ background: isXgb ? "#ede9fe" : "#f1f5f9", color: isXgb ? "#7c3aed" : "#64748b", padding: "2px 8px", borderRadius: 6, fontSize: 11, fontWeight: 600 }}>{isXgb ? "XGBoost" : "Heuristic"}</span>;
}

function MetricCard({ icon, label, value, color, sub }) {
  const [hov, setHov] = useState(false);
  return (
    <div onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
      style={{ background: "#fff", borderRadius: 12, padding: 20, boxShadow: hov ? "0 12px 24px rgba(0,0,0,0.1)" : "0 1px 3px rgba(0,0,0,0.07)", transform: hov ? "translateY(-4px)" : "none", transition: "all 0.2s" }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
        <div style={{ width: 44, height: 44, background: color, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", flexShrink: 0 }}>{icon}</div>
        <div>
          <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 4 }}>{label}</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: "#1e293b" }}>{value}</div>
          {sub && <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>{sub}</div>}
        </div>
      </div>
    </div>
  );
}

function Toast({ msg, type }) {
  return (
    <div style={{ position: "fixed", top: 20, right: 20, zIndex: 9999, background: type === "error" ? "#fef2f2" : "#f0fdf4", border: `1px solid ${type === "error" ? "#fca5a5" : "#86efac"}`, color: type === "error" ? "#dc2626" : "#15803d", padding: "12px 20px", borderRadius: 10, fontWeight: 500, fontSize: 14, boxShadow: "0 8px 24px rgba(0,0,0,0.12)", maxWidth: 440 }}>
      {msg}
    </div>
  );
}

function ModelMetrics({ metrics }) {
  if (!metrics || Object.keys(metrics).length === 0) return null;
  const items = [
    { label: "Accuracy",  value: `${(metrics.accuracy  * 100).toFixed(1)}%`, color: "#10b981" },
    { label: "Precision", value: `${(metrics.precision * 100).toFixed(1)}%`, color: "#3b82f6" },
    { label: "Recall",    value: `${(metrics.recall    * 100).toFixed(1)}%`, color: "#f59e0b" },
    { label: "F1 Score",  value: `${(metrics.f1        * 100).toFixed(1)}%`, color: "#8b5cf6" },
    { label: "ROC-AUC",   value: `${(metrics.roc_auc   * 100).toFixed(1)}%`, color: "#06b6d4" },
  ];
  return (
    <div style={{ background: "linear-gradient(135deg,#667eea15,#764ba215)", border: "1px solid #667eea40", borderRadius: 12, padding: 20, marginBottom: 24 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
        {Icons.cpu}
        <span style={{ fontWeight: 700, color: "#1e293b", fontSize: 15 }}>XGBoost Model Metrics</span>
        <span style={{ background: "#667eea", color: "#fff", borderRadius: 6, padding: "2px 10px", fontSize: 12, fontWeight: 600, marginLeft: 4 }}>Trained</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 12 }}>
        {items.map(m => (
          <div key={m.label} style={{ background: "#fff", borderRadius: 8, padding: "12px 14px", textAlign: "center" }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: m.color }}>{m.value}</div>
            <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>{m.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// LOGIN
// ─────────────────────────────────────────────
function LoginPage({ onLogin }) {
  const [email, setEmail]       = useState("admin@fraudwatch.in");
  const [password, setPassword] = useState("admin123");
  const [error, setError]       = useState("");
  const [loading, setLoading]   = useState(false);
  const [mode, setMode]         = useState("login"); // login | register

  const submit = async () => {
    if (!email || !password) { setError("Fill all fields"); return; }
    setLoading(true); setError("");
    try {
      const res = await apiFetch(mode === "login" ? "/auth/login" : "/auth/register", {
        method: "POST",
        body: JSON.stringify(
          mode === "login"
            ? { email, password }
            : { email, password, name: email.split("@")[0] }
        ),
      });
      localStorage.setItem("fw_jwt", res.token);
      localStorage.setItem("fw_user", JSON.stringify(res.user));
      onLogin(res.user);
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  };

  return (
    <div style={{ minHeight: "100vh", background: "linear-gradient(135deg,#667eea,#764ba2)", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Inter',sans-serif" }}>
      <div style={{ background: "#fff", borderRadius: 16, padding: 40, width: 420, boxShadow: "0 25px 50px rgba(0,0,0,0.15)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 32 }}>
          <div style={{ width: 44, height: 44, background: "linear-gradient(135deg,#667eea,#764ba2)", borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>{Icons.shield}</div>
          <div><div style={{ fontWeight: 700, fontSize: 20 }}>FraudWatch</div><div style={{ fontSize: 12, color: "#94a3b8" }}>Detection System</div></div>
        </div>
        <h2 style={{ fontSize: 24, fontWeight: 700, marginBottom: 24 }}>{mode === "login" ? "Sign In" : "Create Account"}</h2>
        {error && <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", color: "#dc2626", padding: "10px 14px", borderRadius: 8, marginBottom: 16, fontSize: 14 }}>{error}</div>}
        <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
          {[
            ["Email", email, setEmail, "email", "email"],
            ["Password", password, setPassword, "password", mode === "login" ? "current-password" : "new-password"],
          ].map(([lbl, val, set, type, autoComplete]) => (
            <div key={lbl} style={{ marginBottom: 16 }}>
              <label style={{ display: "block", fontSize: 13, fontWeight: 500, marginBottom: 6 }}>{lbl}</label>
              <input
                type={type}
                value={val}
                autoComplete={autoComplete}
                onChange={e => set(e.target.value)}
                style={{ width: "100%", padding: "10px 14px", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 14, boxSizing: "border-box", outline: "none" }}
              />
            </div>
          ))}
          <button type="submit" disabled={loading}
            style={{ width: "100%", padding: 12, background: "linear-gradient(135deg,#667eea,#764ba2)", color: "#fff", border: "none", borderRadius: 8, fontWeight: 600, fontSize: 15, cursor: "pointer", marginTop: 8, opacity: loading ? 0.7 : 1 }}>
            {loading ? "Please wait..." : mode === "login" ? "Sign In" : "Register"}
          </button>
          <button type="button" onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }}
            style={{ width: "100%", padding: 10, background: "transparent", color: "#667eea", border: "1px solid #667eea40", borderRadius: 8, fontWeight: 500, fontSize: 14, cursor: "pointer", marginTop: 10 }}>
            {mode === "login" ? "Create new account" : "Back to Sign In"}
          </button>
        </form>
        <p style={{ textAlign: "center", marginTop: 14, fontSize: 12, color: "#94a3b8" }}>Default: admin@fraudwatch.in / admin123</p>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// LAYOUT
// ─────────────────────────────────────────────
function Layout({ user, page, setPage, onLogout, children }) {
  const nav = [
    { id: "dashboard",    label: "Dashboard",       icon: Icons.dashboard },
    { id: "transactions", label: "Transactions",     icon: Icons.transactions },
    { id: "analytics",   label: "Analytics",        icon: Icons.analytics },
    { id: "blocks",      label: "Block Management", icon: Icons.block },
  ];
  return (
    <div style={{ display: "flex", minHeight: "100vh", fontFamily: "'Inter',sans-serif", background: "#f1f5f9" }}>
      <div style={{ width: 260, background: "#fff", borderRight: "1px solid #e2e8f0", display: "flex", flexDirection: "column", position: "fixed", top: 0, left: 0, height: "100vh", zIndex: 100 }}>
        <div style={{ padding: "20px 20px 16px", borderBottom: "1px solid #e2e8f0" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 36, height: 36, background: "linear-gradient(135deg,#667eea,#764ba2)", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff" }}>{Icons.shield}</div>
            <div><div style={{ fontWeight: 700, fontSize: 16 }}>FraudWatch</div><div style={{ fontSize: 11, color: "#94a3b8" }}>Detection System</div></div>
          </div>
        </div>
        <nav style={{ flex: 1, padding: "12px" }}>
          {nav.map(item => (
            <button key={item.id} onClick={() => setPage(item.id)}
              style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 8, border: "none", cursor: "pointer", marginBottom: 4, background: page === item.id ? "linear-gradient(135deg,#667eea,#764ba2)" : "transparent", color: page === item.id ? "#fff" : "#64748b", fontWeight: page === item.id ? 600 : 400, fontSize: 14, textAlign: "left" }}>
              {item.icon}{item.label}
            </button>
          ))}
        </nav>
        <div style={{ padding: "16px 12px", borderTop: "1px solid #e2e8f0" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", marginBottom: 8 }}>
            <div style={{ width: 32, height: 32, background: "linear-gradient(135deg,#667eea,#764ba2)", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 13, fontWeight: 700 }}>{(user?.name || "U")[0].toUpperCase()}</div>
            <div><div style={{ fontSize: 13, fontWeight: 600 }}>{user?.name}</div><div style={{ fontSize: 11, color: "#94a3b8" }}>{user?.role}</div></div>
          </div>
          <button onClick={onLogout} style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", border: "none", borderRadius: 8, cursor: "pointer", background: "transparent", color: "#94a3b8", fontSize: 13 }}>
            {Icons.logout} Logout
          </button>
        </div>
      </div>
      <div style={{ marginLeft: 260, flex: 1 }}><div style={{ padding: 32 }}>{children}</div></div>
    </div>
  );
}

// ─────────────────────────────────────────────
// DASHBOARD
// ─────────────────────────────────────────────
function Dashboard({ transactions, onUpload, heuristicPct, datasetInfo, modelMetrics, mlStatus, blockedCount }) {
  const fileRef   = useRef();
  const fraud     = transactions.filter(t => t.__status === "Fraudulent");
  const suspicious= transactions.filter(t => t.__status === "Suspicious");
  const fraudAmt  = fraud.reduce((s, t) => s + (t.__amountINR || 0), 0);
  const rate      = transactions.length > 0 ? ((fraud.length / transactions.length) * 100).toFixed(1) : "0.0";
  const alerts    = [...fraud, ...suspicious].slice(0, 8);

  const mlLabel = {
    idle:      null,
    uploading: "⏫ Uploading to server...",
    training:  "🧠 Training XGBoost...",
    fetching:  "📥 Fetching predictions...",
    done:      "✅ XGBoost predictions applied",
    error:     "⚠️ Backend error — heuristics used",
  }[mlStatus];

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 24, fontWeight: 700, color: "#1e293b" }}>Dashboard</h1>
        <p style={{ color: "#64748b", fontSize: 14 }}>Welcome back! Here's your fraud detection overview.</p>
      </div>

      {/* Upload */}
      <div style={{ background: "#fff", borderRadius: 12, padding: 24, marginBottom: 24, boxShadow: "0 1px 3px rgba(0,0,0,0.07)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16, fontSize: 16, fontWeight: 600, color: "#1e293b" }}>
          {Icons.upload} Dataset Management
        </div>
        <div onClick={() => fileRef.current.click()}
          onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) onUpload(f); }}
          onDragOver={e => e.preventDefault()}
          style={{ border: "2px dashed #e2e8f0", borderRadius: 10, padding: 32, textAlign: "center", cursor: "pointer", marginBottom: 16 }}>
          <div style={{ fontSize: 28, color: "#94a3b8", marginBottom: 8 }}>↑</div>
          <div style={{ color: "#475569", fontWeight: 500 }}>Drag & drop a CSV file with is_fraud column, or click to select</div>
          <div style={{ color: "#94a3b8", fontSize: 13, marginTop: 4 }}>Any size · Any CSV with transaction data</div>
          <input ref={fileRef} type="file" accept=".csv,.tsv,.txt" style={{ display: "none" }}
            onChange={e => { if (e.target.files[0]) { onUpload(e.target.files[0]); e.target.value = ""; } }} />
        </div>

        {datasetInfo && (
          <div style={{ background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 8, padding: "14px 16px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 10 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ color: "#16a34a", fontSize: 20 }}>✓</span>
                <div>
                  <div style={{ fontWeight: 600, color: "#15803d" }}>{datasetInfo.name}</div>
                  <div style={{ fontSize: 13, color: "#16a34a" }}>{datasetInfo.rows.toLocaleString()} rows · {datasetInfo.cols} columns · Fraud col: <b>{datasetInfo.fraudCol}</b></div>
                </div>
              </div>
              {mlLabel && <span style={{ fontSize: 13, color: mlStatus === "error" ? "#d97706" : "#667eea", fontWeight: 500 }}>{mlLabel}</span>}
            </div>
            {heuristicPct > 0 && heuristicPct < 100 && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 12, color: "#64748b", marginBottom: 4 }}>Heuristic scan: {heuristicPct}%</div>
                <div style={{ background: "#e2e8f0", borderRadius: 999, height: 6 }}>
                  <div style={{ width: `${heuristicPct}%`, height: "100%", background: "#667eea", borderRadius: 999, transition: "width 0.2s" }} />
                </div>
              </div>
            )}
            {mlStatus === "training" && (
              <div style={{ marginTop: 8 }}>
                <div style={{ fontSize: 12, color: "#64748b", marginBottom: 4 }}>XGBoost training on server...</div>
                <div style={{ background: "#e2e8f0", borderRadius: 999, height: 6, overflow: "hidden" }}>
                  <div style={{ width: "100%", height: "100%", background: "linear-gradient(90deg,#667eea,#764ba2,#667eea)", backgroundSize: "200% 100%", animation: "shimmer 1.5s infinite", borderRadius: 999 }} />
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Model metrics */}
      {modelMetrics && <ModelMetrics metrics={modelMetrics} />}

      {/* Metric Cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 16, marginBottom: 24 }}>
        <MetricCard icon={Icons.transactions} label="Total Transactions" value={transactions.length.toLocaleString()} color="#3b82f6" />
        <MetricCard icon={Icons.alert}        label="Fraudulent"         value={fraud.length.toLocaleString()}         color="#ef4444" sub={formatINR(fraudAmt)} />
        <MetricCard icon={Icons.alert}        label="Suspicious"         value={suspicious.length.toLocaleString()}    color="#f59e0b" />
        <MetricCard icon={Icons.block}        label="Blocked Entities"   value={blockedCount || 0}                      color="#8b5cf6" />
        <MetricCard icon={Icons.percent}      label="Fraud Rate"         value={`${rate}%`}                            color="#10b981" />
      </div>

      {/* Recent Alerts */}
      <div style={{ background: "#fff", borderRadius: 12, padding: 24, boxShadow: "0 1px 3px rgba(0,0,0,0.07)" }}>
        <h3 style={{ fontWeight: 600, color: "#1e293b", marginBottom: 16 }}>Recent Alerts</h3>
        {alerts.length === 0 ? (
          <div style={{ textAlign: "center", color: "#94a3b8", padding: 40 }}>
            <div style={{ fontSize: 36, marginBottom: 10 }}>!</div>
            <div style={{ fontWeight: 500 }}>No alerts yet — upload a dataset to start</div>
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead><tr style={{ borderBottom: "1px solid #e2e8f0" }}>
              {["ID","Amount (INR)","Status","Source","Risk Score","Flags"].map(h => (
                <th key={h} style={{ textAlign: "left", padding: "8px 12px", color: "#94a3b8", fontWeight: 500, fontSize: 12 }}>{h}</th>
              ))}
            </tr></thead>
            <tbody>
              {alerts.map((t, i) => (
                <tr key={i} style={{ borderBottom: "1px solid #f1f5f9" }}>
                  <td style={{ padding: "10px 12px", fontFamily: "monospace", color: "#475569" }}>#{String((t.__id || 0) + 1).padStart(5, "0")}</td>
                  <td style={{ padding: "10px 12px", fontWeight: 600 }}>{formatINR(t.__amountINR)}</td>
                  <td style={{ padding: "10px 12px" }}><StatusBadge status={t.__status} /></td>
                  <td style={{ padding: "10px 12px" }}><SourceBadge source={t.__source} /></td>
                  <td style={{ padding: "10px 12px" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ flex: 1, background: "#e2e8f0", borderRadius: 999, height: 6 }}>
                        <div style={{ width: `${t.__score}%`, height: "100%", background: t.__status === "Fraudulent" ? "#ef4444" : "#f59e0b", borderRadius: 999 }} />
                      </div>
                      <span style={{ fontSize: 12, color: "#64748b", minWidth: 32 }}>{t.__score}%</span>
                    </div>
                  </td>
                  <td style={{ padding: "10px 12px", fontSize: 12, color: "#64748b" }}>{(t.__flags || []).slice(0, 2).join(", ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <style>{`@keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}`}</style>
    </div>
  );
}

// ─────────────────────────────────────────────
// TRANSACTIONS
// ─────────────────────────────────────────────
function Transactions({ transactions }) {
  const [filter, setFilter] = useState("All");
  const [search, setSearch] = useState("");
  const [page, setPage]     = useState(1);
  const PER = 25;

  const filtered = transactions.filter(t => {
    if (filter !== "All" && t.__status !== filter) return false;
    if (search && !JSON.stringify(t).toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });
  const pages   = Math.ceil(filtered.length / PER);
  const visible = filtered.slice((page - 1) * PER, page * PER);
  const userCols = transactions.length > 0
    ? Object.keys(transactions[0]).filter(k => !k.startsWith("__") && !k.startsWith("_") && k !== "dataset_id").slice(0, 4)
    : [];

  return (
    <div>
      <h1 style={{ fontSize: 24, fontWeight: 700, color: "#1e293b", marginBottom: 4 }}>Transactions</h1>
      <p style={{ color: "#64748b", fontSize: 14, marginBottom: 24 }}>Monitor and analyse all transactions</p>
      <div style={{ background: "#fff", borderRadius: 12, padding: 24, boxShadow: "0 1px 3px rgba(0,0,0,0.07)" }}>
        <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap", alignItems: "center" }}>
          <input value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} placeholder="Search transactions..."
            style={{ padding: "8px 14px", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 14, outline: "none", minWidth: 220 }} />
          {["All","Fraudulent","Suspicious","Safe"].map(f => (
            <button key={f} onClick={() => { setFilter(f); setPage(1); }}
              style={{ padding: "8px 16px", borderRadius: 8, border: filter === f ? "none" : "1px solid #e2e8f0", background: filter === f ? "linear-gradient(135deg,#667eea,#764ba2)" : "#fff", color: filter === f ? "#fff" : "#64748b", fontWeight: filter === f ? 600 : 400, cursor: "pointer", fontSize: 14 }}>
              {f}
            </button>
          ))}
          <span style={{ marginLeft: "auto", fontSize: 13, color: "#94a3b8" }}>{filtered.length.toLocaleString()} results</span>
        </div>

        {visible.length === 0 ? (
          <div style={{ textAlign: "center", padding: 48, color: "#94a3b8" }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>!</div>
            <div style={{ fontWeight: 500 }}>No transactions found</div>
            <div style={{ fontSize: 13, marginTop: 4 }}>Upload a CSV dataset to begin</div>
          </div>
        ) : (
          <>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                <thead><tr style={{ borderBottom: "1px solid #e2e8f0" }}>
                  {["ID","Amount (INR)",...userCols,"Status","Source","Risk %","Flags"].map(h => (
                    <th key={h} style={{ textAlign: "left", padding: "8px 12px", color: "#94a3b8", fontWeight: 500, fontSize: 12, whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {visible.map((t, i) => (
                    <tr key={i} style={{ borderBottom: "1px solid #f1f5f9", background: t.__status === "Fraudulent" ? "#fff5f5" : t.__status === "Suspicious" ? "#fffbeb" : "#fff" }}>
                      <td style={{ padding: "10px 12px", fontFamily: "monospace", color: "#475569" }}>#{String((t.__id || 0) + 1).padStart(5,"0")}</td>
                      <td style={{ padding: "10px 12px", fontWeight: 600 }}>{formatINR(t.__amountINR)}</td>
                      {userCols.map(k => <td key={k} style={{ padding: "10px 12px", color: "#475569", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t[k]}</td>)}
                      <td style={{ padding: "10px 12px" }}><StatusBadge status={t.__status} /></td>
                      <td style={{ padding: "10px 12px" }}><SourceBadge source={t.__source} /></td>
                      <td style={{ padding: "10px 12px", fontWeight: 600, color: t.__status === "Fraudulent" ? "#dc2626" : t.__status === "Suspicious" ? "#d97706" : "#16a34a" }}>{t.__score}%</td>
                      <td style={{ padding: "10px 12px", fontSize: 12, color: "#64748b", maxWidth: 200 }}>{(t.__flags || []).slice(0,2).join(", ") || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {pages > 1 && (
              <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 16, alignItems: "center" }}>
                <button onClick={() => setPage(p => Math.max(1, p-1))} disabled={page===1} style={{ padding: "6px 14px", borderRadius: 6, border: "1px solid #e2e8f0", cursor: page===1?"not-allowed":"pointer", background: "#fff" }}>←</button>
                <span style={{ fontSize: 14, color: "#64748b" }}>Page {page} of {pages}</span>
                <button onClick={() => setPage(p => Math.min(pages, p+1))} disabled={page===pages} style={{ padding: "6px 14px", borderRadius: 6, border: "1px solid #e2e8f0", cursor: page===pages?"not-allowed":"pointer", background: "#fff" }}>→</button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// ANALYTICS
// ─────────────────────────────────────────────
function Analytics({ transactions, modelMetrics }) {
  const fraud     = transactions.filter(t => t.__status === "Fraudulent");
  const suspicious= transactions.filter(t => t.__status === "Suspicious");
  const safe      = transactions.filter(t => t.__status === "Safe");
  const fraudAmt  = fraud.reduce((s, t) => s + (t.__amountINR || 0), 0);
  const xgbCount  = transactions.filter(t => t.__source === "xgboost").length;

  const pieData = [
    { name: "Fraudulent", value: fraud.length,     color: "#ef4444" },
    { name: "Suspicious", value: suspicious.length, color: "#f59e0b" },
    { name: "Safe",       value: safe.length,       color: "#10b981" },
  ].filter(d => d.value > 0);

  const srcData = [
    { name: "XGBoost",   value: xgbCount,                            color: "#667eea" },
    { name: "Heuristic", value: transactions.length - xgbCount,      color: "#94a3b8" },
  ].filter(d => d.value > 0);

  const buckets = { "< ₹1K":0, "₹1K-5K":0, "₹5K-25K":0, "₹25K-1L":0, "> ₹1L":0 };
  transactions.forEach(t => {
    const a = t.__amountINR || 0;
    if (a < 1000) buckets["< ₹1K"]++;
    else if (a < 5000) buckets["₹1K-5K"]++;
    else if (a < 25000) buckets["₹5K-25K"]++;
    else if (a < 100000) buckets["₹25K-1L"]++;
    else buckets["> ₹1L"]++;
  });
  const amtDist = Object.entries(buckets).map(([name, count]) => ({ name, count }));

  return (
    <div>
      <h1 style={{ fontSize: 24, fontWeight: 700, color: "#1e293b", marginBottom: 4 }}>Analytics</h1>
      <p style={{ color: "#64748b", fontSize: 14, marginBottom: 24 }}>Fraud insights — all amounts in ₹ INR</p>

      {modelMetrics && <ModelMetrics metrics={modelMetrics} />}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16, marginBottom: 24 }}>
        {[
          { label: "Total Fraud Value",  value: formatINR(fraudAmt), color: "#ef4444" },
          { label: "Avg Fraud Amount",   value: formatINR(fraud.length > 0 ? fraudAmt / fraud.length : 0), color: "#f59e0b" },
          { label: "Fraud Rate",         value: transactions.length > 0 ? `${((fraud.length/transactions.length)*100).toFixed(2)}%` : "0%", color: "#8b5cf6" },
          { label: "XGBoost Scored",     value: xgbCount.toLocaleString(), color: "#667eea" },
        ].map((c, i) => (
          <div key={i} style={{ background: "#fff", borderRadius: 12, padding: 20, boxShadow: "0 1px 3px rgba(0,0,0,0.07)" }}>
            <div style={{ fontSize: 13, color: "#94a3b8", marginBottom: 6 }}>{c.label}</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: c.color }}>{c.value}</div>
          </div>
        ))}
      </div>

      {transactions.length === 0 ? (
        <div style={{ background: "#fff", borderRadius: 12, padding: 48, textAlign: "center", color: "#94a3b8" }}>Upload a dataset to see analytics</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
          <div style={{ background: "#fff", borderRadius: 12, padding: 24, boxShadow: "0 1px 3px rgba(0,0,0,0.07)" }}>
            <h3 style={{ fontWeight: 600, marginBottom: 16 }}>Status Distribution</h3>
            <ResponsiveContainer width="100%" height={240}>
              <PieChart><Pie data={pieData} dataKey="value" cx="50%" cy="50%" outerRadius={85} label={({ name, percent }) => `${name} ${(percent*100).toFixed(0)}%`}>
                {pieData.map((e, i) => <Cell key={i} fill={e.color} />)}
              </Pie><Tooltip formatter={v => v.toLocaleString()} /><Legend /></PieChart>
            </ResponsiveContainer>
          </div>
          <div style={{ background: "#fff", borderRadius: 12, padding: 24, boxShadow: "0 1px 3px rgba(0,0,0,0.07)" }}>
            <h3 style={{ fontWeight: 600, marginBottom: 16 }}>Detection Source</h3>
            <ResponsiveContainer width="100%" height={240}>
              <PieChart><Pie data={srcData} dataKey="value" cx="50%" cy="50%" outerRadius={85} label={({ name, percent }) => `${name} ${(percent*100).toFixed(0)}%`}>
                {srcData.map((e, i) => <Cell key={i} fill={e.color} />)}
              </Pie><Tooltip formatter={v => v.toLocaleString()} /><Legend /></PieChart>
            </ResponsiveContainer>
          </div>
          <div style={{ background: "#fff", borderRadius: 12, padding: 24, boxShadow: "0 1px 3px rgba(0,0,0,0.07)", gridColumn: "1/-1" }}>
            <h3 style={{ fontWeight: 600, marginBottom: 16 }}>Amount Distribution (₹ INR)</h3>
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={amtDist}><CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" /><XAxis dataKey="name" tick={{ fontSize: 12 }} /><YAxis tick={{ fontSize: 12 }} /><Tooltip /><Bar dataKey="count" fill="#667eea" radius={[4,4,0,0]} /></BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// BLOCK MANAGEMENT — fully backend powered
// ─────────────────────────────────────────────
function BlockManagement({ transactions }) {
  const [blocked, setBlocked] = useState([]);
  const [input, setInput]     = useState("");
  const [loading, setLoading] = useState(false);

  // Load blocks from backend on mount
  useEffect(() => {
    apiFetch("/blocks").then(data => setBlocked(Array.isArray(data) ? data : [])).catch(() => {});
  }, []);

  const add = async (entity) => {
    if (!entity || blocked.includes(entity)) return;
    setLoading(true);
    try {
      const res = await apiFetch("/blocks", { method: "POST", body: JSON.stringify({ entity }) });
      setBlocked(res.blocked || []);
    } catch {}
    setLoading(false);
  };

  const remove = async (entity) => {
    setLoading(true);
    try {
      const res = await apiFetch(`/blocks/${encodeURIComponent(entity)}`, { method: "DELETE" });
      setBlocked(res.blocked || []);
    } catch {}
    setLoading(false);
  };

  const highRisk = transactions.filter(t => t.__status === "Fraudulent").slice(0, 10);

  return (
    <div>
      <h1 style={{ fontSize: 24, fontWeight: 700, color: "#1e293b", marginBottom: 4 }}>Block Management</h1>
      <p style={{ color: "#64748b", fontSize: 14, marginBottom: 24 }}>Manage blocked entities — saved to database</p>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        <div style={{ background: "#fff", borderRadius: 12, padding: 24, boxShadow: "0 1px 3px rgba(0,0,0,0.07)" }}>
          <h3 style={{ fontWeight: 600, marginBottom: 16 }}>Block an Entity</h3>
          <div style={{ display: "flex", gap: 10, marginBottom: 20 }}>
            <input value={input} onChange={e => setInput(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter" && input.trim()) { add(input.trim()); setInput(""); } }}
              placeholder="Account ID, UPI ID, phone..." style={{ flex: 1, padding: "10px 14px", border: "1px solid #e2e8f0", borderRadius: 8, fontSize: 14, outline: "none" }} />
            <button onClick={() => { if (input.trim()) { add(input.trim()); setInput(""); } }} disabled={loading}
              style={{ background: "linear-gradient(135deg,#667eea,#764ba2)", color: "#fff", border: "none", borderRadius: 8, padding: "10px 20px", fontWeight: 600, cursor: "pointer" }}>Block</button>
          </div>
          <h4 style={{ fontSize: 13, color: "#94a3b8", marginBottom: 10, fontWeight: 500 }}>HIGH RISK FROM DATASET</h4>
          {highRisk.length === 0
            ? <div style={{ color: "#94a3b8", fontSize: 14 }}>No high-risk entities yet — upload and analyse a dataset</div>
            : highRisk.map((t, i) => {
                const id = String(t["Sender Name"] || t["SenderUPI"] || t.sender_id || t.nameOrig || t.account || `TXN-${t.__id}`);
                const upi = t["SenderUPI"] || t.sender_upi || "";
                return (
                  <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 0", borderBottom: "1px solid #f1f5f9" }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 13, color: "#1e293b" }}>{id}</div>
                      {upi && <div style={{ fontSize: 11, color: "#94a3b8" }}>{upi}</div>}
                      <div style={{ fontSize: 12, color: "#ef4444" }}>Risk: {t.__score}% · {formatINR(t.__amountINR)} · <SourceBadge source={t.__source} /></div>
                    </div>
                    <button onClick={() => add(upi || id)}
                      style={{ background: "#fef2f2", color: "#dc2626", border: "1px solid #fca5a5", borderRadius: 6, padding: "4px 12px", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>Block</button>
                  </div>
                );
              })}
        </div>

        <div style={{ background: "#fff", borderRadius: 12, padding: 24, boxShadow: "0 1px 3px rgba(0,0,0,0.07)" }}>
          <h3 style={{ fontWeight: 600, marginBottom: 4 }}>
            Blocked Entities
            <span style={{ background: "#fef2f2", color: "#dc2626", borderRadius: 999, padding: "2px 10px", fontSize: 13, marginLeft: 8 }}>{blocked.length}</span>
          </h3>
          <p style={{ fontSize: 13, color: "#94a3b8", marginBottom: 16 }}>Saved to database — persists across sessions</p>
          {blocked.length === 0
            ? <div style={{ color: "#94a3b8", textAlign: "center", padding: 32 }}>No entities blocked yet</div>
            : blocked.map((b, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", background: "#fef2f2", borderRadius: 8, marginBottom: 8 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ color: "#dc2626" }}>{Icons.block}</span>
                  <span style={{ fontFamily: "monospace", fontSize: 13 }}>{b}</span>
                </div>
                <button onClick={() => remove(b)} disabled={loading} style={{ background: "none", border: "none", cursor: "pointer", color: "#94a3b8" }}>{Icons.x}</button>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────
export default function App() {
  const [user, setUser]               = useState(null);
  const [page, setPage]               = useState("dashboard");
  const [transactions, setTransactions] = useState([]);
  const [datasetInfo, setDatasetInfo]   = useState(null);
  const [modelMetrics, setModelMetrics] = useState(null);
  const [mlStatus, setMlStatus]         = useState("idle");
  const [heuristicPct, setHeuristicPct] = useState(0);
  const [toast, setToast]               = useState(null);
  const [blockedCount, setBlockedCount] = useState(0);
  const rawRowsRef                      = useRef([]);

  // Restore session
  useEffect(() => {
    try {
      const token = localStorage.getItem("fw_jwt");
      const u = localStorage.getItem("fw_user");
      if (u && token) setUser(JSON.parse(u));
    } catch {}
    try {
      const info = localStorage.getItem("fw_dataset_info");
      const txns = localStorage.getItem("fw_transactions");
      const mtx  = localStorage.getItem("fw_model_metrics");
      if (info) setDatasetInfo(JSON.parse(info));
      if (txns) setTransactions(JSON.parse(txns));
      if (mtx)  setModelMetrics(JSON.parse(mtx));
    } catch {}
  }, []);

  // Load blocked count (only when logged in and token exists)
  useEffect(() => {
    const token = localStorage.getItem("fw_jwt");
    if (!user || !token) { setBlockedCount(0); return; }
    apiFetch("/blocks").then(d => setBlockedCount(Array.isArray(d) ? d.length : 0)).catch(() => setBlockedCount(0));
  }, [user]);

  const showToast = (msg, type = "success") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 5000);
  };

  // ── Upload CSV ──
  const handleUpload = useCallback((file) => {
    setTransactions([]);
    setDatasetInfo(null);
    setModelMetrics(null);
    setMlStatus("idle");
    setHeuristicPct(0);
    rawRowsRef.current = [];
    localStorage.removeItem("fw_transactions");
    localStorage.removeItem("fw_dataset_info");
    localStorage.removeItem("fw_model_metrics");

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const rows = parseCSV(e.target.result);
        if (rows.length === 0) { showToast("Could not parse CSV", "error"); return; }

        const allKeys  = Object.keys(rows[0]).filter(k => !k.startsWith("__"));
        const fraudCol = ["is_fraud","isFraud","fraud","Class","label","Fraud","TARGET","target"]
          .find(k => allKeys.includes(k)) || "none";
        const knownFraud = fraudCol !== "none" ? rows.filter(r => String(r[fraudCol]).trim() === "1").length : 0;

        const info = { name: file.name, rows: rows.length, cols: allKeys.length, fraudCol, knownFraud };
        rawRowsRef.current = rows;
        setDatasetInfo(info);
        localStorage.setItem("fw_dataset_info", JSON.stringify(info));

        showToast(`✓ Loaded ${rows.length.toLocaleString()} rows · ${knownFraud > 0 ? knownFraud + " labelled fraud rows" : "no labels — heuristics only"}`);

        // Run heuristics instantly + upload to backend in parallel
        runHeuristics(rows);
        uploadToBackend(file);
      } catch (err) {
        showToast("Error: " + err.message, "error");
      }
    };
    reader.onerror = () => showToast("Failed to read file", "error");
    reader.readAsText(file);
  }, []);

  // ── Heuristic scan (instant, browser-side) ──
  const runHeuristics = (rows) => {
    const stats   = computeStats(rows);
    const results = [];
    const BATCH   = Math.max(50, Math.floor(rows.length / 40));
    let processed = 0;

    const run = () => {
      const end = Math.min(processed + BATCH, rows.length);
      for (let i = processed; i < end; i++) {
        const { score, status, flags, amountINR } = heuristicDetect(rows[i], stats);
        results.push({ ...rows[i], __id: i, __score: score, __status: status, __flags: flags, __amountINR: amountINR, __source: "heuristic" });
      }
      processed = end;
      setHeuristicPct(Math.round((processed / rows.length) * 100));
      if (processed < rows.length) {
        setTimeout(run, 0);
      } else {
        setTransactions(results);
        try { localStorage.setItem("fw_transactions", JSON.stringify(results.slice(0, 100000))); } catch {}
        const fc = results.filter(r => r.__status === "Fraudulent").length;
        showToast(`✓ Heuristic done: ${fc.toLocaleString()} fraudulent detected`);
      }
    };
    setTimeout(run, 50);
  };

  // ── Upload to backend + train XGBoost ──
  const uploadToBackend = async (file) => {
    setMlStatus("uploading");
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("fraud_column", "is_fraud");

      const dataset = await apiFetch("/datasets/upload", { method: "POST", body: formData });

      setMlStatus("training");
      const trainResult = await apiFetch(`/datasets/${dataset.id}/train`, { method: "POST" });

      if (trainResult.metrics && Object.keys(trainResult.metrics).length > 0) {
        setModelMetrics(trainResult.metrics);
        localStorage.setItem("fw_model_metrics", JSON.stringify(trainResult.metrics));
      }

      setMlStatus("fetching");
      await fetchFromBackend();

      setMlStatus("done");
      showToast(`🧠 XGBoost done! F1: ${((trainResult.metrics?.f1 || 0) * 100).toFixed(1)}% · AUC: ${((trainResult.metrics?.roc_auc || 0) * 100).toFixed(1)}%`);
    } catch (err) {
      setMlStatus("error");
      showToast("Backend training failed — showing heuristic results", "error");
    }
  };

  // ── Fetch all transactions from backend ──
  const fetchFromBackend = async () => {
    const allResults = [];
    let page = 1;
    const perPage = 500;

    while (true) {
      const data = await apiFetch(`/transactions?page=${page}&per_page=${perPage}`);
      if (!data.data || data.data.length === 0) break;

      const mapped = data.data.map(r => ({
        ...r,
        __id:       r.row_id !== undefined ? r.row_id : (r.__id || 0),
        __score:    r._score  || 0,
        __status:   r._status || "Safe",
        __flags:    r._flags  || [],
        __amountINR: r._amount_inr || parseFloat(r.Amount || r.amount || 0) || 0,
        __source:   r._source || "xgboost",
      }));

      allResults.push(...mapped);
      if (allResults.length >= data.total) break;
      page++;
    }

    if (allResults.length > 0) {
      setTransactions(allResults);
      try { localStorage.setItem("fw_transactions", JSON.stringify(allResults.slice(0, 100000))); } catch {}
    }
  };

  const handleLogin = (u) => {
    setUser(u);
    localStorage.setItem("fw_user", JSON.stringify(u));
  };

  const handleLogout = () => {
    localStorage.clear();
    setUser(null);
    setTransactions([]);
    setDatasetInfo(null);
    setModelMetrics(null);
    setBlockedCount(0);
    rawRowsRef.current = [];
  };

  if (!user) return <LoginPage onLogin={handleLogin} />;

  // Attach blocked count for display
  const txnsWithMeta = transactions;

  return (
    <div style={{ fontFamily: "'Inter',sans-serif" }}>
      <style>{`* { box-sizing:border-box; margin:0; padding:0; } button { font-family:inherit; }`}</style>
      {toast && <Toast msg={toast.msg} type={toast.type} />}
      <Layout user={user} page={page} setPage={setPage} onLogout={handleLogout}>
        {page === "dashboard"    && <Dashboard transactions={txnsWithMeta} onUpload={handleUpload} heuristicPct={heuristicPct} datasetInfo={datasetInfo} modelMetrics={modelMetrics} mlStatus={mlStatus} blockedCount={blockedCount} />}
        {page === "transactions" && <Transactions transactions={txnsWithMeta} />}
        {page === "analytics"   && <Analytics transactions={txnsWithMeta} modelMetrics={modelMetrics} />}
        {page === "blocks"      && <BlockManagement transactions={txnsWithMeta} />}
      </Layout>
    </div>
  );
}
