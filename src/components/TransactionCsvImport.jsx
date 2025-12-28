import React, { useState } from "react";
import Papa from "papaparse";

const SAMPLE_HEADER = "Date,Description,Amount,Type,Category,Person";

/**
 * Expected CSV format (with header row):
 *
 * Date,Description,Amount,Type,Category,Person
 * 2024-12-01,Salary,5000,income,Income,you
 * 2024-12-03,Groceries,250,expense,Food,joint
 *
 * - Date: YYYY-MM-DD
 * - Amount: positive number
 * - Type: "income" or "expense"
 * - Category: any of your app categories (Food, Transportation, etc.)
 * - Person: "joint", "you", or "wife"
 */

const TransactionCsvImport = ({ onImport }) => {
  const [parsedRows, setParsedRows] = useState([]);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const handleFileChange = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setError("");
    setInfo("Parsing file...");

    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        if (results.errors && results.errors.length > 0) {
          console.error(results.errors);
          setError("Error parsing CSV. Please check the file format.");
          setInfo("");
          return;
        }

        const rows = results.data;

        if (!rows || rows.length === 0) {
          setError("No data found in file.");
          setInfo("");
          return;
        }

        // Basic header check
        const first = rows[0];
        const required = ["Date", "Description", "Amount", "Type", "Category", "Person"];
        const missing = required.filter((key) => !(key in first));

        if (missing.length > 0) {
          setError(
            `Missing columns: ${missing.join(
              ", "
            )}. Expected header is:\n${SAMPLE_HEADER}`
          );
          setInfo("");
          return;
        }

        const cleaned = rows
          .map((row, index) => {
            const amount = parseFloat(row.Amount);
            if (Number.isNaN(amount)) return null;

            const type =
              row.Type && row.Type.toLowerCase().startsWith("inc")
                ? "income"
                : "expense";

            const person = (row.Person || "joint").toLowerCase();
            const normalizedPerson =
              person === "you" || person === "wife" ? person : "joint";

            return {
              id: Date.now() + index,
              date: row.Date,
              description: row.Description || "",
              category: row.Category || "Other",
              amount,
              type,
              person: normalizedPerson,
            };
          })
          .filter(Boolean);

        if (cleaned.length === 0) {
          setError("No valid rows found in file.");
          setInfo("");
          return;
        }

        setParsedRows(cleaned);
        setInfo(`Parsed ${cleaned.length} transaction(s). Review and click Import.`);
      },
      error: (err) => {
        console.error(err);
        setError("Failed to read file. Please try again.");
        setInfo("");
      },
    });
  };

  const handleImport = () => {
    if (!parsedRows.length) return;
    onImport(parsedRows);
    setParsedRows([]);
    setInfo("Transactions imported successfully.");
  };

  return (
    <div className="mb-6 border border-dashed border-gray-300 rounded-lg p-4 bg-white/60">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h3 className="font-semibold text-gray-800 mb-1">
            Import Transactions from CSV
          </h3>
          <p className="text-xs text-gray-500">
            Expected header: <code>{SAMPLE_HEADER}</code>
          </p>
        </div>
        <input
          type="file"
          accept=".csv,text/csv"
          onChange={handleFileChange}
          className="text-sm"
        />
      </div>

      {error && (
        <p className="mt-2 text-xs text-red-600 whitespace-pre-line">{error}</p>
      )}
      {info && !error && (
        <p className="mt-2 text-xs text-emerald-700 whitespace-pre-line">
          {info}
        </p>
      )}

      {parsedRows.length > 0 && (
        <div className="mt-4">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm text-gray-700">
              Previewing first {Math.min(parsedRows.length, 5)} of{" "}
              {parsedRows.length} transaction(s):
            </p>
            <button
              onClick={handleImport}
              className="bg-indigo-600 text-white text-sm px-3 py-1.5 rounded-md hover:bg-indigo-700"
            >
              Import {parsedRows.length} Transaction
              {parsedRows.length > 1 ? "s" : ""}
            </button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-gray-100">
                <tr>
                  <th className="px-2 py-1 text-left">Date</th>
                  <th className="px-2 py-1 text-left">Description</th>
                  <th className="px-2 py-1 text-left">Category</th>
                  <th className="px-2 py-1 text-left">Person</th>
                  <th className="px-2 py-1 text-right">Amount</th>
                  <th className="px-2 py-1 text-left">Type</th>
                </tr>
              </thead>
              <tbody>
                {parsedRows.slice(0, 5).map((t) => (
                  <tr key={t.id} className="border-b">
                    <td className="px-2 py-1">{t.date}</td>
                    <td className="px-2 py-1">{t.description}</td>
                    <td className="px-2 py-1">{t.category}</td>
                    <td className="px-2 py-1 capitalize">{t.person}</td>
                    <td className="px-2 py-1 text-right">
                      ${t.amount.toFixed(2)}
                    </td>
                    <td className="px-2 py-1 capitalize">{t.type}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

export default TransactionCsvImport;
