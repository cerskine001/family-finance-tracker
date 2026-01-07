// src/helpers/liabilityHelpers.js

export function startEditLiabilityHelper({ l, setEditingLiabilityId, setEditLiabilityDraft }) {
  setEditingLiabilityId(l.id);
  setEditLiabilityDraft({ ...l, value: String(l.value ?? "") });
}

export function cancelEditLiabilityHelper({ setEditingLiabilityId, setEditLiabilityDraft }) {
  setEditingLiabilityId(null);
  setEditLiabilityDraft(null);
}

export async function saveEditLiabilityHelper({
  editLiabilityDraft,
  editingLiabilityId,
  canViewData,
  householdId,
  supabase,
  setLiabilities,
  cancelEditLiability, // pass your wrapper
}) {
  if (!editLiabilityDraft || editingLiabilityId == null) return;

  const updated = {
    ...editLiabilityDraft,
    value: parseFloat(editLiabilityDraft.value || "0"),
  };

  if (canViewData) {
    const payload = {
      name: updated.name,
      value: updated.value,
      person: updated.person,
    };

    const { data, error } = await supabase
      .from("liabilities")
      .update(payload)
      .eq("id", editingLiabilityId)
      .eq("household_id", householdId)
      .select("*")
      .single();

    if (error) {
      alert(error.message);
      return;
    }

    setLiabilities((prev) =>
      prev.map((x) =>
        x.id === editingLiabilityId
          ? { ...data, value: Number(data.value) }
          : x
      )
    );
  } else {
    setLiabilities((prev) =>
      prev.map((x) => (x.id === editingLiabilityId ? updated : x))
    );
  }

  cancelEditLiability();
}
