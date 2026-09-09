import { notFound } from "next/navigation";
import { requireUser } from "@/server/auth";
import { isFeatureEnabledForUser, ZONE_MODEL_FLAG_KEY } from "@/server/data/feature-flags";
import { computeZoneModel } from "@/server/data/zone-model";
import { MLB_SPORT_KEY } from "@/server/data/chart-team-name";
import { ZoneModelView } from "@/components/zone-model/zone-model-view";

// Gated server-side on the zone_model feature flag, independent of whether
// this route is linked in navigation anywhere (AppSidebar only shows the
// nav entry when this same check passes, but that's a UX convenience, not
// the access control - a direct request to /zone-model without the flag
// still 404s here). notFound() rather than a "forbidden" message, so an
// unauthorized user sees the same response as a route that doesn't exist.
export default async function ZoneModelPage() {
  const user = await requireUser();
  const enabled = await isFeatureEnabledForUser(ZONE_MODEL_FLAG_KEY, user.id);
  if (!enabled) notFound();

  const report = await computeZoneModel(MLB_SPORT_KEY);
  return <ZoneModelView report={report} />;
}
