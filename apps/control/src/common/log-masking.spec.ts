import { maskUrl, MASK } from './log-masking';

describe('maskiereUrl (Verwaltung)', () => {
  it('lässt URLs ohne Query unverändert', () => {
    expect(maskUrl('/api/companies')).toBe('/api/companies');
  });

  /**
   * Der Kern: Bestätigungs- und Abmelde-Token tragen ihr Geheimnis im PFAD,
   * nicht im Query. Eine reine Query-Maskierung liesse sie durch.
   */
  it('maskiert den Bestätigungs-Token im Pfad', () => {
    expect(maskUrl('/api/consent/confirmation/abc123')).toBe(
      `/api/consent/confirmation/${MASK}`,
    );
  });

  it('maskiert den Abmelde-Token im Pfad', () => {
    expect(maskUrl('/api/consent/unsubscribe/abc123')).toBe(
      `/api/consent/unsubscribe/${MASK}`,
    );
  });

  it('maskiert auch ohne das /api-Prefix', () => {
    expect(maskUrl('/consent/unsubscribe/abc123')).toBe(
      `/consent/unsubscribe/${MASK}`,
    );
  });

  it('behält an, was hinter dem Token folgt', () => {
    expect(maskUrl('/api/consent/unsubscribe/abc123/immediately')).toBe(
      `/api/consent/unsubscribe/${MASK}/immediately`,
    );
  });

  it('lässt den Pfad ohne Token in Ruhe', () => {
    expect(maskUrl('/api/consent/unsubscribe')).toBe(
      '/api/consent/unsubscribe',
    );
    expect(maskUrl('/api/consent/unsubscribe/')).toBe(
      '/api/consent/unsubscribe/',
    );
  });

  it('maskiert Geheimnisse im Query-String', () => {
    expect(maskUrl('/x?token=geheim')).toBe(`/x?token=${MASK}`);
    expect(maskUrl('/x?code=geheim')).toBe(`/x?code=${MASK}`);
  });

  it('maskiert unabhängig von der Groß-/Kleinschreibung des Namens', () => {
    expect(maskUrl('/x?Token=geheim')).toBe(`/x?Token=${MASK}`);
  });

  it('lässt harmlose Parameter stehen und maskiert nur den Token', () => {
    expect(maskUrl('/api/x?seite=2&token=geheim&sortierung=datum')).toBe(
      `/api/x?seite=2&token=${MASK}&sortierung=datum`,
    );
  });

  it('kommt mit leerem Wert, fehlendem Gleichheitszeichen und leerem Query zurecht', () => {
    expect(maskUrl('/x?token=')).toBe(`/x?token=${MASK}`);
    expect(maskUrl('/x?token')).toBe('/x?token');
    expect(maskUrl('/x?')).toBe('/x?');
  });

  it('maskiert Pfad und Query zugleich', () => {
    expect(maskUrl('/api/consent/unsubscribe/abc?token=xyz')).toBe(
      `/api/consent/unsubscribe/${MASK}?token=${MASK}`,
    );
  });

  /**
   * Der Aufnahmelink trägt sein Token im PFAD, gilt 14 Tage und führt zur
   * Erfassung der Bankverbindung. Bis zur Prüfung vom 13.09.2026 stand er im
   * Klartext im Log.
   */
  it('maskiert den Aufnahme-Token im Pfad', () => {
    expect(maskUrl('/api/intake/abc123')).toBe(`/api/intake/${MASK}`);
  });

  it('maskiert den Aufnahme-Token auch beim Absenden', () => {
    expect(maskUrl('/api/intake/abc123/submit')).toBe(
      `/api/intake/${MASK}/submit`,
    );
  });

  it('verwechselt ähnlich beginnende Pfade nicht mit dem Aufnahmelink', () => {
    expect(maskUrl('/api/aufnahmen/abc123')).toBe('/api/aufnahmen/abc123');
  });
});
