-- CreateTable
CREATE TABLE "IssuerProfile" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "data" JSONB NOT NULL,
    "accentColor" TEXT,
    "logo" BYTEA,
    "logoMime" TEXT,
    "logoSha256" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "IssuerProfile_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "IssuerProfile_singleton" CHECK ("id" = 'singleton')
);
