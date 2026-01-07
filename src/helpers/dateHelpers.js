export const monthToDb = (monthKey) => {
  if (!monthKey) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(monthKey)) return monthKey; // already a full date
  if (/^\d{4}-\d{2}$/.test(monthKey)) return `${monthKey}-01`; // month key -> first of month
  return null;
};

export const toMonthKey = (dbDate) => {
  if (!dbDate) return "";
  return String(dbDate).slice(0, 7);
};
