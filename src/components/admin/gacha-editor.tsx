"use client";
import { useActionState, useState } from "react";
import { saveGacha, findPrizeItems } from "@/app/admin/gacha/actions";
import { probability } from "@/modules/gacha/probability";
import { moneyInputValue, parseMoneyInput } from "@/modules/shared/money";

type Prize = {
  merchandiseItemId: string;
  displayName: string;
  description: string;
  tier: string;
  weight: number;
  allocation: number;
};
export type GachaEditorValue = {
  id?: string;
  expectedConfigurationId: string | null;
  name: string;
  slug: string;
  description: string;
  startsAt: string | null;
  endsAt: string | null;
  active: boolean;
  currency: string;
  pullPriceAmount: number | null;
  terms: string;
  termsVersion: string;
  prizes: Prize[];
};
export function GachaEditor({ initial }: { initial?: GachaEditorValue }) {
  const [state, submit, pending] = useActionState(saveGacha, {});
  const [prizes, setPrizes] = useState<Prize[]>(initial?.prizes ?? []);
  const [results, setResults] = useState<
    Awaited<ReturnType<typeof findPrizeItems>>
  >([]);
  const [query, setQuery] = useState(""),
    [error, setError] = useState(""),
    [searching, setSearching] = useState(false);
  const [currency, setCurrency] = useState(initial?.currency ?? "EUR");
  const total = prizes.reduce((n, p) => n + p.weight, 0);
  function update(index: number, values: Partial<Prize>) {
    setPrizes(prizes.map((p, i) => (i === index ? { ...p, ...values } : p)));
  }
  return (
    <form
      action={(form) => {
        setError("");
        try {
          const price = String(form.get("price") ?? "");
          const date = (key: string) =>
            form.get(key) ? new Date(`${form.get(key)}Z`).toISOString() : null;
          const configuration = {
            id: initial?.id,
            expectedConfigurationId: initial?.expectedConfigurationId ?? null,
            name: form.get("name"),
            slug: form.get("slug"),
            description: form.get("description"),
            startsAt: date("startsAt"),
            endsAt: date("endsAt"),
            active: form.get("active") === "on",
            paidEnabled: false,
            currency,
            pullPriceAmount: price ? parseMoneyInput(price, currency) : null,
            terms: form.get("terms"),
            termsVersion: form.get("termsVersion"),
            prizes,
          };
          form.set("configuration", JSON.stringify(configuration));
          submit(form);
        } catch (e) {
          setError(e instanceof Error ? e.message : "Check your input.");
        }
      }}
    >
      {(error || state.error) && (
        <p role="alert" className="form-error">
          {error || state.error}
        </p>
      )}
      <section className="panel form-section">
        <h2>Banner and terms</h2>
        <p>
          Paid draws are disabled. This interface supports administrator-granted
          draws with no charge.
        </p>
        <div className="field-grid">
          <label className="field">
            <span>Name</span>
            <input
              name="name"
              defaultValue={initial?.name}
              required
              maxLength={200}
            />
          </label>
          <label className="field">
            <span>Slug</span>
            <input
              name="slug"
              defaultValue={initial?.slug}
              required
              maxLength={180}
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
            />
          </label>
          <label className="field">
            <span>Starts at (UTC, optional)</span>
            <input
              type="datetime-local"
              name="startsAt"
              defaultValue={initial?.startsAt?.slice(0, 16)}
            />
          </label>
          <label className="field">
            <span>Ends at (UTC, optional)</span>
            <input
              type="datetime-local"
              name="endsAt"
              defaultValue={initial?.endsAt?.slice(0, 16)}
            />
          </label>
          <label className="field">
            <span>Currency for future price metadata</span>
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
            >
              {["EUR", "JPY", "USD", "GBP"].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Future pull price (optional; no payment enabled)</span>
            <input
              name="price"
              inputMode="decimal"
              defaultValue={
                initial?.pullPriceAmount == null
                  ? ""
                  : moneyInputValue(initial.pullPriceAmount, initial.currency)
              }
            />
          </label>
          <label className="field">
            <span>Terms version</span>
            <input
              name="termsVersion"
              defaultValue={initial?.termsVersion ?? "1"}
              required
              maxLength={100}
            />
          </label>
        </div>
        <label className="field">
          <span>Public description</span>
          <textarea
            name="description"
            defaultValue={initial?.description}
            maxLength={10000}
          />
        </label>
        <label className="field">
          <span>Public terms</span>
          <textarea
            name="terms"
            defaultValue={initial?.terms}
            required
            maxLength={20000}
          />
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            name="active"
            defaultChecked={initial?.active}
          />{" "}
          Activate administrator grants within the configured dates
        </label>
      </section>
      <section className="panel form-section">
        <h2>Physical prize pool</h2>
        <p>
          Saving reserves every allocated unit from eligible France fulfillment
          locations, including when paused. Maximum 100 prizes and 2,000 units.
          Existing awarded units remain reserved separately.
        </p>
        <div className="field-grid">
          <label className="field">
            <span>Find catalog merchandise</span>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              maxLength={100}
            />
          </label>
          <button
            className="button"
            type="button"
            disabled={searching}
            onClick={async () => {
              setSearching(true);
              setError("");
              try {
                setResults(await findPrizeItems(query));
              } catch {
                setError("Catalog search failed. Check your session.");
              } finally {
                setSearching(false);
              }
            }}
          >
            {searching ? "Searching…" : "Search catalog"}
          </button>
        </div>
        {results.length > 0 && (
          <ul>
            {results.map((item) => (
              <li key={item.id}>
                {item.internalSku} · {item.name}{" "}
                <button
                  className="button small"
                  type="button"
                  disabled={
                    prizes.length >= 100 ||
                    prizes.some((p) => p.merchandiseItemId === item.id)
                  }
                  onClick={() =>
                    setPrizes([
                      ...prizes,
                      {
                        merchandiseItemId: item.id,
                        displayName: item.name,
                        description: "",
                        tier: "Standard",
                        weight: 1,
                        allocation: 1,
                      },
                    ])
                  }
                >
                  Add prize
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Public display</th>
                <th>Tier</th>
                <th>Weight</th>
                <th>Allocated units</th>
                <th>Configured odds</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {prizes.map((p, index) => {
                const odds =
                  Number.isSafeInteger(p.weight) &&
                  p.weight > 0 &&
                  Number.isSafeInteger(total) &&
                  total > 0
                    ? probability(p.weight, total)
                    : null;
                return (
                  <tr key={p.merchandiseItemId}>
                    <td>
                      <label className="field">
                        <span>Name</span>
                        <input
                          required
                          maxLength={200}
                          value={p.displayName}
                          onChange={(e) =>
                            update(index, { displayName: e.target.value })
                          }
                        />
                      </label>
                      <label className="field">
                        <span>Description</span>
                        <textarea
                          maxLength={2000}
                          value={p.description}
                          onChange={(e) =>
                            update(index, { description: e.target.value })
                          }
                        />
                      </label>
                    </td>
                    <td>
                      <input
                        aria-label={`Tier for ${p.displayName}`}
                        required
                        maxLength={100}
                        value={p.tier}
                        onChange={(e) =>
                          update(index, { tier: e.target.value })
                        }
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Weight for ${p.displayName}`}
                        type="number"
                        required
                        min={1}
                        max={1000000}
                        value={p.weight}
                        onChange={(e) =>
                          update(index, { weight: Number(e.target.value) })
                        }
                      />
                    </td>
                    <td>
                      <input
                        aria-label={`Allocation for ${p.displayName}`}
                        type="number"
                        required
                        min={1}
                        max={2000}
                        value={p.allocation}
                        onChange={(e) =>
                          update(index, { allocation: Number(e.target.value) })
                        }
                      />
                    </td>
                    <td>
                      {odds
                        ? `${odds.numerator}/${odds.denominator} (${odds.percentage}%${odds.percentageExact ? "" : " rounded"})`
                        : "Invalid weight"}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="button small"
                        onClick={() =>
                          setPrizes(prizes.filter((_, i) => i !== index))
                        }
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p>
          {prizes.reduce((n, p) => n + p.allocation, 0)} units allocated. Odds
          stay fixed for this version. If any prize is depleted, all draws stop;
          odds are never redistributed.
        </p>
        <label className="checkbox-label">
          <input name="confirm" type="checkbox" required /> I reviewed the
          public fields and exact odds, and approve reserving this physical
          stock.
        </label>
        <div className="form-actions">
          <button
            className="button primary"
            disabled={pending || !prizes.length}
          >
            {pending
              ? "Saving…"
              : initial
                ? "Save new configuration version"
                : "Create banner and reserve pool"}
          </button>
        </div>
      </section>
    </form>
  );
}
