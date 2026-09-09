import { requireInternalUser } from "@/lib/authorization";
import { GachaEditor } from "@/components/admin/gacha-editor";
export const metadata = { title: "Create gacha banner" };
export default async function NewGacha() {
  await requireInternalUser();
  return (
    <>
      <div className="page-heading">
        <h1>Create gacha banner</h1>
      </div>
      <GachaEditor />
    </>
  );
}
