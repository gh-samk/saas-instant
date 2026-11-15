import type { ConfigService } from '@nestjs/config';
import type { ManifestService } from '../manifest/manifest.service';
import { CoolifyConfigService, PRESETS } from './coolify.config';

/**
 * ===========================================================================
 * DIE AUSSCHLUSSLISTE DES ABGLEICHS
 * ===========================================================================
 *
 * Sie entscheidet, welche Coolify-Anwendungen NICHT als verwaist gemeldet
 * werden. Ein Filter, der zu weit greift, verdeckt genau den Befund, für den
 * es die Liste gibt — deshalb steht hier, was er tut und was nicht.
 */

function configWith(values: Record<string, string | undefined>) {
  const config = {
    get: (name: string) => values[name],
  } as unknown as ConfigService;
  return new CoolifyConfigService(config);
}

const WITH_TOKEN = { COOLIFY_TOKEN: 'geheim' };

describe('Die Vorgabe', () => {
  it('ist neutral: keine eigenen Deployments eines Betreibers', () => {
    expect(configWith(WITH_TOKEN).read()?.ownApplications).toEqual([]);
    expect(PRESETS.ownApplications).toEqual([]);
  });

  it('kommt aus dem Manifest, wenn die Umgebung nichts sagt', () => {
    const manifest = {
      provisioning: { ownApplications: ['instanz-control', 'instanz-webseite'] },
    } as unknown as ManifestService;
    const config = { get: (n: string) => WITH_TOKEN[n as keyof typeof WITH_TOKEN] };
    const k = new CoolifyConfigService(config as unknown as ConfigService, manifest);
    expect(k.read()?.ownApplications).toEqual(['instanz-control', 'instanz-webseite']);
  });

  it('wird von der Umgebung vor dem Manifest ueberstimmt', () => {
    const manifest = {
      provisioning: { ownApplications: ['instanz-aus-manifest'] },
    } as unknown as ManifestService;
    const config = {
      get: (n: string) =>
        ({ ...WITH_TOKEN, CONTROL_COOLIFY_OWN_APPLICATIONS: 'instanz-aus-env' })[n],
    };
    const k = new CoolifyConfigService(config as unknown as ConfigService, manifest);
    expect(k.read()?.ownApplications).toEqual(['instanz-aus-env']);
  });
});

describe('Die Umgebungsvariable', () => {
  it('ersetzt die Vorgabe, statt sie zu ergänzen', () => {
    const coolifyConfig = configWith({
      ...WITH_TOKEN,
      CONTROL_COOLIFY_OWN_APPLICATIONS: 'instanz-eins,instanz-zwei',
    });
    expect(coolifyConfig.read()?.ownApplications).toEqual([
      'instanz-eins',
      'instanz-zwei',
    ]);
  });

  it('verträgt Leerzeichen und leere Einträge', () => {
    const coolifyConfig = configWith({
      ...WITH_TOKEN,
      CONTROL_COOLIFY_OWN_APPLICATIONS: ' instanz-eins , , instanz-zwei ,',
    });
    expect(coolifyConfig.read()?.ownApplications).toEqual([
      'instanz-eins',
      'instanz-zwei',
    ]);
  });

  it('BLENDET NICHTS AUS, wenn sie gesetzt, aber leer ist', () => {
    // Wer `CONTROL_COOLIFY_OWN_APPLICATIONS=` schreibt, will alles sehen.
    // Auf die Vorgabe zurückzufallen wäre das Gegenteil dessen, was dasteht —
    // und die vier Befunde wären wieder da, ohne dass jemand versteht, warum.
    const coolifyConfig = configWith({
      ...WITH_TOKEN,
      CONTROL_COOLIFY_OWN_APPLICATIONS: '',
    });
    expect(coolifyConfig.read()?.ownApplications).toEqual([]);
  });

  it('nimmt die Vorgabe, wenn sie GAR NICHT gesetzt ist', () => {
    expect(configWith(WITH_TOKEN).read()?.ownApplications).toEqual(
      PRESETS.ownApplications,
    );
  });
});
