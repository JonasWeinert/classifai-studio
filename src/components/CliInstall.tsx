// Install the `classifai` command line tool: a link in /usr/local/bin to the copy inside the app.
import { Check, Terminal } from "lucide-react";
import { useEffect, useState } from "react";
import { api, errorMessage } from "../lib/api";
import type { CliStatus } from "../lib/types";
import { Button } from "./ui";

export function CliInstall({ compact }: { compact?: boolean }) {
  const [s, setS] = useState<CliStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.cliStatus().then(setS).catch(() => setS(null));
  }, []);

  const act = async (f: () => Promise<CliStatus>) => {
    setBusy(true);
    setError(null);
    try {
      setS(await f());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (!s) return null;
  const state = s.state;
  return (
    <div className="text-[12.5px]">
      <div className="flex flex-wrap items-center gap-2">
        {state === "installed" ? (
          <>
            <span className="inline-flex items-center gap-1.5 text-good">
              <Check className="size-3.5" strokeWidth={3} /> Installed
            </span>
            <code className="rounded-[5px] bg-sel px-1.5 py-0.5 font-mono text-[11.5px]">classifai</code>
            {!compact && (
              <Button size="sm" variant="ghost" loading={busy} onClick={() => act(api.cliUninstall)}>
                Remove
              </Button>
            )}
          </>
        ) : state === "unavailable" ? (
          <span className="text-muted-foreground">Not included in this build. In development, run <code className="font-mono">cargo build -p classifai-cli</code>.</span>
        ) : (
          <Button size="sm" icon={<Terminal className="size-3.5" />} loading={busy} onClick={() => act(() => api.cliInstall(state === "other"))}>
            {state === "broken" ? "Repair command line tool" : state === "other" ? "Replace with this app's version" : "Install command line tool"}
          </Button>
        )}
      </div>
      <div className="mt-1.5 text-[11.5px] leading-snug text-faint">
        {state === "installed"
          ? `Run classifai in any terminal. It uses the same data as the app.${s.on_path ? "" : " Add /usr/local/bin to your PATH to use it."}`
          : state === "broken"
            ? `${s.target} points to an app that was moved or deleted.`
            : state === "other"
              ? `${s.target} is a different program${s.points_to ? ` (${s.points_to})` : ""}.`
              : state === "unavailable"
                ? null
                : `Adds the classifai command to ${s.target} so it works in any terminal. macOS may ask for your password.`}
      </div>
      {error && <div className="mt-1.5 text-[11.5px] text-bad">{error}</div>}
    </div>
  );
}
