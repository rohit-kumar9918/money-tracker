import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Legend
} from "recharts";

/* ---------------------------------------------------------
   Categories — the fixed taxonomy every item gets sorted into
--------------------------------------------------------- */
const CATEGORIES = [
  { key: "Food", label: "Food", color: "#5C7A4F", glyph: "01" },
  { key: "Travel", label: "Travel", color: "#3E6B8C", glyph: "02" },
  { key: "Clothing & Shoes", label: "Clothing & Shoes", color: "#7A5A9C", glyph: "03" },
  { key: "Transportation", label: "Transportation", color: "#B7792E", glyph: "04" },
  { key: "Beauty & Daily Use", label: "Beauty & Daily Use", color: "#B25878", glyph: "05" },
  { key: "Other", label: "Other", color: "#8A8578", glyph: "00" },
];
const catColor = (key) => (CATEGORIES.find((c) => c.key === key) || CATEGORIES[5]).color;

/* ---------------------------------------------------------
   Storage helpers (personal, per-user)
--------------------------------------------------------- */
const STORAGE_KEY = "invoices-data";

async function loadInvoices() {
  try {
    const res = await window.storage.get(STORAGE_KEY, false);
    return res ? JSON.parse(res.value) : [];
  } catch {
    return [];
  }
}
async function saveInvoices(invoices) {
  try {
    await window.storage.set(STORAGE_KEY, JSON.stringify(invoices), false);
  } catch (e) {
    console.error("storage save failed", e);
  }
}

/* ---------------------------------------------------------
   File -> base64
--------------------------------------------------------- */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(",")[1]);
    r.onerror = () => reject(new Error("Could not read file"));
    r.readAsDataURL(file);
  });
}

/* ---------------------------------------------------------
   Call Claude to read + categorize the invoice
--------------------------------------------------------- */
async function analyzeInvoice(file) {
  const base64 = await fileToBase64(file);
  const isPdf = file.type === "application/pdf";

  const contentBlock = isPdf
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } }
    : { type: "image", source: { type: "base64", media_type: file.type || "image/jpeg", data: base64 } };

  const systemPrompt = `You are an expert invoice and receipt reader. Read the attached invoice/receipt and extract every purchased line item.

For each item give:
- name: short (2-6 words)
- price: number only, the amount paid for that line item (no currency symbols)
- category: exactly one of these strings: "Food", "Travel", "Clothing & Shoes", "Transportation", "Beauty & Daily Use", "Other"

Category guide:
- Food: groceries, restaurants, snacks, beverages
- Travel: flights, hotels, trip bookings, tourism, sightseeing
- Clothing & Shoes: apparel, footwear, bags, accessories
- Transportation: cabs, fuel, parking, public transit, vehicle upkeep
- Beauty & Daily Use: cosmetics, skincare, haircare, toiletries, personal care, everyday household items
- Other: anything that doesn't clearly fit above

Also extract the store/vendor name and invoice date if visible (format YYYY-MM-DD, else null).

Respond with ONLY raw JSON, no markdown, no code fences, no commentary, exactly in this shape:
{"storeName": string|null, "date": string|null, "items": [{"name": string, "price": number, "category": string}]}`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      system: systemPrompt,
      messages: [
        {
          role: "user",
          content: [contentBlock, { type: "text", text: "Extract and categorize every line item from this invoice." }],
        },
      ],
    }),
  });

  if (!response.ok) throw new Error(`API error ${response.status}`);
  const data = await response.json();
  const text = (data.content || []).map((b) => (b.type === "text" ? b.text : "")).join("\n");
  const clean = text.replace(/```json|```/g, "").trim();
  const parsed = JSON.parse(clean);

  const items = (parsed.items || []).map((it, i) => ({
    id: `${Date.now()}-${i}`,
    name: it.name || "Unnamed item",
    price: Number(it.price) || 0,
    category: CATEGORIES.some((c) => c.key === it.category) ? it.category : "Other",
  }));

  return { storeName: parsed.storeName || null, date: parsed.date || null, items };
}

/* ---------------------------------------------------------
   Small utils
--------------------------------------------------------- */
const fmt = (n) => `Rs ${Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const monthKey = (dateStr) => (dateStr ? dateStr.slice(0, 7) : "unknown");
const monthLabel = (key) => {
  if (key === "unknown") return "Undated";
  const [y, m] = key.split("-");
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString("en-US", { month: "short", year: "numeric" });
};
function uid() {
  return Math.random().toString(36).slice(2, 10);
}

/* ---------------------------------------------------------
   Main App
--------------------------------------------------------- */
export default function App() {
  const [invoices, setInvoices] = useState([]);
  const [tab, setTab] = useState("upload");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [pending, setPending] = useState(null); // parsed invoice awaiting confirm
  const [pendingFileName, setPendingFileName] = useState("");
  const fileInputRef = useRef(null);

  useEffect(() => {
    loadInvoices().then((inv) => {
      setInvoices(inv);
      setLoaded(true);
    });
  }, []);

  const persist = (next) => {
    setInvoices(next);
    saveInvoices(next);
  };

  const handleFile = async (file) => {
    if (!file) return;
    const okType = ["application/pdf", "image/jpeg", "image/jpg", "image/png"].includes(file.type);
    if (!okType) {
      setError("Please upload a PDF, JPEG, or JPG file.");
      return;
    }
    setError(null);
    setBusy(true);
    setPending(null);
    try {
      const result = await analyzeInvoice(file);
      setPending(result);
      setPendingFileName(file.name);
    } catch (e) {
      console.error(e);
      setError("Couldn't read that invoice. Try a clearer scan/photo, or add items manually below.");
      setPending({ storeName: null, date: null, items: [] });
      setPendingFileName(file.name);
    } finally {
      setBusy(false);
    }
  };

  const confirmPending = () => {
    if (!pending || pending.items.length === 0) return;
    const total = pending.items.reduce((s, it) => s + it.price, 0);
    const record = {
      id: uid(),
      fileName: pendingFileName,
      storeName: pending.storeName,
      date: pending.date || new Date().toISOString().slice(0, 10),
      uploadedAt: new Date().toISOString(),
      items: pending.items,
      total,
    };
    persist([record, ...invoices]);
    setPending(null);
    setPendingFileName("");
    setTab("dashboard");
  };

  const discardPending = () => {
    setPending(null);
    setPendingFileName("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const updatePendingItem = (id, patch) => {
    setPending((p) => ({ ...p, items: p.items.map((it) => (it.id === id ? { ...it, ...patch } : it)) }));
  };
  const removePendingItem = (id) => {
    setPending((p) => ({ ...p, items: p.items.filter((it) => it.id !== id) }));
  };
  const addPendingItem = () => {
    setPending((p) => ({
      ...p,
      items: [...p.items, { id: uid(), name: "New item", price: 0, category: "Other" }],
    }));
  };

  const deleteInvoice = (id) => {
    persist(invoices.filter((inv) => inv.id !== id));
  };

  if (!loaded) {
    return (
      <div className="app-shell">
        <style>{globalCss}</style>
        <div className="boot">Opening the ledger…</div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <style>{globalCss}</style>

      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">₹</span>
          <div>
            <div className="brand-title">Ledgerline</div>
            <div className="brand-sub">receipts in, insight out</div>
          </div>
        </div>
        <nav className="tabs">
          {[
            ["upload", "Add invoice"],
            ["dashboard", "Analysis"],
            ["invoices", "All invoices"],
          ].map(([key, label]) => (
            <button
              key={key}
              className={"tab-btn" + (tab === key ? " active" : "")}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </nav>
      </header>

      <main className="app-main">
        {tab === "upload" && (
          <UploadTab
            busy={busy}
            error={error}
            pending={pending}
            pendingFileName={pendingFileName}
            fileInputRef={fileInputRef}
            onFile={handleFile}
            onConfirm={confirmPending}
            onDiscard={discardPending}
            onUpdateItem={updatePendingItem}
            onRemoveItem={removePendingItem}
            onAddItem={addPendingItem}
          />
        )}
        {tab === "dashboard" && <DashboardTab invoices={invoices} />}
        {tab === "invoices" && <InvoicesTab invoices={invoices} onDelete={deleteInvoice} />}
      </main>
    </div>
  );
}

/* ---------------------------------------------------------
   Upload tab
--------------------------------------------------------- */
function UploadTab({
  busy, error, pending, pendingFileName, fileInputRef,
  onFile, onConfirm, onDiscard, onUpdateItem, onRemoveItem, onAddItem,
}) {
  const [drag, setDrag] = useState(false);

  const total = pending ? pending.items.reduce((s, it) => s + Number(it.price || 0), 0) : 0;

  return (
    <div className="upload-grid">
      <div
        className={"dropzone" + (drag ? " drag" : "")}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          const f = e.dataTransfer.files?.[0];
          if (f) onFile(f);
        }}
        onClick={() => fileInputRef.current?.click()}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
          hidden
          onChange={(e) => onFile(e.target.files?.[0])}
        />
        <div className="dropzone-icon">🧾</div>
        <div className="dropzone-title">Drop an invoice, or click to choose one</div>
        <div className="dropzone-sub">PDF, JPG or PNG · read automatically and sorted into categories</div>
      </div>

      {busy && <div className="status-line">Reading invoice and sorting items…</div>}
      {error && <div className="status-line error">{error}</div>}

      {pending && (
        <div className="receipt-card">
          <div className="receipt-edge" />
          <div className="receipt-head">
            <div className="receipt-store">{pending.storeName || "Unknown store"}</div>
            <div className="receipt-meta">{pending.date || "no date detected"} · {pendingFileName}</div>
          </div>

          <div className="receipt-items">
            {pending.items.length === 0 && (
              <div className="receipt-empty">No items detected yet — add them by hand below.</div>
            )}
            {pending.items.map((it) => (
              <div className="receipt-row" key={it.id}>
                <input
                  className="ri-name"
                  value={it.name}
                  onChange={(e) => onUpdateItem(it.id, { name: e.target.value })}
                />
                <select
                  className="ri-cat"
                  style={{ color: catColor(it.category) }}
                  value={it.category}
                  onChange={(e) => onUpdateItem(it.id, { category: e.target.value })}
                >
                  {CATEGORIES.map((c) => (
                    <option key={c.key} value={c.key}>{c.label}</option>
                  ))}
                </select>
                <input
                  className="ri-price"
                  type="number"
                  value={it.price}
                  onChange={(e) => onUpdateItem(it.id, { price: Number(e.target.value) })}
                />
                <button className="ri-remove" onClick={() => onRemoveItem(it.id)} aria-label="Remove item">×</button>
              </div>
            ))}
          </div>

          <button className="add-item-btn" onClick={onAddItem}>+ add item</button>

          <div className="receipt-total">
            <span>Total</span>
            <span>{fmt(total)}</span>
          </div>

          <div className="receipt-actions">
            <button className="btn ghost" onClick={onDiscard}>Discard</button>
            <button className="btn primary" onClick={onConfirm} disabled={pending.items.length === 0}>
              Save to ledger
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------
   Dashboard / analysis tab
--------------------------------------------------------- */
function DashboardTab({ invoices }) {
  const allItems = useMemo(
    () => invoices.flatMap((inv) => inv.items.map((it) => ({ ...it, date: inv.date, storeName: inv.storeName }))),
    [invoices]
  );

  const months = useMemo(() => {
    const set = new Set(allItems.map((it) => monthKey(it.date)));
    return Array.from(set).sort().reverse();
  }, [allItems]);

  const [range, setRange] = useState("this"); // this | last | all | custom
  const [customMonth, setCustomMonth] = useState(months[0] || "unknown");

  useEffect(() => {
    if (months.length && !months.includes(customMonth)) setCustomMonth(months[0]);
  }, [months]); // eslint-disable-line

  const now = new Date();
  const thisMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const lastMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthKey = `${lastMonthDate.getFullYear()}-${String(lastMonthDate.getMonth() + 1).padStart(2, "0")}`;

  const activeMonthKey = range === "this" ? thisMonthKey : range === "last" ? lastMonthKey : range === "custom" ? customMonth : null;

  const filteredItems = useMemo(() => {
    if (range === "all") return allItems;
    return allItems.filter((it) => monthKey(it.date) === activeMonthKey);
  }, [allItems, range, activeMonthKey]);

  const total = filteredItems.reduce((s, it) => s + Number(it.price || 0), 0);

  const byCategory = useMemo(() => {
    const map = {};
    CATEGORIES.forEach((c) => (map[c.key] = 0));
    filteredItems.forEach((it) => (map[it.category] = (map[it.category] || 0) + Number(it.price || 0)));
    return CATEGORIES.map((c) => ({ name: c.label, key: c.key, value: map[c.key] || 0, color: c.color })).filter((d) => d.value > 0);
  }, [filteredItems]);

  const monthlyTrend = useMemo(() => {
    const map = {};
    allItems.forEach((it) => {
      const k = monthKey(it.date);
      map[k] = (map[k] || 0) + Number(it.price || 0);
    });
    return Object.entries(map)
      .filter(([k]) => k !== "unknown")
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-6)
      .map(([k, v]) => ({ month: monthLabel(k), total: v }));
  }, [allItems]);

  if (invoices.length === 0) {
    return <div className="empty-state">No invoices yet — add one under "Add invoice" and it'll show up here.</div>;
  }

  return (
    <div className="dash-grid">
      <div className="range-bar">
        <button className={"chip" + (range === "this" ? " on" : "")} onClick={() => setRange("this")}>This month</button>
        <button className={"chip" + (range === "last" ? " on" : "")} onClick={() => setRange("last")}>Last month</button>
        <button className={"chip" + (range === "custom" ? " on" : "")} onClick={() => setRange("custom")}>Pick a month</button>
        <button className={"chip" + (range === "all" ? " on" : "")} onClick={() => setRange("all")}>All time</button>
        {range === "custom" && (
          <select className="month-picker" value={customMonth} onChange={(e) => setCustomMonth(e.target.value)}>
            {months.map((m) => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
        )}
      </div>

      <div className="total-strip">
        <div className="total-label">
          {range === "this" && "Spent this month"}
          {range === "last" && "Spent last month"}
          {range === "custom" && `Spent in ${monthLabel(customMonth)}`}
          {range === "all" && "Spent all time"}
        </div>
        <div className="total-value">{fmt(total)}</div>
        <div className="total-sub">{filteredItems.length} item{filteredItems.length === 1 ? "" : "s"}</div>
      </div>

      <div className="chart-row">
        <div className="chart-card">
          <div className="chart-title">By category</div>
          {byCategory.length === 0 ? (
            <div className="chart-empty">Nothing recorded for this period.</div>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie data={byCategory} dataKey="value" nameKey="name" innerRadius={55} outerRadius={95} paddingAngle={2}>
                  {byCategory.map((d) => <Cell key={d.key} fill={d.color} />)}
                </Pie>
                <Tooltip formatter={(v) => fmt(v)} />
              </PieChart>
            </ResponsiveContainer>
          )}
          <div className="legend-list">
            {byCategory.map((d) => (
              <div className="legend-row" key={d.key}>
                <span className="legend-dot" style={{ background: d.color }} />
                <span className="legend-name">{d.name}</span>
                <span className="legend-val">{fmt(d.value)}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="chart-card">
          <div className="chart-title">Last 6 months</div>
          {monthlyTrend.length === 0 ? (
            <div className="chart-empty">Not enough dated invoices yet.</div>
          ) : (
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={monthlyTrend}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E4DFD3" />
                <XAxis dataKey="month" tick={{ fontSize: 12, fill: "#6B665A" }} />
                <YAxis tick={{ fontSize: 12, fill: "#6B665A" }} />
                <Tooltip formatter={(v) => fmt(v)} />
                <Bar dataKey="total" fill="#B23A2E" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------
   All invoices tab
--------------------------------------------------------- */
function InvoicesTab({ invoices, onDelete }) {
  if (invoices.length === 0) {
    return <div className="empty-state">Nothing saved yet. Upload your first invoice to get started.</div>;
  }
  return (
    <div className="invoice-list">
      {invoices.map((inv) => (
        <div className="invoice-card" key={inv.id}>
          <div className="invoice-card-head">
            <div>
              <div className="invoice-store">{inv.storeName || "Unknown store"}</div>
              <div className="invoice-meta">{inv.date} · {inv.fileName}</div>
            </div>
            <div className="invoice-total">{fmt(inv.total)}</div>
          </div>
          <div className="invoice-items">
            {inv.items.map((it) => (
              <div className="invoice-item-row" key={it.id}>
                <span className="dot" style={{ background: catColor(it.category) }} />
                <span className="ii-name">{it.name}</span>
                <span className="ii-cat">{it.category}</span>
                <span className="ii-price">{fmt(it.price)}</span>
              </div>
            ))}
          </div>
          <button className="delete-btn" onClick={() => onDelete(inv.id)}>Remove invoice</button>
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------
   Styles
--------------------------------------------------------- */
const globalCss = `
@import url('https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap');

:root{
  --paper:#FAF7F0;
  --paper-dim:#F1ECE0;
  --ink:#211F1B;
  --ink-soft:#6B665A;
  --line:#DDD6C4;
  --stamp:#B23A2E;
}
*{box-sizing:border-box;}
.app-shell{
  font-family:'IBM Plex Mono', monospace;
  background:var(--paper);
  color:var(--ink);
  min-height:100%;
  padding:0;
}
.boot{padding:48px;text-align:center;color:var(--ink-soft);}

.app-header{
  display:flex; align-items:center; justify-content:space-between;
  padding:20px 28px; border-bottom:1px solid var(--line);
  flex-wrap:wrap; gap:14px;
}
.brand{display:flex; align-items:center; gap:12px;}
.brand-mark{
  font-family:'Space Grotesk', sans-serif; font-weight:700; font-size:22px;
  width:38px; height:38px; display:flex; align-items:center; justify-content:center;
  background:var(--stamp); color:var(--paper); border-radius:3px;
}
.brand-title{font-family:'Space Grotesk', sans-serif; font-weight:700; font-size:19px; letter-spacing:.2px;}
.brand-sub{font-size:11px; color:var(--ink-soft); letter-spacing:.5px; text-transform:uppercase;}

.tabs{display:flex; gap:4px; background:var(--paper-dim); padding:4px; border-radius:8px;}
.tab-btn{
  border:none; background:transparent; padding:8px 14px; border-radius:6px;
  font-family:'Space Grotesk', sans-serif; font-weight:600; font-size:13px;
  color:var(--ink-soft); cursor:pointer;
}
.tab-btn.active{background:var(--paper); color:var(--ink); box-shadow:0 1px 2px rgba(0,0,0,.08);}

.app-main{padding:28px; max-width:960px; margin:0 auto;}

/* Upload */
.upload-grid{display:flex; flex-direction:column; gap:18px;}
.dropzone{
  border:2px dashed var(--line); border-radius:12px; padding:40px 20px;
  text-align:center; cursor:pointer; background:var(--paper-dim);
  transition:border-color .15s, background .15s;
}
.dropzone.drag{border-color:var(--stamp); background:#F5E6E1;}
.dropzone-icon{font-size:30px; margin-bottom:8px;}
.dropzone-title{font-family:'Space Grotesk', sans-serif; font-weight:600; font-size:15px;}
.dropzone-sub{font-size:12px; color:var(--ink-soft); margin-top:4px;}

.status-line{font-size:13px; color:var(--ink-soft); padding:4px 2px;}
.status-line.error{color:var(--stamp);}

.receipt-card{
  position:relative; background:var(--paper); border:1px solid var(--line);
  border-radius:10px; padding:22px 22px 18px; margin-top:6px;
}
.receipt-edge{
  position:absolute; top:-1px; left:0; right:0; height:8px;
  background-image:linear-gradient(135deg, var(--paper) 50%, transparent 50%),
                    linear-gradient(45deg, var(--paper) 50%, transparent 50%);
  background-size:14px 14px; background-position:top left; background-repeat:repeat-x;
  border-top:1px solid var(--line);
}
.receipt-head{margin-bottom:14px;}
.receipt-store{font-family:'Space Grotesk', sans-serif; font-weight:700; font-size:16px;}
.receipt-meta{font-size:11px; color:var(--ink-soft); margin-top:2px;}

.receipt-items{border-top:1px dashed var(--line); border-bottom:1px dashed var(--line); padding:10px 0;}
.receipt-empty{font-size:12px; color:var(--ink-soft); padding:8px 0;}
.receipt-row{display:grid; grid-template-columns:1fr 150px 90px 26px; gap:8px; align-items:center; padding:5px 0;}
.ri-name, .ri-cat, .ri-price{
  font-family:'IBM Plex Mono', monospace; font-size:13px; border:1px solid transparent;
  background:transparent; padding:5px 6px; border-radius:5px; color:var(--ink); width:100%;
}
.ri-name:hover, .ri-cat:hover, .ri-price:hover{border-color:var(--line);}
.ri-name:focus, .ri-cat:focus, .ri-price:focus{outline:none; border-color:var(--stamp); background:var(--paper-dim);}
.ri-price{text-align:right;}
.ri-remove{border:none; background:transparent; color:var(--ink-soft); font-size:16px; cursor:pointer;}
.ri-remove:hover{color:var(--stamp);}

.add-item-btn{
  margin-top:10px; border:1px dashed var(--line); background:transparent; color:var(--ink-soft);
  font-family:'IBM Plex Mono', monospace; font-size:12px; padding:6px 10px; border-radius:6px; cursor:pointer;
}
.add-item-btn:hover{border-color:var(--stamp); color:var(--stamp);}

.receipt-total{
  display:flex; justify-content:space-between; font-family:'Space Grotesk', sans-serif;
  font-weight:700; font-size:16px; padding-top:14px;
}
.receipt-actions{display:flex; gap:10px; justify-content:flex-end; margin-top:16px;}
.btn{
  font-family:'Space Grotesk', sans-serif; font-weight:600; font-size:13px;
  padding:9px 16px; border-radius:7px; cursor:pointer; border:1px solid transparent;
}
.btn.ghost{background:transparent; border-color:var(--line); color:var(--ink-soft);}
.btn.ghost:hover{border-color:var(--ink-soft); color:var(--ink);}
.btn.primary{background:var(--stamp); color:var(--paper);}
.btn.primary:hover{background:#98301F;}
.btn.primary:disabled{opacity:.4; cursor:not-allowed;}

/* Dashboard */
.dash-grid{display:flex; flex-direction:column; gap:20px;}
.range-bar{display:flex; gap:8px; flex-wrap:wrap; align-items:center;}
.chip{
  border:1px solid var(--line); background:var(--paper); color:var(--ink-soft);
  font-family:'Space Grotesk', sans-serif; font-weight:600; font-size:12px;
  padding:7px 12px; border-radius:20px; cursor:pointer;
}
.chip.on{background:var(--ink); color:var(--paper); border-color:var(--ink);}
.month-picker{
  font-family:'IBM Plex Mono', monospace; font-size:12px; padding:7px 10px;
  border-radius:20px; border:1px solid var(--line); background:var(--paper);
}

.total-strip{
  background:var(--ink); color:var(--paper); border-radius:12px; padding:22px 26px;
}
.total-label{font-size:11px; letter-spacing:.6px; text-transform:uppercase; opacity:.7;}
.total-value{font-family:'Space Grotesk', sans-serif; font-weight:700; font-size:34px; margin-top:4px;}
.total-sub{font-size:12px; opacity:.6; margin-top:2px;}

.chart-row{display:grid; grid-template-columns:1fr 1fr; gap:18px;}
@media (max-width:760px){ .chart-row{grid-template-columns:1fr;} .receipt-row{grid-template-columns:1fr 120px 76px 22px;} }
.chart-card{background:var(--paper); border:1px solid var(--line); border-radius:12px; padding:16px 18px;}
.chart-title{font-family:'Space Grotesk', sans-serif; font-weight:600; font-size:13px; margin-bottom:6px; color:var(--ink-soft); text-transform:uppercase; letter-spacing:.4px;}
.chart-empty{font-size:12px; color:var(--ink-soft); padding:30px 0; text-align:center;}
.legend-list{margin-top:6px;}
.legend-row{display:flex; align-items:center; gap:8px; font-size:12px; padding:4px 0;}
.legend-dot{width:9px; height:9px; border-radius:50%; display:inline-block;}
.legend-name{flex:1;}
.legend-val{color:var(--ink-soft);}

.empty-state{
  text-align:center; padding:60px 20px; color:var(--ink-soft); font-size:13px;
  border:1px dashed var(--line); border-radius:12px;
}

/* Invoice list */
.invoice-list{display:flex; flex-direction:column; gap:14px;}
.invoice-card{background:var(--paper); border:1px solid var(--line); border-radius:10px; padding:16px 18px;}
.invoice-card-head{display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:10px;}
.invoice-store{font-family:'Space Grotesk', sans-serif; font-weight:700; font-size:15px;}
.invoice-meta{font-size:11px; color:var(--ink-soft); margin-top:2px;}
.invoice-total{font-family:'Space Grotesk', sans-serif; font-weight:700; font-size:16px;}
.invoice-items{border-top:1px dashed var(--line); padding-top:8px;}
.invoice-item-row{display:grid; grid-template-columns:9px 1fr 150px 90px; gap:10px; align-items:center; font-size:12.5px; padding:4px 0;}
.dot{width:9px; height:9px; border-radius:50%;}
.ii-cat{color:var(--ink-soft);}
.ii-price{text-align:right;}
.delete-btn{
  margin-top:10px; border:none; background:transparent; color:var(--ink-soft);
  font-size:11px; text-decoration:underline; cursor:pointer; padding:0;
}
.delete-btn:hover{color:var(--stamp);}
`;
