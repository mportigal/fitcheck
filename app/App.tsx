import { ChatPanel } from "./components/ChatPanel";
import { ProfilePanel } from "./components/ProfilePanel";

export function App() {
  return (
    <div className="app">
      <header>
        Fit Check
        <span className="sub">resolve fit on foot length, not the label</span>
      </header>
      <div className="columns">
        <ChatPanel />
        <ProfilePanel />
      </div>
    </div>
  );
}
