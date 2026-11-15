import { isHttpUrl, safeHref } from './http-url';

describe('isHttpUrl / safeHref (F11)', () => {
  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    ' javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:x',
    '//evil.example',
    'example.com',
    'http://',
    'https://exa mple.com',
    'https://a.example\n.evil',
    '',
    'ftp://example.com',
  ])('weist %j ab', (value) => {
    expect(isHttpUrl(value)).toBe(false);
    expect(safeHref(value)).toBeNull();
  });

  it.each(['http://example.com', 'https://example.org/pfad?x=1', ' https://example.org '])(
    'nimmt %j an',
    (value) => {
      expect(isHttpUrl(value)).toBe(true);
      expect(safeHref(value)).toBe(value.trim());
    },
  );
});
