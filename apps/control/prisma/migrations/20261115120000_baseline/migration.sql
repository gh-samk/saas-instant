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
    "transferStatus" TEXT,
    "recipientName" TEXT NOT NULL,
    "recipientAddress" TEXT NOT NULL,
    "recipientEmail" TEXT,
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

