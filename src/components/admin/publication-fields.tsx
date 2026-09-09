"use client";
import type { BulkReview } from "@/modules/bulk-management/service";
import { storefrontCurrencies } from "@/modules/publication/validation";
import { MediaImage } from "@/components/ui/media-image";
type Item = BulkReview["items"][number];
export function PublicationFields({
  item,
  categories,
  values,
  disabled,
  onChange,
}: {
  item: Item;
  categories: BulkReview["publicCategories"];
  values: Record<string, unknown>;
  disabled: boolean;
  onChange: (key: string, value: unknown) => void;
}) {
  const data = item.publication;
  const imageIds = Array.isArray(values.imageIds)
    ? (values.imageIds as string[])
    : [];
  const field = (
    key: string,
    label: string,
    options: {
      required?: boolean;
      max?: number;
      multiline?: boolean;
      readOnly?: boolean;
    } = {},
  ) => (
    <label className="field">
      <span>{label}</span>
      {options.multiline ? (
        <textarea
          aria-label={`${item.name} ${label}`}
          disabled={disabled}
          value={String(values[key] ?? "")}
          maxLength={options.max ?? 20000}
          onChange={(e) => onChange(key, e.target.value)}
        />
      ) : (
        <input
          aria-label={`${item.name} ${label}`}
          disabled={disabled}
          readOnly={options.readOnly}
          required={options.required && !disabled}
          maxLength={options.max ?? 500}
          value={String(values[key] ?? "")}
          onChange={(e) => onChange(key, e.target.value)}
        />
      )}
    </label>
  );
  function move(id: string, delta: number) {
    const order = [...imageIds],
      index = order.indexOf(id);
    if (index < 0 || index + delta < 0 || index + delta >= order.length) return;
    [order[index], order[index + delta]] = [order[index + delta], order[index]];
    onChange("imageIds", order);
  }
  const images = [...(data?.images ?? [])].sort(
    (a, b) =>
      (imageIds.includes(a.id) ? imageIds.indexOf(a.id) : 1000) -
      (imageIds.includes(b.id) ? imageIds.indexOf(b.id) : 1000),
  );
  return (
    <div className="publication-fields">
      <div className="field-grid">
        {field("publicTitle", "Public title", { required: true })}
        {field("slug", "URL slug", {
          required: true,
          max: 200,
          readOnly: Boolean(data?.listing?.publishedAt),
        })}
        {data?.listing?.publishedAt && (
          <p className="muted small-copy">
            This previously published slug is fixed.
          </p>
        )}
        {field("sellingPrice", "Selling price", { required: true, max: 30 })}
        <label className="field">
          <span>Currency</span>
          <select
            aria-label={`${item.name} Currency`}
            disabled={disabled}
            value={String(values.sellingCurrency)}
            onChange={(e) => onChange("sellingCurrency", e.target.value)}
          >
            {storefrontCurrencies.map((currency) => (
              <option key={currency}>{currency}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Price tax basis</span>
          <select
            aria-label={`${item.name} Price tax basis`}
            disabled={disabled}
            value={String(values.sellingPriceTaxInclusion ?? "UNKNOWN")}
            onChange={(e) =>
              onChange("sellingPriceTaxInclusion", e.target.value)
            }
          >
            <option value="UNKNOWN">Unknown — margin unavailable</option>
            <option value="EXCLUDED">Net price excluding sales tax</option>
            <option value="INCLUDED">
              Tax included — net conversion unavailable
            </option>
          </select>
        </label>
        <label className="field">
          <span>Public category override</span>
          <select
            aria-label={`${item.name} Public category override`}
            disabled={disabled}
            value={String(values.publicCategoryId ?? "")}
            onChange={(e) =>
              onChange("publicCategoryId", e.target.value || null)
            }
          >
            <option value="">
              Category default:{" "}
              {categories.find(
                (category) => category.id === data?.defaultCategoryId,
              )?.name ?? "Unmapped — choose an override"}
            </option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Publication state</span>
          <select
            aria-label={`${item.name} Publication state`}
            disabled={disabled}
            value={values.published === false ? "draft" : "published"}
            onChange={(e) =>
              onChange("published", e.target.value === "published")
            }
          >
            <option value="published">Published</option>
            <option value="draft">Draft / unpublished</option>
          </select>
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            aria-label={`${item.name} Featured`}
            disabled={disabled}
            checked={values.featured === true}
            onChange={(e) => onChange("featured", e.target.checked)}
          />
          Featured
        </label>
      </div>
      <details>
        <summary>Description, subtitle and SEO</summary>
        <div className="field-grid">
          {field("publicSubtitle", "Public subtitle")}
          {field("publicDescription", "Public description", {
            multiline: true,
          })}
          {field("seoTitle", "SEO title", { max: 200 })}
          {field("seoDescription", "SEO description", {
            max: 500,
            multiline: true,
          })}
        </div>
      </details>
      <details open>
        <summary>
          Public images · {imageIds.length} selected (maximum 20)
        </summary>
        <p className="muted small-copy">
          Selection preserves existing approval. Use the arrows to set public
          order.
        </p>
        {images.map((image) => (
          <div className="publication-image" key={image.id}>
            <label className="checkbox-label">
              <input
                aria-label={`${item.name} image ${image.id}`}
                type="checkbox"
                disabled={
                  disabled ||
                  ((!image.approved || !image.deliverable) &&
                    !imageIds.includes(image.id)) ||
                  (!imageIds.includes(image.id) && imageIds.length >= 20)
                }
                checked={imageIds.includes(image.id)}
                onChange={(e) =>
                  onChange(
                    "imageIds",
                    e.target.checked
                      ? [...imageIds, image.id]
                      : imageIds.filter((id) => id !== image.id),
                  )
                }
              />
              <MediaImage
                reference={
                  image.approved && image.deliverable ? image.storageKey : null
                }
                alt={image.caption || item.name}
              />
              <span>
                {image.caption || "Product image"}
                {!image.approved
                  ? " · Approval required"
                  : !image.deliverable
                    ? " · Managed file unavailable"
                    : ""}
              </span>
            </label>
            {imageIds.includes(image.id) && (
              <span>
                <button
                  type="button"
                  className="button small"
                  aria-label={`Move image ${image.id} earlier`}
                  disabled={disabled || imageIds.indexOf(image.id) === 0}
                  onClick={() => move(image.id, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="button small"
                  aria-label={`Move image ${image.id} later`}
                  disabled={
                    disabled ||
                    imageIds.indexOf(image.id) === imageIds.length - 1
                  }
                  onClick={() => move(image.id, 1)}
                >
                  ↓
                </button>
              </span>
            )}
          </div>
        ))}
        {!images.length && (
          <p className="field-error">
            No images recorded. Add an approved managed image before publishing.
          </p>
        )}
      </details>
    </div>
  );
}
