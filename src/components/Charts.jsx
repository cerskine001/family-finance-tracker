import React from "react";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  ArcElement,
  LineElement,
  PointElement,
  Tooltip,
  Legend,
} from "chart.js";

import { Bar, Doughnut, Line } from "react-chartjs-2";

// Register global chart settings
ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  ArcElement,
  LineElement,
  PointElement,
  Tooltip,
  Legend
);

// ----------------------------------------------------------
// Helper for card wrapper
// ----------------------------------------------------------
const ChartCard = ({ title, children }) => (
  <div className="bg-white rounded-lg shadow p-6">
    <h3 className="text-lg font-semibold mb-4">{title}</h3>
    {children}
  </div>
);

// ----------------------------------------------------------
// NET WORTH LINE CHART
// ----------------------------------------------------------
export const NetWorthChart = ({ history }) => {
  const labels = history.map((h) =>
    new Date(h.date).toLocaleDateString("en-US", { month: "short", day: "numeric" })
  );

  const data = {
    labels,
    datasets: [
      {
        label: "Net Worth",
        data: history.map((h) => h.netWorth),
        borderColor: "#4f46e5",
        backgroundColor: "rgba(79, 70, 229, 0.3)",
        tension: 0.4,
        fill: true,
      },
    ],
  };

  return (
    <ChartCard title="Net Worth Trend">
      <Line data={data} />
    </ChartCard>
  );
};

// ----------------------------------------------------------
// INCOME VS EXPENSES BAR CHART
// ----------------------------------------------------------
export const IncomeExpensesChart = ({ income, expenses }) => {
  const labels = ["Income", "Expenses"];

  const data = {
    labels,
    datasets: [
      {
        label: "Amount",
        data: [income, expenses],
        backgroundColor: ["rgba(34,197,94,0.6)", "rgba(239,68,68,0.6)"],
        borderColor: ["#22c55e", "#ef4444"],
        borderWidth: 2,
      },
    ],
  };

  return (
    <ChartCard title="Income vs Expenses">
      <Bar data={data} />
    </ChartCard>
  );
};

// ----------------------------------------------------------
// CATEGORY DONUT CHART
// ----------------------------------------------------------
export const CategoryDonutChart = ({ categoryTotals }) => {
  const labels = Object.keys(categoryTotals);
  const dataValues = Object.values(categoryTotals);

  const colors = [
    "#4f46e5", "#22c55e", "#ef4444", "#0ea5e9",
    "#f59e0b", "#6366f1", "#14b8a6", "#a855f7",
  ];

  const data = {
    labels,
    datasets: [
      {
        data: dataValues,
        backgroundColor: colors.slice(0, labels.length),
      },
    ],
  };

  return (
    <ChartCard title="Spending by Category">
      <Doughnut data={data} />
    </ChartCard>
  );
};

// ----------------------------------------------------------
// MONTHLY SPENDING TREND
// ----------------------------------------------------------
export const MonthlySpendingChart = ({ monthlyTotals }) => {
  const labels = Object.keys(monthlyTotals);
  const dataValues = Object.values(monthlyTotals);

  const data = {
    labels,
    datasets: [
      {
        label: "Monthly Spending",
        data: dataValues,
        borderColor: "#ef4444",
        backgroundColor: "rgba(239,68,68,0.2)",
        tension: 0.4,
        fill: true,
      },
    ],
  };

  return (
    <ChartCard title="Monthly Spending Trend">
      <Line data={data} />
    </ChartCard>
  );
};

// ----------------------------------------------------------
// ASSETS VS LIABILITIES BAR CHART
// ----------------------------------------------------------
export const AssetsLiabilitiesChart = ({ assets, liabilities }) => {
  const data = {
    labels: ["Assets", "Liabilities"],
    datasets: [
      {
        label: "Total",
        data: [assets, liabilities],
        backgroundColor: ["#22c55e", "#ef4444"],
        borderColor: ["#16a34a", "#dc2626"],
        borderWidth: 2,
      },
    ],
  };

  return (
    <ChartCard title="Assets vs Liabilities">
      <Bar data={data} />
    </ChartCard>
  );
};
