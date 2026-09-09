import { notFound } from "next/navigation";
import { z } from "zod";
import { locationQueries } from "@/lib/admin";
import { LocationForm } from "@/components/admin/location-form";

export const metadata = { title: "Edit storage location" };
export default async function EditLocation({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  if (!z.uuid().safeParse(id).success) notFound();
  const location = await locationQueries.detail(id);
  if (!location) notFound();
  const tree = await locationQueries.tree();
  const parents = tree.filter(
    (row) => row.id !== id && !row.ancestors.includes(id),
  );
  return (
    <>
      <div className="page-heading">
        <div>
          <p className="eyebrow">INVENTORY / STORAGE</p>
          <h1>Edit {location.code}</h1>
          <p className="muted">
            Moving a shelf or box changes its physical path without changing
            stock quantities.
          </p>
        </div>
      </div>
      <LocationForm
        location={{ ...location, updatedAt: location.updatedAt.toISOString() }}
        parents={parents.map(({ id, path, effectiveActive }) => ({
          id,
          path,
          effectiveActive,
        }))}
      />
    </>
  );
}
