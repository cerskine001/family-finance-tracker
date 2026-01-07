import { monthToDb, toMonthKey } from "./dateHelpers"; 

export function startEditBudget(budget, { setEditingBudgetId, setEditBudgetDraft }) {
  setEditingBudgetId(budget.id);
  setEditBudgetDraft({
    ...budget,
    amount: String(budget.amount ?? ""),
  });
}

export function cancelEditBudget({ setEditingBudgetId, setEditBudgetDraft }) {
  setEditingBudgetId(null);
  setEditBudgetDraft(null);
}

export async function saveEditBudget({
  editBudgetDraft,
  editingBudgetId,
  canViewData,
  householdId,
  supabase,
  monthToDb,
  toMonthKey,
  setBudgets,
  cancelEditBudget,
}) {
  if (!editBudgetDraft || editingBudgetId == null) return;

  const updated = {
    ...editBudgetDraft,
    amount: parseFloat(editBudgetDraft.amount || "0"),
  };

  if (canViewData) {
    const payload = {
      category: updated.category,
      amount: updated.amount,
      month: monthToDb(updated.month),
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

    setBudgets((prev) =>
      prev.map((b) =>
        b.id === editingBudgetId
          ? { ...data, amount: Number(data.amount), month: toMonthKey(data.month) }
          : b
      )
    );
  } else {
    setBudgets((prev) =>
      prev.map((b) => (b.id === editingBudgetId ? updated : b))
    );
  }

  cancelEditBudget();
}

