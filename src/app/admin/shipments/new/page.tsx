import { randomUUID } from "node:crypto";
import { locationQueries } from "@/lib/admin";
import { ShipmentForm } from "@/components/admin/shipment-form";
export const metadata = { title: "Create shipment" };
export default async function NewShipment({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const locations = await locationQueries.tree(),
    params = await searchParams;
  const origins = locations.filter(
    (row) =>
      row.effectiveActive && row.effectiveCountry === "JP" && !row.inTransit,
  );
  const origin =
    origins.find((row) => row.id === params.origin)?.id || origins[0]?.id || "";
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">JAPAN → FRANCE</p>
          <h1>Create shipment</h1>
        </div>
      </div>
      <ShipmentForm
        locations={locations}
        initial={{
          id: randomUUID(),
          originLocationId: origin,
          destinationLocationId:
            locations.find(
              (row) =>
                row.effectiveActive &&
                row.effectiveCountry === "FR" &&
                !row.inTransit,
            )?.id || "",
          transitParentId:
            locations.find(
              (row) => row.effectiveActive && row.inTransit && !row.parentId,
            )?.id || "",
          fields: {},
          items: [],
        }}
      />
    </>
  );
}
