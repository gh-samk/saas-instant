import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ManifestService } from '../manifest/manifest.service';
import { CoolifyHttpClient } from './coolify.client';
import { CoolifyConfigService } from './coolify.config';
import { CoolifyNotConfiguredClient } from './coolify-not-configured.client';
import { PROVISIONER, WAIT, realWait, type Wait } from '../provisioning/provisioner';
import { CoolifyProvisioner } from './coolify.provisioner';
import { COOLIFY_CLIENT, type CoolifyClient } from './coolify.types';

/**
 * Stellt genau EINEN `CoolifyClient` bereit und baut daraus den `Provisioner`
 * (nur dieser wird exportiert).
 *
 * Welchen, entscheidet allein die Umgebung: mit `COOLIFY_TOKEN` den echten,
 * ohne ihn den, der jeden Aufruf mit einem fachlichen Fehler beantwortet. Es
 * gibt bewusst keinen dritten Fall und keine Attrappe in diesem Modul — die
 * Attrappe liegt unter `src/test-support/` und ist damit vom
 * Auslieferungsartefakt ausgeschlossen ([K3], `build-content.spec.ts`).
 */
@Global()
@Module({
  providers: [
    CoolifyConfigService,
    {
      provide: COOLIFY_CLIENT,
      inject: [ConfigService, { token: ManifestService, optional: true }],
      useFactory: (config: ConfigService, manifest?: ManifestService): CoolifyClient => {
        const coolifyConfig = new CoolifyConfigService(config, manifest).read();
        return coolifyConfig === null
          ? new CoolifyNotConfiguredClient()
          : new CoolifyHttpClient(coolifyConfig);
      },
    },
    { provide: WAIT, useValue: realWait },
    // DIE EINZIGE STELLE, AN DER DIE VERWALTUNG DEN ANBIETER KENNT. Der
    // Instanzdienst injiziert `PROVISIONER` und nichts darunter.
    {
      provide: PROVISIONER,
      inject: [COOLIFY_CLIENT, WAIT],
      useFactory: (client: CoolifyClient, wait: Wait) => new CoolifyProvisioner(client, wait),
    },
  ],
  exports: [PROVISIONER, CoolifyConfigService],
})
export class CoolifyModule {}
