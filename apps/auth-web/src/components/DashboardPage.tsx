import { ToastProvider } from "@meowerse/ui";
import Dashboard from "./Dashboard";

export default function DashboardPage({ base }: { base: string }) {
  return <ToastProvider><Dashboard base={base} /></ToastProvider>;
}
