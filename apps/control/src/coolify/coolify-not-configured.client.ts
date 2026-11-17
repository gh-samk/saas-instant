import { CoolifyNotConfiguredError } from './coolify.errors';
import type {
  ApplicationCreate,
  CoolifyApplication,
  CoolifyClient,
  CoolifyDeployment,
} from './coolify.types';

/**
 * Der Client, der greift, solange `COOLIFY_TOKEN` fehlt.
 *
 * Jeder Aufruf wirft denselben fachlichen Fehler. Die Alternative — einen
 * `null`-Client zu injizieren und überall zu prüfen — verteilte dieselbe
 * Entscheidung auf zehn Stellen, von denen eine irgendwann fehlte.
 */
export class CoolifyNotConfiguredClient implements CoolifyClient {
  version(): Promise<string> {
    throw new CoolifyNotConfiguredError();
  }
  applications(): Promise<CoolifyApplication[]> {
    throw new CoolifyNotConfiguredError();
  }
  getApplication(): Promise<CoolifyApplication | null> {
    throw new CoolifyNotConfiguredError();
  }
  createApplication(_data: ApplicationCreate): Promise<{ uuid: string }> {
    throw new CoolifyNotConfiguredError();
  }
  setEnvironmentVariable(): Promise<void> {
    throw new CoolifyNotConfiguredError();
  }
  setDomain(): Promise<void> {
    throw new CoolifyNotConfiguredError();
  }
  startDeploy(): Promise<{ deploymentUuid: string }> {
    throw new CoolifyNotConfiguredError();
  }
  getDeployment(): Promise<CoolifyDeployment> {
    throw new CoolifyNotConfiguredError();
  }
  stopApplication(): Promise<void> {
    throw new CoolifyNotConfiguredError();
  }
  deleteApplication(): Promise<void> {
    throw new CoolifyNotConfiguredError();
  }
}
