import { Button, ToastProvider, useToast } from "@meowerse/ui";

function Buttons() {
  const push = useToast();
  return (
    <div className="btn-row">
      <Button onClick={() => push({ message: "message sent", variant: "success", duration: 6000 })}>success</Button>
      <Button onClick={() => push({ message: "couldn't send — it will retry when you're back online", variant: "error", duration: 6000 })}>error</Button>
      <Button onClick={() => push({ message: "3 new messages", duration: 6000 })}>info</Button>
    </div>
  );
}

export default function Demo() {
  return <ToastProvider><Buttons /></ToastProvider>;
}
