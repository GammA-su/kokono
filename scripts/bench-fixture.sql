-- Disposable local benchmark fixture. Mirrors audit-scale.ts shape at 50k items.
-- Never run against development or production data; target schema is bench_scale in *_test only.
SET search_path TO bench_scale;
INSERT INTO franchises(id,name,slug,updated_at) VALUES ('11111111-1111-1111-1111-111111111111','Bench franchise','bench',now());
INSERT INTO categories(id,name,slug,public_category_id)
  SELECT '22222222-2222-2222-2222-222222222222','Bench category','bench',id FROM public_categories WHERE slug='goods';
INSERT INTO storage_locations(id,code,name,type,country_code,fulfillment_enabled,active,updated_at) VALUES
  ('33333333-3333-3333-3333-333333333331','bench-jp','bench-jp','JAPAN_WAREHOUSE','JP',false,true,now()),
  ('33333333-3333-3333-3333-333333333332','bench-fr','bench-fr','FRANCE_HOME','FR',true,true,now()),
  ('33333333-3333-3333-3333-333333333333','bench-tr','bench-tr','IN_TRANSIT',NULL,false,true,now());
INSERT INTO lineups(id,franchise_id,name,slug,release_date,release_date_precision,updated_at)
  SELECT gen_random_uuid(),'11111111-1111-1111-1111-111111111111','Bench release '||n,'bench-'||n,DATE '2026-11-01','MONTH',now() FROM generate_series(1,5000) n;
INSERT INTO merchandise_items(id,lineup_id,category_id,name,japanese_name,internal_sku,slug,updated_at)
  SELECT gen_random_uuid(),l.id,'22222222-2222-2222-2222-222222222222','Bench item '||n,'レム Ｍａｒｉｎｅ '||n,'bench-'||n,'bench-'||n,now()
  FROM generate_series(1,50000) n JOIN lineups l ON l.slug='bench-'||((n-1)%5000+1);
INSERT INTO inventory_balances(merchandise_item_id,storage_location_id,quantity,updated_at)
  SELECT id,'33333333-3333-3333-3333-333333333331',6,now() FROM merchandise_items;
INSERT INTO inventory_balances(merchandise_item_id,storage_location_id,quantity,updated_at)
  SELECT id,'33333333-3333-3333-3333-333333333332',3,now() FROM merchandise_items;
INSERT INTO inventory_balances(merchandise_item_id,storage_location_id,quantity,updated_at)
  SELECT id,'33333333-3333-3333-3333-333333333333',1,now() FROM merchandise_items;
-- Managed storage keys must match the application's admin-media UUID pattern.
INSERT INTO item_images(id,merchandise_item_id,storage_key,approved_for_public_use)
  SELECT gen_random_uuid(),id,'admin-media/'||gen_random_uuid()||'.png',true FROM merchandise_items;
INSERT INTO sale_listings(id,merchandise_item_id,slug,selling_price_amount,selling_price_currency,selling_price_tax_inclusion,published,published_at,updated_at)
  SELECT gen_random_uuid(),id,slug,1500,'EUR','INCLUDED',true,now(),now() FROM merchandise_items;
INSERT INTO sale_listing_images(listing_id,item_image_id,display_order)
  SELECT s.id,im.id,0 FROM sale_listings s JOIN item_images im ON im.merchandise_item_id=s.merchandise_item_id;
ANALYZE;
