import { useState } from "react";
import { RadioGroup } from "@meowerse/ui";

export default function Demo() {
  const [v, setV] = useState("system");
  return (
    <div className="demo">
      <RadioGroup name="demo-theme" legend="theme" value={v} onChange={setV} options={[
        { label: "follow the system", value: "system" }, { label: "dark", value: "dark" }, { label: "light", value: "light", hint: "day paper" },
      ]} />
      <p role="status" className="demo__out">chosen: {v}</p>
    </div>
  );
}
