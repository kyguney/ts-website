import ComingSoon from "@/components/coming-soon";
import { LandingPage } from "@/components/landing/landing-page";
import { auth } from "@/auth";

const isMaintenance = () => process.env.NEXT_PUBLIC_MAINTENANCE_MODE === "true";

export default async function Home() {
  // Maintenance / pre-launch: show the Coming Soon page to everyone.
  if (isMaintenance()) {
    return <ComingSoon />;
  }

  // Live: show the marketing/demo landing page.
  const session = await auth();
  return <LandingPage isAuthed={!!session?.user} />;
}
