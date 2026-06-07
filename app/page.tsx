import { Suspense } from "react";
import { AppShell } from "@/components/AppShell";
import { ActivityPanelWrapper } from "@/components/ActivityPanelWrapper";

export default function Home() {
  return (
    <Suspense>
      <AppShell rightPanel={<ActivityPanelWrapper />} />
    </Suspense>
  );
}
