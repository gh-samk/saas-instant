-- SHA-256 des verschlüsselten Uploads-Archivs einer Instanzsicherung. Rein
-- additiv; Altzeilen behalten NULL (der Agent spielt dann keine Uploads ein).
ALTER TABLE "Backup" ADD COLUMN "uploadsSha256" TEXT;
