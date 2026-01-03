// FinanceTracker.jsx
import { supabase } from "./supabaseClient";
import React, { useState, useMemo, useEffect, useCallback } from "react";
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

import TransactionCsvImport from "./components/TransactionCsvImport";
import AuthModal from "./components/AuthModal";
import HouseholdGate from "./components/HouseholdGate";
import InviteMember from "./components/InviteMember";

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
  const header = ["Date", "Description", "Amount", "Type", "Category", "Person"];

  const lines = rows.map((t) => [
    t.date,
    t.description || "",
    t.amount,
    t.type,
    t.category || "",
    t.person || "joint",
  ]);

  const csvLines = [
    header.map(toCsvValue).join(","),
    ...lines.map((row) => row.map(toCsvValue).join(",")),
  ];

  return csvLines.join("\r\n");
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
  const [y, m] = String(monthKey).split("-").map(Number);
  const d = new Date(y, (m - 1) - 1, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

const nextMonthKey = (monthKey) => {
  const [y, m] = String(monthKey).split("-").map(Number);
  const d = new Date(y, (m - 1) + 1, 1);
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

  // Form states
  const [newTransaction, setNewTransaction] = useState({
    date: new Date().toISOString().split("T")[0],
    description: "",
    category: "Food",
    amount: "",
    type: "expense",
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

// Budget: per-card "show all transactions" toggle
const [showAllBudgetTxns, setShowAllBudgetTxns] = useState({});

const [isOwner, setIsOwner] = useState(false);

useEffect(() => {
  if (!session?.user?.id || !householdId) {
    setIsOwner(false);
    return;
  }

  (async () => {
    const { data, error } = await supabase
      .from("household_members")
      .select("role")
      .eq("user_id", session.user.id)
      .eq("household_id", householdId)
      .maybeSingle();

    if (!error) {
      setIsOwner(data?.role === "owner");
    }
  })();
}, [session?.user?.id, householdId]);


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

    // After login, check if user belongs to a household
    (async () => {
      const { data, error } = await supabase
        .from("household_members")
        .select("household_id")
        .eq("user_id", session.user.id)
        .limit(1)
        .maybeSingle();

      if (error) {
        console.error(error);
        setHouseholdId(null);
        setHouseholdGateOpen(true);
        return;
      }

      if (data?.household_id) {
        setHouseholdId(data.household_id);
        setHouseholdGateOpen(false);
      } else {
        setHouseholdId(null);
        setHouseholdGateOpen(true);
      }
    })();
  }, [session?.user?.id]);

  const isAuthed = !!session?.user?.id;
  const canViewData = isAuthed && !!householdId;

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
        ] = await Promise.all([
          supabase.from("transactions").select("*").eq("household_id", householdId).order("date", { ascending: false }),
          supabase.from("budgets").select("*").eq("household_id", householdId).order("created_at", { ascending: false }),
          supabase.from("assets").select("*").eq("household_id", householdId).order("created_at", { ascending: false }),
          supabase.from("liabilities").select("*").eq("household_id", householdId).order("created_at", { ascending: false }),
          supabase.from("recurring_rules").select("*").eq("household_id", householdId).order("created_at", { ascending: false }),
        ]);

        if (ignore) return;

        if (txRes.error) console.warn("[db] load transactions failed", txRes.error);
        if (budRes.error) console.warn("[db] load budgets failed", budRes.error);
        if (aRes.error) console.warn("[db] load assets failed", aRes.error);
        if (lRes.error) console.warn("[db] load liabilities failed", lRes.error);
        if (rRes.error) console.warn("[db] load recurring_rules failed", rRes.error);

        const txns = (txRes.data ?? []).map((t) => ({ ...t, amount: Number(t.amount) }));
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
          frequency: r.frequency ?? 'monthly',
          start_date: r.start_date,
          end_date: r.end_date,
        }));

        setTransactions(txns);
        setBudgets(buds);
        setAssets(assetsRows);
        setLiabilities(liabRows);
        setRecurringRules(rules);
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

        if (ignore) return;

        setTransactions(defaultTransactions);
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

    tableTransactions.forEach((t) => {
      if (t.type === "income") income += t.amount;
      if (t.type === "expense") expenses += t.amount;
    });

    return { income, expenses, net: income - expenses };
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

      if (t.type === "income") group.income += t.amount;
      if (t.type === "expense") group.expenses += t.amount;
      group.net = group.income - group.expenses;
    });

    return Array.from(groups.values()).sort((a, b) => (a.key < b.key ? 1 : -1));
  }, [tableTransactions]);

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
  // Totals
  // ---------------------------------------------------------------------------
  const totalIncome = filteredTransactions
    .filter((t) => t.type === "income")
    .reduce((sum, t) => sum + t.amount, 0);

  const totalExpenses = filteredTransactions
    .filter((t) => t.type === "expense")
    .reduce((sum, t) => sum + t.amount, 0);

  const totalAssets = filteredAssets.reduce((sum, a) => sum + a.value, 0);
  const totalLiabilities = filteredLiabilities.reduce((sum, l) => sum + l.value, 0);
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
            t.category === category &&
            t.date &&
            t.date.startsWith(month)
        )
        .reduce((sum, t) => sum + Number(t.amount || 0), 0);

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
        created_by: session.user.id,
      };

      const { data, error } = await supabase.from("transactions").insert(payload).select("*").single();
      if (error) {
        console.warn("[db] addTransaction failed", error);
        alert(error.message);
        return;
      }
      setTransactions((prev) => [{ ...data, amount: Number(data.amount) }, ...prev]);
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
    });
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

const addRecurringRule = async () => {
    if (!session?.user?.id || !householdId) return;

    const description = newRecurring.description?.trim();
    const amountNum = Number(newRecurring.amount);

    if (!description) {
      alert("Please enter a description for the recurring item.");
      return;
    }
    if (!Number.isFinite(amountNum)) {
      alert("Please enter a valid amount.");
      return;
    }

    const payload = {
      household_id: householdId,
      description,
      category: newRecurring.category,
      amount: amountNum,
      type: newRecurring.type,
      person: newRecurring.person,
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
      setNewRecurring((prev) => ({
        ...prev,
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

  const applyRecurringForCurrentMonth = () => {
    if (!recurringRules.length) {
      alert("No recurring transactions defined yet.");
      return;
    }

    const [year, month] = currentMonth.split("-");
    const pad2 = (n) => String(n).padStart(2, "0");

    const newTxns = [];

    recurringRules.forEach((rule, idx) => {
      if (!rule.active) return;

      const safeDay = Math.min(Math.max(rule.dayOfMonth || 1, 1), 31);
      const date = `${year}-${month}-${pad2(safeDay)}`;

      const exists = transactions.some(
        (t) =>
          t.date === date &&
          t.description === rule.description &&
          t.amount === rule.amount &&
          t.type === rule.type &&
          t.person === rule.person
      );

      if (!exists) {
        newTxns.push({
          id: Date.now() + idx,
          date,
          description: rule.description,
          category: rule.category,
          amount: rule.amount,
          type: rule.type,
          person: rule.person,
        });
      }
    });

    if (!newTxns.length) {
      alert(`No new recurring transactions to add for ${currentMonth}. They may already exist.`);
      return;
    }

    setTransactions((prev) => [...prev, ...newTxns]);
    alert(`Added ${newTxns.length} recurring transaction(s) for ${currentMonth}.`);
  };

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

  const saveEditTransaction = () => {
    if (!editTransactionDraft || editingTransactionId == null) return;

    const updated = {
      ...editTransactionDraft,
      amount: parseFloat(editTransactionDraft.amount) || 0,
    };
  setTransactions((prev) =>
      prev.map((t) => (t.id === editingTransactionId ? updated : t))
    );

    setEditingTransactionId(null);
    setEditTransactionDraft(null);
  };

  // ---------------------------------------------------------------------------
  // Edit helpers (Budgets / Assets / Liabilities)
  // ---------------------------------------------------------------------------
  
  // PUT BACK ADD RECURRING RULE HERE IF NEEDED

const startEditBudget = (b) => {
    setEditingBudgetId(b.id);
    setEditBudgetDraft({ ...b, amount: String(b.amount ?? "") });
  };
  const cancelEditBudget = () => {
    setEditingBudgetId(null);
    setEditBudgetDraft(null);
  };
  const saveEditBudget = async () => {
    if (!editBudgetDraft || editingBudgetId == null) return;

    const updated = {
      ...editBudgetDraft,
      amount: parseFloat(editBudgetDraft.amount || "0"),
    };

    if (canViewData) {
      const payload = {
        category: updated.category,
        amount: updated.amount,
        month: updated.month,
        person: updated.person,
      };

      const { data, error } = await supabase
        .from("budgets")
        .update(payload)
        .eq("id", editingBudgetId)
        .eq("household_id", householdId)
        .select("*")
        .single();

      if (error) return alert(error.message);

      setBudgets((prev) => prev.map((b) => (b.id === editingBudgetId ? { ...data, amount: Number(data.amount) } : b)));
    } else {
      setBudgets((prev) => prev.map((b) => (b.id === editingBudgetId ? updated : b)));
    }

    cancelEditBudget();
  };

  const startEditAsset = (a) => {
    setEditingAssetId(a.id);
    setEditAssetDraft({ ...a, value: String(a.value ?? "") });
  };
  const cancelEditAsset = () => {
    setEditingAssetId(null);
    setEditAssetDraft(null);
  };
  const saveEditAsset = async () => {
    if (!editAssetDraft || editingAssetId == null) return;

    const updated = { ...editAssetDraft, value: parseFloat(editAssetDraft.value || "0") };

    if (canViewData) {
      const payload = { name: updated.name, value: updated.value, person: updated.person };
      const { data, error } = await supabase
        .from("assets")
        .update(payload)
        .eq("id", editingAssetId)
        .eq("household_id", householdId)
        .select("*")
        .single();
      if (error) return alert(error.message);

      setAssets((prev) => prev.map((a) => (a.id === editingAssetId ? { ...data, value: Number(data.value) } : a)));
    } else {
      setAssets((prev) => prev.map((a) => (a.id === editingAssetId ? updated : a)));
    }

    cancelEditAsset();
  };

  const startEditLiability = (l) => {
    setEditingLiabilityId(l.id);
    setEditLiabilityDraft({ ...l, value: String(l.value ?? "") });
  };
  const cancelEditLiability = () => {
    setEditingLiabilityId(null);
    setEditLiabilityDraft(null);
  };
  const saveEditLiability = async () => {
    if (!editLiabilityDraft || editingLiabilityId == null) return;

    const updated = { ...editLiabilityDraft, value: parseFloat(editLiabilityDraft.value || "0") };

    if (canViewData) {
      const payload = { name: updated.name, value: updated.value, person: updated.person };
      const { data, error } = await supabase
        .from("liabilities")
        .update(payload)
        .eq("id", editingLiabilityId)
        .eq("household_id", householdId)
        .select("*")
        .single();
      if (error) return alert(error.message);

      setLiabilities((prev) => prev.map((x) => (x.id === editingLiabilityId ? { ...data, value: Number(data.value) } : x)));
    } else {
      setLiabilities((prev) => prev.map((x) => (x.id === editingLiabilityId ? updated : x)));
    }

    cancelEditLiability();
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

  // Category totals for donut chart
  const categoryTotals = filteredTransactions
    .filter((t) => t.type === "expense")
    .reduce((acc, t) => {
      acc[t.category] = (acc[t.category] || 0) + t.amount;
      return acc;
    }, {});

  // Monthly spending totals
  const monthlyTotals = filteredTransactions
    .filter((t) => t.type === "expense")
    .reduce((acc, t) => {
      const month = t.date.slice(0, 7);
      acc[month] = (acc[month] || 0) + t.amount;
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
      		<InviteMember session={session} />
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
            {["dashboard", "transactions", "assets", "liabilities", "budget"].map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-4 py-2 font-medium capitalize ${
                  activeTab === tab
                    ? "text-indigo-600 border-b-2 border-indigo-600"
                    : "text-gray-600 hover:text-indigo-600"
                }`}
              >
                {tab}
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
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
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
                    <p className="text-gray-600 text-sm">Net Worth</p>
                    <p className="text-2xl font-bold text-indigo-600">
                      ${netWorth.toLocaleString()}
                    </p>
                  </div>
                  <Wallet className="text-indigo-600" size={32} />
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
                    .map((t) => (
                      <div key={t.id} className="flex justify-between items-center">
                        <div>
                          <p className="font-medium">{t.description}</p>
                          <p className="text-xs text-gray-500">
                            {t.date} • {personLabels[t.person]}
                          </p>
                        </div>
                        <span
                          className={`font-bold ${
                            t.type === "income" ? "text-green-600" : "text-red-600"
                          }`}
                        >
                          {t.type === "income" ? "+" : "-"}${t.amount}
                        </span>
                      </div>
                    ))}
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
                <TransactionCsvImport
                  onImport={(rows) => setTransactions((prev) => [...prev, ...rows])}
                />
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

            {/* Recurring Transactions Manager */}
            <div className="mb-6 border rounded-lg p-4 bg-indigo-50/40">
              <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-3">
                <div>
                  <h3 className="font-semibold text-gray-800">Recurring Transactions</h3>
                  <p className="text-xs text-gray-600">
                    Define monthly items (salary, rent, subscriptions) and apply them
                    to the current month in one click.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={applyRecurringForCurrentMonth}
                  className="bg-indigo-600 text-white text-sm px-4 py-2 rounded-md hover:bg-indigo-700"
                >
                  Apply to {currentMonth}
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-6 gap-3 mb-4">
                <input
                  type="text"
                  placeholder="Description"
                  value={newRecurring.description}
                  onChange={(e) =>
                    setNewRecurring({ ...newRecurring, description: e.target.value })
                  }
                  className="border rounded px-3 py-2"
                />
                <select
                  value={newRecurring.category}
                  onChange={(e) =>
                    setNewRecurring({ ...newRecurring, category: e.target.value })
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
                    setNewRecurring({ ...newRecurring, amount: e.target.value })
                  }
                  className="border rounded px-3 py-2"
                />
                <select
                  value={newRecurring.type}
                  onChange={(e) => setNewRecurring({ ...newRecurring, type: e.target.value })}
                  className="border rounded px-3 py-2"
                >
                  <option value="income">Income</option>
                  <option value="expense">Expense</option>
                </select>
                <select
                  value={newRecurring.person}
                  onChange={(e) =>
                    setNewRecurring({ ...newRecurring, person: e.target.value })
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
                    setNewRecurring({ ...newRecurring, dayOfMonth: e.target.value })
                  }
                  className="border rounded px-3 py-2"
                />

                <button
                  type="button"
                  onClick={addRecurringRule}
                  className="bg-indigo-600 text-white rounded px-4 py-2 hover:bg-indigo-700 flex items-center justify-center gap-2 md:col-span-6"
                >
                  <PlusCircle size={18} /> Add Recurring Rule
                </button>
              </div>

              {recurringRules.length === 0 ? (
                <p className="text-xs text-gray-500">No recurring rules yet. Add one above.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-xs md:text-sm">
                    <thead className="bg-gray-100">
                      <tr>
                        <th className="px-3 py-2 text-left">Description</th>
                        <th className="px-3 py-2 text-left">Category</th>
                        <th className="px-3 py-2 text-right">Amount</th>
                        <th className="px-3 py-2 text-left">Type</th>
                        <th className="px-3 py-2 text-left">Person</th>
                        <th className="px-3 py-2 text-left">Schedule</th>
                        <th className="px-3 py-2 text-center">Status</th>
                        <th className="px-3 py-2 text-center">Action</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recurringRules.map((r) => (
                        <tr key={r.id} className="border-b">
                          <td className="px-3 py-2">{r.description}</td>
                          <td className="px-3 py-2">{r.category}</td>
                          <td className="px-3 py-2 text-right">
                            ${Number(r.amount || 0).toLocaleString()}
                          </td>
                          <td className="px-3 py-2 capitalize">{r.type}</td>
                          <td className="px-3 py-2">
                            {personLabels[r.person] || r.person}
                          </td>
                          <td className="px-3 py-2">Every month on day {r.dayOfMonth}</td>
                          <td className="px-3 py-2 text-center">
                            <span
                              className={`inline-flex px-2 py-1 rounded-full text-[11px] font-semibold ${
                                r.active
                                  ? "bg-green-100 text-green-700"
                                  : "bg-gray-200 text-gray-600"
                              }`}
                            >
                              {r.active ? "Active" : "Paused"}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-center">
                            <div className="flex items-center justify-center gap-2">
                              <button
                                onClick={() => toggleRecurringActive(r.id)}
                                className="text-indigo-600 hover:text-indigo-800"
                              >
                                {r.active ? "Pause" : "Resume"}
                              </button>
                              <button
                                onClick={() => deleteRecurringRule(r.id)}
                                className="text-red-600 hover:text-red-800"
                              >
                                Delete
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* Manual add form */}
            <div className="grid grid-cols-1 md:grid-cols-6 gap-3 mb-6">
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
              <button
                type="button"
                onClick={addTransaction}
                className="bg-indigo-600 text-white rounded px-4 py-2 hover:bg-indigo-700 flex items-center justify-center gap-2 md:col-span-6"
              >
                <PlusCircle size={20} /> Add Transaction
              </button>
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
                    <th className="px-4 py-2 text-right">Amount</th>
                    <th className="px-4 py-2 text-center">Action</th>
                  </tr>
                </thead>

                <tbody>
                  {groupedTransactionsByMonth.map((group) => (
                    <React.Fragment key={group.key}>
                      <tr className="bg-gray-100">
                        <td colSpan={2} className="px-4 py-2 font-semibold">
                          {group.label}
                        </td>
                        <td className="px-4 py-2 text-xs text-gray-600">
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
                            {group.net >= 0 ? "+" : "-"}$
                            {Math.abs(group.net).toLocaleString()}
                          </span>
                        </td>
                        <td colSpan={3}></td>
                      </tr>

                      {group.items.map((t) => {
                        const isEditing = t.id === editingTransactionId;

                        return (
                          <tr key={t.id} className="border-b hover:bg-gray-50">
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
                                t.description
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
                                personLabels[t.person]
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
                                    onClick={saveEditTransaction}
                                    className="text-green-600 hover:text-green-800"
                                    title="Save"
                                  >
                                    <Check size={18} />
                                  </button>
                                  <button
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
                                    onClick={() => startEditTransaction(t)}
                                    className="text-indigo-600 hover:text-indigo-800"
                                    title="Edit"
                                  >
                                    <Pencil size={18} />
                                  </button>
                                  <button
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
                <p className="text-xs text-gray-500">Remaining</p>
                <p
                  className={`text-xl font-bold ${
                    (budgetSummary.remaining || 0) < 0 ? "text-red-600" : "text-green-700"
                  }`}
                >
                  ${Number(budgetSummary.remaining || 0).toLocaleString()}
                </p>
              </div>
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
  		const effectivePct = effectiveBudget > 0 ? (spentNum / effectiveBudget) * 100 : 0;
  		const effectiveRemaining = effectiveBudget - spentNum;
  		const effectiveOverBy = Math.max(0, spentNum - effectiveBudget);

                return (
                  <div key={b.id} className="border rounded p-4">
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
                              onClick={cancelEditBudget}
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
                              onClick={() => startEditBudget(b)}
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
                            <span className="text-gray-500">Remaining:</span>{" "}
                            <span
                              className={`font-semibold ${
                                effectiveRemaining < 0 ? "text-red-600" : "text-green-700"
                              }`}
                            >
                              ${Number(effectiveRemaining).toLocaleString()}
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
        <p className="truncate font-medium text-gray-800">
          {t.description || "Untitled"}
        </p>
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
        )}
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