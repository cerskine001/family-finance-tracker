// src/helpers/assetHelpers.js

export function startEditAssetHelper({ a, setEditingAssetId, setEditAssetDraft }) {
  setEditingAssetId(a.id);
  setEditAssetDraft({ ...a, value: String(a.value ?? "") });
}

export function cancelEditAssetHelper({ setEditingAssetId, setEditAssetDraft }) {
  setEditingAssetId(null);
  setEditAssetDraft(null);
}

export async function saveEditAssetHelper({
  editAssetDraft,
  editingAssetId,
  canViewData,
  householdId,
  supabase,
  setAssets,
  cancelEditAsset, // pass your wrapper
}) {
  if (!editAssetDraft || editingAssetId == null) return;

  const updated = {
    ...editAssetDraft,
    value: parseFloat(editAssetDraft.value || "0"),
  };

  if (canViewData) {
    const payload = {
      name: updated.name,
      value: updated.value,
      person: updated.person,
    };

    const { data, error } = await supabase
      .from("assets")
      .update(payload)
      .eq("id", editingAssetId)
      .eq("household_id", householdId)
      .select("*")
      .single();

    if (error) {
      alert(error.message);
      return;
    }

    setAssets((prev) =>
      prev.map((x) =>
        x.id === editingAssetId ? { ...data, value: Number(data.value) } : x
      )
    );
  } else {
    setAssets((prev) =>
      prev.map((x) => (x.id === editingAssetId ? updated : x))
    );
  }

  cancelEditAsset();
}
