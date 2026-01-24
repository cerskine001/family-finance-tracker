// FinanceTracker.jsx
import { supabase } from "./supabaseClient";
import React, { useState, useMemo, useEffect, useCallback, useRef } from "react";
import {
  PlusCircle,
  Trash2,
  DollarSign,
  TrendingUp,
  TrendingDown,
  Wallet,
  Pencil,
  Check,
  X,
} from "lucide-react";

import {
  NetWorthChart,
  IncomeExpensesChart,
  CategoryDonutChart,
  MonthlySpendingChart,
  AssetsLiabilitiesChart,
} from "./components/Charts";

import {
  startOfMonth,
  endOfMonth,
  subMonths,
  startOfYear,
  endOfYear,
  parseISO,
  isWithinInterval,
  format,
} from "date-fns";

// NOTE: We use an in-file importer (SmartTransactionImport) so we can support
// multiple bank/CC CSV formats with a preview + mapping step.
import AuthModal from "./components/AuthModal";
import HouseholdGate from "./components/HouseholdGate";
import InviteMember from "./components/InviteMember";
import { startEditBudget as startEditBudgetHelper, cancelEditBudget as cancelEditBudgetHelper, saveEditBudget as saveEditBudgetHelper } from "./helpers/budgetHelpers";
import {
  startEditLiabilityHelper,
  cancelEditLiabilityHelper,
  saveEditLiabilityHelper,
} from "./helpers/liabilityHelpers";
import {
  startEditAssetHelper,
  cancelEditAssetHelper,
  saveEditAssetHelper,
} from "./helpers/assetHelpers";
import { ArrowLeftRight } from "lucide-react";

// -----------------------------------------------------------------------------
// Simple storage helper
// -----------------------------------------------------------------------------
const getStorage = () => {
  if (typeof window === "undefined") return null;

  if (window.storage) {
    return window.storage;
  }

  return {
    get: async (key) => ({
      value: window.localStorage.getItem(key),
    }),
    set: async (key, value) => {
      window.localStorage.setItem(key, value);
    },
    delete: async (key) => {
      window.localStorage.removeItem(key);
    },
  };
};

const storage = getStorage();

// ---------------------------------------------------------------------------
// CSV helpers
// ---------------------------------------------------------------------------
const toCsvValue = (value) => {
  if (value === null || value === undefined) return "";
  const str = String(value);
  if (str.includes('"') || str.includes(",") || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

const buildTransactionsCsv = (rows) => {
  // Backward compatible: first 6 columns match the original app.
  // New columns are appended.
  const header = [
    "Date",
    "Description",
    "Amount",
    "Type", // income | expense
    "Category",
    "Person",
    "Account",
    "TransactionType", // normal | transfer
    "TransferAccount",
  ];

  const lines = rows.map((t) => [
    t.date,
    t.description || "",
    t.amount,
    t.type,
    t.category || "",
    t.person || "joint",
    // These are denormalized for export convenience.
    t.account_name || "",
    t.transaction_type || "normal",
    t.transfer_account_name || "",
  ]);

  const csvLines = [
    header.map(toCsvValue).join(","),
    ...lines.map((row) => row.map(toCsvValue).join(",")),
  ];

  return csvLines.join("\r\n");
};

// ---------------------------------------------------------------------------
// Smart CSV Import (multi-profile + preview mapping + basic transfer detection)
// ---------------------------------------------------------------------------
const parseCsv = (text) => {
  // Small, dependency-free CSV parser (handles quotes, commas, CRLF).
  const rows = [];
  let i = 0;
  let field = "";
  let row = [];
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    // Ignore empty trailing rows
    if (row.length === 1 && row[0] === "") {
      row = [];
      return;
    }
    rows.push(row);
    row = [];
  };

  while (i < text.length) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        const next = text[i + 1];
        if (next === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }

    if (c === ",") {
      pushField();
      i += 1;
      continue;
    }

    if (c === "\n") {
      pushField();
      pushRow();
      i += 1;
      continue;
    }

    if (c === "\r") {
      // CRLF
      if (text[i + 1] === "\n") {
        pushField();
        pushRow();
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }

    field += c;
    i += 1;
  }

  // last field/row
  pushField();
  pushRow();
  return rows;
};

const normalizeMoney = (v) => {
  if (v == null) return 0;
  const s = String(v)
    .replace(/\$/g, "")
    .replace(/,/g, "")
    .replace(/\((.*)\)/, "-$1")
    .trim();
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};

const tryParseDate = (v) => {
  if (!v) return "";
  const s = String(v).trim();
  // Already ISO
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // MM/DD/YYYY
  const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (mdy) {
    const mm = String(mdy[1]).padStart(2, "0");
    const dd = String(mdy[2]).padStart(2, "0");
    const yyyy = String(mdy[3]).length === 2 ? `20${mdy[3]}` : String(mdy[3]);
    return `${yyyy}-${mm}-${dd}`;
  }

  // Fallback: Date() parse
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return d.toISOString().slice(0, 10);
  }
  return "";
};

const PAYMENT_KEYWORDS = [
  "PAYMENT",
  "AUTOPAY",
  "BOA",
  "THANK YOU",
  "ONLINE PAYMENT",
  "MOBILE PAYMENT",
  "E-PAYMENT",
  "EPAYMENT",
  "E PAYMENT",
  "CC PAYMENT",
  "CREDIT CARD",
  "CARD PAYMENT",
  "GSBANKPAYMENT",
  "APPLECARD",
  "VISA PAYMENT",
  "MASTERCARD PAYMENT",
  "DISCOVER E-PAYMENT",
  "AMERICANEXPRESS",
  "CAPITAL ONE",
  "CAPITALONE",
  "LOAN PAYMENT",
  "TRANSFER",
];

const NOT_PAYMENT_KEYWORDS = [
  "PAYMENTUS",        // merchant names
  "PAYMENT SERVICE",
];

const looksLikeUtility = (desc="") => {
  const d = desc.toUpperCase();
  return [
    "WASHINGTON GAS",
    "PEPCO",
    "BGE",
    "VERIZON",
    "COMCAST",
    "XFINITY",
    "AT&T",
    "T-MOBILE",
    "T MOBILE",
  ].some(k => d.includes(k));
};
const looksLikePayment = (desc = "") => {
  const d = String(desc || "").toUpperCase();
  if (NOT_PAYMENT_KEYWORDS.some((k) => d.includes(k))) return false;
  return PAYMENT_KEYWORDS.some((k) => d.includes(k));
};

const looksLikeFeeOrInterest = (desc = "") => {
  const d = String(desc || "").toUpperCase();
  return d.includes("INTEREST") || d.includes("FEE");
};

// --------------------------------------------------------------
// parse Month
// --------------------------------------------------------------
const parseMonthKey = (monthKey) => {
  // monthKey like "2026-01"
  const [y, m] = String(monthKey).split("-").map(Number);
  return { year: y, monthIndex: m - 1 }; // JS Date month is 0-based
};

const daysInMonth = (year, monthIndex) => {
  // day 0 of next month = last day of month
  return new Date(year, monthIndex + 1, 0).getDate();
};

const isSameMonth = (a, b) =>
  a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();

const pacingHintForMonth = ({
  monthKey,
  effectiveBudget,
  spent,
  tolerance = 0.07,
}) => {
  const budget = Number(effectiveBudget || 0);
  const spentNum = Number(spent || 0);

  if (budget <= 0) return null; // no pacing hint if no budget

  const now = new Date();
  const { year, monthIndex } = parseMonthKey(monthKey);
  const viewStart = new Date(year, monthIndex, 1);
  const dim = daysInMonth(year, monthIndex);

  // If viewing a past/future month, keep it simple and accurate
  if (!isSameMonth(now, viewStart)) {
    const isPast =
      year < now.getFullYear() ||
      (year === now.getFullYear() && monthIndex < now.getMonth());
    const isFuture =
      year > now.getFullYear() ||
      (year === now.getFullYear() && monthIndex > now.getMonth());

    if (isPast) {
      return {
        text: `Month complete · ${spentNum <= budget ? "Within budget" : "Over budget"}`,
        status: spentNum <= budget ? "ahead" : "behind",
      };
    }

    if (isFuture) {
      return { text: "Month hasn’t started yet", status: "neutral" };
    }
  }

  // Current month pacing
  const day = Math.min(dim, Math.max(1, now.getDate()));
  const elapsedRatio = day / dim;

  const expected = budget * elapsedRatio;

  const low = expected * (1 - tolerance);
  const high = expected * (1 + tolerance);

  let status = "pace";
  if (spentNum < low) status = "ahead";
  else if (spentNum > high) status = "behind";

  const label = status === "ahead" ? "Ahead" : status === "behind" ? "Behind" : "On pace";

return {
  day,
  dim,
  status,
  label,
  expected,
};

};

//   ---------------------------------------
//   Payments Helpers
//   ---------------------------------------

const normalizeImportedRow = (r, acctById, selectedPerson) => {
  const amountNum = Number(r.amount || 0);
  const person = r.person || selectedPerson || "joint";

  const acct = r.account_id != null ? acctById.get(Number(r.account_id)) : null;
  const isCredit = acct?.account_type === "credit";

  // Trust explicit transfer rows coming from the importer
  if (r.transaction_type === "transfer") {
    return { ...r, person, amount: amountNum };
  }

  // CREDIT CARD RULES
  if (isCredit) {
    const desc = String(r.description || "");

    // ✅ Payments: Chase may export payments as POSITIVE, Amex often NEGATIVE.
    // So: if it looks like a payment by description, treat as TRANSFER regardless of sign.
    if (looksLikePayment(desc) && !looksLikeUtility(desc)) {
      return {
        ...r,
        person,
        transaction_type: "transfer",
        type: "expense", // transfers excluded anyway
        amount: -Math.abs(amountNum), // on the card account, payment reduces balance
        category: r.category || "Other",
      };
    }

    // ✅ Fees/interest should be expenses
    if (looksLikeFeeOrInterest(desc)) {
      return {
        ...r,
        person,
        transaction_type: "normal",
        type: "expense",
        amount: -Math.abs(amountNum),
        category: r.category || "Fees & Adjustments",
      };
    }

    // ✅ Default for credit card rows = purchase expense (fixes AMEX market charge)
    // Purchases sometimes appear positive (balance increases) or negative (some exports).
    return {
      ...r,
      person,
      transaction_type: "normal",
      type: "expense",
      amount: -Math.abs(amountNum),
    };
  }

  // NON-CREDIT (checking/savings) RULES
  if (amountNum > 0) {
    return {
      ...r,
      person,
      amount: Math.abs(amountNum),
      type: "income",
      transaction_type: "normal",
    };
  }
  if (amountNum < 0) {
    return {
      ...r,
      person,
      amount: -Math.abs(amountNum),
      type: "expense",
      transaction_type: "normal",
    };
  }

  return { ...r, person, amount: amountNum };
};

const SmartTransactionImport = ({
  accounts,
  selectedPerson,
  onImport,
}) => {
  const [profile, setProfile] = useState("generic");
  const [sourceAccountId, setSourceAccountId] = useState("");
  const [fileName, setFileName] = useState("");
  const [rawRows, setRawRows] = useState([]); // string[][]
  const [mapping, setMapping] = useState({
    date: "Date",
    description: "Description",
    amount: "Amount",
    type: "Type",
    category: "Category",
  });
  const [hasHeader, setHasHeader] = useState(true);
  const [detectTransfers, setDetectTransfers] = useState(true);
  const [preview, setPreview] = useState([]);
  const [error, setError] = useState(null);
  const [importSummary, setImportSummary] = useState(null);

  const resetImport = () => {
  setRawRows([]);
  setFileName("");
  setPreview([]);
  setImportSummary(null);
  setError(null);
  };

  const profiles = useMemo(
    () => ({
      generic: {
        label: "Generic (FinanceTracker export)",
        defaults: {
          date: "Date",
          description: "Description",
          amount: "Amount",
          type: "Type",
          category: "Category",
        },
      },
      chase: {
        label: "Chase (checking/savings)",
        defaults: {
          date: "Transaction Date",
          description: "Description",
          amount: "Amount",
          type: "Type", // some exports include Type; if missing we infer by sign
          category: "Category",
        },
      },
      amex: {
        label: "Amex (credit card)",
        defaults: {
          date: "Date",
          description: "Description",
          amount: "Amount",
          type: "Type",
          category: "Category",
        },
      },
        dcu_checking: {
  	label: "DCU (checking/savings)",
  	defaults: {
    	date: "DATE",
    	description: "DESCRIPTION",
    	amount: "AMOUNT",
    	type: "TRANSACTION TYPE",
    	category: "__none__",
  	},
      },
	truist_checking: {
  	label: "Truist (checking/savings)",
  	defaults: {
    	date: "Transaction Date",
    	description: "Full description",
    	amount: "Amount",
    	type: "Transaction Type",
    	category: "Category name",
  	},
	},

	suntrust_checking: {
  	label: "Suntrust (legacy)",
  	defaults: {
    	date: "Transaction Date",
    	description: "Full description",
    	amount: "Amount",
    	type: "Transaction Type",
    	category: "Category name",
  	},
	},

    }),
    []
  );

  // helper functions (put it here)
  const computeImportSummary = useCallback((rows) => {
  let expenses = 0;
  let payments = 0;
  let refunds = 0;

  for (const t of rows || []) {
    const isTransfer = (t.transaction_type || "normal") === "transfer";
    if (isTransfer) {
      payments++;
      continue;
    }

    const desc = String(t.description || "").toLowerCase();
    const looksRefundy =
      /\b(refund|returned|return|reversal|chargeback)\b/.test(desc) ||
      (t.type === "income");

    if (looksRefundy) {
      refunds++;
      continue;
    }

    if (t.type === "expense") expenses++;
  }

  return { expenses, payments, refunds, total: (rows || []).length };
}, []);


  useEffect(() => {
    const p = profiles[profile];
    if (p?.defaults) setMapping(p.defaults);
  }, [profile, profiles]);

  const headers = useMemo(() => {
    if (!rawRows?.length) return [];
    return hasHeader ? rawRows[0] : rawRows[0].map((_, idx) => `Column ${idx + 1}`);
  }, [rawRows, hasHeader]);

  const dataRows = useMemo(() => {
    if (!rawRows?.length) return [];
    return hasHeader ? rawRows.slice(1) : rawRows;
  }, [rawRows, hasHeader]);

  const buildRowObj = useCallback(
    (row) => {
  const idxOf = (colName) => {
  const target = String(colName || "").trim().toLowerCase();
  return headers.findIndex(
    (h) => String(h || "").trim().toLowerCase() === target
  );
  };


      const dateIdx = idxOf(mapping.date);
      const descIdx = idxOf(mapping.description);
      const amtIdx = idxOf(mapping.amount);
      const typeIdx = idxOf(mapping.type);
      const catIdx = mapping.category && mapping.category !== "__none__"
    ? idxOf(mapping.category)
    : -1;

      const rawDate = dateIdx >= 0 ? row[dateIdx] : "";
      const rawDesc = descIdx >= 0 ? row[descIdx] : "";
      const rawAmt = amtIdx >= 0 ? row[amtIdx] : "";
      const rawType = typeIdx >= 0 ? row[typeIdx] : "";
      const rawCat = catIdx >= 0 ? row[catIdx] : "";

      const signed = normalizeMoney(rawAmt);
      const inferredType = signed >= 0 ? "income" : "expense";
      const type = rawType?.toLowerCase() === "income" || rawType?.toLowerCase() === "expense" ? rawType.toLowerCase() : inferredType;

      return {
        date: tryParseDate(rawDate) || new Date().toISOString().slice(0, 10),
        description: String(rawDesc || "").trim(),
        category: String(rawCat || "Uncategorized").trim() || "Uncategorized",
        amount: signed,
        type,
        person: selectedPerson || "joint",
        account_id: sourceAccountId ? Number(sourceAccountId) : null,
        transaction_type: "normal",
        transfer_account_id: null,
      };
    },
    [headers, mapping, selectedPerson, sourceAccountId]
  );


const findAccountByKeywords = (accounts, keywords) => {
  const ks = (keywords || []).map(k => String(k).toLowerCase());
  return (accounts || []).find(a => {
    const hay = `${a.name || ""} ${a.institution || ""}`.toLowerCase();
    return ks.some(k => hay.includes(k));
  }) || null;
};
const normalizeDesc = (s = "") =>
  String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// “Payment-ish” signal, but NOT enough on its own to mark transfer
const looksLikePaymentOrTransferSignal = (descNorm) => {
  // broadened to catch DCU strings
  return /\b(payment|pay|autopay|thank|e payment|epayment|transfer|xfer|loan payment)\b/.test(descNorm);
};

// Build searchable tokens for an account
const buildAccountTokens = (acct) => {
  const parts = [
    acct?.name,
    acct?.institution,
  ]
    .filter(Boolean)
    .map((x) => normalizeDesc(x));

  const base = parts.join(" ").trim();

  // Common aliases (safe, low-maintenance). Add more as you like.
  const alias = [];
  const blob = `${acct?.name || ""} ${acct?.institution || ""}`.toLowerCase();

  if (blob.includes("american express") || blob.includes("amex")) alias.push("amex", "american express");
  if (blob.includes("chase") || blob.includes("jpm")) alias.push("chase", "jp morgan", "jpm");
  if (blob.includes("capital one") || blob.includes("cap1") || blob.includes("c1")) alias.push("capital one", "cap one", "cap1", "c1");
  if (blob.includes("discover")) alias.push("discover");
  if (blob.includes("apple")) alias.push("applecard", "apple card", "gsbankpayment", "gs bank");
  if (blob.includes("dcu") || blob.includes("digital federal")) alias.push("dcu", "digital federal");
if (blob.includes("truist") || blob.includes("suntrust")) {
  alias.push("truist", "suntrust");
}
  return new Set([base, ...alias].filter(Boolean));
};



const normalizeCreditCardRow = (t, srcAcct) => {
  const desc = String(t.description || "");
  const descNorm = normalizeDesc(desc);
  const amt = Number(t.amount || 0);

  // If already tagged as transfer, don’t override
  if ((t.transaction_type || "normal") === "transfer") return t;

  // Payments (AUTOPAY PAYMENT, THANK YOU, etc.) => transfer
  if (looksLikePayment(descNorm)) {
    return {
      ...t,
      transaction_type: "transfer",
      type: "expense",
      amount: -Math.abs(amt),
    };
  }

  // Refunds/credits => income
  const looksRefundy =
    /\b(refund|returned|return|reversal|chargeback|credit)\b/.test(descNorm);

  if (looksRefundy) {
    return {
      ...t,
      transaction_type: "normal",
      type: "income",
      amount: Math.abs(amt),
      category: t.category || "Refund/Credit",
    };
  }

  // Default CC purchase => expense
  return {
    ...t,
    transaction_type: "normal",
    type: "expense",
    amount: -Math.abs(amt),
  };
};


const transferTargets = useMemo(() => {
  const list = (accounts || [])
    .map((a) => ({
      id: Number(a.id),
      account_type: a.account_type,
      tokens: buildAccountTokens(a),
      raw: a,
    }))
    // targets can be credit, loan, or even other bank accounts
    .filter((x) => x.id && x.tokens && x.tokens.size > 0);

  return list;
}, [accounts]);

const detectTransferForRow = useCallback(
  (t) => {
    if (!detectTransfers) return t;

    const descNorm = normalizeDesc(t.description || "");
    const src = (accounts || []).find((a) => String(a.id) === String(t.account_id));
    if (!src) return t;

    // Don’t override explicit transfer tagging
    if ((t.transaction_type || "normal") === "transfer") return t;

    // If it doesn't even look like a payment/transfer, bail early
    if (!looksLikePaymentOrTransferSignal(descNorm)) return t;

    // Find the best matching *other* account based on tokens
    const candidates = transferTargets.filter((x) => Number(x.id) !== Number(src.id));

    const match = candidates.find((c) => {
      for (const token of c.tokens) {
        if (!token) continue;
        // token could be multi-word, this handles both
        if (descNorm.includes(token)) return true;
      }
      return false;
    });

    // IMPORTANT:
    // If we cannot match to a known account, do NOT classify as transfer.
    // This prevents “WASHINGTON GAS PAYMENT” from being tagged as transfer.
    if (!match) return t;

    return {
      ...t,
      transaction_type: "transfer",
      transfer_account_id: Number(match.id),
    };
  },
  [accounts, detectTransfers, transferTargets]
);

  const rebuildPreview = useCallback(() => {
  try {
    setError(null);

    if (!dataRows.length || !headers.length) {
      setPreview([]);
      setImportSummary(null);
      return;
    }

    const acctById = new Map((accounts || []).map((a) => [Number(a.id), a]));
    const srcAcct = sourceAccountId ? acctById.get(Number(sourceAccountId)) : null;

    const normalizeForAccount = (t) => {
      if (!srcAcct) return t;

      // CREDIT CARD rules (AMEX, etc.)
      if (srcAcct.account_type === "credit") {
        return normalizeCreditCardRow(t, srcAcct);
      }

      // BANK rules are already handled by buildRowObj sign inference + normalizeMoney
      return t;
    };

    const p = dataRows
      .slice(0, 10)
      .map((r) => buildRowObj(r))
      .map(normalizeForAccount)
      .map(detectTransferForRow)
      .filter((t) => t.description || t.amount); // ✅ match doImport

    setPreview(p);
    setImportSummary(computeImportSummary(p));
  } catch (e) {
    console.error("[import] preview failed", e);

    // ✅ debug logging that exists in this scope
    console.log("[import] headers:", headers);
    console.log("[import] first data row:", dataRows?.[0]);
    console.log("[import] mapping:", mapping);
    console.log("[import] sourceAccountId:", sourceAccountId);

    setError("Could not build preview. Check mapping + CSV format.");
    setPreview([]);
    setImportSummary(null);
  }
}, [
  dataRows,
  headers,
  accounts,
  sourceAccountId,
  buildRowObj,
  detectTransferForRow,
  mapping,
  computeImportSummary,
]);

  useEffect(() => {
    rebuildPreview();
  }, [rebuildPreview]);

  const onPickFile = async (file) => {
    try {
      setError(null);
      if (!file) return;
      setFileName(file.name || "");
      const text = await file.text();
      const parsed = parseCsv(text);
      if (!parsed?.length) throw new Error("Empty CSV");
      setRawRows(parsed);
    } catch (e) {
      console.error("[import] file read failed", e);
      setError("Could not read CSV. Try exporting as CSV (not XLSX) and re-upload.");
      setRawRows([]);
    }
  };

const doImport = () => {
  if (!dataRows.length || !headers.length) {
    alert("Choose a CSV file first.");
    return;
  }
  if (!sourceAccountId) {
    alert("Pick a source account (Amex/Chase/Checking) so imports can tag the account.");
    return;
  }

  // Build account lookup + source account
  const acctById = new Map((accounts || []).map((a) => [Number(a.id), a]));
  const srcAcct = acctById.get(Number(sourceAccountId));

  // Normalize based on source account type (credit vs bank)
  const normalizeForAccount = (t) => {
    if (!srcAcct) return t;

    // Credit card import rules (AMEX, etc.)
    if (srcAcct.account_type === "credit") {
      return normalizeCreditCardRow(t, srcAcct);
    }

    // Bank/checking/savings: keep as-is (buildRowObj already inferred sign/type)
    return t;
  };

  const rows = dataRows
    .map((r) => buildRowObj(r))            // raw rows -> app shape
    .map(normalizeForAccount)              // ✅ fix AMEX sign/type here
    .map(detectTransferForRow)             // tag transfers & set transfer_account_id when match exists
    .filter((t) => t.description || t.amount);

  // Summary should reflect what will be imported
  setImportSummary(computeImportSummary(rows));

  onImport(rows);

  // reset UI
  setRawRows([]);
  setFileName("");
};

const OPTIONAL_FIELDS = new Set(["category", "type"]);

  return (
    <div className="border rounded-lg p-4 bg-white">
      <div className="flex flex-col md:flex-row md:items-end gap-3">
        <div className="flex-1">
          <label className="text-xs text-gray-500">Import profile</label>
          <select
            value={profile}
            onChange={(e) => setProfile(e.target.value)}
            className="border rounded px-3 py-2 w-full"
          >
            {Object.entries(profiles).map(([k, v]) => (
              <option key={k} value={k}>
                {v.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex-1">
          <label className="text-xs text-gray-500">Source account</label>
          <select
            value={sourceAccountId}
            onChange={(e) => setSourceAccountId(e.target.value)}
            className="border rounded px-3 py-2 w-full"
          >
            <option value="">Select account…</option>
            {(accounts || []).map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}{a.institution ? ` (${a.institution})` : ""}
              </option>
            ))}
          </select>
        </div>

        <div className="flex-1">
          <label className="text-xs text-gray-500">CSV file</label>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => onPickFile(e.target.files?.[0])}
            className="border rounded px-3 py-2 w-full"
          />
          {fileName ? <div className="text-xs text-gray-500 mt-1">{fileName}</div> : null}
        </div>
      </div>

      <div className="mt-3 flex items-center gap-4">
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} />
          First row is header
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-700">
          <input type="checkbox" checked={detectTransfers} onChange={(e) => setDetectTransfers(e.target.checked)} />
          Detect transfers (payments)
        </label>
      </div>

      {error ? <div className="mt-3 text-sm text-red-600">{error}</div> : null}

      {headers.length > 0 && (
        <div className="mt-4 grid grid-cols-1 md:grid-cols-5 gap-3">
          {[
            ["date", "Date"],
            ["description", "Description"],
            ["amount", "Amount"],
            ["type", "Type"],
            ["category", "Category"],
          ].map(([key, label]) => (
            <div key={key}>
              <label className="text-xs text-gray-500">{label} column</label>
<select
  value={mapping[key]}
  onChange={(e) =>
    setMapping((m) => ({ ...m, [key]: e.target.value }))
  }
  className="border rounded px-3 py-2 w-full"
>
  {OPTIONAL_FIELDS.has(key) && (
    <option value="__none__">
      (none – infer from amount)
    </option>
  )}

  {headers.map((h, idx) => (
    <option key={`${key}-${idx}`} value={h}>
      {h || `Column ${idx + 1}`}
    </option>
  ))}
</select>

            </div>
          ))}
        </div>
      )}

      {preview.length > 0 && (
        <div className="mt-4">
          <div className="text-sm font-semibold text-gray-800 mb-2">Preview (first 10 rows)</div>
          <div className="overflow-x-auto border rounded">
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-left">Description</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                  <th className="px-3 py-2 text-left">Type</th>
                  <th className="px-3 py-2 text-left">Txn</th>
                </tr>
              </thead>
              <tbody>
                {preview.map((t, idx) => (
                  <tr key={idx} className="border-t">
                    <td className="px-3 py-2">{t.date}</td>
                    <td className="px-3 py-2">{t.description}</td>
                    <td className="px-3 py-2 text-right">${Math.abs(Number(t.amount || 0)).toLocaleString()}</td>
                    <td className="px-3 py-2">{t.type}</td>
                    <td className="px-3 py-2">
                      {t.transaction_type === "transfer" ? (
                        <span className="text-xs bg-indigo-50 border border-indigo-200 text-indigo-700 px-2 py-1 rounded-full">transfer</span>
                      ) : (
                        <span className="text-xs bg-gray-50 border border-gray-200 text-gray-700 px-2 py-1 rounded-full">normal</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
{importSummary && (
  <div className="mt-2 text-sm text-gray-700">
    <span className="font-semibold">Import Summary:</span>{" "}
    {importSummary.expenses} expenses,{" "}
    {importSummary.payments} payments,{" "}
    {importSummary.refunds} refunds
  </div>
)}

      <div className="mt-4 flex items-center justify-between">
        <div className="text-xs text-gray-500">
          Tip: payments will be auto-tagged as <span className="font-semibold">transfer</span> and excluded from spending totals.
        </div>
        <button
          type="button"
          onClick={doImport}
          className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-md hover:bg-indigo-700"
        >
          Import
        </button>
	<button
    	  onClick={resetImport}
    	  className="border px-4 py-2 rounded hover:bg-gray-100"
  	>
    	  Cancel
  	</button>
      </div>
    </div>
  );
};

// -----------------------------
// Project file helpers
// -----------------------------
const sanitizeFileName = (name) => {
  const original = String(name || "quote");

  let cleaned = original
    .normalize("NFKD")
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  const MAX = 120;
  if (cleaned.length > MAX) {
    const ext = cleaned.includes(".") ? "." + cleaned.split(".").pop() : "";
    cleaned = cleaned.slice(0, MAX - ext.length) + ext;
  }

  return cleaned || "quote";
};

//  --------------------------------------------------------------------------
//  Category Trend Helpers
//  --------------------------------------------------------------------------
const lastNMonthKeys = (n = 6, fromDate = new Date()) => {
  const out = [];
  const d = new Date(fromDate.getFullYear(), fromDate.getMonth(), 1);
  for (let i = 0; i < n; i++) {
    const yy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    out.unshift(`${yy}-${mm}`); // oldest -> newest
    d.setMonth(d.getMonth() - 1);
  }
  return out;
};


// ---------------------------------------------------------------------------
// Month helpers (Budget Tab improvements)
// ---------------------------------------------------------------------------
const toMonthKey = (value) => {
  if (!value) return "";
  // Accept 'YYYY-MM', 'YYYY-MM-DD', or Date-ish strings.
  const s = String(value);
  const key = s.slice(0, 7);
  return /^\d{4}-\d{2}$/.test(key) ? key : "";
};

const monthToDb = (monthKey) => {
  const k = toMonthKey(monthKey);
  return k ? `${k}-01` : null;
};

const prevMonthKey = (monthKey) => {
  const k = toMonthKey(monthKey);
  if (!k) return "";
  const [y, m] = k.split("-").map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

const nextMonthKey = (monthKey) => {
  const k = toMonthKey(monthKey);
  if (!k) return "";
  const [y, m] = k.split("-").map(Number);
  const d = new Date(y, m, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};



// Stable month label (avoid timezone shifting to prior month)
const monthLabelFromKey = (monthKey) => {
  if (!monthKey) return "";
  const [y, m] = String(monthKey).split("-");
  const yy = Number(y);
  const mm = Number(m);
  if (!yy || !mm) return monthKey;
  return format(new Date(yy, mm - 1, 1), "MMMM yyyy");
};

const FinanceTracker = () => {
  const [activeTab, setActiveTab] = useState("dashboard");
  const [selectedPerson, setSelectedPerson] = useState("joint");
  const [isLoading, setIsLoading] = useState(true);

  const [dateRange, setDateRange] = useState("this-month");
  const [customRange, setCustomRange] = useState({
    start: "",
    end: "",
  });

  // Transactions state
  const [transactions, setTransactions] = useState([]);

  // Assets state
  const [assets, setAssets] = useState([]);

  // Liabilities state
  const [liabilities, setLiabilities] = useState([]);

  // Accounts state (bank + credit cards)
  const [accounts, setAccounts] = useState([]);

  // Budget state
  const [budgets, setBudgets] = useState([]);

  const [recurringRules, setRecurringRules] = useState([]);

  const [editingTransactionId, setEditingTransactionId] = useState(null);
  const [editTransactionDraft, setEditTransactionDraft] = useState(null);

  // Inline editing for other entities
  const [editingBudgetId, setEditingBudgetId] = useState(null);
  const [editBudgetDraft, setEditBudgetDraft] = useState(null);

  const [editingAssetId, setEditingAssetId] = useState(null);
  const [editAssetDraft, setEditAssetDraft] = useState(null);

  const [editingLiabilityId, setEditingLiabilityId] = useState(null);
  const [editLiabilityDraft, setEditLiabilityDraft] = useState(null);

  const [rolloverEnabled, setRolloverEnabled] = useState(true);

  // Transactions table filters
  const [transactionSearch, setTransactionSearch] = useState("");
  const [transactionFilterCategory, setTransactionFilterCategory] =
    useState("all");
  const [transactionFilterType, setTransactionFilterType] = useState("all");

  const [session, setSession] = useState(null);
  const [authOpen, setAuthOpen] = useState(false);

  const [householdId, setHouseholdId] = useState(null);
  const [householdGateOpen, setHouseholdGateOpen] = useState(false);
  const [openMonths, setOpenMonths] = useState(() => new Set());

  // Form states
  const [newTransaction, setNewTransaction] = useState({
    date: new Date().toISOString().split("T")[0],
    description: "",
    category: "Food",
    amount: "",
    type: "expense",
    person: "joint",
    account_id: null, // accounts.id
    transaction_type: "normal", // normal | transfer
    transfer_account_id: null, // accounts.id (counterparty)
  });

  const [newAccount, setNewAccount] = useState({
    name: "",
    institution: "",
    account_type: "checking", // checking | savings | credit
    last4: "",
    person: "joint",
  });

  const [newAsset, setNewAsset] = useState({
    name: "",
    value: "",
    person: "joint",
  });

  const [newLiability, setNewLiability] = useState({
    name: "",
    value: "",
    person: "joint",
  });

  const currentMonth = new Date().toISOString().slice(0, 7);

  // Budget: "Add budget" form state
  const [newBudget, setNewBudget] = useState({
    category: "Food",
    amount: "",
    month: currentMonth,
    person: "joint",
  });
    const [applyMonth, setApplyMonth] = useState(currentMonth);

  // Budget: view month selector (decoupled from newBudget form)
  const [budgetViewMonth, setBudgetViewMonth] = useState(currentMonth);

  // Budget: search budgets (category or transaction description)
  const [budgetSearch, setBudgetSearch] = useState("");

  const [expandedBudgets, setExpandedBudgets] = useState({});
  const [userToggledBudgets, setUserToggledBudgets] = useState({}); // track manual toggles

  // New recurring rule form
  const [newRecurring, setNewRecurring] = useState({
    description: "",
    category: "Food",
    amount: "",
    type: "expense",
    person: "joint",
    dayOfMonth: 1,
  });
// ------------------------------
// Recurring Manager UI state
// ------------------------------
const [recurringOpen, setRecurringOpen] = useState(true);
const [recurringSortKey, setRecurringSortKey] = useState("description"); // description | category | amount | type | person | dayOfMonth | active
const [recurringSortDir, setRecurringSortDir] = useState("asc"); // asc | desc
const [recurringSearch, setRecurringSearch] = useState("");

const [selectedRecurringIds, setSelectedRecurringIds] = useState(() => new Set());

// Apply controls
const [applyRecurringMode, setApplyRecurringMode] = useState("month"); // "month" | "date"
const [applyRecurringDate, setApplyRecurringDate] = useState(
  new Date().toISOString().split("T")[0]
);

// --------------------------------------
// Projects (planned/home fixes) - starter
// --------------------------------------
const [projects, setProjects] = useState([]);
const [newProject, setNewProject] = useState({
  name: "",
  vendor: "",
  quotedAmount: "",
  targetMonth: currentMonth, // "YYYY-MM"
  notes: "",
  // file will be selected separately
});

// Optional: store selected file in state (so you can upload on save)
// const [newProjectFile, setNewProjectFile] = useState(null);
const [newProjectFiles, setNewProjectFiles] = useState([]);


// For future: editing support
const [editingProjectId, setEditingProjectId] = useState(null);
const [editProjectDraft, setEditProjectDraft] = useState(null);

// Budget: per-card "show all transactions" toggle
 const [showAllBudgetTxns, setShowAllBudgetTxns] = useState({});

 const [isOwner, setIsOwner] = useState(false);

 const [editingRuleId, setEditingRuleId] = useState(null);
 const [editRuleDraft, setEditRuleDraft] = useState(null);
 // Recurring rule editing state
 const [editingRecurringRuleId, setEditingRecurringRuleId] = useState(null);
 const [editRecurringDraft, setEditRecurringDraft] = useState(null);
 const [forecastOpen, setForecastOpen] = useState(false); // default collapsed
 const [pendingOpenUrl, setPendingOpenUrl] = useState(null);
 const [pendingOpenName, setPendingOpenName] = useState(null);
 const [projectFiles, setProjectFiles] = useState([]);
 const [editProjectFiles, setEditProjectFiles] = useState([]);

 // AI: budget summary
 const [aiBudgetSummary, setAiBudgetSummary] = useState(null);
 const [aiBudgetLoading, setAiBudgetLoading] = useState(false);
 const [aiBudgetError, setAiBudgetError] = useState(null);
 const [aiBudgetOpen, setAiBudgetOpen] = useState(true); // or false if you prefer collapsed by default


  const categories = [
    "Food",
    "Transportation",
    "Housing",
    "Entertainment",
    "Healthcare",
    "Utilities",
    "Shopping",
    "Other",
  ];


// Pull a “takeaway” line if present, else use first non-empty line.
const aiBudgetPreview = (() => {
  const txt = (aiBudgetSummary || "").trim();
  if (!txt) return "";
  const lines = txt.split("\n").map(l => l.trim()).filter(Boolean);

  const takeawayLine =
    lines.find(l => /^takeaway:/i.test(l)) ||
    lines.find(l => /^key takeaway:/i.test(l));

  const pick = takeawayLine || lines[0] || "";
  return pick.length > 140 ? pick.slice(0, 140) + "…" : pick;
})();


 // Budget categories use the same category list
 const budgetCategories = categories;

  useEffect(() => {
  let mounted = true;

  // initial
  supabase.auth.getSession().then(({ data }) => {
    if (!mounted) return;
    setSession(data.session ?? null);
    setAuthOpen(!data.session);
  });

  // updates (login/logout)
  const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
    setSession(newSession);
    setAuthOpen(!newSession);
    if (!newSession) {
      // optional: reset household on logout
      setHouseholdId(null);
      setHouseholdGateOpen(false);
    }
  });

  return () => {
    mounted = false;
    sub.subscription.unsubscribe();
  };
}, []);


  useEffect(() => {
  if (!session?.user?.id) return;

  let cancelled = false;

  (async () => {
    const { data, error } = await supabase
      .from("household_members")
      .select("household_id, role")
      .eq("user_id", session.user.id)
      .limit(1)
      .maybeSingle();

    if (cancelled) return;

    if (error) {
      console.error("[household_members] lookup failed", error);
      setHouseholdId(null);
      setHouseholdGateOpen(true);
      setIsOwner(false);
      return;
    }

    if (data?.household_id) {
      setHouseholdId(data.household_id);
      setHouseholdGateOpen(false);
      setIsOwner((data?.role || "").toLowerCase() === "owner");
    } else {
      setHouseholdId(null);
      setHouseholdGateOpen(true);
      setIsOwner(false);
    }
  })();

  return () => {
    cancelled = true;
  };
}, [session?.user?.id]);

  const isAuthed = !!session?.user?.id;
  const canViewData = isAuthed && !!householdId;

  useEffect(() => {
  console.log("[hh:snapshot]", {
    authed: !!session?.user?.id,
    userId: session?.user?.id,
    householdId,
    isOwner,
    householdGateOpen,
    canViewData,
  });
}, [session?.user?.id, householdId, isOwner, householdGateOpen, canViewData]);

useEffect(() => {
  setApplyMonth(currentMonth);
}, [currentMonth]);

// Reset edit state when person filter changes
useEffect(() => {
  cancelEditRecurringRule();
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [selectedPerson]);

  // ---------------------------------------------------------------------------
  // Load data (Supabase when authed+in household; otherwise local demo defaults)
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let ignore = false;
    setIsLoading(true);

const loadFromDb = async () => {
  if (!canViewData) return;
    try {
        const uid = session.user.id;

const [
  txRes,
  budRes,
  aRes,
  lRes,
  rRes,
  acctRes,
  pRes,
  pfRes,
] = await Promise.all([
  supabase.from("transactions").select("*").eq("household_id", householdId).order("date", { ascending: false }),
  supabase.from("budgets").select("*").eq("household_id", householdId).order("created_at", { ascending: false }),
  supabase.from("assets").select("*").eq("household_id", householdId).order("created_at", { ascending: false }),
  supabase.from("liabilities").select("*").eq("household_id", householdId).order("created_at", { ascending: false }),
  supabase.from("recurring_rules").select("*").eq("household_id", householdId).order("created_at", { ascending: false }),

  // ✅ accounts
  supabase.from("accounts").select("*").eq("household_id", householdId).order("created_at", { ascending: false }),

  // ✅ projects
  supabase.from("planned_projects").select("*").eq("household_id", householdId).order("target_month", { ascending: true }),
supabase.from("project_files").select("*").eq("household_id", householdId).order("created_at", { ascending: false }),

]);

if (pfRes.error) console.warn("[db] load project_files failed", pfRes.error);

const projRows = (pRes.data ?? []).map((p) => ({
  ...p,
  quotedAmount: Number(p.quoted_amount ?? p.quotedAmount ?? 0),
  targetMonth: p.target_month ?? p.targetMonth ?? currentMonth,
  quoteFilePath: p.quote_file_path ?? p.quoteFilePath ?? null, // optional legacy
}));


if (ignore) return;

if (txRes.error) console.warn("[db] load transactions failed", txRes.error);
if (budRes.error) console.warn("[db] load budgets failed", budRes.error);
if (aRes.error) console.warn("[db] load assets failed", aRes.error);
if (lRes.error) console.warn("[db] load liabilities failed", lRes.error);
if (rRes.error) console.warn("[db] load recurring_rules failed", rRes.error);
if (pRes.error) console.warn("[db] load planned_projects failed", pRes.error);
if (pfRes.error) console.warn("[db] load project_files failed", pfRes.error);

const accountsRows = (acctRes.data ?? []).map((a) => ({
  id: a.id,
  household_id: a.household_id,
  name: a.name,
  institution: a.institution || "",
  account_type: a.account_type || "checking",
  last4: a.last4 || "",
  created_by: a.created_by,
  created_at: a.created_at,
}));

const acctById = new Map(accountsRows.map((a) => [Number(a.id), a]));

const txns = (txRes.data ?? []).map((t) => {
  const account = t.account_id ? acctById.get(Number(t.account_id)) : null;
  const transfer = t.transfer_account_id ? acctById.get(Number(t.transfer_account_id)) : null;
  return {
    ...t,
    amount: Number(t.amount),
    transaction_type: t.transaction_type || "normal",
    account_name: account?.name || "",
    transfer_account_name: transfer?.name || "",
  };
});
const buds = (budRes.data ?? []).map((b) => ({ ...b, amount: Number(b.amount), month: toMonthKey(b.month) }));
const assetsRows = (aRes.data ?? []).map((a) => ({ ...a, value: Number(a.value) }));
const liabRows = (lRes.data ?? []).map((l) => ({ ...l, value: Number(l.value) }));
const rules = (rRes.data ?? []).map((r) => ({
  id: r.id,
  description: r.description,
  category: r.category,
  amount: Number(r.amount),
  type: r.type,
  person: r.person,
  dayOfMonth: r.day_of_month ?? r.dayOfMonth ?? 1,
  active: r.active !== false,
  household_id: r.household_id,
  created_by: r.created_by,
  created_at: r.created_at,
  frequency: r.frequency ?? "monthly",
  start_date: r.start_date,
  end_date: r.end_date,
}));

const filesRows = (pfRes.data ?? []).map((f) => ({
  id: f.id,
  householdId: f.household_id,
  projectId: f.project_id,
  fileName: f.file_name,
  filePath: f.file_path,
  mimeType: f.mime_type,
  sizeBytes: f.size_bytes,
  createdBy: f.created_by,
  createdAt: f.created_at,
}));


setAccounts(accountsRows);
setTransactions(txns);
setBudgets(buds);
setAssets(assetsRows);
setLiabilities(liabRows);
setRecurringRules(rules);
setProjects(projRows);
setProjectFiles(filesRows);
      } catch (e) {
        console.warn("[db] loadFromDb threw", e);
      } finally {
        if (!ignore) setIsLoading(false);
      }
    };

const loadDemoDefaults = async () => {
 try {
      const defaultTransactions = [
          { id: 1, date: "2024-12-01", description: "Salary", category: "Income", amount: 5000, type: "income", person: "joint" },
          { id: 2, date: "2024-12-02", description: "Groceries", category: "Food", amount: 120, type: "expense", person: "joint" },
          { id: 3, date: "2024-12-03", description: "Gas", category: "Transportation", amount: 45, type: "expense", person: "you" },
        ];

        const defaultBudgets = [
          { id: 1, category: "Food", amount: 800, month: currentMonth, person: "joint" },
          { id: 2, category: "Transportation", amount: 300, month: currentMonth, person: "you" },
        ];

        const defaultAssets = [
          { id: 1, name: "Checking Account", value: 12000, person: "joint" },
          { id: 2, name: "Brokerage Account", value: 50000, person: "you" },
        ];

        const defaultLiabilities = [
          { id: 1, name: "Credit Card", value: 2500, person: "joint" },
        ];

        const defaultAccounts = [
          { id: 1, name: "Checking", institution: "Chase", account_type: "checking", last4: "" },
          { id: 2, name: "Amex", institution: "American Express", account_type: "credit", last4: "" },
        ];

        if (ignore) return;

        setTransactions(defaultTransactions);
        setAccounts(defaultAccounts);
        setBudgets(defaultBudgets);
        setAssets(defaultAssets);
        setLiabilities(defaultLiabilities);
      } catch (e) {
        console.warn("Failed to load demo defaults:", e);
      } finally {
        if (!ignore) setIsLoading(false);
      }
    };

    if (canViewData) {
      loadFromDb();
    } else {
      loadDemoDefaults();
    }

    return () => {
      ignore = true;
    };
  }, [canViewData, householdId, session?.user?.id]);

  // ---------------------------------------------------------------------------
  // Save data to storage whenever it changes
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!storage) return;
    if (!isLoading && transactions.length >= 0) {
      storage.set("finance-transactions", JSON.stringify(transactions)).catch(console.error);
    }
  }, [transactions, isLoading]);

  useEffect(() => {
    if (!storage) return;
    if (!isLoading && assets.length >= 0) {
      storage.set("finance-assets", JSON.stringify(assets)).catch(console.error);
    }
  }, [assets, isLoading]);

  useEffect(() => {
    if (!storage) return;
    if (!isLoading && liabilities.length >= 0) {
      storage.set("finance-liabilities", JSON.stringify(liabilities)).catch(console.error);
    }
  }, [liabilities, isLoading]);

  useEffect(() => {
    if (!storage) return;
    if (!isLoading && budgets.length >= 0) {
      storage.set("finance-budgets", JSON.stringify(budgets)).catch(console.error);
    }
  }, [budgets, isLoading]);

  useEffect(() => {
    if (!storage) return;
    if (!isLoading) {
      storage.set("finance-recurring-rules", JSON.stringify(recurringRules)).catch(console.error);
    }
  }, [recurringRules, isLoading]);

  // Storage bucket name (create in Supabase Storage)
const PROJECT_QUOTES_BUCKET = "project_quotes";

// Upload helper (starter)
// - You can call this after inserting the project row to DB (so you have projectId)
// - For now it just shows the wiring.
const uploadProjectQuoteFiles = async ({ householdId, projectId, files }) => {
  if (!files?.length) return [];

  if (!canViewData || !householdId) {
    alert("Sign in + select a household to upload files.");
    return [];
  }

  const uploaded = [];

  for (const file of files) {
    const safeName = sanitizeFileName(file.name);
    const path = `households/${householdId}/projects/${projectId}/${Date.now()}_${safeName}`;

    const { data, error } = await supabase.storage
      .from(PROJECT_QUOTES_BUCKET)
      .upload(path, file, { upsert: true });

    if (error) {
      console.error("[projects] upload failed", error);
      throw error;
    }

    uploaded.push({
      fileName: file.name,
      path: data.path,
      mimeType: file.type || null,
      sizeBytes: file.size ?? null,
    });
  }

  return uploaded;
};

const openProjectFileRow = async (fileRow, projectName) => {
  const path = fileRow?.filePath;
  if (!path) return;

  const { data, error } = await supabase.storage
    .from(PROJECT_QUOTES_BUCKET) // "project_quotes"
    .createSignedUrl(path, 60 * 5);

  if (error) {
    console.warn("[projects] signed url failed", error);
    alert(error.message || "Could not open file.");
    return;
  }

  setPendingOpenUrl(data.signedUrl);
  setPendingOpenName(`${projectName || "Project"} — ${fileRow.fileName || "Quote"}`);
};


  // ---------------------------------------------------------------------------
  // Filter by person
  // ---------------------------------------------------------------------------
  const filterByPerson = useCallback(
    (items) => {
      if (selectedPerson === "joint") return items;
      return items.filter(
        (item) => item.person === selectedPerson || item.person === "joint"
     );
    },
    [selectedPerson]
  );

  // Person-only filters
  const transactionsByPerson = useMemo(
    () => filterByPerson(transactions),
    [transactions, filterByPerson]
  );

  const filteredAssets = useMemo(
    () => filterByPerson(assets),
    [assets, filterByPerson]
  );

  const filteredLiabilities = useMemo(
    () => filterByPerson(liabilities),
    [liabilities, filterByPerson]
  );

  const filteredBudgets = useMemo(
    () => filterByPerson(budgets),
    [budgets, filterByPerson]
  );

  const recurringRulesByPerson = useMemo(
  () => filterByPerson(recurringRules),
  [recurringRules, filterByPerson]
);

  // Extra filtering for the Transactions table (search + category + type)
  const tableTransactions = useMemo(() => {
    let rows = [...transactionsByPerson];

    if (transactionFilterCategory !== "all") {
      rows = rows.filter((t) => t.category === transactionFilterCategory);
    }

    if (transactionFilterType !== "all") {
      rows = rows.filter((t) => t.type === transactionFilterType);
    }

    if (transactionSearch.trim()) {
      const q = transactionSearch.toLowerCase();
      rows = rows.filter((t) => {
        return (
          (t.date && t.date.toLowerCase().includes(q)) ||
          (t.description && t.description.toLowerCase().includes(q)) ||
          (t.category && t.category.toLowerCase().includes(q))
        );
      });
    }

    return rows;
  }, [
    transactionsByPerson,
    transactionFilterCategory,
    transactionFilterType,
    transactionSearch,
  ]);

 const tableTotals = useMemo(() => {
  let income = 0;
  let expenses = 0;

  const isTransfer = (t) => (t.transaction_type || "normal") === "transfer";
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

  tableTransactions.forEach((t) => {
    if (isTransfer(t)) return;

    const amt = Math.abs(num(t.amount));

    if (t.type === "income") income += amt;
    if (t.type === "expense") expenses += amt;
  });

  return {
    income,
    expenses,
    net: income - expenses,
  };
}, [tableTransactions]);



  const groupedTransactionsByMonth = useMemo(() => {
  const groups = new Map();

  tableTransactions.forEach((t) => {
    if (!t.date) return;
    const dateObj = parseISO(t.date);
    if (isNaN(dateObj)) return;

    const key = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, "0")}`;

    if (!groups.has(key)) {
      groups.set(key, {
        key,
        label: format(dateObj, "MMMM yyyy"),
        items: [],
        income: 0,
        expenses: 0,
        net: 0,
      });
    }

    const group = groups.get(key);
    group.items.push(t);

    const isTransfer = (t.transaction_type || "normal") === "transfer";
    if (!isTransfer) {
      const amt = Math.abs(Number(t.amount || 0));
      if (t.type === "income") group.income += amt;
      if (t.type === "expense") group.expenses += amt;
    }

    group.net = group.income - group.expenses;
  });

  return Array.from(groups.values()).sort((a, b) => (a.key < b.key ? 1 : -1));
}, [tableTransactions]);


  useEffect(() => {
  if (!currentMonth) return;
  setOpenMonths(new Set([currentMonth]));
}, [currentMonth]);

const lastNMonthKeys = (n = 6) => {
  const out = [];
  const d = new Date();
  d.setDate(1);

  for (let i = 0; i < n; i++) {
    const yy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    out.unshift(`${yy}-${mm}`);
    d.setMonth(d.getMonth() - 1);
  }
  return out;
};


//  --------------------------------------------------------------------------
//  Category Core computation: category x month matrix + rollups
//  --------------------------------------------------------------------------
const categoryTrends = useMemo(() => {
  const months = lastNMonthKeys(6);
  const monthSet = new Set(months);
  const byCategory = new Map();

  for (const t of (transactionsByPerson || [])) {
    if ((t.transaction_type || "normal") === "transfer") continue;
    if (t.type !== "expense") continue;

    const m = String(t.date || "").slice(0, 7);
    if (!monthSet.has(m)) continue;

    const cat = String(t.category || "Uncategorized").trim() || "Uncategorized";
    const spend = Math.abs(Number(t.amount || 0));
    if (!Number.isFinite(spend) || spend === 0) continue;

    const row = byCategory.get(cat) || {};
    row[m] = (row[m] || 0) + spend;
    byCategory.set(cat, row);
  }

  const rows = Array.from(byCategory.entries()).map(([category, mobj]) => {
    const series = months.map((m) => Number(mobj[m] || 0));
    const total = series.reduce((a, b) => a + b, 0);

    const cur = series[series.length - 1] || 0;
    const prev = series[series.length - 2] || 0;
    const delta = cur - prev;
    const pct = prev > 0 ? (delta / prev) * 100 : (cur > 0 ? 100 : 0);

    return { category, series, total, cur, prev, delta, pct };
  });

  rows.sort((a, b) => (b.cur - a.cur) || (b.total - a.total));

  const top = rows.slice(0, 5);
  const risers = [...rows]
    .filter((r) => r.prev >= 25 || r.cur >= 25)
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 5);

  return { months, rows, top, risers };
}, [transactionsByPerson]);




//  ---------------------------------------
// Map: { [projectId]: [fileRow, fileRow...] }
//  ----------------------------------------

const projectFilesByProjectId = useMemo(() => {
  const map = {};

  for (const f of projectFiles || []) {
    const pid = Number(f.projectId ?? f.project_id);
    if (!pid) continue;

    if (!map[pid]) map[pid] = [];

    map[pid].push({
      id: f.id,
      projectId: pid,
      fileName: f.fileName ?? f.file_name,
      filePath: f.filePath ?? f.file_path,
      mimeType: f.mimeType ?? f.mime_type,
      sizeBytes: f.sizeBytes ?? f.size_bytes,
      createdAt: f.createdAt ?? f.created_at,
    });
  }

  // 🔑 Always show newest files first
  Object.values(map).forEach((files) => {
    files.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  });

  return map;
}, [projectFiles]);


  // ---------------------------------------------------------------------------
  // Date range handling
  // ---------------------------------------------------------------------------
  const getDateInterval = () => {
    const today = new Date();

    switch (dateRange) {
      case "this-month":
        return { start: startOfMonth(today), end: endOfMonth(today) };
      case "last-month":
        return {
          start: startOfMonth(subMonths(today, 1)),
          end: endOfMonth(subMonths(today, 1)),
        };
      case "three-months":
        return {
          start: startOfMonth(subMonths(today, 2)),
          end: endOfMonth(today),
        };
      case "ytd":
        return { start: startOfYear(today), end: today };
      case "custom":
        return {
          start: customRange.start ? parseISO(customRange.start) : startOfYear(today),
          end: customRange.end ? parseISO(customRange.end) : today,
        };
      default:
        return { start: startOfMonth(today), end: endOfMonth(today) };
    }
  };

  const { start, end } = getDateInterval();

  // Person + date filtering (used for dashboard/charts/recent list)
  const filteredTransactions = useMemo(() => {
    return transactionsByPerson.filter((t) => {
      const date = parseISO(t.date);
      return isWithinInterval(date, { start, end });
    });
  }, [transactionsByPerson, start, end]);

  // ---------------------------------------------------------------------------
  // Export transactions to CSV (for current person)
  // ---------------------------------------------------------------------------
  const exportTransactionsAsCsv = () => {
    if (!transactionsByPerson.length) {
      alert("No transactions to export for this person.");
      return;
    }

    const csv = buildTransactionsCsv(transactionsByPerson);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    const today = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `transactions-${selectedPerson}-${today}.csv`;

    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

// ---------------------------------------------------------------------------
// Totals (exclude transfers, normalize expense sign)
// ---------------------------------------------------------------------------

const isTransfer = (t) => (t.transaction_type || "normal") === "transfer";
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

const totalIncome = filteredTransactions
  .filter((t) => t.type === "income" && !isTransfer(t))
  .reduce((sum, t) => sum + num(t.amount), 0);

const totalExpenses = filteredTransactions
  .filter((t) => t.type === "expense" && !isTransfer(t))
  .reduce((sum, t) => sum + Math.abs(num(t.amount)), 0);

const totalAssets = filteredAssets.reduce((sum, a) => sum + num(a.value), 0);
const totalLiabilities = filteredLiabilities.reduce((sum, l) => sum + num(l.value), 0);

const netWorth = totalAssets - totalLiabilities;


  // ---------------------------------------------------------------------------
  // Budget calculations (IMPORTANT: use transactionsByPerson, not filteredTransactions)
  // ---------------------------------------------------------------------------
 const getBudgetProgress = useCallback(
  (category, month) => {
    const budgetRow = filteredBudgets.find(
      (b) => b.category === category && b.month === month
    );
    if (!budgetRow) return null;

    const spent = transactionsByPerson
      .filter(
        (t) =>
          t.type === "expense" &&
          (t.transaction_type || "normal") !== "transfer" &&
          t.category === category &&
          t.date &&
          t.date.startsWith(month)
      )
      // ✅ expenses are stored negative; spending should be positive
      .reduce((sum, t) => sum + Math.abs(Number(t.amount || 0)), 0);

    const budget = Number(budgetRow.amount || 0);
    const percentage = budget > 0 ? (spent / budget) * 100 : 0;

    const remaining = budget - spent;
    const overBy = Math.max(0, spent - budget);

    return { budget, spent, percentage, remaining, overBy };
  },
  [filteredBudgets, transactionsByPerson]
);


  const getBudgetTransactions = useCallback(
    (category, month) => {
      return transactionsByPerson
        .filter(
          (t) =>
            t.type === "expense" &&
            (t.transaction_type || "normal") !== "transfer" &&
            t.category === category &&
            t.date &&
            t.date.startsWith(month)
        )
        .sort((a, b) => (a.date < b.date ? 1 : -1)); // newest first
    },
    [transactionsByPerson]
  );
  const getCategorySpendForMonth = useCallback(
  (category, month) => {
    return transactionsByPerson
      .filter((t) =>
        t.type === "expense" &&
        (t.transaction_type || "normal") !== "transfer" &&
        t.category === category &&
        t.date &&
        t.date.startsWith(month)
      )
      .reduce((sum, t) => sum + Number(t.amount || 0), 0);
  },
  [transactionsByPerson]
);





  const getTopContributors = (txns, topN = 3) => {
    const map = new Map();

    txns.forEach((t) => {
      const key = (t.description || "Unknown").trim() || "Unknown";
      map.set(key, (map.get(key) || 0) + Number(t.amount || 0));
    });

    return Array.from(map.entries())
      .map(([description, total]) => ({ description, total }))
      .sort((a, b) => b.total - a.total)
      .slice(0, topN);
  };

  const rolloverByCategoryForViewMonth = useMemo(() => {
  // Option #2: positive and negative roll over
  if (!rolloverEnabled) return {};

  const month = budgetViewMonth;
  if (!month) return {};

  const prev = prevMonthKey(month);

  const map = {};

  // look at budgets from the previous month for this person-filtered view
  filteredBudgets
    .filter((b) => b.month === prev)
    .forEach((b) => {
      const prog = getBudgetProgress(b.category, prev);
      if (!prog) return;
      // remaining = budget - spent (can be + or -)
      map[b.category] = (map[b.category] || 0) + Number(prog.remaining || 0);
    });

  return map;
}, [rolloverEnabled, budgetViewMonth, filteredBudgets, getBudgetProgress]);

  // Auto-expand budgets that are over 100% unless user manually toggled
  useEffect(() => {
  if (activeTab !== "budget") return;

  setExpandedBudgets((prevExpanded) => {
    let changed = false;
    const next = { ...prevExpanded };

    for (const b of filteredBudgets) {
      if (userToggledBudgets[b.id]) continue;

      const progress = getBudgetProgress(b.category, b.month);
      if (!progress) continue;

      const rollover = rolloverEnabled
        ? Number(rolloverByCategoryForViewMonth[b.category] || 0)
        : 0;

      const effectiveBudget = Math.max(0, Number(progress.budget || 0) + rollover);
      const effectivePct =
        effectiveBudget > 0 ? (Number(progress.spent || 0) / effectiveBudget) * 100 : 0;

      if (effectivePct > 100 && !next[b.id]) {
        next[b.id] = true;
        changed = true;
      }
    }

    return changed ? next : prevExpanded;
  });
}, [
  activeTab,
  filteredBudgets,
  userToggledBudgets,
  getBudgetProgress,
  rolloverEnabled,
  rolloverByCategoryForViewMonth,
]);


  const getProgressColor = (percentage) => {
    if (percentage < 80) return "bg-green-500";
    if (percentage < 100) return "bg-yellow-500";
    return "bg-red-500";
  };

  // Budget tab: available months (from budgets + transactions)
  const budgetMonthOptions = useMemo(() => {
    const set = new Set();

    (filteredBudgets || []).forEach((b) => b?.month && set.add(b.month));
    (transactionsByPerson || []).forEach((t) => t?.date && set.add(t.date.slice(0, 7)));

    const arr = Array.from(set).filter(Boolean).sort((a, b) => (a < b ? 1 : -1));
    return arr.length ? arr : [currentMonth];
  }, [filteredBudgets, transactionsByPerson, currentMonth]);

  // Ensure budgetViewMonth stays valid when switching people / data changes
  useEffect(() => {
    if (!budgetMonthOptions.includes(budgetViewMonth)) {
      setBudgetViewMonth(budgetMonthOptions[0] || currentMonth);
    }
  }, [budgetMonthOptions, budgetViewMonth, currentMonth]);

  // Budget tab: filter budgets by selected view month
  const budgetsForViewMonth = useMemo(() => {
    return filteredBudgets.filter((b) => toMonthKey(b.month) === budgetViewMonth);
  }, [filteredBudgets, budgetViewMonth]);

  // Budget tab: apply search filter (category OR transaction description)
  const budgetsForViewMonthAndSearch = useMemo(() => {
    const q = (budgetSearch || "").trim().toLowerCase();
    if (!q) return budgetsForViewMonth;

    return budgetsForViewMonth.filter((b) => {
      const catMatch = (b.category || "").toLowerCase().includes(q);
      if (catMatch) return true;

      // Match against transaction descriptions in this category + month (expenses only)
      return transactionsByPerson.some((t) => {
        if (t.type !== "expense") return false;
        if (!t.category || !t.date) return false;
        if (t.category !== b.category) return false;
        if (!t.date.startsWith(b.month)) return false;
        const desc = (t.description || "").toLowerCase();
        return desc.includes(q);
      });
    });
  }, [budgetsForViewMonth, budgetSearch, transactionsByPerson]);

  // Overall budget summary for selected budgetViewMonth
  const budgetSummary = useMemo(() => {
  const monthBudgets = budgetsForViewMonth;

  if (!budgetViewMonth || monthBudgets.length === 0) {
    return { totalBudget: 0, totalSpent: 0, remaining: 0 };
  }

  let totalBudget = 0;
  let totalSpent = 0;

  monthBudgets.forEach((b) => {
    const prog = getBudgetProgress(b.category, b.month);
    if (!prog) return;

    const rollover = rolloverEnabled
      ? Number(rolloverByCategoryForViewMonth[b.category] || 0)
      : 0;

    const effectiveBudget = Math.max(0, Number(prog.budget || 0) + rollover);

    totalBudget += effectiveBudget;
    totalSpent += Number(prog.spent || 0);
  });

  return {
    totalBudget,
    totalSpent,
    remaining: totalBudget - totalSpent,
  };
}, [
  budgetsForViewMonth,
  budgetViewMonth,
  getBudgetProgress,
  rolloverEnabled,
  rolloverByCategoryForViewMonth,
]);

const budgetViewMonthKey = budgetViewMonth;

const buildBudgetAiPayload = useCallback(
  ({ force } = {}) => {
    const monthKey = budgetViewMonth; // "YYYY-MM"
    const monthLabel = monthLabelFromKey(monthKey);

    const round2 = (n) => {
      const x = Number(n);
      return Number.isFinite(x) ? Math.round(x * 100) / 100 : 0;
    };

    // Totals shown in your summary cards
    const plannedBudget = round2(budgetSummary.totalBudget);
    const actualSpending = round2(budgetSummary.totalSpent);
    const remaining = round2(budgetSummary.remaining);

    const highlights = budgetsForViewMonthAndSearch
      .map((b) => {
        const p = getBudgetProgress(b.category, b.month);
        if (!p) return null;

        const rollover = round2(rolloverByCategoryForViewMonth[b.category] || 0);
        const baseBudget = round2(p.budget || 0);
        const effectiveBudget = round2(Math.max(0, baseBudget + rollover));

        const spent = round2(p.spent || 0);
        const remainingCat = round2(effectiveBudget - spent);

        const ratio = effectiveBudget > 0 ? spent / effectiveBudget : 0;

        const status =
          spent > effectiveBudget
            ? "over"
            : effectiveBudget > 0 && spent >= effectiveBudget
            ? "exhausted"
            : ratio >= 0.8
            ? "watch"
            : "ok";

        return {
          category: b.category,
          status,
          budget: effectiveBudget,
          spent,
          remaining: remainingCat,
        };
      })
      .filter(Boolean)
      .sort((a, b) => (b.spent || 0) - (a.spent || 0))
      .slice(0, 8);

    return {
      monthKey,         // handy for caching/debugging
      monthLabel,
      plannedBudget,
      actualSpending,
      remaining,
      highlights,
      force: !!force,   // if you want Edge Function to treat it as cache-bypass
    };
  },
  [
    budgetViewMonth,
    budgetSummary,
    budgetsForViewMonthAndSearch,
    rolloverByCategoryForViewMonth,
    getBudgetProgress,
  ]
);



const runAiBudgetSummary = useCallback(async ({ force } = {}) => {
  try {
    setAiBudgetLoading(true);
    setAiBudgetError(null);

    const payload = buildBudgetAiPayload(); // don't pass force unless builder expects it

    // ✅ Use the same token that proved to work in console:
    const anon = supabase.supabaseKey; // legacy eyJ... (NOT sb_publishable)
    if (!anon || !anon.startsWith("eyJ")) {
      throw new Error(
        `Supabase key is not legacy JWT (got: ${String(anon).slice(0, 12)}...)`
      );
    }

    const { data, error } = await supabase.functions.invoke("ai-budget-summary", {
      body: payload,
      headers: { Authorization: `Bearer ${anon}` },
    });

    if (error) throw error;
    if (!data?.text) throw new Error("AI returned no text.");

    setAiBudgetSummary(data.text);
  } catch (err) {
    console.error("[ai-budget-summary] failed", err);
    setAiBudgetError(err?.message || "Failed to generate AI budget summary");
  } finally {
    setAiBudgetLoading(false);
  }
}, [buildBudgetAiPayload]);






  // ---------------------------------------------------------------------------
  // Add functions
  // ---------------------------------------------------------------------------
  const addTransaction = async () => {
    if (!newTransaction.description || !newTransaction.amount) return;

    const draft = {
      ...newTransaction,
      amount: parseFloat(newTransaction.amount),
    };

    if (canViewData) {
      const payload = {
        household_id: householdId,
        date: draft.date,
        description: draft.description,
        amount: draft.amount,
        type: draft.type,
        category: draft.category,
        person: draft.person,
        account_id: draft.account_id,
        transaction_type: draft.transaction_type || "normal",
        transfer_account_id: draft.transfer_account_id,
        created_by: session.user.id,
      };

      const { data, error } = await supabase.from("transactions").insert(payload).select("*").single();
      if (error) {
        console.warn("[db] addTransaction failed", error);
        alert(error.message);
        return;
      }
      const acct = data.account_id ? accounts.find((a) => Number(a.id) === Number(data.account_id)) : null;
      const tr = data.transfer_account_id ? accounts.find((a) => Number(a.id) === Number(data.transfer_account_id)) : null;
      setTransactions((prev) => [{
        ...data,
        amount: Number(data.amount),
        transaction_type: data.transaction_type || "normal",
        account_name: acct?.name || "",
        transfer_account_name: tr?.name || "",
      }, ...prev]);
    } else {
      setTransactions((prev) => [...prev, { ...draft, id: Date.now() }]);
    }

    setNewTransaction({
      date: new Date().toISOString().split("T")[0],
      description: "",
      category: "Food",
      amount: "",
      type: "expense",
      person: "joint",
      account_id: null,
      transaction_type: "normal",
      transfer_account_id: null,
    });
  };



const importTransactions = async (rows) => {
  if (!Array.isArray(rows) || rows.length === 0) return;

  console.log("SAMPLE IMPORT ROW:", rows[0]);

  const acctById = new Map((accounts || []).map((a) => [Number(a.id), a]));

  const normalized = rows.map((r) =>
    normalizeImportedRow(r, acctById, selectedPerson)
  );

  if (canViewData) {
    const payload = normalized.map((t) => ({
      household_id: householdId,
      date: t.date,
      description: t.description,
      amount: Number(t.amount || 0),
      type: t.type,
      category: t.category,
      person: t.person,
      account_id: t.account_id,
      transaction_type: t.transaction_type || "normal",
      transfer_account_id: t.transfer_account_id,
      created_by: session.user.id,
    }));

    const { data, error } = await supabase
      .from("transactions")
      .insert(payload)
      .select("*");

    if (error) {
      console.warn("[db] importTransactions failed", error);
      alert(error.message);
      return;
    }

    const enriched = (data || []).map((t) => {
      const acct = t.account_id ? acctById.get(Number(t.account_id)) : null;
      const tr = t.transfer_account_id
        ? acctById.get(Number(t.transfer_account_id))
        : null;
      return {
        ...t,
        amount: Number(t.amount),
        transaction_type: t.transaction_type || "normal",
        account_name: acct?.name || "",
        transfer_account_name: tr?.name || "",
      };
    });

    setTransactions((prev) => [...enriched, ...prev]);
  } else {
    setTransactions((prev) => [
      ...normalized.map((t) => ({ id: Date.now() + Math.random(), ...t })),
      ...prev,
    ]);
  }
};


  const addAsset = async () => {
    if (!newAsset.name || !newAsset.value) return;

    const draft = { ...newAsset, value: parseFloat(newAsset.value) };

    if (canViewData) {
      const payload = {
        household_id: householdId,
        name: draft.name,
        value: draft.value,
        person: draft.person,
        created_by: session.user.id,
      };

      const { data, error } = await supabase.from("assets").insert(payload).select("*").single();
      if (error) {
        console.warn("[db] addAsset failed", error);
        alert(error.message);
        return;
      }
      setAssets((prev) => [{ ...data, value: Number(data.value) }, ...prev]);
    } else {
      setAssets((prev) => [...prev, { ...draft, id: Date.now() }]);
    }

    setNewAsset({ name: "", value: "", person: "joint" });
  };

  const addLiability = async () => {
    if (!newLiability.name || !newLiability.value) return;

    const draft = { ...newLiability, value: parseFloat(newLiability.value) };

    if (canViewData) {
      const payload = {
        household_id: householdId,
        name: draft.name,
        value: draft.value,
        person: draft.person,
        created_by: session.user.id,
      };

      const { data, error } = await supabase.from("liabilities").insert(payload).select("*").single();
      if (error) {
        console.warn("[db] addLiability failed", error);
        alert(error.message);
        return;
      }
      setLiabilities((prev) => [{ ...data, value: Number(data.value) }, ...prev]);
    } else {
      setLiabilities((prev) => [...prev, { ...draft, id: Date.now() }]);
    }

    setNewLiability({ name: "", value: "", person: "joint" });
  };

  const addAccount = async () => {
    if (!newAccount.name) return;

    const draft = {
      ...newAccount,
      name: String(newAccount.name).trim(),
      institution: String(newAccount.institution || "").trim(),
      account_type: newAccount.account_type || "checking",
      last4: String(newAccount.last4 || "").trim(),
    };

    if (canViewData) {
      const payload = {
        household_id: householdId,
        name: draft.name,
        institution: draft.institution,
        account_type: draft.account_type,
        last4: draft.last4,
        created_by: session.user.id,
      };

      const { data, error } = await supabase.from("accounts").insert(payload).select("*").single();
      if (error) {
        console.warn("[db] addAccount failed", error);
        alert(error.message);
        return;
      }
      setAccounts((prev) => [data, ...prev]);
    } else {
      setAccounts((prev) => [{ id: Date.now(), ...draft }, ...prev]);
    }

    setNewAccount({ name: "", institution: "", account_type: "checking", last4: "" });
  };

  const deleteAccount = async (id) => {
    if (!id) return;
    // Guard: don't delete if referenced
    const used = (transactions || []).some(
      (t) => Number(t.account_id) === Number(id) || Number(t.transfer_account_id) === Number(id)
    );
    if (used) {
      alert("This account is referenced by existing transactions. Remove those links first.");
      return;
    }

    if (canViewData) {
      const { error } = await supabase.from("accounts").delete().eq("id", id).eq("household_id", householdId);
      if (error) {
        console.warn("[db] deleteAccount failed", error);
        alert(error.message);
        return;
      }
    }

    setAccounts((prev) => prev.filter((a) => Number(a.id) !== Number(id)));
  };

  const addBudget = async () => {
    if (!newBudget.category || !newBudget.amount || !newBudget.month) return;

    const draft = { ...newBudget, amount: parseFloat(newBudget.amount) };

    if (canViewData) {
      const payload = {
        household_id: householdId,
        category: draft.category,
        amount: draft.amount,
        month: monthToDb(draft.month),
        person: draft.person,
        created_by: session.user.id,
      };

      const { data, error } = await supabase.from("budgets").insert(payload).select("*").single();
      if (error) {
        console.warn("[db] addBudget failed", error);
        alert(error.message);
        return;
      }
      setBudgets((prev) => [{ ...data, amount: Number(data.amount) }, ...prev]);
      setBudgetViewMonth(toMonthKey(draft.month));
    } else {
      setBudgets((prev) => [...prev, { ...draft, id: Date.now() }]);
      setBudgetViewMonth(toMonthKey(draft.month));
    }

    setNewBudget({
      category: "Food",
      amount: "",
      month: monthToDb(draft.month),
      person: "joint",
    });
  };

const addProjectDb = async () => {
  const name = String(newProject.name || "").trim();
  if (!name) return alert("Project name is required.");

  const quotedAmount = Number(newProject.quotedAmount || 0);
  const targetMonth = newProject.targetMonth || currentMonth;

  // If not authed / no household, fall back to local-only (optional)
  if (!canViewData || !householdId || !session?.user?.id) {
    const projectId = Date.now();
    setProjects((prev) => [
      {
        id: projectId,
        name,
        vendor: newProject.vendor || "",
        quotedAmount,
        targetMonth,
        notes: newProject.notes || "",
        quoteFilePath: null,
        createdAt: new Date().toISOString(),
      },
      ...(prev ?? []),
    ]);

    setNewProject({
      name: "",
      vendor: "",
      quotedAmount: "",
      targetMonth: currentMonth,
      notes: "",
    });
    setNewProjectFile(null);
    return;
  }

  // 1) Insert row first (get real DB id)
  const insertPayload = {
    household_id: householdId,
    name,
    vendor: newProject.vendor || null,
    quoted_amount: quotedAmount,
    target_month: targetMonth,
    notes: newProject.notes || null,
    quote_file_path: null,
    created_by: session.user.id,
  };

  const { data: inserted, error: insErr } = await supabase
    .from("planned_projects")
    .insert(insertPayload)
    .select("*")
    .single();

  if (insErr) {
    console.error("[db] addProject insert failed", insErr);
    return alert(insErr.message || "Could not add project.");
  }

  let quoteFilePath = null;

if (newProjectFiles?.length) {
  try {
    // Upload all files
    const uploaded = await uploadProjectQuoteFiles({
      householdId,
      projectId: inserted.id,
      files: newProjectFiles,
    });

    // Optional: set the "primary" file path onto planned_projects
    quoteFilePath = uploaded?.[0]?.path || null;

    if (quoteFilePath) {
      const { error: upErr } = await supabase
        .from("planned_projects")
        .update({ quote_file_path: quoteFilePath })
        .eq("id", inserted.id)
        .eq("household_id", householdId);

      if (upErr) console.warn("[db] project primary file path update failed", upErr);
    }

    // Persist ALL uploaded files in project_files table
    if (uploaded?.length) {
  	const rows = uploaded.map((u) => ({
    	household_id: householdId,
    	project_id: inserted.id,
    	file_name: u.fileName,
    	file_path: u.path,
    	mime_type: u.mimeType ?? null,
    	size_bytes: u.sizeBytes ?? null,
    	created_by: session.user.id,
  	}));

      const { error: pfErr } = await supabase.from("project_files").insert(rows);
	if (pfErr) {
  		console.warn("[db] project_files insert failed", pfErr);
  		alert(pfErr.message || "project_files insert failed");
	}
    }
  } catch (e) {
    console.warn("[projects] file upload failed", e);
    // Continue: project still saved
  }
}


  // 4) Update UI state from persisted row
  const uiRow = {
    id: inserted.id,
    household_id: inserted.household_id,
    name: inserted.name,
    vendor: inserted.vendor || "",
    quotedAmount: Number(inserted.quoted_amount || 0),
    targetMonth: inserted.target_month,
    notes: inserted.notes || "",
    quoteFilePath: quoteFilePath ?? inserted.quote_file_path ?? null,
    createdBy: inserted.created_by,
    createdAt: inserted.created_at,
  };

  setProjects((prev) => [uiRow, ...(prev ?? [])]);

  // Reset form
  setNewProject({
    name: "",
    vendor: "",
    quotedAmount: "",
    targetMonth: currentMonth,
    notes: "",
  });
  setNewProjectFiles([]);
};


const addRecurringRule = async () => {
  if (!session?.user?.id || !householdId) return;

  const description = String(newRecurring.description || "").trim();
  const amountNum = Number(newRecurring.amount);

  if (!description) {
    alert("Please enter a description for the recurring item.");
    return;
  }

  // Tighten validation: reject empty, NaN, 0, negatives
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    alert("Please enter an amount greater than 0.");
    return;
  }

  const payload = {
    household_id: householdId,
    description,
    category: newRecurring.category || "Uncategorized",
    // Store recurring rule amount as positive; sign is applied later when generating transactions
    amount: Math.abs(amountNum),
    type: newRecurring.type || "expense",
    person: newRecurring.person || "joint",
    frequency: "monthly",
    day_of_month: Number(newRecurring.dayOfMonth) || 1,
    start_date: null,
    end_date: null,
    active: true,
    created_by: session.user.id,
  };

  try {
    const { data, error } = await supabase
      .from("recurring_rules")
      .insert(payload)
      .select("*")
      .single();

    if (error) throw error;

    setRecurringRules((prev) => [data, ...prev]);

    // Clear fields you likely want to re-enter; keep category/type/person sticky
    setNewRecurring((prev) => ({
      ...(prev || {}),
      description: "",
      amount: "",
      dayOfMonth: 1,
    }));
  } catch (e) {
    console.error("[db] addRecurringRule failed", e);
    alert("Could not add recurring rule. Check console for details.");
  }
};



  // ---------------------------------------------------------------------------
  // Recurring transaction helpers (monthly)
  // ---------------------------------------------------------------------------
  const deleteRecurringRule = (id) => {
    setRecurringRules((prev) => prev.filter((r) => r.id !== id));
  };

  const toggleRecurringActive = (id) => {
    setRecurringRules((prev) =>
      prev.map((r) => (r.id === id ? { ...r, active: !r.active } : r))
    );
  };

  const toggleBudgetDetails = (budgetId) => {
  setExpandedBudgets((prev) => {
    const next = !prev[budgetId];

    // if collapsing, reset "show all"
    if (!next) {
      setShowAllBudgetTxns((s) => ({ ...s, [budgetId]: false }));
    }

    return { ...prev, [budgetId]: next };
  });

  setUserToggledBudgets((prev) => ({ ...prev, [budgetId]: true }));
};

const applyRecurringForMonth = async (monthKey, opts = {}) => {
  const { silent = false, ruleIds } = opts;

  const notify = (msg) => {
    if (!silent) alert(msg);
  };

  if (!recurringRules?.length) return notify("No recurring transactions defined yet.");
  if (!monthKey || !/^\d{4}-\d{2}$/.test(monthKey)) return notify("Pick a valid month.");

  const [year, month] = monthKey.split("-");
  const pad2 = (n) => String(n).padStart(2, "0");

  // ✅ NEW: determine which rules to apply
  const hasSelection = Array.isArray(ruleIds) && ruleIds.length > 0;
  const rulesToApply = hasSelection
    ? (recurringRulesByPerson || []).filter((r) => ruleIds.includes(r.id))
    : (recurringRulesByPerson || []);

  const newTxns = [];

  rulesToApply.forEach((rule) => {
    if (!rule.active) return;

    const safeDay = Math.min(Math.max(Number(rule.dayOfMonth) || 1, 1), 31);
    const date = `${year}-${month}-${pad2(safeDay)}`;

    const exists = transactions?.some(
      (t) =>
        t.date === date &&
        t.description === rule.description &&
        Number(t.amount) === Number(rule.amount) &&
        t.type === rule.type &&
        t.person === rule.person
    );

    if (!exists) {
      newTxns.push({
        date,
        description: rule.description,
        category: rule.category,
        amount: Number(rule.amount),
        type: rule.type,
        person: rule.person,
        recurring_rule_id: rule.id,
      });
    }
  });

  if (!newTxns.length) {
    return notify(
      `No new recurring transactions to add for ${monthKey}. They may already exist.`
    );
  }

  // ✅ Persist to DB
  if (canViewData && householdId && session?.user?.id) {
    const payload = newTxns.map((t) => ({
      household_id: householdId,
      date: t.date,
      description: t.description,
      category: t.category,
      amount: t.amount,
      type: t.type,
      person: t.person,
      created_by: session.user.id,
      recurring_rule_id: t.recurring_rule_id,
      applied_month: monthKey,
    }));

    const { data, error } = await supabase
      .from("transactions")
      .upsert(payload, {
        onConflict: "household_id,recurring_rule_id,applied_month",
      })
      .select("*");

    if (error) {
      console.error("[db] applyRecurring failed", error);
      return notify(error.message || "Could not apply recurring items.");
    }

    const inserted = (data ?? []).map((t) => ({ ...t, amount: Number(t.amount) }));
    setTransactions((prev) => [...inserted, ...(prev ?? [])]);

    notify(
      hasSelection
        ? `Added ${inserted.length} selected recurring transaction(s) for ${monthKey}.`
        : `Added ${inserted.length} recurring transaction(s) for ${monthKey}.`
    );
    return;
  }

  // Local-only fallback
  const localRows = newTxns.map((t, idx) => ({ id: Date.now() + idx, ...t }));
  setTransactions((prev) => [...localRows, ...(prev ?? [])]);
  notify(
    hasSelection
      ? `Added ${localRows.length} selected recurring transaction(s) for ${monthKey}.`
      : `Added ${localRows.length} recurring transaction(s) for ${monthKey}.`
  );
};


const autoApplyRecurringForMonth = async (monthKey) => {
  if (!canViewData || !householdId || !session?.user?.id) return;
  if (!recurringRules?.length) return;

  await applyRecurringForMonth(monthKey, { silent: true, source: "auto" });
};

// ------------------------------
// Recurring selection helpers
// ------------------------------
const toggleRecurringSelected = (id) => {
  setSelectedRecurringIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
};

const clearRecurringSelection = () => setSelectedRecurringIds(new Set());

const setSelectAllVisibleRecurring = (visibleRules, checked) => {
  setSelectedRecurringIds((prev) => {
    const next = new Set(prev);
    for (const r of visibleRules) {
      if (checked) next.add(r.id);
      else next.delete(r.id);
    }
    return next;
  });
};

const toggleRecurringSort = (key) => {
  setRecurringSortKey((prevKey) => {
    if (prevKey !== key) {
      setRecurringSortDir("asc");
      return key;
    }
    setRecurringSortDir((d) => (d === "asc" ? "desc" : "asc"));
    return prevKey;
  });
};

const applyRecurringForDate = async (dateStr, opts = {}) => {
  // dateStr: YYYY-MM-DD
  if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    if (!opts?.silent) alert("Pick a valid date (YYYY-MM-DD).");
    return;
  }

  const monthKey = dateStr.slice(0, 7); // YYYY-MM
  return applyRecurringForMonth(monthKey, opts);
};




// ------------------------------
// Recurring derived list (filter + sort)
// ------------------------------
const visibleRecurringRules = useMemo(() => {
  const needle = String(recurringSearch || "").trim().toLowerCase();

  // ✅ base list already respects selectedPerson (and joint passthrough) via filterByPerson
  const base = (recurringRulesByPerson || []).filter((r) => {
    if (!needle) return true;
    return (
      String(r.description || "").toLowerCase().includes(needle) ||
      String(r.category || "").toLowerCase().includes(needle)
    );
  });

  const dir = recurringSortDir === "asc" ? 1 : -1;

  return [...base].sort((a, b) => {
    const av = a?.[recurringSortKey];
    const bv = b?.[recurringSortKey];

    if (recurringSortKey === "amount" || recurringSortKey === "dayOfMonth") {
      return (Number(av || 0) - Number(bv || 0)) * dir;
    }
    if (recurringSortKey === "active") {
      return ((a.active ? 1 : 0) - (b.active ? 1 : 0)) * dir;
    }
    return String(av ?? "").localeCompare(String(bv ?? "")) * dir;
  });
}, [recurringRulesByPerson, recurringSearch, recurringSortKey, recurringSortDir]);


const allVisibleSelected =
  visibleRecurringRules.length > 0 &&
  visibleRecurringRules.every((r) => selectedRecurringIds.has(r.id));

const someVisibleSelected =
  visibleRecurringRules.some((r) => selectedRecurringIds.has(r.id)) && !allVisibleSelected;

// ------------------------------
// Apply Selected (you’ll add the 2 helper functions below)
// ------------------------------
const applySelectedRecurringToMonth = async () => {
  const ids = Array.from(selectedRecurringIds);
  if (!ids.length) {
    alert("Select at least one recurring item to apply.");
    return;
  }
  await applyRecurringForMonth(applyMonth, { ruleIds: ids }); // requires small change to applyRecurringForMonth
};

const applySelectedRecurringToDate = async () => {
  const ids = Array.from(selectedRecurringIds);
  if (!ids.length) {
    alert("Select at least one recurring item to apply.");
    return;
  }
  await applyRecurringForDate(applyRecurringDate, { ruleIds: ids }); // new helper
};

const autoAppliedRef = useRef(new Set());

useEffect(() => {
  if (!canViewData || !householdId || !applyMonth) return;
  if (!recurringRules?.length) return;

  const key = `${householdId}:${applyMonth}`;
  if (autoAppliedRef.current.has(key)) return;

  autoAppliedRef.current.add(key);

  (async () => {
    try {
      await autoApplyRecurringForMonth(applyMonth);
    } catch (e) {
      console.error("[auto-apply] failed", e);
      autoAppliedRef.current.delete(key);
    }
  })();
}, [canViewData, householdId, applyMonth, recurringRules?.length]);



  // ---------------------------------------------------------------------------
  // Delete functions (DB-aware)
  // ---------------------------------------------------------------------------
  const deleteTransaction = async (id) => {
    if (canViewData) {
      const { error } = await supabase.from("transactions").delete().eq("id", id).eq("household_id", householdId);
      if (error) return alert(error.message);
    }
    setTransactions((prev) => prev.filter((t) => t.id !== id));
  };

  const deleteAsset = async (id) => {
    if (canViewData) {
      const { error } = await supabase.from("assets").delete().eq("id", id).eq("household_id", householdId);
      if (error) return alert(error.message);
    }
    setAssets((prev) => prev.filter((a) => a.id !== id));
  };

  const deleteLiability = async (id) => {
    if (canViewData) {
      const { error } = await supabase.from("liabilities").delete().eq("id", id).eq("household_id", householdId);
      if (error) return alert(error.message);
    }
    setLiabilities((prev) => prev.filter((l) => l.id !== id));
  };

 const deleteBudget = async (id) => {
    if (canViewData) {
      const { error } = await supabase.from("budgets").delete().eq("id", id).eq("household_id", householdId);
      if (error) return alert(error.message);
    }
    setBudgets((prev) => prev.filter((b) => b.id !== id));
  };

const deleteProjectDb = async (projectId) => {
  if (!canViewData || !householdId) return;

  // Optional: confirm
  const ok = window.confirm("Delete this project?");
  if (!ok) return;

  const { error } = await supabase
    .from("planned_projects")
    .delete()
    .eq("id", projectId)
    .eq("household_id", householdId);

  if (error) {
    console.error("[projects] delete failed", error);
    alert(error.message || "Could not delete project.");
    return;
  }

  setProjects((prev) => (prev || []).filter((p) => p.id !== projectId));
};

  // ---------------------------------------------------------------------------
  // Edit transaction helpers
  // ---------------------------------------------------------------------------
  const startEditTransaction = (transaction) => {
    setEditingTransactionId(transaction.id);
    setEditTransactionDraft({
      ...transaction,
      amount: transaction.amount.toString(),
    });
  };

  const cancelEditTransaction = () => {
    setEditingTransactionId(null);
    setEditTransactionDraft(null);
  };

 const saveEditTransaction = async () => {
  if (!editTransactionDraft || editingTransactionId == null) return;

  const updated = {
    ...editTransactionDraft,
    amount: parseFloat(editTransactionDraft.amount) || 0,
  };

  const acct = updated.account_id ? accounts.find((a) => Number(a.id) === Number(updated.account_id)) : null;
  const tr = updated.transfer_account_id ? accounts.find((a) => Number(a.id) === Number(updated.transfer_account_id)) : null;
  updated.transaction_type = updated.transaction_type || "normal";
  updated.account_name = acct?.name || "";
  updated.transfer_account_name = tr?.name || "";

  // Optimistic UI update
  setTransactions((prev) =>
    prev.map((t) => (t.id === editingTransactionId ? { ...t, ...updated } : t))
  );

  // Persist (if DB is enabled)
  if (canViewData && householdId && session?.user?.id) {
    const { data, error } = await supabase
      .from("transactions")
      .update({
        date: updated.date,
        description: updated.description,
        amount: updated.amount,
        type: updated.type,
        category: updated.category,
        person: updated.person,
        account_id: updated.account_id || null,
        transaction_type: updated.transaction_type || "normal",
        transfer_account_id: (updated.transaction_type === "transfer" ? (updated.transfer_account_id || null) : null),
      })
      .eq("id", editingTransactionId)
      .eq("household_id", householdId)
      .select("*")
      .single();

    if (error) {
      console.error("[db] saveEditTransaction failed", error);
      alert(error.message || "Could not save transaction. Check console.");
      return; // keep edit mode open if desired (see note below)
    }

    // Ensure amount is numeric + keep state in sync with DB
    const acct = data.account_id ? accounts.find((a) => Number(a.id) === Number(data.account_id)) : null;
    const tr = data.transfer_account_id ? accounts.find((a) => Number(a.id) === Number(data.transfer_account_id)) : null;
    setTransactions((prev) =>
      prev.map((t) =>
        t.id === editingTransactionId
          ? {
              ...data,
              amount: Number(data.amount),
              transaction_type: data.transaction_type || "normal",
              account_name: acct?.name || "",
              transfer_account_name: tr?.name || "",
            }
          : t
      )
    );
  }

  // Close edit mode
  setEditingTransactionId(null);
  setEditTransactionDraft(null);
};

const isMonthOpen = (monthKey) => openMonths.has(monthKey);

const toggleMonth = (monthKey) => {
  setOpenMonths((prev) => {
    const next = new Set(prev);
    if (next.has(monthKey)) next.delete(monthKey);
    else next.add(monthKey);
    return next;
  });
};

const expandAllMonths = () => {
  setOpenMonths(new Set(groupedTransactionsByMonth.map((g) => g.monthKey)));
};

const collapseAllMonths = () => {
  setOpenMonths(new Set());
};

//  ----------------------------------------------------------------------------
//  Monthly summary cards at top (respects selectedPerson)
//  ----------------------------------------------------------------------------
const selectedMonth = applyMonth || currentMonth;

const monthTotals = useMemo(() => {
  if (!selectedMonth) return { income: 0, expenses: 0, net: 0 };

  const monthTxns = (transactionsByPerson || []).filter((t) =>
    String(t.date || "").startsWith(selectedMonth)
  );

  let income = 0;
  let expenses = 0;

  for (const t of monthTxns) {
    if ((t.transaction_type || "normal") === "transfer") continue;

    const amt = Math.abs(Number(t.amount || 0));

    if (t.type === "income") income += amt;
    if (t.type === "expense") expenses += amt;
  }

  return { income, expenses, net: income - expenses };
}, [transactionsByPerson, selectedMonth]);


const projectsQuoteSubtotal = useMemo(() => {
  return (projects ?? []).reduce((sum, p) => {
    const val =
      p?.quotedAmount != null
        ? Number(p.quotedAmount)
        : p?.quoted_amount != null
          ? Number(p.quoted_amount)
          : 0;

    return sum + (Number.isFinite(val) ? val : 0);
  }, 0);
}, [projects]);


//   ---------------------------------------------------------------------------
//   Forecast calculation (no DB calls)
//   ---------------------------------------------------------------------------
const addMonths = (yyyyMm, delta) => {
  const [y, m] = yyyyMm.split("-").map(Number);
  const d = new Date(y, (m - 1) + delta, 1);
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${yy}-${mm}`;
};

const forecastRows = useMemo(() => {
  const base = (applyMonth || currentMonth);
  if (!base) return [];

  const monthsAhead = 6; // change to 3 or 6
  const rows = [];

  for (let i = 0; i < monthsAhead; i++) {
    const monthKey = addMonths(base, i);

    let income = 0;
    let expenses = 0;

    for (const r of (recurringRulesByPerson || [])) {
      if (!r.active) continue;
      const amt = Number(r.amount || 0);
      if (r.type === "income") income += amt;
      else expenses += amt;
    }

    rows.push({
      monthKey,
      income,
      expenses,
      net: income - expenses,
    });

    const monthTxns = transactionsByPerson.filter(
  	(t) => t.date && t.date.startsWith(monthKey)
	);

	for (const t of monthTxns) {
  		const amt = Number(t.amount || 0);
  		if (t.type === "income") income += amt;
  		else expenses += amt;
	}
  }
  return rows;
}, [recurringRulesByPerson, applyMonth, currentMonth]);


  // ---------------------------------------------------------------------------
  // Edit helpers (Budgets / Assets / Liabilities/Recurring Rules/Projects)
  // ---------------------------------------------------------------------------
  
const startEditBudget = (b) =>
  startEditBudgetHelper(b, { setEditingBudgetId, setEditBudgetDraft });

const cancelEditBudget = () =>
  cancelEditBudgetHelper({ setEditingBudgetId, setEditBudgetDraft });

const saveEditBudget = async () => {
  await saveEditBudgetHelper({
    editBudgetDraft,
    editingBudgetId,
    canViewData,
    householdId,
    supabase,
    monthToDb,
    toMonthKey,
    setBudgets,
    cancelEditBudget,
  });
};

  const startEditLiability = (l) =>
  startEditLiabilityHelper({
    l,
    setEditingLiabilityId,
    setEditLiabilityDraft,
  });

const cancelEditLiability = () =>
  cancelEditLiabilityHelper({
    setEditingLiabilityId,
    setEditLiabilityDraft,
  });

  const saveEditLiability = async () =>
  saveEditLiabilityHelper({
    editLiabilityDraft,
    editingLiabilityId,
    canViewData,
    householdId,
    supabase,
    setLiabilities,
    cancelEditLiability, // important: pass the wrapper
  });

  const startEditAsset = (a) =>
  startEditAssetHelper({
    a,
    setEditingAssetId,
    setEditAssetDraft,
  });

const cancelEditAsset = () =>
  cancelEditAssetHelper({
    setEditingAssetId,
    setEditAssetDraft,
  });

const saveEditAsset = async () =>
  saveEditAssetHelper({
    editAssetDraft,
    editingAssetId,
    canViewData,
    householdId,
    supabase,
    setAssets,
    cancelEditAsset, // important: pass the wrapper
  });
 
  const startEditRecurringRule = (r) => {
  setEditingRecurringRuleId(r.id);
  setEditRecurringDraft({
    description: r.description || "",
    category: r.category || "Food",
    amount: String(r.amount ?? ""),
    type: r.type || "expense",
    person: r.person || "joint",
    dayOfMonth: String(r.dayOfMonth ?? 1),
  });
  };

  const cancelEditRecurringRule = () => {
  setEditingRecurringRuleId(null);
  setEditRecurringDraft(null);
  };

  const saveEditRecurringRule = async () => {
  if (!editRecurringDraft || !editingRecurringRuleId) return;

  const updated = {
    ...editRecurringDraft,
    amount: Number(editRecurringDraft.amount || 0),
    dayOfMonth: Math.min(Math.max(Number(editRecurringDraft.dayOfMonth) || 1, 1), 31),
  };

  // DB-aware update
  if (canViewData && householdId) {
    const payload = {
      description: String(updated.description || "").trim(),
      category: updated.category,
      amount: updated.amount,
      type: updated.type,
      person: updated.person,
      day_of_month: updated.dayOfMonth,
    };

    const { data, error } = await supabase
      .from("recurring_rules")
      .update(payload)
      .eq("id", editingRecurringRuleId)
      .eq("household_id", householdId)
      .select("*")
      .single();

    if (error) {
      alert(error.message);
      return;
    }

    setRecurringRules((prev) =>
      prev.map((x) =>
        x.id === editingRecurringRuleId
          ? {
              ...x,
              ...data,
              dayOfMonth: data.day_of_month ?? x.dayOfMonth,
            }
          : x
      )
    );
  } else {
    // local fallback
    setRecurringRules((prev) =>
      prev.map((x) =>
        x.id === editingRecurringRuleId
          ? { ...x, ...updated, dayOfMonth: updated.dayOfMonth }
          : x
      )
    );
  }

  cancelEditRecurringRule();
};
// Persist pause/resume
const toggleRecurringActiveDb = async (rule) => {
  const nextActive = !rule.active;

  if (canViewData && householdId) {
    const { error } = await supabase
      .from("recurring_rules")
      .update({ active: nextActive })
      .eq("id", rule.id)
      .eq("household_id", householdId);

    if (error) {
      alert(error.message);
      return;
    }
  }

  setRecurringRules((prev) =>
    prev.map((r) => (r.id === rule.id ? { ...r, active: nextActive } : r))
  );
};

// Persist delete
const deleteRecurringRuleDb = async (id) => {
  if (canViewData && householdId) {
    const { error } = await supabase
      .from("recurring_rules")
      .delete()
      .eq("id", id)
      .eq("household_id", householdId);

    if (error) {
      alert(error.message);
      return;
    }
  }

  setRecurringRules((prev) => prev.filter((r) => r.id !== id));
};

const startEditProject = (p) => {
  setEditingProjectId(p.id);
  setEditProjectDraft({
    name: p.name || "",
    vendor: p.vendor || "",
    quotedAmount: p.quoted_amount ?? p.quotedAmount ?? "",
    targetMonth: p.target_month ?? p.targetMonth ?? currentMonth,
    notes: p.notes || "",
  });
	setEditProjectFiles([]); // reset new uploads
};

const cancelEditProject = () => {
  setEditingProjectId(null);
  setEditProjectDraft(null);
};

const saveEditProjectDb = async () => {
  if (!editingProjectId || !editProjectDraft) return;
  if (!canViewData || !householdId) return;

  const name = String(editProjectDraft.name || "").trim();
  if (!name) return alert("Project name is required.");

  const payload = {
    name,
    vendor: String(editProjectDraft.vendor || "").trim() || null,
    quoted_amount: Number(editProjectDraft.quotedAmount || 0),
    target_month: editProjectDraft.targetMonth || currentMonth,
    notes: String(editProjectDraft.notes || "").trim() || null,
  };

  const { data, error } = await supabase
    .from("planned_projects")
    .update(payload)
    .eq("id", editingProjectId)
    .eq("household_id", householdId)
    .select("*")
    .single();

  if (error) {
    console.error("[projects] update failed", error);
    alert(error.message || "Could not update project.");
    return;
  }

  setProjects((prev) =>
    (prev || []).map((p) =>
      p.id === editingProjectId
        ? {
            ...p,
            ...data,
            quotedAmount: Number(data.quoted_amount ?? data.quotedAmount ?? p.quotedAmount ?? 0),
            targetMonth: data.target_month ?? data.targetMonth ?? p.targetMonth,
            quotePath: data.quote_file_path ?? data.quotePath ?? p.quotePath,
          }
        : p
    )
  );
// 2) ✅ Persist any newly-added files for this existing project
  if (editProjectFiles?.length) {
    await uploadFilesForExistingProject(editingProjectId);
    // uploadFilesForExistingProject already does:
    // - upload to Storage
    // - insert rows into project_files
    // - setProjectFiles(...)
    // - setEditProjectFiles([])
  }

  // 3) Close edit mode AFTER file insert finishes

  cancelEditProject();
};

const getSignedQuoteUrl = async (filePath) => {
  if (!filePath) return null;

  const { data, error } = await supabase.storage
    .from(PROJECT_QUOTES_BUCKET) // "project_quotes"
    .createSignedUrl(filePath, 60 * 5); // 5 minutes

  if (error) {
    console.warn("[projects] signed url failed", error);
    alert(error.message || "Could not open file.");
    return null;
  }

  return data?.signedUrl || null;
};

const handleOpenQuote = async (p) => {
  const path = p.quoteFilePath || p.quote_file_path || null; // whichever you store
  if (!path) return;

  const url = await getSignedQuoteUrl(path);
  if (!url) return;

  // Instead of window.open(...) right away, store it and render a normal <a>
  setPendingOpenUrl(url);
  setPendingOpenName(p.name || "Quote");
};

const uploadFilesForExistingProject = async (projectId, filesOverride = null) => {
  const files =
    filesOverride != null
      ? Array.from(filesOverride)
      : Array.from(editProjectFiles ?? []);

  if (!files?.length) return alert("Pick one or more files first.");
  if (!canViewData || !householdId || !session?.user?.id) return alert("Sign in first.");

  let uploaded = [];
  try {
    uploaded = await uploadProjectQuoteFiles({
      householdId,
      projectId,
      files,
    });

    if (!uploaded?.length) return;

    const rows = uploaded.map((u, idx) => {
      const file = files[idx];
      return {
        household_id: householdId,
        project_id: projectId,
        file_name: file?.name ?? u.fileName,
        file_path: u.path,
        mime_type: file?.type || null,
        size_bytes: file?.size ?? null,
        created_by: session.user.id,
      };
    });

    const { data, error } = await supabase
      .from("project_files")
      .insert(rows)
      .select("*");

    if (error) {
      try {
        const paths = uploaded.map((u) => u.path).filter(Boolean);
        if (paths.length) await supabase.storage.from(PROJECT_QUOTES_BUCKET).remove(paths);
      } catch (cleanupErr) {
        console.warn("[projects] cleanup remove failed", cleanupErr);
      }

      console.warn("[db] project_files insert failed", error);
      alert(error.message || "Could not save file record(s).");
      return;
    }

    const newRows = (data ?? []).map((f) => ({
      id: f.id,
      householdId: f.household_id,
      projectId: f.project_id,
      fileName: f.file_name,
      filePath: f.file_path,
      mimeType: f.mime_type,
      sizeBytes: f.size_bytes,
      createdBy: f.created_by,
      createdAt: f.created_at,
    }));

    setProjectFiles((prev) => [...newRows, ...(prev ?? [])]);

    // Only clear staged state if we're using the staged path
    if (filesOverride == null) setEditProjectFiles([]);

    alert(`Uploaded ${newRows.length} file(s).`);
  } catch (e) {
    console.warn("[projects] uploadFilesForExistingProject failed", e);
    alert(e?.message || "Upload failed. Please try again.");
  }
};


const deleteProjectFileDb = async (fileRow) => {
  if (!fileRow?.id) return;
  if (!canViewData || !householdId || !session?.user?.id) {
    return alert("Sign in first.");
  }

  const ok = window.confirm(`Delete file "${fileRow.fileName || "file"}"?`);
  if (!ok) return;

  // 1) Delete DB row first (so UI state matches DB even if storage fails)
  const { error: dbErr } = await supabase
    .from("project_files")
    .delete()
    .eq("id", fileRow.id)
    .eq("household_id", householdId);

  if (dbErr) {
    console.warn("[db] delete project_files failed", dbErr);
    alert(dbErr.message || "Could not delete file record.");
    return;
  }

  // 2) Best-effort delete from Storage (don’t block UI if this fails)
  const path = fileRow.filePath;
  if (path) {
    const { error: stErr } = await supabase.storage
      .from(PROJECT_QUOTES_BUCKET)
      .remove([path]);

    if (stErr) {
      console.warn("[storage] remove failed", stErr);
      // optional: alert, but usually I just log this
    }
  }

  // 3) Update UI
  setProjectFiles((prev) => (prev ?? []).filter((f) => f.id !== fileRow.id));
};


const replaceProjectFile = async ({ projectId, oldFileRow, newFile }) => {
  if (!projectId || !oldFileRow?.id || !newFile) return;
  if (!canViewData || !householdId || !session?.user?.id) {
    return alert("Sign in first.");
  }

  const ok = window.confirm(
    `Replace "${oldFileRow.fileName || "file"}" with "${newFile.name}"?\n\n` +
      `Tip: This will keep a history entry (new row).`
  );
  if (!ok) return;

  // 1) Upload new file to storage
  const uploaded = await uploadProjectQuoteFiles({
    householdId,
    projectId,
    files: [newFile],
  });

  const u = uploaded?.[0];
  if (!u?.path) return alert("Upload failed.");

  // 2) Insert new DB row (this is the “versioning”)
  const row = {
    household_id: householdId,
    project_id: projectId,
    file_name: newFile.name,
    file_path: u.path,
    mime_type: newFile.type || null,
    size_bytes: newFile.size ?? null,
    created_by: session.user.id,
    // Optional (only if your table has it): replaces_file_id: oldFileRow.id,
  };

  const { data, error } = await supabase
    .from("project_files")
    .insert(row)
    .select("*")
    .single();

  if (error) {
    // Cleanup storage if DB insert failed
    try {
      await supabase.storage.from(PROJECT_QUOTES_BUCKET).remove([u.path]);
    } catch (cleanupErr) {
      console.warn("[projects] cleanup remove failed", cleanupErr);
    }
    console.warn("[db] insert project_files failed", error);
    return alert(error.message || "Could not save replacement file record.");
  }

  // 3) Update UI (prepend newest)
  const uiRow = {
    id: data.id,
    householdId: data.household_id,
    projectId: data.project_id,
    fileName: data.file_name,
    filePath: data.file_path,
    mimeType: data.mime_type,
    sizeBytes: data.size_bytes,
    createdBy: data.created_by,
    createdAt: data.created_at,
  };

  setProjectFiles((prev) => [uiRow, ...(prev ?? [])]);

  // 4) Optional: delete the old one (DB + storage)
  // If you want “replace truly replaces”, uncomment this:
  // await deleteProjectFileDb(oldFileRow);
};


  // ---------------------------------------------------------------------------
  // Clear all
  // ---------------------------------------------------------------------------
  const clearAllData = async () => {
    if (!window.confirm("Are you sure you want to clear all data? This cannot be undone.")) {
      return;
    }

    try {
      if (storage) {
        await Promise.all([
          storage.delete("finance-transactions"),
          storage.delete("finance-assets"),
          storage.delete("finance-liabilities"),
          storage.delete("finance-budgets"),
          storage.delete("finance-recurring-rules"),
        ]);
      }

      setTransactions([]);
      setAssets([]);
      setLiabilities([]);
      setBudgets([]);
      setRecurringRules([]);

      alert("All data has been cleared successfully.");
    } catch (error) {
      console.error("Error clearing data:", error);
      alert("Error clearing data. Please try again.");
    }
  };

  const personLabels = {
    joint: "Joint",
    you: "You",
    wife: "Wife",
  };


  // ---------------------------------------------------------------------------
  // Loading state
  // ---------------------------------------------------------------------------
  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-indigo-600 mx-auto mb-4"></div>
          <p className="text-gray-600">Loading your financial data…</p>
        </div>
      </div>
    );
  }

const isTransferTxn = (t) => (t.transaction_type || "normal") === "transfer";
const toNum = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const absAmt = (t) => Math.abs(toNum(t.amount));

// Transfers total (excluded)
const excludedTransfersTotal = (filteredTransactions || [])
  .filter(isTransferTxn)
  .reduce((sum, t) => sum + absAmt(t), 0);

// Dashboard: exclude transfers from spending/income
const dashboardTransactions = (filteredTransactions || []).filter(
  (t) => !isTransferTxn(t)
);

// Spending-only transactions (expenses, excluding transfers)
const dashboardExpenseTxns = dashboardTransactions.filter(
  (t) => t.type === "expense"
);

// Category totals for donut chart (spend totals should be positive)
const categoryTotals = dashboardExpenseTxns.reduce((acc, t) => {
  const cat = t.category || "Uncategorized";
  acc[cat] = (acc[cat] || 0) + absAmt(t);
  return acc;
}, {});

// Monthly spending totals (positive)
const monthlyTotals = dashboardExpenseTxns.reduce((acc, t) => {
  const month = String(t.date || "").slice(0, 7) || "Unknown";
  acc[month] = (acc[month] || 0) + absAmt(t);
  return acc;
}, {});



  // Net worth history (fake initial values, expands once you add history)
  const netWorthHistory = [
    { date: "2024-10-01", netWorth: totalAssets - totalLiabilities - 10000 },
    { date: "2024-11-01", netWorth: totalAssets - totalLiabilities - 5000 },
    { date: "2024-12-01", netWorth: totalAssets - totalLiabilities },
  ];

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (

    <div className="relative">
    {/* Your normal app UI (blurred + disabled until authenticated + household joined) */}
    <div className={canViewData ? "" : "pointer-events-none blur-sm select-none"}>
    <div className="min-h-screen bg-gradient-to-br from-blue-50 to-indigo-100 p-6">
	 {/* Owner-only tools */}
  	{isOwner && canViewData && (
  		<InviteMember session={session} householdId={householdId} />
	)}

      <div className="max-w-7xl mx-auto">
        <div className="bg-white rounded-xl shadow-lg p-6 mb-6">
          <div className="flex justify-between items-center mb-4">
            <div>
              <h1 className="text-3xl font-bold text-gray-800">
                Family Finance Tracker
              </h1>
              <p className="text-sm text-green-600 mt-1">✓ Data automatically saved</p>
            </div>
            <div className="flex gap-2">
              {["joint", "you", "wife"].map((person) => (
                <button
                  key={person}
                  onClick={() => setSelectedPerson(person)}
                  className={`px-4 py-2 rounded-lg font-medium transition-colors ${
                    selectedPerson === person
                      ? "bg-indigo-600 text-white"
                      : "bg-gray-200 text-gray-700 hover:bg-gray-300"
                  }`}
                >
                  {personLabels[person]}
                </button>
              ))}
            </div>
		{import.meta.env.DEV && (
  		<button
    		onClick={() => {
      		setHouseholdId(null);
      		setHouseholdGateOpen(true);
    		}}
    		className="text-xs text-gray-500 underline mt-4"
  		>
    		Reset household gate (testing)
  		</button>
		)}

          </div>

<div className="flex gap-2 border-b">
  {[
    { key: "dashboard", label: "Dashboard" },
    { key: "transactions", label: "Transactions" },
    { key: "assets", label: "Assets" },
    { key: "liabilities", label: "Liabilities" },
    { key: "budget", label: "Budget" },
    { key: "projects", label: "Projects" },
    { key: "trends", label: "Trends" },
  ].map(({ key, label }) => (
    <button
      key={key}
      onClick={() => setActiveTab(key)}
      className={`px-4 py-2 font-medium ${
        activeTab === key
          ? "text-indigo-600 border-b-2 border-indigo-600"
          : "text-gray-600 hover:text-indigo-600"
      }`}
    >
      {label}
    </button>
  ))}

  <button
    onClick={clearAllData}
    className="ml-auto px-4 py-2 text-sm text-red-600 hover:text-red-800"
  >
    Clear All Data
  </button>
</div>

        </div>

        {/* DASHBOARD TAB */}
        {activeTab === "dashboard" && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
              <div className="bg-white rounded-lg shadow p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-gray-600 text-sm">Total Income</p>
                    <p className="text-2xl font-bold text-green-600">
                      ${totalIncome.toLocaleString()}
                    </p>
                  </div>
                  <TrendingUp className="text-green-600" size={32} />
                </div>
              </div>

              <div className="bg-white rounded-lg shadow p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-gray-600 text-sm">Total Expenses</p>
                    <p className="text-2xl font-bold text-red-600">
                      ${totalExpenses.toLocaleString()}
                    </p>
                  </div>
                  <TrendingDown className="text-red-600" size={32} />
                </div>
              </div>

              <div className="bg-white rounded-lg shadow p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-gray-600 text-sm">Balance</p>
                    <p className="text-2xl font-bold text-blue-600">
                      ${(totalIncome - totalExpenses).toLocaleString()}
                    </p>
                  </div>
                  <DollarSign className="text-blue-600" size={32} />
                </div>
              </div>

	  <div className="bg-white rounded-lg shadow p-6">
              <div className="flex items-start justify-between">
     		<div>
      		  <p className="text-gray-600 text-sm">Transfers/Payments (excluded from txns.)</p>
      		  <p className="text-2xl font-bold text-gray-700">
        	    ${excludedTransfersTotal.toLocaleString()}
      		  </p>
    		</div>
    		<ArrowLeftRight className="text-gray-700" size={32} />
  	     </div>
	  </div>
   	    <div className="bg-white rounded-lg shadow p-6">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-gray-600 text-sm">Net Worth</p>
                    <p className="text-2xl font-bold text-indigo-600">
                      ${netWorth.toLocaleString()}
                    </p>
                  </div>
                  <Wallet className="text-indigo-600" size={32} />
                </div>
            </div>

            </div>


            <div className="flex gap-2 mb-4">
              {[
                { id: "this-month", label: "This Month" },
                { id: "last-month", label: "Last Month" },
                { id: "three-months", label: "Last 3 Months" },
                { id: "ytd", label: "Year to Date" },
                { id: "custom", label: "Custom" },
              ].map((opt) => (
                <button
                  key={opt.id}
                  onClick={() => setDateRange(opt.id)}
                  className={`px-3 py-2 rounded-md text-sm font-medium ${
                    dateRange === opt.id
                      ? "bg-indigo-600 text-white"
                      : "bg-gray-200 hover:bg-gray-300"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>

            {dateRange === "custom" && (
              <div className="flex items-center gap-3 mb-4">
                <input
                  type="date"
                  value={customRange.start}
                  onChange={(e) => setCustomRange({ ...customRange, start: e.target.value })}
                  className="border px-3 py-2 rounded"
                />
                <span>to</span>
                <input
                  type="date"
                  value={customRange.end}
                  onChange={(e) => setCustomRange({ ...customRange, end: e.target.value })}
                  className="border px-3 py-2 rounded"
                />
              </div>
            )}

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
              <IncomeExpensesChart income={totalIncome} expenses={totalExpenses} />
              <AssetsLiabilitiesChart assets={totalAssets} liabilities={totalLiabilities} />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
              <CategoryDonutChart categoryTotals={categoryTotals} />
              <MonthlySpendingChart monthlyTotals={monthlyTotals} />
            </div>

            <div className="mt-6">
              <NetWorthChart history={netWorthHistory} />
            </div>

            {/* Budget Overview (current month) */}
            <div className="bg-white rounded-lg shadow p-6">
              <h2 className="text-xl font-bold text-gray-800 mb-4">
                Current Month Budget Overview
              </h2>
              <div className="space-y-4">
                {categories.map((category) => {
                  const progress = getBudgetProgress(category, currentMonth);
                  if (!progress) return null;

		// If you want rollover to apply here too:
  		const rollover = rolloverEnabled
    ? Number(rolloverByCategoryForViewMonth?.[category] || 0) // or a currentMonth-specific rollover map (see note)
    : 0;

  		const baseBudget = Number(progress.budget || 0);
  		const effectiveBudget = Math.max(0, baseBudget + rollover);

  		const spent = Number(progress.spent || 0);
  		const effectivePct = effectiveBudget > 0 ? (spent / effectiveBudget) * 100 : 0;

                  return (
                    <div key={category}>
                      <div className="flex justify-between mb-1">
                        <span className="font-medium">{category}</span>
                        <span className="text-sm text-gray-600">
                          ${progress.spent.toFixed(0)} / ${progress.budget.toFixed(0)}
                        </span>
                      </div>
                      <div className="w-full bg-gray-200 rounded-full h-3">
                        <div
                          className={`h-3 rounded-full transition-all ${getProgressColor(
                            effectivePct
                          )}`}
                          style={{ width: `${Math.min(effectivePct, 100)}%` }}
                        />
                      </div>
                      <div className="text-xs text-gray-500 mt-1">
                        {effectivePct.toFixed(1)}% used
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Assets vs Liabilities + Recent Transactions */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <div className="bg-white rounded-lg shadow p-6">
                <h2 className="text-xl font-bold text-gray-800 mb-4">
                  Assets vs Liabilities
                </h2>
                <div className="space-y-2">
                  <div className="flex justify-between">
                    <span className="text-gray-600">Total Assets:</span>
                    <span className="font-bold text-green-600">
                      ${totalAssets.toLocaleString()}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600">Total Liabilities:</span>
                    <span className="font-bold text-red-600">
                      ${totalLiabilities.toLocaleString()}
                    </span>
                  </div>
                  <div className="border-t pt-2 flex justify-between">
                    <span className="text-gray-800 font-semibold">Net Worth:</span>
                    <span className="font-bold text-indigo-600">
                      ${netWorth.toLocaleString()}
                    </span>
                  </div>
                </div>
              </div>

              <div className="bg-white rounded-lg shadow p-6">
                <h2 className="text-xl font-bold text-gray-800 mb-4">
                  Recent Transactions
                </h2>
                <div className="space-y-2">
{filteredTransactions
  .slice(-5)
  .reverse()
  .map((t) => {
    const isTransfer = (t.transaction_type || "normal") === "transfer";
    const isIncome = t.type === "income";

    return (
      <div key={t.id} className="flex justify-between items-center">
        <div>
          <div className="flex items-center gap-2">
            <p className="font-medium">{t.description}</p>

            {t.recurring_rule_id ? (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-indigo-100 text-indigo-700">
                Recurring
              </span>
            ) : null}

            {isTransfer ? (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-gray-100 text-gray-700">
                Transfer
              </span>
            ) : null}
          </div>

          <p className="text-xs text-gray-500">
            {t.date} • {personLabels[t.person]}
          </p>
        </div>

        <span
          className={`font-bold ${
            isTransfer
              ? "text-gray-700"
              : isIncome
              ? "text-green-600"
              : "text-red-600"
          }`}
        >
          {isTransfer ? "" : isIncome ? "+" : "-"}${Number(t.amount).toFixed(2)}
        </span>
      </div>
    );
  })}

                </div>
              </div>
            </div>
          </div>
        )}

        {/* TRANSACTIONS TAB */}
        {activeTab === "transactions" && (
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-xl font-bold text-gray-800 mb-4">Transactions</h2>

            <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4 mb-4">
              <div className="flex-1">
                <SmartTransactionImport
                  accounts={accounts}
                  selectedPerson={selectedPerson}
                  onImport={importTransactions}
                />

                {/* Accounts manager */}
                <div className="mt-4 border rounded-lg p-4 bg-white">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-gray-800">Accounts</div>
                      <div className="text-xs text-gray-500">Add Checking/Savings + Credit cards (Amex, Chase, etc.) for clean transfer handling.</div>
                    </div>
                  </div>

                  <div className="mt-3 grid grid-cols-1 md:grid-cols-4 gap-2">
                    <input
                      value={newAccount.name}
                      onChange={(e) => setNewAccount((p) => ({ ...p, name: e.target.value }))}
                      placeholder="Name (e.g., Amex Gold)"
                      className="border rounded px-3 py-2 text-sm"
                    />
                    <input
                      value={newAccount.institution}
                      onChange={(e) => setNewAccount((p) => ({ ...p, institution: e.target.value }))}
                      placeholder="Institution (optional)"
                      className="border rounded px-3 py-2 text-sm"
                    />
                    <select
                      value={newAccount.account_type}
                      onChange={(e) => setNewAccount((p) => ({ ...p, account_type: e.target.value }))}
                      className="border rounded px-3 py-2 text-sm"
                    >
                      <option value="checking">Checking</option>
                      <option value="savings">Savings</option>
                      <option value="credit">Credit card</option>
                    </select>
                    <button
                      type="button"
                      onClick={addAccount}
                      className="bg-gray-800 text-white text-sm px-3 py-2 rounded-md hover:bg-gray-900"
                    >
                      Add account
                    </button>
                  </div>

                  <div className="mt-3 overflow-x-auto">
                    <table className="min-w-full text-sm">
                      <thead className="bg-gray-50">
                        <tr>
                          <th className="px-3 py-2 text-left">Name</th>
                          <th className="px-3 py-2 text-left">Institution</th>
                          <th className="px-3 py-2 text-left">Type</th>
                          <th className="px-3 py-2 text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(accounts || []).map((a) => (
                          <tr key={a.id} className="border-t">
                            <td className="px-3 py-2 font-medium">{a.name}</td>
                            <td className="px-3 py-2 text-gray-600">{a.institution || ""}</td>
                            <td className="px-3 py-2">
                              <span className="text-xs bg-gray-50 border border-gray-200 text-gray-700 px-2 py-1 rounded-full">
                                {a.account_type}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-right">
                              <button
                                type="button"
                                onClick={() => deleteAccount(a.id)}
                                className="inline-flex items-center gap-1 text-red-600 hover:text-red-700"
                                title="Delete account"
                              >
                                <Trash2 size={16} />
                                Delete
                              </button>
                            </td>
                          </tr>
                        ))}
                        {(!accounts || accounts.length === 0) && (
                          <tr className="border-t">
                            <td className="px-3 py-3 text-gray-500" colSpan={4}>
                              No accounts yet. Add Checking + your credit cards to enable transfer tagging.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>

              <div className="md:w-auto">
                <button
                  type="button"
                  onClick={exportTransactionsAsCsv}
                  className="w-full md:w-auto bg-gray-800 text-white text-sm px-4 py-2 rounded-md hover:bg-gray-900"
                >
                  Export Transactions CSV
                </button>
                <p className="mt-1 text-xs text-gray-500">
                  Exports all transactions for:{" "}
                  <strong>{personLabels[selectedPerson]}</strong>
                </p>
              </div>
            </div>

{/* ------------------------------------------------------------------ */}
{/* Recurring Transactions Manager */}
{/* ------------------------------------------------------------------ */}
<div className="bg-white rounded-lg shadow p-6 mb-8">
  {/* Header (collapsible) */}
  <button
    type="button"
    onClick={() => setRecurringOpen((v) => !v)}
    className="w-full flex items-center justify-between"
  >
    <div className="flex items-center gap-3">
      <h2 className="text-xl font-semibold">Recurring Transactions</h2>
      <span className="text-xs text-gray-500">
        Showing rules for: <span className="font-semibold">{personLabels[selectedPerson] || selectedPerson}</span>
      </span>
      <span className="text-xs text-gray-500">
        • {visibleRecurringRules.length} rule{visibleRecurringRules.length === 1 ? "" : "s"}
      </span>
      {selectedRecurringIds.size > 0 && (
        <span className="text-xs text-indigo-700 bg-indigo-50 border border-indigo-200 px-2 py-1 rounded-full">
          {selectedRecurringIds.size} selected
        </span>
      )}
    </div>

    <span className="text-lg text-indigo-700 leading-none">{recurringOpen ? "show less ▾" : "Show Recurring ▸"}</span>
  </button>

  {!recurringOpen ? null : (
    <>
      {/* Controls row */}
      <div className="mt-4 grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
        {/* Search */}
        <div className="md:col-span-4">
          <label className="text-xs text-gray-500">Search (description/category)</label>
          <input
            type="text"
            value={recurringSearch}
            onChange={(e) => setRecurringSearch(e.target.value)}
            className="border rounded px-3 py-2 w-full"
            placeholder="e.g. generator, utilities, food…"
          />
        </div>

        {/* Sort */}
        <div className="md:col-span-4">
          <label className="text-xs text-gray-500">Sort</label>
          <div className="flex gap-2">
            <select
              value={recurringSortKey}
              onChange={(e) => setRecurringSortKey(e.target.value)}
              className="border rounded px-3 py-2 w-full"
            >
              <option value="description">Description</option>
              <option value="category">Category</option>
              <option value="amount">Amount</option>
              <option value="type">Type</option>
              <option value="person">Person</option>
              <option value="dayOfMonth">Day of Month</option>
              <option value="active">Active</option>
            </select>
            <button
              type="button"
              onClick={() => setRecurringSortDir((d) => (d === "asc" ? "desc" : "asc"))}
              className="border rounded px-3 py-2 text-sm"
              title="Toggle sort direction"
            >
              {recurringSortDir === "asc" ? "↑" : "↓"}
            </button>
          </div>
        </div>

        {/* Apply mode */}
        <div className="md:col-span-4">
          <label className="text-xs text-gray-500">Apply selected</label>
          <div className="flex gap-2">
            <select
              value={applyRecurringMode}
              onChange={(e) => setApplyRecurringMode(e.target.value)}
              className="border rounded px-3 py-2"
            >
              <option value="month">To month</option>
              <option value="date">To date</option>
            </select>

            {applyRecurringMode === "month" ? (
              <>
                <input
                  type="month"
                  value={applyMonth}
                  onChange={(e) => setApplyMonth(e.target.value)}
                  className="border rounded px-3 py-2"
                />
                <button
                  type="button"
                  onClick={applySelectedRecurringToMonth}
                  className="bg-indigo-600 text-white rounded px-4 py-2 hover:bg-indigo-700"
                >
                  Apply Selected
                </button>
              </>
            ) : (
              <>
                <input
                  type="date"
                  value={applyRecurringDate}
                  onChange={(e) => setApplyRecurringDate(e.target.value)}
                  className="border rounded px-3 py-2"
                />
                <button
                  type="button"
                  onClick={applySelectedRecurringToDate}
                  className="bg-indigo-600 text-white rounded px-4 py-2 hover:bg-indigo-700"
                >
                  Apply Selected
                </button>
              </>
            )}
          </div>

          <div className="flex gap-3 mt-2">
            <button
              type="button"
              onClick={() => {
                if (visibleRecurringRules.length === 0) return;
                setSelectAllVisibleRecurring(visibleRecurringRules, true);
              }}
              className="text-xs text-indigo-700 hover:text-indigo-900"
            >
              Select all (visible)
            </button>
            <button
              type="button"
              onClick={() => {
                if (visibleRecurringRules.length === 0) return;
                setSelectAllVisibleRecurring(visibleRecurringRules, false);
              }}
              className="text-xs text-gray-600 hover:text-gray-800"
            >
              Clear (visible)
            </button>
            <button
              type="button"
              onClick={clearRecurringSelection}
              className="text-xs text-gray-600 hover:text-gray-800"
            >
              Clear all
            </button>
          </div>
        </div>
      </div>

      {/* Keep your existing "Apply all for month" behavior (optional) */}
      <div className="mt-5 flex items-center gap-3">
        <button
          type="button"
          onClick={() => applyRecurringForMonth(applyMonth)}
          className="bg-gray-900 text-white rounded px-4 py-2 hover:bg-black"
          title="Apply ALL active recurring items for the selected month"
        >
          Apply ALL for {applyMonth}
        </button>

        <span className="text-xs text-gray-500">
          Tip: Use checkboxes to apply only specific items.
        </span>
      </div>

      {/* Table */}
      <div className="mt-4 overflow-x-auto border rounded-lg">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr className="text-left">
              <th className="px-3 py-2 w-10">
                <input
                  type="checkbox"
                  checked={allVisibleSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someVisibleSelected;
                  }}
                  onChange={(e) =>
                    setSelectAllVisibleRecurring(visibleRecurringRules, e.target.checked)
                  }
                />
              </th>

              <th className="px-3 py-2">
                <button
                  type="button"
                  onClick={() => toggleRecurringSort("description")}
                  className="font-semibold hover:underline"
                >
                  Description {recurringSortKey === "description" ? (recurringSortDir === "asc" ? "↑" : "↓") : ""}
                </button>
              </th>

              <th className="px-3 py-2">
                <button
                  type="button"
                  onClick={() => toggleRecurringSort("category")}
                  className="font-semibold hover:underline"
                >
                  Category {recurringSortKey === "category" ? (recurringSortDir === "asc" ? "↑" : "↓") : ""}
                </button>
              </th>

              <th className="px-3 py-2 text-right">
                <button
                  type="button"
                  onClick={() => toggleRecurringSort("amount")}
                  className="font-semibold hover:underline"
                >
                  Amount {recurringSortKey === "amount" ? (recurringSortDir === "asc" ? "↑" : "↓") : ""}
                </button>
              </th>

              <th className="px-3 py-2">
                <button
                  type="button"
                  onClick={() => toggleRecurringSort("type")}
                  className="font-semibold hover:underline"
                >
                  Type {recurringSortKey === "type" ? (recurringSortDir === "asc" ? "↑" : "↓") : ""}
                </button>
              </th>

              <th className="px-3 py-2">
                <button
                  type="button"
                  onClick={() => toggleRecurringSort("person")}
                  className="font-semibold hover:underline"
                >
                  Person {recurringSortKey === "person" ? (recurringSortDir === "asc" ? "↑" : "↓") : ""}
                </button>
              </th>

              <th className="px-3 py-2">
                <button
                  type="button"
                  onClick={() => toggleRecurringSort("dayOfMonth")}
                  className="font-semibold hover:underline"
                >
                  Schedule {recurringSortKey === "dayOfMonth" ? (recurringSortDir === "asc" ? "↑" : "↓") : ""}
                </button>
              </th>

              <th className="px-3 py-2 text-center">
                <button
                  type="button"
                  onClick={() => toggleRecurringSort("active")}
                  className="font-semibold hover:underline"
                >
                  Status {recurringSortKey === "active" ? (recurringSortDir === "asc" ? "↑" : "↓") : ""}
                </button>
              </th>

              <th className="px-3 py-2 text-center font-semibold">Actions</th>
            </tr>
          </thead>

          <tbody>
            {visibleRecurringRules.map((r) => {
              const isEditing = editingRecurringRuleId === r.id;
              const checked = selectedRecurringIds.has(r.id);

              return (
                <tr key={r.id} className="border-b">
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleRecurringSelected(r.id)}
                      disabled={isEditing}
                      title={isEditing ? "Finish editing before selecting" : "Select"}
                    />
                  </td>

                  <td className="px-3 py-2">
                    {isEditing ? (
                      <input
                        value={editRecurringDraft?.description || ""}
                        onChange={(e) =>
                          setEditRecurringDraft((prev) => ({
                            ...(prev || {}),
                            description: e.target.value,
                          }))
                        }
                        className="border rounded px-2 py-1 text-sm w-full"
                      />
                    ) : (
                      r.description
                    )}
                  </td>

                  <td className="px-3 py-2">
                    {isEditing ? (
                      <select
                        value={editRecurringDraft?.category || "Food"}
                        onChange={(e) =>
                          setEditRecurringDraft((prev) => ({
                            ...(prev || {}),
                            category: e.target.value,
                          }))
                        }
                        className="border rounded px-2 py-1 text-sm w-full"
                      >
                        {categories.map((cat) => (
                          <option key={cat} value={cat}>
                            {cat}
                          </option>
                        ))}
                      </select>
                    ) : (
                      r.category
                    )}
                  </td>

                  <td className="px-3 py-2 text-right">
                    {isEditing ? (
                      <input
                        type="number"
                        value={editRecurringDraft?.amount ?? ""}
                        onChange={(e) =>
                          setEditRecurringDraft((prev) => ({
                            ...(prev || {}),
                            amount: e.target.value,
                          }))
                        }
                        className="border rounded px-2 py-1 text-sm w-28 text-right"
                      />
                    ) : (
                      `$${Number(r.amount || 0).toLocaleString()}`
                    )}
                  </td>

                  <td className="px-3 py-2 capitalize">
                    {isEditing ? (
                      <select
                        value={editRecurringDraft?.type || "expense"}
                        onChange={(e) =>
                          setEditRecurringDraft((prev) => ({
                            ...(prev || {}),
                            type: e.target.value,
                          }))
                        }
                        className="border rounded px-2 py-1 text-sm"
                      >
                        <option value="income">Income</option>
                        <option value="expense">Expense</option>
                      </select>
                    ) : (
                      r.type
                    )}
                  </td>

                  <td className="px-3 py-2">
                    {isEditing ? (
                      <select
                        value={editRecurringDraft?.person || "joint"}
                        onChange={(e) =>
                          setEditRecurringDraft((prev) => ({
                            ...(prev || {}),
                            person: e.target.value,
                          }))
                        }
                        className="border rounded px-2 py-1 text-sm"
                      >
                        <option value="joint">Joint</option>
                        <option value="you">You</option>
                        <option value="wife">Wife</option>
                      </select>
                    ) : (
                      personLabels[r.person] || r.person
                    )}
                  </td>

                  <td className="px-3 py-2">
                    {isEditing ? (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-gray-500">Every month on day</span>
                        <input
                          type="number"
                          min={1}
                          max={31}
                          value={editRecurringDraft?.dayOfMonth ?? 1}
                          onChange={(e) =>
                            setEditRecurringDraft((prev) => ({
                              ...(prev || {}),
                              dayOfMonth: e.target.value,
                            }))
                          }
                          className="border rounded px-2 py-1 text-sm w-16"
                        />
                      </div>
                    ) : (
                      <>Every month on day {r.dayOfMonth}</>
                    )}
                  </td>

                  <td className="px-3 py-2 text-center">
                    <span
                      className={`inline-flex px-2 py-1 rounded-full text-[11px] font-semibold ${
                        r.active ? "bg-green-100 text-green-700" : "bg-gray-200 text-gray-600"
                      }`}
                    >
                      {r.active ? "Active" : "Paused"}
                    </span>
                  </td>

                  <td className="px-3 py-2 text-center">
                    {isEditing ? (
                      <div className="flex items-center justify-center gap-2">
                        <button
                          type="button"
                          onClick={saveEditRecurringRule}
                          className="text-indigo-600 hover:text-indigo-800"
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          onClick={cancelEditRecurringRule}
                          className="text-gray-600 hover:text-gray-800"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center justify-center gap-2">
                        <button
                          type="button"
                          onClick={() => startEditRecurringRule(r)}
                          className="text-indigo-600 hover:text-indigo-800"
                        >
                          Edit
                        </button>

                        <button
                          type="button"
                          onClick={() => toggleRecurringActiveDb(r)}
                          className="text-indigo-600 hover:text-indigo-800"
                        >
                          {r.active ? "Pause" : "Resume"}
                        </button>

                        <button
                          type="button"
                          onClick={() => deleteRecurringRuleDb(r.id)}
                          className="text-red-600 hover:text-red-800"
                        >
                          Delete
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

{/* ADD RECURRING RULE — keep inside recurringOpen */}
<div className="grid grid-cols-1 md:grid-cols-6 gap-3 mb-4">
  <input
    type="text"
    placeholder="Description"
    value={newRecurring.description}
    onChange={(e) =>
      setNewRecurring((prev) => ({ ...(prev || {}), description: e.target.value }))
    }
    className="border rounded px-3 py-2"
  />

  <select
    value={newRecurring.category}
    onChange={(e) =>
      setNewRecurring((prev) => ({ ...(prev || {}), category: e.target.value }))
    }
    className="border rounded px-3 py-2"
  >
    {categories.map((cat) => (
      <option key={cat} value={cat}>
        {cat}
      </option>
    ))}
  </select>

  <input
    type="number"
    placeholder="Amount"
    value={newRecurring.amount}
    onChange={(e) =>
      setNewRecurring((prev) => ({ ...(prev || {}), amount: e.target.value }))
    }
    className="border rounded px-3 py-2"
  />

  <select
    value={newRecurring.type}
    onChange={(e) =>
      setNewRecurring((prev) => ({ ...(prev || {}), type: e.target.value }))
    }
    className="border rounded px-3 py-2"
  >
    <option value="income">Income</option>
    <option value="expense">Expense</option>
  </select>

  <select
    value={newRecurring.person}
    onChange={(e) =>
      setNewRecurring((prev) => ({ ...(prev || {}), person: e.target.value }))
    }
    className="border rounded px-3 py-2"
  >
    <option value="joint">Joint</option>
    <option value="you">You</option>
    <option value="wife">Wife</option>
  </select>

  <input
    type="number"
    min={1}
    max={31}
    placeholder="Day"
    value={newRecurring.dayOfMonth}
    onChange={(e) =>
      setNewRecurring((prev) => ({ ...(prev || {}), dayOfMonth: e.target.value }))
    }
    className="border rounded px-3 py-2"
  />

  <button
    type="button"
    onClick={addRecurringRule /* or createRecurringRule/addRecurringRuleDb */}
    className="bg-indigo-600 text-white rounded px-4 py-2 hover:bg-indigo-700 flex items-center justify-center gap-2 md:col-span-6"
  >
    {/* If PlusCircle is not imported, remove this icon line */}
    <PlusCircle size={18} /> Add Recurring Rule
  </button>
</div>

      {/* (No change required unless you want an “Add New” collapse too.) */}
    </>
  )}
</div>


            {/* Manual add form */}
            <div className="grid grid-cols-1 md:grid-cols-8 gap-3 mb-6">
              <input
                type="date"
                value={newTransaction.date}
                onChange={(e) =>
                  setNewTransaction({ ...newTransaction, date: e.target.value })
                }
                className="border rounded px-3 py-2"
              />
              <input
                type="text"
                placeholder="Description"
                value={newTransaction.description}
                onChange={(e) =>
                  setNewTransaction({ ...newTransaction, description: e.target.value })
                }
                className="border rounded px-3 py-2"
              />
              <select
                value={newTransaction.category}
                onChange={(e) =>
                  setNewTransaction({ ...newTransaction, category: e.target.value })
                }
                className="border rounded px-3 py-2"
              >
                {categories.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>
              <input
                type="number"
                placeholder="Amount"
                value={newTransaction.amount}
                onChange={(e) =>
                  setNewTransaction({ ...newTransaction, amount: e.target.value })
                }
                className="border rounded px-3 py-2"
              />
              <select
                value={newTransaction.type}
                onChange={(e) =>
                  setNewTransaction({ ...newTransaction, type: e.target.value })
                }
                className="border rounded px-3 py-2"
              >
                <option value="income">Income</option>
                <option value="expense">Expense</option>
              </select>
              <select
                value={newTransaction.person}
                onChange={(e) =>
                  setNewTransaction({ ...newTransaction, person: e.target.value })
                }
                className="border rounded px-3 py-2"
              >
                <option value="joint">Joint</option>
                <option value="you">You</option>
                <option value="wife">Wife</option>
              </select>

              <select
                value={newTransaction.account_id || ""}
                onChange={(e) =>
                  setNewTransaction({
                    ...newTransaction,
                    account_id: e.target.value ? Number(e.target.value) : null,
                  })
                }
                className="border rounded px-3 py-2"
              >
                <option value="">Account…</option>
                {(accounts || []).map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.institution ? ` (${a.institution})` : ""}
                  </option>
                ))}
              </select>

              <select
                value={newTransaction.transaction_type || "normal"}
                onChange={(e) => {
                  const v = e.target.value;
                  setNewTransaction((p) => ({
                    ...p,
                    transaction_type: v,
                    transfer_account_id: v === "transfer" ? (p.transfer_account_id || null) : null,
                  }));
                }}
                className="border rounded px-3 py-2"
              >
                <option value="normal">Normal</option>
                <option value="transfer">Transfer / Payment</option>
              </select>

              {((newTransaction.transaction_type || "normal") === "transfer") && (
                <select
                  value={newTransaction.transfer_account_id || ""}
                  onChange={(e) =>
                    setNewTransaction({ ...newTransaction, transfer_account_id: e.target.value ? Number(e.target.value) : null })
                  }
                  className="border rounded px-3 py-2"
                >
                  <option value="">To/From account…</option>
                  {(accounts || [])
  .filter((a) => Number(a.id) !== Number(newTransaction.account_id))
  .map((a) => (
    <option key={a.id} value={a.id}>
      {a.name}
      {a.institution ? ` (${a.institution})` : ""}
    </option>
  ))}

                </select>
              )}
              <button
                type="button"
                onClick={addTransaction}
                className="bg-indigo-600 text-white rounded px-4 py-2 hover:bg-indigo-700 flex items-center justify-center gap-2 md:col-span-8"
              >
                <PlusCircle size={20} /> Add Transaction
              </button>
            </div>

		{/* 📊 Monthly summary cards */}
<div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
  <div className="rounded-xl border bg-white p-4">
    <div className="text-xs text-gray-500">Income</div>
    <div className="text-2xl font-bold text-green-700">
      ${monthTotals.income.toLocaleString()}
    </div>
  </div>

  <div className="rounded-xl border bg-white p-4">
    <div className="text-xs text-gray-500">Expenses</div>
    <div className="text-2xl font-bold text-red-700">
      ${monthTotals.expenses.toLocaleString()}
    </div>
  </div>

  <div className="rounded-xl border bg-white p-4">
    <div className="text-xs text-gray-500">Net</div>
    <div
      className={`text-2xl font-bold ${
        monthTotals.net >= 0 ? "text-green-800" : "text-red-800"
      }`}
    >
      {monthTotals.net >= 0 ? "+" : "-"}$
      {Math.abs(monthTotals.net).toLocaleString()}
    </div>
  </div>
</div>


{/*    Forecast UI  */}
{/* Forecast (collapsible) */}
<div className="rounded-xl border bg-white mb-6">
  <button
    type="button"
    onClick={() => setForecastOpen((v) => !v)}
    className="w-full flex items-center justify-between px-4 py-3 hover:bg-gray-50 rounded-xl transition-colors"

  >
    <div className="flex items-center gap-2">
      <span className="text-sm font-semibold">Forecast (next 6 months)</span>
      <span className="text-xs text-gray-500">
        {forecastRows?.length ? `${forecastRows.length} months` : ""}
      </span>
    </div>

    <span
  	className={`text-lg leading-none transition-transform ${
    forecastOpen ? "rotate-90" : "rotate-0"
  }`}
    >
   ▸
   </span>

  </button>

  {forecastOpen ? (
    <div className="px-4 pb-4">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-gray-50 text-left">
              <th className="px-3 py-2">Month</th>
              <th className="px-3 py-2 text-right">Income</th>
              <th className="px-3 py-2 text-right">Expenses</th>
              <th className="px-3 py-2 text-right">Net</th>
            </tr>
          </thead>
          <tbody>
            {forecastRows.map((r) => (
              <tr key={r.monthKey} className="border-b">
                <td className="px-3 py-2">{r.monthKey}</td>
                <td className="px-3 py-2 text-right text-green-700">
                  ${Number(r.income || 0).toLocaleString()}
                </td>
                <td className="px-3 py-2 text-right text-red-700">
                  ${Number(r.expenses || 0).toLocaleString()}
                </td>
                <td
                  className={`px-3 py-2 text-right font-semibold ${
                    r.net >= 0 ? "text-green-800" : "text-red-800"
                  }`}
                >
                  {r.net >= 0 ? "+" : "-"}${Math.abs(Number(r.net || 0)).toLocaleString()}
                </td>
              </tr>
            ))}

            {!forecastRows?.length ? (
              <tr>
                <td colSpan={4} className="px-3 py-4 text-center text-gray-500">
                  No forecast available yet.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  ) : null}
</div>



            {/* Table filters */}
            <div className="flex flex-col md:flex-row gap-3 mb-4">
              <input
                type="text"
                placeholder="Search by date, description, or category..."
                value={transactionSearch}
                onChange={(e) => setTransactionSearch(e.target.value)}
                className="border rounded px-3 py-2 flex-1"
              />

              <select
                value={transactionFilterCategory}
                onChange={(e) => setTransactionFilterCategory(e.target.value)}
                className="border rounded px-3 py-2 md:w-52"
              >
                <option value="all">All Categories</option>
                {categories.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>

              <select
                value={transactionFilterType}
                onChange={(e) => setTransactionFilterType(e.target.value)}
                className="border rounded px-3 py-2 md:w-40"
              >
                <option value="all">All Types</option>
                <option value="income">Income</option>
                <option value="expense">Expense</option>
              </select>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-2 text-left">Date</th>
                    <th className="px-4 py-2 text-left">Description</th>
                    <th className="px-4 py-2 text-left">Category</th>
                    <th className="px-4 py-2 text-left">Person</th>
                    <th className="px-4 py-2 text-left">Account</th>
                    <th className="px-4 py-2 text-left">Txn</th>
                    <th className="px-4 py-2 text-right">Amount</th>
                    <th className="px-4 py-2 text-center">Action</th>
                  </tr>
                </thead>

                <tbody>
                  {groupedTransactionsByMonth.map((group) => (
<React.Fragment key={group.key}>
  <tr className="bg-gray-100">
    <td colSpan={2} className="px-4 py-2 font-semibold">
      <button
        type="button"
        onClick={() => toggleMonth(group.key)}
        className="flex items-center gap-2 text-left hover:text-indigo-700"
        aria-expanded={isMonthOpen(group.key)}
        aria-controls={`month-${group.key}`}
      >
        <span className="text-lg leading-none">
          {isMonthOpen(group.key) ? "▾" : "▸"}
        </span>
        {group.label}
      </button>
    </td>

    <td colSpan={6} className="px-4 py-2 text-xs text-gray-600">
      Income:{" "}
      <span className="text-green-600 font-semibold">
        +${group.income.toLocaleString()}
      </span>{" "}
      • Expenses:{" "}
      <span className="text-red-600 font-semibold">
        -${group.expenses.toLocaleString()}
      </span>{" "}
      • Net:{" "}
      <span
        className={`font-semibold ${
          group.net >= 0 ? "text-green-700" : "text-red-700"
        }`}
      >
        {group.net >= 0 ? "+" : "-"}${Math.abs(group.net).toLocaleString()}
      </span>
    </td>

    {/* remaining columns covered by colSpan=6 above */}
  </tr>

  {isMonthOpen(group.key) && (
    <React.Fragment>
      {group.items.map((t) => {
        const isEditing = t.id === editingTransactionId;

        return (
          <tr
            key={t.id}
            id={`month-${group.key}`}
            className="border-b hover:bg-gray-50"
          >
            <td className="px-4 py-2">
              {isEditing ? (
                <input
                  type="date"
                  value={editTransactionDraft?.date || ""}
                  onChange={(e) =>
                    setEditTransactionDraft((prev) => ({
                      ...prev,
                      date: e.target.value,
                    }))
                  }
                  className="border rounded px-2 py-1 text-sm w-full"
                />
              ) : (
                t.date
              )}
            </td>

            <td className="px-4 py-2">
              {isEditing ? (
                <input
                  type="text"
                  value={editTransactionDraft?.description || ""}
                  onChange={(e) =>
                    setEditTransactionDraft((prev) => ({
                      ...prev,
                      description: e.target.value,
                    }))
                  }
                  className="border rounded px-2 py-1 text-sm w-full"
                />
              ) : (
  		<div className="flex items-center gap-2">
    		 <span>{t.description}</span>
    		 	{t.recurring_rule_id ? (
      		 <span
          	 className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-indigo-100 text-indigo-700"
        	 title={t.applied_month ? `Applied for ${t.applied_month}` : "Recurring"}
      		 >
        		Auto-applied
      		</span>
    		) : null}
  		</div>
		
              )}
            </td>

            <td className="px-4 py-2">
              {isEditing ? (
                <select
                  value={editTransactionDraft?.category || "Other"}
                  onChange={(e) =>
                    setEditTransactionDraft((prev) => ({
                      ...prev,
                      category: e.target.value,
                    }))
                  }
                  className="border rounded px-2 py-1 text-sm w-full"
                >
                  {categories.map((cat) => (
                    <option key={cat} value={cat}>
                      {cat}
                    </option>
                  ))}
                </select>
              ) : (
                t.category
              )}
            </td>

            <td className="px-4 py-2">
              {isEditing ? (
                <select
                  value={editTransactionDraft?.person || "joint"}
                  onChange={(e) =>
                    setEditTransactionDraft((prev) => ({
                      ...prev,
                      person: e.target.value,
                    }))
                  }
                  className="border rounded px-2 py-1 text-sm w-full"
                >
                  <option value="joint">Joint</option>
                  <option value="you">You</option>
                  <option value="wife">Wife</option>
                </select>
              ) : (
                personLabels[t.person] || t.person
              )}
            </td>

            <td className="px-4 py-2">
              {isEditing ? (
                <select
                  value={editTransactionDraft?.account_id || ""}
                  onChange={(e) =>
                    setEditTransactionDraft((prev) => ({
                      ...prev,
                      account_id: e.target.value ? Number(e.target.value) : null,
                    }))
                  }
                  className="border rounded px-2 py-1 text-sm w-full"
                >
                  <option value="">—</option>
                  {(accounts || []).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}{a.institution ? ` (${a.institution})` : ""}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="text-gray-700">{t.account_name || ""}</span>
              )}
            </td>

            <td className="px-4 py-2">
              {isEditing ? (
                <div className="flex items-center gap-2">
                  <select
                    value={editTransactionDraft?.transaction_type || "normal"}
                    onChange={(e) => {
                      const v = e.target.value;
                      setEditTransactionDraft((prev) => ({
                        ...prev,
                        transaction_type: v,
                        transfer_account_id: v === "transfer" ? (prev?.transfer_account_id || null) : null,
                      }));
                    }}
                    className="border rounded px-2 py-1 text-sm"
                  >
                    <option value="normal">Normal</option>
                    <option value="transfer">Transfer</option>
                  </select>
                  {(editTransactionDraft?.transaction_type || "normal") === "transfer" ? (
                    <select
                      value={editTransactionDraft?.transfer_account_id || ""}
                      onChange={(e) =>
                        setEditTransactionDraft((prev) => ({
                          ...prev,
                          transfer_account_id: e.target.value ? Number(e.target.value) : null,
                        }))
                      }
                      className="border rounded px-2 py-1 text-sm"
                    >
                      <option value="">To/From…</option>
                      {(accounts || []).filter((a) => Number(a.id) !== Number(editTransactionDraft?.account_id)).map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}{a.institution ? ` (${a.institution})` : ""}
                        </option>
                      ))}
                    </select>
                  ) : null}
                </div>
              ) : (
                (t.transaction_type || "normal") === "transfer" ? (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold bg-amber-50 text-amber-700 border border-amber-200">
                    Transfer{t.transfer_account_name ? ` → ${t.transfer_account_name}` : ""}
                  </span>
                ) : (
                  <span className="text-xs text-gray-500">Normal</span>
                )
              )}
            </td>

            <td
              className={`px-4 py-2 text-right font-bold ${
                t.type === "income" ? "text-green-600" : "text-red-600"
              }`}
            >
              {isEditing ? (
                <div className="flex items-center gap-2 justify-end">
                  <input
                    type="number"
                    value={editTransactionDraft?.amount || ""}
                    onChange={(e) =>
                      setEditTransactionDraft((prev) => ({
                        ...prev,
                        amount: e.target.value,
                      }))
                    }
                    className="border rounded px-2 py-1 text-sm w-24 text-right"
                  />
                  <select
                    value={editTransactionDraft?.type || "expense"}
                    onChange={(e) =>
                      setEditTransactionDraft((prev) => ({
                        ...prev,
                        type: e.target.value,
                      }))
                    }
                    className="border rounded px-2 py-1 text-xs"
                  >
                    <option value="income">Income</option>
                    <option value="expense">Expense</option>
                  </select>
                </div>
              ) : (
                <>
                  {t.type === "income" ? "+" : "-"}${t.amount}
                </>
              )}
            </td>

            <td className="px-4 py-2 text-center">
              {isEditing ? (
                <div className="flex items-center justify-center gap-2">
                  <button
                    type="button"
                    onClick={saveEditTransaction}
                    className="text-green-600 hover:text-green-800"
                    title="Save"
                  >
                    <Check size={18} />
                  </button>
                  <button
                    type="button"
                    onClick={cancelEditTransaction}
                    className="text-gray-500 hover:text-gray-700"
                    title="Cancel"
                  >
                    <X size={18} />
                  </button>
                </div>
              ) : (
                <div className="flex items-center justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => startEditTransaction(t)}
                    className="text-indigo-600 hover:text-indigo-800"
                    title="Edit"
                  >
                    <Pencil size={18} />
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteTransaction(t.id)}
                    className="text-red-600 hover:text-red-800"
                    title="Delete"
                  >
                    <Trash2 size={18} />
                  </button>
                </div>
              )}
            </td>
          </tr>
        );
      })}
    </React.Fragment>
  )}
</React.Fragment>

                  ))}

                  {tableTransactions.length > 0 && (
                    <tr className="bg-gray-50 font-semibold">
                      <td colSpan={3}></td>
                      <td className="px-4 py-3 text-right">Totals:</td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex flex-col items-end text-sm">
                          <span className="text-green-600">
                            Income: +${tableTotals.income.toLocaleString()}
                          </span>
                          <span className="text-red-600">
                            Expenses: -${tableTotals.expenses.toLocaleString()}
                          </span>
                          <span
                            className={`mt-1 ${
                              tableTotals.net >= 0 ? "text-green-700" : "text-red-700"
                            }`}
                          >
                            Net: {tableTotals.net >= 0 ? "+" : "-"}$
                            {Math.abs(tableTotals.net).toLocaleString()}
                          </span>
                        </div>
                      </td>
                      <td></td>
                    </tr>
                  )}

                  {transactionsByPerson.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-4 py-6 text-center text-gray-500">
                        No transactions yet. Add your first one above.
                      </td>
                    </tr>
                  )}

                  {transactionsByPerson.length > 0 && tableTransactions.length === 0 && (
                    <tr>
                      <td colSpan={6} className="px-4 py-6 text-center text-gray-500">
                        No transactions match this view. Try changing your filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ASSETS TAB */}
        {activeTab === "assets" && (
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-xl font-bold text-gray-800 mb-4">Assets</h2>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
              <input
                type="text"
                placeholder="Asset name"
                value={newAsset.name}
                onChange={(e) => setNewAsset({ ...newAsset, name: e.target.value })}
                className="border rounded px-3 py-2"
              />
              <input
                type="number"
                placeholder="Value"
                value={newAsset.value}
                onChange={(e) => setNewAsset({ ...newAsset, value: e.target.value })}
                className="border rounded px-3 py-2"
              />
              <select
                value={newAsset.person}
                onChange={(e) => setNewAsset({ ...newAsset, person: e.target.value })}
                className="border rounded px-3 py-2"
              >
                <option value="joint">Joint</option>
                <option value="you">You</option>
                <option value="wife">Wife</option>
              </select>
              <button
                onClick={addAsset}
                className="bg-indigo-600 text-white rounded px-4 py-2 hover:bg-indigo-700 flex items-center justify-center gap-2 md:col-span-3"
              >
                <PlusCircle size={20} /> Add Asset
              </button>
            </div>

            <div className="space-y-3">
              {filteredAssets.map((a) => (
                <div
                  key={a.id}
                  className="flex justify-between items-center border rounded p-4 hover:bg-gray-50"
                >
                  <div>
                    {editingAssetId === a.id ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          type="text"
                          value={editAssetDraft?.name ?? ""}
                          onChange={(e) => setEditAssetDraft((p) => ({ ...p, name: e.target.value }))}
                          className="border rounded px-2 py-1 text-sm w-56"
                          placeholder="Asset name"
                        />
                        <input
                          type="number"
                          value={editAssetDraft?.value ?? ""}
                          onChange={(e) => setEditAssetDraft((p) => ({ ...p, value: e.target.value }))}
                          className="border rounded px-2 py-1 text-sm w-28"
                          placeholder="Value"
                        />
                        <select
                          value={editAssetDraft?.person ?? "joint"}
                          onChange={(e) => setEditAssetDraft((p) => ({ ...p, person: e.target.value }))}
                          className="border rounded px-2 py-1 text-sm"
                        >
                          <option value="joint">Joint</option>
                          <option value="you">You</option>
                          <option value="wife">Wife</option>
                        </select>
                      </div>
                    ) : (
                      <>
                        <p className="font-medium">{a.name}</p>
                        <p className="text-sm text-gray-500">{personLabels[a.person]}</p>
                      </>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    {editingAssetId === a.id ? (
                      <>
                        <button
                          type="button"
                          onClick={saveEditAsset}
                          className="text-green-600 hover:text-green-800"
                          title="Save"
                        >
                          <Check size={18} />
                        </button>
                        <button
                          type="button"
                          onClick={cancelEditAsset}
                          className="text-gray-500 hover:text-gray-700"
                          title="Cancel"
                        >
                          <X size={18} />
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="font-bold text-green-600">
                          ${Number(a.value || 0).toLocaleString()}
                        </span>
                        <button
                          type="button"
                          onClick={() => startEditAsset(a)}
                          className="text-gray-600 hover:text-gray-800"
                          title="Edit"
                        >
                          <Pencil size={18} />
                        </button>
                        <button
                          type="button"
                          onClick={() => deleteAsset(a.id)}
                          className="text-red-600 hover:text-red-800"
                          title="Delete"
                        >
                          <Trash2 size={18} />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}

              {filteredAssets.length === 0 && (
                <p className="text-gray-500">
                  No assets added yet. Use the form above to add your first asset.
                </p>
              )}
            </div>

            <div className="mt-6 pt-4 border-t">
              <div className="flex justify-between text-lg font-bold">
                <span>Total Assets:</span>
                <span className="text-green-600">${totalAssets.toLocaleString()}</span>
              </div>
            </div>
          </div>
        )}

        {/* LIABILITIES TAB */}
        {activeTab === "liabilities" && (
          <div className="bg-white rounded-lg shadow p-6">
            <h2 className="text-xl font-bold text-gray-800 mb-4">Liabilities</h2>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
              <input
                type="text"
                placeholder="Liability name"
                value={newLiability.name}
                onChange={(e) => setNewLiability({ ...newLiability, name: e.target.value })}
                className="border rounded px-3 py-2"
              />
              <input
                type="number"
                placeholder="Value"
                value={newLiability.value}
                onChange={(e) =>
                  setNewLiability({ ...newLiability, value: e.target.value })
                }
                className="border rounded px-3 py-2"
              />
              <select
                value={newLiability.person}
                onChange={(e) =>
                  setNewLiability({ ...newLiability, person: e.target.value })
                }
                className="border rounded px-3 py-2"
              >
                <option value="joint">Joint</option>
                <option value="you">You</option>
                <option value="wife">Wife</option>
              </select>
              <button
                onClick={addLiability}
                className="bg-indigo-600 text-white rounded px-4 py-2 hover:bg-indigo-700 flex items-center justify-center gap-2 md:col-span-3"
              >
                <PlusCircle size={20} /> Add Liability
              </button>
            </div>

            <div className="space-y-3">
              {filteredLiabilities.map((l) => (
                <div
                  key={l.id}
                  className="flex justify-between items-center border rounded p-4 hover:bg-gray-50"
                >
                  <div>
                    {editingLiabilityId === l.id ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <input
                          type="text"
                          value={editLiabilityDraft?.name ?? ""}
                          onChange={(e) => setEditLiabilityDraft((p) => ({ ...p, name: e.target.value }))}
                          className="border rounded px-2 py-1 text-sm w-56"
                          placeholder="Liability name"
                        />
                        <input
                          type="number"
                          value={editLiabilityDraft?.value ?? ""}
                          onChange={(e) => setEditLiabilityDraft((p) => ({ ...p, value: e.target.value }))}
                          className="border rounded px-2 py-1 text-sm w-28"
                          placeholder="Value"
                        />
                        <select
                          value={editLiabilityDraft?.person ?? "joint"}
                          onChange={(e) => setEditLiabilityDraft((p) => ({ ...p, person: e.target.value }))}
                          className="border rounded px-2 py-1 text-sm"
                        >
                          <option value="joint">Joint</option>
                          <option value="you">You</option>
                          <option value="wife">Wife</option>
                        </select>
                      </div>
                    ) : (
                      <>
                        <p className="font-medium">{l.name}</p>
                        <p className="text-sm text-gray-500">{personLabels[l.person]}</p>
                      </>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    {editingLiabilityId === l.id ? (
                      <>
                        <button type="button" onClick={saveEditLiability} className="text-green-600 hover:text-green-800" title="Save">
                          <Check size={18} />
                        </button>
                        <button type="button" onClick={cancelEditLiability} className="text-gray-500 hover:text-gray-700" title="Cancel">
                          <X size={18} />
                        </button>
                      </>
                    ) : (
                      <>
                        <span className="font-bold text-red-600">
                          ${Number(l.value || 0).toLocaleString()}
                        </span>
                        <button type="button" onClick={() => startEditLiability(l)} className="text-gray-600 hover:text-gray-800" title="Edit">
                          <Pencil size={18} />
                        </button>
                        <button type="button" onClick={() => deleteLiability(l.id)} className="text-red-600 hover:text-red-800" title="Delete">
                          <Trash2 size={18} />
                        </button>
                      </>
                    )}
                  </div>
                </div>
              ))}

              {filteredLiabilities.length === 0 && (
                <p className="text-gray-500">
                  No liabilities yet. Use the form above to add one.
                </p>
              )}
            </div>

            <div className="mt-6 pt-4 border-t">
              <div className="flex justify-between text-lg font-bold">
                <span>Total Liabilities:</span>
                <span className="text-red-600">${totalLiabilities.toLocaleString()}</span>
              </div>
            </div>
          </div>
        )}


        {/* BUDGET TAB */}
        {activeTab === "budget" && (
          <div className="bg-white rounded-lg shadow p-6">
            <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-4">
              <h2 className="text-xl font-bold text-gray-800">Monthly Budget</h2>

              {/* ✅ Month selector for Budget tab */}
              <div className="flex items-center gap-2">
                <label className="text-sm text-gray-600">View Month</label>
                <select
                  className="border rounded px-2 py-1 text-sm"
                  value={budgetViewMonth}
                  onChange={(e) => setBudgetViewMonth(e.target.value)}
                >
                  {budgetMonthOptions.map((m) => (
                    <option key={m} value={m}>
                      {monthLabelFromKey(m)}
                    </option>
                  ))}
                </select>


                <input
                  type="text"
                  value={budgetSearch}
                  onChange={(e) => setBudgetSearch(e.target.value)}
                  placeholder="Search budgets (category or description)"
                  className="border rounded px-3 py-1 text-sm w-64"
                />
              </div>
            </div>
	  {/* ✅ Rollover control (kept, just aligned nicely) */}
	<div className="flex items-center gap-2 mb-4">
		<label className="text-sm text-gray-600 ml-3">Rollover</label>
		<select
  			className="border rounded px-2 py-1 text-sm"
  			value={rolloverEnabled ? "on" : "off"}
  		onChange={(e) => setRolloverEnabled(e.target.value === "on")}
		>
  			<option value="on">On</option>
  			<option value="off">Off</option>
		</select>
	</div>
            {/* Add Budget Form */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-6">
              <select
                value={newBudget.category}
                onChange={(e) => setNewBudget({ ...newBudget, category: e.target.value })}
                className="border rounded px-3 py-2"
              >
                {categories.map((cat) => (
                  <option key={cat} value={cat}>
                    {cat}
                  </option>
                ))}
              </select>

              <input
                type="number"
                placeholder="Budget amount"
                value={newBudget.amount}
                onChange={(e) => setNewBudget({ ...newBudget, amount: e.target.value })}
                className="border rounded px-3 py-2"
              />

              <input
                type="month"
                value={newBudget.month}
                onChange={(e) => setNewBudget({ ...newBudget, month: e.target.value })}
                className="border rounded px-3 py-2"
              />

              <select
                value={newBudget.person}
                onChange={(e) => setNewBudget({ ...newBudget, person: e.target.value })}
                className="border rounded px-3 py-2"
              >
                <option value="joint">Joint</option>
                <option value="you">You</option>
                <option value="wife">Wife</option>
              </select>

              <button
                type="button"
                onClick={addBudget}
                className="bg-indigo-600 text-white rounded px-4 py-2 hover:bg-indigo-700 flex items-center justify-center gap-2 md:col-span-4"
              >
                <PlusCircle size={20} /> Add Budget
              </button>
            </div>

            {/* Budget vs Actual summary (for budgetViewMonth) */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
              <div className="border rounded-lg p-4">
                <p className="text-xs text-gray-500">Planned Budget</p>
                <p className="text-xl font-bold">
                  ${Number(budgetSummary.totalBudget || 0).toLocaleString()}
                </p>
              </div>

              <div className="border rounded-lg p-4">
                <p className="text-xs text-gray-500">Actual Spending</p>
                <p className="text-xl font-bold text-red-600">
                  ${Number(budgetSummary.totalSpent || 0).toLocaleString()}
                </p>
              </div>

              <div className="border rounded-lg p-4">
		<p className="text-xs text-gray-500">
    		{(budgetSummary.remaining || 0) < 0 ? "Over by" : "Remaining"}
  		</p>

  		<p
    		className={`text-xl font-bold ${
      		(budgetSummary.remaining || 0) < 0 ? "text-red-600" : "text-green-700"
    		}`}
  		>
    		$
    		{Number(
      		(budgetSummary.remaining || 0) < 0
        	? Math.abs(budgetSummary.remaining || 0)
        	: budgetSummary.remaining || 0
    		).toLocaleString()}
  		</p>
              </div>

            </div>

{/* AI Monthly Summary */}
<div className="border rounded-lg p-4 mb-6 bg-white">
  {/* Header row */}
  <div className="flex items-center justify-between gap-3">
    <div className="min-w-0">
      <p className="text-sm font-semibold text-gray-900">Monthly AI Summary</p>
      <p className="text-xs text-gray-500">
        Uses your planned budget, actual spending, and category highlights for{" "}
        {monthLabelFromKey(budgetViewMonthKey)}.
      </p>
    </div>

    <div className="flex items-center gap-3">
      {/* Expand/Collapse */}
      {!!aiBudgetSummary && !aiBudgetError && (
        <button
          type="button"
          onClick={() => setAiBudgetOpen((v) => !v)}
          className="text-sm text-gray-600 hover:text-gray-900 underline inline-flex items-center gap-1"
        >
          <span
            className={`inline-block transition-transform ${
              aiBudgetOpen ? "rotate-90" : ""
            }`}
          >
            ▶
          </span>
          {aiBudgetOpen ? "Collapse" : "Expand"}
        </button>
      )}

      <button
        type="button"
        onClick={() => runAiBudgetSummary({ force: false })}
        disabled={aiBudgetLoading}
        className="bg-indigo-600 text-white text-sm px-3 py-2 rounded hover:bg-indigo-700 disabled:opacity-60"
      >
        {aiBudgetLoading ? "Generating..." : "Generate"}
      </button>

      <button
        type="button"
        onClick={() => runAiBudgetSummary({ force: true })}
        disabled={aiBudgetLoading}
        className="border text-sm px-3 py-2 rounded hover:bg-gray-50 disabled:opacity-60"
        title="Regenerate and overwrite cache"
      >
        Regenerate
      </button>
    </div>
  </div>

  {/* Body (ONLY place summary renders) */}
  {aiBudgetError ? (
    <p className="mt-3 text-sm text-red-600">{aiBudgetError}</p>
  ) : aiBudgetSummary ? (
    aiBudgetOpen ? (
      <div className="mt-3 text-sm text-gray-800 whitespace-pre-line leading-relaxed">
        {aiBudgetSummary}
      </div>
    ) : aiBudgetPreview ? (
      <div className="mt-3 w-full text-sm italic text-gray-600 whitespace-normal break-words">
        <span className="font-medium not-italic">Preview:</span>{" "}
        {aiBudgetPreview}
      </div>
    ) : null
  ) : (
    <div className="mt-3 text-sm text-gray-500">
      Click Generate to create a short summary and takeaway.
    </div>
  )}
</div>



            {/* Per-category budget cards (only for budgetViewMonth) */}
            <div className="space-y-6">
              {budgetsForViewMonthAndSearch.map((b) => {
                const progress = getBudgetProgress(b.category, b.month);
                const isExpanded = !!expandedBudgets[b.id];
		if (!progress) {
    		return (
      		<div key={b.id} className="border rounded p-4 text-sm text-gray-500">
        		No budget progress available.
      		</div>
    		);
  		}

               // ✅ Use effective (rollover-aware) values in the UI
		const rollover = Number(rolloverByCategoryForViewMonth[b.category] || 0);
  		const baseBudget = Number(progress.budget || 0);
  		const effectiveBudget = Math.max(0, baseBudget + rollover);
  		const spentNum = Number(progress.spent || 0);
		 const pacing = pacingHintForMonth({
    			monthKey: b.month,
    			effectiveBudget,
    			spent: spentNum,
    			tolerance: 0.07,
  		});
  		const effectivePct = effectiveBudget > 0 ? (spentNum / effectiveBudget) * 100 : 0;
const isFullySpent = spentNum >= effectiveBudget && effectiveBudget > 0;

const isOverBudget = spentNum > effectiveBudget;

// Treat "fully spent" as its own display state
const pacingMode =
  isFullySpent && !isOverBudget
    ? "fixed_paid"          // Housing paid early (or exactly used)
    : isFullySpent && isOverBudget
    ? "exhausted"           // Variable category blew past budget
    : pacing?.status || "neutral"; // ahead / pace / behind / neutral

const pacingLabel =
  pacingMode === "fixed_paid"
    ? "Paid early"
    : pacingMode === "exhausted"
    ? "Budget exhausted"
    : pacing?.label || "";

const pacingColorClass =
  pacingMode === "fixed_paid"
    ? "text-gray-600"
    : pacingMode === "exhausted"
    ? "text-red-600"
    : pacingMode === "ahead"
    ? "text-green-700"
    : pacingMode === "behind"
    ? "text-red-600"
    : pacingMode === "pace"
    ? "text-gray-600"
    : "text-gray-500";


  		const effectiveRemaining = effectiveBudget - spentNum;
  		const effectiveOverBy = Math.max(0, spentNum - effectiveBudget);
		const isOver = effectiveRemaining < 0;
		const remainingLabel = isOver ? "Over by" : "Remaining";
		const remainingValue = isOver ? effectiveOverBy : effectiveRemaining;

                return (
                  <div key={b.id} className="border rounded p-4">
{pacing && (
  <div className={`text-xs mt-1 ${pacingColorClass}`}>
    Day {pacing.day} of {pacing.dim} · {pacingLabel}
  </div>
)}

{pacingMode === "behind" &&
  typeof pacing?.expected === "number" && (
    <div className="text-xs text-gray-500 mt-0.5">
      Target by today: ${Number(pacing.expected).toLocaleString()}
    </div>
  )}


{pacingMode === "fixed_paid" && (
  <div className="text-xs text-gray-500 mt-0.5">
    Paid early · Fixed monthly expense
  </div>
)}



                    <div className="flex justify-between items-center mb-3">
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="font-bold text-lg">{b.category}</h3>
                          {!isExpanded && progress && effectivePct >= 80 && effectivePct < 100 && (
                            <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-yellow-100 text-yellow-800">
                              Watch {Math.round(effectivePct)}%
                            </span>
                          )}
                        </div>
                        {editingBudgetId === b.id ? (
                          <div className="flex flex-wrap items-center gap-2 mt-1">
                            <select
                              value={editBudgetDraft?.category ?? b.category}
                              onChange={(e) =>
                                setEditBudgetDraft((p) => ({ ...p, category: e.target.value }))
                              }
                              className="border rounded px-2 py-1 text-sm"
                            >
                              {budgetCategories.map((c) => (
                                <option key={c} value={c}>
                                  {c}
                                </option>
                              ))}
                            </select>

                            <input
                              type="month"
                              value={editBudgetDraft?.month ?? b.month}
                              onChange={(e) =>
                                setEditBudgetDraft((p) => ({ ...p, month: e.target.value }))
                              }
                              className="border rounded px-2 py-1 text-sm"
                            />

                            <input
                              type="number"
                              value={editBudgetDraft?.amount ?? ""}
                              onChange={(e) =>
                                setEditBudgetDraft((p) => ({ ...p, amount: e.target.value }))
                              }
                              className="border rounded px-2 py-1 text-sm w-28"
                              placeholder="Amount"
                            />

                            <select
                              value={editBudgetDraft?.person ?? b.person}
                              onChange={(e) =>
                                setEditBudgetDraft((p) => ({ ...p, person: e.target.value }))
                              }
                              className="border rounded px-2 py-1 text-sm"
                            >
                              <option value="joint">Joint</option>
                              <option value="you">You</option>
                              <option value="wife">Wife</option>
                            </select>
                          </div>
                        ) : (
                          <p className="text-sm text-gray-500">
                            {monthLabelFromKey(b.month)} • {personLabels[b.person]}
                          </p>
                        )}
                      </div>

                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() => toggleBudgetDetails(b.id)}
                          className="text-sm text-indigo-600 hover:text-indigo-800"
                          title="Toggle details"
                        >
                          {isExpanded ? "Hide" : "Details"}
                        </button>

                        {editingBudgetId === b.id ? (
                          <>
                            <button
                              type="button"
                              onClick={saveEditBudget}
                              className="text-green-600 hover:text-green-800"
                              title="Save"
                            >
                              <Check size={18} />
                            </button>
                            <button
                              type="button"
                              onClick={() => cancelEditBudget({ setEditingBudgetId, setEditBudgetDraft })}
                              className="text-gray-500 hover:text-gray-700"
                              title="Cancel"
                            >
                              <X size={18} />
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              onClick={() => startEditBudget(b, { setEditingBudgetId, setEditBudgetDraft })}
                              className="text-gray-600 hover:text-gray-800"
                              title="Edit budget"
                            >
                              <Pencil size={18} />
                            </button>
                            <button
                              type="button"
                              onClick={() => deleteBudget(b.id)}
                              className="text-red-600 hover:text-red-800"
                              title="Delete budget"
                            >
                              <Trash2 size={18} />
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    {progress ? (
                      <>
                        {/* Budget vs Actual bar */}
                        <div className="w-full bg-gray-200 rounded-full h-4 mb-2">
                          <div
                            className={`h-4 rounded-full transition-all ${getProgressColor(
                              effectivePct
                            )}`}
                            style={{ width: `${Math.min(effectivePct, 100)}%` }}
                          />
                        </div>

                        {/* Summary row */}
                        <div className="grid grid-cols-1 md:grid-cols-4 gap-2 text-sm">
                          <div className="text-gray-700">
                            <span className="text-gray-500">Budget:</span>{" "}
                            <span className="font-semibold">
                              ${Number(effectiveBudget).toLocaleString()}
                            </span>

                             {rolloverEnabled && rollover !== 0 && (
                              <span className="ml-2 text-[11px] text-gray-500">
                                (Base {Number(baseBudget).toLocaleString()}{" "}
                                {rollover >= 0 ? "+" : "-"}{" "}
                                {Number(Math.abs(rollover)).toLocaleString()} rollover)
                              </span>
                            )}
                          </div>

                          <div className="text-gray-700">
                            <span className="text-gray-500">Spent:</span>{" "}
                            <span className="font-semibold">
                              ${Number(progress.spent).toLocaleString()}
                            </span>
                          </div>

                          <div className="text-gray-700">
                           <span className="text-gray-500">{remainingLabel}:</span>{" "}
  			<span className={isOver ? "text-red-600 font-semibold" : "text-green-700 font-semibold"}>
    				${Number(remainingValue || 0).toLocaleString()}
  			</span>
                          </div>

                          <div className="text-gray-700 md:text-right">
                            <span
                              className={`font-semibold ${
                                effectivePct > 100
                                  ? "text-red-600"
                                  : effectivePct > 80
                                  ? "text-yellow-600"
                                  : "text-green-600"
                              }`}
                            >
                              {effectivePct.toFixed(1)}%
                            </span>
                          </div>
                        </div>

                        {/* ✅ Details section (this is where JSX used to break; now safely outside ternary + fragment closed) */}
                        {isExpanded && (() => {
                          const txns = getBudgetTransactions(b.category, b.month);
                          const top = getTopContributors(txns, 3);
                        
			  const isShowAll = !!showAllBudgetTxns[b.id];
			  const DEFAULT_LIMIT = 8;
			  const shown = isShowAll ? txns : txns.slice(0, DEFAULT_LIMIT);

                          return (
                            <div className="mt-4 border-t pt-4 space-y-3">
                              <div className="text-sm text-gray-700">
                                {effectiveOverBy > 0 ? (
                                  <p className="text-red-600 font-medium">
                                    Over budget by ${Number(effectiveOverBy).toLocaleString()}
                                  </p>
                                ) : (
                                  <p className="text-green-700 font-medium">On track</p>
                                )}

                                <p className="text-xs text-gray-500 mt-1">
                                  Tip: this auto-expands when spending goes over 100% of  your effective budget(unless you manually toggle it).
                                </p>
                              </div>

                              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                                <div className="border rounded-lg p-3 bg-gray-50">
                                  <p className="text-xs font-semibold text-gray-700 mb-2">
                                    Recent transactions ({txns.length})
                                  </p>

                                  {txns.length === 0 ? (
                                    <p className="text-xs text-gray-500">
                                      No expenses recorded for this category/month.
                                    </p>
                                  ) : (
                                   <div className="space-y-2">
  {shown.map((t) => (
    <div
      key={t.id}
      className="flex items-center justify-between text-xs"
    >
      <div className="min-w-0 pr-3">
       <div className="flex items-center gap-2 min-w-0">
  	<p className="truncate font-medium text-gray-800">
    	{t.description || "Untitled"}
  	</p>
  	{t.recurring_rule_id ? (
    	<span className="shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold bg-indigo-100 text-indigo-700">
      Recurring
    	</span>
  	) : null}
	</div>

        <p className="text-[11px] text-gray-500">
          {t.date} • {personLabels[t.person] || t.person}
        </p>
      </div>
      <div className="font-semibold text-gray-800 whitespace-nowrap">
        ${Number(t.amount || 0).toLocaleString()}
      </div>
    </div>
  ))}

  {txns.length > DEFAULT_LIMIT && (
    <div className="pt-2 flex items-center justify-between">
      <p className="text-[11px] text-gray-500">
        {isShowAll
          ? `Showing all ${txns.length}.`
          : `Showing ${Math.min(DEFAULT_LIMIT, txns.length)} of ${txns.length}.`}
      </p>

      <button
        type="button"
        onClick={() =>
          setShowAllBudgetTxns((prev) => ({
            ...prev,
            [b.id]: !prev[b.id],
          }))
        }
        className="text-[12px] font-medium text-indigo-600 hover:text-indigo-800"
      >
        {isShowAll ? "Show less" : "Show all"}
      </button>
    </div>
  )}
</div>
                                  )}
                                </div>

                                <div className="border rounded-lg p-3 bg-gray-50">
                                  <p className="text-xs font-semibold text-gray-700 mb-2">
                                    Top contributors
                                  </p>

                                  {txns.length === 0 ? (
                                    <p className="text-xs text-gray-500">No contributors yet.</p>
                                  ) : (
                                    <div className="space-y-2">
                                      {top.map((row) => (
                                        <div
                                          key={row.description}
                                          className="flex items-center justify-between text-xs"
                                        >
                                          <span className="truncate pr-3 text-gray-800">
                                            {row.description}
                                          </span>
                                          <span className="font-semibold whitespace-nowrap">
                                            ${Number(row.total || 0).toLocaleString()}
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })()}
                      </>
                    ) : (
                      <div className="text-sm text-gray-500">
                        No budget progress available.
                      </div>
                    )}

                  </div>
                );
              })}

              {/* ✅ Empty state lives OUTSIDE the map */}
              {budgetsForViewMonth.length === 0 && (
                <div className="border rounded p-6 text-center text-gray-500">
                  No budgets for {budgetViewMonth} yet. Add one above.
                </div>
              )}
            </div>
          </div>
        )}   {/* End of Budget Logic */}

		        {/* PROJECTS TAB */}
{activeTab === "projects" && (
  <div className="space-y-6">
    <div className="bg-white rounded-lg shadow p-6">
      <h2 className="text-xl font-semibold mb-4">Planned Projects</h2>
      <p className="text-sm text-gray-600 mb-4">
        Track home fixes & planned spends (quotes, notes, and target month).
      </p>

      {/* Add Project form */}
      <div className="grid grid-cols-1 md:grid-cols-6 gap-3">
        <input
          type="text"
          placeholder="Project (e.g. Fireplace replacement)"
          value={newProject.name}
          onChange={(e) => setNewProject((p) => ({ ...p, name: e.target.value }))}
          className="border rounded px-3 py-2 md:col-span-2"
        />
        <input
          type="text"
          placeholder="Vendor (optional)"
          value={newProject.vendor}
          onChange={(e) => setNewProject((p) => ({ ...p, vendor: e.target.value }))}
          className="border rounded px-3 py-2"
        />
        <input
          type="number"
          placeholder="Quoted Amount"
          value={newProject.quotedAmount}
          onChange={(e) =>
            setNewProject((p) => ({ ...p, quotedAmount: e.target.value }))
          }
          className="border rounded px-3 py-2"
        />
        <input
          type="month"
          value={newProject.targetMonth}
          onChange={(e) => setNewProject((p) => ({ ...p, targetMonth: e.target.value }))}
          className="border rounded px-3 py-2"
        />
        <input
          type="file"
          multiple
  	  onChange={(e) => setNewProjectFiles(Array.from(e.target.files || []))}
          className="border rounded px-3 py-2"
          accept=".pdf,.xlsx,.xls,.doc,.docx,.png,.jpg,.jpeg"
        />

        <textarea
          placeholder="Notes (optional)"
          value={newProject.notes}
          onChange={(e) => setNewProject((p) => ({ ...p, notes: e.target.value }))}
          className="border rounded px-3 py-2 md:col-span-6"
          rows={3}
        />

       <button
  	type="button"
  	onClick={addProjectDb}
  	className="bg-indigo-600 text-white rounded px-4 py-2 hover:bg-indigo-700 flex items-center justify-center gap-2 md:col-span-6"
>
  	<PlusCircle size={20} /> Add Project
	</button>

      </div>
    </div>

	{pendingOpenUrl && (
  <div className="mb-3 rounded-lg border bg-indigo-50 px-4 py-3 flex items-center justify-between">
    <div className="text-sm">
      Ready to open: <span className="font-semibold">{pendingOpenName}</span>
      <span className="text-xs text-gray-600"> (link expires in ~5 min)</span>
    </div>

    <div className="flex items-center gap-3">
      <a
        href={pendingOpenUrl}
        target="_blank"
        rel="noreferrer"
        className="text-indigo-700 font-semibold hover:underline"
      >
        Open file
      </a>
      <button
        type="button"
        onClick={() => {
          setPendingOpenUrl(null);
          setPendingOpenName(null);
        }}
        className="text-gray-600 hover:text-gray-800 text-sm"
      >
        Dismiss
      </button>
    </div>
  </div>
)}


    {/* Projects table */}
    <div className="bg-white rounded-lg shadow p-6">
      <h3 className="text-lg font-semibold mb-3">Projects List</h3>

      <div className="overflow-x-auto border rounded-lg">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-50">
            <tr className="text-left">
              <th className="px-3 py-2">Project</th>
              <th className="px-3 py-2">Vendor</th>
              <th className="px-3 py-2 text-right">Quote</th>
              <th className="px-3 py-2">Target Month</th>
              <th className="px-3 py-2">Notes</th>
              <th className="px-3 py-2 text-center">File</th>
              <th className="px-3 py-2 text-center">Actions</th>
            </tr>
          </thead>

<tbody>
  {projects.map((p) => {
    const isEditing = editingProjectId === p.id;

    return (
      <tr key={p.id} className="border-b">
        {/* Project Name */}
        <td className="px-3 py-2 font-medium">
          {isEditing ? (
            <input
              value={editProjectDraft?.name || ""}
              onChange={(e) =>
                setEditProjectDraft((prev) => ({
                  ...(prev || {}),
                  name: e.target.value,
                }))
              }
              className="border rounded px-2 py-1 text-sm w-full"
            />
          ) : (
            p.name
          )}
        </td>

        {/* Vendor */}
        <td className="px-3 py-2">
          {isEditing ? (
            <input
              value={editProjectDraft?.vendor || ""}
              onChange={(e) =>
                setEditProjectDraft((prev) => ({
                  ...(prev || {}),
                  vendor: e.target.value,
                }))
              }
              className="border rounded px-2 py-1 text-sm w-full"
            />
          ) : (
            p.vendor || "-"
          )}
        </td>

        {/* Quoted Amount */}
        <td className="px-3 py-2 text-right">
          {isEditing ? (
            <input
              type="number"
              value={editProjectDraft?.quotedAmount ?? ""}
              onChange={(e) =>
                setEditProjectDraft((prev) => ({
                  ...(prev || {}),
                  quotedAmount: e.target.value,
                }))
              }
              className="border rounded px-2 py-1 text-sm w-28 text-right"
            />
          ) : (
            `$${Number(p.quotedAmount || 0).toLocaleString()}`
          )}
        </td>

        {/* Target Month */}
        <td className="px-3 py-2">
          {isEditing ? (
            <input
              type="month"
              value={editProjectDraft?.targetMonth || ""}
              onChange={(e) =>
                setEditProjectDraft((prev) => ({
                  ...(prev || {}),
                  targetMonth: e.target.value,
                }))
              }
              className="border rounded px-2 py-1 text-sm"
            />
          ) : (
            p.targetMonth
          )}
        </td>

        {/* Notes */}
        <td className="px-3 py-2">
          {isEditing ? (
            <textarea
              value={editProjectDraft?.notes || ""}
              onChange={(e) =>
                setEditProjectDraft((prev) => ({
                  ...(prev || {}),
                  notes: e.target.value,
                }))
              }
              className="border rounded px-2 py-1 text-sm w-full"
              rows={2}
            />
          ) : (
            <span className="text-xs text-gray-600">{p.notes || ""}</span>
          )}
        </td>

        {/* Quote Files */}
        <td className="px-3 py-2 text-center">
          {(() => {
            const pid = Number(p.id);
            const files = projectFilesByProjectId?.[pid] || [];

            if (!files.length) return <span className="text-xs text-gray-500">—</span>;

            return (
              <details className="inline-block text-left">
                <summary className="cursor-pointer text-xs text-indigo-600 hover:underline list-none">
                  Open quote ({files.length} file{files.length === 1 ? "" : "s"})
                </summary>

                <div className="mt-2 w-80 max-w-[80vw] rounded-lg border bg-white shadow-sm p-2">
                  <div className="max-h-56 overflow-auto">
                    {files.map((f) => (
                      <div
                        key={f.id}
                        className="flex items-center justify-between gap-2 px-2 py-2 rounded hover:bg-gray-50"
                        title={f.filePath}
                      >
                        <button
                          type="button"
                          onClick={() => openProjectFileRow(f, p.name)}
                          className="min-w-0 text-left text-xs text-indigo-700 hover:underline truncate"
                        >
                          {f.fileName || "Quote file"}
                        </button>

                        <div className="flex items-center gap-2 shrink-0">
                          {/* Replace */}
                          <label className="text-xs text-gray-700 hover:underline cursor-pointer">
                            Replace
                            <input
                              type="file"
                              className="hidden"
                              onChange={async (e) => {
                                const file = e.target.files?.[0];
                                e.target.value = "";
                                if (!file) return;
                                await replaceProjectFile({
                                  projectId: pid,
                                  oldFileRow: f,
                                  newFile: file,
                                });
                              }}
                            />
                          </label>

                          {/* Delete */}
                          <button
                            type="button"
                            onClick={() => deleteProjectFileDb(f)}
                            className="text-xs text-red-600 hover:underline"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </details>
            );
          })()}
        </td>

        {/* Actions */}
        <td className="px-3 py-2 text-center">
          {isEditing ? (
            <div className="flex flex-col items-center gap-2">
              {/* Upload additional files (staged until Save) */}
              <label className="text-xs text-indigo-600 hover:underline cursor-pointer">
                Add more files
                <input
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    const files = Array.from(e.target.files || []);
                    e.target.value = "";
                    if (!files.length) return;

                    // Stage files for persistence on Save
                    setEditProjectFiles((prev) => [...(prev ?? []), ...files]);
                  }}
                />
              </label>

              {/* Show staged count (VALID location: inside td) */}
              {!!editProjectFiles?.length && (
                <div className="text-[11px] text-gray-500">
                  {editProjectFiles.length} file(s) will upload on Save
                </div>
              )}

              {/* Save / Cancel */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={saveEditProjectDb}
                  className="text-indigo-600 hover:text-indigo-800"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={cancelEditProject}
                  className="text-gray-600 hover:text-gray-800"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center justify-center gap-2">
              <button
                type="button"
                onClick={() => startEditProject(p)}
                className="text-indigo-600 hover:text-indigo-800"
              >
                Edit
              </button>
              <button
                type="button"
                onClick={() => deleteProjectDb(p.id)}
                className="text-red-600 hover:text-red-800"
              >
                Delete
              </button>
            </div>
          )}
        </td>
      </tr>
    );
  })}

  {!projects.length && (
    <tr>
      <td colSpan={7} className="px-3 py-6 text-center text-gray-500">
        No projects yet.
      </td>
    </tr>
  )}
</tbody>

<tfoot>
  <tr className="bg-gray-50 border-t">
    <td colSpan={2} className="px-3 py-2 font-semibold text-gray-700">
      Subtotal
    </td>
    <td className="px-3 py-2 text-right font-bold">
      ${Number(projectsQuoteSubtotal || 0).toLocaleString()}
    </td>
    <td colSpan={4} />
  </tr>
</tfoot>
        </table>
      </div>

      <p className="text-xs text-gray-500 mt-3">
        Next step: persist projects to DB + store quote file path on the project record + add “Open file” links.
      </p>
    </div>
  </div>
)}
   {/* End of Project Logic */}

   {/* TREND TAB */}
{activeTab === "trends" && (() => {
  const lastTrendMonth =
    categoryTrends.months?.[categoryTrends.months.length - 1];

  return (
    <div className="space-y-6">
      {/* Category Trends */}
      <div className="bg-white rounded-lg shadow p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold">Category Trends</h2>
          <div className="text-xs text-gray-500">
            Last {categoryTrends.months.length} months
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Top categories */}
          <div className="border rounded-lg p-4">
            <div className="text-sm font-semibold mb-2 flex items-center justify-between">
              <span>Top categories</span>
              {lastTrendMonth && (
                <span className="text-xs font-normal text-gray-500">
                  {monthLabelFromKey(lastTrendMonth)}
                </span>
              )}
            </div>

<div className="space-y-2">
  {categoryTrends.top.map((r) => {
    const max = Math.max(...r.series, 1);

    return (
      <div key={r.category} className="py-3 border-b last:border-b-0">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline justify-between gap-3">
              <div className="font-semibold truncate">{r.category}</div>
              <div className="shrink-0 text-right font-semibold tabular-nums">
                ${r.cur.toLocaleString()}
              </div>
            </div>

           {/* Sparkline */}
<div className="mt-1 h-5 flex items-end gap-1">
  {r.series.map((v, idx) => {
    const h = Math.round((v / max) * 18);
    const isLast = idx === r.series.length - 1;

    const barColor = isLast
      ? r.delta >= 0
        ? "bg-red-400"
        : "bg-green-400"
      : "bg-gray-300";

    return (
      <div
        key={idx}
        title={`${categoryTrends.months[idx]}: $${v.toLocaleString()}`}
        className={`w-2 rounded-sm ${barColor} transition-all duration-500 ease-out`}
        style={{
          height: `${Math.max(2, h)}px`,
          transitionDelay: `${idx * 40}ms`, // nice cascade
        }}
      />
    );
  })}
</div>



            <div className="mt-1 text-xs text-gray-500">
              vs prev:{" "}
              <span className="font-medium tabular-nums">
                {r.delta >= 0 ? "+" : "-"}${Math.abs(r.delta).toLocaleString()}
              </span>
              {r.prev > 0 && (
                <span className="ml-2">
                  ({r.pct >= 0 ? "+" : ""}
                  {Number.isFinite(r.pct) ? r.pct.toFixed(0) : "0"}%)
                </span>
              )}
            </div>
          </div>
        </div>
      </div>
    );
  })}
</div>

          </div>

          {/* Biggest increases */}
          <div className="border rounded-lg p-4">
            <div className="text-sm font-semibold mb-2">
              Biggest increases (MoM)
            </div>

            <div className="space-y-2">
              {categoryTrends.risers.map((r) => (
                <div
                  key={r.category}
                  className="flex items-center justify-between gap-3"
                >
                  <div className="min-w-0 truncate font-medium">
                    {r.category}
                  </div>
                  <div className="text-right font-semibold text-red-700">
                    +${Math.max(0, r.delta).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
})()}


   {/* End of TREND TAB */}


      </div>  {/* closes max-w-7xl mx-auto */}
    </div>  {/* closes min-h-screen div */}
    </div>  {/* closes blur/disable wrapper */}
    {/* =========================================================
          MODAL GATES (must be OUTSIDE the blurred wrapper)
          ========================================================= */}

      {/* Auth modal gate */}
      {authOpen && (
        <AuthModal
          onClose={() => {}}
          onSignedIn={() => setAuthOpen(false)}
        />
      )}

      {/* Household gate (only after signed in) */}
      {!authOpen && householdGateOpen && (
        <HouseholdGate
          userId={session?.user?.id}
          onDone={(hid) => {
            setHouseholdId(hid);
            setHouseholdGateOpen(false);
          }}
        />
      )}
    </div>
  );
};

export default FinanceTracker;