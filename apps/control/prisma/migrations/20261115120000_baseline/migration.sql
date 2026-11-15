-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('owner', 'administrator', 'staff');

-- CreateEnum
CREATE TYPE "EmergencyKind" AS ENUM ('passkey', 'password');

-- CreateEnum
CREATE TYPE "CompanyStatus" AS ENUM ('inquiry', 'demo', 'pilot_approved', 'pilot_running', 'paying', 'review_pending', 'dormant', 'ended');

-- CreateEnum
CREATE TYPE "PaymentInterval" AS ENUM ('yearly', 'half_yearly', 'monthly');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('direct_debit', 'bank_transfer');

-- CreateEnum
CREATE TYPE "Source" AS ENUM ('form', 'phone', 'referral', 'event');

-- CreateEnum
CREATE TYPE "InstanceStatus" AS ENUM ('provisioning', 'active', 'stopped', 'archived');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('draft', 'finalized', 'sent', 'paid', 'partially_paid', 'overdue', 'cancelled');

-- CreateEnum
CREATE TYPE "BuyerType" AS ENUM ('business', 'authority', 'consumer');

-- CreateEnum
CREATE TYPE "BackupKind" AS ENUM ('instance', 'control', 'invoices');

-- CreateEnum
CREATE TYPE "MailChannel" AS ENUM ('transactional', 'marketing');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('queued', 'sending', 'sent', 'rejected', 'failed');

-- CreateEnum
CREATE TYPE "ConsentStatus" AS ENUM ('unconfirmed', 'confirmed', 'unsubscribed', 'hard_bounced', 'spam_reported');

-- CreateEnum
CREATE TYPE "InquiryKind" AS ENUM ('demo', 'pilot');

-- CreateEnum
CREATE TYPE "InquiryOutcome" AS ENUM ('credentials_sent', 'confirmation_sent', 'already_triggered', 'quota_exhausted', 'send_failed');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'owner',
    "passwordHash" TEXT,
    "totpSecret" TEXT,
    "totpSecretPending" TEXT,
    "totpLastStep" INTEGER,
    "totpPendingValidUntil" TIMESTAMP(3),
    "loginCodeEmail" TEXT,
    "loginCodeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt" TIMESTAMP(3),
    "deactivatedAt" TIMESTAMP(3),
    "sessionGeneration" INTEGER NOT NULL DEFAULT 0,
    "loginFlowGeneration" INTEGER NOT NULL DEFAULT 0,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasskeyCredential" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "counter" INTEGER NOT NULL DEFAULT 0,
    "transports" TEXT,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "PasskeyCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecoveryCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "RecoveryCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailLoginCode" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "targetEmail" TEXT NOT NULL,
    "forSetup" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "consumedAt" TIMESTAMP(3),

    CONSTRAINT "EmailLoginCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validUntil" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmergencyEnrollment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "EmergencyKind" NOT NULL DEFAULT 'passkey',
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "redeemedAt" TIMESTAMP(3),

    CONSTRAINT "EmergencyEnrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legalForm" TEXT,
    "website" TEXT,
    "street" TEXT,
    "houseNumber" TEXT,
    "postalCode" TEXT,
    "city" TEXT,
    "country" TEXT DEFAULT 'Deutschland',
    "billingName" TEXT,
    "billingStreet" TEXT,
    "billingHouseNumber" TEXT,
    "billingPostalCode" TEXT,
    "billingCity" TEXT,
    "billingCountry" TEXT,
    "billingEmail" TEXT,
    "contactName" TEXT,
    "contactEmail" TEXT,
    "contactPhone" TEXT,
    "contactRole" TEXT,
    "deputyName" TEXT,
    "deputyEmail" TEXT,
    "deputyPhone" TEXT,
    "deputyRole" TEXT,
    "status" "CompanyStatus" NOT NULL DEFAULT 'inquiry',
    "lastStatusChangeAt" DATE,
    "priceTier" TEXT,
    "customAmount" DECIMAL(10,2),
    "paymentInterval" "PaymentInterval",
    "paymentMethod" "PaymentMethod",
    "sepaMandateReference" TEXT,
    "sepaMandateDate" DATE,
    "iban" TEXT,
    "bic" TEXT,
    "accountHolder" TEXT,
    "sepaMandateText" TEXT,
    "sepaMandateGrantedAt" TIMESTAMP(3),
    "sepaMandateIp" TEXT,
    "intakeCompletedAt" DATE,
    "intakeLinkSentAt" TIMESTAMP(3),
    "pilotDecisionDate" DATE,
    "reviewDueDate" DATE,
    "reviewDoneAt" DATE,
    "instanceStartDate" DATE,
    "newsletterConsentStatus" "ConsentStatus",
    "source" "Source",
    "notes" TEXT,
    "buyerType" "BuyerType" NOT NULL DEFAULT 'business',
    "vatId" TEXT,
    "buyerReference" TEXT,
    "electronicAddress" TEXT,
    "electronicAddressScheme" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Instance" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "subdomain" TEXT NOT NULL,
    "coolifyApplicationId" TEXT,
    "coolifyDatabaseId" TEXT,
    "metricsTokenEncrypted" TEXT,
    "setupTokenEncrypted" TEXT,
    "status" "InstanceStatus" NOT NULL DEFAULT 'provisioning',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" DATE,
    "appVersion" TEXT,
    "lastMetricsFetchAt" TIMESTAMP(3),
    "setupCompletedAt" DATE,
    "message" TEXT,

    CONSTRAINT "Instance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Backup" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" "BackupKind" NOT NULL DEFAULT 'instance',
    "objectKey" TEXT,
    "sha256" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ok',
    "verifiedAt" TIMESTAMP(3),

    CONSTRAINT "Backup_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstancePreview" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "subdomain" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validUntil" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),

    CONSTRAINT "InstancePreview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationRun" (
    "id" TEXT NOT NULL,
    "executedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "orphanedApplications" JSONB NOT NULL,
    "deviations" JSONB NOT NULL,
    "successful" BOOLEAN NOT NULL DEFAULT true,
    "message" TEXT,

    CONSTRAINT "ReconciliationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Metric" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "activePersons" INTEGER,
    "circles" INTEGER,
    "lastEntryAt" DATE,
    "lastLoginAt" DATE,
    "appVersion" TEXT,
    "fetchSuccessful" BOOLEAN NOT NULL DEFAULT true,
    "errorKind" TEXT,
    "databaseState" TEXT,
    "companyNameMatches" BOOLEAN,

    CONSTRAINT "Metric_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntakeAccess" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "redeemedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "lastSentAt" TIMESTAMP(3),
    "sendCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "IntakeAccess_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Note" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "text" TEXT NOT NULL,
    "bySystem" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sequence" BIGSERIAL NOT NULL,

    CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "invoiceNumber" TEXT,
    "invoiceDate" DATE NOT NULL,
    "servicePeriodFrom" DATE NOT NULL,
    "servicePeriodUntil" DATE NOT NULL,
    "dueDate" DATE NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'draft',
    "paymentDate" DATE,
    "paidAmount" DECIMAL(10,2),
    "finalizedAt" TIMESTAMP(3),
    "cancelledInvoiceId" TEXT,
    "cancellationReason" TEXT,
    "introduction" TEXT,
    "paymentNote" TEXT,
    "internalNote" TEXT,
    "pdfPath" TEXT,
    "xmlPath" TEXT,
    "pdfContent" BYTEA,
    "xmlContent" BYTEA,
    "xrechnungContent" BYTEA,
    "pdfSha256" TEXT,
    "xmlSha256" TEXT,
    "xrechnungSha256" TEXT,
    "documentGeneratedAt" TIMESTAMP(3),
    "retentionUntil" DATE,
    "transferStatus" TEXT,
    "recipientName" TEXT NOT NULL,
    "recipientAddress" TEXT NOT NULL,
    "recipientEmail" TEXT,
    "recipientBuyerType" "BuyerType",
    "recipientVatId" TEXT,
    "recipientBuyerReference" TEXT,
    "recipientElectronicAddress" TEXT,
    "recipientElectronicAddressScheme" TEXT,
    "issuerCompanyName" TEXT NOT NULL,
    "issuerAddress" TEXT NOT NULL,
    "issuerSeat" TEXT,
    "issuerVatId" TEXT,
    "issuerRegisterCourt" TEXT,
    "issuerCommercialRegisterA" TEXT,
    "issuerGeneralPartner" TEXT,
    "issuerGeneralPartnerSeat" TEXT,
    "issuerGeneralPartnerRegisterCourt" TEXT,
    "issuerGeneralPartnerCommercialRegisterB" TEXT,
    "issuerManagingDirector" TEXT,
    "directDebitMandateReference" TEXT,
    "issuerBankDetails" TEXT,
    "issuerContactName" TEXT,
    "issuerContactPhone" TEXT,
    "issuerContactEmail" TEXT,
    "issuerIban" TEXT,
    "issuerBic" TEXT,
    "issuerBankName" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "paymentMeansCode" TEXT NOT NULL DEFAULT '58',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceLine" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "unit" TEXT,
    "description" TEXT,
    "periodFrom" DATE,
    "periodUntil" DATE,
    "quantity" DECIMAL(10,3) NOT NULL,
    "unitPriceNet" DECIMAL(10,2) NOT NULL,
    "taxRate" DECIMAL(5,2) NOT NULL,
    "netAmount" DECIMAL(10,2) NOT NULL,
    "taxAmount" DECIMAL(10,2) NOT NULL,
    "grossAmount" DECIMAL(10,2) NOT NULL,
    "priceTierKey" TEXT,
    "priceTierLabel" TEXT,
    "taxCategory" TEXT NOT NULL DEFAULT 'S',
    "taxExemptionReason" TEXT,

    CONSTRAINT "InvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channel" "MailChannel" NOT NULL,
    "subject" TEXT NOT NULL,
    "contentText" TEXT NOT NULL,
    "contentHtml" TEXT,
    "placeholders" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "eyebrow" TEXT,
    "heading" TEXT,
    "buttonText" TEXT,
    "buttonTarget" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MailTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MailDelivery" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "recipientAddress" TEXT NOT NULL,
    "channel" "MailChannel" NOT NULL,
    "subject" TEXT NOT NULL,
    "contentSnapshot" TEXT NOT NULL,
    "contentSnapshotHtml" TEXT,
    "sentAt" TIMESTAMP(3),
    "deliveryStatus" "DeliveryStatus" NOT NULL DEFAULT 'queued',
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consentId" TEXT,
    "templateId" TEXT,
    "lastErrorClass" TEXT,
    "lastAttemptAt" TIMESTAMP(3),
    "nextAttemptFrom" TIMESTAMP(3),

    CONSTRAINT "MailDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Consent" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "companyId" TEXT,
    "status" "ConsentStatus" NOT NULL DEFAULT 'unconfirmed',
    "subscribedAt" TIMESTAMP(3),
    "ipAtSubscription" TEXT,
    "formText" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "confirmationToken" TEXT,
    "unsubscribedAt" TIMESTAMP(3),
    "unsubscribeToken" TEXT,
    "ipAtConfirmation" TEXT,
    "origin" TEXT,
    "confirmationMailAt" TIMESTAMP(3),
    "confirmationMailCount" INTEGER NOT NULL DEFAULT 0,
    "deactivatedAt" TIMESTAMP(3),
    "blockReason" TEXT,

    CONSTRAINT "Consent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "objectType" TEXT NOT NULL,
    "objectId" TEXT,
    "beforeValue" JSONB,
    "afterValue" JSONB,
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Inquiry" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "kind" "InquiryKind" NOT NULL,
    "outcome" "InquiryOutcome",
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Inquiry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeatureFlag" (
    "key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL,
    "changedById" TEXT,

    CONSTRAINT "FeatureFlag_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "Installation" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "slug" TEXT NOT NULL,
    "productName" TEXT NOT NULL,
    "boundAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Installation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceList" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "taxRatePercent" DECIMAL(5,2) NOT NULL,
    "paymentTermDays" INTEGER NOT NULL,
    "averageDays" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'EUR',
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,

    CONSTRAINT "PriceList_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceTier" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "maxPersons" INTEGER,
    "monthlyCent" INTEGER NOT NULL,
    "halfYearlyCent" INTEGER NOT NULL,
    "yearlyCent" INTEGER NOT NULL,
    "setupCent" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "PriceTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackupTarget" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "type" TEXT NOT NULL,
    "endpoint" TEXT,
    "host" TEXT,
    "bucket" TEXT,
    "region" TEXT,
    "path" TEXT,
    "port" INTEGER,
    "username" TEXT,
    "schedule" TEXT NOT NULL,
    "retentionDays" INTEGER NOT NULL,
    "lastTestAt" TIMESTAMP(3),
    "lastTestOk" BOOLEAN,
    "lastTestMessage" TEXT,

    CONSTRAINT "BackupTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstanceRestore" (
    "id" TEXT NOT NULL,
    "instanceId" TEXT NOT NULL,
    "backupId" TEXT NOT NULL,
    "newSubdomain" TEXT NOT NULL,
    "coolifyApplicationId" TEXT,
    "status" TEXT NOT NULL,
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "adoptedAt" TIMESTAMP(3),

    CONSTRAINT "InstanceRestore_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "PasskeyCredential_credentialId_key" ON "PasskeyCredential"("credentialId");

-- CreateIndex
CREATE INDEX "PasskeyCredential_userId_idx" ON "PasskeyCredential"("userId");

-- CreateIndex
CREATE INDEX "RecoveryCode_userId_idx" ON "RecoveryCode"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "EmailLoginCode_userId_key" ON "EmailLoginCode"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Device_tokenHash_key" ON "Device"("tokenHash");

-- CreateIndex
CREATE INDEX "Device_userId_idx" ON "Device"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "EmergencyEnrollment_tokenHash_key" ON "EmergencyEnrollment"("tokenHash");

-- CreateIndex
CREATE INDEX "EmergencyEnrollment_userId_idx" ON "EmergencyEnrollment"("userId");

-- CreateIndex
CREATE INDEX "Company_status_idx" ON "Company"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Instance_companyId_key" ON "Instance"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Instance_subdomain_key" ON "Instance"("subdomain");

-- CreateIndex
CREATE INDEX "Backup_instanceId_date_idx" ON "Backup"("instanceId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Backup_instanceId_date_key" ON "Backup"("instanceId", "date");

-- CreateIndex
CREATE INDEX "InstancePreview_companyId_subdomain_idx" ON "InstancePreview"("companyId", "subdomain");

-- CreateIndex
CREATE INDEX "ReconciliationRun_executedAt_idx" ON "ReconciliationRun"("executedAt");

-- CreateIndex
CREATE INDEX "Metric_date_idx" ON "Metric"("date");

-- CreateIndex
CREATE UNIQUE INDEX "Metric_instanceId_date_key" ON "Metric"("instanceId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "IntakeAccess_tokenHash_key" ON "IntakeAccess"("tokenHash");

-- CreateIndex
CREATE INDEX "IntakeAccess_companyId_idx" ON "IntakeAccess"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "Note_sequence_key" ON "Note"("sequence");

-- CreateIndex
CREATE INDEX "Note_companyId_date_idx" ON "Note"("companyId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_invoiceNumber_key" ON "Invoice"("invoiceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_cancelledInvoiceId_key" ON "Invoice"("cancelledInvoiceId");

-- CreateIndex
CREATE INDEX "Invoice_companyId_idx" ON "Invoice"("companyId");

-- CreateIndex
CREATE INDEX "Invoice_status_idx" ON "Invoice"("status");

-- CreateIndex
CREATE INDEX "Invoice_dueDate_idx" ON "Invoice"("dueDate");

-- CreateIndex
CREATE INDEX "InvoiceLine_invoiceId_idx" ON "InvoiceLine"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "MailTemplate_name_key" ON "MailTemplate"("name");

-- CreateIndex
CREATE INDEX "MailDelivery_companyId_idx" ON "MailDelivery"("companyId");

-- CreateIndex
CREATE INDEX "MailDelivery_deliveryStatus_idx" ON "MailDelivery"("deliveryStatus");

-- CreateIndex
CREATE INDEX "MailDelivery_consentId_idx" ON "MailDelivery"("consentId");

-- CreateIndex
CREATE INDEX "MailDelivery_templateId_idx" ON "MailDelivery"("templateId");

-- CreateIndex
CREATE INDEX "MailDelivery_recipientAddress_createdAt_idx" ON "MailDelivery"("recipientAddress", "createdAt");

-- CreateIndex
CREATE INDEX "MailDelivery_nextAttemptFrom_idx" ON "MailDelivery"("nextAttemptFrom");

-- CreateIndex
CREATE UNIQUE INDEX "Consent_confirmationToken_key" ON "Consent"("confirmationToken");

-- CreateIndex
CREATE UNIQUE INDEX "Consent_unsubscribeToken_key" ON "Consent"("unsubscribeToken");

-- CreateIndex
CREATE UNIQUE INDEX "Consent_email_key" ON "Consent"("email");

-- CreateIndex
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog"("userId");

-- CreateIndex
CREATE INDEX "AuditLog_timestamp_idx" ON "AuditLog"("timestamp");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- CreateIndex
CREATE INDEX "Inquiry_companyId_kind_idx" ON "Inquiry"("companyId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "PriceTier_key_key" ON "PriceTier"("key");

-- CreateIndex
CREATE UNIQUE INDEX "InstanceRestore_newSubdomain_key" ON "InstanceRestore"("newSubdomain");

-- CreateIndex
CREATE INDEX "InstanceRestore_instanceId_idx" ON "InstanceRestore"("instanceId");

-- CreateIndex
CREATE INDEX "InstanceRestore_backupId_idx" ON "InstanceRestore"("backupId");

-- AddForeignKey
ALTER TABLE "PasskeyCredential" ADD CONSTRAINT "PasskeyCredential_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecoveryCode" ADD CONSTRAINT "RecoveryCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailLoginCode" ADD CONSTRAINT "EmailLoginCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmergencyEnrollment" ADD CONSTRAINT "EmergencyEnrollment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Instance" ADD CONSTRAINT "Instance_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Backup" ADD CONSTRAINT "Backup_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstancePreview" ADD CONSTRAINT "InstancePreview_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Metric" ADD CONSTRAINT "Metric_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntakeAccess" ADD CONSTRAINT "IntakeAccess_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_cancelledInvoiceId_fkey" FOREIGN KEY ("cancelledInvoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "InvoiceLine" ADD CONSTRAINT "InvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "Invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailDelivery" ADD CONSTRAINT "MailDelivery_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailDelivery" ADD CONSTRAINT "MailDelivery_consentId_fkey" FOREIGN KEY ("consentId") REFERENCES "Consent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MailDelivery" ADD CONSTRAINT "MailDelivery_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "MailTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Consent" ADD CONSTRAINT "Consent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inquiry" ADD CONSTRAINT "Inquiry_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstanceRestore" ADD CONSTRAINT "InstanceRestore_instanceId_fkey" FOREIGN KEY ("instanceId") REFERENCES "Instance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstanceRestore" ADD CONSTRAINT "InstanceRestore_backupId_fkey" FOREIGN KEY ("backupId") REFERENCES "Backup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- HAND GESCHRIEBENER TEIL (nicht von Prisma erzeugt; bei jeder Neuerzeugung der
-- Baseline unveraendert anhaengen).
-- ---------------------------------------------------------------------------

-- Singletons: je Tabelle genau eine Zeile.
ALTER TABLE "Installation" ADD CONSTRAINT "Installation_singleton_check" CHECK ("id" = 'singleton');
ALTER TABLE "PriceList" ADD CONSTRAINT "PriceList_singleton_check" CHECK ("id" = 'singleton');
ALTER TABLE "BackupTarget" ADD CONSTRAINT "BackupTarget_singleton_check" CHECK ("id" = 'singleton');

-- GoBD-SCHUTZ AUF DATENBANKEBENE.
--
-- Festgeschriebene Rechnungen (finalizedAt IS NOT NULL) sind unveraenderlich,
-- das AuditLog ist append-only. Das gilt unabhaengig vom Anwendungscode.
--
-- TRUNCATE wird von Triggern dieser Art NICHT erfasst und hier bewusst nicht
-- blockiert: Die DB-Rolle der Anwendung sollte TRUNCATE gar nicht besitzen
-- (REVOKE TRUNCATE ON ALL TABLES ...). Das steht in der Betriebsdoku; die
-- Testaufraeumpfade nutzen TRUNCATE ... CASCADE.

-- (a) Festgeschriebene Rechnungen und ihre Posten nicht loeschen.
CREATE FUNCTION gobd_block_invoice_delete() RETURNS trigger AS $$
BEGIN
  IF OLD."finalizedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'GoBD: festgeschriebene Rechnung ist unveraenderlich und kann nicht geloescht werden (Rechnung %)', OLD."id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Invoice_gobd_no_delete"
  BEFORE DELETE ON "Invoice"
  FOR EACH ROW EXECUTE FUNCTION gobd_block_invoice_delete();

CREATE FUNCTION gobd_block_invoice_line_change() RETURNS trigger AS $$
DECLARE
  finalized timestamp(3);
  parent_id text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    parent_id := OLD."invoiceId";
  ELSE
    -- UPDATE: ohne tatsaechliche Aenderung ist nichts zu schuetzen.
    IF NEW IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
    parent_id := OLD."invoiceId";
  END IF;

  SELECT "finalizedAt" INTO finalized FROM "Invoice" WHERE "id" = parent_id;
  IF finalized IS NOT NULL THEN
    RAISE EXCEPTION 'GoBD: festgeschriebene Rechnung ist unveraenderlich (Posten % der Rechnung %)', OLD."id", parent_id
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "InvoiceLine_gobd_no_delete"
  BEFORE DELETE ON "InvoiceLine"
  FOR EACH ROW EXECUTE FUNCTION gobd_block_invoice_line_change();

-- (c) Posten einer festgeschriebenen Rechnung nicht aendern.
CREATE TRIGGER "InvoiceLine_gobd_no_update"
  BEFORE UPDATE ON "InvoiceLine"
  FOR EACH ROW EXECUTE FUNCTION gobd_block_invoice_line_change();

-- (b) Rechnung nach dem Festschreiben: nur Status-, Zahlungs- und
-- Uebertragungsfelder duerfen sich aendern; die Dokumentspalten nur
-- einmalig von NULL auf einen Wert (set-once).
CREATE FUNCTION gobd_guard_invoice_update() RETURNS trigger AS $$
DECLARE
  mutable_columns text[] := ARRAY['status', 'paymentDate', 'paidAmount', 'transferStatus'];
  document_columns text[] := ARRAY[
    'pdfContent', 'xmlContent', 'xrechnungContent',
    'pdfSha256', 'xmlSha256', 'xrechnungSha256', 'documentGeneratedAt'
  ];
  old_json jsonb;
  new_json jsonb;
  col text;
BEGIN
  IF OLD."finalizedAt" IS NULL THEN
    RETURN NEW;
  END IF;

  old_json := to_jsonb(OLD);
  new_json := to_jsonb(NEW);

  -- Alles ausser den veraenderlichen Feldern und den Dokumentspalten muss gleich bleiben.
  IF (old_json - mutable_columns - document_columns) IS DISTINCT FROM (new_json - mutable_columns - document_columns) THEN
    RAISE EXCEPTION 'GoBD: festgeschriebene Rechnung ist unveraenderlich (Rechnung %)', OLD."id"
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- Dokumentspalten: set-once.
  FOREACH col IN ARRAY document_columns LOOP
    IF old_json -> col IS DISTINCT FROM 'null'::jsonb
       AND old_json -> col IS DISTINCT FROM new_json -> col THEN
      RAISE EXCEPTION 'GoBD: festgeschriebene Rechnung ist unveraenderlich (Dokumentspalte % ist bereits gesetzt, Rechnung %)', col, OLD."id"
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Invoice_gobd_guard_update"
  BEFORE UPDATE ON "Invoice"
  FOR EACH ROW EXECUTE FUNCTION gobd_guard_invoice_update();

-- (d) AuditLog ist append-only. EINZIGE Ausnahme: Das Loeschen eines Kontos
-- setzt ueber den Fremdschluessel (ON DELETE SET NULL) "userId" auf NULL;
-- das ist die vom Schema gewollte Entkopplung und aendert keine Nachweisdaten
-- ("actor" bleibt im Klartext stehen).
CREATE FUNCTION gobd_audit_log_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."userId" IS NOT NULL AND NEW."userId" IS NULL
     AND (to_jsonb(OLD) - 'userId') = (to_jsonb(NEW) - 'userId') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'GoBD: AuditLog ist append-only (% nicht erlaubt)', TG_OP
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AuditLog_append_only"
  BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION gobd_audit_log_append_only();
