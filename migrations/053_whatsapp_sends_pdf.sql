-- Whether the grahak's khata PDF went with the udhaar (udhaar_khata_pdf_v1) or only the text.
ALTER TABLE whatsapp_sends ADD COLUMN with_pdf boolean NOT NULL DEFAULT false;
