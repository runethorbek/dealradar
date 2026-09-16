BEGIN;

ALTER TABLE product_evaluations
ADD COLUMN translated_listing_text_da TEXT;

COMMIT;
