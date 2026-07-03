import { AuthGate, ToastProvider } from "@meowerse/ui";
import AccountSettings from "./AccountSettings";

export default function AccountPage({ base }: { base: string }) {
  return (
    <ToastProvider>
      <AuthGate base={base}>
        <AccountSettings base={base} />
      </AuthGate>
    </ToastProvider>
  );
}
