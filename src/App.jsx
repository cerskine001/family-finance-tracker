import FinanceTracker from "./FinanceTracker";
import AcceptInvite from "./AcceptInvite";

function App() {
  // Simple path-based routing (no react-router)
  if (window.location.pathname === "/accept-invite") {
    return <AcceptInvite />;
  }

  return <FinanceTracker />;
}

export default App;
