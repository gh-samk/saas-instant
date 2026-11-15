import { describe, expect, it } from 'vitest';
import { maskEmail } from './email-mask';

describe('maskiereEmail', () => {
  it('lässt zwei Zeichen und die Domain stehen', () => {
    expect(maskEmail('admin@example.com')).toBe('ad***@example.com');
  });

  it('lässt bei einem Zeichen vor dem @ dieses eine stehen', () => {
    expect(maskEmail('a@example.com')).toBe('a***@example.com');
  });

  it('maskiert nur den lokalen Teil, auch bei einem @ in der Domain', () => {
    expect(maskEmail('admin@mail.example.com')).toBe('ad***@mail.example.com');
  });

  it('gibt einen Wert ohne erkennbaren lokalen Teil unverändert zurück', () => {
    expect(maskEmail('@example.com')).toBe('@example.com');
    expect(maskEmail('')).toBe('');
    expect(maskEmail('keine-adresse')).toBe('keine-adresse');
  });
});
