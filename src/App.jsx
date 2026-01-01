import FinanceTracker from "./FinanceTracker";
import AcceptInvite from "./AcceptInvite";

function isInviteOrRecoveryUrl() {
  const href = window.location.href;
  return (
    href.includes("type=invite") ||
    href.includes("type=recovery") ||
    href.includes("access_token=") ||
    href.includes("refresh_token=")
  );
}

function App() {
  const pathInvite = window.location.pathname === "/accept-invite";
  const tokenInvite = isInviteOrRecoveryUrl();

  if (pathInvite || tokenInvite) {
    return <AcceptInvite />;
  }

  return <FinanceTracker />;
}

export default App;
