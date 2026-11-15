import { composeProjectFor, type BackupManifest } from '../manifest/sections/provisioning';
import type { AgentInstance } from '../backup-settings/backup-agent.types';

/**
 * Beschreibung einer Instanz für den Sicherungs-Agent — aus dem Manifest
 * (`provisioning.backup`) und der Instanz-Zeile. KEINE Geheimnisse.
 * `null`, wenn der Compose-Projektname nicht bestimmbar ist.
 */
export function agentInstanceFor(
  manifest: BackupManifest,
  instance: { subdomain: string; coolifyApplicationId: string | null },
): AgentInstance | null {
  const composeProject = composeProjectFor(manifest.composeProjectPattern, {
    subdomain: instance.subdomain,
    applicationId: instance.coolifyApplicationId,
  });
  if (composeProject === null) return null;
  return {
    subdomain: instance.subdomain,
    composeProject,
    dbService: manifest.dbServiceName,
    dbName: manifest.dbName,
    dbUser: manifest.dbUser,
    ...(manifest.uploadsService !== null && manifest.uploadsPath !== null
      ? { uploadsService: manifest.uploadsService, uploadsPath: manifest.uploadsPath }
      : {}),
  };
}
