import { locationQueries } from "@/lib/admin";
import { LocationForm } from "@/components/admin/location-form";

export const metadata = { title: "Create storage location" };
export default async function NewLocation() {
  const parents = await locationQueries.tree();
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">INVENTORY / STORAGE</p>
          <h1>Create storage location</h1>
          <p className="muted">
            Give every warehouse, shelf and box a stable, unique code.
          </p>
        </div>
      </div>
      <LocationForm
        parents={parents.map(({ id, path, effectiveActive }) => ({
          id,
          path,
          effectiveActive,
        }))}
      />
    </>
  );
}
